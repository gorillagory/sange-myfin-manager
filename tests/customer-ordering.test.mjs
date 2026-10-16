import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  accessibleStorefrontText, addPublicCartLine, cartRequestItems, customerOrderSubmission, customerProductDisplayPrice, deliveryOrderDetails, isCustomerSurfacePath, isStorefrontHostname, normalizeStorefront,
  orderProgress, publicCartLine, setPublicCartQuantity, storefrontContrastIssues, storefrontContrastRatio,
  storefrontFontStack, validateGuestOrder,
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
  for (const path of ['/shop', '/menu?table=1', '/display', '/order/ABC123', '/privacy']) assert.equal(isCustomerSurfacePath(path), true);
  for (const path of ['/', '/orders', '/pos']) assert.equal(isCustomerSurfacePath(path), false);
  assert.equal(isStorefrontHostname('order-bfsb-bali.finn3.com'), true);
  assert.equal(isStorefrontHostname('bfsb-bali.finn3.com'), false);
});

test('storefront normalization bounds branding, slides, and store versus online prices', () => {
  const result=normalizeStorefront({storefront:{logoUrl:'https://example.test/logo.png',
    theme:{primaryColor:'#123456',accentColor:'red',backgroundColor:'#ffffff',textColor:'#111111',fontFamily:'serif'},
    hero:{eyebrow:'A'.repeat(90),title:'Order today',description:'Ready',imageUrl:'javascript:bad'},
    carouselIntervalSeconds:100},slides:[{id:'one',title:'Weekend offer',badge:'OFFER',description:'Save now',
      imageUrl:'https://example.test/offer.jpg',backgroundColor:'#234567',ctaLabel:'Shop',ctaUrl:'/shop'}],
    products:[{id:'latte',name:'Latte',storePrice:12,onlinePrice:9,available:true,
      variants:[{id:'large',name:'Large',storePrice:14,onlinePrice:11,available:true}]}]});
  assert.equal(result.storefront.logoUrl,'https://example.test/logo.png');
  assert.equal(result.storefront.theme.accentColor,'#d7a43b');
  assert.equal(result.storefront.hero.eyebrow.length,80);
  assert.equal(result.storefront.hero.imageUrl,'');
  assert.equal(result.storefront.carouselIntervalSeconds,30);
  assert.deepEqual(result.slides[0],{id:'one',title:'Weekend offer',badge:'OFFER',description:'Save now',
    imageUrl:'https://example.test/offer.jpg',backgroundColor:'#234567',ctaLabel:'Shop',ctaUrl:'/shop'});
  assert.equal(result.products[0].storePrice,12);
  assert.equal(result.products[0].price,9);
  assert.equal(result.products[0].hasOnlinePriceOverride,true);
  assert.equal(result.products[0].variants[0].storePrice,14);
  assert.equal(result.products[0].variants[0].price,11);
});

test('storefront typography and contrast controls produce real customer-facing choices', () => {
  assert.match(storefrontFontStack('geist'), /Geist Variable/);
  assert.match(storefrontFontStack('system'), /^ui-sans-serif/);
  assert.match(storefrontFontStack('serif'), /^Georgia/);
  assert.ok(storefrontContrastRatio('#15382c','#fbfcf8') >= 4.5);
  assert.equal(accessibleStorefrontText('#000000','#ffffff'),'#ffffff');
  assert.equal(accessibleStorefrontText('#ffffff','#ffffff'),'#111111');
  assert.deepEqual(storefrontContrastIssues({
    textColor:'#fefefe', backgroundColor:'#ffffff', primaryColor:'#eeeeee',
  },[{ backgroundColor:'#f5f5f5' }]),[
    'Text and background colors need stronger contrast.',
    'Primary color must be dark enough for white button labels.',
    'Slide 1 background must be dark enough for white text.',
  ]);
});

test('storefront advertised pricing ignores sold-out variants while retaining a sold-out fallback', () => {
  const product = { storePrice: 8, onlinePrice: 8, variants: [
    { storePrice: 5, onlinePrice: 4, available: false },
    { storePrice: 12, onlinePrice: 10, available: true },
    { storePrice: 15, onlinePrice: 13, available: true },
  ] };
  assert.equal(customerProductDisplayPrice(product,'onlinePrice'),10);
  assert.equal(customerProductDisplayPrice(product,'storePrice'),12);
  assert.equal(customerProductDisplayPrice({ ...product, variants: product.variants.slice(0,1) },'onlinePrice'),4);
});

