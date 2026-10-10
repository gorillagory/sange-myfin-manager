import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  audienceMatchesCustomer, awardLoyaltyPointsForSale, filterCampaignEligiblePromotions,
  loyaltyPointsForSpend, loyaltySettingsOutput, registerMarketingLoyalty,
  releaseExpiredLoyaltyReservations, releaseLoyaltyPointsReservation, reserveLoyaltyPoints,
  saveMarketingLoyaltySettings,
} from '../src/marketing-loyalty.js';
import { priceWithPromotions } from '../src/student-promotions.js';

const AT = '2026-10-10T04:00:00.000Z';
const settingsRow = (patch = {}) => ({
  version: '1', enabled: true, unit_label: 'beans', earn_mode: 'per_order',
  points_per_order: '2', spend_step_sen: '500', points_per_spend_step: '3',
  minimum_spend_sen: '100', redemption_threshold_points: '20', ...patch,
});

test('loyalty settings expose integer points and both earn modes use integer sen', () => {
  const perOrder = loyaltySettingsOutput(settingsRow());
  assert.equal(loyaltyPointsForSpend(perOrder, 99), 0);
  assert.equal(loyaltyPointsForSpend(perOrder, 100), 2);
  const spendStep = loyaltySettingsOutput(settingsRow({ earn_mode: 'spend_step' }));
  assert.equal(loyaltyPointsForSpend(spendStep, 1499), 6);
  assert.equal(loyaltyPointsForSpend({ ...spendStep, enabled: false }, 5000), 0);
  assert.throws(() => loyaltyPointsForSpend(spendStep, 1.5), /invalid_loyalty_amount/);
});

