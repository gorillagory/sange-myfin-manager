import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { registerPosPricing } from '../src/pos-pricing.js';
import { checkout } from '../src/business.js';
import { cartItem, createSale } from '../../src/domain/pos.js';

function fixture(role = 'manager', options = {}) {
  const routes = new Map(), calls = [];
  const c = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM myfin.companies')) return { rowCount:1, rows:[{
      workspace_id:'workspace-a', data:{ preferences:{ currency:'RM', taxRate:6, staffDiscountLimit:5 } },
    }] };
    if (sql.includes('FROM myfin.products p')) {
      const available = options.catalogRows || [{
        id:'latte', data:{ name:'Latte', category:'Beverage', subcategory:'Coffee', variants:[] },
        product_price:'10.00', product_online_price_sen:1200,
        variant_id:null, variant_price:null, variant_online_price_sen:null,
      }];
      const rows = available.filter(row => params[1].includes(row.id));
      return { rowCount:rows.length, rows };
    }
    if (sql.startsWith('SELECT id,data FROM myfin.products')) {
      const available = options.productRows || [{
        id:'latte', data:{ id:'latte', name:'Latte', trackStock:false, variants:[] },
      }];
      const rows = available.filter(row => params[1].includes(row.id));
      return { rowCount:rows.length, rows };
    }
    if (sql.includes('FROM myfin.customer_order_reservations')) return {
      rowCount:(options.catalogReservations || []).length, rows:options.catalogReservations || [],
    };
    if (sql.includes('FROM myfin.inventory_recipes r')) return {
      rowCount:(options.recipeRows || []).length, rows:options.recipeRows || [],
    };
    if (sql.includes('FROM myfin.stock_items')) return {
      rowCount:(options.stockRows || []).length, rows:options.stockRows || [],
    };
    if (sql.includes('FROM myfin.customer_order_recipe_reservations')) return {
      rowCount:(options.recipeReservations || []).length, rows:options.recipeReservations || [],
    };
    if (sql.includes('FROM myfin.promotions promotion')) return {
      rowCount:(options.posPromotionRows || []).length, rows:options.posPromotionRows || [],
    };
    if (sql.includes('FROM myfin.promotions p')) return {
      rowCount:(options.promotionRows || []).length, rows:options.promotionRows || [],
    };
    if (sql.includes('FROM myfin.promotion_version_products') ||
        sql.includes('FROM myfin.promotion_version_categories') ||
        sql.includes('FROM myfin.promotion_version_customers')) return { rowCount:0, rows:[] };
    if (sql.startsWith('SELECT myfin.reserve_pos_promotions')) return { rowCount:1, rows:[{ count:'0' }] };
    if (sql.startsWith('SELECT myfin.release_pos_promotions')) return { rowCount:1, rows:[{ count:'1' }] };
    if (sql.startsWith('INSERT INTO myfin.')) return { rowCount:1, rows:[] };
    throw Error(`unexpected query: ${sql}`);
  } };
  const app = {
    get(path, handler) { routes.set(path, handler); },
    post(path, handler) { routes.set(path, handler); },
  };
  const scoped = (req, fn) => fn(c, 'company-a');
  registerPosPricing(app, { scoped, voucherPepper:'pos-pricing-test-pepper-at-least-32-bytes' });
  return { handler:routes.get('/api/companies/:company/pos/quote'),
    promotionsHandler:routes.get('/api/companies/:company/pos/promotions'),
    releaseHandler:routes.get('/api/companies/:company/pos/quote/release'), calls,
    req:body=>({ body, identity:{ id:'cashier-a', username:'Cashier', role } }) };
}

