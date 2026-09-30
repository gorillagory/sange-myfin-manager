import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCustomerOrderHistory } from '../src/customer-order-history.js';

function fixture({ authenticated = true } = {}) {
  const routes = new Map(), calls = [];
  const app = { get(path, _options, handler) { routes.set(path, handler); } };
  const now = new Date(), future = new Date(Date.now() + 600000);
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('FROM myfin.customer_sessions')) return { rowCount: 1, rows: [{ token_digest: 'd'.repeat(64),
      customer_id: 'customer-a', expires_at: future, display_name: 'Amina', primary_email: 'amina@example.test',
      email_verified_at: now }] };
    if (sql.startsWith('UPDATE myfin.customer_sessions')) return { rowCount: 1, rows: [] };
    if (sql.includes('WITH candidates AS')) return { rowCount: 0, rows: [] };
    if (sql.includes('WHERE o.company_id=$1 AND o.customer_id=$2')) return { rowCount: 1, rows: [{
      id: 'order-a', public_code: 'ABC12345', company_id: 'company-a', location_id: 'counter',
      customer_id: 'customer-a', guest_name: 'Amina', guest_email: 'hidden@example.test', guest_phone: 'hidden',
      status: 'awaiting_acceptance', payment_state: 'unpaid', version: 1, currency: 'RM', subtotal: '9.90',
      discount_amount: '0', tax: '0', tax_rate: '0', total_before_rounding: '9.90', rounding: '0', total: '9.90',
      notes: '', expires_at: future, created_at: now, updated_at: now, fulfillment_status: null,
      location_name: 'Main counter', fulfillment_mode: 'pickup', table_label: '', pickup_instructions: 'Ask staff',
    }] };
    if (sql.includes('FROM myfin.customer_order_lines')) return { rowCount: 1, rows: [{ order_id: 'order-a',
      product_id: 'latte', variant_id: null, description: 'Latte', variant_name: '', sku: 'INTERNAL-SKU',
      unit: 'cup', quantity: '1', unit_price: '9.9000', line_total: '9.90' }] };
    if (sql.includes('FROM myfin.customer_order_events')) return { rowCount: 1, rows: [{ order_id: 'order-a',
      version: 1, to_status: 'awaiting_acceptance', created_at: now, staff_actor_id: 'secret-staff' }] };
    throw Error(`unexpected query: ${sql}`);
  } };
  registerCustomerOrderHistory(app, { db: { transaction: fn => fn(client) },
    authOptions: { publicProxyAddresses: [] } });
  return { handler: routes.get('/api/public/customer/orders'), calls,
    req: { tenant: { surface: 'storefront', company_id: 'company-a' }, query: { limit: '20' },
      headers: authenticated ? { cookie: `__Secure-myfin_customer_session=${'A'.repeat(43)}` } : {},
      socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' } };
}

test('signed-in customer sees only own orders for the current storefront company', async () => {
  const { handler, req, calls } = fixture();
  const result = await handler(req);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].status, 'submitted');
  assert.equal(result.rows[0].location.name, 'Main counter');
  assert.equal(result.rows[0].items[0].sku, undefined);
  assert.deepEqual(result.rows[0].events.map(event => event.status), ['submitted']);
  assert.equal(result.rows[0].guestEmail, undefined);
  assert.equal(result.rows[0].guestPhone, undefined);
  assert.equal(result.rows[0].guestName, undefined);
  assert.equal(result.rows[0].customerId, undefined);
  assert.equal(result.rows[0].events[0].actorId, undefined);
  const orderQuery = calls.find(call => call.sql.includes('WHERE o.company_id=$1 AND o.customer_id=$2'));
  assert.deepEqual(orderQuery.params, ['company-a', 'customer-a', 20]);
  assert.match(orderQuery.sql, /o\.company_id=\$1 AND o\.customer_id=\$2/);
  assert.doesNotMatch(orderQuery.sql, /guest_session_digest/);
});

test('guest is rejected and cannot fall back to the guest order cookie', async () => {
  const { handler, req, calls } = fixture({ authenticated: false });
  await assert.rejects(handler(req), error => error.statusCode === 401 && error.message === 'customer_session_required');
  assert.equal(calls.length, 0);
});

test('order history limit is bounded before database access', async () => {
  const { handler, req, calls } = fixture();
  await assert.rejects(handler({ ...req, query: { limit: '101' } }),
    error => error.statusCode === 400 && error.message === 'invalid_input');
  assert.equal(calls.length, 0);
});
