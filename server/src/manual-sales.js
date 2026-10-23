import { createHash } from 'node:crypto';
import { z } from 'zod';
import * as v from './validation.js';
import { requireCapability, publicTransaction } from './access.js';
import {
  businessDate,
  canonical,
  cents,
  checkoutTotalsFor,
  deductItems,
  normalizeProduct,
} from '../../src/domain/pos.js';
import { templateDefaults } from '../../src/domain/documents.js';
import { MANUAL_SALE_BACKDATE_DAYS } from '../../src/domain/manualSales.js';
import { assertUnreservedSaleStock } from './customer-order-reservations.js';
import { consumeRecipeStock } from './inventory-recipes.js';
import { assertOrderCreated } from './orders.js';

const paymentMethods = ['Cash', 'QR Pay', 'Card', 'Bank Transfer', 'E-wallet', 'Other'];
const unitPrice = z.number().finite().min(0).max(1e7)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6);
const taxRate = z.number().finite().min(0).max(100)
  .refine(value => Math.abs(value * 10000 - Math.round(value * 10000)) < 1e-6);
const quantity = z.number().finite().positive().max(1e6)
  .refine(value => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6);

export const manualSaleInput = z.strictObject({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  occurredAt: z.string().datetime(),
  paymentStatus: z.literal('Paid'),
  paymentMethod: z.enum(paymentMethods),
  paymentReference: z.string().trim().max(120).default(''),
  customerId: z.union([v.id, z.literal('')]).default(''),
  discount: z.number().finite().min(0).max(100).default(0),
  recordingReason: z.string().trim().min(3).max(1000),
  taxRate,
  pricingOverrideReason: z.string().trim().max(1000).default(''),
  inventoryPolicy: z.literal('deduct_current_stock_and_recipe'),
  items: z.array(z.strictObject({
    productId: v.id,
    variantId: z.union([v.id, z.literal('')]).default(''),
    quantity,
    unitPrice,
  })).min(1).max(500),
});

const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const manualSaleId = (companyId, idempotencyKey) =>
  `manual_${digest({ companyId, idempotencyKey }).slice(0, 40)}`;

const asProduct = row => normalizeProduct({ ...row.data, id: row.id,
  company_id: row.company_id, version: Number(row.version) });

function validatePayment(input) {
  if (input.paymentMethod === 'Other' && input.paymentReference.length < 2)
    v.fail(400, 'payment_reference_required');
}

function canonicalLines(input, products) {
  return input.items.map(line => {
    const product = products.find(candidate => candidate.id === line.productId);
    const variant = line.variantId
      ? product?.variants?.find(candidate => candidate.id === line.variantId) : null;
    if (!product) v.fail(404, 'product_not_found');
    if ((line.variantId && !variant) || (product.variants.length && !line.variantId))
      v.fail(404, 'variant_not_found');
    const target = variant || product;
    return {
      productId: product.id,
      variantId: variant?.id || '',
      variant: variant?.name || '',
      sku: variant?.sku || product.sku || '',
      desc: product.name + (variant ? ` (${variant.name})` : ''),
      price: line.unitPrice,
      catalogPrice: Number(target.price),
      catalogVersion: Number(product.version || 1),
      priceSource: cents(line.unitPrice) === cents(target.price) ? 'catalog' : 'manual_override',
      cost: Number(target.cost || 0),
      unit: product.unit || 'pcs',
      qty: line.quantity,
    };
  });
}

