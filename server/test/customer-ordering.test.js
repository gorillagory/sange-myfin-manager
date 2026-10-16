import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertProductReservationFloor, assertUnreservedSaleStock } from '../src/customer-order-reservations.js';
import { assertTenderMatches, canonicalTenderSale, registerCustomerOrders } from '../src/customer-orders.js';
import { orderOutput, orderRequestDigest, quoteToken, storefrontRateKey, totalsWithDelivery,
  verifyQuoteToken } from '../src/storefront-public.js';
import { redactExpiredOrderContacts, requirePublishedStorefrontPrivacy,
  storefrontPrivacyComplete, storefrontPrivacyOutput } from '../src/storefront-privacy.js';
import { requestContext } from '../src/tenancy.js';

test('storefront privacy publication requires a bilingual point-of-collection notice', async () => {
  const complete = {
    privacyControllerName: 'Example Foods Sdn Bhd', privacyControllerContact: 'privacy@example.test',
    privacyNoticeUrl: 'https://example.test/privacy',
    privacyNoticeEn: 'We use your contact details to prepare and update you about this order.',
    privacyNoticeMs: 'Kami menggunakan butiran hubungan anda untuk menyediakan pesanan ini.',
    guestContactRetentionDays: 90,
  };
  assert.equal(storefrontPrivacyComplete(complete), true);
  assert.equal(storefrontPrivacyComplete({ ...complete, privacyNoticeMs: '' }), false);
  assert.equal(storefrontPrivacyComplete({ ...complete, privacyNoticeUrl: 'http://example.test/privacy' }), false);
  assert.deepEqual(storefrontPrivacyOutput({
    privacy_controller_name: complete.privacyControllerName,
    privacy_controller_contact: complete.privacyControllerContact,
    privacy_notice_url: complete.privacyNoticeUrl,
    privacy_notice_en: complete.privacyNoticeEn,
    privacy_notice_ms: complete.privacyNoticeMs,
    guest_data_retention_days: 90,
  }), {
    controllerName: complete.privacyControllerName, controllerContact: complete.privacyControllerContact,
    noticeUrl: complete.privacyNoticeUrl, noticeEn: complete.privacyNoticeEn,
    noticeMs: complete.privacyNoticeMs, guestContactRetentionDays: 90,
  });
  await assert.rejects(requirePublishedStorefrontPrivacy({ query: async () => ({ rows: [] }) }, 'company-a'),
    error => error.statusCode === 409 && error.message === 'storefront_privacy_notice_unavailable');
});

test('expired order contact cleanup is bounded, concurrent-safe and idempotent', async () => {
  const calls = [];
  const c = { query: async (sql, params) => {
    calls.push({ sql, params });
    return calls.length === 1 ? { rowCount: 2, rows: [{ id: 'a' }, { id: 'b' }] } : { rowCount: 0, rows: [] };
  } };
  assert.equal(await redactExpiredOrderContacts(c, 'company-a', 9000), 2);
  assert.equal(await redactExpiredOrderContacts(c, 'company-a', 9000), 0);
  assert.match(calls[0].sql, /pii_redacted_at IS NULL/);
  assert.match(calls[0].sql, /status IN \('cancelled','expired','paid'\)/);
  assert.match(calls[0].sql, /LIMIT \$2\s+FOR UPDATE OF o SKIP LOCKED/);
  assert.match(calls[0].sql, /guest_email='',guest_phone='',notes='',pii_redacted_at=now\(\)/);
  assert.match(calls[0].sql, /delivery_address_snapshot=.*'\{\}'::jsonb/s);
  assert.match(calls[0].sql, /delivery_contact_purpose=.*''/s);
  assert.deepEqual(calls[0].params, ['company-a', 500]);
});

