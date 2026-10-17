import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { owner } from './access.js';
import { permissionsFor } from '../../src/domain/permissions.js';
import * as v from './validation.js';

const MAX_POINTS = 1_000_000_000;
const MAX_EVENT_POINTS = 1_000_000;
const MAX_SEN = 9_000_000_000_000_000;
const PROGRAM_ID = 'workspace-loyalty';

const settingsSchema = z.strictObject({
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  enabled: z.boolean(),
  unitLabel: z.string().trim().min(1).max(40),
  earnMode: z.enum(['per_order', 'spend_step']),
  pointsPerOrder: z.number().int().min(1).max(MAX_EVENT_POINTS),
  spendStepSen: z.number().int().min(1).max(MAX_SEN),
  pointsPerSpendStep: z.number().int().min(1).max(MAX_EVENT_POINTS),
  minimumSpendSen: z.number().int().min(0).max(MAX_SEN),
  redemptionThresholdPoints: z.number().int().min(1).max(1000),
});
const reason = z.string().trim().min(3).max(500);
const idempotencyKey = z.string().trim().min(8).max(128);
const adjustmentSchema = z.strictObject({
  customerId: v.id,
  points: z.number().int().min(-MAX_EVENT_POINTS).max(MAX_EVENT_POINTS).refine(value => value !== 0),
  reason,
  idempotencyKey,
});
const redemptionSchema = z.strictObject({
  customerId: v.id,
  points: z.number().int().min(1).max(MAX_EVENT_POINTS),
  reason,
  idempotencyKey,
});
const reserveSchema = redemptionSchema.extend({
  expiresAt: z.string().datetime(),
  orderId: z.union([v.id, z.literal('')]).default(''),
  campaignId: z.union([v.id, z.literal('')]).default(''),
  campaignVersion: z.number().int().positive().nullable().default(null),
  promotionId: z.union([v.id, z.literal('')]).default(''),
  promotionVersion: z.number().int().positive().nullable().default(null),
}).superRefine((input, ctx) => {
  if (Boolean(input.campaignId) !== (input.campaignVersion !== null))
    ctx.addIssue({ code: 'custom', message: 'invalid_campaign_reference' });
  if (Boolean(input.promotionId) !== (input.promotionVersion !== null))
    ctx.addIssue({ code: 'custom', message: 'invalid_promotion_reference' });
});
const finalizeSchema = z.strictObject({ reason, idempotencyKey });
const reverseSchema = finalizeSchema;
const eventsSchema = z.strictObject({
  customerId: z.union([v.id, z.literal('')]).default(''),
  scope: z.enum(['role', 'company']).default('role'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const privileged = who => permissionsFor(who).marketingRead;

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

function safeInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER, message = 'invalid_loyalty_amount' } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail(400, message);
  return number;
}

function iso(value, message = 'invalid_loyalty_time') {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail(400, message);
  return date.toISOString();
}

function defaultSettings() {
  return {
    version: 0, enabled: true, unitLabel: 'points', earnMode: 'per_order',
    pointsPerOrder: 1, spendStepSen: 100, pointsPerSpendStep: 1,
    minimumSpendSen: 0, redemptionThresholdPoints: 10,
  };
}

export function loyaltySettingsOutput(row) {
  if (!row) return defaultSettings();
  return {
    version: Number(row.version),
    enabled: !!row.enabled,
    unitLabel: row.unit_label,
    earnMode: row.earn_mode,
    pointsPerOrder: Number(row.points_per_order),
    spendStepSen: Number(row.spend_step_sen),
    pointsPerSpendStep: Number(row.points_per_spend_step),
    minimumSpendSen: Number(row.minimum_spend_sen),
    redemptionThresholdPoints: Number(row.redemption_threshold_points),
  };
}

export function loyaltyPointsForSpend(settings, totalSen) {
  const total = safeInteger(totalSen, { max: MAX_SEN });
  if (!settings.enabled || total < settings.minimumSpendSen) return 0;
  if (settings.earnMode === 'per_order') return settings.pointsPerOrder;
  const steps = Math.floor(total / settings.spendStepSen);
  const points = steps * settings.pointsPerSpendStep;
  if (!Number.isSafeInteger(points) || points > MAX_EVENT_POINTS) fail(409, 'loyalty_points_limit');
  return points;
}

function eventOutput(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    companyId: row.company_id,
    kind: row.kind,
    points: Number(row.points),
    balanceAfter: Number(row.balance_after),
    reservedAfter: Number(row.reserved_after),
    saleId: row.source_sale_id || '',
    orderId: row.source_order_id || '',
    campaignId: row.campaign_id || '',
    campaignVersion: row.campaign_version === null || row.campaign_version === undefined
      ? null : Number(row.campaign_version),
    promotionId: row.promotion_id || '',
    promotionVersion: row.promotion_version === null || row.promotion_version === undefined
      ? null : Number(row.promotion_version),
    programId: row.program_id || '',
    programVersion: row.program_version === null || row.program_version === undefined
      ? null : Number(row.program_version),
    reversesEventId: row.reverses_event_id || '',
    reason: row.reason,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function accountOutput(row, settings) {
  const balance = Number(row?.stamp_balance || 0);
  const reserved = Number(row?.reserved_points || 0);
  return {
    customerId: row?.customer_id || '',
    balance, reserved, available: balance - reserved,
    version: Number(row?.version || 0), unitLabel: settings.unitLabel,
  };
}

function reservationOutput(row) {
  return {
    id: row.id, customerId: row.customer_id, companyId: row.company_id,
    points: Number(row.points), state: row.state, orderId: row.source_order_id || '',
    campaignId: row.campaign_id || '',
    campaignVersion: row.campaign_version === null ? null : Number(row.campaign_version),
    promotionId: row.promotion_id || '',
    promotionVersion: row.promotion_version === null ? null : Number(row.promotion_version),
    programVersion: Number(row.program_version), expiresAt: row.expires_at,
    consumedEventId: row.consumed_event_id || '', releaseReason: row.release_reason || '',
    reservedAt: row.reserved_at, consumedAt: row.consumed_at || null,
    releasedAt: row.released_at || null, updatedAt: row.updated_at,
  };
}

async function companyContext(c, companyId, lock = false) {
  const result = await c.query(
    `SELECT id,workspace_id FROM myfin.companies
      WHERE id=$1 AND archived_at IS NULL AND suspended_at IS NULL ${lock ? 'FOR SHARE' : ''}`,
    [companyId],
  );
  if (!result.rowCount) fail(404, 'not_found');
  return result.rows[0];
}

async function settingsRow(c, workspaceId, lock = false) {
  return (await c.query(
    `SELECT * FROM myfin.workspace_loyalty_settings WHERE workspace_id=$1 ${lock ? 'FOR UPDATE' : ''}`,
    [workspaceId],
  )).rows[0] || null;
}

async function settingsVersionRow(c, workspaceId, version) {
  return (await c.query(
    `SELECT * FROM myfin.workspace_loyalty_setting_versions
      WHERE workspace_id=$1 AND version=$2`, [workspaceId, version],
  )).rows[0] || null;
}

async function ensureSettings(c, workspaceId, actorId) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,31))',
    [`${workspaceId}:loyalty-settings`]);
  let row = await settingsRow(c, workspaceId, true);
  if (row) return row;
  const settings = defaultSettings();
  if (!actorId) fail(409, 'loyalty_settings_required');
  const requestDigest = digest({ workspaceId, version: 1, settings });
  await c.query(
    `INSERT INTO myfin.workspace_loyalty_setting_versions(
       workspace_id,version,enabled,unit_label,earn_mode,points_per_order,spend_step_sen,
       points_per_spend_step,minimum_spend_sen,redemption_threshold_points,request_digest,created_by)
     VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [workspaceId, settings.enabled, settings.unitLabel, settings.earnMode, settings.pointsPerOrder,
      settings.spendStepSen, settings.pointsPerSpendStep, settings.minimumSpendSen,
      settings.redemptionThresholdPoints, requestDigest, actorId],
  );
  row = (await c.query(
    `INSERT INTO myfin.workspace_loyalty_settings(
       workspace_id,enabled,stamps_per_order,stamps_required,reward_label,minimum_spend,updated_by,
       version,unit_label,earn_mode,points_per_order,spend_step_sen,points_per_spend_step,
       minimum_spend_sen,redemption_threshold_points)
     VALUES($1,$2,$7,$3,'Reward',0,$4,1,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [workspaceId, settings.enabled, settings.redemptionThresholdPoints, actorId, settings.unitLabel,
      settings.earnMode, settings.pointsPerOrder, settings.spendStepSen,
      settings.pointsPerSpendStep, settings.minimumSpendSen, settings.redemptionThresholdPoints],
  )).rows[0];
  return row;
}

