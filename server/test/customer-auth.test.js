import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  customerCookieDomain, customerCookieHeader, customerOrderDefaults, customerPasswordPolicy,
  customerMarketingChannelState, customerNewLoginIdSchema, customerPhoneSchema, customerRegistrationSchema,
  customerSessionDigest, hashCustomerPassword, verifyCustomerPassword,
} from '../src/customer-auth.js';

test('customer registration requires a distinct Finn3 ID and explicit adult confirmation', () => {
  const details = { loginId:'customer-88', email: 'customer@example.test', password: 'a secure password', displayName: 'Customer', phone: '' };
  assert.throws(() => customerRegistrationSchema.parse(details));
  assert.throws(() => customerRegistrationSchema.parse({ ...details, adultConfirmed: false }));
  assert.equal(customerRegistrationSchema.parse({ ...details, adultConfirmed: true }).adultConfirmed, true);
});

test('new Finn3 IDs are bounded handles rather than unverified email ownership claims', () => {
  for (const value of ['abc','amina-coffee','member_2','member.name'])
    assert.equal(customerNewLoginIdSchema.parse(value), value);
  for (const value of ['ab','A Name','customer@example.test','-customer','customer!'])
    assert.throws(() => customerNewLoginIdSchema.parse(value));
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

test('customer bearer cookies are host-only even below the shared public root', async () => {
  assert.equal(customerCookieDomain('order-bfsb-bali.finn3.com', 'finn3.com'), '');
  assert.equal(customerCookieDomain('order-dev.bayam.live', 'finn3.com'), '');
  assert.equal(customerCookieDomain('notfinn3.com', 'finn3.com'), '');
  assert.equal(customerCookieDomain('order-shop.finn3.com', 'com'), '');
  const shared = customerCookieHeader('opaque-token', 'order-bfsb-bali.finn3.com', 'finn3.com');
  assert.match(shared, /^__Host-myfin_customer_session=/);
  assert.match(shared, /Path=\/;.*HttpOnly; Secure; SameSite=Strict/);
  assert.doesNotMatch(shared, /Domain=/);
  const development = customerCookieHeader('opaque-token', 'order-dev.bayam.live', 'finn3.com');
  assert.match(development, /^__Host-myfin_customer_session=/);
  assert.doesNotMatch(development, /Domain=/);
  assert.match(customerSessionDigest('opaque-token'), /^[a-f0-9]{64}$/);
  assert.notEqual(customerSessionDigest('opaque-token'), 'opaque-token');
  const source = await readFile(new URL('../src/customer-auth.js', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../../db/migrations/0041_customer_identity_security.sql', import.meta.url), 'utf8');
  assert.match(source, /INSERT INTO myfin\.customer_sessions\(token_digest,customer_id,hostname,expires_at\)/);
  assert.match(source, /s\.hostname=\$2/);
  assert.match(migration, /customer_sessions_exact_host/);
  assert.match(migration, /Pre-migration parent-domain sessions remain null and are rejected/);
});

test('marketing grant is effective only for the exact currently verified destination', () => {
  const contact = { email: 'member@example.test', emailVerifiedAt: '2026-10-16T00:00:00Z',
    phone: '+60123456789', phoneVerifiedAt: '2026-10-16T00:00:00Z' };
  const emailEvent = { granted: true, destination: 'member@example.test',
    destination_verified_at: '2026-10-16T00:00:00Z', notice_version: 'v1' };
  assert.deepEqual(customerMarketingChannelState('email', contact, emailEvent), {
    granted: true, recordedGranted: true, canGrant: true, destination: 'member@example.test',
    destinationVerified: true, noticeVersion: 'v1', updatedAt: null,
  });
  assert.equal(customerMarketingChannelState('email', { ...contact, emailVerifiedAt: null }, emailEvent).granted, false);
  assert.equal(customerMarketingChannelState('email', { ...contact, email: 'changed@example.test' }, emailEvent).granted, false);
  assert.deepEqual(customerMarketingChannelState('sms', { ...contact, phoneVerifiedAt: null }, {
    granted: true, destination: '+60123456789', destination_verified_at: '2026-10-16T00:00:00Z',
  }), {
    granted: false, recordedGranted: true, canGrant: false, destination: '+60123456789',
    destinationVerified: false, noticeVersion: '', updatedAt: null,
  });
  assert.equal(customerMarketingChannelState('whatsapp', contact, {
    granted: false, destination: '+60123456789', destination_verified_at: '2026-10-16T00:00:00Z',
  }).granted, false);
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

test('workspace profile updates do not rewrite the global customer identity', async () => {
  const source = await readFile(new URL('../src/customer-auth.js', import.meta.url), 'utf8');
  const profileRoute = source.slice(source.indexOf("app.put('/api/public/customer/profile'"),
    source.indexOf("app.post('/api/public/customer/marketing-consent'"));
  assert.match(profileRoute,/customer_workspace_profiles/);
  assert.doesNotMatch(profileRoute,/UPDATE myfin\.customer_accounts/);
  assert.match(profileRoute,/phone_verified_at=CASE/);
  assert.match(profileRoute,/ELSE NULL END/);
});

test('new consent grants require exact verification evidence while revocation stays available', async () => {
  const source = await readFile(new URL('../src/customer-auth.js', import.meta.url), 'utf8');
  const route = source.slice(source.indexOf("app.post('/api/public/customer/marketing-consent'"));
  const migration = await readFile(new URL('../../db/migrations/0041_customer_identity_security.sql', import.meta.url), 'utf8');
  assert.match(route, /input\.granted && \(!destination \|\| !destinationVerifiedAt\)/);
  assert.match(route, /marketing_destination_unverified/);
  assert.match(route, /destination,destination_verified_at/);
  assert.match(migration, /customer_consent_grant_has_verified_destination/);
  assert.match(migration, /NOT granted OR \(destination IS NOT NULL AND destination_verified_at IS NOT NULL\)/);
  assert.match(migration, /NOT VALID/);
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
  assert.match(authSource, /login_id,display_name,primary_email,adult_confirmed_at/);
  assert.match(authSource, /lower\(a\.login_id\)=\$1/);
  assert.match(authSource, /marketingNoticeVersion = 'myfin-marketing-v1'/);
  assert.doesNotMatch(authSource, /input\.noticeVersion/);
  assert.doesNotMatch(authSource, /myfin\.(auth_user|auth_session|app_identities|memberships)/);
});
