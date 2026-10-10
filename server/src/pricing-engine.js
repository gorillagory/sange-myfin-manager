import { createHash, randomUUID } from 'node:crypto';
import {
  priceWithPromotions,
  recordPromotionRedemption,
  voucherLookupDigest,
} from './student-promotions.js';
import { filterCampaignEligiblePromotions } from './marketing-loyalty.js';

const MAX_SEN = 9_000_000_000_000_000;
const MAX_LINES = 500;
const MAX_PROMOTIONS = 100;
const DEFAULT_SNAPSHOT_TTL_SECONDS = 300;
const MAX_SNAPSHOT_TTL_SECONDS = 900;
const sourceTypes = new Set(['customer_order', 'pos_sale', 'invoice']);

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

function object(value, message = 'invalid_pricing_request') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, message);
  return value;
}

function strictKeys(value, allowed, message = 'invalid_pricing_request') {
  object(value, message);
  if (Object.keys(value).some(key => !allowed.has(key))) fail(400, message);
}

function text(value, { optional = false, max = 128, pattern, message = 'invalid_pricing_request' } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return '';
  if (typeof value !== 'string') fail(400, message);
  const result = value.trim();
  if (!result || result.length > max || (pattern && !pattern.test(result))) fail(400, message);
  return result;
}

function positiveInteger(value, max, message = 'invalid_pricing_request') {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(400, message);
  return value;
}

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;

const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function instant(value, message = 'invalid_pricing_time') {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) fail(500, message);
  return result;
}

// PostgreSQL numeric values arrive as strings. Convert them without first
// passing through a binary float, and round half-up at the requested scale.
export function decimalToScaledInteger(value, scale, message = 'invalid_money_configuration') {
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) fail(500, message);
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw)) fail(500, message);
  const [whole, fraction = ''] = raw.split('.');
  const kept = fraction.slice(0, scale).padEnd(scale, '0');
  const discarded = fraction.slice(scale);
  let result = BigInt(whole) * (10n ** BigInt(scale)) + BigInt(kept || '0');
  if (discarded && discarded[0] >= '5') result += 1n;
  const number = Number(result);
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_SEN) fail(500, message);
  return number;
}

function companyCurrency(data) {
  const value = String(data?.preferences?.currencyCode || data?.preferences?.currency || 'MYR').trim().toUpperCase();
  if (value === 'RM') return 'MYR';
  if (!/^[A-Z]{3}$/.test(value)) fail(409, 'invalid_company_currency_configuration');
  return value;
}

function companyTaxBasisPoints(data) {
  const value = data?.preferences?.taxRate ?? data?.preferences?.tax ?? 0;
  const basisPoints = decimalToScaledInteger(value, 2, 'invalid_company_tax_configuration');
  if (basisPoints > 10_000) fail(409, 'invalid_company_tax_configuration');
  return basisPoints;
}

function normalizeRequestedLines(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > MAX_LINES) fail(400, 'invalid_pricing_lines');
  const result = lines.map((raw, index) => {
    strictKeys(raw, new Set(['productId', 'variantId', 'quantityMilli']), 'invalid_pricing_line');
    return {
      lineNo: index + 1,
      productId: text(raw.productId, { message: 'invalid_pricing_line' }),
      variantId: text(raw.variantId, { optional: true, message: 'invalid_pricing_line' }),
      quantityMilli: positiveInteger(raw.quantityMilli, 1_000_000_000, 'invalid_pricing_line'),
    };
  });
  const keys = result.map(line => `${line.productId}\u0000${line.variantId}`);
  if (new Set(keys).size !== keys.length) fail(400, 'duplicate_pricing_line');
  return result;
}

function dataObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* handled below */ }
  }
  fail(409, 'invalid_catalog_product');
}

