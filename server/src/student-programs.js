import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { owner, requireCapability } from './access.js';
import {
  normalizeStudentEligibilityChange, normalizeVoucherCode, voucherLookupDigest,
} from './student-promotions.js';
import * as v from './validation.js';

const MAX_SEN = 9_000_000_000_000_000;
const instant = z.string().trim().max(40).refine(value => {
  const date = new Date(value);
  return value.includes('T') && Number.isFinite(date.getTime());
}, 'invalid_instant').transform(value => new Date(value).toISOString());
const nullableInstant = z.union([instant, z.null()]);
const nullablePositiveInteger = z.union([
  z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), z.null(),
]);
const nullablePerCustomerLimit = z.union([
  z.number().int().min(1).max(1_000_000), z.null(),
]);
const maskedHint = z.string().trim().max(11).regex(/^(?:|\*{3}[A-Za-z0-9._-]{1,8})$/);

const listSchema = z.strictObject({
  q: z.string().trim().max(120).default(''),
  status: z.enum(['all', 'unreviewed', 'pending', 'verified', 'rejected', 'revoked']).default('all'),
  limit: z.coerce.number().int().min(1).max(250).default(100),
  after: v.id.optional().default(''),
});

const reviewSchema = z.strictObject({
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['pending', 'verified', 'rejected', 'revoked']),
  institutionName: z.string().trim().min(2).max(160),
  referenceHint: maskedHint.default(''),
  validUntil: nullableInstant.optional().default(null),
  reason: z.string().trim().max(500).default(''),
});

const productTarget = z.strictObject({
  productId: v.id,
  variantId: z.union([v.id, z.literal('')]).default(''),
});
const categoryTarget = z.strictObject({
  category: z.string().trim().min(1).max(120),
  subcategory: z.string().trim().max(120).default(''),
});
const promotionSchema = z.strictObject({
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  name: z.string().trim().min(1).max(160),
  enabled: z.boolean(),
  redemptionMode: z.enum(['automatic', 'voucher']),
  validFrom: instant,
  validUntil: nullableInstant.default(null),
  discountType: z.enum(['percentage', 'fixed', 'free_item']),
  discountBasisPoints: z.union([z.number().int().min(1).max(10_000), z.null()]).default(null),
  discountSen: z.union([z.number().int().min(1).max(MAX_SEN), z.null()]).default(null),
  maxDiscountSen: z.union([z.number().int().min(1).max(MAX_SEN), z.null()]).default(null),
  rewardProductId: z.union([v.id, z.literal('')]).default(''),
  rewardVariantId: z.union([v.id, z.literal('')]).default(''),
  rewardQuantityMilli: z.union([
    z.number().int().min(1).max(1_000_000_000), z.null(),
  ]).default(null),
  minSubtotalSen: z.number().int().min(0).max(MAX_SEN).default(0),
  maxTotalRedemptions: nullablePositiveInteger.default(null),
  perCustomerLimit: nullablePerCustomerLimit.default(null),
  requiresCustomer: z.boolean().default(false),
  requiresStudent: z.boolean().default(false),
  stackable: z.boolean().default(false),
  priority: z.number().int().min(-1_000_000).max(1_000_000).default(0),
  productTargets: z.array(productTarget).max(1000).default([]),
  categoryTargets: z.array(categoryTarget).max(1000).default([]),
  customerTargets: z.array(v.id).max(1000).default([]),
}).superRefine((input, ctx) => {
  if (input.validUntil && input.validUntil <= input.validFrom)
    ctx.addIssue({ code: 'custom', message: 'invalid_promotion_validity' });
  if ((input.discountType === 'percentage') !== (input.discountBasisPoints !== null))
    ctx.addIssue({ code: 'custom', message: 'invalid_promotion_discount' });
  if ((input.discountType === 'fixed') !== (input.discountSen !== null))
    ctx.addIssue({ code: 'custom', message: 'invalid_promotion_discount' });
  const freeItem = input.discountType === 'free_item';
  if (freeItem !== Boolean(input.rewardProductId)
      || freeItem !== (input.rewardQuantityMilli !== null)
      || (freeItem && input.maxDiscountSen !== null)
      || (!freeItem && Boolean(input.rewardVariantId)))
    ctx.addIssue({ code: 'custom', message: 'invalid_free_item_reward' });
  if (input.requiresStudent && !input.requiresCustomer)
    ctx.addIssue({ code: 'custom', message: 'student_promotion_requires_customer' });
  if (input.perCustomerLimit && input.maxTotalRedemptions
      && input.perCustomerLimit > input.maxTotalRedemptions)
    ctx.addIssue({ code: 'custom', message: 'customer_limit_exceeds_total' });
});

