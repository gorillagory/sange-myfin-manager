import { z } from 'zod';
import * as v from './validation.js';
import { operator, requireCapability } from './access.js';
import { createPricingSnapshot, releasePosPromotions, reservePosPromotions } from './pricing-engine.js';
import { assertUnreservedSaleStock } from './customer-order-reservations.js';
import { assertRecipeAvailability } from './inventory-recipes.js';
import { promotionShareUrl } from './student-programs.js';

const line = z.strictObject({
  productId: v.id,
  variantId: z.string().trim().max(128).default(''),
  quantityMilli: z.number().int().min(1).max(1_000_000_000),
});
const quoteInput = z.strictObject({
  lines: z.array(line).min(1).max(500),
  clientId: z.union([v.id, z.literal('')]).default(''),
  voucherCode: z.string().trim().max(128).default(''),
  manualDiscountBasisPoints: z.number().int().min(0).max(10_000).default(0),
  checkoutId: v.id,
  lock: z.boolean().default(false),
});
const releaseInput = z.strictObject({ checkoutId: v.id, pricingSnapshotId: v.id });

const money = value => Number(value) / 100;
const numberOrNull = value => value === null || value === undefined ? null : Number(value);

export function posPromotionOutput(row) {
  const displayCode = row.display_code || '';
  const campaignId = row.campaign_id || '';
  return {
    promotionId: row.promotion_id,
    promotionVersion: Number(row.promotion_version),
    voucherId: row.voucher_id || '',
    name: row.name,
    campaignId,
    campaignName: row.campaign_name || '',
    campaignVersion: numberOrNull(row.campaign_version),
    channels: row.campaign_channels || ['pos', 'storefront'],
    redemptionMode: row.redemption_mode,
    displayCode,
    code: displayCode,
    codeHint: row.code_hint || '',
    legacyMasked: row.redemption_mode === 'voucher' && !displayCode,
    shareUrl: promotionShareUrl(row.storefront_hostname || '', displayCode, campaignId),
    enabled: true,
    validFrom: row.code_valid_from || row.valid_from,
    validUntil: row.code_valid_until || row.valid_until || null,
    discountType: row.discount_type,
    discountBasisPoints: numberOrNull(row.discount_basis_points),
    discountSen: numberOrNull(row.discount_sen),
    rewardProductId: row.reward_product_id || '',
    rewardProductName: row.reward_product_name || '',
  };
}