test('delivery quote tokens bind zone and every address field without exposing them in the token signature', () => {
  const secret = 's'.repeat(64), context = { company_id:'company-a', hostname:'order-shop.finn3.com' };
  const input = { locationId:'counter', serviceMode:'delivery', items:[{ productId:'latte', variantId:'', quantity:1 }],
    delivery:{ zoneId:'campus', address:{ addressLine1:'12 Jalan A', addressLine2:'', postcode:'50000',
      city:'Kuala Lumpur', state:'Kuala Lumpur', countryCode:'MY', instructions:'Lobby' } } };
  const quote = { locationId:'counter', serviceMode:'delivery', subtotal:19.92, deliveryFee:2.53,
    totalBeforeRounding:22.45, rounding:0, total:22.45 };
  const binding = { snapshotId:'snapshot-a', snapshotRequestDigest:'a'.repeat(64),
    principalDigest:'principal-a', expiresAt:Date.now()+60_000 };
  const token = quoteToken(secret, context, input, quote, binding);
  assert.doesNotMatch(token, /Jalan|Lobby/);
  assert.doesNotThrow(() => verifyQuoteToken(secret, token, context, input, quote,
    { principalDigest:binding.principalDigest }));
  assert.throws(() => verifyQuoteToken(secret, token, context,
    { ...input, delivery:{ ...input.delivery, address:{ ...input.delivery.address, postcode:'50001' } } }, quote,
    { principalDigest:binding.principalDigest }),
  error => error.statusCode === 409 && error.message === 'quote_changed');
  assert.throws(() => verifyQuoteToken(secret, token, context,
    { ...input, delivery:{ ...input.delivery, zoneId:'other' } }, quote,
    { principalDigest:binding.principalDigest }),
  error => error.statusCode === 409 && error.message === 'quote_changed');
  const first = orderRequestDigest(context, { ...input, quoteToken:token });
  assert.equal(first, orderRequestDigest(context, { ...input, quoteToken:token }));
  assert.notEqual(first, orderRequestDigest(context, { ...input, quoteToken:token,
    delivery:{ ...input.delivery, address:{ ...input.delivery.address, instructions:'Side door' } } }));
  assert.notEqual(first, orderRequestDigest({ ...context, company_id:'company-b' }, { ...input, quoteToken:token }));
});

test('delivery fee is added in integer sen before the existing five-sen rounding rule', () => {
  const result = totalsWithDelivery({ subtotal:19.91, discountAmount:0, tax:0, taxRate:0,
    totalBeforeRounding:19.91, rounding:-0.01, total:19.9 }, 253);
  assert.deepEqual(result, { subtotal:19.91, discountAmount:0, discount:0, tax:0, taxRate:0,
    totalBeforeRounding:22.44, rounding:0.01, total:22.45, deliveryFee:2.53 });
});

test('reviewed quotes are host, cart, totals and expiry bound by an authenticated token', () => {
  const secret = 's'.repeat(64);
  const context = { company_id: 'company-a', hostname: 'order-shop.finn3.com' };
  const input = { locationId: 'counter', serviceMode: 'pickup',
    items: [{ productId: 'latte', variantId: '', quantity: 2 }] };
  const quote = { locationId: 'counter', serviceMode: 'pickup', total: 19.9, rounding: -0.01 };
  const binding = { snapshotId:'snapshot-a', snapshotRequestDigest:'b'.repeat(64),
    principalDigest:'principal-a', expiresAt:Date.now()+60_000 };
  const token = quoteToken(secret, context, input, quote, binding);
  assert.ok(token.length < 1000);
  assert.doesNotThrow(() => verifyQuoteToken(secret, token, context, input, quote,
    { principalDigest:binding.principalDigest }));
  assert.throws(() => verifyQuoteToken(secret, token, context, input, { ...quote, total: 20 },
    { principalDigest:binding.principalDigest }),
    error => error.statusCode === 409 && error.message === 'quote_changed');
  assert.throws(() => verifyQuoteToken(secret, token, { ...context, hostname: 'staff.finn3.com' }, input, quote,
    { principalDigest:binding.principalDigest }),
    error => error.statusCode === 409 && error.message === 'quote_changed');
  assert.throws(() => verifyQuoteToken('x'.repeat(64), token, context, input, quote,
    { principalDigest:binding.principalDigest }),
    error => error.statusCode === 409 && error.message === 'quote_changed');
  assert.throws(() => verifyQuoteToken(secret, token, context, input, quote,
    { principalDigest:'different-principal' }),
  error => error.statusCode === 409 && error.message === 'quote_changed');
});