const voucherVersionFields = {
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  enabled: z.boolean(),
  validFrom: instant,
  validUntil: nullableInstant.default(null),
  maxRedemptions: nullablePositiveInteger.default(null),
  perCustomerLimit: nullablePerCustomerLimit.default(null),
};
const voucherCreateSchema = z.strictObject({
  ...voucherVersionFields,
  code: z.string().min(1).max(128),
}).superRefine(validateVoucherLimits);
const voucherUpdateSchema = z.strictObject(voucherVersionFields).superRefine(validateVoucherLimits);

function validateVoucherLimits(input, ctx) {
  if (input.validUntil && input.validUntil <= input.validFrom)
    ctx.addIssue({ code: 'custom', message: 'invalid_voucher_validity' });
  if (input.perCustomerLimit && input.maxRedemptions && input.perCustomerLimit > input.maxRedemptions)
    ctx.addIssue({ code: 'custom', message: 'customer_limit_exceeds_total' });
}

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const requestDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const literalLike = value => value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
const numberOrNull = value => value === null || value === undefined ? null : Number(value);

export function studentProgramPolicy() {
  return Object.freeze({
    pricingApplied: true,
    checkoutIntegration: 'customer_ordering_live',
    rawDocumentUpload: false,
    rawStudentIdentifierStorage: false,
    voucherCodesReturned: false,
    loyaltyScope: 'workspace',
  });
}

export function studentOutput(row) {
  return {
    customerId: row.customer_id,
    displayName: row.profile_name || row.account_name || 'Customer',
    email: row.primary_email || '',
    phone: row.profile_phone || '',
    status: row.status || 'unreviewed',
    institutionName: row.institution_name || '',
    referenceHint: row.reference_hint || '',
    validFrom: row.valid_from || null,
    validUntil: row.valid_until || null,
    version: Number(row.version || 0),
    requestedAt: row.requested_at || null,
    updatedAt: row.updated_at || null,
    lastOrderAt: row.last_order_at || null,
  };
}

export function voucherOutput(row) {
  return {
    id: row.id,
    promotionId: row.promotion_id,
    codeHint: row.code_hint,
    version: Number(row.version),
    enabled: !!row.enabled,
    validFrom: row.valid_from,
    validUntil: row.valid_until || null,
    maxRedemptions: numberOrNull(row.max_redemptions),
    perCustomerLimit: numberOrNull(row.per_customer_limit),
    redeemedCount: Number(row.redeemed_count || 0),
    updatedAt: row.updated_at || null,
  };
}

export function promotionOutput(row, vouchers = []) {
  return {
    id: row.id,
    version: Number(row.version),
    name: row.name,
    enabled: !!row.enabled,
    redemptionMode: row.redemption_mode,
    validFrom: row.valid_from,
    validUntil: row.valid_until || null,
    currencyCode: row.currency_code,
    discountType: row.discount_type,
    discountBasisPoints: numberOrNull(row.discount_basis_points),
    discountSen: numberOrNull(row.discount_sen),
    maxDiscountSen: numberOrNull(row.max_discount_sen),
    rewardProductId: row.reward_product_id || '',
    rewardVariantId: row.reward_variant_id || '',
    rewardQuantityMilli: numberOrNull(row.reward_quantity_milli),
    minSubtotalSen: Number(row.min_subtotal_sen || 0),
    maxTotalRedemptions: numberOrNull(row.max_total_redemptions),
    perCustomerLimit: numberOrNull(row.per_customer_limit),
    requiresCustomer: !!row.requires_customer,
    requiresStudent: !!row.requires_student,
    stackable: !!row.stackable,
    priority: Number(row.priority || 0),
    productTargets: row.product_targets || [],
    categoryTargets: row.category_targets || [],
    customerTargets: row.customer_targets || [],
    redeemedCount: Number(row.redeemed_count || 0),
    updatedAt: row.updated_at || null,
    vouchers,
    applicationState: row.enabled ? 'active_pricing' : 'disabled',
  };
}

async function companyWorkspace(c, companyId) {
  const result = await c.query('SELECT workspace_id FROM myfin.companies WHERE id=$1', [companyId]);
  if (!result.rowCount) v.fail(404, 'not_found');
  return result.rows[0].workspace_id;
}

async function customerBelongsToWorkspace(c, workspaceId, customerId) {
  const result = await c.query(
    `SELECT EXISTS(
       SELECT 1 FROM myfin.customer_workspace_profiles p
        WHERE p.workspace_id=$1 AND p.customer_id=$2
       UNION ALL
       SELECT 1 FROM myfin.customer_order_requests o
       JOIN myfin.companies co ON co.id=o.company_id
        WHERE co.workspace_id=$1 AND o.customer_id=$2
       UNION ALL
       SELECT 1 FROM myfin.student_eligibilities e
        WHERE e.workspace_id=$1 AND e.customer_id=$2
     ) AS found`,
    [workspaceId, customerId],
  );
  return result.rows[0]?.found === true;
}

