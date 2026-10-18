import assert from 'node:assert/strict';
import test from 'node:test';
import { voucherLookupDigest } from '../src/student-promotions.js';
import {
  registerStudentPrograms, studentProgramPolicy, studentOutput, voucherOutput,
} from '../src/student-programs.js';

const SECRET = 'test-only-voucher-hmac-secret-32-bytes-minimum';

function register({ role = 'workspace_owner', query, voucherPepper = SECRET } = {}) {
  const routes = new Map(), calls = [], audits = [];
  const client = { async query(sql, params = []) {
    calls.push({ sql, params });
    return query ? query(sql, params, calls) : { rows: [], rowCount: 0 };
  } };
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    put(path, handler) { routes.set(`PUT ${path}`, handler); },
  };
  const scoped = (req, fn) => fn(client, req.params.company);
  const audit = async (_client, _who, companyId, action, details) => {
    audits.push({ companyId, action, details });
  };
  registerStudentPrograms(app, { scoped, audit, voucherPepper });
  const request = (body = {}, params = {}) => ({
    params: { company: 'company-a', ...params }, body, query: {},
    identity: { id: 'staff-a', role },
  });
  return { routes, calls, audits, request };
}

test('safe outputs omit private digests while returning the reusable marketing display code', () => {
  const student = studentOutput({
    customer_id: 'customer-a', account_name: 'Amina', primary_email: 'a@example.test',
    status: 'verified', institution_name: 'Example College', reference_hint: '***1234',
    verification_reference_digest: 'secret-digest', version: '2', valid_until: '2027-01-01T00:00:00Z',
  });
  const voucher = voucherOutput({
    id: 'voucher-a', promotion_id: 'promotion-a', code_hint: '***SAVE', version: '1', enabled: true,
    valid_from: '2026-01-01T00:00:00Z', code_lookup_digest: 'secret-digest',
    display_code: 'STAFF', code: 'SAVE-SECRET', storefront_hostname: 'order-example.test',
  });
  assert.equal(student.referenceHint, '***1234');
  assert.equal(voucher.codeHint, '***SAVE');
  assert.equal(voucher.displayCode, 'STAFF');
  assert.equal(voucher.code, 'STAFF');
  assert.equal(voucher.legacyMasked, false);
  assert.equal(voucher.shareUrl, 'https://order-example.test/shop?promo=STAFF');
  assert.doesNotMatch(JSON.stringify({ student, voucher }), /secret-digest|SAVE-SECRET/);
  assert.deepEqual(studentProgramPolicy(), {
    pricingApplied: true, checkoutIntegration: 'customer_ordering_live', rawDocumentUpload: false,
    rawStudentIdentifierStorage: false, voucherCodesReturned: true,
    legacyVoucherCodesRecoverable: false, loyaltyScope: 'workspace',
  });
});

test('manager list is workspace scoped and returns only safe configured-foundation summaries', async () => {
  const fixture = register({ role: 'manager', query(sql) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('WITH workspace_customers')) return { rows: [{
      customer_id: 'customer-a', account_name: 'Amina', primary_email: 'a@example.test',
      profile_name: 'Amina Student', profile_phone: '0123', status: 'pending',
      institution_name: 'Example College', reference_hint: '***1234', version: '1',
    }], rowCount: 1 };
    if (sql.includes('FROM myfin.promotions p')) return { rows: [{
      id: 'promotion-a', version: '1', name: 'Student 10%', enabled: false,
      redemption_mode: 'automatic', valid_from: '2026-01-01T00:00:00Z', valid_until: null,
      currency_code: 'MYR', discount_type: 'percentage', discount_basis_points: 1000,
      discount_sen: null, max_discount_sen: null, min_subtotal_sen: '0',
      max_total_redemptions: null, per_customer_limit: null, requires_customer: true,
      requires_student: true, stackable: false, priority: 10, product_targets: [],
      category_targets: [], customer_targets: [], redeemed_count: '0',
    }], rowCount: 1 };
    if (sql.includes('FROM myfin.promotion_vouchers voucher')) return { rows: [], rowCount: 0 };
    throw Error(`unexpected query: ${sql}`);
  } });
  const handler = fixture.routes.get('GET /api/companies/:company/student-programs');
  const result = await handler(fixture.request());
  assert.equal(result.workspaceId, 'workspace-a');
  assert.equal(result.students[0].status, 'pending');
  assert.equal(result.promotions[0].applicationState, 'disabled');
  assert.equal(result.policy.pricingApplied, true);
  const sql = fixture.calls.map(call => call.sql).join('\n');
  assert.match(sql, /co\.workspace_id=\$1/);
  assert.match(sql, /\(\$6 OR o\.company_id=\$7\)/);
  assert.match(sql, /wc\.customer_id>\$4/);
  const customerQuery = fixture.calls.find(call => call.sql.includes('WITH workspace_customers'));
  assert.equal(customerQuery.params[3], '');
  assert.equal(customerQuery.params[5], false);
  assert.equal(customerQuery.params[6], 'company-a');
  assert.doesNotMatch(sql, /SELECT[^;]*(verification_reference_digest|code_lookup_digest|request_digest)/i);
});

