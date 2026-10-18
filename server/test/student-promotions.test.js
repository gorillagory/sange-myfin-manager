import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  normalizePromotion, normalizeStudentEligibilityChange, normalizeVoucherCode,
  priceWithPromotions, recordPromotionRedemption, studentEligibilityAt, voucherLookupDigest,
} from '../src/student-promotions.js';

const at = '2026-10-09T02:00:00.000Z';
const student = {
  status: 'verified', version: 3,
  validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-12-31T16:00:00.000Z',
};
const promotion = (patch = {}) => ({
  id: 'student-beverage', version: 1, name: 'Student beverage 10%', enabled: true,
  redemptionMode: 'automatic', validFrom: '2026-01-01T00:00:00.000Z', validUntil: null,
  discountType: 'percentage', discountBasisPoints: 1000, discountSen: null,
  maxDiscountSen: null, minSubtotalSen: 0, maxTotalRedemptions: null, perCustomerLimit: null,
  requiresCustomer: true, requiresStudent: true, priority: 20, stackable: true,
  productTargets: [], categoryTargets: [{ category: 'Beverage', subcategory: '' }],
  customerTargets: [], usage: { total: 0, customer: 0 }, voucher: null, ...patch,
});
const voucher = (patch = {}) => promotion({
  id: 'welcome-code', name: 'Welcome RM1.50', redemptionMode: 'voucher',
  discountType: 'fixed', discountBasisPoints: null, discountSen: 150,
  requiresCustomer: false, requiresStudent: false, priority: 10, productTargets: [], categoryTargets: [],
  voucher: { id: 'voucher-1', version: 2, enabled: true,
    validFrom: '2026-01-01T00:00:00.000Z', validUntil: null,
    maxRedemptions: 100, perCustomerLimit: 1, usage: { total: 9, customer: 0 } }, ...patch,
});

test('short reusable marketing codes are normalized and retain a peppered checkout lookup', () => {
  const pepper = 'server-only-pepper-material-32-bytes-minimum';
  assert.equal(normalizeVoucherCode('  save-2026  '), 'SAVE-2026');
  const first = voucherLookupDigest(pepper, 'save-2026');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, voucherLookupDigest(pepper, ' SAVE-2026 '));
  assert.notEqual(first, voucherLookupDigest(`${pepper}!`, 'SAVE-2026'));
  assert.throws(() => voucherLookupDigest('short', 'SAVE-2026'), /voucher_pepper_required/);
  assert.throws(() => normalizeVoucherCode('ＳＡＶＥ２０２６'), /invalid_voucher_code/);
  assert.equal(normalizeVoucherCode(' staff '), 'STAFF');
  assert.equal(normalizeVoucherCode('ABC'), 'ABC');
  assert.throws(() => normalizeVoucherCode('AB'), /invalid_voucher_code/);
});

test('student verification stores only constrained metadata and a digest, with explicit transitions', () => {
  const pending = normalizeStudentEligibilityChange({ workspaceId: 'workspace-a', customerId: 'customer-a',
    status: 'pending', institutionName: 'Example University', verificationMethod: '', referenceDigest: '',
    referenceHint: '***1234', validFrom: '', validUntil: '', reason: '', expectedVersion: 0 }, null, at);
  assert.equal(pending.version, 1);
  assert.equal(pending.validUntil, null);
  const verified = normalizeStudentEligibilityChange({ workspaceId: 'workspace-a', customerId: 'customer-a',
    status: 'verified', institutionName: 'Example University', verificationMethod: 'staff_attestation',
    referenceDigest: 'a'.repeat(64), referenceHint: '***1234', validFrom: at,
    validUntil: '2027-10-09T02:00:00.000Z', reason: 'Card checked in person', expectedVersion: 1 },
  { status: 'pending', version: 1 }, at);
  assert.equal(verified.version, 2);
  assert.equal(verified.referenceDigest, 'a'.repeat(64));
  assert.equal('document' in verified, false);
  assert.throws(() => normalizeStudentEligibilityChange({ ...pending, expectedVersion: 0, documentUrl: 'https://files/id.jpg' }),
    /invalid_student_eligibility/);
  const { version: ignoredVersion, ...verifiedRequest } = verified;
  assert.equal(ignoredVersion, 2);
  assert.throws(() => normalizeStudentEligibilityChange({ ...verifiedRequest, expectedVersion: 1, referenceDigest: 'raw-student-id' },
    { status: 'pending', version: 1 }, at), /verification_reference_digest_required/);
  assert.throws(() => normalizeStudentEligibilityChange({ ...verifiedRequest, expectedVersion: 1, referenceHint: 'STUDENT123' },
    { status: 'pending', version: 1 }, at), /invalid_student_reference_hint/);
  const { version: pendingVersion, ...pendingRequest } = pending;
  assert.equal(pendingVersion, 1);
  assert.throws(() => normalizeStudentEligibilityChange({ ...pendingRequest, expectedVersion: 2 },
    { status: 'verified', version: 2, validUntil: '2027-01-01T00:00:00.000Z' }, at),
  /invalid_student_eligibility_transition/);
});