async function customerVisibleFromCompany(c, workspaceId, companyId, customerId, workspaceWide) {
  if (workspaceWide) return customerBelongsToWorkspace(c, workspaceId, customerId);
  const result = await c.query(
    `SELECT EXISTS(
       SELECT 1 FROM myfin.customer_order_requests o
        WHERE o.company_id=$2 AND o.customer_id=$3
       UNION ALL
       SELECT 1 FROM myfin.customer_company_links link
        WHERE link.company_id=$2 AND link.customer_id=$3
     ) AS found
     FROM myfin.companies company WHERE company.id=$2 AND company.workspace_id=$1`,
    [workspaceId, companyId, customerId],
  );
  return result.rows[0]?.found === true;
}

async function validatePromotionTargets(c, workspaceId, companyId, input) {
  const productKeys = input.productTargets.map(target => `${target.productId}\u0000${target.variantId}`);
  const categories = input.categoryTargets.map(target => ({
    category: target.category.trim().toLowerCase(),
    subcategory: target.subcategory.trim().toLowerCase(),
  }));
  const categoryKeys = categories.map(target => `${target.category}\u0000${target.subcategory}`);
  if (new Set(productKeys).size !== productKeys.length) v.fail(400, 'duplicate_promotion_product');
  if (new Set(categoryKeys).size !== categoryKeys.length) v.fail(400, 'duplicate_promotion_category');
  if (new Set(input.customerTargets).size !== input.customerTargets.length) v.fail(400, 'duplicate_promotion_customer');

  if (input.productTargets.length) {
    const invalid = await c.query(
      `SELECT target.product_id,target.variant_id
         FROM jsonb_to_recordset($2::jsonb) AS target(product_id text,variant_id text)
         LEFT JOIN myfin.products p ON p.company_id=$1 AND p.id=target.product_id
         LEFT JOIN myfin.product_variants pv ON pv.company_id=$1 AND pv.product_id=target.product_id
          AND pv.id=target.variant_id
        WHERE p.id IS NULL OR (target.variant_id<>'' AND pv.id IS NULL)
        LIMIT 1`,
      [companyId, JSON.stringify(input.productTargets.map(target => ({
        product_id: target.productId, variant_id: target.variantId,
      })))],
    );
    if (invalid.rowCount) v.fail(400, 'promotion_product_outside_company');
  }
  if (input.discountType === 'free_item') {
    const reward = await c.query(
      `SELECT p.id,
              EXISTS(SELECT 1 FROM myfin.product_variants any_variant
                WHERE any_variant.company_id=p.company_id AND any_variant.product_id=p.id) AS has_variants,
              EXISTS(SELECT 1 FROM myfin.product_variants exact_variant
                WHERE exact_variant.company_id=p.company_id AND exact_variant.product_id=p.id
                  AND exact_variant.id=$3) AS reward_variant_exists
         FROM myfin.products p
        WHERE p.company_id=$1 AND p.id=$2`,
      [companyId, input.rewardProductId, input.rewardVariantId],
    );
    if (!reward.rowCount) v.fail(400, 'promotion_reward_outside_company');
    if (reward.rows[0].has_variants && !input.rewardVariantId)
      v.fail(400, 'promotion_reward_variant_required');
    if (input.rewardVariantId && !reward.rows[0].reward_variant_exists)
      v.fail(400, 'promotion_reward_outside_company');
  }
  for (const customerId of input.customerTargets) {
    if (!await customerBelongsToWorkspace(c, workspaceId, customerId))
      v.fail(400, 'promotion_customer_outside_workspace');
  }
  return { ...input, categoryTargets: categories };
}