async function catalogLines(c, companyId, requested) {
  const ids = [...new Set(requested.map(line => line.productId))].sort();
  const result = await c.query(
    `SELECT p.id,p.data,p.price AS product_price,pv.id AS variant_id,pv.price AS variant_price
       FROM myfin.products p
       LEFT JOIN myfin.product_variants pv
         ON pv.company_id=p.company_id AND pv.product_id=p.id
      WHERE p.company_id=$1 AND p.id=ANY($2::text[])
      ORDER BY p.id,pv.id FOR SHARE OF p`,
    [companyId, ids],
  );
  const byProduct = new Map();
  for (const row of result.rows) {
    const current = byProduct.get(row.id) || { data: dataObject(row.data), price: row.product_price, variants: new Map() };
    if (row.variant_id) current.variants.set(row.variant_id, row.variant_price);
    byProduct.set(row.id, current);
  }
  if (byProduct.size !== ids.length) fail(409, 'catalog_item_unavailable');
  return requested.map(line => {
    const product = byProduct.get(line.productId);
    const configuredVariants = Array.isArray(product.data.variants) ? product.data.variants : [];
    const hasVariants = product.variants.size > 0 || configuredVariants.length > 0;
    if (configuredVariants.length && !product.variants.size) fail(409, 'invalid_catalog_product');
    if (hasVariants && !line.variantId) fail(400, 'catalog_variant_required');
    if (!hasVariants && line.variantId) fail(409, 'catalog_variant_unavailable');
    const variantPrice = line.variantId ? product.variants.get(line.variantId) : undefined;
    if (line.variantId && variantPrice === undefined) fail(409, 'catalog_variant_unavailable');
    const variant = line.variantId ? configuredVariants.find(item => item?.id === line.variantId) : null;
    const productName = String(product.data.name || '').trim() || line.productId;
    return {
      ...line,
      category: String(product.data.category || '').trim().slice(0, 120),
      subcategory: String(product.data.subcategory || '').trim().slice(0, 120),
      description: `${productName}${variant?.name ? ` / ${String(variant.name).trim()}` : ''}`.slice(0, 500),
      unitPriceSen: decimalToScaledInteger(variantPrice ?? product.price, 2, 'invalid_catalog_price'),
    };
  });
}

function promotionFromRow(row) {
  return {
    id: row.id,
    version: Number(row.version),
    name: row.name,
    enabled: row.enabled,
    redemptionMode: row.redemption_mode,
    validFrom: new Date(row.valid_from).toISOString(),
    validUntil: row.valid_until ? new Date(row.valid_until).toISOString() : null,
    discountType: row.discount_type,
    discountBasisPoints: row.discount_basis_points === null ? null : Number(row.discount_basis_points),
    discountSen: row.discount_sen === null ? null : Number(row.discount_sen),
    maxDiscountSen: row.max_discount_sen === null ? null : Number(row.max_discount_sen),
    rewardProductId: row.reward_product_id || '',
    rewardVariantId: row.reward_variant_id || '',
    rewardQuantityMilli: row.reward_quantity_milli == null ? null : Number(row.reward_quantity_milli),
    minSubtotalSen: Number(row.min_subtotal_sen),
    maxTotalRedemptions: row.max_total_redemptions === null ? null : Number(row.max_total_redemptions),
    perCustomerLimit: row.per_customer_limit === null ? null : Number(row.per_customer_limit),
    requiresCustomer: row.requires_customer,
    requiresStudent: row.requires_student,
    priority: Number(row.priority),
    stackable: row.stackable,
    productTargets: [],
    categoryTargets: [],
    customerTargets: [],
    usage: { total: Number(row.total_usage || 0), customer: Number(row.customer_usage || 0) },
    voucher: null,
    campaignLinks: row.campaign_links || [],
  };
}

