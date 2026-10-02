import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hostAllowed, normalizeHostname } from './tenancy.js';
import { manager, owner } from './access.js';
import { storefrontPrivacyComplete, storefrontPrivacyOutput } from './storefront-privacy.js';
import * as v from './validation.js';

const privacyUrl = z.union([
  z.literal(''),
  z.url().max(2048).refine(value => value.startsWith('https://'), 'privacy_notice_url_https_required'),
]);

const configSchema = z.strictObject({
  published: z.boolean(),
  hostname: z.string().trim().toLowerCase().max(253).optional(),
  displayName: z.string().trim().max(120).default(''),
  description: z.string().trim().max(2000).default(''),
  pickupInstructions: z.string().trim().max(2000).default(''),
  orderExpiryMinutes: z.number().int().min(5).max(1440).default(30),
  maxOrderItems: z.number().int().min(1).max(100).default(30),
  maxItemQuantity: z.number().positive().max(1000).default(20),
  maxOrderValue: z.number().positive().max(1000000).default(1000),
  guestContactRetentionDays: z.number().int().min(7).max(3650).default(90),
  privacyControllerName: z.string().trim().max(160).default(''),
  privacyControllerContact: z.string().trim().max(254).default(''),
  privacyNoticeUrl: privacyUrl.default(''),
  privacyNoticeEn: z.string().trim().max(2000).default(''),
  privacyNoticeMs: z.string().trim().max(2000).default(''),
});
const locationCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  fulfillmentMode: z.enum(['pickup','table','both']).default('pickup'),
  tableLabel: z.string().trim().max(80).default(''),
  pickupInstructions: z.string().trim().max(1000).default(''),
});
const locationUpdateSchema = locationCreateSchema.extend({ active: z.boolean() });
const publicationSchema = z.strictObject({
  published: z.boolean(), soldOut: z.boolean().default(false),
  sortOrder: z.number().int().min(-1000000).max(1000000).default(0),
  displayName: z.string().trim().max(120).default(''),
  description: z.string().trim().max(2000).default(''),
  variantIds: z.array(v.id).max(100).optional(),
});

const hashToken = token => createHash('sha256').update(token).digest('hex');
const canConfigure = who => owner(who) || manager(who);
function requireConfigure(who) { if (!canConfigure(who)) v.fail(403, 'access_denied'); }

async function configOutput(c, companyId) {
  const settings = (await c.query('SELECT * FROM myfin.storefront_settings WHERE company_id=$1', [companyId])).rows[0];
  const host = (await c.query(
    'SELECT hostname FROM myfin.storefront_hosts WHERE company_id=$1 AND disabled_at IS NULL', [companyId],
  )).rows[0]?.hostname || '';
  const locations = (await c.query(
    `SELECT id,name,fulfillment_mode,table_label,pickup_instructions,token_hint,token_version,active,created_at,updated_at
       FROM myfin.shop_locations WHERE company_id=$1 ORDER BY created_at,id`, [companyId],
  )).rows;
  const products = (await c.query(
    `SELECT sp.*,p.data FROM myfin.storefront_products sp JOIN myfin.products p
       ON p.company_id=sp.company_id AND p.id=sp.product_id
      WHERE sp.company_id=$1 ORDER BY sp.sort_order,sp.product_id`, [companyId],
  )).rows;
  const variants = products.length ? (await c.query(
    `SELECT * FROM myfin.storefront_product_variants WHERE company_id=$1 AND product_id=ANY($2::text[])
      ORDER BY sort_order,variant_id`, [companyId, products.map(product => product.product_id)],
  )).rows : [];
  const privacy = storefrontPrivacyOutput(settings);
  return {
    storefront: settings ? {
      published: settings.published, hostname: host, displayName: settings.display_name,
      description: settings.description, pickupInstructions: settings.pickup_instructions,
      orderExpiryMinutes: settings.order_expiry_minutes, maxOrderItems: settings.max_order_items,
      maxItemQuantity: Number(settings.max_item_quantity), maxOrderValue: Number(settings.max_order_value),
      privacyControllerName: privacy.controllerName, privacyControllerContact: privacy.controllerContact,
      privacyNoticeUrl: privacy.noticeUrl, privacyNoticeEn: privacy.noticeEn,
      privacyNoticeMs: privacy.noticeMs, guestContactRetentionDays: privacy.guestContactRetentionDays,
      updatedAt: settings.updated_at,
    } : { published: false, hostname: host, displayName: '', description: '', pickupInstructions: '',
      orderExpiryMinutes: 30, maxOrderItems: 30, maxItemQuantity: 20, maxOrderValue: 1000,
      guestContactRetentionDays: 90, privacyControllerName: '', privacyControllerContact: '',
      privacyNoticeUrl: '', privacyNoticeEn: '', privacyNoticeMs: '' },
    locations: locations.map(row => ({ id: row.id, name: row.name, fulfillmentMode: row.fulfillment_mode,
      tableLabel: row.table_label, pickupInstructions: row.pickup_instructions, tokenHint: row.token_hint,
      tokenVersion: row.token_version, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at })),
    products: products.map(row => ({ productId: row.product_id, productName: row.data.name,
      published: row.published, soldOut: row.sold_out, sortOrder: row.sort_order,
      displayName: row.display_name, description: row.description,
      variants: variants.filter(variant => variant.product_id === row.product_id).map(variant => ({
        variantId: variant.variant_id, published: variant.published, soldOut: variant.sold_out,
        sortOrder: variant.sort_order,
      })) })),
  };
}