test('checkout-safe promotion catalog exposes automatic offers and reusable codes with storefront links', async () => {
  const state = fixture('operator', { posPromotionRows:[{
    promotion_id:'promotion-a', promotion_version:'3', voucher_id:'voucher-a',
    name:'Student 10%', campaign_id:'campaign-a', campaign_version:'2', campaign_name:'Student week',
    campaign_channels:['pos','storefront'], redemption_mode:'voucher', display_code:'STUDENT',
    code_hint:'***DENT', storefront_hostname:'order-example.test',
    valid_from:'2026-10-01T00:00:00Z', valid_until:null,
    code_valid_from:'2026-10-01T00:00:00Z', code_valid_until:'2026-11-01T00:00:00Z',
    discount_type:'percentage', discount_basis_points:'1000', discount_sen:null,
    reward_product_id:null, reward_product_name:null,
  }, {
    promotion_id:'promotion-b', promotion_version:'1', voucher_id:null,
    name:'Happy hour', campaign_id:'campaign-b', campaign_version:'1', campaign_name:'Counter hour',
    campaign_channels:['pos'], redemption_mode:'automatic', display_code:null, code_hint:null,
    storefront_hostname:'order-example.test', valid_from:'2026-10-01T00:00:00Z', valid_until:null,
    code_valid_from:null, code_valid_until:null, discount_type:'fixed', discount_basis_points:null,
    discount_sen:'200', reward_product_id:null, reward_product_name:null,
  }] });
  const result = await state.promotionsHandler(state.req({}));
  assert.equal(result.promotions.length, 2);
  assert.deepEqual(result.promotions[0], {
    promotionId:'promotion-a', promotionVersion:3, voucherId:'voucher-a', name:'Student 10%',
    campaignId:'campaign-a', campaignName:'Student week', campaignVersion:2,
    channels:['pos','storefront'], redemptionMode:'voucher', displayCode:'STUDENT', code:'STUDENT',
    codeHint:'***DENT', legacyMasked:false,
    shareUrl:'https://order-example.test/shop?promo=STUDENT&campaign=campaign-a', enabled:true,
    validFrom:'2026-10-01T00:00:00Z', validUntil:'2026-11-01T00:00:00Z',
    discountType:'percentage', discountBasisPoints:1000, discountSen:null,
    rewardProductId:'', rewardProductName:'',
  });
  assert.equal(result.promotions[1].redemptionMode, 'automatic');
  assert.equal(result.promotions[1].displayCode, '');
  const catalog = state.calls.find(call => call.sql.includes('FROM myfin.promotions promotion'));
  assert.deepEqual(catalog.params, ['company-a']);
  assert.match(catalog.sql, /campaign_head\.lifecycle='published'/);
  assert.match(catalog.sql, /'pos'=ANY\(campaign_version\.channels\)/);
  assert.match(catalog.sql, /voucher_version\.campaign_id IS NULL OR campaign_head\.id=voucher_version\.campaign_id/);
  assert.match(catalog.sql, /version\.discount_type<>'free_item'/);
  assert.match(catalog.sql, /coalesce\(reward\.data->>'active','true'\)<>'false'/);
  assert.match(catalog.sql, /FROM myfin\.product_variants reward_variant/);
});