async function customerInCompany(c, workspaceId, companyId, customerId) {
  const result = await c.query(
    `SELECT EXISTS(
       SELECT 1 FROM myfin.customer_company_links link
        WHERE link.company_id=$2 AND link.customer_id=$3
       UNION ALL
       SELECT 1 FROM myfin.customer_order_requests orders
        WHERE orders.company_id=$2 AND orders.customer_id=$3
     ) AS found
     FROM myfin.companies company
     JOIN myfin.customer_accounts account ON account.id=$3 AND account.disabled_at IS NULL
     WHERE company.id=$2 AND company.workspace_id=$1`,
    [workspaceId, companyId, customerId],
  );
  return result.rows[0]?.found === true;
}

async function lockedAccount(c, workspaceId, customerId) {
  await c.query(
    `INSERT INTO myfin.customer_loyalty_accounts(workspace_id,customer_id)
     VALUES($1,$2) ON CONFLICT(workspace_id,customer_id) DO NOTHING`,
    [workspaceId, customerId],
  );
  return (await c.query(
    `SELECT * FROM myfin.customer_loyalty_accounts
      WHERE workspace_id=$1 AND customer_id=$2 FOR UPDATE`,
    [workspaceId, customerId],
  )).rows[0];
}

async function existingPointEvent(c, workspaceId, key, requestDigest) {
  const row = (await c.query(
    `SELECT * FROM myfin.loyalty_point_events
      WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`, [workspaceId, key],
  )).rows[0];
  if (row && row.request_digest !== requestDigest) fail(409, 'loyalty_request_changed');
  return row || null;
}

function actorColumns(actor) {
  if (actor.type === 'staff') return ['staff', actor.id, null];
  if (actor.type === 'customer') return ['customer', null, actor.id];
  return ['system', null, null];
}

async function writePointEvent(c, input) {
  const requestDigest = digest(input.stable);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,30))',
    [`${input.workspaceId}:loyalty:${input.idempotencyKey}`]);
  const existing = await existingPointEvent(c, input.workspaceId, input.idempotencyKey, requestDigest);
  if (existing) {
    const account = await lockedAccount(c, input.workspaceId, existing.customer_id);
    return { event: existing, account, replayed: true };
  }
  const account = await lockedAccount(c, input.workspaceId, input.customerId);
  const balance = Number(account.stamp_balance);
  const reserved = Number(account.reserved_points);
  const nextBalance = balance + input.points;
  const nextReserved = reserved + (input.reservedDelta || 0);
  if (!Number.isSafeInteger(nextBalance) || nextBalance < 0 || nextBalance > MAX_POINTS ||
      !Number.isSafeInteger(nextReserved) || nextReserved < 0 || nextReserved > nextBalance)
    fail(409, 'insufficient_loyalty_points');
  const updated = (await c.query(
    `UPDATE myfin.customer_loyalty_accounts
        SET stamp_balance=$3,reserved_points=$4,version=version+1,updated_at=now()
      WHERE workspace_id=$1 AND customer_id=$2 RETURNING *`,
    [input.workspaceId, input.customerId, nextBalance, nextReserved],
  )).rows[0];
  const id = input.id || randomUUID();
  const [actorType, staffActorId, customerActorId] = actorColumns(input.actor);
  const legacyKind = input.kind === 'bonus' ? 'adjust' : input.kind;
  const legacySaleId = input.kind === 'earn' ? (input.saleId || null) : null;
  await c.query(
    `INSERT INTO myfin.customer_loyalty_events(
       workspace_id,id,customer_id,company_id,kind,stamps,balance_after,source_sale_id,reason,actor_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [input.workspaceId, id, input.customerId, input.companyId, legacyKind, input.points,
      nextBalance, legacySaleId, input.reason, staffActorId],
  );
  const event = (await c.query(
    `INSERT INTO myfin.loyalty_point_events(
       workspace_id,company_id,id,customer_id,kind,points,balance_after,reserved_after,
       source_sale_id,source_order_id,campaign_id,campaign_version,promotion_id,promotion_version,
       program_id,program_version,reverses_event_id,legacy_event_id,actor_type,staff_actor_id,
       customer_actor_id,reason,idempotency_key,request_digest,occurred_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$3,$18,$19,$20,$21,$22,$23,$24)
     RETURNING *`,
    [input.workspaceId, input.companyId, id, input.customerId, input.kind, input.points,
      nextBalance, nextReserved, input.saleId || null, input.orderId || null,
      input.campaignId || null, input.campaignVersion || null,
      input.promotionId || null, input.promotionVersion || null,
      input.programVersion ? PROGRAM_ID : null, input.programVersion || null,
      input.reversesEventId || null, actorType, staffActorId, customerActorId,
      input.reason, input.idempotencyKey, requestDigest, iso(input.occurredAt || new Date())],
  )).rows[0];
  return { event, account: updated, replayed: false };
}

async function economics(c, workspaceId, companyId, workspaceWide) {
  const event = (await c.query(
    `SELECT coalesce(sum(points) FILTER(WHERE kind IN ('earn','bonus')),0)::bigint AS issued_points,
            coalesce(-sum(points) FILTER(WHERE kind='redeem'),0)::bigint AS redeemed_points,
            coalesce(sum(points) FILTER(WHERE kind='adjust'),0)::bigint AS adjusted_points,
            coalesce(sum(points) FILTER(WHERE kind='reverse'),0)::bigint AS reversed_points
       FROM myfin.loyalty_point_events
      WHERE workspace_id=$1 AND ($2 OR company_id=$3)`,
    [workspaceId, workspaceWide, companyId],
  )).rows[0];
  const account = workspaceWide ? (await c.query(
    `SELECT coalesce(sum(stamp_balance),0)::bigint AS outstanding_points,
            coalesce(sum(reserved_points),0)::bigint AS reserved_points,
            count(*)::integer AS customer_count
       FROM myfin.customer_loyalty_accounts WHERE workspace_id=$1`, [workspaceId],
  )).rows[0] : (await c.query(
    `SELECT coalesce(sum(event.points),0)::bigint AS net_points_movement,
            count(DISTINCT event.customer_id)::integer AS customer_count
       FROM myfin.loyalty_point_events event
      WHERE event.workspace_id=$1 AND event.company_id=$2`, [workspaceId, companyId],
  )).rows[0];
  return {
    issuedPoints: Number(event.issued_points), redeemedPoints: Number(event.redeemed_points),
    adjustedPoints: Number(event.adjusted_points), reversedPoints: Number(event.reversed_points),
    netPointsMovement: workspaceWide ? null : Number(account.net_points_movement),
    outstandingPoints: workspaceWide ? Number(account.outstanding_points) : null,
    reservedPoints: workspaceWide ? Number(account.reserved_points) : null,
    customerCount: Number(account.customer_count),
  };
}

async function loyaltyOverview(c, companyId, who) {
  const company = await companyContext(c, companyId);
  const settings = loyaltySettingsOutput(await settingsRow(c, company.workspace_id));
  const workspaceWide = owner(who);
  await releaseExpiredLoyaltyReservations(c, {
    workspaceId: company.workspace_id, companyId: workspaceWide ? '' : companyId, limit: 500,
  });
  return {
    workspaceId: company.workspace_id, companyId,
    scope: workspaceWide ? 'workspace' : 'company', settings,
    economics: await economics(c, company.workspace_id, companyId, workspaceWide),
  };
}

export const getMarketingLoyaltyOverview = loyaltyOverview;

async function saveSettings(c, companyId, who, rawInput) {
  const input = v.parse(settingsSchema, rawInput);
  const company = await companyContext(c, companyId, true);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,31))',
    [`${company.workspace_id}:loyalty-settings`]);
  const current = await settingsRow(c, company.workspace_id, true);
  const currentVersion = Number(current?.version || 0);
  if (currentVersion !== input.expectedVersion) fail(409, 'loyalty_settings_changed');
  const version = currentVersion + 1;
  const stable = { workspaceId: company.workspace_id, version, ...input, expectedVersion: undefined };
  await c.query(
    `INSERT INTO myfin.workspace_loyalty_setting_versions(
       workspace_id,version,enabled,unit_label,earn_mode,points_per_order,spend_step_sen,
       points_per_spend_step,minimum_spend_sen,redemption_threshold_points,request_digest,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [company.workspace_id, version, input.enabled, input.unitLabel, input.earnMode,
      input.pointsPerOrder, input.spendStepSen, input.pointsPerSpendStep,
      input.minimumSpendSen, input.redemptionThresholdPoints, digest(stable), who.id],
  );
  const params = [company.workspace_id, input.enabled, input.redemptionThresholdPoints,
    (input.minimumSpendSen / 100).toFixed(2), who.id, version, input.unitLabel,
    input.earnMode, input.pointsPerOrder, input.spendStepSen, input.pointsPerSpendStep,
    input.minimumSpendSen];
  let saved;
  if (current) saved = (await c.query(
    `UPDATE myfin.workspace_loyalty_settings SET
       enabled=$2,stamps_per_order=$9,stamps_required=$3,minimum_spend=$4,updated_by=$5,
       updated_at=now(),version=$6,unit_label=$7,earn_mode=$8,points_per_order=$9,
       spend_step_sen=$10,points_per_spend_step=$11,minimum_spend_sen=$12,
       redemption_threshold_points=$3
     WHERE workspace_id=$1 AND version=$13 RETURNING *`, [...params, currentVersion],
  )).rows[0];
  else saved = (await c.query(
    `INSERT INTO myfin.workspace_loyalty_settings(
       workspace_id,enabled,stamps_per_order,stamps_required,reward_label,minimum_spend,updated_by,
       version,unit_label,earn_mode,points_per_order,spend_step_sen,points_per_spend_step,
       minimum_spend_sen,redemption_threshold_points)
     VALUES($1,$2,$9,$3,'Reward',$4,$5,$6,$7,$8,$9,$10,$11,$12,$3) RETURNING *`, params,
  )).rows[0];
  if (!saved) fail(409, 'loyalty_settings_changed');
  return loyaltySettingsOutput(saved);
}