test('public order projection maps submitted status and excludes contacts and internal SKU', () => {
  const output = orderOutput({ id: 'order-a', public_code: 'ABC12345', company_id: 'company-a',
    location_id: 'counter', customer_id: null, guest_name: 'Guest', guest_email: 'private@example.com',
    guest_phone: '0123456789', status: 'awaiting_acceptance', payment_state: 'unpaid',
    fulfillment_status: '', version: 1, currency: 'RM', subtotal: 9.91, discount_amount: 0,
    tax: 0, tax_rate: 0, total_before_rounding: 9.91, rounding: -0.01, total: 9.9,
    notes: '', expires_at: new Date(), created_at: new Date(), updated_at: new Date() },
  [{ product_id: 'latte', variant_id: null, description: 'Latte', variant_name: '', sku: 'INTERNAL-1',
    unit: 'cup', quantity: 1, unit_price: 9.91, line_total: 9.91 }]);
  assert.equal(output.status, 'submitted');
  assert.equal(output.paymentState, 'unpaid');
  assert.equal(output.items[0].sku, undefined);
  assert.equal(output.guestEmail, undefined);
  assert.equal(output.guestPhone, undefined);
});

test('public delivery projection exposes only an area summary while retaining service pricing', () => {
  const output = orderOutput({ id:'order-d', public_code:'DELIV123', company_id:'company-a', location_id:'counter',
    guest_name:'Private', status:'accepted', payment_state:'unpaid', version:2, currency:'RM', subtotal:20,
    discount_amount:0, tax:0, tax_rate:0, total_before_rounding:22.5, rounding:0, total:22.5,
    service_mode:'delivery', delivery_zone_id:'zone-a', delivery_fee_sen:250,
    delivery_zone_snapshot:{ name:'Campus', leadTimeMinutes:30, serviceInstructions:'Lobby only' },
    delivery_address_snapshot:{ addressLine1:'12 Secret Street', postcode:'50000', city:'Kuala Lumpur',
      state:'Kuala Lumpur', countryCode:'MY', instructions:'Blue door' }, expires_at:new Date(), created_at:new Date(), updated_at:new Date() }, []);
  assert.deepEqual(output.delivery.address, { postcode:'50000', city:'Kuala Lumpur', state:'Kuala Lumpur', countryCode:'MY' });
  assert.equal(output.deliveryFee, 2.5);
  assert.doesNotMatch(JSON.stringify(output), /Secret Street|Blue door/);
  const redacted = orderOutput({ ...output, public_code:'DELIV123', company_id:'company-a', location_id:'counter',
    payment_state:'unpaid', subtotal:20, discount_amount:0, tax_rate:0, total_before_rounding:22.5,
    service_mode:'delivery', delivery_zone_id:'zone-a', delivery_fee_sen:250,
    delivery_zone_snapshot:{ name:'Campus' }, delivery_address_snapshot:{}, delivery_address_redacted_at:new Date(),
    created_at:new Date(), updated_at:new Date(), expires_at:new Date() }, []);
  assert.equal(redacted.delivery.address, undefined);
  assert.equal(redacted.delivery.addressRedacted, true);
});