test('authenticated POS quote previews without writes and locks exactly one cashier-bound snapshot on demand', async () => {
  const state = fixture();
  const body = { lines:[{ productId:'latte', variantId:'', quantityMilli:1000 }],
    clientId:'', voucherCode:'', manualDiscountBasisPoints:250, checkoutId:'sale-a' };
  const preview = await state.handler(state.req(body));
  assert.equal(preview.pricingSnapshotId, '');
  assert.equal(preview.totals.subtotal, 10);
  assert.equal(preview.totals.manualDiscountAmount, .25);
  assert.equal(state.calls.some(call => call.sql.startsWith('INSERT INTO myfin.')), false);
  assert.equal(state.calls.some(call => call.sql.startsWith('SELECT myfin.reserve_pos_promotions')), false);
  assert.equal(state.calls.some(call => call.sql.startsWith('SELECT id,data FROM myfin.products')), false);

  const locked = await state.handler(state.req({ ...body, lock:true }));
  assert.match(locked.pricingSnapshotId, /^[0-9a-f-]{36}$/);
  assert.equal(Number.isFinite(new Date(locked.serverNow).getTime()), true);
  assert.equal(state.calls.filter(call => call.sql.startsWith('INSERT INTO myfin.pricing_snapshots')).length, 1);
  const insert = state.calls.find(call => call.sql.startsWith('INSERT INTO myfin.pricing_snapshots'));
  assert.deepEqual(insert.params.slice(17, 19), ['pos','cashier-a']);
  const reservation = state.calls.find(call => call.sql.startsWith('SELECT myfin.reserve_pos_promotions'));
  assert.deepEqual(reservation.params.slice(0, 3), ['company-a','sale-a',locked.pricingSnapshotId]);
  assert.equal(reservation.params[3], insert.params[21], 'capacity is held through the durable replay window');
  assert.equal(new Date(reservation.params[3]).getTime()-new Date(locked.expiresAt).getTime(),10*60*1000,
    'an abandoned till holds scarce capacity only ten minutes beyond the tender window');
  assert.equal(state.calls.filter(call => call.sql.startsWith('SELECT id,data FROM myfin.products')).length,1);
  assert.equal(state.calls.filter(call => call.sql.includes('FROM myfin.inventory_recipes r')).length,1);
  assert.deepEqual(await state.releaseHandler(state.req({
    checkoutId:'sale-a', pricingSnapshotId:locked.pricingSnapshotId,
  })), { released:1 });
  assert.deepEqual(state.calls.find(call => call.sql.startsWith('SELECT myfin.release_pos_promotions')).params,
    ['company-a','sale-a',locked.pricingSnapshotId,'cashier-a']);
});

test('operator discretionary discounts are rejected above the company policy before pricing', async () => {
  const state = fixture('operator');
  await assert.rejects(state.handler(state.req({
    lines:[{ productId:'latte', variantId:'', quantityMilli:1000 }],
    clientId:'', voucherCode:'', manualDiscountBasisPoints:501, checkoutId:'sale-a', lock:false,
  })), error => error.statusCode === 403 && error.message === 'manual_discount_limit_exceeded');
  assert.equal(state.calls.filter(call => call.sql.includes('FROM myfin.products p')).length, 0);
});

const freeRewardPromotion = {
  id:'free-cookie', version:'1', name:'Free cookie', enabled:true, redemption_mode:'automatic',
  valid_from:'2026-01-01T00:00:00Z', valid_until:null, discount_type:'free_item',
  discount_basis_points:null, discount_sen:null, max_discount_sen:null,
  reward_product_id:'cookie', reward_variant_id:null, reward_quantity_milli:'1000',
  min_subtotal_sen:'500', max_total_redemptions:null, per_customer_limit:null,
  requires_customer:false, requires_student:false, priority:20, stackable:true,
  total_usage:'0', customer_usage:'0', campaign_links:[{
    campaignId:'campaign-free', campaignVersion:1, currentVersion:1, lifecycle:'published',
    startsAt:'2026-01-01T00:00:00Z', endsAt:null, channels:['pos'], audiences:[],
  }],
};
const rewardCatalogRows = [
  { id:'latte', data:{ name:'Latte', category:'Beverage', subcategory:'Coffee', variants:[] },
    product_price:'10.00', product_online_price_sen:null, variant_id:null, variant_price:null,
    variant_online_price_sen:null },
  { id:'cookie', data:{ name:'Cookie', category:'Pastry', subcategory:'Cookies', variants:[] },
    product_price:'5.00', product_online_price_sen:null, variant_id:null, variant_price:null,
    variant_online_price_sen:null },
];