test('operators are denied student-program access before tenant queries', async () => {
  const fixture = register({ role: 'operator' });
  await assert.rejects(
    fixture.routes.get('GET /api/companies/:company/student-programs')(fixture.request()),
    error => error.statusCode === 403 && error.message === 'access_denied',
  );
  assert.equal(fixture.calls.length, 0);
});

test('workspace-owner verification appends an immutable event in the same scope without storing raw evidence', async () => {
  const fixture = register({ role: 'workspace_owner', query(sql) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('SELECT EXISTS')) return { rows: [{ found: true }], rowCount: 1 };
    if (sql.includes('FROM myfin.student_eligibilities') && sql.includes('FOR UPDATE'))
      return { rows: [{ status: 'pending', version: '1', valid_until: null }], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.student_eligibilities')) return { rows: [{
      customer_id: 'customer-a', status: 'verified', institution_name: 'Example College',
      reference_hint: '***1234', valid_from: '2026-10-09T00:00:00Z',
      valid_until: '2027-10-09T00:00:00Z', version: '2',
    }], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.student_eligibility_events')) return { rows: [], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  } });
  const handler = fixture.routes.get('PUT /api/companies/:company/student-eligibilities/:customerId');
  const result = await handler(fixture.request({
    expectedVersion: 1, status: 'verified', institutionName: 'Example College',
    referenceHint: '***1234', validUntil: '2027-10-09T00:00:00.000Z', reason: 'Seen in person',
  }, { customerId: 'customer-a' }));
  assert.equal(result.status, 'verified');
  assert.doesNotMatch(JSON.stringify(result), /digest|student.?number/i);
  const currentWrite = fixture.calls.find(call => call.sql.includes('INSERT INTO myfin.student_eligibilities'));
  const eventWrite = fixture.calls.find(call => call.sql.includes('INSERT INTO myfin.student_eligibility_events'));
  const visibility = fixture.calls.find(call => call.sql.includes('customer_workspace_profiles'));
  assert.deepEqual(visibility.params, ['workspace-a', 'customer-a']);
  assert.match(currentWrite.params[5], /^[0-9a-f]{64}$/);
  assert.equal(eventWrite.params[10], currentWrite.params[5]);
  assert.equal(eventWrite.params[4], 'verify');
  assert.equal(fixture.audits[0].details.includes(currentWrite.params[5]), false);
  assert.equal(fixture.audits[0].details.includes('***1234'), true);
});

test('managers retain read access but cannot review workspace-wide student eligibility', async () => {
  const fixture = register({ role: 'manager' });
  const handler = fixture.routes.get('PUT /api/companies/:company/student-eligibilities/:customerId');
  await assert.rejects(handler(fixture.request({
    expectedVersion: 0, status: 'pending', institutionName: 'Example College',
    referenceHint: '', validUntil: null, reason: '',
  }, { customerId: 'customer-a' })), error => error.statusCode === 403 && error.message === 'access_denied');
  assert.equal(fixture.calls.length, 0);
});

