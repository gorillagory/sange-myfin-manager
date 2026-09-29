import test from 'node:test';
import assert from 'node:assert/strict';
import { registerOrders, assertOrderCreated } from '../src/orders.js';

function fixture(role = 'operator') {
  const company = 'company-a', saleId = 'paid-sale-a';
  const row = {
    company_id: company, id: saleId, sale_actor_id: 'actor-a', status: 'pending', version: 1,
    legacy: false, client_id: null, customer_name: '', customer_display: 'Walk-in customer',
    sale_data: { number: 'POS-PAID-SALE-A', date: '2026-09-30T08:00:00.000Z',
      customerEmail: 'private@example.test', paymentMethod: 'Cash', total: 10,
      items: [{ productId: 'product-a', desc: 'Coffee', qty: 2, unit: 'cup', price: 5, cost: 3 }] },
    created_at: new Date('2026-09-30T08:00:00.000Z'), updated_at: new Date('2026-09-30T08:00:00.000Z'),
    completed_at: null,
  };
  const records = [], calls = [], audits = [];
  const c = { async query(sql, params = []) {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT id FROM myfin.orders'))
      return { rowCount: params[0] === company && params[1] === saleId ? 1 : 0,
        rows: params[0] === company && params[1] === saleId ? [{ id: saleId }] : [] };
    if (sql.includes('count(*)::integer AS count'))
      return { rows: params[0] === company &&
        (params[1] || row.status !== 'completed' || row.sale_actor_id === params[2])
        ? [{ status: row.status, count: 1 }] : [] };
    if (sql.includes('SELECT o.*,t.data AS sale_data')) {
      const visible = params[0] === company && (!sql.includes('o.id=$2') || params[1] === saleId) &&
        (!sql.includes("$2='all'") || ['all', 'active', row.status].includes(params[1]) &&
          (params[1] !== 'active' || row.status !== 'completed')) &&
        (params[2] || row.status !== 'completed' || row.sale_actor_id === params[3]);
      return { rowCount: visible ? 1 : 0, rows: visible ? [{ ...row }] : [] };
    }
    if (sql.includes('SELECT * FROM myfin.order_events WHERE company_id')) {
      const event = records.find(item => item.request_id === params[1]);
      return { rowCount: event ? 1 : 0, rows: event ? [event] : [] };
    }
    if (sql.includes('SELECT e.*,i.display_name'))
      return { rows: records.map(event => ({ ...event, display_name: 'Cashier' })) };
    if (sql.startsWith('UPDATE myfin.orders')) {
      row.status = params[2]; row.version++;
      row.completed_at = row.status === 'completed' ? new Date() : null;
      return { rowCount: 1, rows: [{ status: row.status, version: row.version,
        updated_at: new Date(), completed_at: row.completed_at }] };
    }
    if (sql.startsWith('INSERT INTO myfin.order_events')) {
      records.push({ id: params[1], order_id: params[2], version: params[3], actor_id: params[4],
        request_id: params[5], request_digest: params[6], action: 'status_changed',
        from_status: params[7], to_status: params[8], note: params[9], created_at: new Date() });
      return { rowCount: 1, rows: [] };
    }
    throw Error(`Unexpected query: ${sql}`);
  } };
  const routes = new Map(), app = {
    get: (path, handler) => routes.set(`GET ${path}`, handler),
    post: (path, handler) => routes.set(`POST ${path}`, handler),
  };
  registerOrders(app, { scoped: (req, fn) => fn(c, req.params.company),
    audit: async (...args) => { audits.push(args); } });
  const req = { params: { company, id: saleId }, identity: { id: 'actor-a', role }, query: {} };
  return { routes, req, row, records, calls, audits, c };
}

test('checkout hook verifies that the atomic insert trigger created exactly one order', async () => {
  const { c } = fixture();
  await assertOrderCreated(c, 'company-a', 'paid-sale-a');
  await assert.rejects(assertOrderCreated(c, 'company-b', 'paid-sale-a'),
    error => error.statusCode === 500 && error.message === 'order_creation_failed');
});

test('order queue is company scoped and excludes payment, price, cost, and contact data', async () => {
  const { routes, req, calls, row } = fixture();
  const list = routes.get('GET /api/companies/:company/orders');
  const response = await list(req);
  assert.equal(response.counts.active, 1);
  assert.equal(response.rows[0].number, 'POS-PAID-SALE-A');
  assert.deepEqual(response.rows[0].items, [{ productId: 'product-a', variantId: '',
    description: 'Coffee', variant: '', quantity: 2, unit: 'cup', sku: '' }]);
  for (const secret of ['private@example.test', 'paymentMethod', 'price', 'cost', 'total'])
    assert.equal(JSON.stringify(response).includes(secret), false);
  assert.equal(calls.find(call => call.sql.includes('SELECT o.*,t.data AS sale_data')).params[0], 'company-a');
  assert.equal((await list({ ...req, params: { company: 'company-b' } })).rows.length, 0);
  row.customer_name = row.customer_display = 'private@example.test';
  assert.equal((await list(req)).rows[0].customerName, 'Customer',
    'email used as a checkout name must not enter the shared queue');
  row.customer_name = row.customer_display = ' private@example.test ';
  row.sale_data.customerEmail = '';
  assert.equal((await list(req)).rows[0].customerName, 'Customer',
    'whitespace around an email must not bypass the shared-queue mask');
});