test('walk-in availability subtracts active reservations and can exclude the tendered order', async () => {
  const calls = [];
  const c = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: params[2] === 'order-a' ? [] : [{ product_id: 'latte', variant_id: '', quantity: '3' }] };
  } };
  const products = [{ id: 'latte', data: { id: 'latte', trackStock: true, stock: 5, variants: [] } }];
  await assertUnreservedSaleStock(c, 'company-a', products, [{ productId: 'latte', variantId: '', qty: 2 }]);
  await assert.rejects(
    assertUnreservedSaleStock(c, 'company-a', products, [{ productId: 'latte', variantId: '', qty: 3 }]),
    error => error.statusCode === 409 && error.message === 'stock_reserved_or_unavailable',
  );
  await assertUnreservedSaleStock(c, 'company-a', products, [{ productId: 'latte', variantId: '', qty: 5 }], 'order-a');
  assert.equal(calls.at(-1).params[2], 'order-a');
});

test('counter tender must match the accepted immutable cart and server totals', () => {
  const order = { company_id: 'company-a', subtotal: 19.92, discount_amount: 0, tax: 0,
    tax_rate: 0, total_before_rounding: 19.92, rounding: -0.02, total: 19.9 };
  const lines = [{ product_id: 'latte', variant_id: null, quantity: 2, unit_price: 9.955 }];
  const sale = { company_id: 'company-a', subtotal: 19.92, discountAmount: 0, discount: 0,
    tax: 0, taxRate: 0, totalBeforeRounding: 19.92, rounding: -0.02, total: 19.9,
    items: [{ productId: 'latte', variantId: '', qty: 2, price: 9.955 }] };
  assert.doesNotThrow(() => assertTenderMatches(order, lines, sale));
  const snapshotOrder = { ...order, currency:'RM', pricing_snapshot_id:'snapshot-a' };
  const snapshotSale = { ...sale, storeSnapshot:{ currency:'RM' }, pricingSnapshotId:'snapshot-a' };
  assert.doesNotThrow(() => assertTenderMatches(snapshotOrder, lines, snapshotSale));
  assert.throws(() => assertTenderMatches(snapshotOrder, lines, { ...snapshotSale, pricingSnapshotId:'' }),
    error => error.statusCode === 409 && error.message === 'customer_order_checkout_changed');
  assert.throws(() => assertTenderMatches(order, lines, { ...sale, total: 19.95 }),
    error => error.statusCode === 409 && error.message === 'customer_order_checkout_changed');
  assert.throws(() => assertTenderMatches(order, lines, { ...sale,
    items: [{ ...sale.items[0], qty: 3 }] }),
    error => error.statusCode === 409 && error.message === 'customer_order_checkout_changed');

  const deliveryOrder = { ...order, service_mode:'delivery', delivery_fee_sen:253,
    total_before_rounding:22.45, rounding:0, total:22.45 };
  const deliverySale = { ...sale, deliveryFee:2.53, totalBeforeRounding:22.45, rounding:0, total:22.45 };
  assert.doesNotThrow(() => assertTenderMatches(deliveryOrder, lines, deliverySale));
  for (const changed of [{ ...deliverySale, deliveryFee:2.5 }, { ...deliverySale, deliveryFee:undefined }])
    assert.throws(() => assertTenderMatches(deliveryOrder, lines, changed),
      error => error.statusCode === 409 && error.message === 'customer_order_checkout_changed');
});