export const saveMarketingLoyaltySettings = saveSettings;

function audienceMatchesCustomer(audience, customer, at) {
  const consent = audience.consent || {};
  const eligibility = audience.eligibility || {};
  const criteria = audience.customer || {};
  const included = criteria.includeCustomerIds || [];
  const excluded = criteria.excludeCustomerIds || [];
  if (excluded.includes(customer.id) || (included.length && !included.includes(customer.id))) return false;
  if (criteria.accountRequired && !customer.hasAccount) return false;
  if (consent.required && !(consent.channels || []).every(channel => customer.consents.has(channel))) return false;
  if (eligibility.studentStatus === 'verified' && !customer.studentVerified) return false;
  if (eligibility.studentStatus === 'not_verified' && customer.studentVerified) return false;
  const stats = audience.scope === 'workspace' ? customer.workspace : customer.company;
  if (stats.orderCount < Number(criteria.minOrderCount || 0)
      || stats.spendSen < Number(criteria.minSpendSen || 0)
      || customer.loyaltyPoints < Number(criteria.minLoyaltyPoints || 0)) return false;
  if (criteria.lastPurchaseWithinDays) {
    if (!stats.lastPurchaseAt) return false;
    const oldest = new Date(at).getTime() - Number(criteria.lastPurchaseWithinDays) * 86400000;
    if (new Date(stats.lastPurchaseAt).getTime() < oldest) return false;
  }
  return true;
}

export { audienceMatchesCustomer };

async function customerCampaignProfile(c, input) {
  const stats = (await c.query(
    `WITH purchases AS (
       SELECT company.workspace_id,orders.company_id,round(orders.total*100)::bigint AS total_sen,
              orders.created_at
         FROM myfin.customer_order_requests orders
         JOIN myfin.companies company ON company.id=orders.company_id
        WHERE company.workspace_id=$1 AND orders.customer_id=$2 AND orders.payment_state='paid'
          AND ($4='' OR orders.id<>$4)
       UNION ALL
       SELECT company.workspace_id,sale.company_id,round(sale.total*100)::bigint AS total_sen,
              (sale.data->>'date')::timestamptz AS created_at
         FROM myfin.transactions sale
         JOIN myfin.companies company ON company.id=sale.company_id
         JOIN myfin.customer_company_links link
           ON link.company_id=sale.company_id AND link.client_id=sale.data->>'client_id'
        WHERE company.workspace_id=$1 AND link.customer_id=$2 AND sale.source='pos'
          AND ($5='' OR sale.id<>$5)
          AND NOT EXISTS(SELECT 1 FROM myfin.customer_order_payments payment
            WHERE payment.company_id=sale.company_id AND payment.sale_id=sale.id)
     )
     SELECT count(*)::integer AS workspace_order_count,
            coalesce(sum(total_sen),0)::bigint AS workspace_spend_sen,
            max(created_at) AS workspace_last_purchase_at,
            count(*) FILTER(WHERE company_id=$3)::integer AS company_order_count,
            coalesce(sum(total_sen) FILTER(WHERE company_id=$3),0)::bigint AS company_spend_sen,
            max(created_at) FILTER(WHERE company_id=$3) AS company_last_purchase_at
       FROM purchases`,
    [input.workspaceId, input.customerId, input.companyId, input.orderId || '', input.saleId || ''],
  )).rows[0];
  const consents = (await c.query(
    `WITH latest_consent AS (
       SELECT DISTINCT ON(channel) channel,granted,destination,destination_verified_at
         FROM myfin.customer_consent_events
        WHERE workspace_id=$1 AND customer_id=$2 AND purpose='marketing'
        ORDER BY channel,created_at DESC,id DESC
     )
     SELECT consent.channel,
            consent.granted AND consent.destination_verified_at IS NOT NULL AND
            CASE WHEN consent.channel='email'
              THEN account.email_verified_at IS NOT NULL AND
                   consent.destination=account.primary_email
              ELSE profile.phone_verified_at IS NOT NULL AND
                   consent.destination=profile.phone
            END AS granted
       FROM latest_consent consent
       JOIN myfin.customer_accounts account ON account.id=$2
       LEFT JOIN myfin.customer_workspace_profiles profile
         ON profile.workspace_id=$1 AND profile.customer_id=account.id`,
    [input.workspaceId, input.customerId],
  )).rows;
  const student = (await c.query(
    `SELECT status,valid_from,valid_until FROM myfin.student_eligibilities
      WHERE workspace_id=$1 AND customer_id=$2`, [input.workspaceId, input.customerId],
  )).rows[0];
  const account = (await c.query(
    `SELECT stamp_balance FROM myfin.customer_loyalty_accounts
      WHERE workspace_id=$1 AND customer_id=$2`, [input.workspaceId, input.customerId],
  )).rows[0];
  const studentVerified = student?.status === 'verified'
    && new Date(student.valid_from) <= new Date(input.occurredAt)
    && new Date(student.valid_until) > new Date(input.occurredAt);
  return {
    id: input.customerId,
    hasAccount: true,
    consents: new Set(consents.filter(row => row.granted).map(row => row.channel)),
    studentVerified, loyaltyPoints: Number(account?.stamp_balance || 0),
    workspace: { orderCount: Number(stats.workspace_order_count || 0),
      spendSen: Number(stats.workspace_spend_sen || 0), lastPurchaseAt: stats.workspace_last_purchase_at || null },
    company: { orderCount: Number(stats.company_order_count || 0),
      spendSen: Number(stats.company_spend_sen || 0), lastPurchaseAt: stats.company_last_purchase_at || null },
  };
}

