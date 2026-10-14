import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  audienceOutput, campaignOutput, deriveCampaignStatus, marketingAnalyticsOutput,
  marketingAnalyticsRange, registerMarketingCampaigns,
} from '../src/marketing-campaigns.js';

const campaignRow = (overrides = {}) => ({
  id: 'campaign-a', version: '1', lifecycle: 'draft', name: 'Welcome offer',
  description: 'First purchase', objective: 'acquisition', channels: ['pos', 'storefront'],
  starts_at: '2026-10-20T00:00:00.000Z', ends_at: '2026-11-20T00:00:00.000Z',
  budget_sen: '10000', currency_code: 'MYR', offer_kind: 'promotion',
  bonus_points: null, bonus_min_spend_sen: null,
  promotion_links: [{ promotionId: 'promotion-a', promotionVersion: 1 }],
  audience_links: [], created_at: '2026-10-10T00:00:00.000Z',
  updated_at: '2026-10-10T00:00:00.000Z', ...overrides,
});

const campaignBody = (overrides = {}) => ({
  expectedVersion: 0, name: 'Welcome offer', description: 'First purchase',
  objective: 'acquisition', channels: ['pos', 'storefront'],
  startsAt: '2026-10-20T00:00:00.000Z', endsAt: '2026-11-20T00:00:00.000Z',
  budgetSen: 10000, currencyCode: 'MYR', offerKind: 'promotion',
  bonusPoints: null, bonusMinimumSpendSen: null,
  promotionLinks: [{ promotionId: 'promotion-a', promotionVersion: 1 }],
  audienceLinks: [], ...overrides,
});

function register({ role = 'workspace_owner', query } = {}) {
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
  registerMarketingCampaigns(app, {
    scoped: (req, fn) => fn(client, req.params.company),
    audit: async (_c, _who, companyId, action, details) => audits.push({ companyId, action, details }),
  });
  const request = (body = {}, params = {}, queryParams = {}) => ({
    params: { company: 'company-a', ...params }, body, query: queryParams,
    identity: { id: 'staff-a', username: 'Staff', role },
  });
  return { routes, calls, audits, request };
}

test('campaign and audience outputs are stable and lifecycle status is schedule-derived', () => {
  const scheduled = campaignOutput(campaignRow(), '2026-10-15T00:00:00.000Z');
  assert.equal(scheduled.status, 'draft');
  assert.equal(deriveCampaignStatus({ ...scheduled, lifecycle: 'published' }, '2026-10-15T00:00:00.000Z'), 'scheduled');
  assert.equal(deriveCampaignStatus({ ...scheduled, lifecycle: 'published' }, '2026-10-25T00:00:00.000Z'), 'active');
  assert.equal(deriveCampaignStatus({ ...scheduled, lifecycle: 'published' }, '2026-12-01T00:00:00.000Z'), 'completed');
  assert.deepEqual(audienceOutput({
    id: 'audience-a', version: '2', name: 'Repeat guests', description: '', scope: 'company',
    company_id: 'company-a', consent_criteria: { required: true, channels: ['email'] },
    eligibility_criteria: { studentStatus: 'any' }, customer_criteria: { minOrderCount: 2 },
  }).consent, { required: true, channels: ['email'] });
});

