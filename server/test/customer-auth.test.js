import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  customerCookieDomain, customerCookieHeader, customerOrderDefaults, customerPasswordPolicy,
  customerPhoneSchema, customerRegistrationSchema,
  customerSessionDigest, hashCustomerPassword, verifyCustomerPassword,
} from '../src/customer-auth.js';

test('customer registration requires an explicit adult confirmation', () => {
  const details = { email: 'customer@example.test', password: 'a secure password', displayName: 'Customer', phone: '' };
  assert.throws(() => customerRegistrationSchema.parse(details));
  assert.throws(() => customerRegistrationSchema.parse({ ...details, adultConfirmed: false }));
  assert.equal(customerRegistrationSchema.parse({ ...details, adultConfirmed: true }).adultConfirmed, true);
});

test('customer phone numbers use the same narrow optional syntax for accounts and orders', () => {
  for (const value of ['', '+60 12-345 6789', '(03) 1234-5678', '01234567'])
    assert.equal(customerPhoneSchema.parse(value), value);
  for (const value of ['123456', 'call-me-now', '+60.12.345.678', '0123456789012345678901234'])
    assert.throws(() => customerPhoneSchema.parse(value));
});

test('customer passwords use randomized bounded scrypt verifiers', async () => {
  const password = 'correct horse battery staple';
  const first = await hashCustomerPassword(password);
  const second = await hashCustomerPassword(password);
  assert.match(first, /^scrypt\$65536\$8\$1\$/);
  assert.notEqual(first, second);
  assert.equal(await verifyCustomerPassword(password, first), true);
  assert.equal(await verifyCustomerPassword('wrong customer password', first), false);
  assert.equal(await verifyCustomerPassword(password, 'malformed'), false);
  assert.doesNotMatch(first, /correct|horse|battery|staple/);
  assert.deepEqual(customerPasswordPolicy, { N: 65536, r: 8, p: 1,
    maxConcurrentKdfs: 2, maxQueuedKdfs: 8 });
  assert.equal(customerPasswordPolicy.N * customerPasswordPolicy.r * 128 *
    customerPasswordPolicy.maxConcurrentKdfs <= 128 * 1024 * 1024, true);
});

test('customer cookie is shared only below the configured matching root', () => {
  assert.equal(customerCookieDomain('order-bfsb-bali.finn3.com', 'finn3.com'), 'finn3.com');
  assert.equal(customerCookieDomain('order-dev.bayam.live', 'finn3.com'), '');
  assert.equal(customerCookieDomain('notfinn3.com', 'finn3.com'), '');
  assert.equal(customerCookieDomain('order-shop.finn3.com', 'com'), '');
  const shared = customerCookieHeader('opaque-token', 'order-bfsb-bali.finn3.com', 'finn3.com');
  assert.match(shared, /^__Secure-myfin_customer_session=/);
  assert.match(shared, /HttpOnly; Secure; SameSite=Lax/);
  assert.match(shared, /Domain=finn3\.com/);
  const development = customerCookieHeader('opaque-token', 'order-dev.bayam.live', 'finn3.com');
  assert.match(development, /^__Host-myfin_customer_session=/);
  assert.doesNotMatch(development, /Domain=/);
  assert.match(customerSessionDigest('opaque-token'), /^[a-f0-9]{64}$/);
  assert.notEqual(customerSessionDigest('opaque-token'), 'opaque-token');
});

test('workspace profile defaults do not infer account ownership from contact fields', async () => {
  const c = { query: async () => ({ rows: [{ display_name: 'Workspace name', phone: '0123' }] }) };
  const value = await customerOrderDefaults(c, 'workspace-a', {
    customerId: 'customer-a', displayName: 'Global name', email: 'customer@example.com',
  });
  assert.deepEqual(value, { customerId: 'customer-a', name: 'Workspace name',
    email: 'customer@example.com', phone: '0123' });
  assert.deepEqual(await customerOrderDefaults(c, 'workspace-a', null),
    { customerId: null, name: '', email: '', phone: '' });
});

test('migration and order submission keep customer auth separate and attach only session identity', async () => {
  const migration = await readFile(new URL('../../db/migrations/0018_customer_ordering.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE myfin\.customer_credentials/);
  assert.match(migration, /CREATE TABLE myfin\.customer_sessions/);
  assert.match(migration, /customer_id text NOT NULL REFERENCES myfin\.customer_accounts/);
  assert.match(migration, /adult_confirmed_at timestamptz NOT NULL/);
  const source = await readFile(new URL('../src/storefront-public.js', import.meta.url), 'utf8');
  const authSource = await readFile(new URL('../src/customer-auth.js', import.meta.url), 'utf8');
  assert.match(source, /customer\?\.customerId \|\| null/);
  assert.match(source, /o\.customer_id=\$4/);
  assert.match(source, /actor_type,customer_actor_id/);
  assert.doesNotMatch(source, /customer_id[^\n]*guest\.email/);
  assert.match(authSource, /urn:myfin:customer:local/);
  assert.match(authSource, /adult_confirmed_at\)\s+VALUES\(\$1,\$2,\$3,now\(\)\)/);
  assert.match(authSource, /marketingNoticeVersion = 'myfin-marketing-v1'/);
  assert.doesNotMatch(authSource, /input\.noticeVersion/);
  assert.doesNotMatch(authSource, /myfin\.(auth_user|auth_session|app_identities|memberships)/);
});
