import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commitPricingRedemptions,
  createPricingSnapshot,
  decimalToScaledInteger,
  extendOrderPromotionReservations,
  loadPricingSnapshot,
  posPricingRecoveryState,
  releaseOrderPromotionReservations,
  reserveOrderPromotions,
  consumeOrderPromotionReservations,
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
    if (sql.includes('FROM myfin.products p') && sql.includes('LEFT JOIN myfin.product_variants')) {
      const available = overrides.catalogRows || [overrides.catalogRow || {
        id: 'latte', data: { name: 'Latte', category: 'Beverage', subcategory: 'Coffee', variants: [] },
        product_price: '19.9999', product_online_price_sen: null, variant_id: null, variant_price: null,
        variant_online_price_sen: null,
      }];
      const rows = available.filter(row => params[1].includes(row.id));
      return { rowCount: rows.length, rows };
    }
    if (sql.includes('FROM myfin.student_eligibilities')) return { rowCount: 1, rows: [{
      status: 'verified', version: '4', valid_from: '2026-01-01T00:00:00Z', valid_until: '2027-01-01T00:00:00Z',
    }] };
    if (sql.includes('FROM myfin.promotions p')) return { rowCount: (overrides.promotionRows || []).length || 2, rows: overrides.promotionRows || [
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
  assert.equal(snapshot.params[16], 600);
  assert.match(voucherLookup.sql, /FROM myfin\.promotion_reservations/);
  assert.match(rules.sql, /FROM myfin\.promotion_reservations/);
  assert.equal(fixture.calls.filter(call => call.sql.startsWith('INSERT INTO myfin.pricing_snapshot_lines')).length, 1);
  assert.equal(fixture.calls.filter(call => call.sql.startsWith('INSERT INTO myfin.pricing_snapshot_discounts')).length, 2);
  assert.equal(fixture.calls.filter(call => call.sql.startsWith('INSERT INTO myfin.pricing_snapshot_discount_lines')).length, 2);
});

test('POS preview is channel-aware and read-only while the final quote persists one cashier-bound snapshot', async () => {
  const promotionRows = [{
    id: 'pos-promo', version: '2', name: 'Counter 10%', enabled: true, redemption_mode: 'automatic',
    valid_from: '2026-01-01T00:00:00Z', valid_until: null, discount_type: 'percentage',
    discount_basis_points: 1000, discount_sen: null, max_discount_sen: null, min_subtotal_sen: '0',
    max_total_redemptions: null, per_customer_limit: null, requires_customer: false,
    requires_student: false, priority: 20, stackable: true, total_usage: '0', customer_usage: '0',
    campaign_links: [{ campaignId:'campaign-pos', campaignVersion:1, currentVersion:1,
      lifecycle:'published', startsAt:'2026-01-01T00:00:00Z', endsAt:null,
      channels:['pos'], audiences:[] }],
  }];
  const fixture = pricingFixture({ promotionRows, catalogRow: {
    id:'latte', data:{ name:'Latte', category:'Beverage', subcategory:'Coffee', variants:[] },
    product_price:'20.00', product_online_price_sen:2500, variant_id:null, variant_price:null,
    variant_online_price_sen:null,
  } });
  const input = { companyId:'company-a', lines:[{ productId:'latte', variantId:'', quantityMilli:1000 }],
    channel:'pos', issuedToStaffId:'cashier-a', manualDiscountBasisPoints:500 };
  const preview = await createPricingSnapshot(fixture.c, input,
    { now:AT, cashRounding:true, persist:false, idFactory:()=>{ throw Error('preview must not allocate an id'); } });
  assert.equal(preview.id, '');
  assert.equal(preview.channel, 'pos');
  assert.equal(preview.subtotalSen, 2000, 'POS ignores the separate online price');
  assert.equal(preview.promotionDiscountSen, 200);
  assert.equal(preview.manualDiscountSen, 90);
  assert.equal(preview.discountSen, 290);
  assert.equal(preview.totalSen, 1815);
  assert.equal(fixture.calls.some(call => call.sql.startsWith('INSERT INTO myfin.')), false);

  const locked = await createPricingSnapshot(fixture.c, input,
    { now:AT, cashRounding:true, persist:true, idFactory:()=> 'pos-snapshot-a' });
  assert.equal(locked.id, 'pos-snapshot-a');
  const snapshots = fixture.calls.filter(call => call.sql.startsWith('INSERT INTO myfin.pricing_snapshots'));
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].params.slice(17, 21), ['pos','cashier-a',500,90]);
  assert.equal(snapshots[0].params[21], '2026-10-09T04:15:00.000Z');
});

