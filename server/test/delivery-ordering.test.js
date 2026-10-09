import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerStorefrontAdmin } from '../src/storefront-admin.js';

function routes() {
  const handlers = new Map();
  const app = {};
  for (const method of ['get','post','put','patch']) app[method] = (path, handler) => handlers.set(`${method}:${path}`, handler);
  return { app, handlers };
}

test('delivery migration is opt-in, tenant-scoped, immutable after submission, and redaction-only for addresses', async () => {
  const sql = await readFile(new URL('../../db/migrations/0025_delivery_ordering.sql', import.meta.url), 'utf8');
  assert.match(sql, /delivery_enabled boolean NOT NULL DEFAULT false/);
  assert.match(sql, /PRIMARY KEY\(company_id,id\)/);
  assert.match(sql, /FOREIGN KEY\(company_id,delivery_zone_id\)[\s\S]*REFERENCES myfin\.storefront_delivery_zones\(company_id,id\)/);
  assert.match(sql, /fee_sen integer NOT NULL CHECK\(fee_sen BETWEEN 0 AND 100000000\)/);
  assert.match(sql, /lead_time_minutes BETWEEN 5 AND 1440/);
  assert.match(sql, /service_mode text CHECK\(service_mode IN \('pickup','table','delivery'\)\)/);
  assert.match(sql, /customer_order_delivery_snapshot_immutable/);
  assert.match(sql, /NEW\.delivery_address_snapshot <> '\{\}'::jsonb/);
  assert.match(sql, /NEW\.pii_redacted_at IS NULL/);
  assert.match(sql, /REVOKE ALL ON TABLE myfin\.storefront_delivery_zones FROM PUBLIC/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /latitude|longitude|payment|card|geocod/i);
});

test('delivery-zone writes require storefront configuration permission before database access', async () => {
  const { app, handlers } = routes();
  let queries = 0;
  registerStorefrontAdmin(app, {
    scoped: (req, fn) => fn({ query:async () => { queries++; return { rows:[], rowCount:0 }; } }, req.params.company),
    authOptions:{ allowedHosts:[] }, audit:async () => {},
  });
  const handler = handlers.get('post:/api/companies/:company/storefront/delivery-zones');
  await assert.rejects(handler({ params:{ company:'company-a' }, identity:{ id:'operator-a', role:'staff' }, body:{
    name:'Campus', feeSen:250, minimumOrderSen:1500, leadTimeMinutes:35, serviceInstructions:'', enabled:true,
  } }), error => error.statusCode === 403 && error.message === 'access_denied');
  assert.equal(queries, 0);
});

test('delivery-zone creation takes tenant and actor only from authenticated route context', async () => {
  const { app, handlers } = routes(), calls = [], audits = [];
  const c = { query:async (sql, params=[]) => {
    calls.push({ sql, params });
    if (sql.includes('FROM myfin.storefront_settings')) return { rows:[] };
    if (sql.includes('FROM myfin.storefront_hosts')) return { rows:[] };
    if (sql.includes('FROM myfin.shop_locations')) return { rows:[] };
    if (sql.includes('FROM myfin.storefront_delivery_zones')) return { rows:[] };
    if (sql.includes('FROM myfin.storefront_products')) return { rows:[] };
    return { rows:[], rowCount:1 };
  } };
  registerStorefrontAdmin(app, { scoped:(req,fn) => fn(c,req.params.company), authOptions:{ allowedHosts:[] },
    audit:async (...args) => audits.push(args) });
  await handlers.get('post:/api/companies/:company/storefront/delivery-zones')({
    params:{ company:'company-a' }, identity:{ id:'manager-a', role:'manager' },
    body:{ name:'Campus', feeSen:250, minimumOrderSen:1500, leadTimeMinutes:35,
      serviceInstructions:'Meet at lobby', enabled:true, companyId:'attacker-company' },
  }).then(() => assert.fail('strict schema must reject an injected tenant'))
    .catch(error => assert.equal(error.statusCode, 400));
  assert.equal(calls.length, 0);
  await handlers.get('post:/api/companies/:company/storefront/delivery-zones')({
    params:{ company:'company-a' }, identity:{ id:'manager-a', role:'manager' },
    body:{ name:'Campus', feeSen:250, minimumOrderSen:1500, leadTimeMinutes:35,
      serviceInstructions:'Meet at lobby', enabled:true },
  });
  const insert = calls.find(call => call.sql.includes('INSERT INTO myfin.storefront_delivery_zones'));
  assert.equal(insert.params[0], 'company-a');
  assert.equal(insert.params.at(-1), 'manager-a');
  assert.equal(audits.length, 1);
});

test('public delivery queries require both company delivery enablement and an enabled zone without external calls', async () => {
  const source = await readFile(new URL('../src/storefront-public.js', import.meta.url), 'utf8');
  assert.match(source, /z\.company_id=\$1 AND z\.id=\$2 AND z\.enabled AND s\.delivery_enabled/);
  assert.match(source, /WHERE company_id=\$1 AND enabled ORDER BY created_at,id/);
  assert.match(source, /cartTokenInput\(input\)/);
  assert.match(source, /delivery_address_snapshot,delivery_contact_purpose,delivery_fee_sen/);
  assert.match(source, /idempotency_key=\$2 FOR UPDATE/);
  assert.doesNotMatch(source, /\bfetch\s*\(|https?:\/\//);
  const staff = await readFile(new URL('../src/customer-orders.js', import.meta.url), 'utf8');
  assert.match(staff, /delivery_address_snapshot/);
  assert.match(staff, /contactPurpose: row\.delivery_contact_purpose/);
  assert.match(staff, /reservationOrderId: id, acceptedOrderQuote: true/);
});

test('staff fulfillment sees the delivery address while customer status remains region-only', async () => {
  const [ordersUi,statusUi,posUi] = await Promise.all([
    readFile(new URL('../../src/components/dashboard/OrdersTab.vue', import.meta.url),'utf8'),
    readFile(new URL('../../src/components/customer/CustomerOrderStatus.vue', import.meta.url),'utf8'),
    readFile(new URL('../../src/components/dashboard/EditionPos.vue', import.meta.url),'utf8'),
  ]);
  assert.match(ordersUi, /address\.addressLine1/);assert.match(ordersUi, /Customer instruction/);
  assert.match(ordersUi, /serviceInstructions/);assert.match(ordersUi, /removed under the retention policy/);
  assert.match(statusUi, /address\.postcode/);assert.match(statusUi, /address\.city/);
  assert.doesNotMatch(statusUi, /addressLine1|addressLine2/);
  assert.match(posUi, /deliveryFee:Number\(locked\.deliveryFee\)/);
  assert.match(posUi, /Delivery fee/);
});