test('analytics range and output use integer sen and explicitly reject causal interpretation', () => {
  const range = marketingAnalyticsRange({ from: '2026-10-01', to: '2026-10-10' });
  assert.deepEqual(range, { from: '2026-10-01', to: '2026-10-10', toExclusive: '2026-10-11' });
  assert.throws(() => marketingAnalyticsRange({ from: '2026-10-11', to: '2026-10-10' }),
    error => error.statusCode === 400 && error.message === 'invalid_marketing_range');
  const output = marketingAnalyticsOutput({
    qualified_quotes: '8', conversions: '2', attributed_revenue_sen: '5000', discount_cost_sen: '500',
    unique_customers: '2', voucher_uses: '1', bonus_points_awarded: '25',
    reservations: '3', paid: '2', active_reservations: '1',
  }, campaignOutput(campaignRow()), range);
  assert.equal(output.metrics.conversionRateBasisPoints, 2500);
  assert.equal(output.metrics.averageOrderValueSen, '2500');
  assert.equal(output.metrics.attributedReturnOnSpendBasisPoints, '4500');
  assert.equal(output.metrics.bonusPointsAwarded, 25);
  assert.deepEqual(output.customerCohort, { suppressed: true, cohortThreshold: 5 });
  assert.doesNotMatch(JSON.stringify(output), /"uniqueCustomers":2/);
  assert.equal(output.attribution.causal, false);
  assert.match(output.attribution.limitation, /does not estimate.*causal/i);
  const visible = marketingAnalyticsOutput({ unique_customers: '5' }, campaignOutput(campaignRow()), range);
  assert.deepEqual(visible.customerCohort,
    { suppressed: false, cohortThreshold: 5, uniqueCustomers: 5 });
  const bonusOnly = marketingAnalyticsOutput({ conversions: '3', qualified_quotes: '0' },
    campaignOutput(campaignRow({ offer_kind: 'bonus_points', promotion_links: [], bonus_points: 5 })), range);
  assert.equal(bonusOnly.metrics.qualifiedQuotes, null);
  assert.equal(bonusOnly.metrics.conversionRateBasisPoints, null);
  assert.equal(bonusOnly.metrics.conversions, 3);
});

test('operators are denied marketing reads before any tenant query', async () => {
  const fixture = register({ role: 'operator' });
  await assert.rejects(
    fixture.routes.get('GET /api/companies/:company/marketing')(fixture.request()),
    error => error.statusCode === 403 && error.message === 'access_denied',
  );
  assert.equal(fixture.calls.length, 0);
});

test('manager overview is company bounded and exposes stable definitions and disabled offer choices', async () => {
  const fixture = register({ role: 'manager', query(sql) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('FROM myfin.marketing_campaigns campaign')) return { rows: [campaignRow()], rowCount: 1 };
    if (sql.includes('FROM myfin.marketing_audiences audience')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM myfin.promotions promotion')) return { rows: [{
      id: 'promotion-a', version: '1', name: 'Ten percent', enabled: false,
      redemption_mode: 'automatic', valid_from: '2026-10-20T00:00:00Z', valid_until: null,
      discount_type: 'percentage', discount_basis_points: 1000, discount_sen: null,
      requires_customer: false, requires_student: false,
    }], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  } });
  const result = await fixture.routes.get('GET /api/companies/:company/marketing')(fixture.request());
  assert.equal(result.workspaceId, 'workspace-a');
  assert.equal(result.summary.campaignCount, 1);
  assert.ok(result.definitions.objectives.includes('repeat_purchase'));
  assert.ok(result.definitions.channels.includes('storefront'));
  assert.equal(result.availablePromotions[0].enabled, false);
  assert.equal(result.attribution.causal, false);
  assert.ok(fixture.calls.slice(1).every(call => call.params[0] === 'workspace-a'));
  assert.ok(fixture.calls.slice(1).every(call => call.params[1] === 'company-a'));
  const audienceRead = fixture.calls.find(call => call.sql.includes('FROM myfin.marketing_audiences audience'));
  assert.equal(audienceRead.params[2], false);
  assert.match(audienceRead.sql, /\$3::boolean AND audience\.company_id IS NULL/);
});