test('counter tender rebuilds receipt lines and customer linkage from the accepted order', async () => {
  const order = { company_id: 'company-a', customer_id: null, guest_name: 'Amina', guest_email: 'amina@example.test' };
  const lines = [{ product_id: 'latte', variant_id: 'large', variant_name: 'Large', sku: 'LAT-L',
    description: 'Cafe Latte', unit: 'cup', quantity: '2', unit_price: '9.9500' }];
  const crafted = { id: 'sale-a', items: [{ productId: 'latte', desc: 'Forged', sku: 'FORGED', qty: 2, price: 9.95 }],
    client_id: 'other-client', customerName: 'Other', customerEmail: 'other@example.test' };
  const result = await canonicalTenderSale({ query: async () => { throw Error('guest must not select a client'); } }, order, lines, crafted);
  assert.deepEqual(result.items, [{ productId: 'latte', variantId: 'large', variant: 'Large', sku: 'LAT-L',
    desc: 'Cafe Latte', price: 9.95, unit: 'cup', qty: 2 }]);
  assert.equal(result.client_id, '');
  assert.equal(result.customerName, 'Walk-in customer');
  assert.equal(result.customerEmail, '');
  assert.equal(Object.hasOwn(result,'deliveryFee'), false);
  assert.equal(Object.hasOwn(result,'pricingSnapshotId'), false);

  const snapshotResult = await canonicalTenderSale(
    { query: async () => { throw Error('guest must not select a client'); } },
    { ...order, pricing_snapshot_id:'snapshot-a' }, lines, crafted);
  assert.equal(snapshotResult.pricingSnapshotId, 'snapshot-a');

  const deliveryResult = await canonicalTenderSale(
    { query: async () => { throw Error('guest must not select a client'); } },
    { ...order, service_mode:'delivery', delivery_fee_sen:253 }, lines, { ...crafted, deliveryFee:999 });
  assert.equal(deliveryResult.deliveryFee, 2.53);

  const accountResult = await canonicalTenderSale({ query: async () => ({ rows: [] }) },
    { ...order, customer_id: 'customer-a' }, lines, crafted);
  assert.equal(accountResult.customerName, 'Amina');
  const emailOnlyGuest = await canonicalTenderSale(
    { query: async () => { throw Error('guest must not select a client'); } },
    { ...order, guest_name: '', guest_email: 'private@example.test' }, lines, crafted);
  assert.equal(emailOnlyGuest.customerName, 'Walk-in customer');
  assert.equal(emailOnlyGuest.customerEmail, '');
});

