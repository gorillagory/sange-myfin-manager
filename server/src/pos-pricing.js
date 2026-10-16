import { z } from 'zod';
import * as v from './validation.js';
import { operator, requireCapability } from './access.js';
import { createPricingSnapshot, releasePosPromotions, reservePosPromotions } from './pricing-engine.js';
import { assertUnreservedSaleStock } from './customer-order-reservations.js';
import { assertRecipeAvailability } from './inventory-recipes.js';

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