function activeCampaignLink(link, at, channel) {
  const instant = new Date(at).getTime();
  return link.lifecycle === 'published'
    && Number(link.currentVersion) === Number(link.campaignVersion)
    && Array.isArray(link.channels) && link.channels.includes(channel)
    && new Date(link.startsAt).getTime() <= instant
    && (!link.endsAt || new Date(link.endsAt).getTime() > instant);
}

export async function filterCampaignEligiblePromotions(c, promotions, context) {
  const at = iso(context.at || new Date());
  const channel = context.channel || 'storefront';
  let customer = null;
  const activeLinks = promotion => (promotion.campaignLinks || [])
    .filter(link => activeCampaignLink(link, at, channel));
  const needsProfile = promotions.some(promotion => activeLinks(promotion)
    .some(link => link.audiences?.length));
  if (needsProfile && context.customerId) customer = await customerCampaignProfile(c, {
    workspaceId: context.workspaceId, companyId: context.companyId,
    customerId: context.customerId, occurredAt: at,
  });
  return promotions.filter(promotion => {
    if (!promotion.campaignLinks?.length) return true;
    const links = activeLinks(promotion);
    if (!links.length) return false;
    return links.some(link => !link.audiences?.length || (customer
      && link.audiences.some(audience => audienceMatchesCustomer(audience, customer, at))));
  });
}

async function activeBonusCampaigns(c, input) {
  const rows = (await c.query(
    `SELECT campaign.id,campaign.version,version.bonus_points,
            coalesce((SELECT jsonb_agg(jsonb_build_object(
              'scope',audience_version.scope,'companyId',audience_version.company_id,
              'consent',audience_version.consent_criteria,
              'eligibility',audience_version.eligibility_criteria,
              'customer',audience_version.customer_criteria)
              ORDER BY link.audience_id,link.audience_version)
             FROM myfin.marketing_campaign_version_audiences link
             JOIN myfin.marketing_audience_versions audience_version
               ON audience_version.workspace_id=link.workspace_id
              AND audience_version.audience_id=link.audience_id
              AND audience_version.version=link.audience_version
            WHERE link.workspace_id=campaign.workspace_id AND link.company_id=campaign.company_id
              AND link.campaign_id=campaign.id AND link.campaign_version=campaign.version),'[]'::jsonb) AS audiences
       FROM myfin.marketing_campaigns campaign
       JOIN myfin.marketing_campaign_versions version
         ON version.workspace_id=campaign.workspace_id AND version.company_id=campaign.company_id
        AND version.campaign_id=campaign.id AND version.version=campaign.version
      WHERE campaign.workspace_id=$1 AND campaign.company_id=$2 AND campaign.lifecycle='published'
        AND version.starts_at<=$3 AND (version.ends_at IS NULL OR version.ends_at>$3)
        AND $5=ANY(version.channels)
        AND version.offer_kind IN ('bonus_points','mixed')
        AND $4>=coalesce(version.bonus_min_spend_sen,0)
        AND (version.offer_kind='bonus_points' OR EXISTS(
          SELECT 1 FROM myfin.marketing_campaign_version_promotions link
          JOIN myfin.promotion_redemptions redemption
            ON redemption.workspace_id=link.workspace_id AND redemption.company_id=link.company_id
           AND redemption.promotion_id=link.promotion_id
           AND redemption.promotion_version=link.promotion_version
           AND redemption.source_type=$6 AND redemption.source_id=$7
          WHERE link.workspace_id=campaign.workspace_id AND link.company_id=campaign.company_id
            AND link.campaign_id=campaign.id AND link.campaign_version=campaign.version))
      ORDER BY campaign.id FOR SHARE OF campaign`,
    [input.workspaceId, input.companyId, input.occurredAt, input.totalSen,
      input.channel, input.sourceType, input.sourceType === 'customer_order' ? input.orderId : input.saleId],
  )).rows;
  if (!rows.some(row => row.audiences?.length)) return rows;
  const customer = await customerCampaignProfile(c, input);
  return rows.filter(row => !row.audiences?.length
    || row.audiences.some(audience => audienceMatchesCustomer(audience, customer, input.occurredAt)));
}

/** Award base loyalty plus every currently published campaign for which the
 * registered customer satisfies at least one exact audience version.
 */
