// Destructive integration acceptance for a fresh, disposable PostgreSQL database.
//
// The test deliberately refuses ordinary databases. The caller must provide all
// three guards below, and the target database must be empty and owned by the
// connecting role:
//   MYFIN_CUSTOMER_ORDER_ACCEPTANCE=myfin-customer-ordering-acceptance-20261001
//   MYFIN_CUSTOMER_ORDER_DATABASE_URL=postgresql://...@127.0.0.1:25438/myfin_customer_ordering_acceptance
//   PostgreSQL cluster_name=myfin-customer-ordering-acceptance-20261001
// Recreate the disposable database before every run. This file creates schema
// `myfin`, applies every real migration, and intentionally leaves its fixtures
// in place for failure inspection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { readMigrations, runMigrations } from '../src/migrations.js';
import { createDatabase } from '../src/database.js';
import { buildApp } from '../src/app.js';
import { createAuth, createIdentity } from '../src/auth.js';
import { cartItem, createSale } from '../../src/domain/pos.js';

const marker = 'myfin-customer-ordering-acceptance-20261001';
const databaseName = 'myfin_customer_ordering_acceptance';
const connectionString = process.env.MYFIN_CUSTOMER_ORDER_DATABASE_URL || '';
if (process.env.MYFIN_CUSTOMER_ORDER_ACCEPTANCE !== marker || !connectionString)
  throw Error('customer_order_acceptance_opt_in_required');