test('a locked automatic reward fails before tender when its catalog stock is unavailable', async () => {
  const state = fixture('manager', {
    promotionRows:[freeRewardPromotion], catalogRows:rewardCatalogRows,
    productRows:[
      { id:'latte', data:{ id:'latte', name:'Latte', trackStock:false, variants:[] } },
      { id:'cookie', data:{ id:'cookie', name:'Cookie', trackStock:true, stock:0, variants:[] } },
    ],
  });
  await assert.rejects(state.handler(state.req({
    lines:[{ productId:'latte', variantId:'', quantityMilli:1000 }], clientId:'', voucherCode:'',
    manualDiscountBasisPoints:0, checkoutId:'sale-reward-stock', lock:true,
  })), error => error.statusCode === 409 && error.message === 'stock_reserved_or_unavailable');
  assert.equal(state.calls.some(call => call.sql.startsWith('SELECT myfin.reserve_pos_promotions')), false,
    'promotion capacity is not held for an untenderable reward');
});

test('a locked automatic reward fails before tender when its recipe ingredient is unavailable', async () => {
  const state = fixture('manager', {
    promotionRows:[freeRewardPromotion], catalogRows:rewardCatalogRows,
    productRows:[
      { id:'latte', data:{ id:'latte', name:'Latte', trackStock:false, variants:[] } },
      { id:'cookie', data:{ id:'cookie', name:'Cookie', trackStock:false, variants:[] } },
    ],
    recipeRows:[{
      id:'recipe-cookie', product_id:'cookie', variant_id:'', version:'1', enabled:true,
      catalog_stock_disabled:true, created_at:'2026-10-01T00:00:00Z',
      stock_item_id:'dough', quantity_per_unit:'0.100000',
    }],
    stockRows:[{ id:'dough', active:true, tracking_mode:'volume', on_hand:'0.000000' }],
  });
  await assert.rejects(state.handler(state.req({
    lines:[{ productId:'latte', variantId:'', quantityMilli:1000 }], clientId:'', voucherCode:'',
    manualDiscountBasisPoints:0, checkoutId:'sale-reward-recipe', lock:true,
  })), error => error.statusCode === 409 && error.message === 'recipe_stock_unavailable');
  assert.equal(state.calls.some(call => call.sql.startsWith('SELECT myfin.reserve_pos_promotions')), false);
});

test('checkout binds POS snapshots once and commits redemptions after the sale insert in the same transaction', async () => {
  const [business, migration] = await Promise.all([
    readFile(new URL('../src/business.js', import.meta.url), 'utf8'),
    readFile(new URL('../../db/migrations/0037_pos_pricing.sql', import.meta.url), 'utf8'),
  ]);
  const start = business.indexOf('export async function checkout');
  const checkout = business.slice(start, business.indexOf('export function registerBusiness', start));
  assert.match(checkout, /acceptedOrderQuote && !options\.reservationOrderId/);
  assert.match(business, /snapshot\.channel !== 'pos' \|\| snapshot\.issuedToStaffId !== who\.id/);
  assert.match(business, /pricing_snapshot_already_used/);
  assert.match(checkout, /unlockedPricePolicy=!lockedPricing&&\(priceChanged\|\|taxChanged\)/);
  assert.ok(checkout.indexOf('INSERT INTO myfin.transactions') < checkout.indexOf('commitPricingRedemptions'));
  assert.ok(checkout.indexOf('commitPricingRedemptions') < checkout.indexOf('awardLoyaltyPointsForSale'));
  assert.match(checkout, /sourceType: 'pos_sale'/);
  assert.match(checkout, /SELECT customer_id FROM myfin\.customer_company_links/);
  assert.match(checkout, /channel: 'pos'/);
  assert.match(checkout, /const effectiveSaleIso=sale\.date/);
  assert.match(checkout, /commitPricingRedemptions[\s\S]*\{ now: effectiveSaleIso \}/);
  assert.match(checkout, /awardLoyaltyPointsForSale[\s\S]*occurredAt: effectiveSaleIso/);
  assert.match(migration, /GENERATED ALWAYS AS \(discount_sen-manual_discount_sen\) STORED/);
  assert.match(migration, /application_discount<>NEW\.promotion_discount_sen/);
  assert.match(migration, /\(channel='pos'\)=\(issued_to_staff_id IS NOT NULL\)/);
  assert.match(migration, /channel='pos' OR \(manual_discount_basis_points=0 AND manual_discount_sen=0\)/);
  assert.match(migration, /ALTER COLUMN source_order_id DROP NOT NULL/);
  assert.match(migration, /source_type IN \('customer_order','pos_sale'\)/);
});