test('operators share active fulfillment but see only their own completed sale history', async () => {
  const { routes, req, row } = fixture();
  row.sale_actor_id = 'other-cashier';
  const list = routes.get('GET /api/companies/:company/orders');
  const detail = routes.get('GET /api/companies/:company/orders/:id');
  assert.equal((await list(req)).rows.length, 1, 'all company operators can finish active work');
  row.status = 'completed'; row.completed_at = new Date();
  assert.equal((await list({ ...req, query: { view: 'completed' } })).rows.length, 0);
  assert.equal((await list({ ...req, query: { view: 'completed' } })).counts.completed, 0);
  await assert.rejects(detail(req), error => error.statusCode === 404);
  assert.equal((await detail({ ...req, identity: { id: 'manager-a', role: 'manager' } })).order.status, 'completed');
});

test('live order pages use a stable created-at/id cursor and reject invalid cursors', async () => {
  const { routes, req, c, row, calls } = fixture();
  const older = { ...row, id: 'paid-sale-older', created_at: new Date('2026-09-29T08:00:00.000Z') };
  const original = c.query.bind(c);
  c.query = async (sql, params) => {
    if (sql.includes('SELECT o.*,t.data AS sale_data') && sql.includes('LIMIT $7')) {
      const rows = params[4] ? [older] : [row, older];
      return { rowCount: rows.length, rows };
    }
    return original(sql, params);
  };
  const list = routes.get('GET /api/companies/:company/orders');
  const first = await list({ ...req, query: { limit: 1 } });
  assert.equal(first.rows[0].id, row.id);
  assert.ok(first.next);
  const second = await list({ ...req, query: { limit: 1, before: first.next } });
  assert.equal(second.rows[0].id, older.id);
  assert.equal(second.next, null);
  assert.equal(calls.some(call => call.sql.includes('OFFSET')), false);
  await assert.rejects(list({ ...req, query: { before: 'tampered' } }),
    error => error.statusCode === 400 && error.message === 'invalid_order_cursor');
});

test('status changes append history once; retries, stale versions, and replay changes are safe', async () => {
  const { routes, req, records, row, audits } = fixture();
  const transition = routes.get('POST /api/companies/:company/orders/:id/transitions');
  const body = { requestId: '7d6993a0-0d18-46eb-9129-940ef5882b76', expectedVersion: 1,
    status: 'preparing', note: '' };
  const first = await transition({ ...req, body });
  assert.equal(first.order.status, 'preparing');
  assert.equal(first.order.version, 2);
  assert.equal(first.events.length, 1);
  assert.equal(records.length, 1);
  assert.equal(audits.length, 1);
  assert.equal((await transition({ ...req, body })).order.version, 2);
  assert.equal(records.length, 1);
  await assert.rejects(transition({ ...req, body: { ...body, note: 'changed' } }),
    error => error.statusCode === 409 && error.message === 'order_request_id_reused');
  await assert.rejects(transition({ ...req, body: { ...body,
    requestId: 'ef8643c8-020e-48ca-8b9a-c7e60da6893c' } }),
    error => error.statusCode === 409 && error.message === 'order_changed');
  assert.equal(row.status, 'preparing');
});

test('completion is final for operators; manager can reopen with a reason', async () => {
  const { routes, req, row, records } = fixture();
  row.status = 'completed'; row.version = 2; row.completed_at = new Date();
  const transition = routes.get('POST /api/companies/:company/orders/:id/transitions');
  const body = { requestId: '7d6993a0-0d18-46eb-9129-940ef5882b76', expectedVersion: 2,
    status: 'pending', note: 'Needs another item' };
  await assert.rejects(transition({ ...req, body }),
    error => error.statusCode === 403 && error.message === 'manager_required');
  await assert.rejects(transition({ ...req, identity: { id: 'manager-a', role: 'manager' },
    body: { ...body, note: '' } }),
    error => error.statusCode === 400 && error.message === 'order_reopen_reason_required');
  const reopened = await transition({ ...req, identity: { id: 'manager-a', role: 'manager' }, body });
  assert.equal(reopened.order.status, 'pending');
  assert.equal(reopened.order.completedAt, null);
  assert.equal(records[0].from_status, 'completed');
  assert.equal(records[0].to_status, 'pending');
});

test('a shared-queue operator can finish another cashier order and safely retry a lost response', async () => {
  const { routes, req, row } = fixture();
  row.sale_actor_id = 'other-cashier';
  const transition = routes.get('POST /api/companies/:company/orders/:id/transitions');
  const body = { requestId: '78f7313a-bc1c-4af3-a3c9-fb13687c44ef', expectedVersion: 1,
    status: 'completed', note: '' };
  assert.equal((await transition({ ...req, body })).order.status, 'completed');
  assert.equal((await transition({ ...req, body })).order.status, 'completed');
  await assert.rejects(routes.get('GET /api/companies/:company/orders/:id')(req),
    error => error.statusCode === 404);
  await assert.rejects(transition({ ...req, body: { ...body,
    requestId: '988ec385-e141-4e50-accc-1846bb51205f', expectedVersion: 2, status: 'pending' } }),
    error => error.statusCode === 404);
});

test('an old preparation request cannot reveal later completed history for another cashier', async () => {
  const { routes, req, row } = fixture();
  row.sale_actor_id = 'other-cashier';
  const transition = routes.get('POST /api/companies/:company/orders/:id/transitions');
  const body = { requestId: '3719868d-d46a-4838-ac02-7148f4e2e64e', expectedVersion: 1,
    status: 'preparing', note: '' };
  await transition({ ...req, body });
  row.status = 'completed'; row.version = 3; row.completed_at = new Date();
  await assert.rejects(transition({ ...req, body }), error => error.statusCode === 404);
});