test('student eligibility uses an inclusive start and exclusive expiry boundary', () => {
  assert.deepEqual(studentEligibilityAt(student, '2026-01-01T00:00:00.000Z'),
    { eligible: true, reason: 'verified', version: 3 });
  assert.deepEqual(studentEligibilityAt(student, student.validUntil), { eligible: false, reason: 'expired' });
  assert.deepEqual(studentEligibilityAt({ ...student, status: 'revoked' }, at),
    { eligible: false, reason: 'not_verified' });
});

test('integer-sen pricing combines targeted student and voucher discounts deterministically', () => {
  const result = priceWithPromotions({
    at, customerId: 'customer-a', studentEligibility: student, currencyCode: 'MYR', taxBasisPoints: 600,
    cashRounding: true,
    lines: [
      { lineNo: 1, productId: 'latte', variantId: '', category: 'Beverage', subcategory: 'Coffee',
        description: 'Latte', quantityMilli: 2000, unitPriceSen: 1000 },
      { lineNo: 2, productId: 'croissant', variantId: '', category: 'Pastry', subcategory: '',
        description: 'Croissant', quantityMilli: 1000, unitPriceSen: 500 },
    ],
    promotions: [voucher(), promotion()],
  });
  assert.deepEqual({ subtotal: result.subtotalSen, discount: result.discountSen,
    taxable: result.taxableSen, tax: result.taxSen, before: result.totalBeforeRoundingSen,
    rounding: result.roundingSen, total: result.totalSen },
  { subtotal: 2500, discount: 350, taxable: 2150, tax: 129, before: 2279, rounding: 1, total: 2280 });
  assert.deepEqual(result.applications.map(item => [item.promotionId, item.discountSen]),
    [['student-beverage', 200], ['welcome-code', 150]]);
  assert.equal(result.studentEligibilityVersion, 3);
  assert.match(result.rulesDigest, /^[0-9a-f]{64}$/);
  assert.equal('loyalty' in result, false);
});

test('fixed discounts allocate largest remainders by line order without losing a sen', () => {
  const result = priceWithPromotions({ at, cashRounding: false, lines: [1, 2, 3].map(lineNo => ({
    lineNo, productId: `p-${lineNo}`, variantId: '', category: '', subcategory: '', description: `P${lineNo}`,
    quantityMilli: 1000, unitPriceSen: 1,
  })), promotions: [voucher({ discountSen: 2, voucher: { ...voucher().voucher, perCustomerLimit: null } })] });
  assert.deepEqual(result.lines.map(line => line.discountSen), [1, 1, 0]);
  assert.equal(result.discountSen, 2);
  assert.equal(result.totalSen, 1);
});