async function loadVoucher(c, { workspaceId, companyId, currencyCode, customerId, lookupDigest, at }) {
  if (!lookupDigest) return null;
  const result = await c.query(
    `SELECT v.promotion_id,v.id,v.version,vv.enabled,vv.valid_from,vv.valid_until,
            vv.max_redemptions,vv.per_customer_limit,
            coalesce(vu.redemption_count,0)+(SELECT count(*) FROM myfin.promotion_reservations vr
              WHERE vr.workspace_id=v.workspace_id AND vr.company_id=v.company_id
                AND vr.promotion_id=v.promotion_id AND vr.voucher_id=v.id
                AND vr.state='active' AND vr.expires_at>$6) AS total_usage,
            coalesce(vcu.redemption_count,0)+(SELECT count(*) FROM myfin.promotion_reservations vr
              WHERE vr.workspace_id=v.workspace_id AND vr.company_id=v.company_id
                AND vr.promotion_id=v.promotion_id AND vr.voucher_id=v.id AND vr.customer_id=$5
                AND vr.state='active' AND vr.expires_at>$6) AS customer_usage
       FROM myfin.promotion_vouchers v
       JOIN myfin.promotion_voucher_versions vv
         ON vv.workspace_id=v.workspace_id AND vv.company_id=v.company_id
        AND vv.promotion_id=v.promotion_id AND vv.voucher_id=v.id AND vv.version=v.version
       JOIN myfin.promotions p
         ON p.workspace_id=v.workspace_id AND p.company_id=v.company_id AND p.id=v.promotion_id
       JOIN myfin.promotion_versions pv
         ON pv.workspace_id=p.workspace_id AND pv.company_id=p.company_id
        AND pv.promotion_id=p.id AND pv.version=p.version
       LEFT JOIN myfin.promotion_voucher_usage_counters vu
         ON vu.workspace_id=v.workspace_id AND vu.company_id=v.company_id
        AND vu.promotion_id=v.promotion_id AND vu.voucher_id=v.id
       LEFT JOIN myfin.promotion_voucher_customer_usage_counters vcu
         ON vcu.workspace_id=v.workspace_id AND vcu.company_id=v.company_id
        AND vcu.promotion_id=v.promotion_id AND vcu.voucher_id=v.id AND vcu.customer_id=$5
      WHERE v.workspace_id=$1 AND v.company_id=$2 AND v.code_lookup_digest=$3
        AND pv.currency_code=$4 AND pv.redemption_mode='voucher'
        AND pv.enabled AND pv.valid_from<=$6 AND (pv.valid_until IS NULL OR pv.valid_until>$6)
        AND vv.enabled AND vv.valid_from<=$6 AND (vv.valid_until IS NULL OR vv.valid_until>$6)`,
    [workspaceId, companyId, lookupDigest, currencyCode, customerId || null, at],
  );
  if (result.rowCount !== 1) fail(400, 'voucher_invalid_or_unavailable');
  const row = result.rows[0];
  return {
    promotionId: row.promotion_id,
    id: row.id,
    version: Number(row.version),
    enabled: row.enabled,
    validFrom: new Date(row.valid_from).toISOString(),
    validUntil: row.valid_until ? new Date(row.valid_until).toISOString() : null,
    maxRedemptions: row.max_redemptions === null ? null : Number(row.max_redemptions),
    perCustomerLimit: row.per_customer_limit === null ? null : Number(row.per_customer_limit),
    usage: { total: Number(row.total_usage || 0), customer: Number(row.customer_usage || 0) },
  };
}