test('saving points settings keeps the legacy stamps-per-order projection in sync', async () => {
  const calls = [];
  const c = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM myfin.companies'))
      return { rows: [{ id: 'company-a', workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('FROM myfin.workspace_loyalty_settings'))
      return { rows: [settingsRow()], rowCount: 1 };
    if (sql.startsWith('INSERT INTO myfin.workspace_loyalty_setting_versions'))
      return { rows: [], rowCount: 1 };
    if (sql.startsWith('UPDATE myfin.workspace_loyalty_settings'))
      return { rows: [settingsRow({ version: '2', points_per_order: '7' })], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  } };
  const result = await saveMarketingLoyaltySettings(c, 'company-a', { id: 'owner-a' }, {
    expectedVersion: 1, enabled: true, unitLabel: 'beans', earnMode: 'per_order',
    pointsPerOrder: 7, spendStepSen: 500, pointsPerSpendStep: 3,
    minimumSpendSen: 100, redemptionThresholdPoints: 20,
  });
  assert.equal(result.pointsPerOrder, 7);
  const compatibilityWrite = calls.find(call => call.sql.startsWith('UPDATE myfin.workspace_loyalty_settings'));
  assert.match(compatibilityWrite.sql, /stamps_per_order=\$9/);
  assert.equal(compatibilityWrite.params[8], 7);
});

const offer = patch => ({
  id: 'reward-a', version: 1, name: 'Free latte', enabled: true,
  redemptionMode: 'automatic', validFrom: '2026-01-01T00:00:00.000Z', validUntil: null,
  discountType: 'free_item', discountBasisPoints: null, discountSen: null, maxDiscountSen: null,
  rewardProductId: 'latte', rewardVariantId: 'large', rewardQuantityMilli: 1000,
  minSubtotalSen: 0, maxTotalRedemptions: null, perCustomerLimit: null,
  requiresCustomer: false, requiresStudent: false, priority: 10, stackable: true,
  productTargets: [], categoryTargets: [], customerTargets: [],
  usage: { total: 0, customer: 0 }, voucher: null, ...patch,
});

const line = (patch = {}) => ({
  lineNo: 1, productId: 'latte', variantId: 'large', category: 'Beverage',
  subcategory: 'Coffee', description: 'Large latte', quantityMilli: 2000, unitPriceSen: 750, ...patch,
});

test('free-item rewards require the exact reward line and cap a 100 percent discount to configured quantity', () => {
  const result = priceWithPromotions({ at: AT, cashRounding: false,
    lines: [line()], promotions: [offer()] });
  assert.equal(result.subtotalSen, 1500);
  assert.equal(result.discountSen, 750);
  assert.deepEqual(result.applications[0].lineDiscounts, [{ lineNo: 1, discountSen: 750 }]);
  assert.equal(result.lines[0].quantityMilli, 2000);

  assert.equal(priceWithPromotions({ at: AT, cashRounding: false,
    lines: [line({ variantId: 'small' })], promotions: [offer()] }).discountSen, 0);
  assert.equal(priceWithPromotions({ at: AT, cashRounding: false,
    lines: [line({ productId: 'tea' })], promotions: [offer()] }).discountSen, 0);
});

test('a free-item reward discounts only the still-payable reward amount after an earlier stacked offer', () => {
  const percentage = {
    ...offer({ id: 'first', name: 'Half off', discountType: 'percentage',
      discountBasisPoints: 5000, rewardProductId: '', rewardVariantId: '', rewardQuantityMilli: null,
      priority: 20 }),
  };
  const result = priceWithPromotions({ at: AT, cashRounding: false,
    lines: [line({ quantityMilli: 1000 })], promotions: [percentage, offer()] });
  assert.deepEqual(result.applications.map(item => [item.promotionId, item.discountSen]),
    [['first', 375], ['reward-a', 375]]);
  assert.equal(result.totalSen, 0);
});

const eligibleCustomer = (patch = {}) => ({
  id: 'customer-a', hasAccount: true, consents: new Set(['email', 'whatsapp']),
  studentVerified: true, loyaltyPoints: 25,
  workspace: { orderCount: 5, spendSen: 10000, lastPurchaseAt: '2026-10-01T00:00:00.000Z' },
  company: { orderCount: 3, spendSen: 6000, lastPurchaseAt: '2026-10-05T00:00:00.000Z' },
  ...patch,
});
const audience = (patch = {}) => ({
  scope: 'company', consent: { required: true, channels: ['email'] },
  eligibility: { studentStatus: 'verified' }, customer: {
    accountRequired: true, minOrderCount: 2, minSpendSen: 5000, minLoyaltyPoints: 20,
    lastPurchaseWithinDays: 30, includeCustomerIds: ['customer-a'], excludeCustomerIds: [],
  }, ...patch,
});

test('audience evaluation enforces consent, account, student, history, loyalty, recency and exact inclusions', () => {
  assert.equal(audienceMatchesCustomer(audience(), eligibleCustomer(), AT), true);
  assert.equal(audienceMatchesCustomer(audience(), eligibleCustomer({ hasAccount: false }), AT), false);
  assert.equal(audienceMatchesCustomer(audience(), eligibleCustomer({ consents: new Set() }), AT), false);
  assert.equal(audienceMatchesCustomer(audience(), eligibleCustomer({ studentVerified: false }), AT), false);
  assert.equal(audienceMatchesCustomer(audience(), eligibleCustomer({ loyaltyPoints: 19 }), AT), false);
  assert.equal(audienceMatchesCustomer(audience(), eligibleCustomer({
    company: { orderCount: 1, spendSen: 6000, lastPurchaseAt: '2026-10-05T00:00:00.000Z' },
  }), AT), false);
  assert.equal(audienceMatchesCustomer(audience({ customer: {
    ...audience().customer, excludeCustomerIds: ['customer-a'],
  } }), eligibleCustomer(), AT), false);
  assert.equal(audienceMatchesCustomer(audience({ customer: {
    ...audience().customer, lastPurchaseWithinDays: 2,
  } }), eligibleCustomer(), AT), false);
});

test('campaign-linked pricing excludes guests and mismatched audiences while legacy offers remain eligible', async () => {
  const active = { campaignId: 'campaign-a', campaignVersion: 2, currentVersion: 2,
    lifecycle: 'published', startsAt: '2026-10-01T00:00:00.000Z', endsAt: null,
    channels: ['storefront'] };
  const promotions = [
    { id: 'legacy', campaignLinks: [] },
    { id: 'public-campaign', campaignLinks: [{ ...active, audiences: [] }] },
    { id: 'targeted', campaignLinks: [{ ...active, audiences: [audience()] }] },
    { id: 'pos-only', campaignLinks: [{ ...active, channels: ['pos'], audiences: [] }] },
    { id: 'paused', campaignLinks: [{ ...active, lifecycle: 'paused', audiences: [] }] },
  ];
  const noQueries = { query: async () => { throw Error('guest evaluation must not query a profile'); } };
  assert.deepEqual((await filterCampaignEligiblePromotions(noQueries, promotions, {
    workspaceId: 'workspace-a', companyId: 'company-a', customerId: '', at: AT,
  })).map(item => item.id), ['legacy', 'public-campaign']);

  const c = { query: async sql => {
    if (sql.includes('FROM myfin.customer_order_requests orders')) return { rows: [{
      workspace_order_count: '5', workspace_spend_sen: '10000', workspace_last_purchase_at: '2026-10-01T00:00:00Z',
      company_order_count: '3', company_spend_sen: '6000', company_last_purchase_at: '2026-10-05T00:00:00Z',
    }] };
    if (sql.includes('FROM myfin.customer_consent_events')) return { rows: [{ channel: 'email', granted: true }] };
    if (sql.includes('FROM myfin.student_eligibilities')) return { rows: [{
      status: 'verified', valid_from: '2026-01-01T00:00:00Z', valid_until: '2027-01-01T00:00:00Z',
    }] };
    if (sql.includes('FROM myfin.customer_loyalty_accounts')) return { rows: [{ stamp_balance: '25' }] };
    throw Error(`unexpected query: ${sql}`);
  } };
  assert.deepEqual((await filterCampaignEligiblePromotions(c, promotions, {
    workspaceId: 'workspace-a', companyId: 'company-a', customerId: 'customer-a', at: AT,
  })).map(item => item.id), ['legacy', 'public-campaign', 'targeted']);
});

function awardFixture() {
  const state = {
    account: { workspace_id: 'workspace-a', customer_id: 'customer-a', stamp_balance: 0,
      reserved_points: 0, version: 1 },
    currentSettings: settingsRow(), settingsVersions: new Map([[1, settingsRow()]]),
    events: [], campaigns: [], batch: null, accountUpdates: 0, waiters: [], saleLocked: false,
  };
  const releaseSale = () => { state.saleLocked = false; state.waiters.shift()?.(); };
  const client = () => ({ query: async (sql, params = []) => {
    if (sql.includes("hashtextextended($1,30)") && String(params[0]).includes(':loyalty-sale:')) {
      while (state.saleLocked) await new Promise(resolve => state.waiters.push(resolve));
      state.saleLocked = true;
      return { rows: [{}], rowCount: 1 };
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('FROM myfin.companies')) return { rows: [{ id: 'company-a', workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('FROM myfin.customer_order_requests') && sql.includes('JOIN myfin.customer_order_payments')) {
      const exactSource = params[1] === 'order-a' && params[2] === 'sale-a';
      return exactSource ? { rows: [{ customer_id: 'customer-a', status: 'paid', payment_state: 'paid',
        order_total_sen: '1000', sale_total_sen: '1000' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM myfin.loyalty_sale_award_batches')) {
      const result = { rows: state.batch ? [state.batch] : [], rowCount: state.batch ? 1 : 0 };
      // The real advisory lock is transaction scoped. A replay is read-only,
      // so the fake transaction can release as soon as it sees the batch.
      if (state.batch && state.saleLocked) releaseSale();
      return result;
    }
    if (sql.includes("kind IN ('earn','bonus')")) {
      if (!state.batch && state.events.length && state.saleLocked) releaseSale();
      return { rows: state.events, rowCount: state.events.length };
    }
    if (sql.includes('FROM myfin.workspace_loyalty_setting_versions')) {
      const row = state.settingsVersions.get(Number(params[1]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM myfin.workspace_loyalty_settings'))
      return { rows: [state.currentSettings], rowCount: 1 };
    if (sql.includes('FROM myfin.customer_order_requests orders')) return { rows: [{
      workspace_order_count: '0', workspace_spend_sen: '0', workspace_last_purchase_at: null,
      company_order_count: '0', company_spend_sen: '0', company_last_purchase_at: null,
    }], rowCount: 1 };
    if (sql.includes('FROM myfin.customer_consent_events')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM myfin.student_eligibilities')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT stamp_balance FROM myfin.customer_loyalty_accounts'))
      return { rows: [{ stamp_balance: state.account.stamp_balance }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO myfin.customer_loyalty_accounts')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT * FROM myfin.customer_loyalty_accounts'))
      return { rows: [{ ...state.account }], rowCount: 1 };
    if (sql.startsWith('UPDATE myfin.customer_loyalty_accounts')) {
      state.account = { ...state.account, stamp_balance: params[2], reserved_points: params[3],
        version: state.account.version + 1 };
      state.accountUpdates += 1;
      return { rows: [{ ...state.account }], rowCount: 1 };
    }
    if (sql.includes('FROM myfin.loyalty_point_events') && sql.includes('idempotency_key')) {
      const row = state.events.find(event => event.idempotency_key === params[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('INSERT INTO myfin.customer_loyalty_events')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('INSERT INTO myfin.loyalty_point_events')) {
      const row = {
        workspace_id: params[0], company_id: params[1], id: params[2], customer_id: params[3],
        kind: params[4], points: params[5], balance_after: params[6], reserved_after: params[7],
        source_sale_id: params[8], source_order_id: params[9], campaign_id: params[10],
        campaign_version: params[11], promotion_id: params[12], promotion_version: params[13],
        program_id: params[14], program_version: params[15], reverses_event_id: params[16],
        actor_type: params[17], staff_actor_id: params[18], customer_actor_id: params[19],
        reason: params[20], idempotency_key: params[21], request_digest: params[22],
        occurred_at: params[23], created_at: params[23],
      };
      state.events.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('FROM myfin.marketing_campaigns campaign'))
      return { rows: state.campaigns, rowCount: state.campaigns.length };
    if (sql.startsWith('INSERT INTO myfin.loyalty_sale_award_batches')) {
      state.batch = { workspace_id: params[0], company_id: params[1], source_sale_id: params[2],
        source_order_id: params[3], customer_id: params[4], total_sen: params[5],
        program_version: params[6], request_digest: params[7], occurred_at: params[8] };
      releaseSale();
      return { rows: [], rowCount: 1 };
    }
    throw Error(`unexpected query: ${sql}`);
  } });
  return { state, client };
}

test('concurrent paid-sale awards are exact-once and retries use the recorded program after settings change', async () => {
  const fixture = awardFixture();
  fixture.state.campaigns = [{ id: 'campaign-a', version: '3', bonus_points: '5', audiences: [] }];
  const input = { companyId: 'company-a', customerId: 'customer-a', saleId: 'sale-a', orderId: 'order-a',
    totalSen: 1000, occurredAt: AT, actorId: 'staff-a' };
  const [first, concurrent] = await Promise.all([
    awardLoyaltyPointsForSale(fixture.client(), input),
    awardLoyaltyPointsForSale(fixture.client(), { ...input, occurredAt: '2026-10-10T04:00:01.000Z', actorId: 'staff-b' }),
  ]);
  assert.equal(fixture.state.accountUpdates, 2);
  assert.equal(fixture.state.events.length, 2);
  assert.deepEqual(fixture.state.events.map(event => [event.kind, event.points, event.campaign_version]),
    [['earn', 2, null], ['bonus', 5, 3]]);
  assert.deepEqual([first.awards[0].replayed, concurrent.awards[0].replayed].sort(), [false, true]);

  fixture.state.currentSettings = settingsRow({ version: '2', points_per_order: '50' });
  fixture.state.settingsVersions.set(2, fixture.state.currentSettings);
  const replay = await awardLoyaltyPointsForSale(fixture.client(), {
    ...input, occurredAt: '2026-12-01T00:00:00.000Z', actorId: 'different-staff',
  });
  assert.equal(replay.settings.version, 1);
  assert.equal(replay.awards[0].event.points, 2);
  assert.equal(replay.awards[1].event.points, 5);
  assert.equal(replay.awards[0].replayed, true);
  assert.equal(fixture.state.accountUpdates, 2);
  await assert.rejects(awardLoyaltyPointsForSale(fixture.client(), { ...input, totalSen: 1001 }),
    error => error.statusCode === 409 && error.message === 'loyalty_sale_source_changed');
});

test('migrated sale awards replay only against the authoritative paid order and stay labeled unversioned', async () => {
  const fixture = awardFixture();
  fixture.state.events = [{
    workspace_id: 'workspace-a', company_id: 'company-a', id: 'legacy-event-a',
    customer_id: 'customer-a', kind: 'earn', points: 1, balance_after: 1, reserved_after: 0,
    source_sale_id: 'sale-a', source_order_id: null, program_id: null, program_version: null,
    reason: 'Legacy loyalty event', occurred_at: AT, created_at: AT,
  }];
  const input = { companyId: 'company-a', customerId: 'customer-a', saleId: 'sale-a',
    orderId: 'order-a', totalSen: 1000, occurredAt: AT, actorId: 'staff-a' };
  const replay = await awardLoyaltyPointsForSale(fixture.client(), input);
  assert.equal(replay.settings, null);
  assert.equal(replay.legacyUnversioned, true);
  assert.equal(replay.awards[0].replayed, true);
  await assert.rejects(awardLoyaltyPointsForSale(fixture.client(), { ...input, totalSen: 1001 }),
    error => error.statusCode === 409 && error.message === 'loyalty_sale_source_invalid');
});

test('a sale cannot qualify its own bonus audience by crossing the loyalty threshold', async () => {
  const fixture = awardFixture();
  fixture.state.account.stamp_balance = 19;
  fixture.state.campaigns = [{ id: 'threshold-bonus', version: '1', bonus_points: '5',
    audiences: [{ ...audience({ consent: { required: false, channels: [] },
      eligibility: { studentStatus: 'any' }, customer: {
        ...audience().customer, minOrderCount: 0, minSpendSen: 0, minLoyaltyPoints: 20,
        lastPurchaseWithinDays: null, includeCustomerIds: [],
      } }) }] }];
  const result = await awardLoyaltyPointsForSale(fixture.client(), {
    companyId: 'company-a', customerId: 'customer-a', saleId: 'sale-a', orderId: 'order-a',
    totalSen: 1000, occurredAt: AT, actorId: 'staff-a',
  });
  assert.deepEqual(result.awards.map(item => item.event.kind), ['earn']);
  assert.equal(result.awards[0].event.balanceAfter, 21);
  assert.equal(fixture.state.events.some(event => event.kind === 'bonus'), false);
});

function balanceFixture() {
  const state = {
    account: { workspace_id: 'workspace-a', customer_id: 'customer-a', stamp_balance: 20,
      reserved_points: 0, version: 1 },
    currentSettings: settingsRow(), settingsVersions: new Map([[1, settingsRow()]]),
    pointEvents: [], reservations: [], accountUpdates: 0,
  };
  const client = { query: async (sql, params = []) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('SELECT EXISTS(')) return { rows: [{ found: true }], rowCount: 1 };
    if (sql.includes('FROM myfin.companies')) return { rows: [{ id: 'company-a', workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('FROM myfin.loyalty_point_events') && sql.includes('idempotency_key')) {
      const row = state.pointEvents.find(event => event.idempotency_key === params[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM myfin.workspace_loyalty_setting_versions')) {
      const row = state.settingsVersions.get(Number(params[1]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM myfin.workspace_loyalty_settings'))
      return { rows: [state.currentSettings], rowCount: 1 };
    if (sql.includes('FROM myfin.loyalty_point_reservations') && sql.includes('idempotency_key')) {
      const row = state.reservations.find(item => item.idempotency_key === params[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM myfin.loyalty_point_reservations') && sql.includes('SKIP LOCKED'))
      return { rows: [], rowCount: 0 };
    if (sql.startsWith('INSERT INTO myfin.customer_loyalty_accounts')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT * FROM myfin.customer_loyalty_accounts'))
      return { rows: [{ ...state.account }], rowCount: 1 };
    if (sql.startsWith('UPDATE myfin.customer_loyalty_accounts') && sql.includes('reserved_points=reserved_points+')) {
      state.account = { ...state.account, reserved_points: state.account.reserved_points + Number(params[2]),
        version: state.account.version + 1 };
      state.accountUpdates += 1;
      return { rows: [{ ...state.account }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE myfin.customer_loyalty_accounts')) {
      state.account = { ...state.account, stamp_balance: Number(params[2]), reserved_points: Number(params[3]),
        version: state.account.version + 1 };
      state.accountUpdates += 1;
      return { rows: [{ ...state.account }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO myfin.customer_loyalty_events')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('INSERT INTO myfin.loyalty_point_events')) {
      const row = { workspace_id: params[0], company_id: params[1], id: params[2], customer_id: params[3],
        kind: params[4], points: params[5], balance_after: params[6], reserved_after: params[7],
        source_sale_id: params[8], source_order_id: params[9], campaign_id: params[10], campaign_version: params[11],
        promotion_id: params[12], promotion_version: params[13], program_id: params[14], program_version: params[15],
        reverses_event_id: params[16], actor_type: params[17], staff_actor_id: params[18],
        customer_actor_id: params[19], reason: params[20], idempotency_key: params[21],
        request_digest: params[22], occurred_at: params[23], created_at: params[23] };
      state.pointEvents.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO myfin.loyalty_point_reservations')) {
      const row = { workspace_id: params[0], company_id: params[1], id: params[2], customer_id: params[3],
        points: params[4], state: 'active', source_order_id: params[5], campaign_id: params[6],
        campaign_version: params[7], promotion_id: params[8], promotion_version: params[9],
        program_version: params[10], idempotency_key: params[11], request_digest: params[12],
        expires_at: params[13], reserved_at: AT, updated_at: AT };
      state.reservations.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO myfin.loyalty_point_reservation_events')) return { rows: [], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  } };
  return { state, client };
}

test('adjustment replay remains exact after a settings version change', async () => {
  const fixture = balanceFixture(), routes = new Map();
  const app = { get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    put(path, handler) { routes.set(`PUT ${path}`, handler); } };
  registerMarketingLoyalty(app, { scoped: (req, fn) => fn(fixture.client, req.params.company), audit: async () => {} });
  const req = { params: { company: 'company-a' }, identity: { id: 'manager-a', role: 'manager' },
    body: { customerId: 'customer-a', points: 5, reason: 'Service recovery', idempotencyKey: 'adjust-0001' } };
  const handler = routes.get('POST /api/companies/:company/marketing/loyalty/adjustments');
  const first = await handler(req);
  fixture.state.currentSettings = settingsRow({ version: '2', unit_label: 'stars' });
  fixture.state.settingsVersions.set(2, fixture.state.currentSettings);
  const replay = await handler(req);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.account.unitLabel, 'beans');
  assert.equal(fixture.state.account.stamp_balance, 25);
  assert.equal(fixture.state.accountUpdates, 1);
});

test('reservation replay precedes changed settings, disabled policy and expiry checks', async () => {
  const fixture = balanceFixture();
  const expiresAt = new Date(Date.now() + 40).toISOString();
  const input = { companyId: 'company-a', customerId: 'customer-a', points: 7,
    reason: 'Apply to online order', idempotencyKey: 'reserve-0001', expiresAt,
    orderId: '', campaignId: '', campaignVersion: null, promotionId: '', promotionVersion: null,
    actor: { type: 'staff', id: 'manager-a' }, fallbackStaffActorId: 'manager-a' };
  const first = await reserveLoyaltyPoints(fixture.client, input);
  fixture.state.currentSettings = settingsRow({ version: '2', enabled: false, unit_label: 'stars' });
  fixture.state.settingsVersions.set(2, fixture.state.currentSettings);
  await new Promise(resolve => setTimeout(resolve, 60));
  const replay = await reserveLoyaltyPoints(fixture.client, input);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.account.unitLabel, 'beans');
  assert.equal(fixture.state.account.reserved_points, 7);
  assert.equal(fixture.state.accountUpdates, 1);
});

test('bounded expiry sweep releases stranded points and appends system lifecycle evidence', async () => {
  const calls = [], account = { reserved: 9 };
  const c = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FOR UPDATE SKIP LOCKED')) return { rows: [
      { id: 'reservation-a', customer_id: 'customer-a', points: 4 },
      { id: 'reservation-b', customer_id: 'customer-a', points: 5 },
    ], rowCount: 2 };
    if (sql.startsWith('UPDATE myfin.customer_loyalty_accounts')) {
      account.reserved -= Number(params[2]);
      return { rows: [{ customer_id: params[1] }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE myfin.loyalty_point_reservations')) return { rows: [{ id: params[1] }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO myfin.loyalty_point_reservation_events')) return { rows: [], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  } };
  assert.equal(await releaseExpiredLoyaltyReservations(c, {
    workspaceId: 'workspace-a', customerId: 'customer-a', limit: 10,
  }), 2);
  assert.equal(account.reserved, 0);
  assert.equal(calls.filter(call => call.sql.startsWith('INSERT INTO myfin.loyalty_point_reservation_events')).length, 2);
  assert.ok(calls.some(call => call.sql.includes("'system'")));
});

test('customer reservation replay checks ownership before returning another account', async () => {
  const calls = [];
  const c = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM myfin.companies'))
      return { rows: [{ id: 'company-a', workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('FROM myfin.loyalty_point_reservation_events event')) return { rows: [{
      workspace_id: 'workspace-a', company_id: 'company-a', id: 'reservation-a',
      customer_id: 'customer-a', points: 5, state: 'released', source_order_id: null,
      campaign_id: null, campaign_version: null, promotion_id: null, promotion_version: null,
      program_version: 1, expires_at: '2026-10-11T00:00:00.000Z', consumed_event_id: null,
      release_reason: 'Customer changed mind', reserved_at: AT, released_at: AT, updated_at: AT,
      event_request_digest: 'irrelevant-before-ownership', event_reservation_id: 'reservation-a',
    }], rowCount: 1 };
    throw Error(`unexpected query: ${sql}`);
  } };
  await assert.rejects(releaseLoyaltyPointsReservation(c, {
    companyId: 'company-a', reservationId: 'reservation-a',
    actor: { type: 'customer', id: 'customer-b' }, reason: 'Customer changed mind',
    idempotencyKey: 'release-0001',
  }), error => error.statusCode === 403 && error.message === 'loyalty_reservation_owner_required');
  assert.equal(calls.some(call => call.sql.includes('customer_loyalty_accounts')), false);
  assert.equal(calls.some(call => call.sql.includes('workspace_loyalty_settings')), false);
});

test('owner can explicitly constrain loyalty history to the selected company', async () => {
  const routes = new Map(), calls = [];
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post() {}, put() {},
  };
  const client = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM myfin.companies'))
      return { rows: [{ id: 'company-a', workspace_id: 'workspace-a' }], rowCount: 1 };
    if (sql.includes('FROM myfin.loyalty_point_events event')) return { rows: [], rowCount: 0 };
    throw Error(`unexpected query: ${sql}`);
  } };
  registerMarketingLoyalty(app, {
    scoped: (req, fn) => fn(client, req.params.company), audit: async () => {},
  });
  const handler = routes.get('GET /api/companies/:company/marketing/loyalty/events');
  const base = { params: { company: 'company-a' }, identity: { id: 'owner-a', role: 'workspace_owner' } };
  const companyResult = await handler({ ...base, query: { scope: 'company', limit: '100' } });
  assert.equal(companyResult.scope, 'company');
  assert.deepEqual(calls.at(-1).params, ['workspace-a', false, 'company-a', '', 100]);
  const workspaceResult = await handler({ ...base, query: {} });
  assert.equal(workspaceResult.scope, 'workspace');
  assert.deepEqual(calls.at(-1).params, ['workspace-a', true, 'company-a', '', 50]);
});

test('staff loyalty routes deny operators and require an adjustment reason before database access', async () => {
  const routes = new Map(), calls = [];
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    put(path, handler) { routes.set(`PUT ${path}`, handler); },
  };
  registerMarketingLoyalty(app, {
    scoped: (req, fn) => fn({ query: async (...args) => { calls.push(args); return { rows: [], rowCount: 0 }; } }, req.params.company),
    audit: async () => {},
  });
  const operator = { params: { company: 'company-a' }, query: {}, body: {},
    identity: { id: 'operator-a', role: 'operator' } };
  await assert.rejects(routes.get('GET /api/companies/:company/marketing/loyalty')(operator),
    error => error.statusCode === 403 && error.message === 'access_denied');
  const manager = { ...operator, identity: { id: 'manager-a', role: 'manager' }, body: {
    customerId: 'customer-a', points: 5, reason: 'x', idempotencyKey: 'adjust-0001',
  } };
  await assert.rejects(routes.get('POST /api/companies/:company/marketing/loyalty/adjustments')(manager),
    error => error.statusCode === 400);
  assert.equal(calls.length, 0);
});

test('migration keeps legacy projections, immutable exact-source history and least-privilege runtime grants', async () => {
  const [sql, development, production] = await Promise.all([
    readFile(new URL('../../db/migrations/0030_marketing_rewards_loyalty.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../db/grant-development-runtime.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../db/grant-production-runtime.sql', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(sql, /^(?:BEGIN|COMMIT);/m);
  assert.match(sql, /discount_type='free_item'/);
  assert.match(sql, /validate_free_item_redemption/);
  assert.match(sql, /reward_line_count<>1/);
  assert.match(sql, /CREATE TABLE myfin\.workspace_loyalty_setting_versions/);
  assert.match(sql, /CREATE TABLE myfin\.loyalty_point_events/);
  assert.match(sql, /CREATE TABLE myfin\.loyalty_sale_award_batches/);
  assert.match(sql, /CREATE TABLE myfin\.loyalty_point_reservations/);
  assert.equal((sql.match(/FOREIGN KEY\(workspace_id,company_id\)\s+REFERENCES myfin\.companies\(workspace_id,id\)/g) || []).length, 3);
  assert.match(sql, /UNIQUE\(workspace_id,consumed_event_id\)/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE ON myfin\.loyalty_point_reservations/);
  assert.match(sql, /NEW\.state<>'active'/);
  assert.match(sql, /consumed_event\.company_id IS DISTINCT FROM NEW\.company_id/);
  assert.match(sql, /consumed_event\.customer_id IS DISTINCT FROM NEW\.customer_id/);
  assert.match(sql, /consumed_event\.kind<>'redeem'/);
  assert.match(sql, /consumed_event\.points<>-NEW\.points/);
  assert.match(sql, /consumed_event\.program_version IS DISTINCT FROM NEW\.program_version/);
  assert.match(sql, /consumed_event\.source_order_id IS DISTINCT FROM NEW\.source_order_id/);
  assert.match(sql, /consumed_event\.campaign_id IS DISTINCT FROM NEW\.campaign_id/);
  assert.match(sql, /consumed_event\.promotion_id IS DISTINCT FROM NEW\.promotion_id/);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER loyalty_reserved_total_from_account[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER loyalty_reserved_total_from_reservation[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /account_reserved<>active_reserved/);
  assert.match(sql, /UNIQUE\(workspace_id,idempotency_key\)/);
  assert.match(sql, /loyalty_point_campaign_sale_once/);
  assert.match(sql, /immutable_loyalty_point_events/);
  assert.match(sql, /no_truncate_loyalty_sale_award_batches/);
  assert.match(sql, /INSERT INTO myfin\.loyalty_point_events[\s\S]*FROM myfin\.customer_loyalty_events/);
  assert.match(sql, /REVOKE ALL ON myfin\.workspace_loyalty_setting_versions/);
  assert.match(sql, /REVOKE ALL ON FUNCTION myfin\.enforce_loyalty_reserved_total\(\) FROM PUBLIC/);
  for (const grants of [development, production]) {
    assert.match(grants, /SELECT,INSERT ON myfin\.workspace_loyalty_setting_versions,myfin\.loyalty_point_events/);
    assert.match(grants, /SELECT,INSERT,UPDATE ON myfin\.loyalty_point_reservations/);
    assert.doesNotMatch(grants, /SELECT,INSERT,UPDATE,DELETE ON myfin\.loyalty_point_reservations/);
  }
});
