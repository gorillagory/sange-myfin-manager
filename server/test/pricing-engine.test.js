import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commitPricingRedemptions,
  createPricingSnapshot,
  decimalToScaledInteger,
} from '../src/pricing-engine.js';
import { voucherLookupDigest } from '../src/student-promotions.js';

const PEPPER = 'pricing-test-voucher-pepper-at-least-32-bytes';
const AT = '2026-10-09T04:00:00.000Z';

function pricingFixture(overrides = {}) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM myfin.companies')) return { rowCount: 1, rows: [{
      workspace_id: 'workspace-a', data: { preferences: { currency: 'RM', taxRate: 6 } },
    }] };
    if (sql.includes('FROM myfin.customer_accounts')) return { rowCount: 1, rows: [{ '?column?': 1 }] };
    if (sql.includes('FROM myfin.promotion_vouchers v')) return { rowCount: 1, rows: [{
      promotion_id: 'voucher-promo', id: 'voucher-a', version: '2', enabled: true,
      valid_from: '2026-01-01T00:00:00Z', valid_until: '2027-01-01T00:00:00Z',
      max_redemptions: '100', per_customer_limit: '2', total_usage: '3', customer_usage: '0',
    }] };
    if (sql.includes('FROM myfin.products p') && sql.includes('LEFT JOIN myfin.product_variants')) return {
      rowCount: 1, rows: [{ id: 'latte', data: { name: 'Latte', category: 'Beverage', subcategory: 'Coffee', variants: [] },
        product_price: '19.9999', variant_id: null, variant_price: null }],
    };
    if (sql.includes('FROM myfin.student_eligibilities')) return { rowCount: 1, rows: [{
      status: 'verified', version: '4', valid_from: '2026-01-01T00:00:00Z', valid_until: '2027-01-01T00:00:00Z',
    }] };
    if (sql.includes('FROM myfin.promotions p')) return { rowCount: 2, rows: [
      { id: 'student-promo', version: '3', name: 'Student 10%', enabled: true, redemption_mode: 'automatic',
        valid_from: '2026-01-01T00:00:00Z', valid_until: null, discount_type: 'percentage',
        discount_basis_points: 1000, discount_sen: null, max_discount_sen: null, min_subtotal_sen: '0',
        max_total_redemptions: null, per_customer_limit: null, requires_customer: true,
        requires_student: true, priority: 20, stackable: true, total_usage: '10', customer_usage: '1' },
      { id: 'voucher-promo', version: '5', name: 'Voucher RM1.25', enabled: true, redemption_mode: 'voucher',
        valid_from: '2026-01-01T00:00:00Z', valid_until: null, discount_type: 'fixed',
        discount_basis_points: null, discount_sen: '125', max_discount_sen: null, min_subtotal_sen: '0',
        max_total_redemptions: null, per_customer_limit: null, requires_customer: false,
        requires_student: false, priority: 10, stackable: true, total_usage: '7', customer_usage: '0' },
    ] };
    if (sql.includes('FROM myfin.promotion_version_products')) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM myfin.promotion_version_categories')) return { rowCount: 1, rows: [{
      promotion_id: 'student-promo', promotion_version: '3', category_key: 'beverage', subcategory_key: 'coffee',
    }] };
    if (sql.includes('FROM myfin.promotion_version_customers')) return { rowCount: 0, rows: [] };
    if (sql.startsWith('INSERT INTO myfin.')) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  return { c: { query: overrides.query || query }, calls };
}

test('decimal conversion never passes authoritative catalog prices through binary float arithmetic', () => {
  assert.equal(decimalToScaledInteger('19.9999', 2), 2000);
  assert.equal(decimalToScaledInteger('2.5549', 2), 255);
  assert.equal(decimalToScaledInteger('2.5550', 2), 256);
  assert.equal(decimalToScaledInteger(6, 2), 600);
  assert.throws(() => decimalToScaledInteger('-1', 2), /invalid_money_configuration/);
  assert.throws(() => decimalToScaledInteger('1e3', 2), /invalid_money_configuration/);
});