let target;
try { target = new URL(connectionString); }
catch { throw Error('invalid_customer_order_acceptance_database_url'); }
if (!['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.pathname !== `/${databaseName}` || target.search || target.hash)
  throw Error('unsafe_customer_order_acceptance_target');

const staffHost = 'staff-a.acceptance.test';
const storefrontA = 'order-a.acceptance.test';
const storefrontB = 'order-b.acceptance.test';
const password = 'Synthetic acceptance password 2026!';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const cookiePairs = response => {
  const values = response.headers['set-cookie'];
  return (values ? (Array.isArray(values) ? values : [values]) : []).map(value => value.split(';')[0]);
};
const mergeCookies = (...groups) => {
  const jar = new Map();
  for (const group of groups.flat()) {
    if (!group) continue;
    const at = group.indexOf('=');
    if (at > 0) jar.set(group.slice(0, at), group.slice(at + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
};
const expectCode = (promise, code) => assert.rejects(promise, error => error?.code === code);

test('customer accounts and ordering survive real PostgreSQL concurrency and constraints', async t => {
  const migrator = new pg.Client({ connectionString, application_name: 'myfin-customer-acceptance-migrator' });
  let database, app;
  await migrator.connect();
  try {
    await t.test('safety gates and the real migration batch', async () => {
      const safety = (await migrator.query(`SELECT current_database() AS database,
        current_setting('cluster_name') AS cluster_name,
        current_user=pg_get_userbyid(datdba) AS database_owner
        FROM pg_database WHERE datname=current_database()`)).rows[0];
      assert.deepEqual(safety, { database: databaseName, cluster_name: marker, database_owner: true });
      const existing = await migrator.query(`SELECT n.nspname,c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema')
          AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')`);
      assert.equal(existing.rowCount, 0, 'the disposable database must start empty');
      assert.equal((await migrator.query("SELECT to_regnamespace('myfin') AS schema")).rows[0].schema, null);
      await migrator.query('CREATE SCHEMA myfin');
      const migrations = await readMigrations();
      assert.deepEqual(await runMigrations(migrator, migrations), migrations.map(row => row.version));
      assert.deepEqual(await runMigrations(migrator, migrations), []);
    });

    const poolConfig = {
      connectionString,
      options: '-c search_path=myfin,pg_catalog',
      max: 12,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
      statement_timeout: 10000,
      query_timeout: 12000,
      application_name: 'myfin-customer-ordering-acceptance',
    };
    database = createDatabase(poolConfig);
    assert.equal(await database.ready(), true);
    const authOptions = {
      origin: `https://${staffHost}`,
      protocol: 'https:',
      allowedHosts: [staffHost, storefrontA, storefrontB],
      controlHosts: [],
      rootDomain: 'acceptance.test',
      publicProxyAddresses: [],
      enforceTenantHosts: true,
      secret: 'customer-order-acceptance-secret'.padEnd(64, 'x'),
      secure: true,
      pos: null,
    };
    const auth = createAuth(database.pool, authOptions);
    app = buildApp({ database, auth, authOptions });

    const tag = randomUUID().slice(0, 8);
    const workspaceA = `workspace-a-${tag}`;
    const workspaceB = `workspace-b-${tag}`;
    const companyA = `company-a-${tag}`;
    const companyB = `company-b-${tag}`;
    const productId = `latte-${tag}`;
    const locationA = `counter-a-${tag}`;
    const locationB = `counter-b-${tag}`;
    const locationTokenA = `location-a-${tag}`.padEnd(43, 'x');
    const locationTokenB = `location-b-${tag}`.padEnd(43, 'x');
    const product = {
      id: productId, name: 'Acceptance latte', sku: `LATTE-${tag}`, description: 'Synthetic only',
      category: 'Beverages', subcategory: 'Coffee', unit: 'cup', price: 9.93, cost: 3.1,
      stock: 2, trackStock: true, variants: [],
    };
    let staffId, staffCookie, customerCookie, customerId;

    async function request(host, path, { method = 'GET', cookie = '', body, headers = {} } = {}) {
      return app.inject({
        method,
        url: `/api${path}`,
        headers: { host, origin: `https://${host}`, ...(cookie ? { cookie } : {}), ...headers },
        ...(body === undefined ? {} : { payload: body }),
      });
    }
    async function ok(host, path, options, status = 200) {
      const response = await request(host, path, options);
      assert.equal(response.statusCode, status, `${options?.method || 'GET'} ${host}${path}: ${response.statusCode} ${response.body}`);
      return response;
    }

    await t.test('fixtures and hostname surfaces are tenant-safe', async () => {
      await database.transaction(async client => {
        await client.query(
          `INSERT INTO myfin.workspaces(id,name,slug) VALUES
            ($1,'Acceptance workspace A',$2),($3,'Acceptance workspace B',$4)`,
          [workspaceA, `accept-a-${tag}`, workspaceB, `accept-b-${tag}`],
        );
        await client.query(
          `INSERT INTO myfin.companies(id,name,data,workspace_id,slug) VALUES
            ($1,'Acceptance cafe A',$2,$3,'cafe-a'),($4,'Acceptance cafe B',$2,$5,'cafe-b')`,
          [companyA, { preferences: { currency: 'RM', taxRate: 0, staffDiscountLimit: 0 } }, workspaceA,
            companyB, workspaceB],
        );
        staffId = await createIdentity(client, {
          email: `owner-${tag}@acceptance.test`, username: 'Acceptance owner', password,
          role: 'workspace_owner', workspace_id: workspaceA, company_id: '',
        });
        await client.query(
          `INSERT INTO myfin.tenant_hosts(hostname,workspace_id,company_id,canonical)
           VALUES($1,$2,$3,true)`, [staffHost, workspaceA, companyA],
        );
        await client.query(
          `INSERT INTO myfin.storefront_hosts(hostname,company_id,created_by)
           VALUES($1,$2,$5),($3,$4,$5)`, [storefrontA, companyA, storefrontB, companyB, staffId],
        );
        await client.query(
          `INSERT INTO myfin.storefront_settings(
             company_id,published,display_name,guest_data_retention_days,
             privacy_controller_name,privacy_controller_contact,privacy_notice_url,
             privacy_notice_en,privacy_notice_ms,updated_by)
           VALUES($1,true,'Acceptance cafe A',7,'Acceptance Controller','privacy@acceptance.test',
                    'https://acceptance.test/privacy','Synthetic English privacy notice.',
                    'Notis privasi sintetik Bahasa Malaysia.',$3),
                 ($2,true,'Acceptance cafe B',7,'Acceptance Controller','privacy@acceptance.test',
                    'https://acceptance.test/privacy','Synthetic English privacy notice.',
                    'Notis privasi sintetik Bahasa Malaysia.',$3)`,
          [companyA, companyB, staffId],
        );
        await client.query(
          `INSERT INTO myfin.shop_locations(company_id,id,name,fulfillment_mode,token_digest,token_hint,created_by)
           VALUES($1,$2,'Counter A','pickup',$3,'aaaaaa',$7),
                 ($4,$5,'Counter B','pickup',$6,'bbbbbb',$7)`,
          [companyA, locationA, sha256(locationTokenA), companyB, locationB, sha256(locationTokenB), staffId],
        );
        await client.query(
          `INSERT INTO myfin.products(company_id,id,data,stock,price,cost) VALUES($1,$2,$3,$4,$5,$6)`,
          [companyA, productId, product, product.stock, product.price, product.cost],
        );
        await client.query(
          `INSERT INTO myfin.storefront_products(company_id,product_id,published,display_name,updated_by)
           VALUES($1,$2,true,'Acceptance latte',$3)`, [companyA, productId, staffId],
        );
      });
      await expectCode(database.query(
        `INSERT INTO myfin.tenant_hosts(hostname,workspace_id,company_id,canonical)
         VALUES($1,$2,$3,true)`, [storefrontA, workspaceB, companyB]), '23514');
      await expectCode(database.query(
        `INSERT INTO myfin.storefront_hosts(hostname,company_id,created_by)
         VALUES('order-a-second.acceptance.test',$1,$2)`, [companyA, staffId]), '23505');
      assert.equal((await request(staffHost, '/public/customer/me')).statusCode, 404);
      assert.equal((await request(storefrontA, `/companies/${companyA}/customer-orders`)).statusCode, 404);
    });

    await t.test('one customer session crosses shops while profiles remain workspace-scoped', async () => {
      const registered = await ok(storefrontA, '/public/customer/register', {
        method: 'POST', body: {
          email: `customer-${tag}@acceptance.test`, password,
          displayName: 'Amina Acceptance', phone: '+60111111111', adultConfirmed: true,
        },
      }, 201);
      const registration = registered.json();
      customerId = registration.customer.id;
      customerCookie = mergeCookies(cookiePairs(registered));
      assert.equal(registration.customer.emailVerified, false);
      const duplicate = await request(storefrontB, '/public/customer/register', {
        method: 'POST', body: {
          email: `CUSTOMER-${tag}@acceptance.test`, password,
          displayName: 'Duplicate', phone: '', adultConfirmed: true,
        },
      });
      assert.equal(duplicate.statusCode, 409);
      assert.equal(duplicate.json().error, 'customer_account_unavailable');

      const across = (await ok(storefrontB, '/public/customer/me', { cookie: customerCookie })).json();
      assert.equal(across.authenticated, true);
      assert.equal(across.customer.id, customerId);
      assert.equal(across.profile.workspaceId, workspaceB);
      assert.equal(across.loyalty.workspaceId, workspaceB);
      assert.equal(across.loyalty.stampBalance, 0);
      await ok(storefrontA, '/public/customer/profile', {
        method: 'PUT', cookie: customerCookie, body: { displayName: 'Amina at A', phone: '+60111111111' },
      });
      await ok(storefrontB, '/public/customer/profile', {
        method: 'PUT', cookie: customerCookie, body: { displayName: 'Amina at B', phone: '+60222222222' },
      });
      const profiles = (await database.query(
        `SELECT workspace_id,phone FROM myfin.customer_workspace_profiles
          WHERE customer_id=$1 ORDER BY workspace_id`, [customerId],
      )).rows;
      assert.deepEqual(profiles, [
        { workspace_id: workspaceA, phone: '+60111111111' },
        { workspace_id: workspaceB, phone: '+60222222222' },
      ]);
      assert.ok((await database.query(
        'SELECT adult_confirmed_at FROM myfin.customer_accounts WHERE id=$1', [customerId],
      )).rows[0].adult_confirmed_at);

      const failedSignIn = await request(storefrontA, '/public/customer/sign-in', {
        method: 'POST', body: { email: `customer-${tag}@acceptance.test`, password: 'wrong password value' },
      });
      assert.equal(failedSignIn.statusCode, 401);
      assert.equal(failedSignIn.json().error, 'customer_authentication_failed');
      assert.equal(Number((await database.query(
        'SELECT failed_attempts FROM myfin.customer_credentials WHERE customer_id=$1', [customerId],
      )).rows[0].failed_attempts), 1);
      const validSignIn = await ok(storefrontA, '/public/customer/sign-in', {
        method: 'POST', body: { email: `customer-${tag}@acceptance.test`, password },
      });
      assert.ok(mergeCookies(cookiePairs(validSignIn)));
      assert.equal(Number((await database.query(
        'SELECT failed_attempts FROM myfin.customer_credentials WHERE customer_id=$1', [customerId],
      )).rows[0].failed_attempts), 0);
    });

    await t.test('order submission is idempotent and concurrent acceptance cannot oversell', async () => {
      const signedIn = await ok(staffHost, '/auth/sign-in/email', {
        method: 'POST', body: { email: `owner-${tag}@acceptance.test`, password },
      });
      staffCookie = mergeCookies(cookiePairs(signedIn));
      assert.ok(staffCookie);

      const cart = { locationId: locationA, serviceMode: 'pickup',
        items: [{ productId, variantId: '', quantity: 2 }] };
      const quoteResponse = await ok(storefrontA, '/public/order-requests/quote', {
        method: 'POST', cookie: customerCookie, body: cart,
      });
      const shopperCookie = mergeCookies(customerCookie, cookiePairs(quoteResponse));
      const submitBody = { ...cart, guest: {}, quoteToken: quoteResponse.json().quoteToken };
      const idempotencyKey = randomUUID();
      const duplicateSubmissions = await Promise.all([
        request(storefrontA, '/public/order-requests', {
          method: 'POST', cookie: shopperCookie, body: submitBody,
          headers: { 'idempotency-key': idempotencyKey },
        }),
        request(storefrontA, '/public/order-requests', {
          method: 'POST', cookie: shopperCookie, body: submitBody,
          headers: { 'idempotency-key': idempotencyKey },
        }),
      ]);
      assert.deepEqual(duplicateSubmissions.map(response => response.statusCode).sort(), [200, 201]);
      const firstOrder = duplicateSubmissions[0].json().order;
      assert.equal(duplicateSubmissions[1].json().order.id, firstOrder.id);
      assert.equal((await database.query(
        'SELECT count(*)::int AS count FROM myfin.customer_order_requests WHERE company_id=$1 AND idempotency_key=$2',
        [companyA, idempotencyKey],
      )).rows[0].count, 1);

      const second = await ok(storefrontA, '/public/order-requests', {
        method: 'POST', cookie: shopperCookie, body: submitBody,
        headers: { 'idempotency-key': randomUUID() },
      }, 201);
      const secondOrder = second.json().order;
      const queue = (await ok(staffHost, `/companies/${companyA}/customer-orders?view=active`, {
        cookie: staffCookie,
      })).json();
      assert.equal(queue.rows.length, 2, 'the bounded expiry scan must parse and retain live orders');
      const transitions = await Promise.all([
        request(staffHost, `/companies/${companyA}/customer-orders/${firstOrder.id}/transitions`, {
          method: 'POST', cookie: staffCookie,
          body: { requestId: randomUUID(), expectedVersion: 1, status: 'accepted', note: 'Synthetic acceptance' },
        }),
        request(staffHost, `/companies/${companyA}/customer-orders/${secondOrder.id}/transitions`, {
          method: 'POST', cookie: staffCookie,
          body: { requestId: randomUUID(), expectedVersion: 1, status: 'accepted', note: 'Synthetic acceptance' },
        }),
      ]);
      assert.deepEqual(transitions.map(response => response.statusCode).sort(), [200, 409]);
      const acceptedResponse = transitions.find(response => response.statusCode === 200);
      const rejectedResponse = transitions.find(response => response.statusCode === 409);
      assert.equal(rejectedResponse.json().error, 'stock_reserved_or_unavailable');
      const accepted = acceptedResponse.json().order;
      const rejectedId = accepted.id === firstOrder.id ? secondOrder.id : firstOrder.id;
      assert.equal(Number((await database.query(
        `SELECT coalesce(sum(quantity),0)::numeric AS quantity FROM myfin.customer_order_reservations
          WHERE company_id=$1 AND released_at IS NULL`, [companyA],
      )).rows[0].quantity), 2);
      assert.equal((await database.query(
        'SELECT status FROM myfin.customer_order_requests WHERE company_id=$1 AND id=$2',
        [companyA, rejectedId],
      )).rows[0].status, 'awaiting_acceptance');
      assert.equal(Number((await database.query(
        'SELECT stock FROM myfin.products WHERE company_id=$1 AND id=$2', [companyA, productId],
      )).rows[0].stock), 2);

      const item = { ...cartItem(product), qty: 2 };
      const sale = createSale({
        id: `sale-${tag}`, items: [item],
        company: { id: companyA, name: 'Acceptance cafe A', address: '', phone: '', registration: '',
          preferences: { currency: 'RM', taxRate: 0 } },
        user: { uid: staffId, username: 'Acceptance owner' }, method: 'Cash', received: 100,
      });
      assert.equal(sale.total, accepted.total);
      const tenderBody = { requestId: randomUUID(), expectedVersion: accepted.version, sale };
      const paid = await ok(staffHost, `/companies/${companyA}/customer-orders/${accepted.id}/tender`, {
        method: 'POST', cookie: staffCookie, body: tenderBody,
      });
      assert.equal(paid.json().order.status, 'paid');
      const replay = await ok(staffHost, `/companies/${companyA}/customer-orders/${accepted.id}/tender`, {
        method: 'POST', cookie: staffCookie, body: tenderBody,
      });
      assert.equal(replay.json().saleId, sale.id);

      const invariants = (await database.query(
        `SELECT
          (SELECT count(*)::int FROM myfin.transactions WHERE company_id=$1 AND id=$2) AS sales,
          (SELECT count(*)::int FROM myfin.customer_order_payments WHERE company_id=$1 AND order_id=$3) AS payments,
          (SELECT count(*)::int FROM myfin.stock_movements WHERE company_id=$1 AND id=$2) AS stock_movements,
          (SELECT count(*)::int FROM myfin.customer_loyalty_events WHERE workspace_id=$4 AND source_sale_id=$2) AS loyalty_events,
          (SELECT stamp_balance FROM myfin.customer_loyalty_accounts WHERE workspace_id=$4 AND customer_id=$5) AS balance,
          (SELECT stock FROM myfin.products WHERE company_id=$1 AND id=$6) AS stock`,
        [companyA, sale.id, accepted.id, workspaceA, customerId, productId],
      )).rows[0];
      assert.deepEqual({
        sales: invariants.sales, payments: invariants.payments, stock_movements: invariants.stock_movements,
        loyalty_events: invariants.loyalty_events, balance: invariants.balance, stock: Number(invariants.stock),
      }, { sales: 1, payments: 1, stock_movements: 1, loyalty_events: 1, balance: 1, stock: 0 });
      assert.equal((await database.query(
        `SELECT count(*)::int AS count FROM myfin.customer_loyalty_accounts
          WHERE workspace_id=$1 AND customer_id=$2`, [workspaceB, customerId],
      )).rows[0].count, 0);

      await expectCode(database.query(
        `INSERT INTO myfin.customer_order_payments(company_id,order_id,sale_id,actor_id,request_id,request_digest)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [companyA, rejectedId, sale.id, staffId, randomUUID(), 'a'.repeat(64)]), '23505');
      await expectCode(database.query(
        `INSERT INTO myfin.customer_loyalty_events(
           workspace_id,id,customer_id,company_id,kind,stamps,balance_after,source_sale_id,reason,actor_id)
         VALUES($1,$2,$3,$4,'earn',1,2,$5,'Duplicate',$6)`,
        [workspaceA, randomUUID(), customerId, companyA, sale.id, staffId]), '23505');

      const actors = (await database.query(
        `SELECT actor_type,staff_actor_id,customer_actor_id FROM myfin.customer_order_events
          WHERE company_id=$1 AND order_id=$2 ORDER BY version`, [companyA, accepted.id],
      )).rows;
      assert.deepEqual(actors.map(row => row.actor_type), ['customer', 'staff', 'staff']);
      assert.equal(actors[0].customer_actor_id, customerId);
      assert.equal(actors[0].staff_actor_id, null);
      assert.ok(actors.slice(1).every(row => row.staff_actor_id === staffId && row.customer_actor_id === null));
      await expectCode(database.query(
        `INSERT INTO myfin.customer_order_events(
           company_id,id,order_id,version,actor_type,staff_actor_id,request_id,request_digest,
           action,from_status,to_status)
         VALUES($1,$2,$3,2,'customer',$4,$5,$6,'status_changed','awaiting_acceptance','cancelled')`,
        [companyA, randomUUID(), rejectedId, staffId, randomUUID(), 'b'.repeat(64)]), '23514');

      await database.query(
        `UPDATE myfin.customer_order_requests SET updated_at=now()-interval '8 days'
          WHERE company_id=$1 AND id=$2`, [companyA, accepted.id],
      );
      const cleanupReads = await Promise.all([
        ok(storefrontA, '/public/customer/orders', { cookie: customerCookie }),
        ok(storefrontA, '/public/customer/orders', { cookie: customerCookie }),
      ]);
      const historyA = cleanupReads[0].json();
      const historyB = (await ok(storefrontB, '/public/customer/orders', { cookie: customerCookie })).json();
      assert.equal(historyA.rows.length, 2);
      assert.equal(historyB.rows.length, 0);
      assert.ok(historyA.rows.every(order => order.customerId === undefined && order.guestEmail === undefined));
      const redacted = (await database.query(
        `SELECT guest_name,guest_email,guest_phone,notes,pii_redacted_at
           FROM myfin.customer_order_requests WHERE company_id=$1 AND id=$2`, [companyA, accepted.id],
      )).rows[0];
      assert.deepEqual({
        guest_name: redacted.guest_name, guest_email: redacted.guest_email,
        guest_phone: redacted.guest_phone, notes: redacted.notes,
      }, { guest_name: 'Customer', guest_email: '', guest_phone: '', notes: '' });
      assert.ok(redacted.pii_redacted_at);
      await ok(storefrontA, '/public/customer/orders', { cookie: customerCookie });
      assert.equal((await database.query(
        `SELECT pii_redacted_at FROM myfin.customer_order_requests
          WHERE company_id=$1 AND id=$2`, [companyA, accepted.id],
      )).rows[0].pii_redacted_at.toISOString(), redacted.pii_redacted_at.toISOString());
      const meA = (await ok(storefrontA, '/public/customer/me', { cookie: customerCookie })).json();
      const meB = (await ok(storefrontB, '/public/customer/me', { cookie: customerCookie })).json();
      assert.equal(meA.loyalty.stampBalance, 1);
      assert.equal(meB.loyalty.stampBalance, 0);
    });

    await t.test('history ledgers stay immutable', async () => {
      await expectCode(database.query(
        `UPDATE myfin.customer_order_events SET note=note
          WHERE company_id=$1 AND order_id IN (
            SELECT id FROM myfin.customer_order_requests WHERE company_id=$1 LIMIT 1)`, [companyA]), '23514');
      await expectCode(database.query(
        `UPDATE myfin.customer_loyalty_events SET reason=reason
          WHERE workspace_id=$1`, [workspaceA]), '23514');
      await expectCode(database.query(
        `DELETE FROM myfin.customer_order_payments WHERE company_id=$1`, [companyA]), '23514');
    });
  } finally {
    if (app) await app.close();
    else if (database) await database.close();
    await migrator.end().catch(() => {});
  }
});