async function activePosPromotions(c, companyId) {
  const result = await c.query(
    `SELECT promotion.id AS promotion_id,promotion.version AS promotion_version,
            version.name,version.redemption_mode,version.valid_from,version.valid_until,
            version.discount_type,version.discount_basis_points,version.discount_sen,
            version.reward_product_id,reward.data->>'name' AS reward_product_name,
            voucher.id AS voucher_id,voucher.display_code,voucher.code_hint,
            voucher_version.valid_from AS code_valid_from,
            voucher_version.valid_until AS code_valid_until,
            campaign.id AS campaign_id,campaign.version AS campaign_version,
            campaign.name AS campaign_name,campaign.channels AS campaign_channels,
            host.hostname AS storefront_hostname
       FROM myfin.promotions promotion
       JOIN myfin.promotion_versions version
         ON version.workspace_id=promotion.workspace_id AND version.company_id=promotion.company_id
        AND version.promotion_id=promotion.id AND version.version=promotion.version
       LEFT JOIN myfin.products reward
         ON reward.company_id=promotion.company_id AND reward.id=version.reward_product_id
       LEFT JOIN myfin.promotion_vouchers voucher
         ON voucher.workspace_id=promotion.workspace_id AND voucher.company_id=promotion.company_id
        AND voucher.promotion_id=promotion.id AND version.redemption_mode='voucher'
       LEFT JOIN myfin.promotion_voucher_versions voucher_version
         ON voucher_version.workspace_id=voucher.workspace_id
        AND voucher_version.company_id=voucher.company_id
        AND voucher_version.promotion_id=voucher.promotion_id
        AND voucher_version.voucher_id=voucher.id AND voucher_version.version=voucher.version
        AND voucher_version.enabled AND voucher_version.valid_from<=now()
        AND (voucher_version.valid_until IS NULL OR voucher_version.valid_until>now())
       LEFT JOIN LATERAL (
         SELECT campaign_head.id,campaign_head.version,campaign_version.name,campaign_version.channels
           FROM myfin.marketing_campaigns campaign_head
           JOIN myfin.marketing_campaign_versions campaign_version
             ON campaign_version.workspace_id=campaign_head.workspace_id
            AND campaign_version.company_id=campaign_head.company_id
            AND campaign_version.campaign_id=campaign_head.id
            AND campaign_version.version=campaign_head.version
           JOIN myfin.marketing_campaign_version_promotions link
             ON link.workspace_id=campaign_head.workspace_id AND link.company_id=campaign_head.company_id
            AND link.campaign_id=campaign_head.id AND link.campaign_version=campaign_head.version
            AND link.promotion_id=promotion.id AND link.promotion_version=promotion.version
          WHERE campaign_head.workspace_id=promotion.workspace_id
            AND campaign_head.company_id=promotion.company_id
            AND campaign_head.lifecycle='published' AND 'pos'=ANY(campaign_version.channels)
            AND campaign_version.starts_at<=now()
            AND (campaign_version.ends_at IS NULL OR campaign_version.ends_at>now())
            AND (voucher_version.campaign_id IS NULL OR campaign_head.id=voucher_version.campaign_id)
          ORDER BY campaign_version.starts_at DESC,campaign_head.id LIMIT 1
       ) campaign ON true
       LEFT JOIN myfin.promotion_usage_counters promotion_usage
         ON promotion_usage.workspace_id=promotion.workspace_id
        AND promotion_usage.company_id=promotion.company_id
        AND promotion_usage.promotion_id=promotion.id
       LEFT JOIN myfin.promotion_voucher_usage_counters voucher_usage
         ON voucher_usage.workspace_id=voucher.workspace_id AND voucher_usage.company_id=voucher.company_id
        AND voucher_usage.promotion_id=voucher.promotion_id AND voucher_usage.voucher_id=voucher.id
       LEFT JOIN myfin.storefront_hosts host
         ON host.company_id=promotion.company_id AND host.disabled_at IS NULL
      WHERE promotion.company_id=$1 AND version.enabled
        AND version.valid_from<=now() AND (version.valid_until IS NULL OR version.valid_until>now())
        AND (version.max_total_redemptions IS NULL
          OR coalesce(promotion_usage.redemption_count,0)<version.max_total_redemptions)
        AND (NOT EXISTS(
          SELECT 1 FROM myfin.marketing_campaign_version_promotions any_link
           WHERE any_link.workspace_id=promotion.workspace_id
             AND any_link.company_id=promotion.company_id
             AND any_link.promotion_id=promotion.id
             AND any_link.promotion_version=promotion.version
        ) OR campaign.id IS NOT NULL)
        AND (version.discount_type<>'free_item' OR (
          reward.id IS NOT NULL AND coalesce(reward.data->>'active','true')<>'false'
          AND (version.reward_variant_id IS NULL OR EXISTS(
            SELECT 1 FROM myfin.product_variants reward_variant
             WHERE reward_variant.company_id=promotion.company_id
               AND reward_variant.product_id=version.reward_product_id
               AND reward_variant.id=version.reward_variant_id
          ))
        ))
        AND (version.redemption_mode='automatic' OR (
          voucher.id IS NOT NULL AND voucher_version.voucher_id IS NOT NULL
          AND (voucher_version.max_redemptions IS NULL
            OR coalesce(voucher_usage.redemption_count,0)<voucher_version.max_redemptions)
        ))
      ORDER BY version.priority DESC,version.name,promotion.id,voucher.display_code NULLS LAST,voucher.id`,
    [companyId],
  );
  return result.rows.map(posPromotionOutput);
}