test('offline snapshot recovery keeps server cart and principal binding without blocking paid replay', async () => {
  const business = await readFile(new URL('../src/business.js', import.meta.url), 'utf8');
  const pricingStart = business.indexOf('async function posSalePricing');
  const checkoutStart = business.indexOf('export async function checkout');
  const pricing = business.slice(pricingStart, checkoutStart);
  const checkout = business.slice(checkoutStart, business.indexOf('export function registerBusiness', checkoutStart));
  assert.match(pricing, /snapshot\.channel !== 'pos' \|\| snapshot\.issuedToStaffId !== who\.id/);
  assert.match(pricing, /snapshot\.lines\.length !== sale\.items\.length/);
  assert.match(pricing, /item\.productId !== line\.productId/);
  assert.match(pricing, /pricing_customer_changed/);
  assert.match(pricing, /capturedDuringTender \|\| !recovery\.recoveryActive/);
  assert.match(pricing, /const exactReplay = prior\.some\(row => row\.id === sale\.id\)/);
  assert.match(pricing, /if \(!exactReplay\)/,
    'an already-posted paid receipt remains an idempotent replay after its tender window');
  assert.ok(checkout.indexOf('if (existing.rowCount)') < checkout.indexOf("receipt_review_required_offline_sync"),
    'an existing paid receipt is returned before offline recovery staging');
});

test('a paid offline receipt captured under its locked snapshot remains eligible for durable review', async () => {
  const now = new Date(), captured = new Date(now.getTime() - 30_000), priced = new Date(now.getTime() - 60_000),
    expires = new Date(now.getTime() + 4 * 60_000), recoveryExpires = new Date(now.getTime() + 14 * 60_000);
  const product = { id:'latte', name:'Latte', sku:'LATTE', price:10, cost:2, unit:'pcs', variants:[], trackStock:false };
  const lockedTotals = { subtotal:10, discountAmount:0, tax:0, taxRate:0, discount:0,
    totalBeforeRounding:10, rounding:0, total:10 };
  const sale = createSale({ id:'offline-locked-sale', items:[cartItem(product)],
    company:{ id:'company-a', name:'Shop', preferences:{ currency:'RM', taxRate:0 } },
    user:{ uid:'cashier-a', username:'Cashier' }, method:'Cash', received:10, offline:true,
    lockedTotals, pricingSnapshotId:'snapshot-a', occurredAt:captured.toISOString() });
  const calls = [], c = { query:async sql => {
    calls.push(sql);
    if(sql.includes('SELECT workspace_id FROM myfin.companies'))return {rowCount:1,rows:[{workspace_id:'workspace-a'}]};
    if(sql.includes('pg_advisory_xact_lock'))return {rowCount:1,rows:[]};
    if(sql.includes('FROM myfin.transactions'))return {rowCount:0,rows:[]};
    if(sql.includes('FROM myfin.pricing_snapshots'))return {rowCount:1,rows:[{
      id:'snapshot-a',request_digest:'a'.repeat(64),rules_digest:'b'.repeat(64),priced_at:priced,
      expires_at:expires,recovery_expires_at:recoveryExpires,currency_code:'RM',customer_id:null,
      channel:'pos',issued_to_staff_id:'cashier-a',manual_discount_basis_points:0,manual_discount_sen:0,
      promotion_discount_sen:0,student_eligibility_version:null,subtotal_sen:1000,discount_sen:0,
      taxable_sen:1000,tax_sen:0,tax_basis_points:0,rounding_sen:0,total_sen:1000,
    }]};
    if(sql.includes('FROM myfin.pricing_snapshot_discounts'))return {rowCount:0,rows:[]};
    if(sql.includes('FROM myfin.pricing_snapshot_lines'))return {rowCount:1,rows:[{
      line_no:1,product_id:'latte',variant_id:null,category:'Beverage',subcategory:'Coffee',description:'Latte',
      quantity_milli:1000,unit_price_sen:1000,gross_sen:1000,discount_sen:0,net_sen:1000,automatic_reward:false,
    }]};
    throw Error(`unexpected query: ${sql}`);
  }};
  await assert.rejects(checkout(c,{id:'cashier-a',username:'Cashier',role:'operator'},'company-a',sale,null,
    {serverNow:now.toISOString()}),error=>error.statusCode===409&&error.message==='receipt_review_required_offline_sync');
  assert.equal(calls.some(sql=>sql.includes('FROM myfin.pricing_snapshot_lines')),true,
    'the locked cart is validated before the already-paid receipt enters review');
});