export async function recordManualSale(c, who, companyId, rawInput, audit, options = {}) {
  requireCapability(who, 'manualSalesCreate');
  const input = v.parse(manualSaleInput, rawInput);
  const occurredAt = new Date(input.occurredAt);
  const serverRow = options.serverNow
    ? { server_now: options.serverNow }
    : (await c.query('SELECT now() AS server_now')).rows[0];
  const serverAt = new Date(serverRow?.server_now);
  if (!Number.isFinite(occurredAt.getTime()) || !Number.isFinite(serverAt.getTime()))
    v.fail(500, 'server_time_unavailable');
  if (occurredAt.getTime() > serverAt.getTime() + 5 * 60 * 1000)
    v.fail(400, 'manual_sale_future_date');
  const occurredIso = occurredAt.toISOString(), serverIso = serverAt.toISOString();
  const occurredDate = businessDate(occurredIso), serverDate = businessDate(serverIso);
  const backdateDays = (Date.parse(serverDate) - Date.parse(occurredDate)) / 86400000;
  // Issued-document corrections cannot reverse both product and recipe stock.
  // Until a dedicated counter-entry workflow exists, constrain immutable late
  // entries to the operational reconciliation window used by busy shops.
  if (!Number.isInteger(backdateDays) || backdateDays > MANUAL_SALE_BACKDATE_DAYS)
    v.fail(400, 'manual_sale_backdate_limit');
  validatePayment(input);

  const id = manualSaleId(companyId, input.idempotencyKey);
  const requestDigest = digest({ companyId, ...input, occurredAt: occurredIso });
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,23))',
    [`${companyId}:manual-sale:${input.idempotencyKey}`]);
  const existing = await c.query(
    'SELECT * FROM myfin.transactions WHERE company_id=$1 AND id=$2', [companyId, id]);
  if (existing.rowCount) {
    const row = existing.rows[0];
    if (row.source !== 'manual_sale' || row.fingerprint !== requestDigest)
      v.fail(409, 'manual_sale_idempotency_key_reused');
    return recordOutput(row, who);
  }

  const productIds = [...new Set(input.items.map(item => item.productId))].sort();
  if (productIds.length > 100) v.fail(400, 'too_many_products');
  const productRows = await c.query(
    'SELECT * FROM myfin.products WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',
    [companyId, productIds]);
  if (productRows.rowCount !== productIds.length) v.fail(404, 'product_not_found');
  const products = productRows.rows.map(asProduct);
  if (products.some(product => !product.active)) v.fail(409, 'product_inactive');
  const items = canonicalLines(input, products);
  await (options.assertUnreservedSaleStock || assertUnreservedSaleStock)(
    c, companyId, productRows.rows, items, '');

  const companyRow = (await c.query(
    'SELECT name,data FROM myfin.companies WHERE id=$1 FOR SHARE', [companyId])).rows[0];
  if (!companyRow) v.fail(404, 'not_found');
  const company = { ...companyRow.data, name: companyRow.name }, prefs = company.preferences || {};
  const currentTaxRateAtRecording = Number(prefs.taxRate ?? prefs.tax ?? 0);
  const priceOverridden = items.some(item => cents(item.price) !== cents(item.catalogPrice));
  const taxOverridden = Math.abs(input.taxRate - currentTaxRateAtRecording) > 1e-9;
  const pricingOverridden = priceOverridden || taxOverridden;
  if (pricingOverridden && input.pricingOverrideReason.length < 8)
    v.fail(400, 'manual_sale_pricing_reason_required');
  let totals;
  try { totals = checkoutTotalsFor(items, input.taxRate, input.discount); }
  catch { v.fail(400, 'invalid_manual_sale_totals'); }
  if (totals.total <= 0 || totals.total > 1e9) v.fail(400, 'invalid_manual_sale_totals');

  let customer = null;
  if (input.customerId) {
    customer = (await c.query(
      'SELECT data FROM myfin.clients WHERE company_id=$1 AND id=$2 FOR SHARE',
      [companyId, input.customerId])).rows[0]?.data;
    if (!customer || customer.type === 'Supplier') v.fail(404, 'customer_not_found');
  }

  let deduction;
  try { deduction = deductItems(products, items, false); }
  catch { v.fail(409, 'stock_unavailable'); }
  const number = `MAN-${occurredDate.replaceAll('-', '')}-${id.slice(-8).toUpperCase()}`;
  const storeSnapshot = {
    name: company.name || '', address: company.address || '', phone: company.phone || '',
    registration: company.registration || '', currency: prefs.currency || 'RM',
    footer: prefs.receiptFooter || 'Thank you for shopping with us.', paperWidth: prefs.paperWidth || '80',
  };
  const companySnapshot = { ...storeSnapshot, email: company.email || '', logo: company.logo || '',
    qrCode: company.qrCode || company.qrCodeUrl || '' };
  const saved = {
    id, company_id: companyId, schemaVersion: 3, source: 'manual_sale', type: 'Invoice',
    number, status: 'Paid',
    paymentStatus: input.paymentStatus, paymentMethod: input.paymentMethod,
    paymentReference: input.paymentReference,
    date: occurredIso, occurredAt: occurredIso, businessDate: occurredDate,
    recordedAt: serverIso, recordedById: who.id, recordedByName: who.username || who.email || 'Manager',
    recordingMode: 'manual_backdated', recordingReason: input.recordingReason,
    pricingPolicy: 'reviewed_historical_price_with_catalog_snapshot',
    pricingSnapshotCapturedAt: serverIso, pricingOverridden,
    ...(pricingOverridden ? { pricingOverrideReason: input.pricingOverrideReason } : {}),
    currentTaxRateAtRecording,
    inventoryPolicy: input.inventoryPolicy, recipePolicy: 'current_recipe_at_recording',
    items, ...totals, client_id: input.customerId,
    customerName: customer?.name || 'Walk-in customer', customerEmail: customer?.email || '',
    cashierId: who.id, cashierName: who.username || who.email || 'Manager',
    received: totals.total, change: 0,
    stockShortage: false, offline: false, receiptTemplateId: '', receiptTemplateVersion: 0,
    storeSnapshot, companySnapshot, templateSnapshot: templateDefaults('Receipt'),
  };
  await c.query(`INSERT INTO myfin.transactions(
      company_id,id,actor_id,source,total,fingerprint,data)
    VALUES($1,$2,$3,'manual_sale',$4,$5,$6)`,
  [companyId, id, who.id, totals.total, requestDigest, saved]);
  await (options.assertOrderCreated || assertOrderCreated)(c, companyId, id);
  try {
    await (options.consumeRecipeStock || consumeRecipeStock)(c, { companyId, actorId: who.id, saleId: id,
      serverOccurredAt: serverIso, capturedAt: occurredIso, items, offline: false });
  } catch (error) {
    if (error?.message === 'recipe_stock_unavailable') v.fail(409, 'recipe_stock_unavailable');
    throw error;
  }
  for (const product of deduction.updates) {
    product.version++;
    await c.query(`UPDATE myfin.products SET data=$3,stock=$4,version=version+1
      WHERE company_id=$1 AND id=$2`, [companyId, product.id, product, product.stock]);
    for (const variant of product.variants) await c.query(
      `UPDATE myfin.product_variants SET stock=$4
        WHERE company_id=$1 AND product_id=$2 AND id=$3`,
      [companyId, product.id, variant.id, variant.stock]);
  }
  await c.query(`INSERT INTO myfin.stock_movements(company_id,id,actor_id,data,sale_id)
    VALUES($1,$2,$3,$4,$2)`, [companyId, id, who.id, {
    saleId: id, action: 'Recorded sale stock deduction', date: serverIso, occurredAt: occurredIso,
    cashierId: who.id, recordingMode: 'manual_backdated', movements: deduction.movements, shortage: false,
  }]);
  await audit(c, who, companyId, 'Record backdated sale',
    `${number} · occurred ${occurredDate} · ${input.paymentStatus} / ${input.paymentMethod} · ${totals.total.toFixed(2)}${pricingOverridden ? ` · historical pricing: ${input.pricingOverrideReason}` : ''} · ${input.recordingReason}`,
    id);
  return publicTransaction(saved, who);
}

function recordOutput(row, who) {
  const total = Number(row.total ?? row.data?.total ?? 0), paid = row.data?.paymentStatus === 'Paid' ? total : 0;
  const data = { ...row.data, id: row.id, company_id: row.company_id,
    createdBy: row.actor_id, documentState: 'recorded', paidAmount: paid,
    outstandingAmount: Math.max(0, cents(total) - cents(paid)) / 100 };
  return publicTransaction(data, who);
}

export function registerManualSales(app, { scoped, audit }) {
  app.post('/api/companies/:company/manual-sales', req =>
    scoped(req, (c, companyId) => recordManualSale(c, req.identity, companyId, req.body, audit)));
}

export { paymentMethods };