test('student review rejects raw document and unmasked identifier fields before reading customer data', async () => {
  const fixture = register({ role: 'workspace_owner' });
  const handler = fixture.routes.get('PUT /api/companies/:company/student-eligibilities/:customerId');
  for (const extra of [
    { studentNumber: 'ABC1234' }, { document: 'data:image/png;base64,abc' }, { referenceHint: 'ABC1234' },
  ]) {
    await assert.rejects(handler(fixture.request({
      expectedVersion: 1, status: 'verified', institutionName: 'Example College',
      referenceHint: '***1234', validUntil: '2027-10-09T00:00:00.000Z', ...extra,
    }, { customerId: 'customer-a' })), error => error.statusCode === 400);
  }
  assert.equal(fixture.calls.length, 0);
});

const promotionBody = (overrides = {}) => ({
  expectedVersion: 0, name: 'Student 10%', enabled: false, redemptionMode: 'automatic',
  validFrom: '2026-10-09T00:00:00.000Z', validUntil: '2027-10-09T00:00:00.000Z',
  discountType: 'percentage', discountBasisPoints: 1000, discountSen: null,
  maxDiscountSen: 1000, minSubtotalSen: 500, maxTotalRedemptions: 100,
  perCustomerLimit: 2, requiresCustomer: true, requiresStudent: true, stackable: false,
  priority: 20, productTargets: [], categoryTargets: [{ category: ' Beverages ', subcategory: ' Latte ' }],
  customerTargets: [], ...overrides,
});

test('owners and managers create immutable company offers while operators are denied before database access', async () => {
  const query = sql => {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('SELECT version FROM myfin.promotions')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO myfin.promotions')) return { rows: [{ updated_at: '2026-10-09T00:00:00Z' }], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.promotion_versions')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.promotion_version_categories')) return { rows: [], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  };
  const fixture = register({ query });
  const handler = fixture.routes.get('POST /api/companies/:company/student-promotions');
  const result = await handler(fixture.request(promotionBody()));
  assert.equal(result.version, 1);
  assert.deepEqual(result.categoryTargets, [{ category: 'beverages', subcategory: 'latte' }]);
  assert.equal(result.applicationState, 'disabled');
  assert.ok(fixture.calls.some(call => call.sql.includes('INSERT INTO myfin.promotion_versions')));
  assert.ok(!fixture.calls.some(call => /UPDATE myfin\.promotion_versions/.test(call.sql)));
  const versionWrite = fixture.calls.find(call => call.sql.includes('INSERT INTO myfin.promotion_versions'));
  assert.match(versionWrite.params[23], /^[0-9a-f]{64}$/);

  const manager = register({ role: 'manager', query });
  const managerResult = await manager.routes.get('POST /api/companies/:company/student-promotions')(
    manager.request(promotionBody({ name: 'Manager offer' })),
  );
  assert.equal(managerResult.version, 1);
  assert.ok(manager.calls.some(call => call.sql.includes('INSERT INTO myfin.promotion_versions')));

  const operator = register({ role: 'operator' });
  await assert.rejects(
    operator.routes.get('POST /api/companies/:company/student-promotions')(operator.request(promotionBody())),
    error => error.statusCode === 403 && error.message === 'access_denied',
  );
  assert.equal(operator.calls.length, 0);
});

test('promotion validation rejects inconsistent money, duplicate targets and stale versions', async () => {
  const invalid = register();
  const create = invalid.routes.get('POST /api/companies/:company/student-promotions');
  await assert.rejects(create(invalid.request(promotionBody({ discountType: 'fixed' }))),
    error => error.statusCode === 400);
  await assert.rejects(create(invalid.request(promotionBody({ perCustomerLimit: 2_147_483_648 }))),
    error => error.statusCode === 400);
  assert.equal(invalid.calls.length, 0);

  const duplicate = register({ query(sql) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  } });
  await assert.rejects(duplicate.routes.get('POST /api/companies/:company/student-promotions')(
    duplicate.request(promotionBody({ categoryTargets: [
      { category: 'Beverage', subcategory: '' }, { category: ' beverage ', subcategory: '' },
    ] }))), error => error.statusCode === 400 && error.message === 'duplicate_promotion_category');

  const stale = register({ query(sql) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('SELECT version FROM myfin.promotions')) return { rows: [{ version: '4' }], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  } });
  await assert.rejects(stale.routes.get('PUT /api/companies/:company/student-promotions/:promotionId')(
    stale.request(promotionBody({ expectedVersion: 3 }), { promotionId: 'promotion-a' })),
  error => error.statusCode === 409 && error.message === 'promotion_changed');
});