test('workspace audiences are visible to owners but excluded from manager reads', async () => {
  for (const [role, includeWorkspace] of [['manager', false], ['workspace_owner', true]]) {
    const fixture = register({ role, query(sql, params) {
      if (sql.startsWith('SELECT workspace_id'))
        return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
      if (sql.includes('FROM myfin.marketing_audiences audience')) {
        assert.deepEqual(params, ['workspace-a', 'company-a', includeWorkspace]);
        return { rows: [{
          id: 'company-audience', version: '1', name: 'Company customers', description: '',
          scope: 'company', company_id: 'company-a', consent_criteria: { required: false, channels: [] },
          eligibility_criteria: { studentStatus: 'any' }, customer_criteria: {},
        }, ...(includeWorkspace ? [{
          id: 'workspace-audience', version: '1', name: 'Workspace customers', description: '',
          scope: 'workspace', company_id: null, consent_criteria: { required: false, channels: [] },
          eligibility_criteria: { studentStatus: 'any' }, customer_criteria: {},
        }] : [])], rowCount: includeWorkspace ? 2 : 1 };
      }
      throw Error(`unexpected query: ${sql}`);
    } });
    const result = await fixture.routes.get('GET /api/companies/:company/marketing/audiences')(
      fixture.request(),
    );
    assert.deepEqual(result.audiences.map(audience => audience.scope),
      includeWorkspace ? ['company', 'workspace'] : ['company']);
  }
});

test('manager can version a company audience but workspace audiences require an owner', async () => {
  const denied = register({ role: 'manager' });
  const create = denied.routes.get('POST /api/companies/:company/marketing/audiences');
  await assert.rejects(create(denied.request({
    expectedVersion: 0, name: 'All workspace customers', description: '', scope: 'workspace',
    consent: { required: true, channels: ['email'] }, eligibility: { studentStatus: 'any' },
    customer: { accountRequired: true, minOrderCount: 0, minSpendSen: 0, minLoyaltyPoints: 0,
      lastPurchaseWithinDays: null, includeCustomerIds: [], excludeCustomerIds: [] },
  })), error => error.statusCode === 403 && error.message === 'workspace_audience_requires_owner');
  assert.equal(denied.calls.length, 0);

  const allowed = register({ role: 'manager', query(sql) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('FROM myfin.marketing_audiences') && sql.includes('FOR UPDATE')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO myfin.marketing_audiences')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.marketing_audience_versions')) return { rows: [], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  } });
  const result = await allowed.routes.get('POST /api/companies/:company/marketing/audiences')(
    allowed.request({
      expectedVersion: 0, name: 'Repeat customers', description: 'At least twice', scope: 'company',
      consent: { required: false, channels: [] }, eligibility: { studentStatus: 'any' },
      customer: { accountRequired: true, minOrderCount: 2, minSpendSen: 0, minLoyaltyPoints: 0,
        lastPurchaseWithinDays: 90, includeCustomerIds: [], excludeCustomerIds: [] },
    }),
  );
  assert.equal(result.scope, 'company');
  assert.equal(result.customer.minOrderCount, 2);
  const versionWrite = allowed.calls.find(call => call.sql.includes('INSERT INTO myfin.marketing_audience_versions'));
  assert.equal(versionWrite.params[6], 'company-a');
  assert.match(versionWrite.params[10], /^[0-9a-f]{64}$/);
});

test('campaign creation stores immutable exact links and requires linked offers to be disabled', async () => {
  const fixture = register({ query(sql) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('FROM jsonb_to_recordset') && sql.includes('JOIN myfin.promotion_versions'))
      return { rows: [{ promotion_id: 'promotion-a', promotion_version: '1', enabled: false }], rowCount: 1 };
    if (sql.includes('FROM myfin.marketing_campaigns campaign') && sql.includes('campaign.id<>'))
      return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT version,lifecycle FROM myfin.marketing_campaigns')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO myfin.marketing_campaigns')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.marketing_campaign_versions')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.marketing_campaign_version_promotions')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.marketing_campaign_events')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM myfin.marketing_campaigns campaign')) return { rows: [campaignRow()], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  } });
  const result = await fixture.routes.get('POST /api/companies/:company/marketing/campaigns')(
    fixture.request(campaignBody()),
  );
  assert.equal(result.version, 1);
  assert.equal(result.offerKind, 'promotion');
  assert.ok(fixture.calls.some(call => call.sql.includes('INSERT INTO myfin.marketing_campaign_versions')));
  assert.ok(fixture.calls.some(call => call.sql.includes('INSERT INTO myfin.marketing_campaign_version_promotions')));
  assert.equal(fixture.audits[0].action, 'Marketing campaign created');

  const enabled = register({ query(sql) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('JOIN myfin.promotion_versions'))
      return { rows: [{ promotion_id: 'promotion-a', promotion_version: '1', enabled: true }], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  } });
  await assert.rejects(
    enabled.routes.get('POST /api/companies/:company/marketing/campaigns')(enabled.request(campaignBody())),
    error => error.statusCode === 409 && error.message === 'campaign_promotion_must_be_disabled',
  );
});

