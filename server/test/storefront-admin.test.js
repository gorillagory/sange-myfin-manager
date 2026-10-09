import assert from 'node:assert/strict';
import test from 'node:test';
import { registerStorefrontAdmin } from '../src/storefront-admin.js';

function client({ settings, host = '', locations = [], deliveryZones = [], products = [], variants = [] } = {}) {
  return {
    async query(sql) {
      if (sql.includes('FROM myfin.storefront_settings')) return { rows: settings ? [settings] : [] };
      if (sql.includes('FROM myfin.storefront_hosts')) return { rows: host ? [{ hostname: host }] : [] };
      if (sql.includes('FROM myfin.shop_locations')) return { rows: locations };
      if (sql.includes('FROM myfin.storefront_delivery_zones')) return { rows: deliveryZones };
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
  if (sql.includes('SELECT 1 FROM myfin.storefront_delivery_zones')) return { rows:[{}], rowCount:1 };
  if (sql.includes('INSERT INTO myfin.storefront_settings')) return { rows:[], rowCount:1 };
  if (sql.includes('UPDATE myfin.storefront_delivery_zones SET')) return { rows:[], rowCount:1 };
  if (sql.includes('SELECT * FROM myfin.storefront_settings')) return { rows:[], rowCount:0 };
  if (sql.includes('FROM myfin.storefront_hosts')) return { rows:[], rowCount:0 };
  if (sql.includes('FROM myfin.shop_locations')) return { rows:[], rowCount:0 };
  if (sql.includes('FROM myfin.storefront_delivery_zones')) return { rows:[], rowCount:0 };
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
    },
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
    updatedAt: '2026-10-02T00:00:00.000Z',
  });
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

test('storefront hostname claims fail before changing the current host when another company owns the name', async () => {
  const fixture = writeFixture((sql) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows:[], rowCount:1 };
    if (sql.includes('SELECT delivery_enabled')) return { rows:[{ delivery_enabled:false }], rowCount:1 };
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

test('storefront hostname upsert cannot take ownership after a conditional claim is lost', async () => {
  const fixture = writeFixture((sql) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows:[], rowCount:1 };
    if (sql.includes('SELECT delivery_enabled')) return { rows:[{ delivery_enabled:false }], rowCount:1 };
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