async function listPrograms(c, companyId, query, who) {
  const workspaceId = await companyWorkspace(c, companyId);
  const workspaceWide = owner(who);
  const search = query.q ? `%${literalLike(query.q.toLowerCase())}%` : '';
  const students = await c.query(
    `WITH workspace_customers AS (
       SELECT customer_id FROM myfin.customer_workspace_profiles WHERE workspace_id=$1 AND $6
       UNION SELECT o.customer_id FROM myfin.customer_order_requests o
         JOIN myfin.companies co ON co.id=o.company_id
        WHERE co.workspace_id=$1 AND ($6 OR o.company_id=$7) AND o.customer_id IS NOT NULL
       UNION SELECT link.customer_id FROM myfin.customer_company_links link
         JOIN myfin.companies co ON co.id=link.company_id
        WHERE co.workspace_id=$1 AND ($6 OR link.company_id=$7)
       UNION SELECT customer_id FROM myfin.student_eligibilities WHERE workspace_id=$1 AND $6
     ), last_orders AS (
       SELECT o.customer_id,max(o.created_at) AS last_order_at
         FROM myfin.customer_order_requests o JOIN myfin.companies co ON co.id=o.company_id
        WHERE co.workspace_id=$1 AND ($6 OR o.company_id=$7) AND o.customer_id IS NOT NULL GROUP BY o.customer_id
     )
     SELECT wc.customer_id,a.display_name AS account_name,a.primary_email,
            p.display_name AS profile_name,p.phone AS profile_phone,
            e.status,e.institution_name,e.reference_hint,e.valid_from,e.valid_until,e.version,
            e.requested_at,e.updated_at,lo.last_order_at
       FROM workspace_customers wc JOIN myfin.customer_accounts a ON a.id=wc.customer_id
       LEFT JOIN myfin.customer_workspace_profiles p ON p.workspace_id=$1 AND p.customer_id=wc.customer_id
       LEFT JOIN myfin.student_eligibilities e ON e.workspace_id=$1 AND e.customer_id=wc.customer_id
       LEFT JOIN last_orders lo ON lo.customer_id=wc.customer_id
      WHERE ($2='all' OR ($2='unreviewed' AND e.status IS NULL) OR e.status=$2)
        AND ($3='' OR lower(coalesce(p.display_name,'')) LIKE $3 ESCAPE '\\'
                   OR lower(coalesce(a.display_name,'')) LIKE $3 ESCAPE '\\'
                   OR lower(coalesce(a.primary_email,'')) LIKE $3 ESCAPE '\\')
        AND ($4='' OR wc.customer_id>$4)
      ORDER BY wc.customer_id LIMIT $5`,
    [workspaceId, query.status, search, query.after, query.limit + 1, workspaceWide, companyId],
  );
  const promotionRows = await c.query(
    `SELECT p.id,p.version,p.updated_at,pv.name,pv.enabled,pv.redemption_mode,pv.valid_from,pv.valid_until,
            pv.currency_code,pv.discount_type,pv.discount_basis_points,pv.discount_sen,pv.max_discount_sen,
            pv.reward_product_id,pv.reward_variant_id,pv.reward_quantity_milli,
            pv.min_subtotal_sen,pv.max_total_redemptions,pv.per_customer_limit,pv.requires_customer,
            pv.requires_student,pv.stackable,pv.priority,coalesce(usage.redemption_count,0) AS redeemed_count,
            coalesce((SELECT jsonb_agg(jsonb_build_object('productId',t.product_id,'variantId',coalesce(t.variant_id,''))
              ORDER BY t.product_id,t.variant_key) FROM myfin.promotion_version_products t
              WHERE t.workspace_id=p.workspace_id AND t.company_id=p.company_id
                AND t.promotion_id=p.id AND t.promotion_version=p.version),'[]'::jsonb) AS product_targets,
            coalesce((SELECT jsonb_agg(jsonb_build_object('category',t.category_key,'subcategory',t.subcategory_key)
              ORDER BY t.category_key,t.subcategory_key) FROM myfin.promotion_version_categories t
              WHERE t.workspace_id=p.workspace_id AND t.company_id=p.company_id
                AND t.promotion_id=p.id AND t.promotion_version=p.version),'[]'::jsonb) AS category_targets,
            coalesce((SELECT jsonb_agg(t.customer_id ORDER BY t.customer_id)
              FROM myfin.promotion_version_customers t WHERE t.workspace_id=p.workspace_id
                AND t.company_id=p.company_id AND t.promotion_id=p.id
                AND t.promotion_version=p.version),'[]'::jsonb) AS customer_targets
       FROM myfin.promotions p JOIN myfin.promotion_versions pv
         ON pv.workspace_id=p.workspace_id AND pv.company_id=p.company_id
        AND pv.promotion_id=p.id AND pv.version=p.version
       LEFT JOIN myfin.promotion_usage_counters usage
         ON usage.workspace_id=p.workspace_id AND usage.company_id=p.company_id AND usage.promotion_id=p.id
      WHERE p.workspace_id=$1 AND p.company_id=$2 ORDER BY pv.priority DESC,pv.name,p.id`,
    [workspaceId, companyId],
  );
  const voucherRows = await c.query(
    `SELECT voucher.id,voucher.promotion_id,voucher.code_hint,voucher.version,voucher.updated_at,
            version.enabled,version.valid_from,version.valid_until,version.max_redemptions,
            version.per_customer_limit,coalesce(usage.redemption_count,0) AS redeemed_count
       FROM myfin.promotion_vouchers voucher JOIN myfin.promotion_voucher_versions version
         ON version.workspace_id=voucher.workspace_id AND version.company_id=voucher.company_id
        AND version.promotion_id=voucher.promotion_id AND version.voucher_id=voucher.id
        AND version.version=voucher.version
       LEFT JOIN myfin.promotion_voucher_usage_counters usage
         ON usage.workspace_id=voucher.workspace_id AND usage.company_id=voucher.company_id
        AND usage.promotion_id=voucher.promotion_id AND usage.voucher_id=voucher.id
      WHERE voucher.workspace_id=$1 AND voucher.company_id=$2
      ORDER BY voucher.promotion_id,voucher.code_hint,voucher.id`,
    [workspaceId, companyId],
  );
  const vouchers = voucherRows.rows.map(voucherOutput);
  const visible = students.rows.slice(0, query.limit);
  return {
    workspaceId,
    students: visible.map(studentOutput),
    next: students.rowCount > query.limit ? visible.at(-1)?.customer_id || null : null,
    promotions: promotionRows.rows.map(row => promotionOutput(
      row, vouchers.filter(voucher => voucher.promotionId === row.id),
    )),
    policy: studentProgramPolicy(),
  };
}

