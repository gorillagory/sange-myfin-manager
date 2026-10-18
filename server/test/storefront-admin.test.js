import assert from 'node:assert/strict';
import test from 'node:test';
import { registerStorefrontAdmin } from '../src/storefront-admin.js';

function client({ settings, host = '', locations = [], deliveryZones = [], slides = [], products = [], variants = [] } = {}) {
  return {
    async query(sql) {
      if (sql.includes('FROM myfin.storefront_settings')) return { rows: settings ? [settings] : [] };
      if (sql.includes('FROM myfin.storefront_hosts')) return { rows: host ? [{ hostname: host }] : [] };
      if (sql.includes('FROM myfin.shop_locations')) return { rows: locations };
      if (sql.includes('FROM myfin.storefront_delivery_zones')) return { rows: deliveryZones };
      if (sql.includes('FROM myfin.storefront_carousel_slides')) return { rows: slides };
      if (sql.includes('FROM myfin.storefront_products')) return { rows: products };
      if (sql.includes('FROM myfin.storefront_product_variants')) return { rows: variants };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function getStorefront(options) {
  const routes = new Map();
  const app = {
    get(path, handler) { routes.set(path, handler); },
    put() {},
    post() {},
    patch() {},
  };
  const c = client(options);
  registerStorefrontAdmin(app, {
    scoped: (req, fn) => fn(c, req.params.company),
    authOptions: { allowedHosts: [] },
    audit() {},
  });
  return routes.get('/api/companies/:company/storefront')({
    params: { company: 'company-a' },
    identity: { id: 'manager-a', role: 'manager' },
  });
}

function writeFixture(query) {
  const routes = new Map(), calls = [];
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    put(path, handler) { routes.set(`PUT ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    patch(path, handler) { routes.set(`PATCH ${path}`, handler); },
  };
  const c = { async query(sql, params = []) {
    calls.push({ sql, params });
    return query(sql, params, calls);
  } };
  registerStorefrontAdmin(app, {
    scoped: (req, fn) => fn(c, req.params.company),
    authOptions: { allowedHosts: ['*.example.test'] },
    audit() {},
  });
  const request = (body, params = {}) => ({ body,
    params: { company:'company-a', ...params }, identity: { id:'manager-a', role:'manager' } });
  return { routes, calls, request };
}

function successfulWrite(sql) {
  if (sql.includes('pg_advisory_xact_lock')) return { rows:[], rowCount:1 };
  if (sql.includes('SELECT delivery_enabled') && sql.includes('FOR UPDATE'))
    return { rows:[{ delivery_enabled:false }], rowCount:1 };
  if (sql.includes('FROM myfin.customer_order_online_payment_state')) return { rows:[], rowCount:0 };
  if (sql.includes('SELECT 1 FROM myfin.storefront_delivery_zones')) return { rows:[{}], rowCount:1 };
  if (sql.includes('INSERT INTO myfin.storefront_settings')) return { rows:[], rowCount:1 };
  if (sql.includes('UPDATE myfin.storefront_delivery_zones SET')) return { rows:[], rowCount:1 };
  if (sql.includes('SELECT * FROM myfin.storefront_settings')) return { rows:[], rowCount:0 };
  if (sql.includes('FROM myfin.storefront_hosts')) return { rows:[], rowCount:0 };
  if (sql.includes('FROM myfin.shop_locations')) return { rows:[], rowCount:0 };
  if (sql.includes('FROM myfin.storefront_delivery_zones')) return { rows:[], rowCount:0 };
  if (sql.includes('FROM myfin.storefront_carousel_slides')) return { rows:[], rowCount:0 };
  if (sql.includes('FROM myfin.storefront_products')) return { rows:[], rowCount:0 };
  throw new Error(`Unexpected query: ${sql}`);
}

test('storefront admin returns safe defaults before a company has configured a public shop', async () => {
  const result = await getStorefront();
  assert.deepEqual(result, {
    storefront: {
      published: false,
      deliveryEnabled: false,
      hostname: '',
      displayName: '',
      description: '',
      pickupInstructions: '',
      orderExpiryMinutes: 30,
      maxOrderItems: 30,
      maxItemQuantity: 20,
      maxOrderValue: 1000,
      guestContactRetentionDays: 90,
      privacyControllerName: '',
      privacyControllerContact: '',
      privacyNoticeUrl: '',
      privacyNoticeEn: '',
      privacyNoticeMs: '',
      logoUrl: '',
      themePrimaryColor: '#17624d',
      themeAccentColor: '#d7a43b',
      themeBackgroundColor: '#fbfcf8',
      themeTextColor: '#15382c',
      themeFontFamily: 'geist',
      heroEyebrow: 'ORDER ONLINE',
      heroTitle: '',
      heroDescription: '',
      heroImageUrl: '',
      carouselIntervalSeconds: 7,
    },
    slides: [],
    locations: [],
    deliveryZones: [],
    products: [],
  });
});

test('storefront admin maps database privacy columns to the editable form contract', async () => {
  const result = await getStorefront({
    host: 'order-shop.example.test',
    settings: {
      published: false,
      display_name: 'Shop',
      description: 'Menu',
      pickup_instructions: 'Counter',
      order_expiry_minutes: 45,
      max_order_items: 12,
      max_item_quantity: '8.000',
      max_order_value: '250.00',
      guest_data_retention_days: 120,
      privacy_controller_name: 'Example Sdn Bhd',
      privacy_controller_contact: 'privacy@example.test',
      privacy_notice_url: 'https://example.test/privacy',
      privacy_notice_en: 'English notice',
      privacy_notice_ms: 'Notis Bahasa Melayu',
      logo_url: 'https://example.test/logo.png',
      theme_primary_color: '#112233', theme_accent_color: '#445566',
      theme_background_color: '#fefefe', theme_text_color: '#101820', theme_font_family: 'system',
      hero_eyebrow: 'ORDER AHEAD', hero_title: 'Coffee, ready when you are',
      hero_description: 'Skip the queue.', hero_image_url: 'https://example.test/hero.jpg',
      carousel_interval_seconds: 9,
      updated_at: '2026-10-02T00:00:00.000Z',
    },
  });
  assert.deepEqual(result.storefront, {
    published: false,
    deliveryEnabled: false,
    hostname: 'order-shop.example.test',
    displayName: 'Shop',
    description: 'Menu',
    pickupInstructions: 'Counter',
    orderExpiryMinutes: 45,
    maxOrderItems: 12,
    maxItemQuantity: 8,
    maxOrderValue: 250,
    privacyControllerName: 'Example Sdn Bhd',
    privacyControllerContact: 'privacy@example.test',
    privacyNoticeUrl: 'https://example.test/privacy',
    privacyNoticeEn: 'English notice',
    privacyNoticeMs: 'Notis Bahasa Melayu',
    guestContactRetentionDays: 120,
    logoUrl: 'https://example.test/logo.png',
    themePrimaryColor: '#112233', themeAccentColor: '#445566', themeBackgroundColor: '#fefefe',
    themeTextColor: '#101820', themeFontFamily: 'system', heroEyebrow: 'ORDER AHEAD',
    heroTitle: 'Coffee, ready when you are', heroDescription: 'Skip the queue.',
    heroImageUrl: 'https://example.test/hero.jpg', carouselIntervalSeconds: 9,
    updatedAt: '2026-10-02T00:00:00.000Z',
  });
});

test('storefront admin exposes bounded carousel content and exact-sen channel prices', async () => {
  const result = await getStorefront({
    slides: [{ id:'slide-a', published:true, sort_order:2, badge:'WEEKEND', title:'Two for tea',
      description:'Saturday only', image_url:'https://example.test/tea.jpg', background_color:'#123456',
      cta_label:'Order now', cta_url:'/shop?category=Tea', created_at:'created', updated_at:'updated' }],
    products: [{ product_id:'product-a', data:{ name:'Latte' }, store_price:'12.3450',
      online_price_sen:1090, published:true, sold_out:false, sort_order:0, display_name:'', description:'' }],
    variants: [{ product_id:'product-a', variant_id:'large', store_price:'14.9950', online_price_sen:null,
      published:true, sold_out:false, sort_order:0 }],
  });
  assert.deepEqual(result.slides[0], { id:'slide-a', published:true, sortOrder:2, badge:'WEEKEND',
    title:'Two for tea', description:'Saturday only', imageUrl:'https://example.test/tea.jpg',
    backgroundColor:'#123456', ctaLabel:'Order now', ctaUrl:'/shop?category=Tea',
    createdAt:'created', updatedAt:'updated' });
  assert.equal(result.products[0].storePriceSen, 1235);
  assert.equal(result.products[0].onlinePriceSen, 1090);
  assert.equal(result.products[0].variants[0].storePriceSen, 1500);
  assert.equal(result.products[0].variants[0].onlinePriceSen, null);
});

test('storefront admin maps exact-sen delivery zones without exposing actor identifiers', async () => {
  const result = await getStorefront({ deliveryZones: [{ id:'zone-a', name:'Campus', fee_sen:250,
    minimum_order_sen:1500, lead_time_minutes:35, service_instructions:'Meet at the lobby', enabled:true,
    created_at:'2026-10-09T00:00:00Z', updated_at:'2026-10-09T00:00:00Z', updated_by:'secret-actor' }] });
  assert.deepEqual(result.deliveryZones, [{ id:'zone-a', name:'Campus', feeSen:250, minimumOrderSen:1500,
    leadTimeMinutes:35, serviceInstructions:'Meet at the lobby', enabled:true,
    createdAt:'2026-10-09T00:00:00Z', updatedAt:'2026-10-09T00:00:00Z' }]);
  assert.doesNotMatch(JSON.stringify(result), /secret-actor/);
});

test('storefront product writes preserve exact-sen product and variant online overrides', async () => {
  const fixture=writeFixture((sql) => {
    if(sql.includes('SELECT p.data,sp.online_price_sen'))return {rows:[{data:{name:'Latte',variants:[{id:'large'}]},online_price_sen:null}],rowCount:1};
    if(sql.includes('SELECT variant_id,online_price_sen'))return {rows:[],rowCount:0};
    if(sql.includes('INSERT INTO myfin.storefront_products'))return {rows:[],rowCount:1};
    if(sql.includes('DELETE FROM myfin.storefront_product_variants'))return {rows:[],rowCount:1};
    if(sql.includes('INSERT INTO myfin.storefront_product_variants'))return {rows:[],rowCount:1};
    return successfulWrite(sql);
  });
  await fixture.routes.get('PUT /api/companies/:company/storefront/products/:product')(
    fixture.request({published:true,soldOut:false,sortOrder:0,displayName:'',description:'',
      variantIds:['large'],onlinePriceSen:875,variantOverrides:[{variantId:'large',onlinePriceSen:1025}]},
    {product:'latte'}),
  );
  const productInsert=fixture.calls.find(call=>call.sql.includes('INSERT INTO myfin.storefront_products'));
  const variantInsert=fixture.calls.find(call=>call.sql.includes('INSERT INTO myfin.storefront_product_variants'));
  assert.equal(productInsert.params[7],875);
  assert.equal(variantInsert.params[4],1025);
});

test('storefront admin cannot republish an inactive inventory product', async () => {
  const fixture=writeFixture(sql=>{
    if(sql.includes('SELECT p.data,sp.online_price_sen'))return {rows:[{data:{name:'Retired',active:false,variants:[]},online_price_sen:null}],rowCount:1};
    throw new Error(`Unexpected query: ${sql}`);
  });
  const handler=fixture.routes.get('PUT /api/companies/:company/storefront/products/:product');
  await assert.rejects(handler(fixture.request({published:true,soldOut:false,sortOrder:0,
    displayName:'',description:'',variantIds:[],onlinePriceSen:null,variantOverrides:[]},{product:'retired'})),
  error=>error.statusCode===409&&error.message==='product_inactive');
  assert.equal(fixture.calls.some(call=>call.sql.includes('INSERT INTO myfin.storefront_products')),false);
});

test('storefront hostname claims fail before changing the current host when another company owns the name', async () => {
  const fixture = writeFixture((sql) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows:[], rowCount:1 };
    if (sql.includes('SELECT delivery_enabled')) return { rows:[{ delivery_enabled:false }], rowCount:1 };
    if (sql.includes('SELECT hostname FROM myfin.storefront_hosts'))
      return { rows:[{ hostname:'order-old.example.test' }], rowCount:1 };
    if (sql.includes('FROM myfin.customer_order_online_payment_state')) return { rows:[], rowCount:0 };
    if (sql.includes('SELECT company_id FROM myfin.storefront_hosts'))
      return { rows:[{ company_id:'company-b' }], rowCount:1 };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const handler = fixture.routes.get('PUT /api/companies/:company/storefront');
  await assert.rejects(handler(fixture.request({ published:false, hostname:'order-shop.example.test' })),
    error => error.statusCode === 409 && error.message === 'hostname_unavailable');
  assert.equal(fixture.calls.some(call => call.sql.includes('UPDATE myfin.storefront_hosts SET disabled_at')), false);
  assert.equal(fixture.calls.some(call => call.sql.includes('INSERT INTO myfin.storefront_hosts')), false);
  const hostnameLock = fixture.calls.find(call => call.params[0] === 'order-shop.example.test'
    && call.sql.includes('hashtextextended($1,18)'));
  assert.ok(hostnameLock);
});

test('storefront writes reject unreadable theme and promotional colors before database work', async () => {
  const fixture = writeFixture(() => { throw new Error('database must not be reached'); });
  const handler = fixture.routes.get('PUT /api/companies/:company/storefront');
  await assert.rejects(handler(fixture.request({
    published:false, themePrimaryColor:'#eeeeee', themeTextColor:'#fefefe',
    themeBackgroundColor:'#ffffff', slides:[{ title:'Unreadable', backgroundColor:'#f5f5f5' }],
  })), error => error.statusCode === 400 && error.message === 'invalid_input');
  assert.equal(fixture.calls.length,0);
});

test('storefront settings reject a reusable asset owned by another company before mutation', async () => {
  const assetId='a21c72e5-6f42-43c7-a412-d6ed22679ad8';
  const fixture=writeFixture((sql,params)=>{
    if(sql.includes("kind='assets'")&&sql.includes('FOR KEY SHARE')) {
      assert.deepEqual(params,['company-a',[assetId]]);
      return {rows:[],rowCount:0};
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const handler=fixture.routes.get('PUT /api/companies/:company/storefront');
  await assert.rejects(handler(fixture.request({published:false,
    logoUrl:`/api/public/storefront-assets/${assetId}`})),
  error=>error.statusCode===403&&error.message==='invalid_storefront_asset');
  assert.equal(fixture.calls.some(call=>call.sql.includes('INSERT INTO myfin.storefront_settings')),false);
});

test('storefront hostname upsert cannot take ownership after a conditional claim is lost', async () => {
  const fixture = writeFixture((sql) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows:[], rowCount:1 };
    if (sql.includes('SELECT delivery_enabled')) return { rows:[{ delivery_enabled:false }], rowCount:1 };
    if (sql.includes('SELECT hostname FROM myfin.storefront_hosts'))
      return { rows:[{ hostname:'order-old.example.test' }], rowCount:1 };
    if (sql.includes('FROM myfin.customer_order_online_payment_state')) return { rows:[], rowCount:0 };
    if (sql.includes('SELECT company_id FROM myfin.storefront_hosts')) return { rows:[], rowCount:0 };
    if (sql.includes('UPDATE myfin.storefront_hosts SET disabled_at')) return { rows:[], rowCount:1 };
    if (sql.includes('INSERT INTO myfin.storefront_hosts')) return { rows:[], rowCount:0 };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const handler = fixture.routes.get('PUT /api/companies/:company/storefront');
  await assert.rejects(handler(fixture.request({ published:false, hostname:'order-shop.example.test' })),
    error => error.statusCode === 409 && error.message === 'hostname_unavailable');
  const claim = fixture.calls.find(call => call.sql.includes('INSERT INTO myfin.storefront_hosts'));
  assert.match(claim.sql, /ON CONFLICT\(hostname\) DO UPDATE SET disabled_at=NULL/);
  assert.match(claim.sql, /WHERE myfin\.storefront_hosts\.company_id=EXCLUDED\.company_id/);
  assert.match(claim.sql, /RETURNING company_id/);
});

test('storefront hostname changes stop before mutation while an online payment is nonterminal', async () => {
  const fixture = writeFixture((sql) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows:[], rowCount:1 };
    if (sql.includes('SELECT delivery_enabled')) return { rows:[{ delivery_enabled:false }], rowCount:1 };
    if (sql.includes('SELECT hostname FROM myfin.storefront_hosts'))
      return { rows:[{ hostname:'order-old.example.test' }], rowCount:1 };
    if (sql.includes('FROM myfin.customer_order_online_payment_state'))
      return { rows:[{ state:'reconciliation_required' }], rowCount:1 };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const handler = fixture.routes.get('PUT /api/companies/:company/storefront');
  await assert.rejects(handler(fixture.request({ published:false, hostname:'order-new.example.test' })),
    error => error.statusCode === 409 &&
      error.message === 'storefront_hostname_change_blocked_by_online_payment');
  const stateCheck = fixture.calls.find(call =>
    call.sql.includes('FROM myfin.customer_order_online_payment_state'));
  assert.match(stateCheck.sql, /state NOT IN \('failed','finalized'\)/);
  assert.equal(fixture.calls.some(call => call.sql.includes('UPDATE myfin.storefront_hosts SET')),false);
  assert.equal(fixture.calls.some(call => call.sql.includes('INSERT INTO myfin.storefront_hosts')),false);
});

test('storefront hostname guard permits unchanged hosts and changes with only terminal payment intents', async () => {
  const unchanged = writeFixture((sql) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows:[], rowCount:1 };
    if (sql.includes('SELECT delivery_enabled')) return { rows:[{ delivery_enabled:false }], rowCount:1 };
    if (sql.includes('SELECT hostname FROM myfin.storefront_hosts') && sql.includes('FOR UPDATE'))
      return { rows:[{ hostname:'order-shop.example.test' }], rowCount:1 };
    return successfulWrite(sql);
  });
  await unchanged.routes.get('PUT /api/companies/:company/storefront')(
    unchanged.request({ published:false, hostname:'order-shop.example.test' }),
  );
  assert.equal(unchanged.calls.some(call =>
    call.sql.includes('FROM myfin.customer_order_online_payment_state')),false);

  const terminal = writeFixture((sql) => {
    if (sql.includes('SELECT hostname FROM myfin.storefront_hosts') && sql.includes('FOR UPDATE'))
      return { rows:[{ hostname:'order-old.example.test' }], rowCount:1 };
    if (sql.includes('SELECT company_id FROM myfin.storefront_hosts')) return { rows:[], rowCount:0 };
    if (sql.includes('UPDATE myfin.storefront_hosts SET disabled_at')) return { rows:[], rowCount:1 };
    if (sql.includes('INSERT INTO myfin.storefront_hosts'))
      return { rows:[{ company_id:'company-a' }], rowCount:1 };
    return successfulWrite(sql);
  });
  await terminal.routes.get('PUT /api/companies/:company/storefront')(
    terminal.request({ published:false, hostname:'order-new.example.test' }),
  );
  const stateCheck = terminal.calls.find(call =>
    call.sql.includes('FROM myfin.customer_order_online_payment_state'));
  assert.ok(stateCheck, 'terminal states are excluded by the database query');
  assert.match(stateCheck.sql, /state NOT IN \('failed','finalized'\)/);
  assert.equal(terminal.calls.some(call => call.sql.includes('UPDATE myfin.storefront_hosts SET')),true);
});

test('delivery enable and last-zone disable share one company-scoped transaction lock', async () => {
  const settings = writeFixture(successfulWrite);
  await settings.routes.get('PUT /api/companies/:company/storefront')(
    settings.request({ published:false, deliveryEnabled:true }),
  );
  const zone = writeFixture(successfulWrite);
  await zone.routes.get('PATCH /api/companies/:company/storefront/delivery-zones/:id')(
    zone.request({ name:'Campus', feeSen:250, minimumOrderSen:0, leadTimeMinutes:20,
      serviceInstructions:'', enabled:false }, { id:'zone-a' }),
  );
  for (const fixture of [settings, zone]) {
    assert.match(fixture.calls[0].sql, /pg_advisory_xact_lock\(hashtextextended\(\$1,35\)\)/);
    assert.deepEqual(fixture.calls[0].params, ['company-a:storefront-delivery-configuration']);
  }
});

test('a published general shop always retains an active pickup-capable location', async () => {
  const publish = writeFixture((sql) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows:[], rowCount:1 };
    if (sql.includes('SELECT delivery_enabled')) return { rows:[{ delivery_enabled:false }], rowCount:1 };
    if (sql.includes('SELECT company_id FROM myfin.storefront_hosts'))
      return { rows:[{ company_id:'company-a' }], rowCount:1 };
    if (sql.includes('SELECT 1 FROM myfin.storefront_hosts')) return { rows:[{}], rowCount:1 };
    if (sql.includes('FROM myfin.shop_locations') && sql.includes("fulfillment_mode IN ('pickup','both')"))
      return { rows:[], rowCount:0 };
    throw new Error(`Unexpected query: ${sql}`);
  });
  await assert.rejects(publish.routes.get('PUT /api/companies/:company/storefront')(
    publish.request({ published:true, privacyControllerName:'Shop',
      privacyControllerContact:'privacy@example.test',privacyNoticeUrl:'https://example.test/privacy',
      privacyNoticeEn:'How customer data is used.',privacyNoticeMs:'Cara data pelanggan digunakan.' }),
  ), error => error.statusCode === 409 && error.message === 'storefront_pickup_location_required');

  const update = writeFixture((sql) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows:[], rowCount:1 };
    if (sql.includes('SELECT published')) return { rows:[{ published:true }], rowCount:1 };
    if (sql.includes('FROM myfin.shop_locations') && sql.includes('id<>$2')) return { rows:[], rowCount:0 };
    throw new Error(`Unexpected query: ${sql}`);
  });
  await assert.rejects(update.routes.get('PATCH /api/companies/:company/storefront/locations/:id')(
    update.request({ name:'Table 1', fulfillmentMode:'table', tableLabel:'1', pickupInstructions:'', active:true },
      { id:'location-a' }),
  ), error => error.statusCode === 409 && error.message === 'storefront_pickup_location_required');
  assert.equal(update.calls.some(call => call.sql.includes('UPDATE myfin.shop_locations SET')), false);
});