test('publish atomically clones complete promotion rules, advances exact links, and marks campaign published', async () => {
  let finalRead = false;
  const fixture = register({ query(sql) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('FROM myfin.marketing_campaigns campaign') && sql.includes('FOR UPDATE OF campaign'))
      return { rows: [campaignRow()], rowCount: 1 };
    if (sql.includes('FROM myfin.promotions promotion') && sql.includes('FOR UPDATE OF promotion')) return { rows: [{
      current_version: '1', promotion_id: 'promotion-a', version: '1', redemption_mode: 'automatic',
    }], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.promotion_versions')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.promotion_version_')) return { rows: [], rowCount: 1 };
    if (sql.includes('UPDATE myfin.promotions SET version=')) return { rows: [{ id: 'promotion-a' }], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.marketing_campaign_versions')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.marketing_campaign_version_audiences')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.marketing_campaign_version_promotions')) return { rows: [], rowCount: 1 };
    if (sql.includes('UPDATE myfin.marketing_campaigns')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.marketing_campaign_events')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM myfin.marketing_campaigns campaign')) {
      finalRead = true;
      return { rows: [campaignRow({ version: '2', lifecycle: 'published',
        promotion_links: [{ promotionId: 'promotion-a', promotionVersion: 2 }] })], rowCount: 1 };
    }
    throw Error(`unexpected query: ${sql}`);
  } });
  const result = await fixture.routes.get('POST /api/companies/:company/marketing/campaigns/:campaignId/publish')(
    fixture.request({ expectedVersion: 1 }, { campaignId: 'campaign-a' }),
  );
  assert.equal(finalRead, true);
  assert.equal(result.lifecycle, 'published');
  assert.equal(result.version, 2);
  assert.deepEqual(result.promotionLinks, [{ promotionId: 'promotion-a', promotionVersion: 2 }]);
  const clone = fixture.calls.find(call => call.sql.includes('INSERT INTO myfin.promotion_versions'));
  assert.match(clone.sql, /reward_product_id,reward_variant_id,reward_quantity_milli/);
  assert.equal(clone.params[5], true);
  const event = fixture.calls.find(call => call.sql.includes('INSERT INTO myfin.marketing_campaign_events'));
  assert.equal(event.params[4], 'published');
  assert.equal(event.params[6], 'published');
});