async function loadPromotions(c, { workspaceId, companyId, currencyCode, customerId, voucher, at }) {
  const result = await c.query(
    `SELECT p.id,p.version,pv.name,pv.enabled,pv.redemption_mode,pv.valid_from,pv.valid_until,
            pv.discount_type,pv.discount_basis_points,pv.discount_sen,pv.max_discount_sen,
            pv.reward_product_id,pv.reward_variant_id,pv.reward_quantity_milli,
            pv.min_subtotal_sen,pv.max_total_redemptions,pv.per_customer_limit,
            pv.requires_customer,pv.requires_student,pv.priority,pv.stackable,
            coalesce((SELECT jsonb_agg(jsonb_build_object(
              'campaignId',link.campaign_id,'campaignVersion',link.campaign_version,
              'currentVersion',campaign.version,'lifecycle',campaign.lifecycle,
              'startsAt',campaign_version.starts_at,'endsAt',campaign_version.ends_at,
              'channels',campaign_version.channels,
              'audiences',coalesce((SELECT jsonb_agg(jsonb_build_object(
                'scope',audience_version.scope,'companyId',audience_version.company_id,
                'consent',audience_version.consent_criteria,
                'eligibility',audience_version.eligibility_criteria,
                'customer',audience_version.customer_criteria)
                ORDER BY audience_link.audience_id,audience_link.audience_version)
                FROM myfin.marketing_campaign_version_audiences audience_link
                JOIN myfin.marketing_audience_versions audience_version
                  ON audience_version.workspace_id=audience_link.workspace_id
                 AND audience_version.audience_id=audience_link.audience_id
                 AND audience_version.version=audience_link.audience_version
               WHERE audience_link.workspace_id=link.workspace_id
                 AND audience_link.company_id=link.company_id
                 AND audience_link.campaign_id=link.campaign_id
                 AND audience_link.campaign_version=link.campaign_version),'[]'::jsonb))
              ORDER BY link.campaign_id,link.campaign_version)
              FROM myfin.marketing_campaign_version_promotions link
              JOIN myfin.marketing_campaigns campaign
                ON campaign.workspace_id=link.workspace_id AND campaign.company_id=link.company_id
               AND campaign.id=link.campaign_id
              JOIN myfin.marketing_campaign_versions campaign_version
                ON campaign_version.workspace_id=link.workspace_id
               AND campaign_version.company_id=link.company_id
               AND campaign_version.campaign_id=link.campaign_id
               AND campaign_version.version=link.campaign_version
             WHERE link.workspace_id=p.workspace_id AND link.company_id=p.company_id
               AND link.promotion_id=p.id AND link.promotion_version=p.version),'[]'::jsonb)
              AS campaign_links,
            coalesce(pu.redemption_count,0)+(SELECT count(*) FROM myfin.promotion_reservations pr
              WHERE pr.workspace_id=p.workspace_id AND pr.company_id=p.company_id
                AND pr.promotion_id=p.id AND pr.state='active' AND pr.expires_at>$5) AS total_usage,
            coalesce(pcu.redemption_count,0)+(SELECT count(*) FROM myfin.promotion_reservations pr
              WHERE pr.workspace_id=p.workspace_id AND pr.company_id=p.company_id
                AND pr.promotion_id=p.id AND pr.customer_id=$4
                AND pr.state='active' AND pr.expires_at>$5) AS customer_usage
       FROM myfin.promotions p
       JOIN myfin.promotion_versions pv
         ON pv.workspace_id=p.workspace_id AND pv.company_id=p.company_id
        AND pv.promotion_id=p.id AND pv.version=p.version
       LEFT JOIN myfin.promotion_usage_counters pu
         ON pu.workspace_id=p.workspace_id AND pu.company_id=p.company_id AND pu.promotion_id=p.id
       LEFT JOIN myfin.promotion_customer_usage_counters pcu
         ON pcu.workspace_id=p.workspace_id AND pcu.company_id=p.company_id
        AND pcu.promotion_id=p.id AND pcu.customer_id=$4
      WHERE p.workspace_id=$1 AND p.company_id=$2 AND pv.currency_code=$3
        AND pv.enabled AND pv.valid_from<=$5 AND (pv.valid_until IS NULL OR pv.valid_until>$5)
        AND (pv.redemption_mode='automatic' OR p.id=$6)
      ORDER BY pv.priority DESC,p.id LIMIT 101`,
    [workspaceId, companyId, currencyCode, customerId || null, at, voucher?.promotionId || null],
  );
  if (result.rows.length > MAX_PROMOTIONS) fail(409, 'too_many_active_promotions');
  let promotions = result.rows.map(promotionFromRow);
  if (!promotions.length) return [];
  promotions = await filterCampaignEligiblePromotions(c, promotions, {
    workspaceId, companyId, customerId, at,
  });
  if (voucher && !promotions.some(item => item.id === voucher.promotionId)) fail(400, 'voucher_invalid_or_unavailable');
  if (!promotions.length) return [];
  const ids = promotions.map(item => item.id);
  const [products, categories, customers] = await Promise.all([
    c.query(
      `SELECT promotion_id,promotion_version,product_id,variant_id
         FROM myfin.promotion_version_products
        WHERE workspace_id=$1 AND company_id=$2 AND promotion_id=ANY($3::text[])
        ORDER BY promotion_id,product_id,variant_key`, [workspaceId, companyId, ids],
    ),
    c.query(
      `SELECT promotion_id,promotion_version,category_key,subcategory_key
         FROM myfin.promotion_version_categories
        WHERE workspace_id=$1 AND company_id=$2 AND promotion_id=ANY($3::text[])
        ORDER BY promotion_id,category_key,subcategory_key`, [workspaceId, companyId, ids],
    ),
    c.query(
      `SELECT promotion_id,promotion_version,customer_id
         FROM myfin.promotion_version_customers
        WHERE workspace_id=$1 AND company_id=$2 AND promotion_id=ANY($3::text[])
        ORDER BY promotion_id,customer_id`, [workspaceId, companyId, ids],
    ),
  ]);
  const current = (promotion, row) => promotion.id === row.promotion_id && promotion.version === Number(row.promotion_version);
  for (const promotion of promotions) {
    promotion.productTargets = products.rows.filter(row => current(promotion, row))
      .map(row => ({ productId: row.product_id, variantId: row.variant_id || '' }));
    promotion.categoryTargets = categories.rows.filter(row => current(promotion, row))
      .map(row => ({ category: row.category_key, subcategory: row.subcategory_key || '' }));
    promotion.customerTargets = customers.rows.filter(row => current(promotion, row)).map(row => row.customer_id);
    if (voucher?.promotionId === promotion.id) promotion.voucher = {
      id: voucher.id, version: voucher.version, enabled: voucher.enabled,
      validFrom: voucher.validFrom, validUntil: voucher.validUntil,
      maxRedemptions: voucher.maxRedemptions, perCustomerLimit: voucher.perCustomerLimit,
      usage: voucher.usage,
    };
  }
  return promotions.map(({ campaignLinks: _campaignLinks, ...promotion }) => promotion);
}