test('manager finalization posts a verified online payment once from authoritative order totals', async () => {
  const app = { routes: [],
    get(url, handler) { this.routes.push({ method:'GET', url, handler }); },
    post(url, handler) { this.routes.push({ method:'POST', url, handler }); },
    put(url, handler) { this.routes.push({ method:'PUT', url, handler }); } };
  const now = '2026-10-16T02:30:00.000Z';
  const order = { company_id:'company-a', id:'order-a', public_code:'ABC12345',
    location_id:'counter', location_name:'Counter', fulfillment_mode:'pickup', table_label:'',
    pickup_instructions:'', service_mode:'pickup', customer_id:null, guest_name:'Guest',
    guest_email:'', guest_phone:'', status:'accepted', payment_state:'unpaid', version:2,
    currency:'RM', subtotal:'19.95', discount_amount:'0', tax:'0', tax_rate:'0',
    total_before_rounding:'19.95', rounding:'0', total:'19.95', delivery_fee_sen:0,
    pricing_snapshot_id:'snapshot-a', promotion_discounts:[],
    expires_at:'2026-10-16T03:30:00.000Z', created_at:now, updated_at:now,
    sale_id:null, fulfillment_status:null };
  const lines = [{ line_no:1, product_id:'latte', variant_id:null, variant_name:'', sku:'LATTE',
    description:'Latte', unit:'cup', quantity:'1', unit_price:'19.95', line_total:'19.95' }];
  const evidence = { company_id:'company-a', order_id:'order-a', intent_id:'intent-a',
    amount_sen:'1995', currency_code:'MYR', state:'confirmed_unposted',
    provider_payment_id:'payment-a', provider_method_code:'duitnow', provider_status:'completed',
    confirmed_at:now, public_code_snapshot:'ABC12345', created_at:now };
  let finalization = null, savedSale = null, checkoutCalls = 0;
  const c = { query: async (sql, params = []) => {
    if (/FROM myfin\.online_payment_finalizations\s+WHERE company_id=\$1 AND request_id=\$2/.test(sql))
      return { rows: finalization && finalization.request_id === params[1] ? [finalization] : [],
        rowCount: finalization && finalization.request_id === params[1] ? 1 : 0 };
    if (/FROM myfin\.customer_order_requests o\s+JOIN myfin\.shop_locations/.test(sql))
      return { rows:[order], rowCount:1 };
    if (/pg_advisory_xact_lock/.test(sql)) return { rows:[{}], rowCount:1 };
    if (/FROM myfin\.customer_order_online_payment_state s/.test(sql))
      return { rows:[{ ...evidence, ...(finalization ? { state:'finalized',
        finalized_sale_id:finalization.sale_id, finalized_at:now } : {}) }], rowCount:1 };
    if (/FROM myfin\.online_payment_finalizations\s+WHERE company_id=\$1 AND order_id=\$2/.test(sql))
      return { rows:finalization ? [finalization] : [], rowCount:finalization ? 1 : 0 };
    if (/FROM myfin\.customer_order_lines/.test(sql)) return { rows:lines, rowCount:lines.length };
    if (/SELECT name,data FROM myfin\.companies/.test(sql)) return { rows:[{ name:'Cafe', data:{
      preferences:{ currency:'RM', taxRate:0, receiptFooter:'Thank you', paperWidth:'80' } } }], rowCount:1 };
    if (/INSERT INTO myfin\.customer_order_payments/.test(sql)) {
      order.sale_id = params[2]; return { rows:[], rowCount:1 };
    }
    if (/UPDATE myfin\.customer_order_requests SET status='paid'/.test(sql)) {
      order.status = 'paid'; order.payment_state = 'paid'; order.version = params[2];
      return { rows:[order], rowCount:1 };
    }
    if (/UPDATE myfin\.customer_order_(?:recipe_)?reservations/.test(sql)) return { rows:[], rowCount:1 };
    if (/consume_order_promotion_reservations/.test(sql)) return { rows:[{ count:1 }], rowCount:1 };
    if (/INSERT INTO myfin\.customer_order_events/.test(sql)) return { rows:[], rowCount:1 };
    if (/INSERT INTO myfin\.online_payment_finalizations/.test(sql)) {
      finalization = { intent_id:params[2], order_id:params[3], sale_id:params[4], actor_id:params[5],
        request_id:params[6], request_digest:params[7] }; return { rows:[], rowCount:1 };
    }
    if (/SELECT company_id,id,data FROM myfin\.transactions/.test(sql))
      return { rows:savedSale ? [{ company_id:'company-a', id:savedSale.id, data:savedSale }] : [],
        rowCount:savedSale ? 1 : 0 };
    throw new Error(`unexpected_sql:${sql}`);
  } };
  registerCustomerOrders(app, { scoped:(req, fn) => fn(c, req.params.company), audit:async () => {},
    checkout:async (_c, who, companyId, sale, _approval, options) => {
      checkoutCalls += 1;
      assert.equal(who.id, 'manager-a'); assert.equal(companyId, 'company-a');
      assert.equal(options.acceptedOrderQuote, true); assert.equal(options.serverNow, now);
      assert.equal(sale.total, 19.95); assert.equal(sale.received, 19.95);
      assert.equal(sale.paymentMethod, 'QR Pay'); assert.equal(sale.cashierId, 'manager-a');
      assert.equal(sale.date, now); savedSale = sale; return sale;
    } });
  const route = app.routes.find(item => item.method === 'POST' &&
    item.url.endsWith('/online-payment/finalize'));
  const req = { params:{ company:'company-a', id:'order-a' }, identity:{ id:'manager-a',
    username:'Manager', role:'manager' }, body:{ requestId:'5f851550-5083-43d8-b633-638851107ae2',
    expectedVersion:2 } };
  const first = await route.handler(req);
  assert.equal(first.onlinePayment.state, 'finalized');
  assert.equal(first.saleId, savedSale.id);
  assert.equal(order.payment_state, 'paid');
  assert.equal(finalization.intent_id, 'intent-a');
  assert.equal(checkoutCalls, 1);
  const replay = await route.handler(req);
  assert.equal(replay.saleId, first.saleId);
  assert.equal(checkoutCalls, 1, 'lost-response retry must reuse the exact posted sale');
  await assert.rejects(route.handler({ ...req, identity:{ id:'operator-a', role:'operator' } }),
    error => error.statusCode === 403 && error.message === 'manager_required');
  await assert.rejects(route.handler({ ...req, body:{ ...req.body, amount:0.01 } }),
    error => error.statusCode === 400 && error.message === 'invalid_input');
});

