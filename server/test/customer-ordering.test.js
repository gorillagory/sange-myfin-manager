import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertProductReservationFloor, assertUnreservedSaleStock } from '../src/customer-order-reservations.js';
import { assertTenderMatches, canonicalTenderSale } from '../src/customer-orders.js';
import { orderOutput, quoteToken, storefrontRateKey, verifyQuoteToken } from '../src/storefront-public.js';
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
  assert.deepEqual(calls[0].params, ['company-a', 500]);
});

test('reviewed quotes are host, cart, totals and expiry bound by an authenticated token', () => {
  const secret = 's'.repeat(64);
  const context = { company_id: 'company-a', hostname: 'order-shop.finn3.com' };
  const input = { locationId: 'counter', serviceMode: 'pickup',
    items: [{ productId: 'latte', variantId: '', quantity: 2 }] };
  const quote = { locationId: 'counter', serviceMode: 'pickup', total: 19.9, rounding: -0.01 };
  const token = quoteToken(secret, context, input, quote);
  assert.ok(token.length < 500);
  assert.doesNotThrow(() => verifyQuoteToken(secret, token, context, input, quote));
  assert.throws(() => verifyQuoteToken(secret, token, context, input, { ...quote, total: 20 }),
    error => error.statusCode === 409 && error.message === 'quote_changed');
  assert.throws(() => verifyQuoteToken(secret, token, { ...context, hostname: 'staff.finn3.com' }, input, quote),
    error => error.statusCode === 409 && error.message === 'quote_changed');
  assert.throws(() => verifyQuoteToken('x'.repeat(64), token, context, input, quote),
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
  assert.throws(() => assertTenderMatches(order, lines, { ...sale, total: 19.95 }),
    error => error.statusCode === 409 && error.message === 'customer_order_checkout_changed');
  assert.throws(() => assertTenderMatches(order, lines, { ...sale,
    items: [{ ...sale.items[0], qty: 3 }] }),
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

  const accountResult = await canonicalTenderSale({ query: async () => ({ rows: [] }) },
    { ...order, customer_id: 'customer-a' }, lines, crafted);
  assert.equal(accountResult.customerName, 'Amina');
  const emailOnlyGuest = await canonicalTenderSale(
    { query: async () => { throw Error('guest must not select a client'); } },
    { ...order, guest_name: '', guest_email: 'private@example.test' }, lines, crafted);
  assert.equal(emailOnlyGuest.customerName, 'Walk-in customer');
  assert.equal(emailOnlyGuest.customerEmail, '');
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
  assert.match(sql, /immutable_customer_order_payments/);
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