test('fractional quantities round half-up once in integer sen and usage counters do not alter rule identity', () => {
  const input = { at, cashRounding: false, customerId: 'customer-a', studentEligibility: student,
    lines: [{ lineNo: 1, productId: 'sample', variantId: '', category: 'Beverage', subcategory: '',
      description: 'Half unit', quantityMilli: 500, unitPriceSen: 5 }],
    promotions: [promotion({ discountBasisPoints: 1 })] };
  const before = priceWithPromotions(input);
  const after = priceWithPromotions({ ...input, promotions: [promotion({
    discountBasisPoints: 1, usage: { total: 999, customer: 999 },
  })] });
  assert.equal(before.subtotalSen, 3);
  assert.equal(before.rulesDigest, after.rulesDigest);
});

test('target, identity, validity and usage boundaries prevent ineligible discounts', () => {
  const base = { at, cashRounding: false, customerId: 'customer-a', studentEligibility: student,
    lines: [{ lineNo: 1, productId: 'latte', variantId: '', category: 'Beverage', subcategory: 'Coffee',
      description: 'Latte', quantityMilli: 1000, unitPriceSen: 1000 }] };
  assert.equal(priceWithPromotions({ ...base, customerId: '', promotions: [promotion()] }).discountSen, 0);
  assert.equal(priceWithPromotions({ ...base, studentEligibility: { ...student, status: 'revoked' },
    promotions: [promotion()] }).discountSen, 0);
  assert.equal(priceWithPromotions({ ...base, promotions: [promotion({ categoryTargets: [{ category: 'Pastry', subcategory: '' }] })] }).discountSen, 0);
  assert.equal(priceWithPromotions({ ...base, promotions: [promotion({ maxTotalRedemptions: 10,
    usage: { total: 10, customer: 0 } })] }).discountSen, 0);
  assert.equal(priceWithPromotions({ ...base, promotions: [promotion({ perCustomerLimit: 1,
    usage: { total: 0, customer: 1 } })] }).discountSen, 0);
  assert.equal(priceWithPromotions({ ...base, at: '2027-01-01T00:00:00.000Z',
    promotions: [promotion({ validUntil: '2027-01-01T00:00:00.000Z' })] }).discountSen, 0);
});

test('non-stackable rules cannot be combined after a prior applied discount', () => {
  const result = priceWithPromotions({ at, cashRounding: false,
    lines: [{ lineNo: 1, productId: 'p', variantId: '', category: 'Menu', subcategory: '',
      description: 'Item', quantityMilli: 1000, unitPriceSen: 1000 }],
    promotions: [
      promotion({ id: 'first', name: 'First', priority: 20, requiresCustomer: false, requiresStudent: false,
        categoryTargets: [], discountBasisPoints: 1000 }),
      promotion({ id: 'second', name: 'Second', priority: 10, stackable: false,
        requiresCustomer: false, requiresStudent: false, categoryTargets: [], discountBasisPoints: 5000 }),
    ] });
  assert.deepEqual(result.applications.map(item => item.promotionId), ['first']);
  assert.equal(result.discountSen, 100);
});

test('promotion validation rejects ambiguous money, malformed targets and duplicate customers', () => {
  assert.throws(() => normalizePromotion(promotion({ discountSen: 1 })), /invalid_promotion_discount/);
  assert.throws(() => normalizePromotion(promotion({ discountBasisPoints: 10001 })), /invalid_promotion_discount/);
  assert.throws(() => normalizePromotion(promotion({ productTargets: 'latte' })), /invalid_promotion_target/);
  assert.throws(() => normalizePromotion(promotion({ customerTargets: ['customer-a', 'customer-a'] })),
    /duplicate_promotion_customer/);
  assert.throws(() => normalizePromotion(promotion({ productTargets: [
    { productId: 'latte', variantId: '' }, { productId: 'latte', variantId: '' },
  ] })), /duplicate_promotion_product/);
  assert.throws(() => priceWithPromotions({ at, cashRounding: false,
    lines: [{ productId: 'p', quantityMilli: 1000, unitPriceSen: 1, description: 'P' }],
    promotions: Array.from({ length: 101 }, (_, index) => promotion({ id: `p-${index}` })) }),
  /too_many_promotions/);
  assert.throws(() => priceWithPromotions({ at, cashRounding: false,
    lines: [{ productId: 'p', quantityMilli: 0, unitPriceSen: 1 }], promotions: [] }), /invalid_input/);
});