test('locked POS prices reserve shared capacity and consume the hold despite later campaign edits', async () => {
  const [migration, route, ui] = await Promise.all([
    readFile(new URL('../../db/migrations/0037_pos_pricing.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/pos-pricing.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/components/dashboard/EditionPos.vue', import.meta.url), 'utf8'),
  ]);
  const reserve = migration.slice(migration.indexOf('CREATE FUNCTION myfin.reserve_pos_promotions'),
    migration.indexOf('CREATE FUNCTION myfin.enforce_pos_promotion_redemption'));
  const consume = migration.slice(migration.indexOf('CREATE FUNCTION myfin.enforce_pos_promotion_redemption'),
    migration.indexOf('DROP TRIGGER promotion_redemption_limit_guard'));
  const promotionLock = reserve.indexOf('FROM myfin.promotions');
  const capacityRead = reserve.indexOf('FROM myfin.promotion_usage_counters');
  const sharedHolds = reserve.indexOf('FROM myfin.promotion_reservations', capacityRead);
  assert.ok(promotionLock >= 0 && promotionLock < capacityRead && capacityRead < sharedHolds,
    'the parent promotion lock must serialize both committed usage and every active hold');
  assert.match(reserve, /state='active' AND expires_at>now\(\)/);
  assert.match(reserve, /expires_at<=now\(\) OR pos_checkout_id=requested_checkout/);
  assert.match(reserve, /release_reason=CASE WHEN expires_at<=now\(\) THEN 'price_expired' ELSE 'price_refreshed' END/);
  assert.match(reserve, /FROM myfin\.promotion_vouchers[\s\S]*FOR UPDATE/);
  assert.match(consume, /held\.pos_checkout_id=NEW\.source_id/);
  assert.match(consume, /now\(\)>=reservation\.expires_at OR\s+NEW\.occurred_at>=reservation\.expires_at/);
  assert.match(consume, /PERFORM myfin\.apply_reserved_promotion_usage\(reservation\)/);
  assert.doesNotMatch(consume, /current_promotion\.version|rule\.enabled|voucher_rule\.enabled/,
    'a capacity hold must survive a later version or enabled-state change');
  assert.match(migration, /WHEN \(NEW\.source_type='pos_sale'\)[\s\S]*enforce_pos_promotion_redemption/);
  assert.match(migration, /CREATE TABLE myfin\.pos_pricing_recovery_exceptions/);
  assert.match(migration, /review_row\.status<>'pending'/);
  assert.doesNotMatch(migration, /review_row\.reason_code<>'receipt_review_required_pricing_expired'/,
    'a receipt first reviewed for another cause must remain resolvable after the recovery deadline');
  assert.match(consume, /AND NOT recovery_approved/);
  assert.ok(route.indexOf('createPricingSnapshot') < route.indexOf('reservePosPromotions'));
  assert.match(ui, /checkoutId:saleId\.value/);
});