test('free-item offers require the exact existing variant when the reward product has variants', async () => {
  const freeItem = promotionBody({
    name: 'Free large latte', discountType: 'free_item', discountBasisPoints: null,
    maxDiscountSen: null, rewardProductId: 'latte', rewardVariantId: '',
    rewardQuantityMilli: 1000, categoryTargets: [],
  });
  const missingVariant = register({ query(sql) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('AS has_variants')) return {
      rows: [{ id: 'latte', has_variants: true, reward_variant_exists: false }], rowCount: 1,
    };
    throw Error(`unexpected query: ${sql}`);
  } });
  const create = missingVariant.routes.get('POST /api/companies/:company/student-promotions');
  await assert.rejects(create(missingVariant.request(freeItem)),
    error => error.statusCode === 400 && error.message === 'promotion_reward_variant_required');
  assert.equal(missingVariant.calls.some(call => call.sql.includes('INSERT INTO myfin.promotions')), false);

  const exactVariant = register({ query(sql, params) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('AS has_variants')) {
      assert.equal(params[2], 'large');
      return { rows: [{ id: 'latte', has_variants: true, reward_variant_exists: true }], rowCount: 1 };
    }
    if (sql.includes('SELECT version FROM myfin.promotions')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO myfin.promotions')) return { rows: [{ updated_at: '2026-10-09T00:00:00Z' }], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.promotion_versions')) return { rows: [], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  } });
  const saved = await exactVariant.routes.get('POST /api/companies/:company/student-promotions')(
    exactVariant.request({ ...freeItem, rewardVariantId: 'large' }),
  );
  assert.equal(saved.rewardProductId, 'latte');
  assert.equal(saved.rewardVariantId, 'large');
});