function actionFor(fromStatus, toStatus) {
  if (toStatus === 'pending') return 'request';
  if (toStatus === 'verified') return fromStatus === 'verified' ? 'renew' : 'verify';
  if (toStatus === 'rejected') return 'reject';
  return 'revoke';
}

async function reviewStudent(c, who, companyId, customerId, input) {
  const workspaceId = await companyWorkspace(c, companyId);
  if (!await customerVisibleFromCompany(c, workspaceId, companyId, customerId, owner(who)))
    v.fail(404, 'customer_not_found');
  const currentResult = await c.query(
    `SELECT status,version,valid_until FROM myfin.student_eligibilities
      WHERE workspace_id=$1 AND customer_id=$2 FOR UPDATE`,
    [workspaceId, customerId],
  );
  const currentRow = currentResult.rows[0] || null;
  const current = currentRow ? {
    status: currentRow.status,
    version: Number(currentRow.version),
    validUntil: currentRow.valid_until instanceof Date
      ? currentRow.valid_until.toISOString() : currentRow.valid_until,
  } : null;
  if (Number(current?.version || 0) !== input.expectedVersion) v.fail(409, 'student_eligibility_changed');
  const now = new Date().toISOString();
  const verified = input.status === 'verified';
  const change = normalizeStudentEligibilityChange({
    workspaceId,
    customerId,
    status: input.status,
    institutionName: input.institutionName,
    verificationMethod: verified ? 'staff_attestation' : undefined,
    referenceDigest: verified ? createHash('sha256').update(randomUUID()).digest('hex') : undefined,
    referenceHint: input.referenceHint,
    validFrom: verified ? now : undefined,
    validUntil: verified ? input.validUntil : undefined,
    reason: input.reason,
    expectedVersion: input.expectedVersion,
  }, current, now);
  const saved = await c.query(
    `INSERT INTO myfin.student_eligibilities(
       workspace_id,customer_id,status,institution_name,verification_method,verification_reference_digest,
       reference_hint,valid_from,valid_until,version,updated_by_staff)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT(workspace_id,customer_id) DO UPDATE SET
       status=EXCLUDED.status,institution_name=EXCLUDED.institution_name,
       verification_method=EXCLUDED.verification_method,
       verification_reference_digest=EXCLUDED.verification_reference_digest,
       reference_hint=EXCLUDED.reference_hint,valid_from=EXCLUDED.valid_from,valid_until=EXCLUDED.valid_until,
       version=EXCLUDED.version,updated_by_staff=EXCLUDED.updated_by_staff,updated_by_customer=NULL,
       requested_at=CASE WHEN EXCLUDED.status='pending' THEN now() ELSE student_eligibilities.requested_at END,
       updated_at=now()
     WHERE student_eligibilities.version=$12
     RETURNING customer_id,status,institution_name,reference_hint,valid_from,valid_until,version,requested_at,updated_at`,
    [workspaceId, customerId, change.status, change.institutionName,
      change.verificationMethod || null, change.referenceDigest || null, change.referenceHint,
      change.validFrom, change.validUntil, change.version, who.id, change.expectedVersion],
  );
  if (!saved.rowCount) v.fail(409, 'student_eligibility_changed');
  await c.query(
    `INSERT INTO myfin.student_eligibility_events(
       workspace_id,id,customer_id,version,action,from_status,to_status,actor_type,staff_actor_id,
       institution_name,verification_method,verification_reference_digest,reference_hint,
       valid_from,valid_until,reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,'staff',$8,$9,$10,$11,$12,$13,$14,$15)`,
    [workspaceId, randomUUID(), customerId, change.version, actionFor(current?.status || null, change.status),
      current?.status || null, change.status, who.id, change.institutionName,
      change.verificationMethod || null, change.referenceDigest || null, change.referenceHint,
      change.validFrom, change.validUntil, change.reason],
  );
  return studentOutput(saved.rows[0]);
}

