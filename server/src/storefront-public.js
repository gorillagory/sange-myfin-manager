import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { canonical, cents, checkoutTotalsFor } from '../../src/domain/pos.js';
import { activeReservationQuantities, releaseOrderReservations } from './customer-order-reservations.js';
import { customerOrderDefaults, customerPhoneSchema, customerSession } from './customer-auth.js';
import { redactExpiredOrderContacts, requirePublishedStorefrontPrivacy,
  storefrontPrivacyComplete, storefrontPrivacyOutput } from './storefront-privacy.js';
import * as v from './validation.js';

const cookieName = '__Host-myfin_guest_order';
const itemSchema = z.strictObject({
  productId: v.id,
  variantId: z.union([v.id, z.literal('')]).default(''),
  quantity: z.number().finite().positive().max(1000)
    .refine(value => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6),
});
const cartSchema = z.strictObject({
  locationToken: z.string().min(32).max(256).optional(),
  locationId: v.id.optional(),
  serviceMode: z.enum(['pickup', 'table']).default('pickup'),
  items: z.array(itemSchema).min(1).max(100),
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
const safeImage = value => /^https:\/\/\S+$/.test(value || '') ? value : '';
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
  if (!row || (row.fulfillment_mode !== 'both' && row.fulfillment_mode !== input.serviceMode))
    v.fail(400, 'invalid_shop_location');
  return row;
}

function quoteToken(secret, context, input, quote) {
  const payload = Buffer.from(JSON.stringify({ companyId: context.company_id, hostname: context.hostname,
    cartDigest: digest(JSON.stringify(canonical({ locationToken: input.locationToken || '', locationId: input.locationId || '',
      serviceMode: input.serviceMode, items: input.items }))),
    quoteDigest: digest(JSON.stringify(canonical(quote))),
    expiresAt: Date.now() + 5 * 60000 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyQuoteToken(secret, token, context, input, quote) {
  const [payload, supplied, ...extra] = token.split('.');
  if (!payload || !supplied || extra.length) v.fail(409, 'quote_changed');
  const expected = createHmac('sha256', secret).update(payload).digest();
  let actual;
  try { actual = Buffer.from(supplied, 'base64url'); } catch { v.fail(409, 'quote_changed'); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) v.fail(409, 'quote_changed');
  let value;
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { v.fail(409, 'quote_changed'); }
  const cartDigest = digest(JSON.stringify(canonical({ locationToken: input.locationToken || '', locationId: input.locationId || '',
    serviceMode: input.serviceMode, items: input.items })));
  const currentQuoteDigest = digest(JSON.stringify(canonical(quote)));
  if (value.companyId !== context.company_id || value.hostname !== context.hostname ||
      !Number.isFinite(value.expiresAt) || value.expiresAt < Date.now() ||
      value.cartDigest !== cartDigest || value.quoteDigest !== currentQuoteDigest) v.fail(409, 'quote_changed');
}

async function pricedCart(c, companyId, input) {
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
    const variant = item.variantId ? product.variants?.find(entry => entry.id === item.variantId) : null;
    if (item.variantId) {
      const publication = visibility.get(lineKey(item));
      if (!variant || !publication?.published || publication.sold_out) v.fail(409, 'menu_item_unavailable');
    } else if (product.variants?.length) v.fail(400, 'menu_variant_required');
    if (product.trackStock) {
      const available = Number((variant || product).stock || 0) - (reserved.get(lineKey(item)) || 0);
      if (available < item.quantity) v.fail(409, 'menu_item_unavailable');
    }
    const price = Number(variant?.price ?? row.price);
    return {
      lineNo: index + 1, productId: item.productId, variantId: item.variantId || '',
      description: row.display_name || product.name, variant: variant?.name || '',
      sku: variant?.sku || product.sku || '', unit: product.unit || 'pcs',
      qty: item.quantity, price,
    };
  });
  const preferences = config.company_data?.preferences || {};
  const totals = checkoutTotalsFor(lines, Number(preferences.taxRate ?? preferences.tax ?? 0), 0);
  if (totals.total <= 0 || totals.total > Number(config.max_order_value)) v.fail(400, 'order_value_limit');
  return { config, lines, totals, currency: preferences.currency || 'RM' };
}

function orderOutput(row, lines = []) {
  return {
    id: row.id, code: row.public_code, companyId: row.company_id, locationId: row.location_id,
    guestName: row.guest_name || '',
    status: row.status === 'awaiting_acceptance' ? 'submitted' : row.status,
    paymentState: row.payment_state, fulfillmentStatus: row.fulfillment_status || '',
    version: Number(row.version), currency: row.currency,
    subtotal: Number(row.subtotal), discountAmount: Number(row.discount_amount), tax: Number(row.tax),
    taxRate: Number(row.tax_rate), totalBeforeRounding: Number(row.total_before_rounding),
    rounding: Number(row.rounding), total: Number(row.total),
    notes: row.notes || '', contactRedactedAt: row.pii_redacted_at || null,
    pickupAt: row.pickup_at, expiresAt: row.expires_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
    location: row.location_name ? { id: row.location_id, name: row.location_name,
      fulfillmentMode: row.fulfillment_mode, tableLabel: row.table_label || '',
      pickupInstructions: row.pickup_instructions || '' } : undefined,
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
      const products = (await c.query(
        `SELECT p.id,p.data,p.price,p.stock,sp.display_name,sp.description,sp.sort_order,sp.sold_out
           FROM myfin.products p JOIN myfin.storefront_products sp
             ON sp.company_id=p.company_id AND sp.product_id=p.id
          WHERE p.company_id=$1 AND sp.published ORDER BY sp.sort_order,p.id`, [context.company_id],
      )).rows;
      const ids = products.map(row => row.id);
      const variantRows = ids.length ? (await c.query(
        `SELECT product_id,variant_id,published,sold_out,sort_order FROM myfin.storefront_product_variants
          WHERE company_id=$1 AND product_id=ANY($2::text[])`, [context.company_id, ids],
      )).rows : [];
      const reserved = await activeReservationQuantities(c, context.company_id, ids);
      const cap = Number(config.max_item_quantity);
      const projection = products.map(row => {
        const product = row.data;
        const availability = target => product.trackStock
          ? Math.max(0, Math.min(cap, Math.floor((Number(target.stock || 0) - (reserved.get(`${row.id}\u0000${target.id || ''}`) || 0)) * 1000) / 1000))
          : cap;
        const variants = (product.variants || []).map(variant => {
          const publication = variantRows.find(entry => entry.product_id === row.id && entry.variant_id === variant.id);
          const maxQuantity = publication?.sold_out ? 0 : availability(variant);
          return publication?.published ? { id: variant.id, name: variant.name, price: Number(variant.price),
            available: maxQuantity > 0, maxQuantity, sortOrder: publication.sort_order } : null;
        }).filter(Boolean).sort((a, b) => a.sortOrder - b.sortOrder);
        const maxQuantity = row.sold_out || (product.variants?.length && !variants.some(item => item.available)) ? 0 : availability(product);
        return {
          id: row.id, name: row.display_name || product.name, description: row.description || product.description || '',
          category: product.category || 'Menu', subcategory: product.subcategory || '', imageUrl: safeImage(product.imageUrl),
          unit: product.unit || 'pcs', price: Number(row.price), available: maxQuantity > 0,
          maxQuantity: product.variants?.length ? undefined : maxQuantity, variants,
        };
      });
      const preferences = config.company_data?.preferences || {};
      return {
        storefront: { companyId: context.company_id, name: config.display_name || config.company_name,
          description: config.description, currency: preferences.currency || 'RM',
          taxRate: Number(preferences.taxRate ?? preferences.tax ?? 0), pickupInstructions: config.pickup_instructions,
          privacy: storefrontPrivacyOutput(config) },
        locations: locations.map(row => ({ id: row.id, name: row.name, fulfillmentMode: row.fulfillment_mode,
          pickupInstructions: row.pickup_instructions })),
        location: selectedLocation ? { id: selectedLocation.id, name: selectedLocation.name,
          fulfillmentMode: selectedLocation.fulfillment_mode, tableLabel: selectedLocation.table_label } : null,
        products: projection,
      };
    });
  });

  app.post('/api/public/order-requests/quote', { config: { rateLimit: rate(30) } }, async (req, reply) => {
    const context = publicContext(req);
    const input = v.parse(cartSchema, req.body);
    return db.transaction(async c => {
      const location = await locationFor(c, context.company_id, input);
      const priced = await pricedCart(c, context.company_id, input);
      await guestSession(c, req, reply, context.hostname, true);
      const quote = { locationId: location.id, serviceMode: input.serviceMode,
        items: priced.lines.map(item => ({ productId: item.productId, variantId: item.variantId,
          description: item.description, variant: item.variant, unit: item.unit, quantity: item.qty,
          unitPrice: item.price, lineTotal: Math.round(cents(item.price) * item.qty) / 100 })),
        ...priced.totals, currency: priced.currency };
      return { quote, quoteToken: quoteToken(authOptions.secret, context, input, quote) };
    });
  });

  app.post('/api/public/order-requests', { config: { rateLimit: rate(10) } }, async (req, reply) => {
    const context = publicContext(req);
    const input = v.parse(submitSchema, req.body);
    const requestId = v.parse(z.uuid(), req.headers['idempotency-key']);
    const requestDigest = digest(JSON.stringify(canonical({ companyId: context.company_id, hostname: context.hostname, input })));
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
      const location = await locationFor(c, context.company_id, input);
      if (input.serviceMode === 'pickup' && !guest.email && !guest.phone) v.fail(400, 'pickup_contact_required');
      const priced = await pricedCart(c, context.company_id, input);
      const quote = { locationId: location.id, serviceMode: input.serviceMode,
        items: priced.lines.map(item => ({ productId: item.productId, variantId: item.variantId,
          description: item.description, variant: item.variant, unit: item.unit, quantity: item.qty,
          unitPrice: item.price, lineTotal: Math.round(cents(item.price) * item.qty) / 100 })),
        ...priced.totals, currency: priced.currency };
      verifyQuoteToken(authOptions.secret, input.quoteToken, context, input, quote);
      const orderId = randomUUID();
      let code;
      for (let attempt = 0; attempt < 5; attempt++) {
        code = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
        const found = await c.query('SELECT 1 FROM myfin.customer_order_requests WHERE company_id=$1 AND public_code=$2', [context.company_id, code]);
        if (!found.rowCount) break;
        code = '';
      }
      if (!code) v.fail(503, 'order_code_unavailable');
      const expiresAt = new Date(Date.now() + Number(priced.config.order_expiry_minutes) * 60000);
      const row = (await c.query(
        `INSERT INTO myfin.customer_order_requests(
          company_id,id,public_code,location_id,customer_id,guest_name,guest_email,guest_phone,notes,currency,
          subtotal,discount_amount,tax,tax_rate,total_before_rounding,rounding,total,
          guest_session_digest,idempotency_key,request_digest,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
        [context.company_id, orderId, code, location.id, customer?.customerId || null,
          guest.name, guest.email, guest.phone, input.notes, priced.currency,
          priced.totals.subtotal, priced.totals.discountAmount, priced.totals.tax,
          priced.totals.taxRate, priced.totals.totalBeforeRounding, priced.totals.rounding, priced.totals.total,
          session.digest, requestId, requestDigest, expiresAt],
      )).rows[0];
      for (const item of priced.lines) await c.query(
        `INSERT INTO myfin.customer_order_lines(company_id,order_id,line_no,product_id,variant_id,description,variant_name,sku,unit,quantity,unit_price,line_total)
         VALUES($1,$2,$3,$4,nullif($5,''),$6,$7,$8,$9,$10,$11,$12)`,
        [context.company_id, orderId, item.lineNo, item.productId, item.variantId, item.description,
          item.variant, item.sku, item.unit, item.qty, item.price, Math.round(cents(item.price) * item.qty) / 100],
      );
      await c.query(
        `INSERT INTO myfin.customer_order_events(company_id,id,order_id,version,actor_type,customer_actor_id,request_id,request_digest,action,to_status)
         VALUES($1,$2,$3,1,$4,$5,$6,$7,'submitted','awaiting_acceptance')`,
        [context.company_id, randomUUID(), orderId, customer ? 'customer' : 'guest',
          customer?.customerId || null, requestId, requestDigest],
      );
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

export { orderOutput, orderLines, expireIfNeeded, pricedCart, quoteToken, verifyQuoteToken };
