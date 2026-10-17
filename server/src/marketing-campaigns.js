import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as v from './validation.js';
import { requireCapability, owner } from './access.js';

const MAX_SEN = 9_000_000_000_000_000;
const OBJECTIVES = Object.freeze([
  'awareness', 'acquisition', 'conversion', 'repeat_purchase', 'basket_growth',
  'inventory_clearance', 'loyalty', 'win_back', 'custom',
]);
const CHANNELS = Object.freeze([
  'pos', 'storefront', 'email', 'sms', 'whatsapp', 'qr', 'social', 'in_store', 'other',
]);
const LIFECYCLES = Object.freeze(['draft', 'published', 'paused', 'completed', 'archived']);
const OFFER_KINDS = Object.freeze(['promotion', 'bonus_points', 'mixed', 'none']);
const instant = z.string().trim().max(40).refine(value => value.includes('T')
  && Number.isFinite(new Date(value).getTime()), 'invalid_instant')
  .transform(value => new Date(value).toISOString());
const nullableInstant = z.union([instant, z.null()]);
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const optionalSen = z.union([z.number().int().min(0).max(MAX_SEN), z.null()]);
const exactPromotion = z.strictObject({
  promotionId: v.id,
  promotionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
const exactAudience = z.strictObject({
  audienceId: v.id,
  audienceVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
const campaignSchema = z.strictObject({
  expectedVersion: version,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).default(''),
  objective: z.enum(OBJECTIVES),
  channels: z.array(z.enum(CHANNELS)).min(1).max(12),
  startsAt: instant,
  endsAt: nullableInstant.default(null),
  budgetSen: optionalSen.default(null),
  currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('MYR'),
  offerKind: z.enum(OFFER_KINDS).default('none'),
  bonusPoints: z.union([z.number().int().min(1).max(1_000_000), z.null()]).default(null),
  bonusMinimumSpendSen: optionalSen.default(null),
  promotionLinks: z.array(exactPromotion).max(100).default([]),
  audienceLinks: z.array(exactAudience).max(100).default([]),
}).superRefine((input, ctx) => {
  if (input.endsAt && input.endsAt <= input.startsAt)
    ctx.addIssue({ code: 'custom', message: 'invalid_campaign_schedule' });
  if (new Set(input.channels).size !== input.channels.length)
    ctx.addIssue({ code: 'custom', message: 'duplicate_campaign_channel' });
  if (new Set(input.promotionLinks.map(link => link.promotionId)).size
      !== input.promotionLinks.length)
    ctx.addIssue({ code: 'custom', message: 'duplicate_campaign_promotion' });
  if (new Set(input.audienceLinks.map(link => link.audienceId)).size
      !== input.audienceLinks.length)
    ctx.addIssue({ code: 'custom', message: 'duplicate_campaign_audience' });
  const hasBonus = ['bonus_points', 'mixed'].includes(input.offerKind);
  const hasPromotions = ['promotion', 'mixed'].includes(input.offerKind);
  if (hasBonus !== (input.bonusPoints !== null))
    ctx.addIssue({ code: 'custom', message: 'invalid_campaign_bonus_points' });
  if (!hasBonus && input.bonusMinimumSpendSen !== null)
    ctx.addIssue({ code: 'custom', message: 'invalid_campaign_bonus_threshold' });
  if (hasPromotions && input.promotionLinks.length === 0)
    ctx.addIssue({ code: 'custom', message: 'campaign_promotion_required' });
  if (!hasPromotions && input.promotionLinks.length)
    ctx.addIssue({ code: 'custom', message: 'campaign_promotion_not_allowed' });
});

const consentSchema = z.strictObject({
  required: z.boolean().default(false),
  channels: z.array(z.enum(['email', 'sms', 'whatsapp'])).max(3).default([]),
}).superRefine((input, ctx) => {
  if (!input.required && input.channels.length)
    ctx.addIssue({ code: 'custom', message: 'consent_channels_require_consent' });
  if (input.required && !input.channels.length)
    ctx.addIssue({ code: 'custom', message: 'consent_channel_required' });
  if (new Set(input.channels).size !== input.channels.length)
    ctx.addIssue({ code: 'custom', message: 'duplicate_consent_channel' });
});
const eligibilitySchema = z.strictObject({
  studentStatus: z.enum(['any', 'verified', 'not_verified']).default('any'),
});
const customerCriteriaSchema = z.strictObject({
  accountRequired: z.boolean().default(true),
  minOrderCount: z.number().int().min(0).max(1_000_000).default(0),
  minSpendSen: z.number().int().min(0).max(MAX_SEN).default(0),
  minLoyaltyPoints: z.number().int().min(0).max(1_000_000_000).default(0),
  lastPurchaseWithinDays: z.union([z.number().int().min(1).max(3650), z.null()]).default(null),
  includeCustomerIds: z.array(v.id).max(1000).default([]),
  excludeCustomerIds: z.array(v.id).max(1000).default([]),
}).superRefine((input, ctx) => {
  if (new Set(input.includeCustomerIds).size !== input.includeCustomerIds.length
      || new Set(input.excludeCustomerIds).size !== input.excludeCustomerIds.length)
    ctx.addIssue({ code: 'custom', message: 'duplicate_audience_customer' });
  if (input.includeCustomerIds.some(id => input.excludeCustomerIds.includes(id)))
    ctx.addIssue({ code: 'custom', message: 'conflicting_audience_customer' });
});
const audienceSchema = z.strictObject({
  expectedVersion: version,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).default(''),
  scope: z.enum(['company', 'workspace']),
  consent: consentSchema.default({ required: false, channels: [] }),
  eligibility: eligibilitySchema.default({ studentStatus: 'any' }),
  customer: customerCriteriaSchema.default({
    accountRequired: true, minOrderCount: 0, minSpendSen: 0, minLoyaltyPoints: 0,
    lastPurchaseWithinDays: null, includeCustomerIds: [], excludeCustomerIds: [],
  }),
});
const transitionSchema = z.strictObject({ expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });
const cloneSchema = z.strictObject({
  expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  name: z.string().trim().min(1).max(160).optional(),
});
const dateQuerySchema = z.strictObject({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const asIso = value => value instanceof Date ? value.toISOString() : value || null;
const asNumber = value => value === null || value === undefined ? null : Number(value);

function requireMarketingStaff(who) {
  requireCapability(who, 'marketingRead');
}

async function companyWorkspace(c, companyId) {
  const result = await c.query('SELECT workspace_id FROM myfin.companies WHERE id=$1', [companyId]);
  if (!result.rowCount) v.fail(404, 'company_not_found');
  return result.rows[0].workspace_id;
}

export function deriveCampaignStatus(campaign, at = new Date().toISOString()) {
  if (campaign.lifecycle !== 'published') return campaign.lifecycle;
  const now = asIso(at);
  if (now < asIso(campaign.starts_at ?? campaign.startsAt)) return 'scheduled';
  const end = asIso(campaign.ends_at ?? campaign.endsAt);
  return end && now >= end ? 'completed' : 'active';
}

export function campaignOutput(row, at = new Date().toISOString()) {
  const campaign = {
    id: row.id,
    version: Number(row.version),
    name: row.name,
    description: row.description || '',
    objective: row.objective,
    channels: row.channels || [],
    startsAt: asIso(row.starts_at),
    endsAt: asIso(row.ends_at),
    budgetSen: asNumber(row.budget_sen),
    currencyCode: row.currency_code,
    offerKind: row.offer_kind || 'none',
    bonusPoints: asNumber(row.bonus_points),
    bonusMinimumSpendSen: asNumber(row.bonus_min_spend_sen),
    lifecycle: row.lifecycle,
    promotionLinks: row.promotion_links || [],
    audienceLinks: row.audience_links || [],
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
  return { ...campaign, status: deriveCampaignStatus(campaign, at) };
}

export function audienceOutput(row) {
  return {
    id: row.id,
    version: Number(row.version),
    name: row.name,
    description: row.description || '',
    scope: row.scope,
    companyId: row.company_id || null,
    consent: row.consent_criteria || { required: false, channels: [] },
    eligibility: row.eligibility_criteria || { studentStatus: 'any' },
    customer: row.customer_criteria || {},
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

const campaignSelect = `SELECT campaign.id,campaign.version,campaign.lifecycle,campaign.created_at,campaign.updated_at,
       version.name,version.description,version.objective,version.channels,version.starts_at,version.ends_at,
       version.budget_sen,version.currency_code,version.offer_kind,version.bonus_points,version.bonus_min_spend_sen,
       coalesce((SELECT jsonb_agg(jsonb_build_object('promotionId',link.promotion_id,
         'promotionVersion',link.promotion_version,'redemptionMode',offer.redemption_mode,
         'voucherReady',CASE WHEN offer.redemption_mode<>'voucher' THEN true ELSE EXISTS(
           SELECT 1 FROM myfin.promotion_vouchers voucher
           JOIN myfin.promotion_voucher_versions voucher_version
             ON voucher_version.workspace_id=voucher.workspace_id AND voucher_version.company_id=voucher.company_id
            AND voucher_version.promotion_id=voucher.promotion_id AND voucher_version.voucher_id=voucher.id
            AND voucher_version.version=voucher.version
           LEFT JOIN myfin.promotion_voucher_usage_counters voucher_usage
             ON voucher_usage.workspace_id=voucher.workspace_id AND voucher_usage.company_id=voucher.company_id
            AND voucher_usage.promotion_id=voucher.promotion_id AND voucher_usage.voucher_id=voucher.id
           WHERE voucher.workspace_id=link.workspace_id AND voucher.company_id=link.company_id
             AND voucher.promotion_id=link.promotion_id AND voucher_version.enabled
             AND voucher_version.valid_from<=version.starts_at
             AND ((version.ends_at IS NULL AND voucher_version.valid_until IS NULL)
               OR (version.ends_at IS NOT NULL AND (voucher_version.valid_until IS NULL OR voucher_version.valid_until>=version.ends_at)))
             AND (voucher_version.max_redemptions IS NULL
               OR coalesce(voucher_usage.redemption_count,0)<voucher_version.max_redemptions)
         ) END) ORDER BY link.promotion_id,link.promotion_version)
         FROM myfin.marketing_campaign_version_promotions link
         JOIN myfin.promotion_versions offer
           ON offer.workspace_id=link.workspace_id AND offer.company_id=link.company_id
          AND offer.promotion_id=link.promotion_id AND offer.version=link.promotion_version
        WHERE link.workspace_id=campaign.workspace_id AND link.company_id=campaign.company_id
          AND link.campaign_id=campaign.id AND link.campaign_version=campaign.version),'[]'::jsonb) AS promotion_links,
       coalesce((SELECT jsonb_agg(jsonb_build_object('audienceId',link.audience_id,
         'audienceVersion',link.audience_version) ORDER BY link.audience_id,link.audience_version)
         FROM myfin.marketing_campaign_version_audiences link
        WHERE link.workspace_id=campaign.workspace_id AND link.company_id=campaign.company_id
          AND link.campaign_id=campaign.id AND link.campaign_version=campaign.version),'[]'::jsonb) AS audience_links
  FROM myfin.marketing_campaigns campaign JOIN myfin.marketing_campaign_versions version
    ON version.workspace_id=campaign.workspace_id AND version.company_id=campaign.company_id
   AND version.campaign_id=campaign.id AND version.version=campaign.version`;

async function campaignById(c, workspaceId, companyId, campaignId, lock = false) {
  const result = await c.query(`${campaignSelect}
    WHERE campaign.workspace_id=$1 AND campaign.company_id=$2 AND campaign.id=$3
    ${lock ? 'FOR UPDATE OF campaign' : ''}`, [workspaceId, companyId, campaignId]);
  if (!result.rowCount) v.fail(404, 'campaign_not_found');
  return result.rows[0];
}

async function listCampaigns(c, workspaceId, companyId) {
  const result = await c.query(`${campaignSelect}
    WHERE campaign.workspace_id=$1 AND campaign.company_id=$2
    ORDER BY campaign.updated_at DESC,campaign.id`, [workspaceId, companyId]);
  const now = new Date().toISOString();
  return result.rows.map(row => campaignOutput(row, now));
}

async function listAudiences(c, workspaceId, companyId, includeWorkspace) {
  const result = await c.query(
    `SELECT audience.id,audience.version,audience.scope,audience.company_id,
            audience.created_at,audience.updated_at,version.name,version.description,
            version.consent_criteria,version.eligibility_criteria,version.customer_criteria
       FROM myfin.marketing_audiences audience JOIN myfin.marketing_audience_versions version
         ON version.workspace_id=audience.workspace_id AND version.audience_id=audience.id
        AND version.version=audience.version
      WHERE audience.workspace_id=$1
        AND (audience.company_id=$2 OR ($3::boolean AND audience.company_id IS NULL))
      ORDER BY audience.updated_at DESC,audience.id`,
    [workspaceId, companyId, includeWorkspace],
  );
  return result.rows.map(audienceOutput);
}

async function availablePromotions(c, workspaceId, companyId) {
  const result = await c.query(
      `SELECT promotion.id,promotion.version,version.name,version.enabled,version.redemption_mode,
            version.valid_from,version.valid_until,version.discount_type,version.discount_basis_points,
            version.discount_sen,version.reward_product_id,version.reward_variant_id,
            version.reward_quantity_milli,version.requires_customer,version.requires_student,
            version.stackable,version.priority
       FROM myfin.promotions promotion JOIN myfin.promotion_versions version
         ON version.workspace_id=promotion.workspace_id AND version.company_id=promotion.company_id
        AND version.promotion_id=promotion.id AND version.version=promotion.version
      WHERE promotion.workspace_id=$1 AND promotion.company_id=$2
      ORDER BY version.name,promotion.id`,
    [workspaceId, companyId],
  );
  return result.rows.map(row => ({
    promotionId: row.id, promotionVersion: Number(row.version), name: row.name,
    enabled: !!row.enabled, redemptionMode: row.redemption_mode,
    validFrom: asIso(row.valid_from), validUntil: asIso(row.valid_until),
    discountType: row.discount_type, discountBasisPoints: asNumber(row.discount_basis_points),
    discountSen: asNumber(row.discount_sen), rewardProductId: row.reward_product_id || null,
    rewardVariantId: row.reward_variant_id || null,
    rewardQuantityMilli: asNumber(row.reward_quantity_milli), requiresCustomer: !!row.requires_customer,
    requiresStudent: !!row.requires_student, stackable: !!row.stackable,
    priority: Number(row.priority || 0),
  }));
}

async function validateCampaignLinks(c, who, workspaceId, companyId, campaignId, input) {
  if (input.promotionLinks.length) {
    const promotions = await c.query(
      `SELECT link.promotion_id,link.promotion_version,version.enabled
         FROM jsonb_to_recordset($3::jsonb) AS link(promotion_id text,promotion_version bigint)
         JOIN myfin.promotion_versions version
           ON version.workspace_id=$1 AND version.company_id=$2
          AND version.promotion_id=link.promotion_id AND version.version=link.promotion_version`,
      [workspaceId, companyId, JSON.stringify(input.promotionLinks.map(link => ({
        promotion_id: link.promotionId, promotion_version: link.promotionVersion,
      })))],
    );
    if (promotions.rowCount !== input.promotionLinks.length) v.fail(409, 'campaign_promotion_not_found');
    if (promotions.rows.some(row => row.enabled)) v.fail(409, 'campaign_promotion_must_be_disabled');
    const owned = await c.query(
      `SELECT DISTINCT link.promotion_id
         FROM myfin.marketing_campaigns campaign
         JOIN myfin.marketing_campaign_version_promotions link
           ON link.workspace_id=campaign.workspace_id AND link.company_id=campaign.company_id
          AND link.campaign_id=campaign.id AND link.campaign_version=campaign.version
        WHERE campaign.workspace_id=$1 AND campaign.company_id=$2 AND campaign.id<>$3
          AND campaign.lifecycle NOT IN ('completed','archived')
          AND link.promotion_id=ANY($4::text[])`,
      [workspaceId, companyId, campaignId, input.promotionLinks.map(link => link.promotionId)],
    );
    if (owned.rowCount) v.fail(409, 'promotion_already_linked_to_campaign');
  }
  if (input.audienceLinks.length) {
    const audiences = await c.query(
      `SELECT link.audience_id,link.audience_version,version.scope,version.company_id
         FROM jsonb_to_recordset($3::jsonb) AS link(audience_id text,audience_version bigint)
         JOIN myfin.marketing_audience_versions version
           ON version.workspace_id=$1 AND version.audience_id=link.audience_id
          AND version.version=link.audience_version
        WHERE version.company_id=$2 OR version.company_id IS NULL`,
      [workspaceId, companyId, JSON.stringify(input.audienceLinks.map(link => ({
        audience_id: link.audienceId, audience_version: link.audienceVersion,
      })))],
    );
    if (audiences.rowCount !== input.audienceLinks.length) v.fail(409, 'campaign_audience_not_found');
    if (!owner(who) && audiences.rows.some(row => row.scope === 'workspace'))
      v.fail(403, 'workspace_audience_requires_owner');
  }
}

async function appendCampaignEvent(c, {
  workspaceId, companyId, campaignId, campaignVersion, eventType, fromLifecycle, toLifecycle, actorId, details = {},
}) {
  await c.query(
    `INSERT INTO myfin.marketing_campaign_events(
       workspace_id,company_id,campaign_id,campaign_version,event_type,from_lifecycle,to_lifecycle,actor_id,details)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [workspaceId, companyId, campaignId, campaignVersion, eventType,
      fromLifecycle, toLifecycle, actorId, details],
  );
}

async function saveCampaign(c, who, companyId, campaignId, rawInput, creating, eventDetails = {}) {
  const input = v.parse(campaignSchema, rawInput);
  if ((creating && input.expectedVersion !== 0) || (!creating && input.expectedVersion === 0))
    v.fail(409, 'campaign_changed');
  const workspaceId = await companyWorkspace(c, companyId);
  await validateCampaignLinks(c, who, workspaceId, companyId, campaignId, input);
  const currentResult = await c.query(
    `SELECT version,lifecycle FROM myfin.marketing_campaigns
      WHERE workspace_id=$1 AND company_id=$2 AND id=$3 FOR UPDATE`,
    [workspaceId, companyId, campaignId],
  );
  const current = currentResult.rows[0] || null;
  if (Number(current?.version || 0) !== input.expectedVersion) v.fail(409, 'campaign_changed');
  if (current && !['draft', 'paused'].includes(current.lifecycle))
    v.fail(409, 'campaign_must_be_draft_or_paused');
  const nextVersion = input.expectedVersion + 1;
  const lifecycle = current?.lifecycle || 'draft';
  if (creating) {
    await c.query(
      `INSERT INTO myfin.marketing_campaigns(
         workspace_id,company_id,id,version,lifecycle,updated_by)
       VALUES($1,$2,$3,$4,'draft',$5)`,
      [workspaceId, companyId, campaignId, nextVersion, who.id],
    );
  } else {
    const changed = await c.query(
      `UPDATE myfin.marketing_campaigns SET version=$4,updated_by=$5,updated_at=now()
        WHERE workspace_id=$1 AND company_id=$2 AND id=$3 AND version=$6
        RETURNING id`,
      [workspaceId, companyId, campaignId, nextVersion, who.id, input.expectedVersion],
    );
    if (!changed.rowCount) v.fail(409, 'campaign_changed');
  }
  await c.query(
    `INSERT INTO myfin.marketing_campaign_versions(
       workspace_id,company_id,campaign_id,version,name,description,objective,channels,starts_at,ends_at,
       budget_sen,currency_code,offer_kind,bonus_points,bonus_min_spend_sen,request_digest,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [workspaceId, companyId, campaignId, nextVersion, input.name, input.description,
      input.objective, input.channels, input.startsAt, input.endsAt, input.budgetSen,
      input.currencyCode, input.offerKind, input.bonusPoints, input.bonusMinimumSpendSen,
      digest({ campaignId, version: nextVersion, ...input, expectedVersion: undefined }), who.id],
  );
  if (input.promotionLinks.length) await c.query(
    `INSERT INTO myfin.marketing_campaign_version_promotions(
       workspace_id,company_id,campaign_id,campaign_version,promotion_id,promotion_version)
     SELECT $1,$2,$3,$4,link.promotion_id,link.promotion_version
       FROM jsonb_to_recordset($5::jsonb) AS link(promotion_id text,promotion_version bigint)`,
    [workspaceId, companyId, campaignId, nextVersion, JSON.stringify(input.promotionLinks.map(link => ({
      promotion_id: link.promotionId, promotion_version: link.promotionVersion,
    })))],
  );
  if (input.audienceLinks.length) await c.query(
    `INSERT INTO myfin.marketing_campaign_version_audiences(
       workspace_id,company_id,campaign_id,campaign_version,audience_id,audience_version)
     SELECT $1,$2,$3,$4,link.audience_id,link.audience_version
       FROM jsonb_to_recordset($5::jsonb) AS link(audience_id text,audience_version bigint)`,
    [workspaceId, companyId, campaignId, nextVersion, JSON.stringify(input.audienceLinks.map(link => ({
      audience_id: link.audienceId, audience_version: link.audienceVersion,
    })))],
  );
  await appendCampaignEvent(c, {
    workspaceId, companyId, campaignId, campaignVersion: nextVersion,
    eventType: creating ? (eventDetails.sourceCampaignId ? 'cloned' : 'created') : 'versioned',
    fromLifecycle: creating ? null : lifecycle, toLifecycle: lifecycle, actorId: who.id, details: eventDetails,
  });
  return campaignById(c, workspaceId, companyId, campaignId);
}

async function saveAudience(c, who, companyId, audienceId, rawInput, creating) {
  const input = v.parse(audienceSchema, rawInput);
  if ((creating && input.expectedVersion !== 0) || (!creating && input.expectedVersion === 0))
    v.fail(409, 'audience_changed');
  if (input.scope === 'workspace' && !owner(who)) v.fail(403, 'workspace_audience_requires_owner');
  const workspaceId = await companyWorkspace(c, companyId);
  const currentResult = await c.query(
    `SELECT version,scope,company_id,created_at FROM myfin.marketing_audiences
      WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
    [workspaceId, audienceId],
  );
  const current = currentResult.rows[0] || null;
  if (Number(current?.version || 0) !== input.expectedVersion) v.fail(409, 'audience_changed');
  if (current && (current.scope !== input.scope
      || (current.company_id || null) !== (input.scope === 'company' ? companyId : null)))
    v.fail(409, 'audience_scope_immutable');
  if (current?.scope === 'workspace' && !owner(who)) v.fail(403, 'workspace_audience_requires_owner');
  const nextVersion = input.expectedVersion + 1;
  const scopedCompanyId = input.scope === 'company' ? companyId : null;
  if (creating) {
    await c.query(
      `INSERT INTO myfin.marketing_audiences(workspace_id,id,company_id,scope,version,updated_by)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [workspaceId, audienceId, scopedCompanyId, input.scope, nextVersion, who.id],
    );
  } else {
    const changed = await c.query(
      `UPDATE myfin.marketing_audiences SET version=$3,updated_by=$4,updated_at=now()
        WHERE workspace_id=$1 AND id=$2 AND version=$5 RETURNING id`,
      [workspaceId, audienceId, nextVersion, who.id, input.expectedVersion],
    );
    if (!changed.rowCount) v.fail(409, 'audience_changed');
  }
  await c.query(
    `INSERT INTO myfin.marketing_audience_versions(
       workspace_id,audience_id,version,name,description,scope,company_id,
       consent_criteria,eligibility_criteria,customer_criteria,request_digest,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [workspaceId, audienceId, nextVersion, input.name, input.description, input.scope,
      scopedCompanyId, input.consent, input.eligibility, input.customer,
      digest({ audienceId, version: nextVersion, ...input, expectedVersion: undefined }), who.id],
  );
  return audienceOutput({
    id: audienceId, version: nextVersion, name: input.name, description: input.description,
    scope: input.scope, company_id: scopedCompanyId, consent_criteria: input.consent,
    eligibility_criteria: input.eligibility, customer_criteria: input.customer,
    created_at: current?.created_at || new Date().toISOString(), updated_at: new Date().toISOString(),
  });
}

const transitions = Object.freeze({
  publish: { from: ['draft', 'paused'], to: 'published' },
  pause: { from: ['published'], to: 'paused' },
  complete: { from: ['published', 'paused'], to: 'completed' },
  archive: { from: ['draft', 'paused', 'completed'], to: 'archived' },
});
const transitionAuditActions = Object.freeze({
  publish: 'Marketing campaign published', pause: 'Marketing campaign paused',
  complete: 'Marketing campaign completed', archive: 'Marketing campaign archived',
});

async function copyPromotionVersion(c, {
  workspaceId, companyId, promotionId, sourceVersion, nextVersion, enabled, actorId,
}) {
  const source = await c.query(
    `SELECT promotion.version AS current_version,version.*
       FROM myfin.promotions promotion JOIN myfin.promotion_versions version
         ON version.workspace_id=promotion.workspace_id AND version.company_id=promotion.company_id
        AND version.promotion_id=promotion.id
      WHERE promotion.workspace_id=$1 AND promotion.company_id=$2 AND promotion.id=$3
        AND version.version=$4 FOR UPDATE OF promotion`,
    [workspaceId, companyId, promotionId, sourceVersion],
  );
  if (!source.rowCount) v.fail(409, 'campaign_promotion_not_found');
  if (Number(source.rows[0].current_version) !== sourceVersion) v.fail(409, 'campaign_promotion_changed');
  if (nextVersion !== sourceVersion + 1) v.fail(409, 'campaign_promotion_changed');
  await c.query(
    `INSERT INTO myfin.promotion_versions(
       workspace_id,company_id,promotion_id,version,name,enabled,redemption_mode,valid_from,valid_until,
       currency_code,discount_type,discount_basis_points,discount_sen,max_discount_sen,min_subtotal_sen,
       max_total_redemptions,per_customer_limit,requires_customer,requires_student,stackable,priority,
       reward_product_id,reward_variant_id,reward_quantity_milli,request_digest,created_by)
     SELECT workspace_id,company_id,promotion_id,$5,name,$6,redemption_mode,valid_from,valid_until,
            currency_code,discount_type,discount_basis_points,discount_sen,max_discount_sen,min_subtotal_sen,
            max_total_redemptions,per_customer_limit,requires_customer,requires_student,stackable,priority,
            reward_product_id,reward_variant_id,reward_quantity_milli,$7,$8
       FROM myfin.promotion_versions
      WHERE workspace_id=$1 AND company_id=$2 AND promotion_id=$3 AND version=$4`,
    [workspaceId, companyId, promotionId, sourceVersion, nextVersion, enabled,
      digest({ promotionId, sourceVersion, version: nextVersion, enabled, action: 'campaign_lifecycle' }), actorId],
  );
  for (const [table, fields] of [
    ['promotion_version_products', 'product_id,variant_id'],
    ['promotion_version_categories', 'category_key,subcategory_key'],
    ['promotion_version_customers', 'customer_id'],
  ]) await c.query(
    `INSERT INTO myfin.${table}(workspace_id,company_id,promotion_id,promotion_version,${fields})
     SELECT workspace_id,company_id,promotion_id,$5,${fields} FROM myfin.${table}
      WHERE workspace_id=$1 AND company_id=$2 AND promotion_id=$3 AND promotion_version=$4`,
    [workspaceId, companyId, promotionId, sourceVersion, nextVersion],
  );
  const changed = await c.query(
    `UPDATE myfin.promotions SET version=$5,updated_by=$6,updated_at=now()
      WHERE workspace_id=$1 AND company_id=$2 AND id=$3 AND version=$4 RETURNING id`,
    [workspaceId, companyId, promotionId, sourceVersion, nextVersion, actorId],
  );
  if (!changed.rowCount) v.fail(409, 'campaign_promotion_changed');
  return { promotionId, promotionVersion: nextVersion };
}

async function clonePromotionIdentity(c, {
  workspaceId, companyId, sourcePromotionId, sourceVersion, actorId,
}) {
  const source = await c.query(
    `SELECT * FROM myfin.promotion_versions
      WHERE workspace_id=$1 AND company_id=$2 AND promotion_id=$3 AND version=$4`,
    [workspaceId, companyId, sourcePromotionId, sourceVersion],
  );
  if (!source.rowCount) v.fail(409, 'campaign_promotion_not_found');
  if (source.rows[0].redemption_mode === 'voucher') v.fail(409, 'campaign_voucher_clone_requires_new_code');
  const promotionId = randomUUID();
  await c.query(
    `INSERT INTO myfin.promotions(workspace_id,company_id,id,version,updated_by)
     VALUES($1,$2,$3,1,$4)`,
    [workspaceId, companyId, promotionId, actorId],
  );
  await c.query(
    `INSERT INTO myfin.promotion_versions(
       workspace_id,company_id,promotion_id,version,name,enabled,redemption_mode,valid_from,valid_until,
       currency_code,discount_type,discount_basis_points,discount_sen,max_discount_sen,min_subtotal_sen,
       max_total_redemptions,per_customer_limit,requires_customer,requires_student,stackable,priority,
       reward_product_id,reward_variant_id,reward_quantity_milli,request_digest,created_by)
     SELECT workspace_id,company_id,$5,1,name,false,redemption_mode,valid_from,valid_until,
            currency_code,discount_type,discount_basis_points,discount_sen,max_discount_sen,min_subtotal_sen,
            max_total_redemptions,per_customer_limit,requires_customer,requires_student,stackable,priority,
            reward_product_id,reward_variant_id,reward_quantity_milli,$6,$7
       FROM myfin.promotion_versions
      WHERE workspace_id=$1 AND company_id=$2 AND promotion_id=$3 AND version=$4`,
    [workspaceId, companyId, sourcePromotionId, sourceVersion, promotionId,
      digest({ sourcePromotionId, sourceVersion, promotionId, version: 1, enabled: false, action: 'campaign_clone' }), actorId],
  );
  for (const [table, fields] of [
    ['promotion_version_products', 'product_id,variant_id'],
    ['promotion_version_categories', 'category_key,subcategory_key'],
    ['promotion_version_customers', 'customer_id'],
  ]) await c.query(
    `INSERT INTO myfin.${table}(workspace_id,company_id,promotion_id,promotion_version,${fields})
     SELECT workspace_id,company_id,$5,1,${fields} FROM myfin.${table}
      WHERE workspace_id=$1 AND company_id=$2 AND promotion_id=$3 AND promotion_version=$4`,
    [workspaceId, companyId, sourcePromotionId, sourceVersion, promotionId],
  );
  return { promotionId, promotionVersion: 1 };
}

async function advanceCampaignLifecycle(c, who, workspaceId, companyId, row, action, transition) {
  const enablePromotions = action === 'publish';
  const promotionLinks = [];
  for (const link of row.promotion_links || []) promotionLinks.push(await copyPromotionVersion(c, {
    workspaceId, companyId, promotionId: link.promotionId,
    sourceVersion: Number(link.promotionVersion), nextVersion: Number(link.promotionVersion) + 1,
    enabled: enablePromotions, actorId: who.id,
  }));
  const nextVersion = Number(row.version) + 1;
  await c.query(
    `INSERT INTO myfin.marketing_campaign_versions(
       workspace_id,company_id,campaign_id,version,name,description,objective,channels,starts_at,ends_at,
       budget_sen,currency_code,offer_kind,bonus_points,bonus_min_spend_sen,request_digest,created_by)
     SELECT workspace_id,company_id,campaign_id,$5,name,description,objective,channels,starts_at,ends_at,
            budget_sen,currency_code,offer_kind,bonus_points,bonus_min_spend_sen,$6,$7
       FROM myfin.marketing_campaign_versions
      WHERE workspace_id=$1 AND company_id=$2 AND campaign_id=$3 AND version=$4`,
    [workspaceId, companyId, row.id, Number(row.version), nextVersion,
      digest({ campaignId: row.id, sourceVersion: Number(row.version), version: nextVersion, action }), who.id],
  );
  await c.query(
    `INSERT INTO myfin.marketing_campaign_version_audiences(
       workspace_id,company_id,campaign_id,campaign_version,audience_id,audience_version)
     SELECT workspace_id,company_id,campaign_id,$5,audience_id,audience_version
       FROM myfin.marketing_campaign_version_audiences
      WHERE workspace_id=$1 AND company_id=$2 AND campaign_id=$3 AND campaign_version=$4`,
    [workspaceId, companyId, row.id, Number(row.version), nextVersion],
  );
  if (promotionLinks.length) await c.query(
    `INSERT INTO myfin.marketing_campaign_version_promotions(
       workspace_id,company_id,campaign_id,campaign_version,promotion_id,promotion_version)
     SELECT $1,$2,$3,$4,link.promotion_id,link.promotion_version
       FROM jsonb_to_recordset($5::jsonb) AS link(promotion_id text,promotion_version bigint)`,
    [workspaceId, companyId, row.id, nextVersion, JSON.stringify(promotionLinks.map(link => ({
      promotion_id: link.promotionId, promotion_version: link.promotionVersion,
    })))],
  );
  const timestampColumn = `${transition.to}_at`;
  await c.query(
    `UPDATE myfin.marketing_campaigns
        SET version=$4,lifecycle=$5,${timestampColumn}=now(),updated_by=$6,updated_at=now()
      WHERE workspace_id=$1 AND company_id=$2 AND id=$3 AND version=$7`,
    [workspaceId, companyId, row.id, nextVersion, transition.to, who.id, Number(row.version)],
  );
  await appendCampaignEvent(c, {
    workspaceId, companyId, campaignId: row.id, campaignVersion: nextVersion, eventType: transition.to,
    fromLifecycle: row.lifecycle, toLifecycle: transition.to, actorId: who.id,
    details: { promotionState: enablePromotions ? 'enabled' : 'disabled' },
  });
  return campaignById(c, workspaceId, companyId, row.id);
}

async function transitionCampaign(c, who, companyId, campaignId, action, expectedVersion) {
  const workspaceId = await companyWorkspace(c, companyId);
  const row = await campaignById(c, workspaceId, companyId, campaignId, true);
  if (Number(row.version) !== expectedVersion) v.fail(409, 'campaign_changed');
  const transition = transitions[action];
  if (!transition.from.includes(row.lifecycle)) v.fail(409, 'invalid_campaign_transition');
  const now = new Date().toISOString();
  if (action === 'publish' && row.ends_at && asIso(row.ends_at) <= now) v.fail(409, 'campaign_schedule_ended');
  if (action === 'publish' && !row.channels?.some(channel => ['storefront','pos'].includes(channel)))
    v.fail(409, 'campaign_pricing_channel_required');
  if (action === 'publish' && row.promotion_links?.some(link =>
    link.redemptionMode === 'voucher' && link.voucherReady !== true))
    v.fail(409, 'campaign_enabled_voucher_required');
  if (['publish', 'pause', 'complete'].includes(action))
    return campaignOutput(await advanceCampaignLifecycle(
      c, who, workspaceId, companyId, row, action, transition,
    ), now);
  const timestampColumn = `${transition.to}_at`;
  await c.query(
    `UPDATE myfin.marketing_campaigns SET lifecycle=$4,${timestampColumn}=now(),updated_by=$5,updated_at=now()
      WHERE workspace_id=$1 AND company_id=$2 AND id=$3`,
    [workspaceId, companyId, campaignId, transition.to, who.id],
  );
  await appendCampaignEvent(c, {
    workspaceId, companyId, campaignId, campaignVersion: expectedVersion, eventType: transition.to,
    fromLifecycle: row.lifecycle, toLifecycle: transition.to, actorId: who.id,
  });
  return campaignOutput({ ...row, lifecycle: transition.to, updated_at: now }, now);
}

export function marketingAnalyticsRange(query = {}, now = new Date()) {
  const parsed = v.parse(dateQuerySchema, query);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = parsed.to || today.toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.parse(`${to}T00:00:00.000Z`) - 29 * 86400000)
    .toISOString().slice(0, 10);
  const from = parsed.from || defaultFrom;
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs
      || (toMs - fromMs) / 86400000 > 366) v.fail(400, 'invalid_marketing_range');
  return { from, to, toExclusive: new Date(toMs + 86400000).toISOString().slice(0, 10) };
}

export function marketingAnalyticsOutput(row, campaign, range) {
  // A bonus-only campaign is recorded only when points are awarded after
  // payment. Until exposure is snapshotted, it has no defensible quote-level
  // denominator and must not be presented as a zero-percent conversion rate.
  const quotes = campaign.offerKind === 'bonus_points'
    ? null : Number(row.qualified_quotes || 0);
  const conversions = Number(row.conversions || 0);
  const revenue = BigInt(row.attributed_revenue_sen || 0);
  const discount = BigInt(row.discount_cost_sen || 0);
  const budget = campaign.budgetSen === null ? null : BigInt(campaign.budgetSen);
  const uniqueCustomers = Number(row.unique_customers || 0);
  return {
    campaignId: campaign.id,
    campaignVersion: campaign.version,
    from: range.from,
    to: range.to,
    attribution: {
      label: 'Attributed performance',
      causal: false,
      model: 'exact-linked-promotion-version',
      limitation: 'Revenue is associated with exact linked promotion use; it does not estimate incremental or causal lift.',
    },
    metrics: {
      qualifiedQuotes: quotes,
      conversions,
      conversionRateBasisPoints: quotes === null
        ? null : quotes ? Math.round(conversions * 10000 / quotes) : 0,
      attributedRevenueSen: revenue.toString(),
      discountCostSen: discount.toString(),
      averageOrderValueSen: conversions ? (revenue / BigInt(conversions)).toString() : '0',
      voucherUses: Number(row.voucher_uses || 0),
      bonusPointsAwarded: Number(row.bonus_points_awarded || 0),
      reservations: Number(row.reservations || 0),
      attributedReturnOnSpendBasisPoints: budget && budget > 0n
        ? ((revenue - discount) * 10000n / budget).toString() : null,
    },
    customerCohort: uniqueCustomers < 5
      ? { suppressed: true, cohortThreshold: 5 }
      : { suppressed: false, cohortThreshold: 5, uniqueCustomers },
    orderLifecycle: {
      awaitingAcceptance: Number(row.awaiting_acceptance || 0),
      accepted: Number(row.accepted || 0),
      preparing: Number(row.preparing || 0),
      ready: Number(row.ready || 0),
      paid: Number(row.paid || 0),
      cancelled: Number(row.cancelled || 0),
      expired: Number(row.expired || 0),
    },
    reservationLifecycle: {
      active: Number(row.active_reservations || 0),
      consumed: Number(row.consumed_reservations || 0),
      released: Number(row.released_reservations || 0),
    },
  };
}

async function campaignAnalytics(c, workspaceId, companyId, campaign, range) {
  const result = await c.query(
    `WITH campaign_links AS (
       SELECT DISTINCT link.promotion_id,link.promotion_version,version.starts_at,version.ends_at
         FROM myfin.marketing_campaign_version_promotions link
         JOIN myfin.marketing_campaign_versions version
           ON version.workspace_id=link.workspace_id AND version.company_id=link.company_id
          AND version.campaign_id=link.campaign_id AND version.version=link.campaign_version
        WHERE link.workspace_id=$1 AND link.company_id=$2 AND link.campaign_id=$3
     ), qualified AS (
       SELECT DISTINCT snapshot.id,snapshot.customer_id,snapshot.priced_at
         FROM myfin.pricing_snapshots snapshot
         JOIN myfin.pricing_snapshot_discounts discount
           ON discount.workspace_id=snapshot.workspace_id AND discount.company_id=snapshot.company_id
          AND discount.snapshot_id=snapshot.id
        WHERE snapshot.workspace_id=$1 AND snapshot.company_id=$2
          AND snapshot.priced_at >= $4::date AND snapshot.priced_at < $5::date
          AND EXISTS(SELECT 1 FROM campaign_links link
            WHERE link.promotion_id=discount.promotion_id
              AND link.promotion_version=discount.promotion_version
              AND snapshot.priced_at>=link.starts_at
              AND (link.ends_at IS NULL OR snapshot.priced_at<link.ends_at))
     ), matching_redemptions AS (
       SELECT redemption.*,
              CASE WHEN redemption.source_type='customer_order' THEN payment.sale_id ELSE redemption.source_id END AS sale_id
         FROM myfin.promotion_redemptions redemption
         LEFT JOIN myfin.customer_order_payments payment
           ON redemption.source_type='customer_order' AND payment.company_id=redemption.company_id
          AND payment.order_id=redemption.source_id
        WHERE redemption.workspace_id=$1 AND redemption.company_id=$2
          AND redemption.occurred_at >= $4::date AND redemption.occurred_at < $5::date
          AND EXISTS(SELECT 1 FROM campaign_links link
            WHERE link.promotion_id=redemption.promotion_id
              AND link.promotion_version=redemption.promotion_version
              AND redemption.occurred_at>=link.starts_at
              AND (link.ends_at IS NULL OR redemption.occurred_at<link.ends_at))
     ), redemption_sales AS (
       SELECT redemption.sale_id,min(redemption.customer_id) AS customer_id,
              sum(redemption.discount_sen)::bigint AS discount_sen,
              count(*) FILTER(WHERE redemption.voucher_id IS NOT NULL)::bigint AS voucher_uses
         FROM matching_redemptions redemption WHERE redemption.sale_id IS NOT NULL GROUP BY redemption.sale_id
     ), bonus_sales AS (
       SELECT event.source_sale_id AS sale_id,min(event.customer_id) AS customer_id,
              sum(event.points)::bigint AS bonus_points
         FROM myfin.loyalty_point_events event
         JOIN myfin.marketing_campaign_versions bonus_campaign
           ON bonus_campaign.workspace_id=event.workspace_id AND bonus_campaign.company_id=event.company_id
          AND bonus_campaign.campaign_id=event.campaign_id AND bonus_campaign.version=event.campaign_version
        WHERE event.workspace_id=$1 AND event.company_id=$2 AND event.campaign_id=$3
          AND event.kind='bonus' AND event.source_sale_id IS NOT NULL
          AND event.occurred_at >= $4::date AND event.occurred_at < $5::date
          AND event.occurred_at>=bonus_campaign.starts_at
          AND (bonus_campaign.ends_at IS NULL OR event.occurred_at<bonus_campaign.ends_at)
        GROUP BY event.source_sale_id
     ), attributed_sale_ids AS (
       SELECT sale_id FROM redemption_sales UNION SELECT sale_id FROM bonus_sales
     ), attributed_sales AS (
       SELECT ids.sale_id,coalesce(redemption.customer_id,bonus.customer_id) AS customer_id,
              coalesce(redemption.discount_sen,0)::bigint AS discount_sen,
              coalesce(redemption.voucher_uses,0)::bigint AS voucher_uses,
              coalesce(bonus.bonus_points,0)::bigint AS bonus_points
         FROM attributed_sale_ids ids
         LEFT JOIN redemption_sales redemption ON redemption.sale_id=ids.sale_id
         LEFT JOIN bonus_sales bonus ON bonus.sale_id=ids.sale_id
     ), sales_totals AS (
       SELECT count(*)::bigint AS conversions,
              coalesce(sum(round(sale.total*100)::bigint),0)::bigint AS attributed_revenue_sen,
              coalesce(sum(attributed.discount_sen),0)::bigint AS discount_cost_sen,
              count(DISTINCT attributed.customer_id) FILTER(WHERE attributed.customer_id IS NOT NULL)::bigint AS unique_customers,
              coalesce(sum(attributed.voucher_uses),0)::bigint AS voucher_uses,
              coalesce(sum(attributed.bonus_points),0)::bigint AS bonus_points_awarded
         FROM attributed_sales attributed
         JOIN myfin.transactions sale ON sale.company_id=$2 AND sale.id=attributed.sale_id
     ), order_counts AS (
       SELECT count(*) FILTER(WHERE status='awaiting_acceptance')::bigint AS awaiting_acceptance,
              count(*) FILTER(WHERE status='accepted')::bigint AS accepted,
              count(*) FILTER(WHERE status='preparing')::bigint AS preparing,
              count(*) FILTER(WHERE status='ready')::bigint AS ready,
              count(*) FILTER(WHERE status='paid')::bigint AS paid,
              count(*) FILTER(WHERE status='cancelled')::bigint AS cancelled,
              count(*) FILTER(WHERE status='expired')::bigint AS expired
         FROM myfin.customer_order_requests orders
        WHERE orders.company_id=$2 AND (
          EXISTS(SELECT 1 FROM qualified WHERE qualified.id=orders.pricing_snapshot_id)
          OR EXISTS(
            SELECT 1 FROM myfin.customer_order_payments payment
             JOIN attributed_sale_ids attributed ON attributed.sale_id=payment.sale_id
            WHERE payment.company_id=orders.company_id AND payment.order_id=orders.id
          )
        )
     ), reservation_counts AS (
       SELECT count(*)::bigint AS reservations,
              count(*) FILTER(WHERE reservation.state='active')::bigint AS active_reservations,
              count(*) FILTER(WHERE reservation.state='consumed')::bigint AS consumed_reservations,
              count(*) FILTER(WHERE reservation.state='released')::bigint AS released_reservations
         FROM myfin.promotion_reservations reservation
        WHERE reservation.workspace_id=$1 AND reservation.company_id=$2
          AND reservation.reserved_at >= $4::date AND reservation.reserved_at < $5::date
          AND EXISTS(SELECT 1 FROM campaign_links link
            WHERE link.promotion_id=reservation.promotion_id AND link.promotion_version=reservation.promotion_version)
     )
     SELECT (SELECT count(*) FROM qualified)::bigint AS qualified_quotes,sales_totals.*,
            order_counts.*,reservation_counts.*
       FROM sales_totals CROSS JOIN order_counts CROSS JOIN reservation_counts`,
    [workspaceId, companyId, campaign.id, range.from, range.toExclusive],
  );
  return marketingAnalyticsOutput(result.rows[0] || {}, campaign, range);
}

function definitions() {
  return {
    objectives: [...OBJECTIVES], channels: [...CHANNELS], lifecycles: [...LIFECYCLES],
    offerKinds: [...OFFER_KINDS], consentChannels: ['email', 'sms', 'whatsapp'],
  };
}

export function registerMarketingCampaigns(app, { scoped, audit }) {
  app.get('/api/companies/:company/marketing', req => scoped(req, async (c, companyId) => {
    requireMarketingStaff(req.identity);
    const workspaceId = await companyWorkspace(c, companyId);
    const campaigns = await listCampaigns(c, workspaceId, companyId);
    const audiences = await listAudiences(c, workspaceId, companyId, owner(req.identity));
    const promotions = await availablePromotions(c, workspaceId, companyId);
    const counts = Object.fromEntries(['draft', 'scheduled', 'active', 'paused', 'completed', 'archived']
      .map(status => [status, campaigns.filter(campaign => campaign.status === status).length]));
    return {
      workspaceId, campaigns, audiences, availablePromotions: promotions,
      summary: { campaignCount: campaigns.length, audienceCount: audiences.length, ...counts },
      definitions: definitions(),
      attribution: { label: 'Attributed performance', causal: false, model: 'exact-linked-promotion-version' },
    };
  }));

  app.get('/api/companies/:company/marketing/campaigns', req => scoped(req, async (c, companyId) => {
    requireMarketingStaff(req.identity);
    const workspaceId = await companyWorkspace(c, companyId);
    return { workspaceId, campaigns: await listCampaigns(c, workspaceId, companyId) };
  }));

  app.post('/api/companies/:company/marketing/campaigns', req => scoped(req, async (c, companyId) => {
    requireMarketingStaff(req.identity);
    const result = campaignOutput(await saveCampaign(c, req.identity, companyId, randomUUID(), req.body, true));
    await audit(c, req.identity, companyId, 'Marketing campaign created', `${result.name} · version ${result.version}`);
    return result;
  }));

  app.put('/api/companies/:company/marketing/campaigns/:campaignId', req => scoped(req, async (c, companyId) => {
    requireMarketingStaff(req.identity);
    const campaignId = v.parse(v.id, req.params.campaignId);
    const result = campaignOutput(await saveCampaign(c, req.identity, companyId, campaignId, req.body, false));
    await audit(c, req.identity, companyId, 'Marketing campaign versioned', `${result.name} · version ${result.version}`);
    return result;
  }));

  for (const action of Object.keys(transitions)) app.post(
    `/api/companies/:company/marketing/campaigns/:campaignId/${action}`,
    req => scoped(req, async (c, companyId) => {
      requireMarketingStaff(req.identity);
      const campaignId = v.parse(v.id, req.params.campaignId);
      const input = v.parse(transitionSchema, req.body);
      const result = await transitionCampaign(c, req.identity, companyId, campaignId, action, input.expectedVersion);
      await audit(c, req.identity, companyId, transitionAuditActions[action],
        `${result.name} · version ${result.version}`);
      return result;
    }),
  );

  app.post('/api/companies/:company/marketing/campaigns/:campaignId/clone', req => scoped(req, async (c, companyId) => {
    requireMarketingStaff(req.identity);
    const sourceId = v.parse(v.id, req.params.campaignId);
    const input = v.parse(cloneSchema, req.body);
    const workspaceId = await companyWorkspace(c, companyId);
    const source = campaignOutput(await campaignById(c, workspaceId, companyId, sourceId, true));
    if (source.version !== input.expectedVersion) v.fail(409, 'campaign_changed');
    const clonedPromotionLinks = [];
    for (const link of source.promotionLinks) clonedPromotionLinks.push(await clonePromotionIdentity(c, {
      workspaceId, companyId, sourcePromotionId: link.promotionId,
      sourceVersion: link.promotionVersion, actorId: req.identity.id,
    }));
    const cloneId = randomUUID();
    const clone = campaignOutput(await saveCampaign(c, req.identity, companyId, cloneId, {
      expectedVersion: 0, name: input.name || `${source.name} copy`, description: source.description,
      objective: source.objective, channels: source.channels, startsAt: source.startsAt,
      endsAt: source.endsAt, budgetSen: source.budgetSen, currencyCode: source.currencyCode,
      offerKind: source.offerKind, bonusPoints: source.bonusPoints,
      bonusMinimumSpendSen: source.bonusMinimumSpendSen,
      promotionLinks: clonedPromotionLinks, audienceLinks: source.audienceLinks,
    }, true, { sourceCampaignId: source.id, sourceCampaignVersion: source.version }));
    await audit(c, req.identity, companyId, 'Marketing campaign cloned',
      `${source.name} · version ${source.version} → ${clone.name}`);
    return clone;
  }));

  app.get('/api/companies/:company/marketing/campaigns/:campaignId/analytics', req => scoped(req, async (c, companyId) => {
    requireMarketingStaff(req.identity);
    const campaignId = v.parse(v.id, req.params.campaignId);
    const range = marketingAnalyticsRange(req.query || {});
    const workspaceId = await companyWorkspace(c, companyId);
    const campaign = campaignOutput(await campaignById(c, workspaceId, companyId, campaignId));
    return campaignAnalytics(c, workspaceId, companyId, campaign, range);
  }));

  app.get('/api/companies/:company/marketing/audiences', req => scoped(req, async (c, companyId) => {
    requireMarketingStaff(req.identity);
    const workspaceId = await companyWorkspace(c, companyId);
    return { workspaceId, audiences: await listAudiences(
      c, workspaceId, companyId, owner(req.identity),
    ) };
  }));

  app.post('/api/companies/:company/marketing/audiences', req => scoped(req, async (c, companyId) => {
    requireMarketingStaff(req.identity);
    const result = await saveAudience(c, req.identity, companyId, randomUUID(), req.body, true);
    await audit(c, req.identity, companyId, 'Marketing audience created', `${result.name} · ${result.scope}`);
    return result;
  }));

  app.put('/api/companies/:company/marketing/audiences/:audienceId', req => scoped(req, async (c, companyId) => {
    requireMarketingStaff(req.identity);
    const audienceId = v.parse(v.id, req.params.audienceId);
    const result = await saveAudience(c, req.identity, companyId, audienceId, req.body, false);
    await audit(c, req.identity, companyId, 'Marketing audience versioned', `${result.name} · version ${result.version}`);
    return result;
  }));
}