async function savePromotion(c, who, companyId, promotionId, rawInput, creating) {
  let input = v.parse(promotionSchema, rawInput);
  if ((creating && input.expectedVersion !== 0) || (!creating && input.expectedVersion === 0))
    v.fail(409, 'promotion_changed');
  const workspaceId = await companyWorkspace(c, companyId);
  input = await validatePromotionTargets(c, workspaceId, companyId, input);
  const current = await c.query(
    `SELECT version FROM myfin.promotions
      WHERE workspace_id=$1 AND company_id=$2 AND id=$3 FOR UPDATE`,
    [workspaceId, companyId, promotionId],
  );
  if (Number(current.rows[0]?.version || 0) !== input.expectedVersion) v.fail(409, 'promotion_changed');
  const version = input.expectedVersion + 1;
  let changed;
  if (creating) {
    changed = await c.query(
      `INSERT INTO myfin.promotions(workspace_id,company_id,id,version,updated_by)
       VALUES($1,$2,$3,$4,$5) RETURNING updated_at`,
      [workspaceId, companyId, promotionId, version, who.id],
    );
  } else {
    changed = await c.query(
      `UPDATE myfin.promotions SET version=$4,updated_by=$5,updated_at=now()
        WHERE workspace_id=$1 AND company_id=$2 AND id=$3 AND version=$6 RETURNING updated_at`,
      [workspaceId, companyId, promotionId, version, who.id, input.expectedVersion],
    );
  }
  if (!changed.rowCount) v.fail(409, 'promotion_changed');
  const digest = requestDigest({ promotionId, version, ...input, expectedVersion: undefined });
  await c.query(
    `INSERT INTO myfin.promotion_versions(
       workspace_id,company_id,promotion_id,version,name,enabled,redemption_mode,valid_from,valid_until,
       currency_code,discount_type,discount_basis_points,discount_sen,max_discount_sen,min_subtotal_sen,
       reward_product_id,reward_variant_id,reward_quantity_milli,max_total_redemptions,per_customer_limit,
       requires_customer,requires_student,stackable,priority,request_digest,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'MYR',$10,$11,$12,$13,$14,nullif($15,''),nullif($16,''),$17,
       $18,$19,$20,$21,$22,$23,$24,$25)`,
    [workspaceId, companyId, promotionId, version, input.name, input.enabled, input.redemptionMode,
      input.validFrom, input.validUntil, input.discountType, input.discountBasisPoints, input.discountSen,
      input.maxDiscountSen, input.minSubtotalSen, input.rewardProductId, input.rewardVariantId,
      input.rewardQuantityMilli, input.maxTotalRedemptions, input.perCustomerLimit,
      input.requiresCustomer, input.requiresStudent, input.stackable, input.priority, digest, who.id],
  );
  if (input.productTargets.length) await c.query(
    `INSERT INTO myfin.promotion_version_products(
       workspace_id,company_id,promotion_id,promotion_version,product_id,variant_id)
     SELECT $1,$2,$3,$4,target.product_id,nullif(target.variant_id,'')
       FROM jsonb_to_recordset($5::jsonb) AS target(product_id text,variant_id text)`,
    [workspaceId, companyId, promotionId, version, JSON.stringify(input.productTargets.map(target => ({
      product_id: target.productId, variant_id: target.variantId,
    })))],
  );
  if (input.categoryTargets.length) await c.query(
    `INSERT INTO myfin.promotion_version_categories(
       workspace_id,company_id,promotion_id,promotion_version,category_key,subcategory_key)
     SELECT $1,$2,$3,$4,target.category,target.subcategory
       FROM jsonb_to_recordset($5::jsonb) AS target(category text,subcategory text)`,
    [workspaceId, companyId, promotionId, version, JSON.stringify(input.categoryTargets)],
  );
  if (input.customerTargets.length) await c.query(
    `INSERT INTO myfin.promotion_version_customers(
       workspace_id,company_id,promotion_id,promotion_version,customer_id)
     SELECT $1,$2,$3,$4,value FROM jsonb_array_elements_text($5::jsonb)`,
    [workspaceId, companyId, promotionId, version, JSON.stringify(input.customerTargets)],
  );
  return promotionOutput({
    id: promotionId, version, updated_at: changed.rows[0].updated_at,
    name: input.name, enabled: input.enabled, redemption_mode: input.redemptionMode,
    valid_from: input.validFrom, valid_until: input.validUntil, currency_code: 'MYR',
    discount_type: input.discountType, discount_basis_points: input.discountBasisPoints,
    discount_sen: input.discountSen, max_discount_sen: input.maxDiscountSen,
    reward_product_id: input.rewardProductId, reward_variant_id: input.rewardVariantId,
    reward_quantity_milli: input.rewardQuantityMilli,
    min_subtotal_sen: input.minSubtotalSen, max_total_redemptions: input.maxTotalRedemptions,
    per_customer_limit: input.perCustomerLimit, requires_customer: input.requiresCustomer,
    requires_student: input.requiresStudent, stackable: input.stackable, priority: input.priority,
    product_targets: input.productTargets, category_targets: input.categoryTargets,
    customer_targets: input.customerTargets, redeemed_count: 0,
  });
}

