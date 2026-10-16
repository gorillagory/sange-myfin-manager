import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assessPromotionHold, scarceHoldExpiry } from '../src/storefront-public.js';

const secret = 'promotion-guard-test-secret-0123456789abcdef';
const base = {
  workspaceId: 'workspace-a', companyId: 'company-a', snapshotId: 'snapshot-a',
  customerId: '', guestSessionDigest: 'a'.repeat(64), guestEmail: 'guest@example.test',
  guestPhone: '+60 12-345 6789', secret,
};

function client(applications, counts = []) {
  const calls = [];
  return { calls, async query(sql, params = []) {
    calls.push({ sql, params });
    if (sql.includes('FROM myfin.pricing_snapshot_discounts d'))
      return { rows: applications, rowCount: applications.length };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('anonymous_campaign_holds')) {
      const row = counts.shift() || {};
      return { rows: [{ promotion_id:applications[0]?.promotion_id,
        session_holds:0, customer_holds:0, email_holds:0, phone_holds:0,
        anonymous_campaign_holds:0, anonymous_voucher_holds:0, ...row }], rowCount: 1 };
    }
    throw new Error(`unexpected_sql:${sql}`);
  } };
}

const limited = (overrides = {}) => ({ promotion_id:'promotion-a', voucher_id:null,
  max_total_redemptions:'20', voucher_max_redemptions:null, ...overrides });

test('unlimited promotions do not add a hold guard or shorten an anonymous order', async () => {
  const c = client([]);
  const result = await assessPromotionHold(c, base);
  assert.deepEqual(result, { allowed:true, limitedPromotionCount:0, hasVoucher:false });
  assert.equal(c.calls.length, 1);
  const configured = new Date('2026-10-16T01:30:00.000Z');
  assert.equal(scarceHoldExpiry(configured, result, '', Date.parse('2026-10-16T01:00:00.000Z')).toISOString(),
    configured.toISOString());
});

test('scarce guest campaigns serialize secret-keyed durable principals and permit the first hold', async () => {
  const c = client([limited()]);
  const result = await assessPromotionHold(c, base);
  assert.equal(result.allowed, true);
  const locks = c.calls.filter(call => call.sql.includes('pg_advisory_xact_lock'));
  assert.equal(locks.length, 4,
    'session, email, phone and anonymous campaign budget are serialized');
  for (const lock of locks) {
    const key = lock.params[0];
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(key, /guest|example|3456789|promotion-a/);
  }
  const configured = new Date('2026-10-16T01:30:00.000Z');
  assert.equal(scarceHoldExpiry(configured, result, '', Date.parse('2026-10-16T01:00:00.000Z')).toISOString(),
    '2026-10-16T01:05:00.000Z');
});

test('session or contact identity blocks a second active scarce hold across IP and cookie changes', async () => {
  const session = client([limited()], [{ session_holds:1 }]);
  assert.deepEqual(await assessPromotionHold(session, base), {
    allowed:false, reason:'principal_active_hold', limitedPromotionCount:1, hasVoucher:false,
  });

  const rotatedSession = client([limited()], [{ email_holds:1 }]);
  const result = await assessPromotionHold(rotatedSession, { ...base, guestSessionDigest:'b'.repeat(64) });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'principal_active_hold');
  const count = rotatedSession.calls.find(call => call.sql.includes('anonymous_campaign_holds'));
  assert.equal(count.params[3], 'guest@example.test');
  assert.equal(count.params[4], '60123456789');
});

test('registered identity is serialized and capped without shortening its accepted checkout window', async () => {
  const c = client([limited()], [{ customer_holds:1 }]);
  const result = await assessPromotionHold(c, { ...base, customerId:'customer-a' });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'principal_active_hold');
  const count = c.calls.find(call => call.sql.includes('anonymous_campaign_holds'));
  assert.equal(count.params[3], '');
  assert.equal(count.params[4], '', 'untrusted guest contact cannot block a signed-in customer');
  const configured = new Date('2026-10-16T01:30:00.000Z');
  assert.equal(scarceHoldExpiry(configured, { limitedPromotionCount:1 }, 'customer-a',
    Date.parse('2026-10-16T01:00:00.000Z')).toISOString(), configured.toISOString());
});

test('anonymous campaign and voucher budgets preserve capacity across fresh principals', async () => {
  const campaign = client([limited({ max_total_redemptions:'8' })], [{ anonymous_campaign_holds:2 }]);
  let result = await assessPromotionHold(campaign, base);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'anonymous_campaign_budget');

  const voucher = client([limited({ max_total_redemptions:null, voucher_id:'voucher-a',
    voucher_max_redemptions:'4' })], [{ anonymous_voucher_holds:1 }]);
  result = await assessPromotionHold(voucher, base);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'anonymous_voucher_budget');
  assert.equal(result.hasVoucher, true);
  assert.equal(voucher.calls.filter(call => call.sql.includes('pg_advisory_xact_lock')).length, 4,
    'the common anonymous budget lock also serializes voucher capacity');
});

test('missing durable principal or signing secret fails closed before any reservation count', async () => {
  const c = client([limited()]);
  const result = await assessPromotionHold(c, { ...base, guestSessionDigest:'' });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'principal_unavailable');
  assert.equal(c.calls.some(call => call.sql.includes('anonymous_campaign_holds')), false);
  assert.equal(c.calls.some(call => call.sql.includes('pg_advisory_xact_lock')), false);
});

test('public submit preserves idempotent replay before guard and emits only safe denial metadata', async () => {
  const source = await readFile(new URL('../src/storefront-public.js', import.meta.url), 'utf8');
  const submit = source.slice(source.indexOf("app.post('/api/public/order-requests'"),
    source.indexOf("app.get('/api/public/order-requests/:code/status'"));
  assert.ok(submit.indexOf('if (existing)') < submit.indexOf('await assessPromotionHold'));
  assert.ok(submit.indexOf('await assessPromotionHold') < submit.indexOf('INSERT INTO myfin.customer_order_requests'));
  assert.match(submit, /event: 'storefront_promotion_hold_blocked'/);
  const warning = submit.slice(submit.indexOf("req.log?.warn"), submit.indexOf("v.fail(409, 'promotion_unavailable')"));
  assert.doesNotMatch(warning, /guestEmail|guestPhone|guestSessionDigest|customerId|promotionId|voucherId/);
  assert.match(submit, /const expiresAt = scarceHoldExpiry/);
  assert.match(submit, /reserveOrderPromotions[\s\S]*expiresAt/);
});