test('storefront and display make guest, account, reusable QR, and channel pricing explicit', async () => {
  const [storefront,display,admin,status]=await Promise.all([
    readFile(new URL('../src/components/customer/CustomerStorefront.vue',import.meta.url),'utf8'),
    readFile(new URL('../src/components/customer/CustomerDisplay.vue',import.meta.url),'utf8'),
    readFile(new URL('../src/components/dashboard/StorefrontAdmin.vue',import.meta.url),'utf8'),
    readFile(new URL('../src/components/customer/CustomerOrderStatus.vue',import.meta.url),'utf8'),
  ]);
  assert.match(storefront,/Order as a guest with no account required/);
  assert.match(storefront,/Sign in or create account/);
  assert.match(storefront,/--customer-page-ink/);
  assert.match(storefront,/--customer-accent-ink/);
  assert.match(storefront,/Online price/);
  assert.match(storefront,/online · .* store/);
  assert.match(storefront,/<s v-if="hasOnlineSaving\(product\)"/);
  assert.match(storefront,/>Order total</);
  assert.match(storefront,/'Place order'/);
  assert.doesNotMatch(storefront,/pay at the counter|pay later|Total due at counter/i);
  assert.match(display,/shopUrl/);assert.match(display,/Print banner/);assert.match(display,/Download PNG/);
  assert.match(display,/loadCanvasImage\(slide\.value\?\.imageUrl\)/);
  assert.match(display,/loadCanvasImage\(storefront\.value\.logoUrl\)/);
  assert.match(display,/storefrontFontStack/);
  assert.match(display,/fulfillmentLabel/);
  assert.match(display,/blocks reuse/);
  assert.match(display,/Pause promotion carousel/);
  assert.match(display,/visibilitychange/);
  assert.match(display,/if\(withdrawn\)\{menu\.value=null;qrImage\.value=''/);
  assert.match(admin,/Reusable shop QR/);assert.match(admin,/Reset to store price/);
  assert.match(status,/reconciliation_required/);
  assert.match(status,/Do not start another payment or pay at the counter/);
  assert.doesNotMatch(status,/status === 503\) sessionStorage\.removeItem/);
});

test('a scanned dual-purpose location preserves the table or pickup choice', () => {
  const result = normalizeStorefront({ storefront: {}, location: { id: 'shop', name: 'Main shop', fulfillmentMode: 'both' } });
  assert.equal(result.location.fulfillmentMode, 'both');
});

test('delivery normalization exposes only valid enabled-zone projections and validates a bounded address', () => {
  const result = normalizeStorefront({ storefront:{}, deliveryZones:[
    { id:'campus', name:'Campus', fee:2.5, minimumOrder:15, leadTimeMinutes:35, serviceInstructions:'Lobby' },
    { id:'bad', name:'Bad', fee:-1, minimumOrder:0, leadTimeMinutes:1 },
  ] });
  assert.deepEqual(result.deliveryZones, [{ id:'campus', name:'Campus', fee:2.5, minimumOrder:15,
    leadTimeMinutes:35, serviceInstructions:'Lobby' }]);
  assert.deepEqual(deliveryOrderDetails('campus', { addressLine1:' 12 Jalan A ', postcode:'50000',
    city:'Kuala Lumpur', state:'Kuala Lumpur', instructions:' Lobby ' }, result.deliveryZones), {
    zoneId:'campus', address:{ addressLine1:'12 Jalan A', addressLine2:'', postcode:'50000',
      city:'Kuala Lumpur', state:'Kuala Lumpur', countryCode:'MY', instructions:'Lobby' },
  });
  assert.throws(() => deliveryOrderDetails('other', {}, result.deliveryZones), /available delivery zone/);
  assert.throws(() => deliveryOrderDetails('campus', { addressLine1:'12 Jalan A' }, result.deliveryZones), /postcode/);
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

test('storefront discards a stale promotion quote before refreshing it', async () => {
  const source = await readFile(new URL('../src/components/customer/CustomerStorefront.vue', import.meta.url), 'utf8');
  const recovery = source.slice(source.indexOf("if (['quote_changed','promotion_unavailable'].includes"));
  assert.ok(recovery.indexOf("retry = null; quote.value = null; quoteToken.value = ''") <
    recovery.indexOf('await quoteCustomerOrder(currentOrder(true))'));
  assert.match(recovery, /A promotion or voucher changed\. Review the refreshed total/);
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
    await registerCustomerAccount({ loginId:'amina', displayName: 'Amina', email: 'amina@example.test', phone: '', password: 'twelve-characters', adultConfirmed: true });
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

test('customer marketing controls fail closed for unverified destinations while allowing withdrawal', async () => {
  const panel = await readFile(new URL('../src/components/customer/CustomerAccountPanel.vue', import.meta.url), 'utf8');
  assert.match(panel, /state\.recordedGranted \?\? state\.granted/);
  assert.match(panel, /!consent\[channel\] && !channelState\(channel\)\.canGrant/);
  assert.match(panel, /Paused: the saved destination is no longer verified/);
  assert.match(panel, /Unverified destinations cannot be opted in/);
  assert.match(panel, /sign in separately at each shop/i);
});
