import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  addPublicCartLine, cartRequestItems, customerOrderSubmission, isCustomerSurfacePath, isStorefrontHostname, normalizeStorefront,
  orderProgress, publicCartLine, setPublicCartQuantity, validateGuestOrder,
} from '../src/domain/customerOrdering.js';
import {
  loadCustomerAccount, loadCustomerOrders, loadCustomerOrderStatus, loadStorefront, registerCustomerAccount,
  signInCustomerAccount, signOutCustomerAccount, submitCustomerOrder, updateCustomerMarketingConsent,
  updateCustomerProfile,
} from '../src/services/customerOrdering.js';

const menu = normalizeStorefront({
  storefront: { companyId: 'shop', name: 'Ba|Li', currency: 'RM' },
  locations: [{ id: 'counter', name: 'Counter', fulfillmentMode: 'pickup' }],
  products: [{ id: 'latte', name: 'Latte', price: 9, available: true, maxQuantity: 3,
    variants: [{ id: 'iced', name: 'Iced', price: 10, available: true, maxQuantity: 2 }] }],
});

test('customer routes are isolated from staff routes', () => {
  for (const path of ['/shop', '/menu?table=1', '/order/ABC123', '/privacy']) assert.equal(isCustomerSurfacePath(path), true);
  for (const path of ['/', '/orders', '/pos']) assert.equal(isCustomerSurfacePath(path), false);
  assert.equal(isStorefrontHostname('order-bfsb-bali.finn3.com'), true);
  assert.equal(isStorefrontHostname('bfsb-bali.finn3.com'), false);
});

test('a scanned dual-purpose location preserves the table or pickup choice', () => {
  const result = normalizeStorefront({ storefront: {}, location: { id: 'shop', name: 'Main shop', fulfillmentMode: 'both' } });
  assert.equal(result.location.fulfillmentMode, 'both');
});

test('storefront normalization preserves only safe bounded privacy notice fields', () => {
  const result = normalizeStorefront({ storefront: { privacy: {
    controllerName: 'Example Foods', controllerContact: 'privacy@example.test',
    noticeUrl: 'https://example.test/privacy', noticeEn: 'English notice', noticeMs: 'Notis BM',
    guestContactRetentionDays: 9000,
  } } });
  assert.deepEqual(result.storefront.privacy, {
    controllerName: 'Example Foods', controllerContact: 'privacy@example.test',
    noticeUrl: 'https://example.test/privacy', noticeEn: 'English notice', noticeMs: 'Notis BM',
    guestContactRetentionDays: 3650,
  });
  assert.equal(normalizeStorefront({ storefront: { privacy: { noticeUrl: 'javascript:alert(1)' } } })
    .storefront.privacy.noticeUrl, '');
});

test('customer bootstrap bypasses the staff offline worker', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /!isCustomerSurfacePath\(location\.pathname\)/);
  assert.doesNotMatch(main, /Store\.init\(\)/);
});

test('public menu and cart retain server IDs while enforcing availability caps', () => {
  assert.equal(menu.storefront.name, 'Ba|Li');
  const line = publicCartLine(menu.products[0], 'iced');
  assert.deepEqual(cartRequestItems([line]), [{ productId: 'latte', variantId: 'iced', quantity: 1 }]);
  const twice = addPublicCartLine([line], line);
  assert.equal(twice[0].quantity, 2);
  assert.throws(() => addPublicCartLine(twice, line), /up to 2/);
  assert.deepEqual(setPublicCartQuantity(twice, line.key, 0), []);
  assert.throws(() => publicCartLine({ ...menu.products[0], available: false }, 'iced'), /unavailable/);
});

test('remote pickup requires contact while a scanned table can stay anonymous', () => {
  assert.deepEqual(validateGuestOrder({ fulfillmentMode: 'table', guest: {} }), { name: 'Guest', email: '', phone: '', notes: '' });
  assert.throws(() => validateGuestOrder({ fulfillmentMode: 'pickup', guest: { name: 'Lee' } }), /email address or phone/);
  assert.equal(validateGuestOrder({ fulfillmentMode: 'pickup', guest: { name: 'Lee', phone: '+60 12-345 6789' } }).phone, '+60 12-345 6789');
  assert.throws(() => validateGuestOrder({ fulfillmentMode: 'pickup', guest: { name: 'Lee', email: 'wrong' } }), /valid email/);
  assert.deepEqual(customerOrderSubmission({ order: { serviceMode: 'pickup', items: [{ productId: 'latte', quantity: 1 }] }, quoteToken: 'signed-quote', fulfillmentMode: 'pickup', guest: { name: 'Lee', phone: '+60123456789' } }), {
    serviceMode: 'pickup', items: [{ productId: 'latte', quantity: 1 }], quoteToken: 'signed-quote', guest: { name: 'Lee', phone: '+60123456789' },
  });
  assert.throws(() => customerOrderSubmission({ order: {}, fulfillmentMode: 'table', guest: {} }), /latest shop quote/);
});

test('order status models normal and terminal progress', () => {
  assert.equal(orderProgress('ready').currentIndex, 3);
  assert.equal(orderProgress('awaiting_acceptance').current, 'submitted');
  assert.equal(orderProgress('paid', 'preparing').current, 'preparing');
  assert.equal(orderProgress('cancelled').terminal, true);
});

test('public ordering uses a separate cookie session and never puts a capability in browser storage or headers', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/status') ? { order: {} } : {} };
  };
  try {
    await loadStorefront('a'.repeat(32));
    await submitCustomerOrder({ items: [] }, '059b2d6e-2e68-42a8-838e-751b57efabbb');
    await loadCustomerOrderStatus('ABC12345');
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.options.credentials, 'include');
  assert.equal(calls[1].options.headers['Idempotency-Key'], '059b2d6e-2e68-42a8-838e-751b57efabbb');
  assert.equal('Authorization' in calls[2].options.headers, false);
});

test('customer account requests use the cookie session and preserve explicit profile and consent writes', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.includes('/orders?') ? { rows: [] } : { authenticated: true } };
  };
  try {
    await loadCustomerAccount();
    await registerCustomerAccount({ displayName: 'Amina', email: 'amina@example.test', phone: '', password: 'twelve-characters', adultConfirmed: true });
    await signInCustomerAccount({ email: 'amina@example.test', password: 'twelve-characters' });
    await updateCustomerProfile({ displayName: 'Amina R.', phone: '+60123456789' });
    await updateCustomerMarketingConsent('email', false);
    await loadCustomerOrders(999);
    await signOutCustomerAccount();
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(calls.map(call => [call.url, call.options.method]), [
    ['/api/public/customer/me', 'GET'],
    ['/api/public/customer/register', 'POST'],
    ['/api/public/customer/sign-in', 'POST'],
    ['/api/public/customer/profile', 'PUT'],
    ['/api/public/customer/marketing-consent', 'POST'],
    ['/api/public/customer/orders?limit=100', 'GET'],
    ['/api/public/customer/sign-out', 'POST'],
  ]);
  assert.equal(JSON.parse(calls[1].options.body).adultConfirmed, true);
  assert.deepEqual(JSON.parse(calls[4].options.body), { channel: 'email', granted: false });
  for (const call of calls) assert.equal(call.options.credentials, 'include');
});