test('redemption writer sends only validated identifiers, digests and integer sen', async () => {
  const calls = [];
  const c = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [{ id: values[2] }] }; } };
  const row = await recordPromotionRedemption(c, { workspaceId: 'workspace-a', companyId: 'company-a',
    id: 'redemption-a', promotionId: 'promotion-a', promotionVersion: 2, voucherId: 'voucher-a',
    voucherVersion: 1, pricingSnapshotId: 'price-a', customerId: 'customer-a', sourceType: 'customer_order',
    sourceId: 'order-a', idempotencyKey: 'order-a:promotion-a', requestDigest: 'b'.repeat(64),
    discountSen: 150, occurredAt: at });
  assert.deepEqual(row, { id: 'redemption-a' });
  assert.match(calls[0].sql, /INSERT INTO myfin\.promotion_redemptions/);
  assert.equal(calls[0].values[13], 150);
  assert.doesNotMatch(JSON.stringify(calls), /SAVE-2026|student.?id/i);
});

test('migration preserves versioned evidence, immutable snapshots and atomic usage limits', async () => {
  const sql = await readFile(new URL('../../db/migrations/0022_student_promotions.sql', import.meta.url), 'utf8');
  for (const table of ['student_eligibilities', 'student_eligibility_events', 'promotions',
    'promotion_versions', 'promotion_vouchers', 'promotion_voucher_versions', 'pricing_snapshots',
    'pricing_snapshot_lines', 'pricing_snapshot_discounts', 'pricing_snapshot_discount_lines',
    'promotion_redemptions']) assert.match(sql, new RegExp(`CREATE TABLE myfin\\.${table}`));
  assert.match(sql, /status IN \('pending','verified','rejected','revoked'\)/);
  assert.match(sql, /Raw student IDs, document bytes, document URLs and provider secrets are forbidden/);
  assert.match(sql, /code_lookup_digest text NOT NULL CHECK\(code_lookup_digest ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /student_eligibilities_current_event_fk[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /SECURITY DEFINER SET search_path=pg_catalog,myfin/);
  assert.match(sql, /ON CONFLICT\(workspace_id,company_id,promotion_id\) DO UPDATE SET/);
  assert.match(sql, /promotion_customer_usage_counters/);
  assert.match(sql, /promotion_voucher_customer_usage_counters/);
  assert.match(sql, /pricing_snapshot_discount_changed/);
  assert.match(sql, /student_eligibility_expired/);
  assert.match(sql, /immutable_promotion_redemptions/);
  assert.match(sql, /no_truncate_pricing_snapshots/);
  assert.match(sql, /ALTER TABLE myfin\.customer_order_requests ADD COLUMN pricing_snapshot_id text/);
  assert.match(sql, /ALTER TABLE myfin\.transactions ADD COLUMN pricing_snapshot_id text/);
  assert.doesNotMatch(sql, /student_document|document_url|student_id_number|voucher_code text/i);
});

test('0047 keeps readable marketing codes additive, immutable and campaign-attributed', async () => {
  const sql = await readFile(new URL('../../db/migrations/0047_marketing_promo_codes.sql', import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN display_code text/);
  assert.match(sql, /promotion_vouchers_company_display_code_key/);
  assert.match(sql, /WHERE display_code IS NOT NULL/);
  assert.match(sql, /ADD COLUMN campaign_id text/);
  assert.match(sql, /REFERENCES myfin\.marketing_campaigns\(workspace_id,company_id,id\) ON DELETE RESTRICT/);
  assert.match(sql, /NEW\.display_code IS DISTINCT FROM OLD\.display_code/);
  assert.match(sql, /NULL identifies a legacy hash-only code/);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|TRUNCATE TABLE/i);
});