test('voucher creation stores a reusable display code plus HMAC lookup and returns its campaign share link', async () => {
  const fixture = register({ query(sql) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('FROM myfin.promotions p') && sql.includes('FOR UPDATE OF p')) return { rows: [{
      version: '1', redemption_mode: 'voucher', valid_from: '2026-01-01T00:00:00Z', valid_until: null,
    }], rowCount: 1 };
    if (sql.includes('SELECT host.hostname AS storefront_hostname')) return { rows: [{
      storefront_hostname: 'order-example.test', campaign_id: 'campaign-a', campaign_version: '1',
      campaign_name: 'Student week', campaign_channels: ['pos', 'storefront'],
    }], rowCount: 1 };
    if (sql.startsWith('SELECT 1 FROM myfin.promotion_vouchers')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO myfin.promotion_vouchers(')) return { rows: [{
      updated_at: '2026-10-09T00:00:00Z',
    }], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.promotion_voucher_versions')) return { rows: [], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  } });
  const handler = fixture.routes.get('POST /api/companies/:company/student-promotions/:promotionId/vouchers');
  const result = await handler(fixture.request({
    expectedVersion: 0, code: 'STUDENT-2026', enabled: false,
    validFrom: '2026-10-09T00:00:00.000Z', validUntil: '2027-10-09T00:00:00.000Z',
    maxRedemptions: 100, perCustomerLimit: 1,
  }, { promotionId: 'promotion-a' }));
  assert.equal(result.codeHint, '***2026');
  assert.equal(result.displayCode, 'STUDENT-2026');
  assert.equal(result.code, 'STUDENT-2026');
  assert.equal(result.campaignId, 'campaign-a');
  assert.equal(result.shareUrl,
    'https://order-example.test/shop?promo=STUDENT-2026&campaign=campaign-a');
  assert.equal(result.applicationState, undefined);
  assert.doesNotMatch(JSON.stringify({ result, audit: fixture.audits }), /[a-f0-9]{64}/);
  const duplicateLookup = fixture.calls.find(call => call.sql.startsWith('SELECT 1 FROM myfin.promotion_vouchers'));
  assert.equal(duplicateLookup.params[1], voucherLookupDigest(SECRET, 'STUDENT-2026'));
  const stored = fixture.calls.find(call => call.sql.includes('INSERT INTO myfin.promotion_vouchers('));
  assert.equal(stored.params[4], duplicateLookup.params[1]);
  assert.equal(stored.params[5], 'STUDENT-2026');
  assert.match(stored.sql, /display_code/);
  const version = fixture.calls.find(call => call.sql.includes('INSERT INTO myfin.promotion_voucher_versions'));
  assert.equal(version.params[10], 'campaign-a');
  assert.match(version.sql, /campaign_id/);
});

test('code creation rejects ambiguous campaign inference and honors an explicit campaign selection', async () => {
  const body = {
    expectedVersion: 0, code: 'STAFF', enabled: true,
    validFrom: '2026-10-09T00:00:00.000Z', validUntil: null,
    maxRedemptions: null, perCustomerLimit: null,
  };
  const query = ({ explicit = false } = {}) => (sql, params) => {
    if (sql.startsWith('SELECT workspace_id'))
      return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('FROM myfin.promotions p') && sql.includes('FOR UPDATE OF p')) return { rows: [{
      version: '1', redemption_mode: 'voucher', valid_from: '2026-01-01T00:00:00Z', valid_until: null,
    }], rowCount: 1 };
    if (sql.includes('SELECT host.hostname AS storefront_hostname')) {
      if (!explicit) return { rows: [
        { campaign_id:'campaign-a', campaign_version:'1', campaign_name:'A', campaign_channels:['pos'] },
        { campaign_id:'campaign-b', campaign_version:'1', campaign_name:'B', campaign_channels:['storefront'] },
      ], rowCount: 2 };
      assert.equal(params[3], 'campaign-b');
      return { rows: [{ storefront_hostname:'order-example.test', campaign_id:'campaign-b',
        campaign_version:'1', campaign_name:'B', campaign_channels:['storefront'] }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT 1 FROM myfin.promotion_vouchers')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO myfin.promotion_vouchers('))
      return { rows: [{ updated_at:'2026-10-09T00:00:00Z' }], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.promotion_voucher_versions')) return { rows: [], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  };

  const ambiguous = register({ query:query() });
  const path = 'POST /api/companies/:company/marketing/promotions/:promotionId/codes';
  await assert.rejects(ambiguous.routes.get(path)(ambiguous.request(body, { promotionId:'promotion-a' })),
    error => error.statusCode === 409 && error.message === 'voucher_campaign_ambiguous');
  assert.equal(ambiguous.calls.some(call => call.sql.includes('INSERT INTO myfin.promotion_vouchers(')), false);

  const selected = register({ query:query({ explicit:true }) });
  const result = await selected.routes.get(path)(selected.request(
    { ...body, campaignId:'campaign-b' }, { promotionId:'promotion-a' },
  ));
  assert.equal(result.campaignId, 'campaign-b');
  assert.equal(result.shareUrl, 'https://order-example.test/shop?promo=STAFF&campaign=campaign-b');
  const savedVersion = selected.calls.find(call => call.sql.includes('INSERT INTO myfin.promotion_voucher_versions'));
  assert.equal(savedVersion.params[10], 'campaign-b');
});

test('legacy masked codes rotate atomically into a reusable campaign code', async () => {
  const fixture = register({ query(sql) {
    if (sql.startsWith('SELECT workspace_id'))
      return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('FROM myfin.promotions p') && sql.includes('FOR UPDATE OF p')) return { rows: [{
      version: '2', redemption_mode: 'voucher', valid_from: '2026-01-01T00:00:00Z', valid_until: null,
    }], rowCount: 1 };
    if (sql.startsWith('SELECT voucher.version,current_version.enabled')) return { rows: [{
      version:'1', enabled:true, valid_from:'2026-01-01T00:00:00.000Z', valid_until:null,
      max_redemptions:'100', per_customer_limit:'1', campaign_id:'campaign-a',
    }], rowCount: 1 };
    if (sql.startsWith('SELECT voucher.version,voucher.display_code')) return { rows: [{
      version:'1', display_code:null, code_hint:'***2024', campaign_id:'campaign-a', redeemed_count:'2',
    }], rowCount: 1 };
    if (sql.includes('SELECT host.hostname AS storefront_hostname')) return { rows: [{
      storefront_hostname:'order-example.test', campaign_id:'campaign-a', campaign_version:'3',
      campaign_name:'Student return', campaign_channels:['pos','storefront'],
    }], rowCount: 1 };
    if (sql.startsWith('UPDATE myfin.promotion_vouchers SET version='))
      return { rows:[{ updated_at:'2026-10-19T00:00:00Z' }], rowCount:1 };
    if (sql.startsWith('SELECT 1 FROM myfin.promotion_vouchers')) return { rows:[], rowCount:0 };
    if (sql.includes('INSERT INTO myfin.promotion_vouchers('))
      return { rows:[{ updated_at:'2026-10-19T00:00:00Z' }], rowCount:1 };
    if (sql.includes('INSERT INTO myfin.promotion_voucher_versions')) return { rows:[], rowCount:1 };
    throw Error(`unexpected query: ${sql}`);
  } });
  const result = await fixture.routes.get(
    'POST /api/companies/:company/marketing/promotions/:promotionId/codes/:voucherId/rotate',
  )(fixture.request({ expectedVersion:1, code:'STUDENT' }, {
    promotionId:'promotion-a', voucherId:'legacy-voucher',
  }));
  assert.equal(result.replacedVoucherId, 'legacy-voucher');
  assert.equal(result.previous.enabled, false);
  assert.equal(result.previous.legacyMasked, true);
  assert.equal(result.voucher.displayCode, 'STUDENT');
  assert.equal(result.voucher.campaignId, 'campaign-a');
  assert.equal(result.voucher.shareUrl,
    'https://order-example.test/shop?promo=STUDENT&campaign=campaign-a');
  const writes = fixture.calls.filter(call => call.sql.includes('INSERT INTO myfin.promotion_voucher_versions'));
  assert.equal(writes.length, 2);
  assert.equal(writes[0].params[5], false);
  assert.equal(writes[1].params[10], 'campaign-a');
  const promotionLock = fixture.calls.findIndex(call =>
    call.sql.includes('FROM myfin.promotions p') && call.sql.includes('FOR UPDATE OF p'));
  const voucherLock = fixture.calls.findIndex(call =>
    call.sql.startsWith('SELECT voucher.version,current_version.enabled'));
  assert.ok(promotionLock > -1 && promotionLock < voucherLock);
});

test('voucher routes fail closed without a protected HMAC secret and reject code replacement', async () => {
  const unavailable = register({ voucherPepper: '' });
  await assert.rejects(
    unavailable.routes.get('POST /api/companies/:company/student-promotions/:promotionId/vouchers')(
      unavailable.request({ expectedVersion: 0, code: 'STUDENT-2026', enabled: false,
        validFrom: '2026-10-09T00:00:00.000Z', validUntil: null,
        maxRedemptions: null, perCustomerLimit: null }, { promotionId: 'promotion-a' })),
    error => error.statusCode === 503 && error.message === 'voucher_secret_unavailable',
  );
  assert.equal(unavailable.calls.length, 0);

  const update = register({ query(sql) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  } });
  await assert.rejects(
    update.routes.get('PUT /api/companies/:company/student-promotions/:promotionId/vouchers/:voucherId')(
      update.request({ expectedVersion: 1, code: 'REPLACE-ME', enabled: false,
        validFrom: '2026-10-09T00:00:00.000Z', validUntil: null,
        maxRedemptions: null, perCustomerLimit: null }, { promotionId: 'promotion-a', voucherId: 'voucher-a' })),
    error => error.statusCode === 400,
  );
});