test('manager cancellation shares the payment lock and cannot release a pending hosted checkout', async () => {
  const app = { routes:[],
    get(url, handler) { this.routes.push({ method:'GET',url,handler }); },
    post(url, handler) { this.routes.push({ method:'POST',url,handler }); },
    put(url, handler) { this.routes.push({ method:'PUT',url,handler }); } };
  const calls = [];
  const order = { company_id:'company-a', id:'order-a', public_code:'ABC12345', status:'accepted',
    payment_state:'unpaid', version:2, expires_at:new Date(Date.now()+600_000).toISOString(),
    location_name:'Counter', fulfillment_mode:'pickup', table_label:'', pickup_instructions:'' };
  const c = { query:async (sql, params = []) => {
    calls.push({ sql,params });
    if (/SELECT request_digest FROM myfin\.customer_order_events/.test(sql))
      return { rows:[],rowCount:0 };
    if (/FROM myfin\.customer_order_requests o\s+JOIN myfin\.shop_locations/.test(sql))
      return { rows:[order],rowCount:1 };
    if (/pg_advisory_xact_lock/.test(sql)) return { rows:[{}],rowCount:1 };
    if (/SELECT state FROM myfin\.customer_order_online_payment_state/.test(sql))
      return { rows:[{ state:'pending' }],rowCount:1 };
    throw new Error(`unexpected_sql:${sql}`);
  } };
  registerCustomerOrders(app, { scoped:(req, fn) => fn(c, req.params.company),
    audit:async () => {}, checkout:async () => { throw new Error('must not tender'); } });
  const route = app.routes.find(item => item.method === 'POST' && item.url.endsWith('/transitions'));
  await assert.rejects(route.handler({ params:{ company:'company-a',id:'order-a' },
    identity:{ id:'manager-a',role:'manager' }, body:{
      requestId:'4f64dc0d-f2ae-4cdf-9daf-f35acc5230e3', expectedVersion:2,
      status:'cancelled', note:'Customer asked to cancel',
    } }), error => error.statusCode === 409 && error.message === 'online_payment_holds_order');
  const lock = calls.find(call => call.sql.includes('pg_advisory_xact_lock'));
  assert.deepEqual(lock.params, ['online-payment-order:company-a:order-a']);
  assert.equal(calls.some(call => /UPDATE myfin\.customer_order_requests/.test(call.sql)), false);
  assert.equal(calls.some(call => /release_order_promotion_reservations/.test(call.sql)), false);
});

test('inventory edits cannot disable tracking or reduce stock below accepted reservations', async () => {
  const c = { query: async () => ({ rows: [{ product_id: 'latte', variant_id: '', quantity: '3' }] }) };
  await assert.doesNotReject(assertProductReservationFloor(c, 'company-a',
    { id: 'latte', trackStock: true, stock: 3, variants: [] }));
  await assert.rejects(assertProductReservationFloor(c, 'company-a',
    { id: 'latte', trackStock: true, stock: 2, variants: [] }),
  error => error.statusCode === 409 && error.message === 'active_order_reservations');
  await assert.rejects(assertProductReservationFloor(c, 'company-a',
    { id: 'latte', trackStock: false, stock: 10, variants: [] }),
  error => error.statusCode === 409 && error.message === 'active_order_reservations');
  await assert.rejects(assertProductReservationFloor(c, 'company-a',
    { id: 'latte', trackStock: true, stock: 10, variants: [{ id: 'large', stock: 10 }] }),
  error => error.statusCode === 409 && error.message === 'active_order_reservations');
});

