import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { canonical } from '../../src/domain/pos.js';
import { activeReservationQuantities, releaseOrderReservations } from './customer-order-reservations.js';
import { customerOrderDefaults, customerPhoneSchema, customerSession } from './customer-auth.js';
import { createPricingSnapshot, decimalToScaledInteger, loadPricingSnapshot, releaseOrderPromotionReservations,
  reserveOrderPromotions } from './pricing-engine.js';
import { assertRecipeAvailability, recipeAvailabilityForProducts } from './inventory-recipes.js';
import { redactExpiredOrderContacts, requirePublishedStorefrontPrivacy,
  storefrontPrivacyComplete, storefrontPrivacyOutput } from './storefront-privacy.js';
import { onlinePaymentReleaseBlocker } from './online-payment-lock.js';
import * as v from './validation.js';

const cookieName = '__Host-myfin_guest_order';
const anonymousPromotionHoldMs = 5 * 60 * 1000;
const itemSchema = z.strictObject({
  productId: v.id,
  variantId: z.union([v.id, z.literal('')]).default(''),
  quantity: z.number().finite().positive().max(1000)
    .refine(value => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6),
});
const deliveryAddressSchema = z.strictObject({
  addressLine1: z.string().trim().min(1).max(160),
  addressLine2: z.string().trim().max(160).default(''),
  postcode: z.string().trim().min(2).max(20),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().min(1).max(120),
  countryCode: z.literal('MY').default('MY'),
  instructions: z.string().trim().max(500).default(''),
});
const deliverySchema = z.strictObject({ zoneId: v.id, address: deliveryAddressSchema });
const cartSchema = z.strictObject({
  locationToken: z.string().min(32).max(256).optional(),
  locationId: v.id.optional(),
  serviceMode: z.enum(['pickup', 'table', 'delivery']).default('pickup'),
  delivery: deliverySchema.optional(),
  items: z.array(itemSchema).min(1).max(100),
});
const quoteSchema = cartSchema.extend({
  voucherCode: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9-]+$/).optional(),
});
const submitSchema = cartSchema.extend({
  guest: z.strictObject({
    name: z.string().trim().max(120).default(''),
    email: z.union([z.literal(''), z.email().max(254)]).default(''),
    phone: customerPhoneSchema,
  }),
  notes: z.string().trim().max(1000).default(''),
  quoteToken: z.string().min(80).max(4000),
});