export async function awardLoyaltyPointsForSale(c, rawInput) {
  const orderId = rawInput.orderId ? v.parse(v.id, rawInput.orderId) : '';
  const sourceType = rawInput.sourceType || (orderId ? 'customer_order' : 'pos_sale');
  const channel = rawInput.channel || (sourceType === 'customer_order' ? 'storefront' : 'pos');
  if (!['customer_order', 'pos_sale'].includes(sourceType)
      || !['storefront', 'pos'].includes(channel)
      || (sourceType === 'customer_order') !== Boolean(orderId)
      || (sourceType === 'customer_order' ? channel !== 'storefront' : channel !== 'pos'))
    fail(400, 'invalid_loyalty_sale_source');
  const input = {
    companyId: v.parse(v.id, rawInput.companyId), customerId: v.parse(v.id, rawInput.customerId),
    saleId: v.parse(v.id, rawInput.saleId), orderId, sourceType, channel,
    totalSen: safeInteger(rawInput.totalSen, { max: MAX_SEN }),
    occurredAt: iso(rawInput.occurredAt || new Date()), actorId: v.parse(v.id, rawInput.actorId),
  };
  const company = await companyContext(c, input.companyId, true);
  input.workspaceId = company.workspace_id;
  const sourceStable = {
    workspaceId: input.workspaceId, companyId: input.companyId, customerId: input.customerId,
    saleId: input.saleId, orderId: input.orderId, totalSen: input.totalSen,
  };
  const sourceDigest = digest(sourceStable);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,30))',
    [`${input.workspaceId}:loyalty-sale:${input.companyId}:${input.saleId}`]);
  const batch = (await c.query(
    `SELECT * FROM myfin.loyalty_sale_award_batches
      WHERE workspace_id=$1 AND company_id=$2 AND source_sale_id=$3 FOR SHARE`,
    [input.workspaceId, input.companyId, input.saleId],
  )).rows[0];
  if (batch) {
    if (batch.request_digest !== sourceDigest
        || (batch.source_type || 'customer_order') !== input.sourceType)
      fail(409, 'loyalty_sale_source_changed');
    const recordedSettings = loyaltySettingsOutput(await settingsVersionRow(
      c, input.workspaceId, Number(batch.program_version),
    ));
    const events = (await c.query(
      `SELECT * FROM myfin.loyalty_point_events
        WHERE workspace_id=$1 AND company_id=$2 AND source_sale_id=$3
          AND kind IN ('earn','bonus') ORDER BY created_at,id`,
      [input.workspaceId, input.companyId, input.saleId],
    )).rows;
    return { settings: recordedSettings,
      awards: events.map(event => ({ event: eventOutput(event), replayed: true })) };
  }
  const source = input.sourceType === 'customer_order' ? (await c.query(
    `SELECT orders.customer_id,orders.status,orders.payment_state,
            round(orders.total*100)::bigint AS order_total_sen,
            round(sale.total*100)::bigint AS sale_total_sen
       FROM myfin.customer_order_requests orders
       JOIN myfin.customer_order_payments payment
         ON payment.company_id=orders.company_id AND payment.order_id=orders.id
        AND payment.sale_id=$3
       JOIN myfin.transactions sale
         ON sale.company_id=payment.company_id AND sale.id=payment.sale_id
      WHERE orders.company_id=$1 AND orders.id=$2
      FOR SHARE OF orders,sale`, [input.companyId, input.orderId, input.saleId],
  )).rows[0] : (await c.query(
    `SELECT sale.source,sale.data->>'client_id' AS client_id,link.customer_id,
            round(sale.total*100)::bigint AS sale_total_sen
       FROM myfin.transactions sale
       JOIN myfin.customer_company_links link
         ON link.company_id=sale.company_id AND link.client_id=sale.data->>'client_id'
      WHERE sale.company_id=$1 AND sale.id=$2
      FOR SHARE OF sale`, [input.companyId, input.saleId],
  )).rows[0];
  const validCustomerOrder = input.sourceType === 'customer_order'
    && source?.customer_id === input.customerId && source.status === 'paid'
    && source.payment_state === 'paid' && Number(source.order_total_sen) === input.totalSen;
  const validPosSale = input.sourceType === 'pos_sale'
    && source?.source === 'pos' && source.customer_id === input.customerId && Boolean(source.client_id);
  if ((!validCustomerOrder && !validPosSale) || Number(source?.sale_total_sen) !== input.totalSen)
    fail(409, 'loyalty_sale_source_invalid');
  // A legacy stamp earn may have been migrated before award batches existed.
  // Its exact source event remains authoritative and must never be recalculated.
  const migrated = (await c.query(
    `SELECT * FROM myfin.loyalty_point_events
      WHERE workspace_id=$1 AND company_id=$2 AND source_sale_id=$3
        AND kind IN ('earn','bonus') ORDER BY created_at,id`,
    [input.workspaceId, input.companyId, input.saleId],
  )).rows;
  if (migrated.length) {
    if (migrated.some(event => event.customer_id !== input.customerId
        || (event.source_order_id && event.source_order_id !== input.orderId)))
      fail(409, 'loyalty_sale_source_changed');
    const programVersion = migrated.find(event => event.program_version)?.program_version;
    const recorded = programVersion
      ? loyaltySettingsOutput(await settingsVersionRow(c, input.workspaceId, Number(programVersion)))
      : null;
    return { settings: recorded,
      legacyUnversioned: !programVersion,
      awards: migrated.map(event => ({ event: eventOutput(event), replayed: true })) };
  }
  const settings = loyaltySettingsOutput(await ensureSettings(c, input.workspaceId, input.actorId));
  // Audience history is evaluated against the state immediately before this
  // sale: neither its order totals nor its newly earned base points qualify it.
  const campaigns = settings.enabled ? await activeBonusCampaigns(c, input) : [];
  const awards = [];
  const basePoints = settings.enabled ? loyaltyPointsForSpend(settings, input.totalSen) : 0;
  if (basePoints) {
    const stable = { type: 'base', ...sourceStable, settingsVersion: settings.version, points: basePoints };
    awards.push(await writePointEvent(c, {
      workspaceId: input.workspaceId, companyId: input.companyId, customerId: input.customerId,
      kind: 'earn', points: basePoints, saleId: input.saleId, orderId: input.orderId,
      programVersion: settings.version, actor: { type: 'staff', id: input.actorId },
      reason: input.sourceType === 'customer_order' ? 'Eligible paid order' : 'Eligible paid POS sale',
      idempotencyKey: digest(stable), occurredAt: input.occurredAt, stable,
    }));
  }
  for (const campaign of campaigns) {
    const points = safeInteger(campaign.bonus_points, { min: 1, max: MAX_EVENT_POINTS });
    const stable = { type: 'campaign_bonus', ...sourceStable, settingsVersion: settings.version,
      campaignId: campaign.id, campaignVersion: Number(campaign.version), points };
    awards.push(await writePointEvent(c, {
      workspaceId: input.workspaceId, companyId: input.companyId, customerId: input.customerId,
      kind: 'bonus', points, saleId: input.saleId, orderId: input.orderId,
      campaignId: campaign.id, campaignVersion: Number(campaign.version),
      programVersion: settings.version, actor: { type: 'staff', id: input.actorId },
      reason: 'Campaign bonus points',
      idempotencyKey: digest({ type: 'campaign_bonus', ...sourceStable,
        campaignId: campaign.id, campaignVersion: Number(campaign.version) }),
      occurredAt: input.occurredAt, stable,
    }));
  }
  await c.query(
    `INSERT INTO myfin.loyalty_sale_award_batches(
       workspace_id,company_id,source_sale_id,source_order_id,customer_id,total_sen,
       program_version,request_digest,occurred_at,source_type)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [input.workspaceId, input.companyId, input.saleId, input.orderId || null, input.customerId,
      input.totalSen, settings.version, sourceDigest, input.occurredAt, input.sourceType],
  );
  return { settings, awards: awards.map(item => ({ event: eventOutput(item.event), replayed: item.replayed })) };
}

async function changePoints(c, companyId, who, input, kind) {
  const company = await companyContext(c, companyId, true);
  const points = kind === 'redeem' ? -input.points : input.points;
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,30))',
    [`${company.workspace_id}:loyalty:${input.idempotencyKey}`]);
  const prior = (await c.query(
    `SELECT * FROM myfin.loyalty_point_events
      WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`,
    [company.workspace_id, input.idempotencyKey],
  )).rows[0];
  if (prior) {
    const programVersion = prior.program_version ? Number(prior.program_version) : null;
    const stable = { workspaceId: company.workspace_id, companyId, customerId: input.customerId,
      kind, points, reason: input.reason, programVersion };
    if (prior.request_digest !== digest(stable)) fail(409, 'loyalty_request_changed');
    const settings = programVersion
      ? loyaltySettingsOutput(await settingsVersionRow(c, company.workspace_id, programVersion))
      : loyaltySettingsOutput(await settingsRow(c, company.workspace_id));
    const account = await lockedAccount(c, company.workspace_id, prior.customer_id);
    return { event: eventOutput(prior), account: accountOutput(account, settings), replayed: true };
  }
  if (!await customerInCompany(c, company.workspace_id, companyId, input.customerId))
    fail(404, 'customer_not_found');
  const settings = loyaltySettingsOutput(await ensureSettings(c, company.workspace_id, who.id));
  await releaseExpiredLoyaltyReservations(c, {
    workspaceId: company.workspace_id, customerId: input.customerId, limit: 500,
  });
  const stable = { workspaceId: company.workspace_id, companyId, customerId: input.customerId,
    kind, points, reason: input.reason, programVersion: settings.version };
  const result = await writePointEvent(c, {
    ...stable, programVersion: settings.version, actor: { type: 'staff', id: who.id },
    idempotencyKey: input.idempotencyKey, occurredAt: new Date(), stable,
  });
  return { event: eventOutput(result.event), account: accountOutput(result.account, settings), replayed: result.replayed };
}

export async function releaseExpiredLoyaltyReservations(c, rawInput) {
  const workspaceId = v.parse(v.id, rawInput.workspaceId);
  const companyId = rawInput.companyId ? v.parse(v.id, rawInput.companyId) : '';
  const customerId = rawInput.customerId ? v.parse(v.id, rawInput.customerId) : '';
  const limit = safeInteger(rawInput.limit ?? 100, { min: 1, max: 500, message: 'invalid_loyalty_limit' });
  const expired = (await c.query(
    `SELECT * FROM myfin.loyalty_point_reservations
      WHERE workspace_id=$1 AND state='active' AND expires_at<=now()
        AND ($2='' OR company_id=$2) AND ($3='' OR customer_id=$3)
      ORDER BY expires_at,id LIMIT $4 FOR UPDATE SKIP LOCKED`,
    [workspaceId, companyId, customerId, limit],
  )).rows;
  for (const reservation of expired) {
    const account = (await c.query(
      `UPDATE myfin.customer_loyalty_accounts SET reserved_points=reserved_points-$3,
         version=version+1,updated_at=now()
       WHERE workspace_id=$1 AND customer_id=$2 AND reserved_points>=$3 RETURNING customer_id`,
      [workspaceId, reservation.customer_id, reservation.points],
    )).rows[0];
    if (!account) fail(409, 'loyalty_balance_changed');
    const reason = 'Reservation expired automatically';
    const saved = await c.query(
      `UPDATE myfin.loyalty_point_reservations SET state='expired',released_at=now(),
         release_reason=$3,updated_at=now()
       WHERE workspace_id=$1 AND id=$2 AND state='active' RETURNING id`,
      [workspaceId, reservation.id, reason],
    );
    if (!saved.rowCount) fail(409, 'loyalty_reservation_unavailable');
    const idempotencyKey = digest({ type: 'loyalty_reservation_expiry', workspaceId,
      reservationId: reservation.id });
    const stable = { workspaceId, reservationId: reservation.id, action: 'expired', reason };
    await c.query(
      `INSERT INTO myfin.loyalty_point_reservation_events(
         workspace_id,id,reservation_id,action,idempotency_key,request_digest,actor_type,reason)
       VALUES($1,$2,$3,'expired',$4,$5,'system',$6)`,
      [workspaceId, randomUUID(), reservation.id, idempotencyKey, digest(stable), reason],
    );
  }
  return expired.length;
}

export async function reserveLoyaltyPoints(c, rawInput) {
  const { companyId: rawCompanyId, actor, fallbackStaffActorId, ...body } = rawInput;
  const input = { ...v.parse(reserveSchema, body), companyId: v.parse(v.id, rawCompanyId), actor,
    fallbackStaffActorId };
  const company = await companyContext(c, input.companyId, true);
  const workspaceId = company.workspace_id;
  if (!actor || !['staff', 'customer'].includes(actor.type)
      || (actor.type === 'customer' && actor.id !== input.customerId))
    fail(400, 'invalid_loyalty_actor');
  const actorId = v.parse(v.id, actor.id);
  const expiresAt = iso(input.expiresAt);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,30))',
    [`${workspaceId}:loyalty-reservation:${input.idempotencyKey}`]);
  const prior = (await c.query(
    `SELECT * FROM myfin.loyalty_point_reservations
      WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`, [workspaceId, input.idempotencyKey],
  )).rows[0];
  if (prior) {
    const stable = { workspaceId, companyId: input.companyId, customerId: input.customerId,
      points: input.points, orderId: input.orderId, campaignId: input.campaignId,
      campaignVersion: input.campaignVersion, promotionId: input.promotionId,
      promotionVersion: input.promotionVersion, programVersion: Number(prior.program_version),
      expiresAt, reason: input.reason };
    const requestDigest = digest(stable);
    if (prior.request_digest !== requestDigest) fail(409, 'loyalty_request_changed');
    const settings = loyaltySettingsOutput(await settingsVersionRow(
      c, workspaceId, Number(prior.program_version),
    ));
    return { reservation: reservationOutput(prior),
      account: accountOutput(await lockedAccount(c, workspaceId, input.customerId), settings), replayed: true };
  }
  if (!await customerInCompany(c, workspaceId, input.companyId, input.customerId))
    fail(404, 'customer_not_found');
  const fallbackActor = input.fallbackStaffActorId
    ? v.parse(v.id, input.fallbackStaffActorId) : null;
  const currentSettings = await settingsRow(c, workspaceId, true);
  const settings = loyaltySettingsOutput(currentSettings || await ensureSettings(
    c, workspaceId, actor.type === 'staff' ? actorId : fallbackActor,
  ));
  if (!settings.enabled) fail(409, 'loyalty_program_disabled');
  const now = new Date();
  if (new Date(expiresAt) <= now || new Date(expiresAt) > new Date(now.getTime() + 7 * 86400000))
    fail(400, 'invalid_loyalty_reservation_expiry');
  if (input.orderId) {
    const order = (await c.query(
      `SELECT customer_id FROM myfin.customer_order_requests
        WHERE company_id=$1 AND id=$2 FOR SHARE`, [input.companyId, input.orderId],
    )).rows[0];
    if (!order || order.customer_id !== input.customerId) fail(409, 'loyalty_order_customer_changed');
  }
  await releaseExpiredLoyaltyReservations(c, { workspaceId, customerId: input.customerId, limit: 500 });
  const stable = { workspaceId, companyId: input.companyId, customerId: input.customerId,
    points: input.points, orderId: input.orderId, campaignId: input.campaignId,
    campaignVersion: input.campaignVersion, promotionId: input.promotionId,
    promotionVersion: input.promotionVersion, programVersion: settings.version,
    expiresAt, reason: input.reason };
  const requestDigest = digest(stable);
  const account = await lockedAccount(c, workspaceId, input.customerId);
  if (Number(account.stamp_balance) - Number(account.reserved_points) < input.points)
    fail(409, 'insufficient_loyalty_points');
  const updated = (await c.query(
    `UPDATE myfin.customer_loyalty_accounts SET reserved_points=reserved_points+$3,
       version=version+1,updated_at=now() WHERE workspace_id=$1 AND customer_id=$2 RETURNING *`,
    [workspaceId, input.customerId, input.points],
  )).rows[0];
  const id = randomUUID();
  const [actorType, staffActorId, customerActorId] = actorColumns(actor);
  const reservation = (await c.query(
    `INSERT INTO myfin.loyalty_point_reservations(
       workspace_id,company_id,id,customer_id,points,source_order_id,campaign_id,campaign_version,
       promotion_id,promotion_version,program_version,idempotency_key,request_digest,expires_at,
       staff_actor_id,customer_actor_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [workspaceId, input.companyId, id, input.customerId, input.points, input.orderId || null,
      input.campaignId || null, input.campaignVersion, input.promotionId || null, input.promotionVersion,
      settings.version, input.idempotencyKey, requestDigest, expiresAt, staffActorId, customerActorId],
  )).rows[0];
  await c.query(
    `INSERT INTO myfin.loyalty_point_reservation_events(
       workspace_id,id,reservation_id,action,idempotency_key,request_digest,actor_type,
       staff_actor_id,customer_actor_id,reason)
     VALUES($1,$2,$3,'reserved',$4,$5,$6,$7,$8,$9)`,
    [workspaceId, randomUUID(), id, digest({ reservation: input.idempotencyKey, action: 'reserved' }), requestDigest,
      actorType, staffActorId, customerActorId, input.reason],
  );
  return { reservation: reservationOutput(reservation), account: accountOutput(updated, settings), replayed: false };
}