test('POS automatically inserts an eligible free reward while storefront pricing remains explicitly basket-driven', async () => {
  const promotionRows = [{
    id:'free-cookie', version:'1', name:'Free cookie', enabled:true, redemption_mode:'automatic',
    valid_from:'2026-01-01T00:00:00Z', valid_until:null, discount_type:'free_item',
    discount_basis_points:null, discount_sen:null, max_discount_sen:null,
    reward_product_id:'cookie', reward_variant_id:null, reward_quantity_milli:'1000',
    min_subtotal_sen:'1000', max_total_redemptions:null, per_customer_limit:null,
    requires_customer:false, requires_student:false, priority:30, stackable:true,
    total_usage:'0', customer_usage:'0', campaign_links:[{
      campaignId:'campaign-free', campaignVersion:1, currentVersion:1, lifecycle:'published',
      startsAt:'2026-01-01T00:00:00Z', endsAt:null, channels:['pos','storefront'], audiences:[],
    }],
  }];
  const fixture = pricingFixture({ promotionRows, catalogRows:[
    { id:'latte', data:{ name:'Latte', category:'Beverage', subcategory:'Coffee', variants:[] },
      product_price:'20.00', product_online_price_sen:null, variant_id:null, variant_price:null,
      variant_online_price_sen:null },
    { id:'cookie', data:{ name:'Cookie', category:'Pastry', subcategory:'Cookies', variants:[] },
      product_price:'5.00', product_online_price_sen:null, variant_id:null, variant_price:null,
      variant_online_price_sen:null },
  ] });
  const base = { companyId:'company-a', lines:[{ productId:'latte', variantId:'', quantityMilli:1000 }] };
  const pos = await createPricingSnapshot(fixture.c, {
    ...base, channel:'pos', issuedToStaffId:'cashier-a',
  }, { now:AT, persist:false, cashRounding:true });
  assert.deepEqual(pos.lines.map(line => [line.productId,line.quantityMilli,line.automaticReward,line.grossSen,line.netSen]), [
    ['latte',1000,false,2000,2000],
    ['cookie',1000,true,500,0],
  ]);
  assert.equal(pos.subtotalSen,2500);
  assert.equal(pos.discountSen,500);
  assert.equal(pos.totalSen,2120);
  assert.deepEqual(pos.discounts.map(row => [row.promotionId,row.discountSen]), [['free-cookie',500]]);

  const partial = await createPricingSnapshot(fixture.c, {
    companyId:'company-a', channel:'pos', issuedToStaffId:'cashier-a', lines:[
      { productId:'latte', variantId:'', quantityMilli:1000 },
      { productId:'cookie', variantId:'', quantityMilli:500 },
    ],
  }, { now:AT, persist:false, cashRounding:true });
  assert.deepEqual(partial.lines.map(line => [
    line.productId,line.quantityMilli,line.automaticReward,line.grossSen,line.netSen,
  ]), [
    ['latte',1000,false,2000,2000],
    ['cookie',500,false,250,0],
    ['cookie',500,true,250,0],
  ], 'a partial reward already in the basket is discounted and only the missing quantity is inserted');
  assert.equal(partial.subtotalSen,2500);
  assert.equal(partial.discountSen,500);
  assert.equal(partial.totalSen,2120);

  const storefront = await createPricingSnapshot(fixture.c, base,
    { now:AT, persist:false, cashRounding:false });
  assert.equal(storefront.lines.length,1);
  assert.equal(storefront.lines[0].automaticReward,false);
  assert.equal(storefront.discountSen,0);
});