test('authoritative quote loads catalog, current rules, student state and HMAC voucher then stores full immutable detail', async () => {
  const fixture = pricingFixture();
  const result = await createPricingSnapshot(fixture.c, {
    workspaceId: 'workspace-a', companyId: 'company-a', customerId: 'customer-a',
    lines: [{ productId: 'latte', variantId: '', quantityMilli: 1500 }],
    voucherCode: 'STUDENT-2026',
  }, {
    voucherPepper: PEPPER, cashRounding: true, now: AT, expiresInSeconds: 300,
    idFactory: () => 'snapshot-a',
  });

  assert.equal(result.id, 'snapshot-a');
  assert.equal(result.expiresAt, '2026-10-09T04:05:00.000Z');
  assert.equal(result.currencyCode, 'MYR');
  assert.equal(result.studentEligibilityVersion, 4);
  assert.deepEqual({ subtotal: result.subtotalSen, discount: result.discountSen,
    taxable: result.taxableSen, tax: result.taxSen, rounding: result.roundingSen, total: result.totalSen },
  { subtotal: 3000, discount: 425, taxable: 2575, tax: 155, rounding: 0, total: 2730 });
  assert.deepEqual(result.discounts.map(item => [item.promotionId, item.discountSen, item.voucherApplied]), [
    ['student-promo', 300, false], ['voucher-promo', 125, true],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /STUDENT-2026|voucher-a/);

  const voucherLookup = fixture.calls.find(call => call.sql.includes('FROM myfin.promotion_vouchers v'));
  assert.equal(voucherLookup.params[2], voucherLookupDigest(PEPPER, 'STUDENT-2026'));
  assert.doesNotMatch(JSON.stringify(fixture.calls), /STUDENT-2026/);
  const rules = fixture.calls.find(call => call.sql.includes('FROM myfin.promotions p'));
  assert.match(rules.sql, /pv\.version=p\.version/);
  assert.match(rules.sql, /pv\.enabled AND pv\.valid_from<=/);
  const snapshot = fixture.calls.find(call => call.sql.startsWith('INSERT INTO myfin.pricing_snapshots'));
  assert.equal(snapshot.params[3], 'customer-a');
  assert.equal(snapshot.params[4], 4);
  assert.equal(snapshot.params[7], 425);
  assert.equal(fixture.calls.filter(call => call.sql.startsWith('INSERT INTO myfin.pricing_snapshot_lines')).length, 1);
  assert.equal(fixture.calls.filter(call => call.sql.startsWith('INSERT INTO myfin.pricing_snapshot_discounts')).length, 2);
  assert.equal(fixture.calls.filter(call => call.sql.startsWith('INSERT INTO myfin.pricing_snapshot_discount_lines')).length, 2);
});

test('quote accepts identifiers and quantities only and validates customer_account identity directly', async () => {
  const fixture = pricingFixture();
  await assert.rejects(createPricingSnapshot(fixture.c, {
    companyId: 'company-a', customerId: 'customer-a',
    lines: [{ productId: 'latte', variantId: '', quantityMilli: 1000, unitPriceSen: 1 }],
  }), error => error.statusCode === 400 && error.message === 'invalid_pricing_line');
  assert.equal(fixture.calls.length, 0);

  const missing = pricingFixture({ query: async (sql) => {
    if (sql.includes('FROM myfin.companies')) return { rowCount: 1, rows: [{
      workspace_id: 'workspace-a', data: { preferences: { currency: 'RM' } },
    }] };
    if (sql.includes('FROM myfin.customer_accounts')) return { rowCount: 0, rows: [] };
    throw new Error('query should stop after customer_account validation');
  } });
  await assert.rejects(createPricingSnapshot(missing.c, {
    companyId: 'company-a', customerId: 'staff-client-row',
    lines: [{ productId: 'latte', variantId: '', quantityMilli: 1000 }],
  }), error => error.statusCode === 409 && error.message === 'customer_unavailable');
});

test('voucher lookup fails closed without leaking or silently ignoring a submitted code', async () => {
  const noSecret = pricingFixture();
  await assert.rejects(createPricingSnapshot(noSecret.c, {
    companyId: 'company-a', lines: [{ productId: 'latte', variantId: '', quantityMilli: 1000 }],
    voucherCode: 'NOT-A-CODE',
  }, { now: AT }), error => error.statusCode === 503 && error.message === 'voucher_secret_unavailable');
  assert.doesNotMatch(JSON.stringify(noSecret.calls), /NOT-A-CODE/);

  const calls = [];
  const unavailable = pricingFixture({ query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM myfin.companies')) return { rowCount: 1, rows: [{
      workspace_id: 'workspace-a', data: { preferences: { currency: 'MYR' } },
    }] };
    if (sql.includes('FROM myfin.promotion_vouchers v')) return { rowCount: 0, rows: [] };
    throw new Error('query should stop after voucher lookup');
  } });
  await assert.rejects(createPricingSnapshot(unavailable.c, {
    companyId: 'company-a', lines: [{ productId: 'latte', variantId: '', quantityMilli: 1000 }],
    voucherCode: 'VALID-LOOKING',
  }, { voucherPepper: PEPPER, now: AT }),
  error => error.statusCode === 400 && error.message === 'voucher_invalid_or_unavailable');
  assert.doesNotMatch(JSON.stringify(calls), /VALID-LOOKING/);
});