async function finalizeReservation(c, companyId, reservationId, actor, input, action) {
  const company = await companyContext(c, companyId, true);
  if (!actor || !['staff', 'customer'].includes(actor.type)) fail(400, 'invalid_loyalty_actor');
  const actorId = v.parse(v.id, actor.id);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,30))',
    [`${company.workspace_id}:loyalty-reservation-event:${input.idempotencyKey}`]);
  const priorEvent = (await c.query(
    `SELECT event.request_digest AS event_request_digest,event.reservation_id AS event_reservation_id,
            reservation.* FROM myfin.loyalty_point_reservation_events event
       JOIN myfin.loyalty_point_reservations reservation
         ON reservation.workspace_id=event.workspace_id AND reservation.id=event.reservation_id
      WHERE event.workspace_id=$1 AND event.idempotency_key=$2 FOR UPDATE OF reservation`,
    [company.workspace_id, input.idempotencyKey],
  )).rows[0];
  const stable = { workspaceId: company.workspace_id, companyId, reservationId, action, reason: input.reason };
  const requestDigest = digest(stable);
  if (priorEvent) {
    if (actor.type === 'customer' && priorEvent.customer_id !== actorId)
      fail(403, 'loyalty_reservation_owner_required');
    if (priorEvent.event_request_digest !== requestDigest || priorEvent.event_reservation_id !== reservationId)
      fail(409, 'loyalty_request_changed');
    const settings = loyaltySettingsOutput(await settingsVersionRow(
      c, company.workspace_id, Number(priorEvent.program_version),
    ));
    const account = await lockedAccount(c, company.workspace_id, priorEvent.customer_id);
    const pointEvent = priorEvent.consumed_event_id ? (await c.query(
      `SELECT * FROM myfin.loyalty_point_events WHERE workspace_id=$1 AND id=$2`,
      [company.workspace_id, priorEvent.consumed_event_id],
    )).rows[0] : null;
    return { reservation: reservationOutput(priorEvent), account: accountOutput(account, settings),
      ...(pointEvent ? { event: eventOutput(pointEvent) } : {}), replayed: true };
  }
  const currentSettings = await settingsRow(c, company.workspace_id, true);
  const settings = loyaltySettingsOutput(currentSettings || await ensureSettings(
    c, company.workspace_id, actor.type === 'staff' ? actorId : null,
  ));
  const reservation = (await c.query(
    `SELECT * FROM myfin.loyalty_point_reservations
      WHERE workspace_id=$1 AND company_id=$2 AND id=$3 FOR UPDATE`,
    [company.workspace_id, companyId, reservationId],
  )).rows[0];
  if (!reservation) fail(404, 'loyalty_reservation_not_found');
  if (actor.type === 'customer' && reservation.customer_id !== actorId)
    fail(403, 'loyalty_reservation_owner_required');
  if (reservation.state !== 'active') fail(409, 'loyalty_reservation_unavailable');
  if (new Date(reservation.expires_at) <= new Date()) action = 'expired';
  let pointResult = null;
  let account;
  if (action === 'consume') {
    pointResult = await writePointEvent(c, {
      workspaceId: company.workspace_id, companyId, customerId: reservation.customer_id,
      kind: 'redeem', points: -Number(reservation.points), reservedDelta: -Number(reservation.points),
      orderId: reservation.source_order_id || '', campaignId: reservation.campaign_id || '',
      campaignVersion: reservation.campaign_version ? Number(reservation.campaign_version) : null,
      promotionId: reservation.promotion_id || '',
      promotionVersion: reservation.promotion_version ? Number(reservation.promotion_version) : null,
      programVersion: Number(reservation.program_version), actor,
      reason: input.reason,
      idempotencyKey: digest({ reservationId, action: 'consume', key: input.idempotencyKey }),
      occurredAt: new Date(), stable: { ...stable, points: Number(reservation.points) },
    });
    account = pointResult.account;
  } else {
    account = (await c.query(
      `UPDATE myfin.customer_loyalty_accounts SET reserved_points=reserved_points-$3,
         version=version+1,updated_at=now()
       WHERE workspace_id=$1 AND customer_id=$2 AND reserved_points>=$3 RETURNING *`,
      [company.workspace_id, reservation.customer_id, reservation.points],
    )).rows[0];
    if (!account) fail(409, 'loyalty_balance_changed');
  }
  const state = action === 'consume' ? 'consumed' : action === 'expired' ? 'expired' : 'released';
  const saved = (await c.query(
    `UPDATE myfin.loyalty_point_reservations SET state=$4,
       consumed_event_id=$5,consumed_at=CASE WHEN $4='consumed' THEN now() ELSE NULL END,
       released_at=CASE WHEN $4 IN ('released','expired') THEN now() ELSE NULL END,
       release_reason=CASE WHEN $4 IN ('released','expired') THEN $6 ELSE NULL END,updated_at=now()
      WHERE workspace_id=$1 AND company_id=$2 AND id=$3 AND state='active' RETURNING *`,
    [company.workspace_id, companyId, reservationId, state, pointResult?.event.id || null, input.reason],
  )).rows[0];
  if (!saved) fail(409, 'loyalty_reservation_unavailable');
  const [actorType, staffActorId, customerActorId] = actorColumns(actor);
  await c.query(
    `INSERT INTO myfin.loyalty_point_reservation_events(
       workspace_id,id,reservation_id,action,idempotency_key,request_digest,actor_type,
       staff_actor_id,customer_actor_id,reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [company.workspace_id, randomUUID(), reservationId, state, input.idempotencyKey,
      requestDigest, actorType, staffActorId, customerActorId, input.reason],
  );
  return { reservation: reservationOutput(saved), account: accountOutput(account, settings),
    ...(pointResult ? { event: eventOutput(pointResult.event) } : {}), replayed: false };
}

export async function consumeLoyaltyPointsReservation(c, rawInput) {
  const companyId = v.parse(v.id, rawInput.companyId);
  const reservationId = v.parse(v.id, rawInput.reservationId);
  const input = v.parse(finalizeSchema, {
    reason: rawInput.reason, idempotencyKey: rawInput.idempotencyKey,
  });
  return finalizeReservation(c, companyId, reservationId, rawInput.actor, input, 'consume');
}

export async function releaseLoyaltyPointsReservation(c, rawInput) {
  const companyId = v.parse(v.id, rawInput.companyId);
  const reservationId = v.parse(v.id, rawInput.reservationId);
  const input = v.parse(finalizeSchema, {
    reason: rawInput.reason, idempotencyKey: rawInput.idempotencyKey,
  });
  return finalizeReservation(c, companyId, reservationId, rawInput.actor, input, 'release');
}

async function reverseEvent(c, companyId, eventId, who, input) {
  const company = await companyContext(c, companyId, true);
  const original = (await c.query(
    `SELECT * FROM myfin.loyalty_point_events
      WHERE workspace_id=$1 AND company_id=$2 AND id=$3 FOR UPDATE`,
    [company.workspace_id, companyId, eventId],
  )).rows[0];
  if (!original) fail(404, 'loyalty_event_not_found');
  if (original.kind === 'reverse') fail(409, 'loyalty_reversal_invalid');
  const settings = original.program_version
    ? loyaltySettingsOutput(await settingsVersionRow(c, company.workspace_id, Number(original.program_version)))
    : loyaltySettingsOutput(await ensureSettings(c, company.workspace_id, who.id));
  const stable = { workspaceId: company.workspace_id, companyId, eventId,
    points: -Number(original.points), reason: input.reason };
  const requestDigest = digest(stable);
  const prior = (await c.query(
    `SELECT * FROM myfin.loyalty_point_events
      WHERE workspace_id=$1 AND reverses_event_id=$2`, [company.workspace_id, eventId],
  )).rows[0];
  if (prior) {
    if (prior.idempotency_key !== input.idempotencyKey) fail(409, 'loyalty_event_already_reversed');
    if (prior.request_digest !== requestDigest) fail(409, 'loyalty_request_changed');
    const account = await lockedAccount(c, company.workspace_id, original.customer_id);
    return { event: eventOutput(prior), account: accountOutput(account, settings), replayed: true };
  }
  const result = await writePointEvent(c, {
    workspaceId: company.workspace_id, companyId, customerId: original.customer_id,
    kind: 'reverse', points: -Number(original.points),
    saleId: original.source_sale_id || '', orderId: original.source_order_id || '',
    campaignId: original.campaign_id || '',
    campaignVersion: original.campaign_version ? Number(original.campaign_version) : null,
    promotionId: original.promotion_id || '',
    promotionVersion: original.promotion_version ? Number(original.promotion_version) : null,
    programVersion: original.program_version ? Number(original.program_version) : settings.version,
    reversesEventId: eventId, actor: { type: 'staff', id: who.id }, reason: input.reason,
    idempotencyKey: input.idempotencyKey, occurredAt: new Date(), stable,
  });
  return { event: eventOutput(result.event), account: accountOutput(result.account, settings), replayed: result.replayed };
}

/** Call from a future paid-sale reversal in the same database transaction.
 * Every base/campaign award is reversed once; already-reversed awards are
 * skipped so a source-level retry cannot double-credit or double-debit.
 */
export async function reverseLoyaltyPointsForSale(c, rawInput) {
  const companyId = v.parse(v.id, rawInput.companyId);
  const saleId = v.parse(v.id, rawInput.saleId);
  const actorId = v.parse(v.id, rawInput.actorId);
  const input = v.parse(finalizeSchema, {
    reason: rawInput.reason, idempotencyKey: rawInput.idempotencyKey,
  });
  const company = await companyContext(c, companyId, true);
  const rows = (await c.query(
    `SELECT original.id FROM myfin.loyalty_point_events original
       LEFT JOIN myfin.loyalty_point_events reversal
         ON reversal.workspace_id=original.workspace_id AND reversal.reverses_event_id=original.id
      WHERE original.workspace_id=$1 AND original.company_id=$2 AND original.source_sale_id=$3
        AND original.kind IN ('earn','bonus') AND reversal.id IS NULL
      ORDER BY original.created_at,original.id FOR UPDATE OF original`,
    [company.workspace_id, companyId, saleId],
  )).rows;
  const reversals = [];
  for (const row of rows) reversals.push(await reverseEvent(c, companyId, row.id, { id: actorId }, {
    reason: input.reason,
    idempotencyKey: digest({ type: 'loyalty_sale_reversal', workspaceId: company.workspace_id,
      companyId, saleId, eventId: row.id, sourceKey: input.idempotencyKey }),
  }));
  return { saleId, reversals };
}

export function registerMarketingLoyalty(app, { scoped, audit }) {
  app.get('/api/companies/:company/marketing/loyalty', req => scoped(req, async (c, companyId) => {
    if (!privileged(req.identity)) fail(403, 'access_denied');
    return loyaltyOverview(c, companyId, req.identity);
  }));

  app.put('/api/companies/:company/marketing/loyalty', req => scoped(req, async (c, companyId) => {
    if (!owner(req.identity)) fail(403, 'workspace_owner_required');
    const settings = await saveSettings(c, companyId, req.identity, req.body);
    await audit(c, req.identity, companyId, 'Loyalty settings versioned',
      `${settings.unitLabel} · version ${settings.version} · ${settings.enabled ? 'enabled' : 'disabled'}`);
    return loyaltyOverview(c, companyId, req.identity);
  }));

  app.post('/api/companies/:company/marketing/loyalty/adjustments', req => scoped(req, async (c, companyId) => {
    if (!privileged(req.identity)) fail(403, 'access_denied');
    const input = v.parse(adjustmentSchema, req.body);
    const result = await changePoints(c, companyId, req.identity, input, 'adjust');
    await audit(c, req.identity, companyId, 'Loyalty points adjusted',
      `${input.customerId} · ${input.points > 0 ? '+' : ''}${input.points} · ${input.reason}`);
    return result;
  }));

  app.post('/api/companies/:company/marketing/loyalty/redemptions', req => scoped(req, async (c, companyId) => {
    if (!privileged(req.identity)) fail(403, 'access_denied');
    const input = v.parse(redemptionSchema, req.body);
    const result = await changePoints(c, companyId, req.identity, input, 'redeem');
    await audit(c, req.identity, companyId, 'Loyalty points redeemed',
      `${input.customerId} · ${input.points} · ${input.reason}`);
    return result;
  }));

  app.post('/api/companies/:company/marketing/loyalty/redemptions/reserve', req => scoped(req, async (c, companyId) => {
    if (!privileged(req.identity)) fail(403, 'access_denied');
    const result = await reserveLoyaltyPoints(c, { ...req.body, companyId,
      actor: { type: 'staff', id: req.identity.id }, fallbackStaffActorId: req.identity.id });
    await audit(c, req.identity, companyId, 'Loyalty points reserved',
      `${result.reservation.customerId} · ${result.reservation.points}`);
    return result;
  }));

  app.post('/api/companies/:company/marketing/loyalty/redemptions/:reservationId/consume', req => scoped(req, async (c, companyId) => {
    if (!privileged(req.identity)) fail(403, 'access_denied');
    const reservationId = v.parse(v.id, req.params.reservationId);
    const input = v.parse(finalizeSchema, req.body);
    const result = await consumeLoyaltyPointsReservation(c, {
      companyId, reservationId, ...input, actor: { type: 'staff', id: req.identity.id },
    });
    await audit(c, req.identity, companyId, 'Loyalty reservation consumed', `${reservationId} · ${input.reason}`);
    return result;
  }));

  app.post('/api/companies/:company/marketing/loyalty/redemptions/:reservationId/release', req => scoped(req, async (c, companyId) => {
    if (!privileged(req.identity)) fail(403, 'access_denied');
    const reservationId = v.parse(v.id, req.params.reservationId);
    const input = v.parse(finalizeSchema, req.body);
    const result = await releaseLoyaltyPointsReservation(c, {
      companyId, reservationId, ...input, actor: { type: 'staff', id: req.identity.id },
    });
    await audit(c, req.identity, companyId, 'Loyalty reservation released', `${reservationId} · ${input.reason}`);
    return result;
  }));

  app.post('/api/companies/:company/marketing/loyalty/events/:eventId/reverse', req => scoped(req, async (c, companyId) => {
    if (!privileged(req.identity)) fail(403, 'access_denied');
    const eventId = v.parse(v.id, req.params.eventId);
    const input = v.parse(reverseSchema, req.body);
    const result = await reverseEvent(c, companyId, eventId, req.identity, input);
    await audit(c, req.identity, companyId, 'Loyalty event reversed', `${eventId} · ${input.reason}`);
    return result;
  }));

  app.get('/api/companies/:company/marketing/loyalty/events', req => scoped(req, async (c, companyId) => {
    if (!privileged(req.identity)) fail(403, 'access_denied');
    const query = v.parse(eventsSchema, req.query || {});
    const company = await companyContext(c, companyId);
    const workspaceWide = owner(req.identity) && query.scope === 'role';
    const rows = (await c.query(
      `SELECT event.*,account.display_name AS customer_name,account.primary_email AS customer_email
         FROM myfin.loyalty_point_events event
         JOIN myfin.customer_accounts account ON account.id=event.customer_id
        WHERE event.workspace_id=$1 AND ($2 OR event.company_id=$3)
          AND ($4='' OR event.customer_id=$4)
        ORDER BY event.occurred_at DESC,event.id DESC LIMIT $5`,
      [company.workspace_id, workspaceWide, companyId, query.customerId, query.limit],
    )).rows;
    return { scope: workspaceWide ? 'workspace' : 'company', rows: rows.map(row => ({ ...eventOutput(row),
      customerName: row.customer_name || 'Customer', customerEmail: row.customer_email || '' })) };
  }));
}