export function posQuoteOutput(snapshot) {
  return {
    pricingSnapshotId: snapshot.id,
    requestDigest: snapshot.requestDigest,
    expiresAt: snapshot.expiresAt,
    serverNow: new Date().toISOString(),
    currencyCode: snapshot.currencyCode,
    customerLinked: Boolean(snapshot.customerId),
    totals: {
      subtotal: money(snapshot.subtotalSen),
      promotionDiscountAmount: money(snapshot.promotionDiscountSen),
      manualDiscountAmount: money(snapshot.manualDiscountSen),
      discountAmount: money(snapshot.discountSen),
      discount: Number(snapshot.manualDiscountBasisPoints) / 100,
      tax: money(snapshot.taxSen),
      taxRate: Number(snapshot.taxBasisPoints) / 100,
      totalBeforeRounding: money(snapshot.taxableSen + snapshot.taxSen),
      rounding: money(snapshot.roundingSen),
      total: money(snapshot.totalSen),
    },
    lines: snapshot.lines.map(item => ({
      lineNo: item.lineNo,
      productId: item.productId,
      variantId: item.variantId,
      description: item.description,
      quantity: Number(item.quantityMilli) / 1000,
      unitPrice: money(item.unitPriceSen),
      catalogUnitPrice: money(item.catalogUnitPriceSen ?? item.unitPriceSen),
      catalogProductVersion: item.catalogProductVersion ?? null,
      priceSource: item.priceSource || 'catalog',
      gross: money(item.grossSen),
      savings: money(item.discountSen),
      net: money(item.netSen),
      automaticReward: Boolean(item.automaticReward),
    })),
    discounts: snapshot.discounts.map(item => ({
      promotionId: item.promotionId,
      promotionVersion: item.promotionVersion,
      name: item.name,
      voucherApplied: item.voucherApplied,
      amount: money(item.discountSen),
    })),
  };
}

export function registerPosPricing(app, { scoped, voucherPepper }) {
  app.get('/api/companies/:company/pos/promotions', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'checkout');
    return { promotions: await activePosPromotions(c, companyId) };
  }));

  app.post('/api/companies/:company/pos/quote', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'checkout');
    const input = v.parse(quoteInput, req.body);
    const company = (await c.query(
      'SELECT workspace_id,data FROM myfin.companies WHERE id=$1 FOR SHARE', [companyId],
    )).rows[0];
    if (!company) v.fail(404, 'company_not_found');
    const allowedBasisPoints = Math.round(Math.min(100, Math.max(0,
      Number(company.data?.preferences?.staffDiscountLimit || 0))) * 100);
    if (operator(req.identity) && input.manualDiscountBasisPoints > allowedBasisPoints)
      v.fail(403, 'manual_discount_limit_exceeded');

    let customerId = '';
    if (input.clientId) {
      const client = (await c.query(
        `SELECT client.data,link.customer_id
           FROM myfin.clients client
           LEFT JOIN myfin.customer_company_links link
             ON link.company_id=client.company_id AND link.client_id=client.id
          WHERE client.company_id=$1 AND client.id=$2`,
        [companyId, input.clientId],
      )).rows[0];
      if (!client || client.data?.type === 'Supplier') v.fail(404, 'customer_not_found');
      customerId = client.customer_id || '';
    }

    const snapshot = await createPricingSnapshot(c, {
      workspaceId: company.workspace_id,
      companyId,
      customerId,
      lines: input.lines,
      voucherCode: input.voucherCode,
      channel: 'pos',
      issuedToStaffId: req.identity.id,
      manualDiscountBasisPoints: input.manualDiscountBasisPoints,
    }, { voucherPepper, cashRounding: true, persist: input.lock });
    if (input.lock) {
      const saleItems = snapshot.lines.map(item => ({
        lineNo: item.lineNo,
        productId: item.productId,
        variantId: item.variantId,
        qty: Number(item.quantityMilli) / 1000,
      }));
      const ids = [...new Set(saleItems.map(item => item.productId))].sort();
      const productRows = (await c.query(
        'SELECT id,data FROM myfin.products WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR SHARE',
        [companyId, ids],
      )).rows;
      if (productRows.length !== ids.length) v.fail(409, 'catalog_item_unavailable');
      if (productRows.some(row => row.data?.active === false)) v.fail(409, 'catalog_item_unavailable');
      await assertUnreservedSaleStock(c, companyId, productRows, saleItems);
      await assertRecipeAvailability(c, { companyId, items: saleItems, lock: 'share' });
      await reservePosPromotions(c, {
        companyId, checkoutId: input.checkoutId, snapshotId: snapshot.id,
        expiresAt: snapshot.recoveryExpiresAt,
      });
    }
    return posQuoteOutput(snapshot);
  }));
  app.post('/api/companies/:company/pos/quote/release', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'checkout');
    const input = v.parse(releaseInput, req.body);
    const released = await releasePosPromotions(c, {
      companyId, checkoutId: input.checkoutId,
      snapshotId: input.pricingSnapshotId, staffId: req.identity.id,
    });
    return { released };
  }));
}