test('campaign transitions append event types accepted by the database constraint', async t => {
  for (const { action, from, to, versions } of [
    { action: 'publish', from: 'draft', to: 'published', versions: [1, 2] },
    { action: 'pause', from: 'published', to: 'paused', versions: [1, 2] },
    { action: 'complete', from: 'paused', to: 'completed', versions: [1, 2] },
    { action: 'archive', from: 'completed', to: 'archived', versions: [1, 1] },
  ]) await t.test(action, async () => {
    const fixture = register({ query(sql) {
      if (sql.startsWith('SELECT workspace_id'))
        return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
      if (sql.includes('FROM myfin.marketing_campaigns campaign') && sql.includes('FOR UPDATE OF campaign'))
        return { rows: [campaignRow({
          version: String(versions[0]), lifecycle: from, promotion_links: [],
          ends_at: '2099-11-20T00:00:00.000Z',
        })], rowCount: 1 };
      if (sql.includes('INSERT INTO myfin.marketing_campaign_versions'))
        return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO myfin.marketing_campaign_version_audiences'))
        return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE myfin.marketing_campaigns'))
        return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO myfin.marketing_campaign_events'))
        return { rows: [], rowCount: 1 };
      if (sql.includes('FROM myfin.marketing_campaigns campaign'))
        return { rows: [campaignRow({
          version: String(versions[1]), lifecycle: to, promotion_links: [],
          ends_at: '2099-11-20T00:00:00.000Z',
        })], rowCount: 1 };
      throw Error(`unexpected query: ${sql}`);
    } });

    const result = await fixture.routes.get(
      `POST /api/companies/:company/marketing/campaigns/:campaignId/${action}`,
    )(fixture.request({ expectedVersion: versions[0] }, { campaignId: 'campaign-a' }));

    assert.equal(result.lifecycle, to);
    const event = fixture.calls.find(call => call.sql.includes('INSERT INTO myfin.marketing_campaign_events'));
    assert.deepEqual(event.params.slice(4, 7), [to, from, to]);
  });
});

test('targeted campaign publishes after preserving the exact audience version link', async () => {
  let finalRead = false;
  const fixture = register({ query(sql) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('FROM myfin.marketing_campaigns campaign') && sql.includes('FOR UPDATE OF campaign'))
      return { rows: [campaignRow({
        audience_links: [{ audienceId: 'audience-a', audienceVersion: 1 }],
      })], rowCount: 1 };
    if (sql.includes('FROM myfin.promotions promotion') && sql.includes('FOR UPDATE OF promotion')) return { rows: [{
      current_version: '1', promotion_id: 'promotion-a', version: '1', redemption_mode: 'automatic',
    }], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.promotion_versions')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.promotion_version_')) return { rows: [], rowCount: 1 };
    if (sql.includes('UPDATE myfin.promotions SET version=')) return { rows: [{ id: 'promotion-a' }], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.marketing_campaign_versions')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.marketing_campaign_version_audiences')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.marketing_campaign_version_promotions')) return { rows: [], rowCount: 1 };
    if (sql.includes('UPDATE myfin.marketing_campaigns')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO myfin.marketing_campaign_events')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM myfin.marketing_campaigns campaign')) {
      finalRead = true;
      return { rows: [campaignRow({ version: '2', lifecycle: 'published',
        audience_links: [{ audienceId: 'audience-a', audienceVersion: 1 }],
        promotion_links: [{ promotionId: 'promotion-a', promotionVersion: 2 }] })], rowCount: 1 };
    }
    throw Error(`unexpected query: ${sql}`);
  } });
  const result = await fixture.routes.get('POST /api/companies/:company/marketing/campaigns/:campaignId/publish')(
    fixture.request({ expectedVersion: 1 }, { campaignId: 'campaign-a' }),
  );
  assert.equal(finalRead, true);
  assert.equal(result.lifecycle, 'published');
  assert.deepEqual(result.audienceLinks, [{ audienceId: 'audience-a', audienceVersion: 1 }]);
  const audienceClone = fixture.calls.find(call => call.sql.includes('INSERT INTO myfin.marketing_campaign_version_audiences'));
  assert.deepEqual(audienceClone.params.slice(0, 5), ['workspace-a', 'company-a', 'campaign-a', 1, 2]);
});

