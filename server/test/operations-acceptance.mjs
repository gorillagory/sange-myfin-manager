// Run only against the disposable Phase06 PostgreSQL cluster.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/database.js';
import { authConfig, createAuth, createIdentity } from '../src/auth.js';
import { buildApp } from '../src/app.js';
import { importExpensesCsv } from '../../src/domain/expensesCsv.js';

const marker = 'myfin-phase06-pg-20260928';
const cfg = loadConfig();
const privateDir = process.env.MYFIN_TEST_PRIVATE;
if (
  process.env.MYFIN_ISOLATED_ACCEPTANCE !== marker ||
  cfg.database.host !== '127.0.0.1' ||
  cfg.database.port !== 25436 ||
  cfg.database.database !== 'myfin_dev' ||
  !privateDir
) throw Error('unsafe_phase06_test_target');

const admin = new pg.Client({
  ...cfg.database,
  user: 'postgres',
  password: (await readFile(`${privateDir}/admin.secret`, 'utf8')).trim(),
});
await admin.connect();
assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name, marker);

const tag = randomUUID().slice(0, 8);
const workspace = `operations-${tag}`;
const companyA = `operations-a-${tag}`;
const companyB = `operations-b-${tag}`;
const hostA = `ops-a-${tag}.test`;
const hostB = `ops-b-${tag}.test`;
const authOptions = {
  ...authConfig(),
  origin: `https://${hostA}`,
  protocol: 'https:',
  allowedHosts: [hostA, hostB],
  controlHosts: [],
  enforceTenantHosts: true,
  secure: true,
  rootDomain: 'test',
};
const db = createDatabase(cfg.database);
const app = buildApp({ database: db, authOptions, auth: createAuth(db.pool, authOptions) });
const password = (await readFile(`${privateDir}/seed.secret`, 'utf8')).trim();
const email = `operations-${tag}@myfin.test`;
const url = (company, path) => `/companies/${company}${path}`;
let ownerId, cookieA, cookieB, supplierA, supplierB, beans, cups;

async function request(host, path, { cookie, method = 'GET', body } = {}) {
  return app.inject({
    url: `/api${path}`,
    method,
    headers: {
      host,
      origin: `https://${host}`,
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { payload: body }),
  });
}
async function ok(host, path, options) {
  const response = await request(host, path, options);
  assert.equal(response.statusCode, 200, `${path}: ${response.statusCode} ${response.body}`);
  return response.json();
}
async function reject(host, path, options, status, error) {
  const response = await request(host, path, options);
  assert.equal(response.statusCode, status, `${path}: ${response.statusCode} ${response.body}`);
  if (error) assert.equal(response.json().error, error);
}
async function signIn(host) {
  const response = await request(host, '/auth/sign-in/email', {
    method: 'POST', body: { email, password },
  });
  assert.equal(response.statusCode, 200, response.body);
  const values = response.headers['set-cookie'];
  return (Array.isArray(values) ? values : [values]).map(value => value.split(';')[0]).join('; ');
}
const itemPayload = (id, overrides = {}) => ({
  id, name: 'Arabica beans', category: 'Ingredients', trackingMode: 'weight',
  baseUnit: 'g', barcode: `BEANS-${tag}`, onHand: 0, reorderLevel: 500,
  preferredSupplierId: supplierA.id, active: true, notes: '',
  packagings: [{ label: 'One kilogram bag', barcode: `BAG-${tag}`, quantityInBase: 1000 }],
  ...overrides,
});
const movement = (key, overrides = {}) => ({
  kind: 'receive', quantity: 2, packagingId: beans.packagings[0].id,
  supplierId: supplierA.id, unitVersion:beans.unitVersion, reason: 'Supplier delivery', idempotencyKey: key,
  ...overrides,
});
async function listed(company, host, cookie, path) {
  return (await ok(host, url(company, path), { cookie })).rows;
}