export function registerStorefrontAdmin(app, { scoped, authOptions, audit }) {
  app.get('/api/companies/:company/storefront', req => scoped(req, async (c, companyId) => {
    requireConfigure(req.identity);
    return configOutput(c, companyId);
  }));

  app.put('/api/companies/:company/storefront', req => scoped(req, async (c, companyId) => {
    requireConfigure(req.identity);
    const input = v.parse(configSchema, req.body);
    if (input.hostname !== undefined) {
      const hostname = normalizeHostname(input.hostname);
      if (!hostname || !hostname.startsWith('order-') || !hostAllowed(hostname, authOptions.allowedHosts))
        v.fail(400, 'invalid_storefront_hostname');
      const existing = await c.query(
        `SELECT company_id FROM myfin.storefront_hosts WHERE hostname=$1 FOR UPDATE`, [hostname],
      );
      if (existing.rowCount && existing.rows[0].company_id !== companyId) v.fail(409, 'hostname_unavailable');
      await c.query(
        `UPDATE myfin.storefront_hosts SET disabled_at=now()
          WHERE company_id=$1 AND hostname<>$2 AND disabled_at IS NULL`, [companyId, hostname],
      );
      await c.query(
        `INSERT INTO myfin.storefront_hosts(hostname,company_id,created_by)
         VALUES($1,$2,$3) ON CONFLICT(hostname) DO UPDATE SET disabled_at=NULL`,
        [hostname, companyId, req.identity.id],
      );
    }
    if (input.published) {
      if (!storefrontPrivacyComplete(input)) v.fail(409, 'storefront_privacy_notice_required');
      const activeHost = await c.query(
        'SELECT 1 FROM myfin.storefront_hosts WHERE company_id=$1 AND disabled_at IS NULL', [companyId],
      );
      const activeLocation = await c.query(
        'SELECT 1 FROM myfin.shop_locations WHERE company_id=$1 AND active LIMIT 1', [companyId],
      );
      if (!activeHost.rowCount || !activeLocation.rowCount) v.fail(409, 'storefront_host_and_location_required');
    }
    await c.query(
      `INSERT INTO myfin.storefront_settings(company_id,published,display_name,description,pickup_instructions,
         order_expiry_minutes,max_order_items,max_item_quantity,max_order_value,guest_data_retention_days,
         privacy_controller_name,privacy_controller_contact,privacy_notice_url,privacy_notice_en,privacy_notice_ms,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT(company_id) DO UPDATE SET published=EXCLUDED.published,display_name=EXCLUDED.display_name,
         description=EXCLUDED.description,pickup_instructions=EXCLUDED.pickup_instructions,
         order_expiry_minutes=EXCLUDED.order_expiry_minutes,max_order_items=EXCLUDED.max_order_items,
         max_item_quantity=EXCLUDED.max_item_quantity,max_order_value=EXCLUDED.max_order_value,
         guest_data_retention_days=EXCLUDED.guest_data_retention_days,
         privacy_controller_name=EXCLUDED.privacy_controller_name,
         privacy_controller_contact=EXCLUDED.privacy_controller_contact,
         privacy_notice_url=EXCLUDED.privacy_notice_url,privacy_notice_en=EXCLUDED.privacy_notice_en,
         privacy_notice_ms=EXCLUDED.privacy_notice_ms,
         updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [companyId, input.published, input.displayName, input.description, input.pickupInstructions,
        input.orderExpiryMinutes, input.maxOrderItems, input.maxItemQuantity, input.maxOrderValue,
        input.guestContactRetentionDays, input.privacyControllerName, input.privacyControllerContact,
        input.privacyNoticeUrl, input.privacyNoticeEn, input.privacyNoticeMs, req.identity.id],
    );
    await audit(c, req.identity, companyId, 'Storefront settings', input.published ? 'Published' : 'Unpublished');
    return configOutput(c, companyId);
  }));

  app.post('/api/companies/:company/storefront/locations', req => scoped(req, async (c, companyId) => {
    requireConfigure(req.identity);
    const input = v.parse(locationCreateSchema, req.body);
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await c.query(
      `INSERT INTO myfin.shop_locations(company_id,id,name,fulfillment_mode,table_label,pickup_instructions,
        token_digest,token_hint,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [companyId, id, input.name, input.fulfillmentMode, input.tableLabel, input.pickupInstructions,
        hashToken(token), token.slice(-6), req.identity.id],
    );
    const host = (await c.query(
      'SELECT hostname FROM myfin.storefront_hosts WHERE company_id=$1 AND disabled_at IS NULL', [companyId],
    )).rows[0]?.hostname || '';
    await audit(c, req.identity, companyId, 'Shop location created', `${input.name} · ${id}`);
    return { location: { id, ...input, active: true, tokenVersion: 1 }, locationToken: token,
      orderUrl: host ? `https://${host}/shop?locationToken=${encodeURIComponent(token)}` : '' };
  }));

  app.patch('/api/companies/:company/storefront/locations/:id', req => scoped(req, async (c, companyId) => {
    requireConfigure(req.identity);
    const id = v.parse(v.id, req.params.id), input = v.parse(locationUpdateSchema, req.body);
    const result = await c.query(
      `UPDATE myfin.shop_locations SET name=$3,fulfillment_mode=$4,table_label=$5,pickup_instructions=$6,
         active=$7,updated_at=now() WHERE company_id=$1 AND id=$2`,
      [companyId, id, input.name, input.fulfillmentMode, input.tableLabel, input.pickupInstructions, input.active],
    );
    if (!result.rowCount) v.fail(404, 'shop_location_not_found');
    await audit(c, req.identity, companyId, 'Shop location updated', `${input.name} · ${id}`);
    return configOutput(c, companyId);
  }));

  app.post('/api/companies/:company/storefront/locations/:id/rotate-token', req => scoped(req, async (c, companyId) => {
    requireConfigure(req.identity);
    const id = v.parse(v.id, req.params.id), token = randomBytes(32).toString('base64url');
    const result = await c.query(
      `UPDATE myfin.shop_locations SET token_digest=$3,token_hint=$4,token_version=token_version+1,updated_at=now()
        WHERE company_id=$1 AND id=$2 RETURNING name,token_version`,
      [companyId, id, hashToken(token), token.slice(-6)],
    );
    if (!result.rowCount) v.fail(404, 'shop_location_not_found');
    const host = (await c.query(
      'SELECT hostname FROM myfin.storefront_hosts WHERE company_id=$1 AND disabled_at IS NULL', [companyId],
    )).rows[0]?.hostname || '';
    await audit(c, req.identity, companyId, 'Shop QR rotated', `${result.rows[0].name} · ${id}`);
    return { locationId: id, tokenVersion: result.rows[0].token_version, locationToken: token,
      orderUrl: host ? `https://${host}/shop?locationToken=${encodeURIComponent(token)}` : '' };
  }));

  app.put('/api/companies/:company/storefront/products/:product', req => scoped(req, async (c, companyId) => {
    requireConfigure(req.identity);
    const productId = v.parse(v.id, req.params.product), input = v.parse(publicationSchema, req.body);
    const product = (await c.query(
      'SELECT data FROM myfin.products WHERE company_id=$1 AND id=$2 FOR SHARE', [companyId, productId],
    )).rows[0]?.data;
    if (!product) v.fail(404, 'product_not_found');
    const known = new Set((product.variants || []).map(variant => variant.id));
    const selected = input.variantIds === undefined ? [...known] : input.variantIds;
    if (selected.some(id => !known.has(id))) v.fail(400, 'invalid_product_variant');
    await c.query(
      `INSERT INTO myfin.storefront_products(company_id,product_id,published,sold_out,sort_order,display_name,description,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(company_id,product_id) DO UPDATE SET
       published=EXCLUDED.published,sold_out=EXCLUDED.sold_out,sort_order=EXCLUDED.sort_order,
       display_name=EXCLUDED.display_name,description=EXCLUDED.description,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [companyId, productId, input.published, input.soldOut, input.sortOrder, input.displayName, input.description, req.identity.id],
    );
    await c.query('DELETE FROM myfin.storefront_product_variants WHERE company_id=$1 AND product_id=$2', [companyId, productId]);
    let sort = 0;
    for (const id of selected) await c.query(
      `INSERT INTO myfin.storefront_product_variants(company_id,product_id,variant_id,published,sort_order)
       VALUES($1,$2,$3,true,$4)`, [companyId, productId, id, sort++],
    );
    await audit(c, req.identity, companyId, 'Storefront product', `${product.name} · ${input.published ? 'Published' : 'Hidden'}`);
    return configOutput(c, companyId);
  }));
}