test('a campaign without the live storefront channel remains a draft', async () => {
  const fixture = register({ query(sql) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('FROM myfin.marketing_campaigns campaign') && sql.includes('FOR UPDATE OF campaign'))
      return { rows: [campaignRow({ channels: ['pos', 'email'] })], rowCount: 1 };
    throw Error(`unexpected mutation after channel guard: ${sql}`);
  } });
  await assert.rejects(
    fixture.routes.get('POST /api/companies/:company/marketing/campaigns/:campaignId/publish')(
      fixture.request({ expectedVersion: 1 }, { campaignId: 'campaign-a' }),
    ), error => error.statusCode === 409 && error.message === 'campaign_storefront_channel_required',
  );
  assert.equal(fixture.calls.some(call => call.sql.includes('UPDATE myfin.marketing_campaigns')), false);
});

test('campaign analytics SQL is exact-version, tenant, schedule and date bounded', async () => {
  const fixture = register({ role: 'manager', query(sql) {
    if (sql.startsWith('SELECT workspace_id')) return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('FROM myfin.marketing_campaigns campaign')) return { rows: [campaignRow()], rowCount: 1 };
    if (sql.includes('WITH campaign_links')) return { rows: [{
      qualified_quotes: '10', conversions: '4', attributed_revenue_sen: '12000', discount_cost_sen: '1000',
      unique_customers: '3', voucher_uses: '2', bonus_points_awarded: '40', reservations: '5', paid: '4', cancelled: '1',
      active_reservations: '1', consumed_reservations: '4', released_reservations: '0',
    }], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  } });
  const result = await fixture.routes.get('GET /api/companies/:company/marketing/campaigns/:campaignId/analytics')(
    fixture.request({}, { campaignId: 'campaign-a' }, { from: '2026-10-01', to: '2026-10-10' }),
  );
  assert.equal(result.metrics.attributedRevenueSen, '12000');
  assert.equal(result.metrics.conversionRateBasisPoints, 4000);
  assert.equal(result.attribution.causal, false);
  const analytics = fixture.calls.find(call => call.sql.includes('WITH campaign_links'));
  assert.deepEqual(analytics.params, ['workspace-a', 'company-a', 'campaign-a', '2026-10-01', '2026-10-11']);
  assert.match(analytics.sql, /link\.promotion_version=discount\.promotion_version/);
  assert.match(analytics.sql, /snapshot\.priced_at>=link\.starts_at/);
  assert.match(analytics.sql, /redemption\.workspace_id=\$1 AND redemption\.company_id=\$2/);
  assert.match(analytics.sql, /JOIN attributed_sale_ids attributed ON attributed\.sale_id=payment\.sale_id/);
});

test('0029 schema is additive, versioned, immutable and runtime ACLs are least privilege', () => {
  const migration = readFileSync(new URL('../../db/migrations/0029_marketing_campaigns.sql', import.meta.url), 'utf8');
  const dev = readFileSync(new URL('../../db/grant-development-runtime.sql', import.meta.url), 'utf8');
  const prod = readFileSync(new URL('../../db/grant-production-runtime.sql', import.meta.url), 'utf8');
  for (const table of [
    'marketing_audiences', 'marketing_audience_versions', 'marketing_campaigns',
    'marketing_campaign_versions', 'marketing_campaign_version_promotions',
    'marketing_campaign_version_audiences', 'marketing_campaign_events',
  ]) assert.match(migration, new RegExp(`CREATE TABLE myfin\\.${table}`));
  assert.match(migration, /offer_kind IN \('promotion','bonus_points','mixed','none'\)/);
  assert.match(migration, /bonus_min_spend_sen/);
  assert.match(migration, /REFERENCES myfin\.promotion_versions\(workspace_id,company_id,promotion_id,version\)/);
  assert.match(migration, /marketing_history_immutable/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|TRUNCATE TABLE/i);
  for (const grants of [dev, prod]) {
    assert.match(grants, /SELECT,INSERT,UPDATE ON myfin\.marketing_audiences,myfin\.marketing_campaigns/);
    assert.match(grants, /SELECT,INSERT ON myfin\.marketing_audience_versions,myfin\.marketing_campaign_versions/);
    assert.doesNotMatch(grants, /DELETE ON myfin\.marketing_/);
  }
});