async function promotionForVoucher(c, workspaceId, companyId, promotionId) {
  const result = await c.query(
    `SELECT p.version,pv.redemption_mode,pv.valid_from,pv.valid_until
       FROM myfin.promotions p JOIN myfin.promotion_versions pv
         ON pv.workspace_id=p.workspace_id AND pv.company_id=p.company_id
        AND pv.promotion_id=p.id AND pv.version=p.version
      WHERE p.workspace_id=$1 AND p.company_id=$2 AND p.id=$3 FOR UPDATE OF p`,
    [workspaceId, companyId, promotionId],
  );
  if (!result.rowCount) v.fail(404, 'promotion_not_found');
  if (result.rows[0].redemption_mode !== 'voucher') v.fail(409, 'promotion_not_voucher');
  return result.rows[0];
}

async function createVoucher(c, who, companyId, promotionId, rawInput, voucherPepper) {
  if (typeof voucherPepper !== 'string' || voucherPepper.length < 32)
    v.fail(503, 'voucher_secret_unavailable');
  const workspaceId = await companyWorkspace(c, companyId);
  const input = v.parse(voucherCreateSchema, rawInput);
  if (input.expectedVersion !== 0) v.fail(409, 'voucher_changed');
  await promotionForVoucher(c, workspaceId, companyId, promotionId);
  const normalizedCode = normalizeVoucherCode(input.code);
  const lookupDigest = voucherLookupDigest(voucherPepper, normalizedCode);
  const duplicate = await c.query(
    'SELECT 1 FROM myfin.promotion_vouchers WHERE company_id=$1 AND code_lookup_digest=$2',
    [companyId, lookupDigest],
  );
  if (duplicate.rowCount) v.fail(409, 'voucher_code_exists');
  const voucherId = randomUUID();
  const codeHint = `***${normalizedCode.slice(-4)}`;
  const version = 1;
  const saved = await c.query(
    `INSERT INTO myfin.promotion_vouchers(
       workspace_id,company_id,id,promotion_id,code_lookup_digest,code_hint,version,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING updated_at`,
    [workspaceId, companyId, voucherId, promotionId, lookupDigest, codeHint, version, who.id],
  );
  await c.query(
    `INSERT INTO myfin.promotion_voucher_versions(
       workspace_id,company_id,promotion_id,voucher_id,version,enabled,valid_from,valid_until,
       max_redemptions,per_customer_limit,request_digest,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [workspaceId, companyId, promotionId, voucherId, version, input.enabled, input.validFrom,
      input.validUntil, input.maxRedemptions, input.perCustomerLimit,
      requestDigest({ voucherId, version, codeHint, enabled: input.enabled, validFrom: input.validFrom,
        validUntil: input.validUntil, maxRedemptions: input.maxRedemptions,
        perCustomerLimit: input.perCustomerLimit }), who.id],
  );
  return voucherOutput({ id: voucherId, promotion_id: promotionId, code_hint: codeHint, version,
    enabled: input.enabled, valid_from: input.validFrom, valid_until: input.validUntil,
    max_redemptions: input.maxRedemptions, per_customer_limit: input.perCustomerLimit,
    redeemed_count: 0, updated_at: saved.rows[0].updated_at });
}

async function updateVoucher(c, who, companyId, promotionId, voucherId, rawInput) {
  const workspaceId = await companyWorkspace(c, companyId);
  const input = v.parse(voucherUpdateSchema, rawInput);
  if (input.expectedVersion === 0) v.fail(409, 'voucher_changed');
  await promotionForVoucher(c, workspaceId, companyId, promotionId);
  const current = await c.query(
    `SELECT voucher.version,voucher.code_hint,coalesce(usage.redemption_count,0) AS redeemed_count
       FROM myfin.promotion_vouchers voucher
       LEFT JOIN myfin.promotion_voucher_usage_counters usage
         ON usage.workspace_id=voucher.workspace_id AND usage.company_id=voucher.company_id
        AND usage.promotion_id=voucher.promotion_id AND usage.voucher_id=voucher.id
      WHERE voucher.workspace_id=$1 AND voucher.company_id=$2
        AND voucher.promotion_id=$3 AND voucher.id=$4 FOR UPDATE OF voucher`,
    [workspaceId, companyId, promotionId, voucherId],
  );
  if (!current.rowCount) v.fail(404, 'voucher_not_found');
  if (Number(current.rows[0].version) !== input.expectedVersion) v.fail(409, 'voucher_changed');
  const version = input.expectedVersion + 1;
  const saved = await c.query(
    `UPDATE myfin.promotion_vouchers SET version=$5,updated_by=$6,updated_at=now()
      WHERE workspace_id=$1 AND company_id=$2 AND promotion_id=$3 AND id=$4 AND version=$7
      RETURNING updated_at`,
    [workspaceId, companyId, promotionId, voucherId, version, who.id, input.expectedVersion],
  );
  if (!saved.rowCount) v.fail(409, 'voucher_changed');
  const codeHint = current.rows[0].code_hint;
  await c.query(
    `INSERT INTO myfin.promotion_voucher_versions(
       workspace_id,company_id,promotion_id,voucher_id,version,enabled,valid_from,valid_until,
       max_redemptions,per_customer_limit,request_digest,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [workspaceId, companyId, promotionId, voucherId, version, input.enabled, input.validFrom,
      input.validUntil, input.maxRedemptions, input.perCustomerLimit,
      requestDigest({ voucherId, version, codeHint, enabled: input.enabled, validFrom: input.validFrom,
        validUntil: input.validUntil, maxRedemptions: input.maxRedemptions,
        perCustomerLimit: input.perCustomerLimit }), who.id],
  );
  return voucherOutput({ id: voucherId, promotion_id: promotionId, code_hint: codeHint, version,
    enabled: input.enabled, valid_from: input.validFrom, valid_until: input.validUntil,
    max_redemptions: input.maxRedemptions, per_customer_limit: input.perCustomerLimit,
    redeemed_count: current.rows[0].redeemed_count, updated_at: saved.rows[0].updated_at });
}

export function registerStudentPrograms(app, {
  scoped, audit, voucherPepper = process.env.MYFIN_VOUCHER_HMAC_SECRET,
}) {
  app.get('/api/companies/:company/student-programs', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'studentProgramsRead');
    return listPrograms(c, companyId, v.parse(listSchema, req.query || {}), req.identity);
  }));

  app.put('/api/companies/:company/student-eligibilities/:customerId', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'studentEligibilityReview');
    if (!owner(req.identity)) v.fail(403, 'access_denied');
    const customerId = v.parse(v.id, req.params.customerId);
    const result = await reviewStudent(c, req.identity, companyId, customerId, v.parse(reviewSchema, req.body));
    await audit(c, req.identity, companyId, 'Student eligibility reviewed',
      `${customerId} · ${result.status} · ${result.referenceHint || 'no reference hint'}`);
    return result;
  }));

  app.post('/api/companies/:company/student-promotions', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'promotionsManage');
    const promotionId = randomUUID();
    const result = await savePromotion(c, req.identity, companyId, promotionId, req.body, true);
    await audit(c, req.identity, companyId, 'Promotion configured',
      `${result.name} · version ${result.version} · ${result.enabled ? 'pricing active' : 'disabled'}`);
    return result;
  }));

  app.put('/api/companies/:company/student-promotions/:promotionId', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'promotionsManage');
    const promotionId = v.parse(v.id, req.params.promotionId);
    const result = await savePromotion(c, req.identity, companyId, promotionId, req.body, false);
    await audit(c, req.identity, companyId, 'Promotion configured',
      `${result.name} · version ${result.version} · ${result.enabled ? 'pricing active' : 'disabled'}`);
    return result;
  }));

  app.post('/api/companies/:company/student-promotions/:promotionId/vouchers', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'promotionsManage');
    const promotionId = v.parse(v.id, req.params.promotionId);
    const result = await createVoucher(c, req.identity, companyId, promotionId, req.body, voucherPepper);
    await audit(c, req.identity, companyId, 'Voucher configured',
      `${result.codeHint} · version ${result.version} · configured only`);
    return result;
  }));

  app.put('/api/companies/:company/student-promotions/:promotionId/vouchers/:voucherId', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'promotionsManage');
    const promotionId = v.parse(v.id, req.params.promotionId);
    const voucherId = v.parse(v.id, req.params.voucherId);
    const result = await updateVoucher(c, req.identity, companyId, promotionId, voucherId, req.body);
    await audit(c, req.identity, companyId, 'Voucher configured',
      `${result.codeHint} · version ${result.version} · configured only`);
    return result;
  }));
}