test('POS recovery state separates the collection window from durable exact replay', () => {
  const snapshot = {
    pricedAt:'2026-10-09T04:00:00.000Z',
    expiresAt:'2026-10-09T04:05:00.000Z',
    recoveryExpiresAt:'2026-10-09T04:15:00.000Z',
  };
  assert.deepEqual(posPricingRecoveryState(snapshot, {
    capturedAt:'2026-10-09T04:04:00.000Z', now:'2026-10-09T04:10:00.000Z',
  }), { capturedDuringTender:true, recoveryActive:true });
  assert.deepEqual(posPricingRecoveryState(snapshot, {
    capturedAt:'2026-10-09T03:59:00.000Z', now:'2026-10-09T04:15:00.000Z',
  }), { capturedDuringTender:false, recoveryActive:false });
});

test('POS discretionary discounts retain exact half-up cents above floating-point multiplication range', async () => {
  const unitPriceSen = 7_999_999_999_999_999n;
  const basisPoints = 3333n;
  const expectedDiscount = (unitPriceSen * basisPoints / 10_000n)
    + ((unitPriceSen * basisPoints % 10_000n) * 2n >= 10_000n ? 1n : 0n);
  const fixture = pricingFixture({ promotionRows: [], catalogRow: {
    id:'asset', data:{ name:'High-value asset', category:'Asset', subcategory:'', variants:[] },
    product_price:'79999999999999.99', product_online_price_sen:null, variant_id:null,
    variant_price:null, variant_online_price_sen:null,
  } });
  const quote = await createPricingSnapshot(fixture.c, {
    companyId:'company-a', lines:[{ productId:'asset', variantId:'', quantityMilli:1000 }],
    channel:'pos', issuedToStaffId:'owner-a', manualDiscountBasisPoints:Number(basisPoints),
  }, { now:AT, cashRounding:true, persist:false });
  assert.equal(BigInt(quote.manualDiscountSen), expectedDiscount);
  assert.equal(BigInt(quote.lines[0].discountSen), expectedDiscount);
  assert.equal(BigInt(quote.lines[0].netSen), unitPriceSen - expectedDiscount);
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

  const ineligible = pricingFixture({ promotionRows: [{
    id: 'voucher-promo', version: '5', name: 'Voucher RM1.25', enabled: true,
    redemption_mode: 'voucher', valid_from: '2026-01-01T00:00:00Z', valid_until: null,
    discount_type: 'fixed', discount_basis_points: null, discount_sen: '125',
    max_discount_sen: null, min_subtotal_sen: '999999', max_total_redemptions: null,
    per_customer_limit: null, requires_customer: false, requires_student: false,
    priority: 10, stackable: true, total_usage: '0', customer_usage: '0',
  }] });
  await assert.rejects(createPricingSnapshot(ineligible.c, {
    companyId: 'company-a', customerId: 'customer-a',
    lines: [{ productId: 'latte', variantId: '', quantityMilli: 1000 }],
    voucherCode: 'VALID-NOT-ELIGIBLE',
  }, { voucherPepper: PEPPER, now: AT }),
  error => error.statusCode === 400 && error.message === 'voucher_invalid_or_unavailable');
  assert.equal(ineligible.calls.some(call => call.sql.startsWith('INSERT INTO myfin.pricing_snapshots')), false);
  assert.doesNotMatch(JSON.stringify(ineligible.calls), /VALID-NOT-ELIGIBLE/);
});