async function persistSnapshot(c, { workspaceId, companyId, id, expiresAt, requestDigest, priced }) {
  await c.query(
    `INSERT INTO myfin.pricing_snapshots(
       workspace_id,company_id,id,customer_id,student_eligibility_version,currency_code,
       subtotal_sen,discount_sen,taxable_sen,tax_sen,rounding_sen,total_sen,
       rules_digest,request_digest,priced_at,expires_at,tax_basis_points)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [workspaceId, companyId, id, priced.customerId || null, priced.studentEligibilityVersion,
      priced.currencyCode, priced.subtotalSen, priced.discountSen, priced.taxableSen, priced.taxSen,
      priced.roundingSen, priced.totalSen, priced.rulesDigest, requestDigest, priced.pricedAt, expiresAt,
      priced.taxBasisPoints],
  );
  for (const line of priced.lines) await c.query(
    `INSERT INTO myfin.pricing_snapshot_lines(
       workspace_id,company_id,snapshot_id,line_no,product_id,variant_id,category,subcategory,
       description,quantity_milli,unit_price_sen,gross_sen,discount_sen,net_sen)
     VALUES($1,$2,$3,$4,$5,nullif($6,''),$7,$8,$9,$10,$11,$12,$13,$14)`,
    [workspaceId, companyId, id, line.lineNo, line.productId, line.variantId, line.category,
      line.subcategory, line.description, line.quantityMilli, line.unitPriceSen, line.grossSen,
      line.discountSen, line.netSen],
  );
  for (let index = 0; index < priced.applications.length; index++) {
    const application = priced.applications[index];
    const sequence = index + 1;
    await c.query(
      `INSERT INTO myfin.pricing_snapshot_discounts(
         workspace_id,company_id,snapshot_id,sequence,promotion_id,promotion_version,
         voucher_id,voucher_version,display_name,discount_sen)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [workspaceId, companyId, id, sequence, application.promotionId, application.promotionVersion,
        application.voucherId || null, application.voucherVersion, application.name, application.discountSen],
    );
    for (const line of application.lineDiscounts) await c.query(
      `INSERT INTO myfin.pricing_snapshot_discount_lines(
         workspace_id,company_id,snapshot_id,discount_sequence,line_no,discount_sen)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [workspaceId, companyId, id, sequence, line.lineNo, line.discountSen],
    );
  }
}

function safeSnapshotOutput(id, expiresAt, requestDigest, priced) {
  return {
    id,
    requestDigest,
    rulesDigest: priced.rulesDigest,
    expiresAt,
    pricedAt: priced.pricedAt,
    currencyCode: priced.currencyCode,
    customerId: priced.customerId,
    studentEligibilityVersion: priced.studentEligibilityVersion,
    subtotalSen: priced.subtotalSen,
    discountSen: priced.discountSen,
    taxableSen: priced.taxableSen,
    taxSen: priced.taxSen,
    taxBasisPoints: priced.taxBasisPoints,
    roundingSen: priced.roundingSen,
    totalSen: priced.totalSen,
    lines: priced.lines.map(line => ({ ...line })),
    discounts: priced.applications.map(item => ({
      promotionId: item.promotionId,
      promotionVersion: item.promotionVersion,
      name: item.name,
      voucherApplied: Boolean(item.voucherId),
      discountSen: item.discountSen,
      lineDiscounts: item.lineDiscounts.map(line => ({ ...line })),
    })),
  };
}

/**
 * Create an authoritative, immutable quote. The supplied client must already be
 * inside a database transaction because migration 0022 defers the parent/detail
 * consistency check until commit.
 */
export async function createPricingSnapshot(c, input, options = {}) {
  strictKeys(input, new Set(['workspaceId', 'companyId', 'customerId', 'lines', 'voucherCode']));
  const companyId = text(input.companyId);
  const expectedWorkspace = text(input.workspaceId, { optional: true });
  const customerId = text(input.customerId, { optional: true });
  const requested = normalizeRequestedLines(input.lines);
  const now = instant(typeof options.now === 'function' ? options.now() : (options.now || new Date()));
  const pricedAt = now.toISOString();
  const ttl = options.expiresInSeconds ?? DEFAULT_SNAPSHOT_TTL_SECONDS;
  positiveInteger(ttl, MAX_SNAPSHOT_TTL_SECONDS, 'invalid_snapshot_expiry');
  if (ttl < 30) fail(500, 'invalid_snapshot_expiry');
  const cashRounding = options.cashRounding ?? true;
  if (typeof cashRounding !== 'boolean') fail(500, 'invalid_cash_rounding_policy');

  const company = (await c.query(
    'SELECT workspace_id,data FROM myfin.companies WHERE id=$1 FOR SHARE', [companyId],
  )).rows[0];
  if (!company) fail(404, 'company_not_found');
  const workspaceId = company.workspace_id;
  if (expectedWorkspace && expectedWorkspace !== workspaceId) fail(403, 'company_workspace_mismatch');
  if (customerId) {
    const customer = await c.query(
      'SELECT 1 FROM myfin.customer_accounts WHERE id=$1 AND disabled_at IS NULL', [customerId],
    );
    if (!customer.rowCount) fail(409, 'customer_unavailable');
  }
  const currencyCode = companyCurrency(company.data);
  const taxBasisPoints = companyTaxBasisPoints(company.data);
  if (input.voucherCode && (typeof options.voucherPepper !== 'string' || options.voucherPepper.length < 32))
    fail(503, 'voucher_secret_unavailable');
  const lookupDigest = input.voucherCode ? voucherLookupDigest(options.voucherPepper, input.voucherCode) : null;
  const voucher = await loadVoucher(c, {
    workspaceId, companyId, currencyCode, customerId, lookupDigest, at: pricedAt,
  });
  const [lines, eligibility, promotions] = await Promise.all([
    catalogLines(c, companyId, requested),
    customerId ? c.query(
      `SELECT status,version,valid_from,valid_until
         FROM myfin.student_eligibilities WHERE workspace_id=$1 AND customer_id=$2`,
      [workspaceId, customerId],
    ) : Promise.resolve({ rows: [] }),
    loadPromotions(c, { workspaceId, companyId, currencyCode, customerId, voucher, at: pricedAt }),
  ]);
  const student = eligibility.rows[0] ? {
    status: eligibility.rows[0].status,
    version: Number(eligibility.rows[0].version),
    validFrom: eligibility.rows[0].valid_from ? new Date(eligibility.rows[0].valid_from).toISOString() : null,
    validUntil: eligibility.rows[0].valid_until ? new Date(eligibility.rows[0].valid_until).toISOString() : null,
  } : null;
  const priced = priceWithPromotions({
    lines, promotions, customerId, studentEligibility: student,
    at: pricedAt, currencyCode, taxBasisPoints, cashRounding,
  });
  priced.taxBasisPoints = taxBasisPoints;
  if (priced.totalSen <= 0) fail(400, 'order_total_required');
  if (lookupDigest && !priced.applications.some(application => application.voucherId))
    fail(400, 'voucher_invalid_or_unavailable');
  const requestDigest = digest({
    workspaceId, companyId, customerId, lines: requested,
    voucherLookupDigest: lookupDigest, currencyCode, taxBasisPoints, cashRounding,
  });
  const idFactory = options.idFactory || randomUUID;
  const id = text(idFactory(), { message: 'invalid_snapshot_id' });
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
  await persistSnapshot(c, { workspaceId, companyId, id, expiresAt, requestDigest, priced });
  return safeSnapshotOutput(id, expiresAt, requestDigest, priced);
}

async function snapshotForCommit(c, workspaceId, companyId, snapshotId) {
  const snapshot = (await c.query(
    `SELECT * FROM myfin.pricing_snapshots
      WHERE workspace_id=$1 AND company_id=$2 AND id=$3 FOR SHARE`,
    [workspaceId, companyId, snapshotId],
  )).rows[0];
  if (!snapshot) fail(409, 'pricing_snapshot_unavailable');
  const discounts = (await c.query(
    `SELECT * FROM myfin.pricing_snapshot_discounts
      WHERE workspace_id=$1 AND company_id=$2 AND snapshot_id=$3 ORDER BY sequence`,
    [workspaceId, companyId, snapshotId],
  )).rows;
  return { snapshot, discounts };
}

export async function loadPricingSnapshot(c, input, options = {}) {
  strictKeys(input, new Set(['workspaceId', 'companyId', 'snapshotId', 'customerId', 'requestDigest']));
  const workspaceId = text(input.workspaceId);
  const companyId = text(input.companyId);
  const snapshotId = text(input.snapshotId);
  const customerId = text(input.customerId, { optional: true });
  const { snapshot, discounts } = await snapshotForCommit(c, workspaceId, companyId, snapshotId);
  if ((snapshot.customer_id || '') !== customerId) fail(409, 'pricing_customer_changed');
  if (input.requestDigest && snapshot.request_digest !== input.requestDigest) fail(409, 'pricing_snapshot_changed');
  const now = instant(typeof options.now === 'function' ? options.now() : (options.now || new Date()));
  if (!options.allowExpired && snapshot.expires_at && now >= new Date(snapshot.expires_at))
    fail(409, 'pricing_snapshot_expired');
  const lines = (await c.query(
    `SELECT * FROM myfin.pricing_snapshot_lines
      WHERE workspace_id=$1 AND company_id=$2 AND snapshot_id=$3 ORDER BY line_no`,
    [workspaceId, companyId, snapshotId],
  )).rows;
  const discountLines = discounts.length ? (await c.query(
    `SELECT * FROM myfin.pricing_snapshot_discount_lines
      WHERE workspace_id=$1 AND company_id=$2 AND snapshot_id=$3
      ORDER BY discount_sequence,line_no`, [workspaceId, companyId, snapshotId],
  )).rows : [];
  return {
    id: snapshot.id,
    requestDigest: snapshot.request_digest,
    rulesDigest: snapshot.rules_digest,
    pricedAt: new Date(snapshot.priced_at).toISOString(),
    expiresAt: snapshot.expires_at ? new Date(snapshot.expires_at).toISOString() : null,
    currencyCode: snapshot.currency_code,
    customerId: snapshot.customer_id || '',
    studentEligibilityVersion: snapshot.student_eligibility_version === null
      ? null : Number(snapshot.student_eligibility_version),
    subtotalSen: Number(snapshot.subtotal_sen),
    discountSen: Number(snapshot.discount_sen),
    taxableSen: Number(snapshot.taxable_sen),
    taxSen: Number(snapshot.tax_sen),
    taxBasisPoints: Number(snapshot.tax_basis_points || 0),
    roundingSen: Number(snapshot.rounding_sen),
    totalSen: Number(snapshot.total_sen),
    lines: lines.map(line => ({ lineNo: Number(line.line_no), productId: line.product_id,
      variantId: line.variant_id || '', category: line.category, subcategory: line.subcategory,
      description: line.description, quantityMilli: Number(line.quantity_milli),
      unitPriceSen: Number(line.unit_price_sen), grossSen: Number(line.gross_sen),
      discountSen: Number(line.discount_sen), netSen: Number(line.net_sen) })),
    discounts: discounts.map(discount => ({ promotionId: discount.promotion_id,
      promotionVersion: Number(discount.promotion_version), name: discount.display_name,
      voucherApplied: Boolean(discount.voucher_id), discountSen: Number(discount.discount_sen),
      lineDiscounts: discountLines.filter(line => Number(line.discount_sequence) === Number(discount.sequence))
        .map(line => ({ lineNo: Number(line.line_no), discountSen: Number(line.discount_sen) })) })),
  };
}

export async function reserveOrderPromotions(c, { companyId, orderId, snapshotId, expiresAt }) {
  const result = await c.query(
    'SELECT myfin.reserve_order_promotions($1,$2,$3,$4) AS count',
    [text(companyId), text(orderId), text(snapshotId), instant(expiresAt).toISOString()],
  );
  return Number(result.rows[0]?.count || 0);
}

export async function extendOrderPromotionReservations(c, { companyId, orderId, expiresAt }) {
  const result = await c.query(
    'SELECT myfin.extend_order_promotion_reservations($1,$2,$3) AS count',
    [text(companyId), text(orderId), instant(expiresAt).toISOString()],
  );
  return Number(result.rows[0]?.count || 0);
}

export async function releaseOrderPromotionReservations(c, { companyId, orderId, reason }) {
  if (!['cancelled', 'expired'].includes(reason)) fail(400, 'invalid_reservation_release_reason');
  const result = await c.query(
    'SELECT myfin.release_order_promotion_reservations($1,$2,$3) AS count',
    [text(companyId), text(orderId), reason],
  );
  return Number(result.rows[0]?.count || 0);
}

export async function consumeOrderPromotionReservations(c, { companyId, orderId, saleId, occurredAt }) {
  const result = await c.query(
    'SELECT myfin.consume_order_promotion_reservations($1,$2,$3,$4) AS count',
    [text(companyId), text(orderId), text(saleId), instant(occurredAt).toISOString()],
  );
  return Number(result.rows[0]?.count || 0);
}

async function boundSource(c, { companyId, sourceType, sourceId, snapshotId }) {
  if (sourceType === 'customer_order') {
    const row = (await c.query(
      `SELECT pricing_snapshot_id,customer_id FROM myfin.customer_order_requests
        WHERE company_id=$1 AND id=$2 FOR UPDATE`, [companyId, sourceId],
    )).rows[0];
    if (!row || row.pricing_snapshot_id !== snapshotId) fail(409, 'pricing_source_not_bound');
    return row;
  }
  const row = (await c.query(
    `SELECT pricing_snapshot_id,source,data FROM myfin.transactions
      WHERE company_id=$1 AND id=$2 FOR UPDATE`, [companyId, sourceId],
  )).rows[0];
  if (!row || row.pricing_snapshot_id !== snapshotId) fail(409, 'pricing_source_not_bound');
  const data = dataObject(row.data);
  if (sourceType === 'pos_sale' && row.source !== 'pos') fail(409, 'pricing_source_type_mismatch');
  if (sourceType === 'invoice' && (row.source === 'pos' || data.type !== 'Invoice'))
    fail(409, 'pricing_source_type_mismatch');
  return row;
}

function sameRedemption(row, snapshotId, snapshot, discount) {
  return row.pricing_snapshot_id === snapshotId
    && row.promotion_id === discount.promotion_id
    && Number(row.promotion_version) === Number(discount.promotion_version)
    && (row.voucher_id || null) === (discount.voucher_id || null)
    && (row.voucher_version === null ? null : Number(row.voucher_version))
      === (discount.voucher_version === null ? null : Number(discount.voucher_version))
    && Number(row.discount_sen) === Number(discount.discount_sen)
    && (row.customer_id || null) === (snapshot.customer_id || null);
}

/**
 * Consume every promotion in a snapshot after the source row has been inserted
 * with pricing_snapshot_id. Run this in the same transaction as that source.
 * Database triggers serialize and finally enforce all usage limits.
 */
export async function commitPricingRedemptions(c, input, options = {}) {
  strictKeys(input, new Set(['workspaceId', 'companyId', 'snapshotId', 'sourceType', 'sourceId']));
  const workspaceId = text(input.workspaceId);
  const companyId = text(input.companyId);
  const snapshotId = text(input.snapshotId);
  const sourceType = text(input.sourceType);
  const sourceId = text(input.sourceId);
  if (!sourceTypes.has(sourceType)) fail(400, 'invalid_pricing_source');
  const occurredAt = instant(typeof options.now === 'function' ? options.now() : (options.now || new Date())).toISOString();
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,22))',
    [`${companyId}:pricing-redemption:${sourceType}:${sourceId}`]);
  const { snapshot, discounts } = await snapshotForCommit(c, workspaceId, companyId, snapshotId);
  if (snapshot.expires_at && occurredAt >= new Date(snapshot.expires_at).toISOString())
    fail(409, 'pricing_snapshot_expired');
  const source = await boundSource(c, { companyId, sourceType, sourceId, snapshotId });
  if (sourceType === 'customer_order' && (source.customer_id || null) !== (snapshot.customer_id || null))
    fail(409, 'pricing_customer_changed');
  const existing = (await c.query(
    `SELECT * FROM myfin.promotion_redemptions
      WHERE company_id=$1 AND source_type=$2 AND source_id=$3 FOR UPDATE`,
    [companyId, sourceType, sourceId],
  )).rows;
  if (existing.length) {
    if (existing.length !== discounts.length || discounts.some(discount =>
      !existing.some(row => sameRedemption(row, snapshotId, snapshot, discount))))
      fail(409, 'promotion_redemption_source_changed');
    return existing.map(row => ({ id: row.id, promotionId: row.promotion_id,
      discountSen: Number(row.discount_sen) }));
  }
  const idFactory = options.idFactory || randomUUID;
  const written = [];
  for (const discount of discounts) {
    const stable = {
      workspaceId, companyId, snapshotId, sourceType, sourceId,
      promotionId: discount.promotion_id, promotionVersion: Number(discount.promotion_version),
      voucherId: discount.voucher_id || null,
      voucherVersion: discount.voucher_version === null ? null : Number(discount.voucher_version),
      customerId: snapshot.customer_id || null,
      discountSen: Number(discount.discount_sen),
    };
    const row = await recordPromotionRedemption(c, {
      workspaceId,
      companyId,
      id: text(idFactory(), { message: 'invalid_redemption_id' }),
      promotionId: stable.promotionId,
      promotionVersion: stable.promotionVersion,
      voucherId: stable.voucherId,
      voucherVersion: stable.voucherVersion,
      pricingSnapshotId: snapshotId,
      customerId: stable.customerId,
      sourceType,
      sourceId,
      idempotencyKey: digest({ companyId, sourceType, sourceId, promotionId: discount.promotion_id }),
      requestDigest: digest(stable),
      discountSen: stable.discountSen,
      occurredAt,
    });
    written.push({ id: row.id, promotionId: discount.promotion_id, discountSen: Number(discount.discount_sen) });
  }
  return written;
}
