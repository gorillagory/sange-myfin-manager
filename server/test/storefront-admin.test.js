import assert from 'node:assert/strict';
import test from 'node:test';
import { registerStorefrontAdmin } from '../src/storefront-admin.js';

function client({ settings, host = '', locations = [], products = [], variants = [] } = {}) {
  return {
    async query(sql) {
      if (sql.includes('FROM myfin.storefront_settings')) return { rows: settings ? [settings] : [] };
      if (sql.includes('FROM myfin.storefront_hosts')) return { rows: host ? [{ hostname: host }] : [] };
      if (sql.includes('FROM myfin.shop_locations')) return { rows: locations };
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

test('storefront admin returns safe defaults before a company has configured a public shop', async () => {
  const result = await getStorefront();
  assert.deepEqual(result, {
    storefront: {
      published: false,
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