test('stored snapshots reload safely and lifecycle helpers expose only bounded identifiers', async () => {
  const calls = [];
  const snapshot = { id:'snapshot-a', customer_id:'customer-a', request_digest:'a'.repeat(64),
    rules_digest:'b'.repeat(64), priced_at:AT, expires_at:'2026-10-09T04:05:00Z', currency_code:'MYR',
    student_eligibility_version:'4', subtotal_sen:'2000', discount_sen:'125', taxable_sen:'1875',
    tax_sen:'113', tax_basis_points:'600', rounding_sen:'0', total_sen:'1988' };
  const c = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM myfin.pricing_snapshots')) return { rowCount:1, rows:[snapshot] };
    if (sql.includes('FROM myfin.pricing_snapshot_discounts')) return { rowCount:1, rows:[{
      sequence:1, promotion_id:'promotion-a', promotion_version:'2', voucher_id:'voucher-internal',
      voucher_version:'3', display_name:'Welcome RM1.25', discount_sen:'125' }] };
    if (sql.includes('FROM myfin.pricing_snapshot_lines')) return { rowCount:1, rows:[{
      line_no:1, product_id:'latte', variant_id:null, category:'Beverage', subcategory:'Coffee',
      description:'Latte', quantity_milli:'1000', unit_price_sen:'2000', gross_sen:'2000',
      discount_sen:'125', net_sen:'1875' }] };
    if (sql.includes('FROM myfin.pricing_snapshot_discount_lines')) return { rowCount:1, rows:[{
      discount_sequence:1, line_no:1, discount_sen:'125' }] };
    if (sql.includes('myfin.reserve_order_promotions')) return { rows:[{ count:'1' }] };
    if (sql.includes('myfin.extend_order_promotion_reservations')) return { rows:[{ count:'1' }] };
    if (sql.includes('myfin.release_order_promotion_reservations')) return { rows:[{ count:'1' }] };
    if (sql.includes('myfin.consume_order_promotion_reservations')) return { rows:[{ count:'1' }] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const loaded = await loadPricingSnapshot(c, { workspaceId:'workspace-a', companyId:'company-a',
    snapshotId:'snapshot-a', customerId:'customer-a', requestDigest:'a'.repeat(64) },
  { now:'2026-10-09T04:04:59Z' });
  assert.equal(loaded.taxBasisPoints, 600);
  assert.deepEqual(loaded.discounts, [{ promotionId:'promotion-a', promotionVersion:2,
    name:'Welcome RM1.25', voucherApplied:true, discountSen:125,
    lineDiscounts:[{ lineNo:1, discountSen:125 }] }]);
  assert.doesNotMatch(JSON.stringify(loaded), /voucher-internal/);
  await assert.rejects(loadPricingSnapshot(c, { workspaceId:'workspace-a', companyId:'company-a',
    snapshotId:'snapshot-a', customerId:'different' }, { now:AT }),
  error => error.statusCode === 409 && error.message === 'pricing_customer_changed');
  assert.equal(await reserveOrderPromotions(c, { companyId:'company-a', orderId:'order-a',
    snapshotId:'snapshot-a', expiresAt:'2026-10-09T05:00:00Z' }), 1);
  assert.equal(await extendOrderPromotionReservations(c, { companyId:'company-a', orderId:'order-a',
    expiresAt:'2026-10-09T06:00:00Z' }), 1);
  assert.equal(await releaseOrderPromotionReservations(c, { companyId:'company-a', orderId:'order-a',
    reason:'cancelled' }), 1);
  await assert.rejects(releaseOrderPromotionReservations(c, { companyId:'company-a', orderId:'order-a',
    reason:'rollback' }), error => error.statusCode === 400 && error.message === 'invalid_reservation_release_reason');
  assert.equal(await consumeOrderPromotionReservations(c, { companyId:'company-a', orderId:'order-a',
    saleId:'sale-a', occurredAt:'2026-10-09T04:30:00Z' }), 1);
  assert.deepEqual(calls.filter(call => call.sql.includes('myfin.') && call.sql.includes('_order_promotion')).map(call => call.params), [
    ['company-a','order-a','snapshot-a','2026-10-09T05:00:00.000Z'],
    ['company-a','order-a','2026-10-09T06:00:00.000Z'],
    ['company-a','order-a','cancelled'],
    ['company-a','order-a','sale-a','2026-10-09T04:30:00.000Z'],
  ]);
});

function commitFixture({ existing = [], bound = true, sourceType = 'customer_order',
  snapshot: snapshotOverride = {}, recoveryException = false } = {}) {
  const calls = [];
  const snapshot = { id: 'snapshot-a', customer_id: 'customer-a', request_digest: 'a'.repeat(64),
    expires_at:sourceType === 'pos_sale' ? '2026-10-09T04:05:00Z' : '2026-10-09T05:00:00Z',
    channel:sourceType === 'pos_sale' ? 'pos' : 'storefront',
    recovery_expires_at:sourceType === 'pos_sale' ? '2026-10-09T04:15:00Z' : null,
    ...snapshotOverride };
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
    if (sql.includes('myfin.pos_pricing_recovery_authorized')) return {
      rowCount:1, rows:[{ allowed:recoveryException }],
    };
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

test('POS redemption replay uses its durable hold, then requires an immutable manager exception', async () => {
  const recovering = commitFixture({ sourceType:'pos_sale' });
  assert.equal((await commitPricingRedemptions(recovering.c, {
    workspaceId:'workspace-a', companyId:'company-a', snapshotId:'snapshot-a',
    sourceType:'pos_sale', sourceId:'sale-a',
  }, { now:'2026-10-09T04:10:00Z', idFactory:()=> 'redemption-recovered' }))[0].id,
  'redemption-recovered');
  assert.equal(recovering.calls.some(call => call.sql.includes('pos_pricing_recovery_authorized')), false,
    'the bounded durable reservation is enough before its recovery deadline');

  const approved = commitFixture({ sourceType:'pos_sale', recoveryException:true });
  assert.equal((await commitPricingRedemptions(approved.c, {
    workspaceId:'workspace-a', companyId:'company-a', snapshotId:'snapshot-a',
    sourceType:'pos_sale', sourceId:'sale-a',
  }, { now:'2026-10-09T04:20:00Z', idFactory:()=> 'redemption-approved' }))[0].id,
  'redemption-approved');
  assert.equal(approved.calls.some(call => call.sql.includes('pos_pricing_recovery_authorized')), true);

  const expired = commitFixture({ sourceType:'pos_sale' });
  await assert.rejects(commitPricingRedemptions(expired.c, {
    workspaceId:'workspace-a', companyId:'company-a', snapshotId:'snapshot-a',
    sourceType:'pos_sale', sourceId:'sale-a',
  }, { now:'2026-10-09T04:20:00Z' }),
  error => error.statusCode === 409 && error.message === 'pricing_snapshot_expired');
});

test('an exact prior redemption remains idempotent after every quote deadline', async () => {
  const exact = {
    id:'prior-pos', pricing_snapshot_id:'snapshot-a', promotion_id:'promotion-a', promotion_version:'2',
    voucher_id:null, voucher_version:null, discount_sen:'150', customer_id:'customer-a',
  };
  const fixture = commitFixture({ sourceType:'pos_sale', existing:[exact] });
  assert.deepEqual(await commitPricingRedemptions(fixture.c, {
    workspaceId:'workspace-a', companyId:'company-a', snapshotId:'snapshot-a',
    sourceType:'pos_sale', sourceId:'sale-a',
  }, { now:'2026-11-01T00:00:00Z' }), [{ id:'prior-pos', promotionId:'promotion-a', discountSen:150 }]);
  assert.equal(fixture.calls.some(call => call.sql.includes('pos_pricing_recovery_authorized')), false);
});
