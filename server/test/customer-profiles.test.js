import test from 'node:test';
import assert from 'node:assert/strict';
import { literalLike, registerCustomerProfiles } from '../src/customer-profiles.js';

function fixture(role = 'manager') {
  const routes = new Map(), calls = [];
  const app = { get(path, handler) { routes.set(path, handler); } };
  const row = { id: 'customer-a', account_name: 'Account name', profile_name: 'Amina', profile_phone: '0123',
    primary_email: 'amina@example.test', email_verified: true, disabled_at: null,
    order_count: 4, paid_order_count: 3, paid_spend: '59.70', first_order_at: new Date('2026-01-01'),
    last_order_at: new Date('2026-02-01'), stamp_balance: 3,
    consents: { email: { granted: true, noticeVersion: 'v1', source: 'profile', updatedAt: '2026-02-01T00:00:00Z' } } };
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT workspace_id')) return { rowCount: 1, rows: [{ workspace_id: 'workspace-a' }] };
    if (sql.includes('WITH order_stats')) return { rowCount: 1, rows: [row] };
    if (sql.includes('workspace_loyalty_settings')) return { rowCount: 1, rows: [{ enabled: true,
      stamps_required: 8, reward_label: 'Free drink', minimum_spend: '5.00' }] };
    throw Error(`unexpected query: ${sql}`);
  } };
  const scoped = (req, fn) => fn(client, req.params.company);
  registerCustomerProfiles(app, { scoped });
  return { handler: routes.get('/api/companies/:company/customer-profiles'), calls,
    req: { params: { company: 'company-a' }, query: {}, identity: { id: 'staff-a', role } } };
}

test('manager sees only company-order customers with workspace loyalty and latest consent summaries', async () => {
  const { handler, req, calls } = fixture();
  const result = await handler(req);
  assert.equal(result.workspaceId, 'workspace-a');
  assert.deepEqual(result.loyaltySettings, { enabled: true, stampsRequired: 8,
    rewardLabel: 'Free drink', minimumSpend: 5, earnRule: 'one_stamp_per_eligible_paid_order' });
  assert.deepEqual(result.rows[0], {
    customerId: 'customer-a', displayName: 'Amina', phone: '0123', email: 'amina@example.test',
    emailVerified: true, active: true, orderCount: 4, paidOrderCount: 3, paidSpend: 59.7,
    firstOrderAt: new Date('2026-01-01'), lastOrderAt: new Date('2026-02-01'), loyaltyBalance: 3,
    marketingConsent: { email: { granted: true, noticeVersion: 'v1', source: 'profile', updatedAt: '2026-02-01T00:00:00Z' },
      sms: null, whatsapp: null },
  });
  const sql = calls.find(call => call.sql.includes('WITH order_stats')).sql;
  assert.match(sql, /WHERE company_id=\$1 AND customer_id IS NOT NULL/);
  assert.doesNotMatch(sql, /auth_(?:account|session|verification)/);
});

test('operators are denied before any customer data query', async () => {
  const { handler, req, calls } = fixture('operator');
  await assert.rejects(handler(req), error => error.statusCode === 403 && error.message === 'access_denied');
  assert.equal(calls.length, 0);
});

test('search is bounded, literal and parameterized while pagination remains stable', async () => {
  const { handler, req, calls } = fixture('workspace_owner');
  await handler({ ...req, query: { q: 'A%_\\B', limit: '20', after: 'customer-0' } });
  const query = calls.find(call => call.sql.includes('WITH order_stats'));
  assert.equal(query.params[2], `%${literalLike('a%_\\b')}%`);
  assert.equal(query.params[3], 'customer-0');
  assert.equal(query.params[4], 21);
  assert.match(query.sql, /LIKE \$3 ESCAPE '\\'/);
});