const digest = value => createHash('sha256').update(value).digest('hex');
const tokenDigest = token => digest(`myfin-guest-order:${token}`);
const parseCookies = header => Object.fromEntries(String(header || '').split(';').map(part => {
  const at = part.indexOf('=');
  return at < 0 ? ['', ''] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
}).filter(([key]) => key));
const safeImage = value => typeof value === 'string' && value.length <= 2048 &&
  (/^https:\/\/\S+$/i.test(value) ||
    /^\/api\/public\/storefront-assets\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
  ? value : '';
const safeAction = value => typeof value === 'string' && value.length <= 2048 && (/^https:\/\/\S+$/i.test(value) ||
  (/^\/[A-Za-z0-9/_?&=.%#-]*$/.test(value) && !value.startsWith('//'))) ? value : '';
const boundedText = (value, max) => String(value || '').trim().slice(0, max);
const lineKey = item => `${item.productId}\u0000${item.variantId || ''}`;
const normalizedIp = value => String(value || '').replace(/^::ffff:/, '');
export function storefrontRateKey(req, authOptions = {}) {
  const remote = normalizedIp(req.socket?.remoteAddress || req.ip);
  if ((authOptions.publicProxyAddresses || []).includes(remote)) {
    const forwarded = Array.isArray(req.headers['x-myfin-client-ip']) ? '' : normalizedIp(req.headers['x-myfin-client-ip']);
    if (isIP(forwarded)) return forwarded;
  }
  return remote || 'unknown';
}

function publicContext(req) {
  if (req.tenant?.surface !== 'storefront') v.fail(404, 'not_found');
  return req.tenant;
}

async function settings(c, companyId, published = true) {
  const row = (await c.query(
    `SELECT s.*,c.name AS company_name,c.data AS company_data,c.workspace_id
       FROM myfin.storefront_settings s JOIN myfin.companies c ON c.id=s.company_id
      WHERE s.company_id=$1 AND ($2=false OR s.published)`, [companyId, published],
  )).rows[0];
  if (!row) v.fail(404, 'storefront_not_found');
  if (published && !storefrontPrivacyComplete(row)) v.fail(409, 'storefront_privacy_notice_unavailable');
  if (published) await redactExpiredOrderContacts(c, companyId);
  return row;
}

async function locationFor(c, companyId, input) {
  if (input.serviceMode === 'table' && !input.locationToken) v.fail(400, 'shop_qr_required');
  let row;
  if (input.locationToken) {
    row = (await c.query(
      `SELECT * FROM myfin.shop_locations
        WHERE company_id=$1 AND token_digest=$2 AND active FOR SHARE`,
      [companyId, digest(input.locationToken)],
    )).rows[0];
  } else if (input.locationId) {
    row = (await c.query(
      `SELECT * FROM myfin.shop_locations WHERE company_id=$1 AND id=$2 AND active FOR SHARE`,
      [companyId, input.locationId],
    )).rows[0];
    if (row?.fulfillment_mode === 'table' || input.serviceMode === 'table') row = null;
  } else {
    const result = await c.query(
      `SELECT * FROM myfin.shop_locations
        WHERE company_id=$1 AND active AND fulfillment_mode IN ('pickup','both') ORDER BY created_at,id LIMIT 2`,
      [companyId],
    );
    if (result.rowCount === 1) row = result.rows[0];
  }
  const allowed = input.serviceMode === 'delivery'
    ? ['pickup','both'].includes(row?.fulfillment_mode)
    : row && (row.fulfillment_mode === 'both' || row.fulfillment_mode === input.serviceMode);
  if (!row || !allowed)
    v.fail(400, 'invalid_shop_location');
  return row;
}

function cartTokenInput(input) {
  return { locationToken: input.locationToken || '', locationId: input.locationId || '',
    serviceMode: input.serviceMode, delivery: input.delivery || null, items: input.items };
}

function orderRequestDigest(context, input) {
  return digest(JSON.stringify(canonical({ companyId: context.company_id, hostname: context.hostname, input })));
}

function quoteToken(secret, context, input, quote, binding = {}) {
  const payload = Buffer.from(JSON.stringify({ companyId: context.company_id, hostname: context.hostname,
    cartDigest: digest(JSON.stringify(canonical(cartTokenInput(input)))),
    quoteDigest: digest(JSON.stringify(canonical(quote))), snapshotId: binding.snapshotId || '',
    snapshotRequestDigest: binding.snapshotRequestDigest || '', principalDigest: binding.principalDigest || '',
    expiresAt: Number(binding.expiresAt || Date.now() + 5 * 60000) })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyQuoteToken(secret, token, context, input, quote = null, binding = {}) {
  const [payload, supplied, ...extra] = token.split('.');
  if (!payload || !supplied || extra.length) v.fail(409, 'quote_changed');
  const expected = createHmac('sha256', secret).update(payload).digest();
  let actual;
  try { actual = Buffer.from(supplied, 'base64url'); } catch { v.fail(409, 'quote_changed'); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) v.fail(409, 'quote_changed');
  let value;
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { v.fail(409, 'quote_changed'); }
  const cartDigest = digest(JSON.stringify(canonical(cartTokenInput(input))));
  if (value.companyId !== context.company_id || value.hostname !== context.hostname ||
      !Number.isFinite(value.expiresAt) || value.expiresAt < Date.now() ||
      value.cartDigest !== cartDigest || (binding.principalDigest || '') !== (value.principalDigest || '') ||
      !value.snapshotId || !/^[A-Za-z0-9_-]{1,128}$/.test(value.snapshotId) ||
      !/^[0-9a-f]{64}$/.test(value.snapshotRequestDigest || '')) v.fail(409, 'quote_changed');
  if (quote && value.quoteDigest !== digest(JSON.stringify(canonical(quote)))) v.fail(409, 'quote_changed');
  return value;
}

function principalDigest(customer, session) {
  return digest(customer?.customerId ? `customer:${customer.customerId}` : `guest:${session?.digest || ''}`);
}

const normalizedPromotionPhone = value => String(value || '').replace(/[^0-9]/g, '');
const promotionGuardDigest = (secret, kind, value) => createHmac('sha256', secret)
  .update(`myfin-promotion-hold:${kind}:${value}`).digest('hex');

function scarceHoldExpiry(configuredExpiry, guard, customerId, now = Date.now()) {
  const configured = new Date(configuredExpiry);
  if (customerId || !guard.limitedPromotionCount) return configured;
  return new Date(Math.min(configured.getTime(), now + anonymousPromotionHoldMs));
}

// Promotion capacity is globally serialized by reserve_order_promotions. These
// additional advisory locks serialize the durable principals an attacker cannot
// change merely by rotating IP addresses. Contact values never enter lock keys
// or logs: only secret-keyed digests are used for serialization.
async function assessPromotionHold(c, { workspaceId, companyId, snapshotId, customerId = '',
  guestSessionDigest, guestEmail = '', guestPhone = '', secret }) {
  const applications = (await c.query(
    `SELECT d.promotion_id,d.voucher_id,p.max_total_redemptions,
            vv.max_redemptions AS voucher_max_redemptions
       FROM myfin.pricing_snapshot_discounts d
       JOIN myfin.promotion_versions p
         ON p.workspace_id=d.workspace_id AND p.company_id=d.company_id
        AND p.promotion_id=d.promotion_id AND p.version=d.promotion_version
       LEFT JOIN myfin.promotion_voucher_versions vv
         ON vv.workspace_id=d.workspace_id AND vv.company_id=d.company_id
        AND vv.promotion_id=d.promotion_id AND vv.voucher_id=d.voucher_id
        AND vv.version=d.voucher_version
      WHERE d.workspace_id=$1 AND d.company_id=$2 AND d.snapshot_id=$3
        AND (p.max_total_redemptions IS NOT NULL OR vv.max_redemptions IS NOT NULL)
      ORDER BY d.promotion_id`, [workspaceId, companyId, snapshotId],
  )).rows;
  if (!applications.length) return { allowed: true, limitedPromotionCount: 0, hasVoucher: false };

  // Authenticated customers are bound only to their durable customer identity.
  // Treating caller-supplied contact text as another principal would let an
  // anonymous order using somebody else's address block that customer's cart.
  const email = customerId ? '' : String(guestEmail || '').trim().toLowerCase();
  const phone = customerId ? '' : normalizedPromotionPhone(guestPhone);
  const principals = [
    ['guest_session', guestSessionDigest],
    ...(customerId ? [['customer', customerId]] : []),
    ...(!customerId && email ? [['contact_email', email]] : []),
    ...(!customerId && phone ? [['contact_phone', phone]] : []),
  ];
  // Fail closed if a caller ever reaches this guard without the durable guest
  // session that quote and submit are already required to share.
  if (!guestSessionDigest || typeof secret !== 'string' || secret.length < 32)
    return { allowed: false, reason: 'principal_unavailable', limitedPromotionCount: applications.length,
      hasVoucher: applications.some(row => Boolean(row.voucher_id)) };

  const locks = new Set();
  for (const [kind, value] of principals)
    locks.add(promotionGuardDigest(secret, `${companyId}:${kind}`, value));
  // One company-wide anonymous lock keeps fresh-cookie and fresh-contact attempts
  // from racing the shared campaign/voucher budget. Registered customers use
  // their stable customer principal while SQL promotion-row locks protect the
  // ordinary global redemption counters.
  if (!customerId) locks.add(promotionGuardDigest(secret, 'anonymous_company', companyId));
  for (const key of [...locks].sort())
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,41))', [key]);
  const countRows = (await c.query(
    `WITH guard AS (
       SELECT * FROM jsonb_to_recordset($7::jsonb) AS x(promotion_id text,voucher_id text)
     )
     SELECT g.promotion_id,
       count(DISTINCT r.order_id) FILTER (WHERE o.id IS NOT NULL AND
         o.guest_session_digest=$2)::integer AS session_holds,
       count(DISTINCT r.order_id) FILTER (WHERE o.id IS NOT NULL AND
         $3::text<>'' AND o.customer_id=$3)::integer AS customer_holds,
       count(DISTINCT r.order_id) FILTER (WHERE o.id IS NOT NULL AND
         $4::text<>'' AND lower(o.guest_email)=$4)::integer AS email_holds,
       count(DISTINCT r.order_id) FILTER (WHERE o.id IS NOT NULL AND $5::text<>'' AND
         regexp_replace(o.guest_phone,'[^0-9]','','g')=$5)::integer AS phone_holds,
       count(DISTINCT r.order_id) FILTER (WHERE o.id IS NOT NULL AND
         o.customer_id IS NULL)::integer AS anonymous_campaign_holds,
       count(DISTINCT r.order_id) FILTER (WHERE o.id IS NOT NULL AND
         o.customer_id IS NULL AND g.voucher_id<>'' AND
         r.voucher_id=g.voucher_id)::integer AS anonymous_voucher_holds
      FROM guard g
      LEFT JOIN myfin.promotion_reservations r
        ON r.company_id=$1 AND r.workspace_id=$6 AND r.promotion_id=g.promotion_id
       AND r.source_type='customer_order' AND r.state='active' AND r.expires_at>now()
      LEFT JOIN myfin.customer_order_requests o
        ON o.company_id=r.company_id AND o.id=r.order_id AND o.payment_state='unpaid'
       AND o.status IN ('awaiting_acceptance','accepted','preparing','ready')
     GROUP BY g.promotion_id`,
    [companyId, guestSessionDigest, customerId, email, phone, workspaceId,
      JSON.stringify(applications.map(row => ({ promotion_id: row.promotion_id,
        voucher_id: row.voucher_id || '' })))],
  )).rows;
  const countsByPromotion = new Map(countRows.map(row => [row.promotion_id, row]));

  for (const row of applications) {
    const counts = countsByPromotion.get(row.promotion_id) || {};
    if (Number(counts.session_holds) > 0 || Number(counts.customer_holds) > 0 ||
        Number(counts.email_holds) > 0 || Number(counts.phone_holds) > 0)
      return { allowed: false, reason: 'principal_active_hold', limitedPromotionCount: applications.length,
        hasVoucher: applications.some(item => Boolean(item.voucher_id)) };
    if (!customerId && row.max_total_redemptions !== null) {
      const capacity = Number(row.max_total_redemptions);
      const budget = Math.max(1, Math.min(10, Math.floor(capacity / 4)));
      if (Number(counts.anonymous_campaign_holds) >= budget)
        return { allowed: false, reason: 'anonymous_campaign_budget', limitedPromotionCount: applications.length,
          hasVoucher: applications.some(item => Boolean(item.voucher_id)) };
    }
    if (!customerId && row.voucher_id && row.voucher_max_redemptions !== null) {
      const capacity = Number(row.voucher_max_redemptions);
      const budget = Math.max(1, Math.min(10, Math.floor(capacity / 4)));
      if (Number(counts.anonymous_voucher_holds) >= budget)
        return { allowed: false, reason: 'anonymous_voucher_budget', limitedPromotionCount: applications.length,
          hasVoucher: true };
    }
  }
  return { allowed: true, limitedPromotionCount: applications.length,
    hasVoucher: applications.some(row => Boolean(row.voucher_id)) };
}

async function publishedCart(c, companyId, input, snapshot = null) {
  const config = await settings(c, companyId);
  if (input.items.length > config.max_order_items) v.fail(400, 'order_item_limit');
  const seen = new Set();
  for (const item of input.items) {
    if (item.quantity > Number(config.max_item_quantity)) v.fail(400, 'item_quantity_limit');
    const key = lineKey(item);
    if (seen.has(key)) v.fail(400, 'duplicate_order_line');
    seen.add(key);
  }
  const ids = [...new Set(input.items.map(item => item.productId))].sort();
  const result = await c.query(
    `SELECT p.id,p.data,p.price,p.stock,sp.display_name,sp.description,sp.sold_out
      FROM myfin.products p JOIN myfin.storefront_products sp
         ON sp.company_id=p.company_id AND sp.product_id=p.id
      WHERE p.company_id=$1 AND p.id=ANY($2::text[]) AND sp.published
        AND coalesce(p.data->>'active','true')<>'false'
      ORDER BY p.id FOR SHARE OF p`, [companyId, ids],
  );
  if (result.rowCount !== ids.length) v.fail(409, 'menu_item_unavailable');
  const variantRows = await c.query(
    `SELECT product_id,variant_id,published,sold_out FROM myfin.storefront_product_variants
      WHERE company_id=$1 AND product_id=ANY($2::text[])`, [companyId, ids],
  );
  const visibility = new Map(variantRows.rows.map(row => [`${row.product_id}\u0000${row.variant_id}`, row]));
  const reserved = await activeReservationQuantities(c, companyId, ids);
  const lines = input.items.map((item, index) => {
    const row = result.rows.find(product => product.id === item.productId);
    if (!row || row.sold_out) v.fail(409, 'menu_item_unavailable');
    const product = row.data;
    if (product.active === false) v.fail(409, 'menu_item_unavailable');
    const variant = item.variantId ? product.variants?.find(entry => entry.id === item.variantId) : null;
    if (item.variantId) {
      const publication = visibility.get(lineKey(item));
      if (!variant || !publication?.published || publication.sold_out) v.fail(409, 'menu_item_unavailable');
    } else if (product.variants?.length) v.fail(400, 'menu_variant_required');
    if (product.trackStock) {
      const available = Number((variant || product).stock || 0) - (reserved.get(lineKey(item)) || 0);
      if (available < item.quantity) v.fail(409, 'menu_item_unavailable');
    }
    return {
      lineNo: index + 1, productId: item.productId, variantId: item.variantId || '',
      description: row.display_name || product.name, variant: variant?.name || '',
      sku: variant?.sku || product.sku || '', unit: product.unit || 'pcs',
      qty: item.quantity,
    };
  });
  try{
    await assertRecipeAvailability(c,{companyId,items:lines.map(line=>({productId:line.productId,
      variantId:line.variantId,qty:line.qty,lineNo:line.lineNo})),lock:'share'});
  }catch(error){
    if(['recipe_stock_unavailable','recipe_stock_changed','recipe_count_requires_whole_units'].includes(error?.message))
      v.fail(409,'menu_item_unavailable');
    throw error;
  }
  if (snapshot) {
    if (snapshot.lines.length !== lines.length) v.fail(409, 'quote_changed');
    for (const line of lines) {
      const quoted = snapshot.lines.find(item => item.productId === line.productId && item.variantId === line.variantId);
      if (!quoted || quoted.quantityMilli !== Math.round(line.qty * 1000)) v.fail(409, 'quote_changed');
    }
  }
  return { config, lines, currency: config.company_data?.preferences?.currency || 'RM' };
}

function totalsFromSnapshot(snapshot, feeSen = 0, includeDeliveryFee = false) {
  const amount = Number(feeSen);
  if (!Number.isSafeInteger(amount) || amount < 0) v.fail(409, 'delivery_unavailable');
  const beforeSen = snapshot.taxableSen + snapshot.taxSen + amount;
  const remainder = beforeSen % 5;
  const roundingSen = remainder ? (remainder <= 2 ? -remainder : 5 - remainder) : 0;
  return { subtotal: snapshot.subtotalSen / 100, discountAmount: snapshot.discountSen / 100,
    discount: 0, tax: snapshot.taxSen / 100, taxRate: snapshot.taxBasisPoints / 100,
    ...(includeDeliveryFee ? { deliveryFee: amount / 100 } : {}),
    totalBeforeRounding: beforeSen / 100, rounding: roundingSen / 100,
    total: (beforeSen + roundingSen) / 100 };
}

// Compatibility helper for existing delivery tests and non-promotion callers.
function totalsWithDelivery(totals, feeSen) {
  const subtotalSen = Math.round(Number(totals.subtotal) * 100);
  const discountSen = Math.round(Number(totals.discountAmount) * 100);
  const taxSen = Math.round(Number(totals.tax) * 100);
  return totalsFromSnapshot({ subtotalSen, discountSen, taxableSen: subtotalSen - discountSen,
    taxSen, taxBasisPoints: Math.round(Number(totals.taxRate || 0) * 100),
    totalSen: subtotalSen - discountSen + taxSen }, feeSen, true);
}

async function deliveryFor(c, companyId, input, priced) {
  if (input.serviceMode !== 'delivery') {
    if (input.delivery) v.fail(400, 'delivery_details_not_allowed');
    return null;
  }
  if (!input.delivery) v.fail(400, 'delivery_details_required');
  const zone = (await c.query(
    `SELECT z.* FROM myfin.storefront_delivery_zones z
       JOIN myfin.storefront_settings s ON s.company_id=z.company_id
      WHERE z.company_id=$1 AND z.id=$2 AND z.enabled AND s.delivery_enabled FOR SHARE OF z`,
    [companyId, input.delivery.zoneId],
  )).rows[0];
  if (!zone) v.fail(409, 'delivery_unavailable');
  const merchandiseSen = priced.snapshot.taxableSen;
  if (merchandiseSen < Number(zone.minimum_order_sen)) v.fail(400, 'delivery_minimum_not_met');
  const totals = totalsFromSnapshot(priced.snapshot, Number(zone.fee_sen), true);
  if (totals.total > Number(priced.config.max_order_value)) v.fail(400, 'order_value_limit');
  return { zone, totals, address: input.delivery.address };
}

function deliveryQuote(delivery) {
  if (!delivery) return undefined;
  return { zoneId: delivery.zone.id, zoneName: delivery.zone.name,
    fee: Number(delivery.zone.fee_sen) / 100,
    minimumOrder: Number(delivery.zone.minimum_order_sen) / 100,
    leadTimeMinutes: Number(delivery.zone.lead_time_minutes),
    serviceInstructions: delivery.zone.service_instructions };
}

function quoteFor(input, location, priced, delivery) {
  const totals = delivery?.totals || totalsFromSnapshot(priced.snapshot);
  if (totals.total <= 0 || totals.total > Number(priced.config.max_order_value))
    v.fail(400, 'order_value_limit');
  return { locationId: location.id, serviceMode: input.serviceMode,
    items: priced.lines.map(item => ({ productId: item.productId, variantId: item.variantId,
      description: item.description, variant: item.variant, unit: item.unit, quantity: item.qty,
      unitPrice: item.unitPriceSen / 100, lineTotal: item.grossSen / 100 })),
    ...totals, discounts: priced.snapshot.discounts.map(item => ({ name: item.name, amount: item.discountSen / 100 })),
    currency: priced.currency, ...(delivery ? { delivery: deliveryQuote(delivery) } : {}) };
}

async function pricedCart(c, context, input, customerId, voucherPepper) {
  const publication = await publishedCart(c, context.company_id, input);
  const snapshot = await createPricingSnapshot(c, {
    workspaceId: context.workspace_id, companyId: context.company_id, customerId,
    lines: input.items.map(item => ({ productId: item.productId, variantId: item.variantId || '',
      quantityMilli: Math.round(item.quantity * 1000) })),
    ...(input.voucherCode ? { voucherCode: input.voucherCode } : {}),
  }, { voucherPepper, cashRounding: false });
  const lines = publication.lines.map(line => {
    const priced = snapshot.lines.find(item => item.productId === line.productId && item.variantId === line.variantId);
    if (!priced) v.fail(409, 'quote_changed');
    return { ...line, unitPriceSen: priced.unitPriceSen, grossSen: priced.grossSen };
  });
  return { ...publication, lines, snapshot };
}

async function snapshotCart(c, context, input, customerId, token) {
  const snapshot = await loadPricingSnapshot(c, { workspaceId: context.workspace_id,
    companyId: context.company_id, snapshotId: token.snapshotId, customerId,
    requestDigest: token.snapshotRequestDigest });
  const publication = await publishedCart(c, context.company_id, input, snapshot);
  return { ...publication, snapshot, lines: publication.lines.map(line => {
    const priced = snapshot.lines.find(item => item.productId === line.productId && item.variantId === line.variantId);
    return { ...line, unitPriceSen: priced.unitPriceSen, grossSen: priced.grossSen };
  }) };
}

function orderOutput(row, lines = []) {
  const mode = row.service_mode || (row.fulfillment_mode === 'table' ? 'table' : 'pickup');
  const zone = row.delivery_zone_snapshot || {};
  const address = row.delivery_address_snapshot || {};
  return {
    id: row.id, code: row.public_code, companyId: row.company_id, locationId: row.location_id,
    guestName: row.guest_name || '',
    status: row.status === 'awaiting_acceptance' ? 'submitted' : row.status,
    paymentState: row.payment_state, fulfillmentStatus: row.fulfillment_status || '',
    version: Number(row.version), currency: row.currency,
    subtotal: Number(row.subtotal), discountAmount: Number(row.discount_amount), tax: Number(row.tax),
    taxRate: Number(row.tax_rate), totalBeforeRounding: Number(row.total_before_rounding),
    rounding: Number(row.rounding), total: Number(row.total),
    serviceMode: mode,
    notes: row.notes || '', contactRedactedAt: row.pii_redacted_at || null,
    pickupAt: row.pickup_at, expiresAt: row.expires_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
    location: row.location_name ? { id: row.location_id, name: row.location_name,
      fulfillmentMode: row.fulfillment_mode, tableLabel: row.table_label || '',
      pickupInstructions: row.pickup_instructions || '' } : undefined,
    ...(mode === 'delivery' ? { deliveryFee: Number(row.delivery_fee_sen || 0) / 100, delivery: {
      zoneId: row.delivery_zone_id, zoneName: zone.name || '', fee: Number(row.delivery_fee_sen || 0) / 100,
      leadTimeMinutes: Number(zone.leadTimeMinutes || 0), serviceInstructions: zone.serviceInstructions || '',
      addressRedacted: Boolean(row.delivery_address_redacted_at),
      ...(!row.delivery_address_redacted_at ? { address: { postcode: address.postcode || '', city: address.city || '',
        state: address.state || '', countryCode: address.countryCode || 'MY' } } : {}),
    } } : {}),
    items: lines.map(line => ({
      productId: line.product_id, variantId: line.variant_id || '', description: line.description,
      variant: line.variant_name || '', unit: line.unit,
      quantity: Number(line.quantity), unitPrice: Number(line.unit_price), lineTotal: Number(line.line_total),
    })),
  };
}

async function orderLines(c, companyId, orderId) {
  return (await c.query(
    `SELECT * FROM myfin.customer_order_lines WHERE company_id=$1 AND order_id=$2 ORDER BY line_no`,
    [companyId, orderId],
  )).rows;
}

async function existingGuestSession(c, req, hostname) {
  const token = parseCookies(req.headers.cookie)[cookieName];
  if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  const tokenHash = tokenDigest(token);
  const row = (await c.query(
    `SELECT token_digest FROM myfin.customer_guest_sessions
      WHERE token_digest=$1 AND storefront_hostname=$2 AND revoked_at IS NULL AND expires_at>now()`,
    [tokenHash, hostname],
  )).rows[0];
  if (!row) return null;
  await c.query(`UPDATE myfin.customer_guest_sessions SET last_seen_at=now()
    WHERE token_digest=$1 AND last_seen_at<now()-interval '5 minutes'`, [tokenHash]);
  return { token, digest: tokenHash };
}

async function guestSession(c, req, reply, hostname, create = false) {
  const existing = await existingGuestSession(c, req, hostname);
  if (existing || !create) return existing;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = tokenDigest(token);
  await c.query(
    `INSERT INTO myfin.customer_guest_sessions(token_digest,storefront_hostname,expires_at)
     VALUES($1,$2,now()+interval '7 days')`, [tokenHash, hostname],
  );
  reply.header('Set-Cookie', `${cookieName}=${token}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax`);
  return { token, digest: tokenHash };
}

async function expireIfNeeded(c, order) {
  if (!['awaiting_acceptance','accepted','preparing','ready'].includes(order.status) || new Date(order.expires_at) > new Date()) return order;
  if (await onlinePaymentReleaseBlocker(c, order.company_id, order.id)) return order;
  const nextVersion = Number(order.version) + 1;
  const updated = (await c.query(
    `UPDATE myfin.customer_order_requests SET status='expired',version=$3,updated_at=now()
      WHERE company_id=$1 AND id=$2 AND version=$4 RETURNING *`,
    [order.company_id, order.id, nextVersion, order.version],
  )).rows[0];
  if (!updated) return (await c.query(
    'SELECT * FROM myfin.customer_order_requests WHERE company_id=$1 AND id=$2', [order.company_id, order.id],
  )).rows[0];
  await releaseOrderReservations(c, order.company_id, order.id, 'expired');
  await releaseOrderPromotionReservations(c, { companyId: order.company_id, orderId: order.id, reason: 'expired' });
  await c.query(
    `INSERT INTO myfin.customer_order_events(company_id,id,order_id,version,actor_type,request_id,request_digest,action,from_status,to_status,note)
     VALUES($1,$2,$3,$4,'system',$5,$6,'expired',$7,'expired','Order expired before payment.')`,
    [order.company_id, randomUUID(), order.id, nextVersion, `expire:${order.id}`, digest(`expire:${order.id}`), order.status],
  );
  return updated;
}

export function registerStorefrontPublic(app, { db, authOptions }) {
  const rate = (max) => ({ max, timeWindow: 60000, keyGenerator: req => storefrontRateKey(req, authOptions) });
  app.get('/api/public/storefront', { config: { rateLimit: rate(120) } }, async req => {
    const context = publicContext(req);
    const query = v.parse(z.strictObject({ locationToken: z.string().min(32).max(256).optional() }), req.query);
    return db.transaction(async c => {
      const config = await settings(c, context.company_id);
      let selectedLocation = null;
      if (query.locationToken) selectedLocation = (await c.query(
        `SELECT * FROM myfin.shop_locations WHERE company_id=$1 AND token_digest=$2 AND active`,
        [context.company_id, digest(query.locationToken)],
      )).rows[0] || null;
      if (query.locationToken && !selectedLocation) v.fail(400, 'invalid_shop_location');
      const locations = (await c.query(
        `SELECT id,name,fulfillment_mode,table_label,pickup_instructions FROM myfin.shop_locations
          WHERE company_id=$1 AND active AND fulfillment_mode IN ('pickup','both') ORDER BY created_at,id`, [context.company_id],
      )).rows;
      const deliveryZones = config.delivery_enabled ? (await c.query(
        `SELECT id,name,fee_sen,minimum_order_sen,lead_time_minutes,service_instructions
           FROM myfin.storefront_delivery_zones WHERE company_id=$1 AND enabled ORDER BY created_at,id`,
        [context.company_id],
      )).rows : [];
      const slides = (await c.query(
        `SELECT id,badge,title,description,image_url,background_color,cta_label,cta_url
           FROM myfin.storefront_carousel_slides WHERE company_id=$1 AND published ORDER BY sort_order,id`,
        [context.company_id],
      )).rows;
      const products = (await c.query(
        `SELECT p.id,p.data,p.price,p.stock,sp.display_name,sp.description,sp.sort_order,sp.sold_out,
                sp.online_price_sen
           FROM myfin.products p JOIN myfin.storefront_products sp
             ON sp.company_id=p.company_id AND sp.product_id=p.id
          WHERE p.company_id=$1 AND sp.published
            AND coalesce(p.data->>'active','true')<>'false'
          ORDER BY sp.sort_order,p.id FOR SHARE OF p`, [context.company_id],
      )).rows.filter(row => row.data?.active !== false);
      const ids = products.map(row => row.id);
      const variantRows = ids.length ? (await c.query(
        `SELECT spv.product_id,spv.variant_id,spv.published,spv.sold_out,spv.sort_order,
                spv.online_price_sen,pv.price AS store_price
           FROM myfin.storefront_product_variants spv JOIN myfin.product_variants pv
             ON pv.company_id=spv.company_id AND pv.product_id=spv.product_id AND pv.id=spv.variant_id
          WHERE spv.company_id=$1 AND spv.product_id=ANY($2::text[])`, [context.company_id, ids],
      )).rows : [];
      const cap = Number(config.max_item_quantity);
      const reserved = await activeReservationQuantities(c, context.company_id, ids);
      const recipeAvailability = await recipeAvailabilityForProducts(c,context.company_id,products,{cap});
      const projection = products.map(row => {
        const product = row.data;
        const availability = target => {
          const recipe=recipeAvailability.get(`${row.id}\u0000${target.id||''}`);
          return recipe?recipe.availableQuantity:product.trackStock
            ? Math.max(0, Math.min(cap, Math.floor((Number(target.stock || 0) - (reserved.get(`${row.id}\u0000${target.id || ''}`) || 0)) * 1000) / 1000))
            : cap;
        };
        const variants = (product.variants || []).map(variant => {
          const publication = variantRows.find(entry => entry.product_id === row.id && entry.variant_id === variant.id);
          const maxQuantity = publication?.sold_out ? 0 : availability(variant);
          const storePriceSen = publication ? decimalToScaledInteger(publication.store_price, 2, 'invalid_catalog_price') : 0;
          const onlinePriceSen = publication?.online_price_sen === null || publication?.online_price_sen === undefined
            ? (row.online_price_sen === null || row.online_price_sen === undefined ? storePriceSen : Number(row.online_price_sen))
            : Number(publication.online_price_sen);
          return publication?.published ? { id: variant.id, name: boundedText(variant.name, 120),
            storePrice: storePriceSen / 100, onlinePrice: onlinePriceSen / 100, price: onlinePriceSen / 100,
            hasOnlinePriceOverride: onlinePriceSen !== storePriceSen,
            available: maxQuantity > 0, maxQuantity, sortOrder: publication.sort_order } : null;
        }).filter(Boolean).sort((a, b) => a.sortOrder - b.sortOrder);
        const maxQuantity = row.sold_out || (product.variants?.length && !variants.some(item => item.available)) ? 0 : availability(product);
        const storePriceSen = decimalToScaledInteger(row.price, 2, 'invalid_catalog_price');
        const onlinePriceSen = row.online_price_sen === null || row.online_price_sen === undefined
          ? storePriceSen : Number(row.online_price_sen);
        return {
          id: row.id, active: true, name: boundedText(row.display_name || product.name, 120),
          description: boundedText(row.description || product.description, 2000),
          category: boundedText(product.category || 'Menu', 120), subcategory: boundedText(product.subcategory, 120),
          imageUrl: safeImage(product.imageUrl), unit: boundedText(product.unit || 'pcs', 40),
          storePrice: storePriceSen / 100, onlinePrice: onlinePriceSen / 100,
          price: onlinePriceSen / 100, hasOnlinePriceOverride: onlinePriceSen !== storePriceSen, available: maxQuantity > 0,
          maxQuantity: product.variants?.length ? undefined : maxQuantity, variants,
        };
      });
      const preferences = config.company_data?.preferences || {};
      return {
        storefront: { companyId: context.company_id,
          name: boundedText(config.display_name || config.company_name, 120),
          description: boundedText(config.description, 2000), currency: boundedText(preferences.currency || 'RM', 8),
          taxRate: Number(preferences.taxRate ?? preferences.tax ?? 0),
          pickupInstructions: boundedText(config.pickup_instructions, 2000),
          logoUrl: safeImage(config.logo_url),
          theme: { primaryColor: config.theme_primary_color, accentColor: config.theme_accent_color,
            backgroundColor: config.theme_background_color, textColor: config.theme_text_color,
            fontFamily: config.theme_font_family },
          hero: { eyebrow: boundedText(config.hero_eyebrow, 80),
            title: boundedText(config.hero_title || config.display_name || config.company_name, 160),
            description: boundedText(config.hero_description || config.description, 1000),
            imageUrl: safeImage(config.hero_image_url) },
          carouselIntervalSeconds: Number(config.carousel_interval_seconds),
          privacy: storefrontPrivacyOutput(config) },
        slides: slides.slice(0, 12).map(row => ({ id: row.id, badge: boundedText(row.badge, 80),
          title: boundedText(row.title, 160), description: boundedText(row.description, 1000),
          imageUrl: safeImage(row.image_url), backgroundColor: row.background_color,
          ctaLabel: boundedText(row.cta_label, 60), ctaUrl: safeAction(row.cta_url) })),
        locations: locations.map(row => ({ id: row.id, name: row.name, fulfillmentMode: row.fulfillment_mode,
          pickupInstructions: row.pickup_instructions })),
        deliveryZones: deliveryZones.map(row => ({ id: row.id, name: row.name,
          fee: Number(row.fee_sen) / 100, minimumOrder: Number(row.minimum_order_sen) / 100,
          leadTimeMinutes: Number(row.lead_time_minutes), serviceInstructions: row.service_instructions })),
        location: selectedLocation ? { id: selectedLocation.id, name: selectedLocation.name,
          fulfillmentMode: selectedLocation.fulfillment_mode, tableLabel: selectedLocation.table_label } : null,
        products: projection,
      };
    });
  });

  app.post('/api/public/order-requests/quote', { config: { rateLimit: rate(30) } }, async (req, reply) => {
    const context = publicContext(req);
    const input = v.parse(quoteSchema, req.body);
    return db.transaction(async c => {
      await requirePublishedStorefrontPrivacy(c, context.company_id);
      const session = await guestSession(c, req, reply, context.hostname, true);
      const customer = await customerSession(c, req);
      const location = await locationFor(c, context.company_id, input);
      const priced = await pricedCart(c, context, input, customer?.customerId || '', authOptions.voucherHmacSecret);
      const delivery = await deliveryFor(c, context.company_id, input, priced);
      const quote = quoteFor(input, location, priced, delivery);
      return { quote, quoteToken: quoteToken(authOptions.secret, context, input, quote, {
        snapshotId: priced.snapshot.id, snapshotRequestDigest: priced.snapshot.requestDigest,
        principalDigest: principalDigest(customer, session),
        expiresAt: new Date(priced.snapshot.expiresAt).getTime(),
      }) };
    });
  });

  app.post('/api/public/order-requests', { config: { rateLimit: rate(10) } }, async (req, reply) => {
    const context = publicContext(req);
    const input = v.parse(submitSchema, req.body);
    const requestId = v.parse(z.uuid(), req.headers['idempotency-key']);
    const requestDigest = orderRequestDigest(context, input);
    return db.transaction(async c => {
      await requirePublishedStorefrontPrivacy(c, context.company_id);
      const session = await guestSession(c, req, reply, context.hostname, true);
      const customer = await customerSession(c, req);
      const defaults = await customerOrderDefaults(c, context.workspace_id, customer);
      const guest = {
        name: input.guest.name || defaults.name,
        email: (input.guest.email || defaults.email).toLowerCase(),
        phone: input.guest.phone || defaults.phone,
      };
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,18))',
        [`${context.company_id}:customer-order:${requestId}`]);
      const existing = (await c.query(
        'SELECT * FROM myfin.customer_order_requests WHERE company_id=$1 AND idempotency_key=$2 FOR UPDATE',
        [context.company_id, requestId],
      )).rows[0];
      if (existing) {
        if (existing.request_digest !== requestDigest) v.fail(409, 'idempotency_key_reused');
        const ownsExisting = existing.customer_id
          ? customer?.customerId === existing.customer_id
          : existing.guest_session_digest === session.digest;
        if (!ownsExisting) v.fail(403, 'guest_session_required');
        const location = (await c.query(
          `SELECT name AS location_name,fulfillment_mode,table_label,pickup_instructions
             FROM myfin.shop_locations WHERE company_id=$1 AND id=$2`,
          [context.company_id, existing.location_id],
        )).rows[0] || {};
        return { order: orderOutput({ ...await expireIfNeeded(c, existing), ...location },
          await orderLines(c, context.company_id, existing.id)) };
      }
      const binding = { principalDigest: principalDigest(customer, session) };
      const token = verifyQuoteToken(authOptions.secret, input.quoteToken, context, input, null, binding);
      const location = await locationFor(c, context.company_id, input);
      if (input.serviceMode !== 'table' && !guest.email && !guest.phone) v.fail(400, 'pickup_contact_required');
      const priced = await snapshotCart(c, context, input, customer?.customerId || '', token);
      const delivery = await deliveryFor(c, context.company_id, input, priced);
      const quote = quoteFor(input, location, priced, delivery);
      verifyQuoteToken(authOptions.secret, input.quoteToken, context, input, quote, binding);
      const promotionGuard = await assessPromotionHold(c, {
        workspaceId: context.workspace_id, companyId: context.company_id,
        snapshotId: priced.snapshot.id, customerId: customer?.customerId || '',
        guestSessionDigest: session.digest, guestEmail: guest.email, guestPhone: guest.phone,
        secret: authOptions.secret,
      });
      if (!promotionGuard.allowed) {
        req.log?.warn({ event: 'storefront_promotion_hold_blocked',
          reason: promotionGuard.reason, authenticatedCustomer: Boolean(customer),
          hasVoucher: promotionGuard.hasVoucher,
          limitedPromotionCount: promotionGuard.limitedPromotionCount },
        'Storefront promotion hold blocked');
        v.fail(409, 'promotion_unavailable');
      }
      const orderId = randomUUID();
      let code;
      for (let attempt = 0; attempt < 5; attempt++) {
        code = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
        const found = await c.query('SELECT 1 FROM myfin.customer_order_requests WHERE company_id=$1 AND public_code=$2', [context.company_id, code]);
        if (!found.rowCount) break;
        code = '';
      }
      if (!code) v.fail(503, 'order_code_unavailable');
      const configuredExpiry = new Date(Date.now() + Number(priced.config.order_expiry_minutes) * 60000);
      const expiresAt = scarceHoldExpiry(configuredExpiry, promotionGuard, customer?.customerId || '');
      const row = (await c.query(
        `INSERT INTO myfin.customer_order_requests(
          company_id,id,public_code,location_id,customer_id,guest_name,guest_email,guest_phone,notes,currency,
          subtotal,discount_amount,tax,tax_rate,total_before_rounding,rounding,total,
          guest_session_digest,idempotency_key,request_digest,expires_at,service_mode,delivery_zone_id,
          delivery_zone_snapshot,delivery_address_snapshot,delivery_contact_purpose,delivery_fee_sen,
          pricing_snapshot_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
           $22,$23,$24,$25,$26,$27,$28) RETURNING *`,
        [context.company_id, orderId, code, location.id, customer?.customerId || null,
          guest.name, guest.email, guest.phone, input.notes, priced.currency,
          quote.subtotal, quote.discountAmount, quote.tax,
          quote.taxRate, quote.totalBeforeRounding, quote.rounding, quote.total,
          session.digest, requestId, requestDigest, expiresAt, input.serviceMode,
          delivery?.zone.id || null,
          delivery ? JSON.stringify({ name: delivery.zone.name, feeSen: Number(delivery.zone.fee_sen),
            minimumOrderSen: Number(delivery.zone.minimum_order_sen),
            leadTimeMinutes: Number(delivery.zone.lead_time_minutes),
            serviceInstructions: delivery.zone.service_instructions }) : '{}',
          delivery ? JSON.stringify(delivery.address) : '{}', delivery ? 'order_delivery' : '',
          delivery ? Number(delivery.zone.fee_sen) : 0, priced.snapshot.id],
      )).rows[0];
      for (const item of priced.lines) await c.query(
        `INSERT INTO myfin.customer_order_lines(company_id,order_id,line_no,product_id,variant_id,description,variant_name,sku,unit,quantity,unit_price,line_total)
         VALUES($1,$2,$3,$4,nullif($5,''),$6,$7,$8,$9,$10,$11,$12)`,
        [context.company_id, orderId, item.lineNo, item.productId, item.variantId, item.description,
          item.variant, item.sku, item.unit, item.qty, item.unitPriceSen / 100, item.grossSen / 100],
      );
      await c.query(
        `INSERT INTO myfin.customer_order_events(company_id,id,order_id,version,actor_type,customer_actor_id,request_id,request_digest,action,to_status)
         VALUES($1,$2,$3,1,$4,$5,$6,$7,'submitted','awaiting_acceptance')`,
        [context.company_id, randomUUID(), orderId, customer ? 'customer' : 'guest',
          customer?.customerId || null, requestId, requestDigest],
      );
      try {
        await reserveOrderPromotions(c, { companyId: context.company_id, orderId,
          snapshotId: priced.snapshot.id, expiresAt });
      } catch (error) {
        if (/promotion|voucher|pricing_snapshot/i.test(String(error?.message || '')))
          v.fail(409, 'promotion_unavailable');
        throw error;
      }
      reply.code(201);
      return { order: orderOutput({ ...row, location_name: location.name, fulfillment_mode: location.fulfillment_mode,
        table_label: location.table_label, pickup_instructions: location.pickup_instructions },
      await orderLines(c, context.company_id, orderId)) };
    });
  });

  app.get('/api/public/order-requests/:code/status', { config: { rateLimit: rate(60) } }, async req => {
    const context = publicContext(req);
    const code = v.parse(z.string().regex(/^[A-Z0-9]{8}$/), String(req.params.code).toUpperCase());
    return db.transaction(async c => {
      await settings(c, context.company_id);
      const session = await guestSession(c, req, null, context.hostname, false);
      const customer = await customerSession(c, req);
      if (!session && !customer) v.fail(401, 'guest_session_required');
      let order = (await c.query(
        `SELECT o.*,fo.status AS fulfillment_status,l.name AS location_name,l.fulfillment_mode,l.table_label,l.pickup_instructions
         FROM myfin.customer_order_requests o
         JOIN myfin.shop_locations l ON l.company_id=o.company_id AND l.id=o.location_id
         LEFT JOIN myfin.customer_order_payments op ON op.company_id=o.company_id AND op.order_id=o.id
         LEFT JOIN myfin.orders fo ON fo.company_id=op.company_id AND fo.id=op.sale_id
          WHERE o.company_id=$1 AND o.public_code=$2 AND
            ((o.customer_id IS NULL AND o.guest_session_digest=$3) OR
             ($4::text IS NOT NULL AND o.customer_id=$4))`,
        [context.company_id, code, session?.digest || null, customer?.customerId || null],
      )).rows[0];
      if (!order) v.fail(404, 'order_not_found');
      const routed = order;
      order = { ...await expireIfNeeded(c, order), location_name: routed.location_name,
        fulfillment_mode: routed.fulfillment_mode, table_label: routed.table_label,
        pickup_instructions: routed.pickup_instructions, fulfillment_status: routed.fulfillment_status };
      const events = (await c.query(
        `SELECT version,to_status,created_at FROM myfin.customer_order_events
          WHERE company_id=$1 AND order_id=$2 ORDER BY version`, [context.company_id, order.id],
      )).rows;
      return { order: orderOutput(order, await orderLines(c, context.company_id, order.id)),
        events: events.map(event => ({ version: Number(event.version),
          status: event.to_status === 'awaiting_acceptance' ? 'submitted' : event.to_status, createdAt: event.created_at })) };
    });
  });
}

export { orderOutput, orderLines, expireIfNeeded, orderRequestDigest, pricedCart, quoteToken,
  assessPromotionHold, scarceHoldExpiry, totalsFromSnapshot, totalsWithDelivery, verifyQuoteToken };