function commitFixture({ existing = [], bound = true, sourceType = 'customer_order' } = {}) {
  const calls = [];
  const snapshot = { id: 'snapshot-a', customer_id: 'customer-a', request_digest: 'a'.repeat(64),
    expires_at: '2026-10-09T05:00:00Z' };
  const discounts = [{ promotion_id: 'promotion-a', promotion_version: '2', voucher_id: null,
    voucher_version: null, discount_sen: '150' }];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [{}] };
    if (sql.includes('FROM myfin.pricing_snapshots')) return { rowCount: 1, rows: [snapshot] };
    if (sql.includes('FROM myfin.pricing_snapshot_discounts')) return { rowCount: 1, rows: discounts };
    if (sql.includes('FROM myfin.customer_order_requests')) return { rowCount: bound ? 1 : 0,
      rows: bound ? [{ pricing_snapshot_id: 'snapshot-a', customer_id: 'customer-a' }] : [] };
    if (sql.includes('FROM myfin.transactions')) return { rowCount: bound ? 1 : 0,
      rows: bound ? [{ pricing_snapshot_id: 'snapshot-a', source: sourceType === 'pos_sale' ? 'pos' : 'manual',
        data: { type: 'Invoice' } }] : [] };
    if (sql.includes('FROM myfin.promotion_redemptions')) return { rowCount: existing.length, rows: existing };
    if (sql.startsWith('INSERT INTO myfin.promotion_redemptions')) return { rowCount: 1, rows: [{ id: params[2] }] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  return { c: { query }, calls };
}

test('redemption commit requires a snapshot-bound source and writes stable source-keyed usage', async () => {
  const fixture = commitFixture();
  const result = await commitPricingRedemptions(fixture.c, {
    workspaceId: 'workspace-a', companyId: 'company-a', snapshotId: 'snapshot-a',
    sourceType: 'customer_order', sourceId: 'order-a',
  }, { now: AT, idFactory: () => 'redemption-a' });
  assert.deepEqual(result, [{ id: 'redemption-a', promotionId: 'promotion-a', discountSen: 150 }]);
  const insert = fixture.calls.find(call => call.sql.startsWith('INSERT INTO myfin.promotion_redemptions'));
  assert.equal(insert.params[7], 'snapshot-a');
  assert.equal(insert.params[9], 'customer_order');
  assert.equal(insert.params[10], 'order-a');
  assert.match(insert.params[11], /^[0-9a-f]{64}$/);
  assert.match(insert.params[12], /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(fixture.calls), /voucher.?code|student.?document/i);

  const unbound = commitFixture({ bound: false });
  await assert.rejects(commitPricingRedemptions(unbound.c, {
    workspaceId: 'workspace-a', companyId: 'company-a', snapshotId: 'snapshot-a',
    sourceType: 'customer_order', sourceId: 'order-a',
  }, { now: AT }), error => error.statusCode === 409 && error.message === 'pricing_source_not_bound');
});

test('redemption commit is idempotent for the same source and rejects changed evidence', async () => {
  const exact = {
    id: 'prior-a', pricing_snapshot_id: 'snapshot-a', promotion_id: 'promotion-a', promotion_version: '2',
    voucher_id: null, voucher_version: null, discount_sen: '150', customer_id: 'customer-a',
  };
  const fixture = commitFixture({ existing: [exact] });
  assert.deepEqual(await commitPricingRedemptions(fixture.c, {
    workspaceId: 'workspace-a', companyId: 'company-a', snapshotId: 'snapshot-a',
    sourceType: 'customer_order', sourceId: 'order-a',
  }, { now: AT }), [{ id: 'prior-a', promotionId: 'promotion-a', discountSen: 150 }]);
  assert.equal(fixture.calls.some(call => call.sql.startsWith('INSERT INTO myfin.promotion_redemptions')), false);

  const changed = commitFixture({ existing: [{ ...exact, discount_sen: '149' }] });
  await assert.rejects(commitPricingRedemptions(changed.c, {
    workspaceId: 'workspace-a', companyId: 'company-a', snapshotId: 'snapshot-a',
    sourceType: 'customer_order', sourceId: 'order-a',
  }, { now: AT }), error => error.statusCode === 409 && error.message === 'promotion_redemption_source_changed');
});

test('POS and invoice sources are type checked instead of treating staff clients as customer accounts', async () => {
  for (const sourceType of ['pos_sale', 'invoice']) {
    const fixture = commitFixture({ sourceType });
    const result = await commitPricingRedemptions(fixture.c, {
      workspaceId: 'workspace-a', companyId: 'company-a', snapshotId: 'snapshot-a',
      sourceType, sourceId: `${sourceType}-a`,
    }, { now: AT, idFactory: () => `${sourceType}-redemption` });
    assert.equal(result.length, 1);
  }
});