try {
  await test('synthetic workspace, host sessions and suppliers are isolated', async () => {
    await db.transaction(async client => {
      await client.query(
        'INSERT INTO myfin.workspaces(id,name,slug) VALUES($1,$2,$3)',
        [workspace, 'Operations acceptance', workspace],
      );
      await client.query(
        `INSERT INTO myfin.companies(id,workspace_id,slug,name,data)
         VALUES($1,$3,'brand-a','Brand A',$4),($2,$3,'brand-b','Brand B',$4)`,
        [companyA, companyB, workspace, { preferences: { currency: 'RM', taxRate: 0 } }],
      );
      await client.query(
        `INSERT INTO myfin.tenant_hosts(hostname,workspace_id,company_id,canonical)
         VALUES($1,$3,$4,true),($2,$3,$5,true)`,
        [hostA, hostB, workspace, companyA, companyB],
      );
      ownerId = await createIdentity(client, {
        username: 'Operations owner', email, password,
        role: 'workspace_owner', workspace_id: workspace, company_id: '',
      });
    });
    [cookieA, cookieB] = await Promise.all([signIn(hostA), signIn(hostB)]);
    supplierA = await ok(hostA, url(companyA, '/clients'), {
      cookie: cookieA, method: 'POST', body: { name: 'A supplier', type: 'Supplier' },
    });
    supplierB = await ok(hostB, url(companyB, '/clients'), {
      cookie: cookieB, method: 'POST', body: { name: 'B supplier', type: 'Supplier' },
    });
    assert.notEqual(supplierA.id, supplierB.id);
    await reject(hostA, url(companyB, '/stock_items'), { cookie: cookieA }, 404);
    await reject(hostB, url(companyA, '/stock_items'), { cookie: cookieB }, 404);
  });

  await test('stock items and barcodes are tenant scoped; opening stock has one ledger entry', async () => {
    beans = await ok(hostA, url(companyA, '/stock_items'), {
      cookie: cookieA, method: 'POST', body: itemPayload(`beans-${tag}`),
    });
    assert.equal(beans.onHand, 0);
    assert.match(beans.internalCode, /^STK-\d{6,}$/);
    assert.equal(beans.packagings.length, 1);
    const twin = await ok(hostB, url(companyB, '/stock_items'), {
      cookie: cookieB, method: 'POST', body: itemPayload(beans.id, {
        name: 'Brand B beans', barcode: `BEANS-B-${tag}`,
        preferredSupplierId: supplierB.id,
        packagings: [{ label: 'B bag', barcode: `BAG-B-${tag}`, quantityInBase: 500 }],
      }),
    });
    assert.equal(twin.id, beans.id);
    assert.match(twin.internalCode, /^STK-\d{6,}$/);
    assert.deepEqual((await listed(companyA, hostA, cookieA, '/stock_items')).map(row => row.name), ['Arabica beans']);
    assert.deepEqual((await listed(companyB, hostB, cookieB, '/stock_items')).map(row => row.name), ['Brand B beans']);
    await reject(hostA, url(companyA, '/stock_items'), {
      cookie: cookieA, method: 'POST', body: itemPayload(`wrong-supplier-${tag}`, {
        barcode: `OTHER-${tag}`, preferredSupplierId: supplierB.id, packagings: [],
      }),
    }, 409, 'supplier_not_found');

    const concurrent = await Promise.all(['one','two'].map(label => ok(hostA, url(companyA, '/stock_items'), {
      cookie:cookieA,method:'POST',body:itemPayload(`concurrent-${label}-${tag}`,{
        name:`Concurrent ${label}`,barcode:'',preferredSupplierId:'',packagings:[],
      }),
    })));
    assert.equal(new Set(concurrent.map(row=>row.internalCode)).size,2);
    assert.ok(concurrent.every(row=>/^STK-\d{6,}$/.test(row.internalCode)));

    cups = await ok(hostA, url(companyA, '/stock_items'), {
      cookie: cookieA, method: 'POST', body: itemPayload(`cups-${tag}`, {
        name: 'Paper cups', trackingMode: 'count', baseUnit: 'pcs', barcode: `CUPS-${tag}`,
        onHand: 12, reorderLevel: 5,
        packagings: [{ label: 'Sleeve', barcode: `SLEEVE-${tag}`, quantityInBase: 12 }],
      }),
    });
    assert.equal(cups.onHand, 12);
    const opening = (await listed(companyA, hostA, cookieA, '/stock_ledger')).filter(row => row.itemId === cups.id);
    assert.equal(opening.length, 1);
    assert.equal(opening[0].kind, 'adjust');
    assert.equal(opening[0].quantityAfter, 12);
  });

  await test('packaged receipt is exactly once and consumed packaging cannot be rewritten', async () => {
    const key = `receive-${tag}`;
    const first = await ok(hostA, url(companyA, `/stock_items/${beans.id}/movements`), {
      cookie: cookieA, method: 'POST', body: movement(key),
    });
    assert.equal(first.duplicate, false);
    assert.equal(first.movement.inputQuantity, 2000);
    assert.equal(first.movement.quantityAfter, 2000);
    assert.equal(first.movement.packagingId, beans.packagings[0].id);
    const replay = await ok(hostA, url(companyA, `/stock_items/${beans.id}/movements`), {
      cookie: cookieA, method: 'POST', body: movement(key),
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.movement.id, first.movement.id);
    await reject(hostA, url(companyA, `/stock_items/${beans.id}/movements`), {
      cookie: cookieA, method: 'POST', body: movement(key, { quantity: 3 }),
    }, 409, 'stock_movement_payload_changed');
    const brandB = (await listed(companyB, hostB, cookieB, '/stock_items'))[0];
    const independent = await ok(hostB, url(companyB, `/stock_items/${brandB.id}/movements`), {
      cookie: cookieB, method: 'POST', body: {
        kind: 'receive', quantity: 2, packagingId: brandB.packagings[0].id,
        supplierId: supplierB.id, unitVersion:brandB.unitVersion, reason: 'Brand B delivery', idempotencyKey: key,
      },
    });
    assert.equal(independent.duplicate, false);
    assert.equal(independent.movement.quantityAfter, 1000);
    assert.equal((await listed(companyA, hostA, cookieA, '/stock_ledger')).filter(row => row.itemId === beans.id).length, 1);
    beans = (await listed(companyA, hostA, cookieA, '/stock_items')).find(row => row.id === beans.id);
    assert.equal(beans.onHand, 2000);
    await reject(hostA, url(companyA, `/stock_items/${beans.id}`), {
      cookie: cookieA, method: 'PUT', body: { ...beans, onHand: 3000 },
    }, 409, 'use_stock_movement');
    await reject(hostA, url(companyA, `/stock_items/${beans.id}`), {
      cookie: cookieA, method: 'PUT', body: {
        ...beans, packagings: [{ ...beans.packagings[0], quantityInBase: 750 }],
      },
    }, 409, 'used_packaging_immutable');
    await reject(hostA, url(companyA, `/stock_items/${beans.id}`), {
      cookie: cookieA, method: 'PUT', body: { ...beans, baseUnit: 'kg' },
    }, 409, 'stock_unit_correction_required');
    beans = await ok(hostA, url(companyA, `/stock_items/${beans.id}`), {
      cookie: cookieA, method: 'PUT', body: {
        ...beans, name: 'Arabica beans, roast 2',
        packagings: [...beans.packagings, { label: 'Half bag', barcode: `HALF-${tag}`, quantityInBase: 500 }],
      },
    });
    assert.equal(beans.name, 'Arabica beans, roast 2');
    assert.equal(beans.packagings.length, 2);
    assert.equal(beans.onHand, 2000);
  });

  await test('counted items reject fractions and record physical count in whole units', async () => {
    await reject(hostA, url(companyA, '/stock_items'), {
      cookie: cookieA, method: 'POST', body: itemPayload(`fractional-${tag}`, {
        name: 'Invalid counted item', trackingMode: 'count', baseUnit: 'pcs',
        barcode: `FRACTIONAL-${tag}`, packagings: [], onHand: 1.5,
      }),
    }, 400, 'counted_stock_requires_whole_units');
    await reject(hostA, url(companyA, `/stock_items/${cups.id}/movements`), {
      cookie: cookieA, method: 'POST', body: {
        kind: 'receive', quantity: 0.5, unitVersion:cups.unitVersion, reason: 'Half sleeve', idempotencyKey: `half-${tag}`,
      },
    }, 400, 'counted_stock_requires_whole_units');
    const receipt = await ok(hostA, url(companyA, `/stock_items/${cups.id}/movements`), {
      cookie: cookieA, method: 'POST', body: {
        kind: 'receive', quantity: 2, packagingId: cups.packagings[0].id,
        unitVersion:cups.unitVersion, reason: 'Two sleeves', idempotencyKey: `sleeves-${tag}`,
      },
    });
    assert.equal(receipt.movement.inputQuantity, 24);
    assert.equal(receipt.item.onHand, 36);
    const count = await ok(hostA, url(companyA, `/stock_items/${cups.id}/movements`), {
      cookie: cookieA, method: 'POST', body: {
        kind: 'count', quantity: 35, unitVersion:cups.unitVersion, reason: 'Physical count', idempotencyKey: `count-${tag}`,
      },
    });
    assert.equal(count.movement.delta, -1);
    assert.equal(count.movement.quantityAfter, 35);
    assert.equal((await listed(companyA, hostA, cookieA, '/stock_items')).find(row => row.id === cups.id).onHand, 35);
  });

  await test('unit correction preserves old movement units and rejects a stale device form', async () => {
    const milk = await ok(hostA, url(companyA, '/stock_items'), {
      cookie: cookieA, method: 'POST', body: itemPayload(`milk-${tag}`, {
        name: 'Fresh milk', trackingMode: 'volume', baseUnit: 'L', barcode: `MILK-${tag}`,
        onHand: 1.25, reorderLevel: 0.25,
        packagings: [{ label: 'One litre carton', barcode: `MILK-CARTON-${tag}`, quantityInBase: 1 }],
      }),
    });
    const corrected = await ok(hostA, url(companyA, `/stock_items/${milk.id}`), {
      cookie: cookieA, method: 'PUT', body: {
        ...milk, baseUnit: 'ml',
        unitCorrection: { strategy: 'convert', conversionFactor: 1000, reason: 'Use millilitres for recipe accuracy' },
      },
    });
    assert.equal(corrected.unitVersion, milk.unitVersion + 1);
    assert.equal(corrected.onHand, 1250);
    assert.equal(corrected.reorderLevel, 250);
    assert.equal(corrected.packagings[0].quantityInBase, 1000);
    await reject(hostA, url(companyA, `/stock_items/${milk.id}/movements`), {
      cookie: cookieA, method: 'POST', body: {
        kind: 'receive', quantity: 1, unitVersion: milk.unitVersion,
        reason: 'Stale device delivery', idempotencyKey: `stale-unit-${tag}`,
      },
    }, 409, 'stock_unit_changed_reload');
    const received = await ok(hostA, url(companyA, `/stock_items/${milk.id}/movements`), {
      cookie: cookieA, method: 'POST', body: {
        kind: 'receive', quantity: 1, packagingId: corrected.packagings[0].id,
        unitVersion: corrected.unitVersion, reason: 'Supplier carton', idempotencyKey: `new-unit-${tag}`,
      },
    });
    assert.equal(received.movement.inputQuantity, 1000);
    assert.equal(received.item.onHand, 2250);
    const history = (await listed(companyA, hostA, cookieA, '/stock_ledger')).filter(row => row.itemId === milk.id);
    assert.equal(history.length, 2);
    const opening = history.find(row => row.kind === 'adjust'), delivery = history.find(row => row.kind === 'receive');
    assert.deepEqual([opening.baseUnitAtTime, opening.unitVersionAtTime, opening.quantityAfter], ['L', 1, 1.25]);
    assert.deepEqual([delivery.baseUnitAtTime, delivery.unitVersionAtTime, delivery.packagingQuantityAtTime], ['ml', 2, 1000]);
  });

  await test('owner purge deletes only an unused archived item and never reuses its printed code', async () => {
    const unused = await ok(hostA, url(companyA, '/stock_items'), {
      cookie: cookieA, method: 'POST', body: itemPayload(`unused-${tag}`, {
        name: 'Unused sample', barcode: '', onHand: 0, reorderLevel: 0,
        preferredSupplierId: '', packagings: [],
      }),
    });
    const activeCheck = await ok(hostA, url(companyA, `/stock_items/${unused.id}/purge-check`), { cookie: cookieA });
    assert.equal(activeCheck.canPurge, false);
    await reject(hostA, url(companyA, `/stock_items/${unused.id}/purge`), {
      cookie: cookieA, method: 'DELETE',
    }, 409, 'archive_stock_item_before_purge');
    await ok(hostA, url(companyA, `/stock_items/${unused.id}`), { cookie: cookieA, method: 'DELETE' });
    const archivedCheck = await ok(hostA, url(companyA, `/stock_items/${unused.id}/purge-check`), { cookie: cookieA });
    assert.equal(archivedCheck.canPurge, true);
    await ok(hostA, url(companyA, `/stock_items/${unused.id}/purge`), { cookie: cookieA, method: 'DELETE' });
    const replacement = await ok(hostA, url(companyA, '/stock_items'), {
      cookie: cookieA, method: 'POST', body: itemPayload(`replacement-${tag}`, {
        name: 'Replacement sample', barcode: '', onHand: 0, reorderLevel: 0,
        preferredSupplierId: '', packagings: [],
      }),
    });
    const codeNumber = row => BigInt(row.internalCode.slice(4));
    assert.ok(codeNumber(replacement) > codeNumber(unused));
  });

  await test('supplier-linked CSV import repeats by batch key and remains tenant isolated', async () => {
    const csv = `date,description,category,amount,supplier_id,supplier_name,payee\n2026-09-29,Arabica delivery,Inventory,19.90,,A supplier,\n2026-09-29,Packaging,Inventory,5.25,,,Paper seller`;
    const rows = importExpensesCsv(csv, [supplierA]);
    assert.equal(rows[0].supplier_id, supplierA.id);
    const batchId = `expense-${tag}`;
    const pathA = url(companyA, '/import-expenses');
    const first = await ok(hostA, pathA, {
      cookie: cookieA, method: 'POST', body: { batchId, rows },
    });
    assert.deepEqual(first, { count: 2, alreadyImported: false });
    assert.deepEqual(await ok(hostA, pathA, {
      cookie: cookieA, method: 'POST', body: { batchId, rows },
    }), { count: 2, alreadyImported: true });
    await reject(hostA, pathA, {
      cookie: cookieA, method: 'POST', body: {
        batchId, rows: [{ ...rows[0], amount: 20.90 }, rows[1]],
      },
    }, 409, 'expense_import_payload_changed');
    const saved = (await db.query(
      `SELECT id,supplier_id,amount,data FROM myfin.expenses
       WHERE company_id=$1 AND data->>'description' IN ('Arabica delivery','Packaging') ORDER BY amount DESC`,
      [companyA],
    )).rows;
    assert.equal(saved.length, 2);
    assert.equal(saved[0].supplier_id, supplierA.id);
    assert.equal(saved[0].amount, '19.90');
    assert.equal(saved[0].data.payee, 'A supplier');
    assert.equal(saved[1].supplier_id, null);

    const linked = await ok(hostA, url(companyA, `/stock_items/${beans.id}/movements`), {
      cookie: cookieA, method: 'POST', body: movement(`expense-link-${tag}`, {
        quantity: 1, expenseId: saved[0].id,
      }),
    });
    assert.equal(linked.movement.supplierId, supplierA.id);
    assert.equal(linked.movement.expenseId, saved[0].id);
    const evidenceMovement=(await db.query(`SELECT id FROM myfin.stock_ledger
      WHERE company_id=$1 AND expense_id IS NULL ORDER BY created_at,id LIMIT 1`,[companyA])).rows[0].id;
    const purchaseOrderId=`expense-po-${tag}`,goodsReceiptId=`expense-gr-${tag}`;
    await admin.query(`INSERT INTO myfin.purchase_orders(company_id,id,number,supplier_id,total_sen,idempotency_key,
      request_digest,created_by) VALUES($1,$2,$3,$4,100,$5,$6,$7)`,
    [companyA,purchaseOrderId,`PO-EXP-${tag}`,supplierA.id,`expense-po-key-${tag}`,'1'.repeat(64),ownerId]);
    await admin.query(`INSERT INTO myfin.goods_receipts(company_id,id,purchase_order_id,reference,received_at,
      idempotency_key,request_digest,received_by) VALUES($1,$2,$3,$4,now(),$5,$6,$7)`,
    [companyA,goodsReceiptId,purchaseOrderId,`GR-EXP-${tag}`,`expense-gr-key-${tag}`,'2'.repeat(64),ownerId]);
    const linkedTypes=await ok(hostA,url(companyA,'/expenses'),{cookie:cookieA,method:'POST',body:{
      id:randomUUID(),date:'2026-09-29',description:'All linked evidence',amount:1,status:'paid',paidOn:'2026-09-29',
      paidByType:'other',paidByName:'Acceptance business account',links:[
        {type:'stock_item',id:beans.id},{type:'stock_movement',id:evidenceMovement},
        {type:'purchase_order',id:purchaseOrderId},{type:'goods_receipt',id:goodsReceiptId},
      ],
    }});
    assert.deepEqual(linkedTypes.links.map(row=>row.type),
      ['goods_receipt','purchase_order','stock_item','stock_movement']);
    await reject(hostA, url(companyA, `/stock_items/${beans.id}/movements`), {
      cookie: cookieA, method: 'POST', body: movement(`foreign-expense-${tag}`, {
        supplierId: supplierB.id,
      }),
    }, 409, 'supplier_not_found');

    await reject(hostA, pathA, {
      cookie: cookieA, method: 'POST', body: {
        batchId: `foreign-${tag}`, rows: [{ ...rows[0], supplier_id: supplierB.id }],
      },
    }, 409, 'supplier_not_found');
    assert.equal((await db.query(
      'SELECT count(*)::int AS n FROM myfin.expense_import_batches WHERE company_id=$1 AND batch_id=$2',
      [companyA, `foreign-${tag}`],
    )).rows[0].n, 0);
    const otherRows = importExpensesCsv(
      'date,description,amount,supplier_name\n2026-09-29,Brand B delivery,3.50,B supplier',
      [supplierB],
    );
    assert.deepEqual(await ok(hostB, url(companyB, '/import-expenses'), {
      cookie: cookieB, method: 'POST', body: { batchId, rows: otherRows },
    }), { count: 1, alreadyImported: false });
    assert.equal((await db.query(
      'SELECT count(*)::int AS n FROM myfin.expense_import_batches WHERE batch_id=$1',
      [batchId],
    )).rows[0].n, 2);
    assert.equal((await listed(companyB, hostB, cookieB, '/expenses')).length, 1);
    // Two imported expenses plus the linked-evidence expense created above.
    assert.equal((await listed(companyA, hostA, cookieA, '/expenses')).length, 3);
  });

  await test('archived stock stops movements while its ledger remains readable', async () => {
    const prior = (await listed(companyA, hostA, cookieA, '/stock_ledger'))
      .filter(row => row.itemId === beans.id).length;
    assert.equal((await ok(hostA, url(companyA, `/stock_items/${beans.id}`), {
      cookie: cookieA, method: 'DELETE',
    })).ok, true);
    const archived = (await listed(companyA, hostA, cookieA, '/stock_items'))
      .find(row => row.id === beans.id);
    assert.equal(archived.active, false);
    await reject(hostA, url(companyA, `/stock_items/${beans.id}/movements`), {
      cookie: cookieA, method: 'POST', body: movement(`archived-${tag}`),
    }, 404, 'stock_item_not_found');
    assert.equal((await listed(companyA, hostA, cookieA, '/stock_ledger'))
      .filter(row => row.itemId === beans.id).length, prior);
  });
} finally {
  await app.close();
  await admin.end();
}