test('request context resolves explicit storefront hosts only after staff-host lookup', async () => {
  const calls = [];
  const db = { query: async (sql, params) => {
    calls.push(sql);
    if (sql.includes('FROM myfin.tenant_hosts')) return { rows: [] };
    if (sql.includes('FROM myfin.storefront_hosts')) return { rows: [{ hostname: params[0], company_id: 'company-a',
      workspace_id: 'workspace-a', company_name: 'Cafe', company_slug: 'cafe', workspace_name: 'Owner', workspace_slug: 'owner' }] };
    return { rows: [] };
  } };
  const context = await requestContext(db, { headers: { host: 'order-owner-cafe.finn3.com' } },
    { allowedHosts: ['*.finn3.com'], controlHosts: [] });
  assert.equal(context.surface, 'storefront');
  assert.equal(context.company_id, 'company-a');
  assert.match(calls[0], /tenant_hosts/);
  assert.match(calls[1], /storefront_hosts/);
});

test('public rate limiting trusts the overwritten client header only from an explicit proxy', () => {
  const request = { socket: { remoteAddress: '192.168.1.103' }, ip: '192.168.1.103',
    headers: { 'x-myfin-client-ip': '203.0.113.9' } };
  assert.equal(storefrontRateKey(request, { publicProxyAddresses: [] }), '192.168.1.103');
  assert.equal(storefrontRateKey(request, { publicProxyAddresses: ['192.168.1.103'] }), '203.0.113.9');
  assert.equal(storefrontRateKey({ ...request, headers: { 'x-myfin-client-ip': 'spoofed, 203.0.113.9' } },
    { publicProxyAddresses: ['192.168.1.103'] }), '192.168.1.103');
});

test('migration separates security surfaces and keeps audit and payment ledgers immutable', async () => {
  const sql = await readFile(new URL('../../db/migrations/0018_customer_ordering.sql', import.meta.url), 'utf8');
  assert.match(sql, /storefront_host_surface_guard/);
  assert.match(sql, /split_part\(NEW\.hostname,'.',1\) LIKE 'order-%'/);
  assert.match(sql, /customer_guest_sessions/);
  assert.match(sql, /guest_session_digest/);
  assert.match(sql, /immutable_customer_order_events/);
  assert.match(sql, /immutable_customer_order_payments/);
  assert.match(sql, /immutable_customer_loyalty_events/);
  assert.match(sql, /staff_actor_id text REFERENCES myfin\.app_identities/);
  assert.match(sql, /customer_actor_id text REFERENCES myfin\.customer_accounts/);
  assert.match(sql, /actor_type='customer'.*customer_actor_id IS NOT NULL/s);
  assert.match(sql, /customer_loyalty_sale_earn_key/);
  assert.match(sql, /CHECK\(\(status='paid'\)=\(payment_state='paid'\)\)/);
  assert.match(sql, /guest_data_retention_days integer NOT NULL DEFAULT 90/);
  assert.match(sql, /privacy_notice_en text NOT NULL DEFAULT ''/);
  assert.match(sql, /privacy_notice_ms text NOT NULL DEFAULT ''/);
  assert.match(sql, /pii_redacted_at timestamptz/);
  assert.match(sql, /customer_order_contact_retention_idx/);
  const publicSource = await readFile(new URL('../src/storefront-public.js', import.meta.url), 'utf8');
  assert.match(publicSource, /HttpOnly; Secure; SameSite=Lax/);
  assert.match(publicSource, /o\.guest_session_digest=\$3/);
  assert.match(publicSource, /storefrontPrivacyOutput\(config\)/);
  const authSource = await readFile(new URL('../src/customer-auth.js', import.meta.url), 'utf8');
  assert.equal(authSource.match(/requirePublishedStorefrontPrivacy\(c, context\.company_id\)/g)?.length, 3);
  const staffSource = await readFile(new URL('../src/customer-orders.js', import.meta.url), 'utf8');
  assert.match(staffSource, /ORDER BY expires_at,id LIMIT 200 FOR UPDATE SKIP LOCKED/);
});
