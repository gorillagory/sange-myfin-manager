import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hostAllowed, normalizeHostname } from './tenancy.js';
import { requireCapability } from './access.js';
import { decimalToScaledInteger } from './pricing-engine.js';
import { storefrontPrivacyComplete, storefrontPrivacyOutput } from './storefront-privacy.js';
import * as v from './validation.js';

const privacyUrl = z.union([
  z.literal(''),
  z.url().max(2048).refine(value => value.startsWith('https://'), 'privacy_notice_url_https_required'),
]);
const publicAssetPath = /^\/api\/public\/storefront-assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const optionalStorefrontImageUrl = z.union([
  z.literal(''),
  z.string().max(2048).refine(value => /^https:\/\/\S+$/.test(value) || publicAssetPath.test(value),
    'storefront_image_url_required'),
]);
const themeColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
function colorContrast(left, right) {
  const luminance = value => {
    const hex = value.slice(1);
    const channels = [0,2,4].map(index => Number.parseInt(hex.slice(index,index + 2),16) / 255)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const first = luminance(left), second = luminance(right);
  return (Math.max(first,second) + 0.05) / (Math.min(first,second) + 0.05);
}
const carouselSlideSchema = z.strictObject({
  id: v.id.optional(), published: z.boolean().default(false),
  sortOrder: z.number().int().min(-1000000).max(1000000).default(0),
  badge: z.string().trim().max(80).default(''), title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).default(''), imageUrl: optionalStorefrontImageUrl.default(''),
  backgroundColor: themeColor.default('#17624d'), ctaLabel: z.string().trim().max(60).default(''),
  ctaUrl: z.string().trim().max(2048).default('').refine(value => !value || /^https:\/\/\S+$/.test(value) ||
    (/^\/[A-Za-z0-9/_?&=.%#-]*$/.test(value) && !value.startsWith('//')), 'invalid_carousel_cta_url'),
}).refine(slide => Boolean(slide.ctaLabel) === Boolean(slide.ctaUrl), 'carousel_cta_incomplete');

const configSchema = z.strictObject({
  published: z.boolean(),
  deliveryEnabled: z.boolean().optional(),
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
  logoUrl: optionalStorefrontImageUrl.default(''),
  themePrimaryColor: themeColor.default('#17624d'),
  themeAccentColor: themeColor.default('#d7a43b'),
  themeBackgroundColor: themeColor.default('#fbfcf8'),
  themeTextColor: themeColor.default('#15382c'),
  themeFontFamily: z.enum(['geist','system','serif']).default('geist'),
  heroEyebrow: z.string().trim().max(80).default('ORDER ONLINE'),
  heroTitle: z.string().trim().max(160).default(''),
  heroDescription: z.string().trim().max(1000).default(''),
  heroImageUrl: optionalStorefrontImageUrl.default(''),
  carouselIntervalSeconds: z.number().int().min(3).max(30).default(7),
  slides: z.array(carouselSlideSchema).max(12).optional(),
}).superRefine((input, context) => {
  if (colorContrast(input.themeTextColor,input.themeBackgroundColor) < 4.5) context.addIssue({
    code:'custom', path:['themeTextColor'], message:'storefront_text_contrast_required',
  });
  if (colorContrast('#ffffff',input.themePrimaryColor) < 4.5) context.addIssue({
    code:'custom', path:['themePrimaryColor'], message:'storefront_primary_contrast_required',
  });
  for (const [index,slide] of (input.slides || []).entries()) if (
    colorContrast('#ffffff',slide.backgroundColor) < 4.5
  ) context.addIssue({ code:'custom', path:['slides',index,'backgroundColor'],
    message:'storefront_slide_contrast_required' });
});
const locationCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  fulfillmentMode: z.enum(['pickup','table','both']).default('pickup'),
  tableLabel: z.string().trim().max(80).default(''),
  pickupInstructions: z.string().trim().max(1000).default(''),
});
const locationUpdateSchema = locationCreateSchema.extend({ active: z.boolean() });
const publicationSchema = z.strictObject({
  published: z.boolean().optional(), soldOut: z.boolean().default(false),
  sortOrder: z.number().int().min(-1000000).max(1000000).default(0),
  displayName: z.string().trim().max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  imageUrl: optionalStorefrontImageUrl.optional(),
  variantIds: z.array(v.id).max(100).optional(),
  onlinePriceSen: z.number().int().min(0).max(100000000).nullable().optional(),
  variantOverrides: z.array(z.strictObject({
    variantId: v.id,
    onlinePriceSen: z.number().int().min(0).max(100000000).nullable().default(null),
  })).max(100).optional(),
});
const deliveryZoneSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  feeSen: z.number().int().min(0).max(100000000),
  minimumOrderSen: z.number().int().min(0).max(100000000).default(0),
  leadTimeMinutes: z.number().int().min(5).max(1440),
  serviceInstructions: z.string().trim().max(1000).default(''),
  enabled: z.boolean().default(false),
});

const hashToken = token => createHash('sha256').update(token).digest('hex');
function requireConfigure(who) { requireCapability(who, 'storefrontManage'); }
const lockDeliveryConfiguration = (c, companyId) => c.query(
  'SELECT pg_advisory_xact_lock(hashtextextended($1,35))', [`${companyId}:storefront-delivery-configuration`],
);

async function validateStorefrontAssetOwnership(c, companyId, input) {
  const urls = [input.logoUrl, input.heroImageUrl, input.imageUrl,
    ...(input.slides || []).map(slide => slide.imageUrl)];
  const ids = [...new Set(urls.flatMap(value => publicAssetPath.exec(value || '')?.[1] || []))];
  if (!ids.length) return;
  const owned = await c.query(
    `SELECT id FROM myfin.files
      WHERE company_id=$1 AND kind='assets' AND id=ANY($2::text[]) FOR KEY SHARE`,
    [companyId, ids],
  );
  if (owned.rowCount !== ids.length) v.fail(403, 'invalid_storefront_asset');
}

async function configOutput(c, companyId) {
  const settings = (await c.query('SELECT * FROM myfin.storefront_settings WHERE company_id=$1', [companyId])).rows[0];
  const host = (await c.query(
    'SELECT hostname FROM myfin.storefront_hosts WHERE company_id=$1 AND disabled_at IS NULL', [companyId],
  )).rows[0]?.hostname || '';
  const locations = (await c.query(
    `SELECT id,name,fulfillment_mode,table_label,pickup_instructions,token_hint,token_version,active,created_at,updated_at
       FROM myfin.shop_locations WHERE company_id=$1 ORDER BY created_at,id`, [companyId],
  )).rows;
  const deliveryZones = (await c.query(
    `SELECT id,name,fee_sen,minimum_order_sen,lead_time_minutes,service_instructions,enabled,created_at,updated_at
       FROM myfin.storefront_delivery_zones WHERE company_id=$1 ORDER BY created_at,id`, [companyId],
  )).rows;
  const slides = (await c.query(
    `SELECT id,published,sort_order,badge,title,description,image_url,background_color,cta_label,cta_url,created_at,updated_at
       FROM myfin.storefront_carousel_slides WHERE company_id=$1 ORDER BY sort_order,id`, [companyId],
  )).rows;
  const products = (await c.query(
    `SELECT p.id AS product_id,p.data,p.price AS store_price,
            coalesce(sp.sold_out,false) AS sold_out,coalesce(sp.sort_order,0) AS sort_order,
            sp.online_price_sen,coalesce(sp.image_url,'') AS image_url
       FROM myfin.products p LEFT JOIN myfin.storefront_products sp
         ON sp.company_id=p.company_id AND sp.product_id=p.id
      WHERE p.company_id=$1 ORDER BY coalesce(sp.sort_order,0),p.id`, [companyId],
  )).rows;
  const variants = products.length ? (await c.query(
    `SELECT pv.product_id,pv.id AS variant_id,pv.price AS store_price,
            coalesce(spv.sold_out,false) AS sold_out,coalesce(spv.sort_order,0) AS sort_order,
            spv.online_price_sen
       FROM myfin.product_variants pv LEFT JOIN myfin.storefront_product_variants spv
         ON spv.company_id=pv.company_id AND spv.product_id=pv.product_id AND spv.variant_id=pv.id
      WHERE pv.company_id=$1 AND pv.product_id=ANY($2::text[])
      ORDER BY coalesce(spv.sort_order,0),pv.id`,
    [companyId, products.map(product => product.product_id)],
  )).rows : [];
  const privacy = storefrontPrivacyOutput(settings);
  return {
    storefront: settings ? {
      published: settings.published, deliveryEnabled: Boolean(settings.delivery_enabled), hostname: host, displayName: settings.display_name,
      description: settings.description, pickupInstructions: settings.pickup_instructions,
      orderExpiryMinutes: settings.order_expiry_minutes, maxOrderItems: settings.max_order_items,
      maxItemQuantity: Number(settings.max_item_quantity), maxOrderValue: Number(settings.max_order_value),
      privacyControllerName: privacy.controllerName, privacyControllerContact: privacy.controllerContact,
      privacyNoticeUrl: privacy.noticeUrl, privacyNoticeEn: privacy.noticeEn,
      privacyNoticeMs: privacy.noticeMs, guestContactRetentionDays: privacy.guestContactRetentionDays,
      logoUrl: settings.logo_url, themePrimaryColor: settings.theme_primary_color,
      themeAccentColor: settings.theme_accent_color, themeBackgroundColor: settings.theme_background_color,
      themeTextColor: settings.theme_text_color, themeFontFamily: settings.theme_font_family,
      heroEyebrow: settings.hero_eyebrow, heroTitle: settings.hero_title,
      heroDescription: settings.hero_description, heroImageUrl: settings.hero_image_url,
      carouselIntervalSeconds: settings.carousel_interval_seconds,
      updatedAt: settings.updated_at,
    } : { published: false, deliveryEnabled: false, hostname: host, displayName: '', description: '', pickupInstructions: '',
      orderExpiryMinutes: 30, maxOrderItems: 30, maxItemQuantity: 20, maxOrderValue: 1000,
      guestContactRetentionDays: 90, privacyControllerName: '', privacyControllerContact: '',
      privacyNoticeUrl: '', privacyNoticeEn: '', privacyNoticeMs: '', logoUrl: '',
      themePrimaryColor: '#17624d', themeAccentColor: '#d7a43b', themeBackgroundColor: '#fbfcf8',
      themeTextColor: '#15382c', themeFontFamily: 'geist', heroEyebrow: 'ORDER ONLINE',
      heroTitle: '', heroDescription: '', heroImageUrl: '', carouselIntervalSeconds: 7 },
    slides: slides.map(row => ({ id: row.id, published: row.published, sortOrder: row.sort_order,
      badge: row.badge, title: row.title, description: row.description, imageUrl: row.image_url,
      backgroundColor: row.background_color, ctaLabel: row.cta_label, ctaUrl: row.cta_url,
      createdAt: row.created_at, updatedAt: row.updated_at })),
    locations: locations.map(row => ({ id: row.id, name: row.name, fulfillmentMode: row.fulfillment_mode,
      tableLabel: row.table_label, pickupInstructions: row.pickup_instructions, tokenHint: row.token_hint,
      tokenVersion: row.token_version, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at })),
    deliveryZones: deliveryZones.map(row => ({ id: row.id, name: row.name, feeSen: Number(row.fee_sen),
      minimumOrderSen: Number(row.minimum_order_sen), leadTimeMinutes: Number(row.lead_time_minutes),
      serviceInstructions: row.service_instructions, enabled: row.enabled,
      createdAt: row.created_at, updatedAt: row.updated_at })),
    products: products.map(row => ({ productId: row.product_id, productName: row.data.name,
      active: row.data?.active !== false,
      published: row.data?.active !== false, soldOut: row.sold_out, sortOrder: row.sort_order,
      displayName: '', description: row.data?.description || '', imageUrl:row.image_url,
      storePriceSen: decimalToScaledInteger(row.store_price, 2, 'invalid_catalog_price'),
      onlinePriceSen: row.online_price_sen === null || row.online_price_sen === undefined ? null : Number(row.online_price_sen),
      variants: variants.filter(variant => variant.product_id === row.product_id).map(variant => ({
        variantId: variant.variant_id, published: row.data?.active !== false, soldOut: variant.sold_out,
        sortOrder: variant.sort_order,
        storePriceSen: decimalToScaledInteger(variant.store_price, 2, 'invalid_catalog_price'),
        onlinePriceSen: variant.online_price_sen === null || variant.online_price_sen === undefined
          ? null : Number(variant.online_price_sen),
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
    await validateStorefrontAssetOwnership(c, companyId, input);
    await lockDeliveryConfiguration(c, companyId);
    const deliveryEnabled = input.deliveryEnabled === undefined
      ? Boolean((await c.query(
        'SELECT delivery_enabled FROM myfin.storefront_settings WHERE company_id=$1 FOR UPDATE', [companyId],
      )).rows[0]?.delivery_enabled)
      : input.deliveryEnabled;
    if (input.hostname !== undefined) {
      const hostname = normalizeHostname(input.hostname);
      if (!hostname || !hostname.startsWith('order-') || !hostAllowed(hostname, authOptions.allowedHosts))
        v.fail(400, 'invalid_storefront_hostname');
      const currentHost = (await c.query(
        `SELECT hostname FROM myfin.storefront_hosts
          WHERE company_id=$1 AND disabled_at IS NULL FOR UPDATE`, [companyId],
      )).rows[0]?.hostname || '';
      if (currentHost !== hostname) {
        // Payment creation takes a shared lock on this same host row. Once this
        // update lock is held, the derived state query cannot miss a concurrently
        // committed intent for the hostname that is about to be disabled.
        const unresolvedPayment = await c.query(
          `SELECT state FROM myfin.customer_order_online_payment_state
            WHERE company_id=$1 AND state NOT IN ('failed','finalized')
            LIMIT 1`, [companyId],
        );
        if (unresolvedPayment.rowCount)
          v.fail(409, 'storefront_hostname_change_blocked_by_online_payment');
        // This is the same hostname lock used by the cross-surface database trigger. It also
        // protects a currently absent hostname until this transaction commits its claim.
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,18))', [hostname]);
        const existing = await c.query(
          'SELECT company_id FROM myfin.storefront_hosts WHERE hostname=$1 FOR UPDATE', [hostname],
        );
        if (existing.rowCount && existing.rows[0].company_id !== companyId) v.fail(409, 'hostname_unavailable');
        await c.query(
          `UPDATE myfin.storefront_hosts SET disabled_at=now()
            WHERE company_id=$1 AND hostname<>$2 AND disabled_at IS NULL`, [companyId, hostname],
        );
        const claimed = await c.query(
          `INSERT INTO myfin.storefront_hosts(hostname,company_id,created_by)
           VALUES($1,$2,$3) ON CONFLICT(hostname) DO UPDATE SET disabled_at=NULL
             WHERE myfin.storefront_hosts.company_id=EXCLUDED.company_id
           RETURNING company_id`,
          [hostname, companyId, req.identity.id],
        );
        if (!claimed.rowCount || claimed.rows[0]?.company_id !== companyId) v.fail(409, 'hostname_unavailable');
      }
    }
    if (input.published) {
      if (!storefrontPrivacyComplete(input)) v.fail(409, 'storefront_privacy_notice_required');
      const activeHost = await c.query(
        'SELECT 1 FROM myfin.storefront_hosts WHERE company_id=$1 AND disabled_at IS NULL', [companyId],
      );
      const activeLocation = await c.query(
        `SELECT 1 FROM myfin.shop_locations
          WHERE company_id=$1 AND active AND fulfillment_mode IN ('pickup','both') LIMIT 1`, [companyId],
      );
      if (!activeHost.rowCount) v.fail(409, 'storefront_host_and_location_required');
      if (!activeLocation.rowCount) v.fail(409, 'storefront_pickup_location_required');
    }
    if (deliveryEnabled) {
      const zone = await c.query(
        'SELECT 1 FROM myfin.storefront_delivery_zones WHERE company_id=$1 AND enabled LIMIT 1', [companyId],
      );
      if (!zone.rowCount) v.fail(409, 'delivery_zone_required');
    }
    await c.query(
      `INSERT INTO myfin.storefront_settings(company_id,published,display_name,description,pickup_instructions,
         order_expiry_minutes,max_order_items,max_item_quantity,max_order_value,guest_data_retention_days,
         privacy_controller_name,privacy_controller_contact,privacy_notice_url,privacy_notice_en,privacy_notice_ms,
         delivery_enabled,logo_url,theme_primary_color,theme_accent_color,theme_background_color,theme_text_color,
         theme_font_family,hero_eyebrow,hero_title,hero_description,hero_image_url,carousel_interval_seconds,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       ON CONFLICT(company_id) DO UPDATE SET published=EXCLUDED.published,display_name=EXCLUDED.display_name,
         description=EXCLUDED.description,pickup_instructions=EXCLUDED.pickup_instructions,
         order_expiry_minutes=EXCLUDED.order_expiry_minutes,max_order_items=EXCLUDED.max_order_items,
         max_item_quantity=EXCLUDED.max_item_quantity,max_order_value=EXCLUDED.max_order_value,
         guest_data_retention_days=EXCLUDED.guest_data_retention_days,
         privacy_controller_name=EXCLUDED.privacy_controller_name,
         privacy_controller_contact=EXCLUDED.privacy_controller_contact,
         privacy_notice_url=EXCLUDED.privacy_notice_url,privacy_notice_en=EXCLUDED.privacy_notice_en,
         privacy_notice_ms=EXCLUDED.privacy_notice_ms,delivery_enabled=EXCLUDED.delivery_enabled,
         logo_url=EXCLUDED.logo_url,theme_primary_color=EXCLUDED.theme_primary_color,
         theme_accent_color=EXCLUDED.theme_accent_color,theme_background_color=EXCLUDED.theme_background_color,
         theme_text_color=EXCLUDED.theme_text_color,theme_font_family=EXCLUDED.theme_font_family,
         hero_eyebrow=EXCLUDED.hero_eyebrow,hero_title=EXCLUDED.hero_title,
         hero_description=EXCLUDED.hero_description,hero_image_url=EXCLUDED.hero_image_url,
         carousel_interval_seconds=EXCLUDED.carousel_interval_seconds,
         updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [companyId, input.published, input.displayName, input.description, input.pickupInstructions,
        input.orderExpiryMinutes, input.maxOrderItems, input.maxItemQuantity, input.maxOrderValue,
        input.guestContactRetentionDays, input.privacyControllerName, input.privacyControllerContact,
        input.privacyNoticeUrl, input.privacyNoticeEn, input.privacyNoticeMs, deliveryEnabled,
        input.logoUrl, input.themePrimaryColor, input.themeAccentColor, input.themeBackgroundColor,
        input.themeTextColor, input.themeFontFamily, input.heroEyebrow, input.heroTitle,
        input.heroDescription, input.heroImageUrl, input.carouselIntervalSeconds, req.identity.id],
    );
    if (input.slides !== undefined) {
      const ids = input.slides.map(slide => slide.id || randomUUID());
      if (new Set(ids).size !== ids.length) v.fail(400, 'duplicate_carousel_slide');
      await c.query('DELETE FROM myfin.storefront_carousel_slides WHERE company_id=$1', [companyId]);
      for (let index = 0; index < input.slides.length; index++) {
        const slide = input.slides[index];
        await c.query(
          `INSERT INTO myfin.storefront_carousel_slides(company_id,id,published,sort_order,badge,title,description,
             image_url,background_color,cta_label,cta_url,created_by,updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
          [companyId, ids[index], slide.published, slide.sortOrder, slide.badge, slide.title,
            slide.description, slide.imageUrl, slide.backgroundColor, slide.ctaLabel, slide.ctaUrl,
            req.identity.id],
        );
      }
    }
    await audit(c, req.identity, companyId, 'Storefront settings', input.published ? 'Published' : 'Unpublished');
    return configOutput(c, companyId);
  }));

  app.post('/api/companies/:company/storefront/delivery-zones', req => scoped(req, async (c, companyId) => {
    requireConfigure(req.identity);
    const input = v.parse(deliveryZoneSchema, req.body), id = randomUUID();
    await c.query(
      `INSERT INTO myfin.storefront_delivery_zones(company_id,id,name,fee_sen,minimum_order_sen,
         lead_time_minutes,service_instructions,enabled,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [companyId, id, input.name, input.feeSen, input.minimumOrderSen, input.leadTimeMinutes,
        input.serviceInstructions, input.enabled, req.identity.id],
    );
    await audit(c, req.identity, companyId, 'Delivery zone created', `${input.name} · ${id}`);
    return configOutput(c, companyId);
  }));

  app.patch('/api/companies/:company/storefront/delivery-zones/:id', req => scoped(req, async (c, companyId) => {
    requireConfigure(req.identity);
    const id = v.parse(v.id, req.params.id), input = v.parse(deliveryZoneSchema, req.body);
    await lockDeliveryConfiguration(c, companyId);
    if (!input.enabled) {
      const settings = (await c.query(
        'SELECT delivery_enabled FROM myfin.storefront_settings WHERE company_id=$1 FOR UPDATE', [companyId],
      )).rows[0];
      if (settings?.delivery_enabled) {
        const other = await c.query(
          'SELECT 1 FROM myfin.storefront_delivery_zones WHERE company_id=$1 AND id<>$2 AND enabled LIMIT 1',
          [companyId, id],
        );
        if (!other.rowCount) v.fail(409, 'delivery_zone_required');
      }
    }
    const result = await c.query(
      `UPDATE myfin.storefront_delivery_zones SET name=$3,fee_sen=$4,minimum_order_sen=$5,
         lead_time_minutes=$6,service_instructions=$7,enabled=$8,updated_by=$9,updated_at=now()
       WHERE company_id=$1 AND id=$2`,
      [companyId, id, input.name, input.feeSen, input.minimumOrderSen, input.leadTimeMinutes,
        input.serviceInstructions, input.enabled, req.identity.id],
    );
    if (!result.rowCount) v.fail(404, 'delivery_zone_not_found');
    await audit(c, req.identity, companyId, 'Delivery zone updated', `${input.name} · ${id}`);
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
    await lockDeliveryConfiguration(c, companyId);
    if (!input.active || !['pickup','both'].includes(input.fulfillmentMode)) {
      const settings = (await c.query(
        'SELECT published FROM myfin.storefront_settings WHERE company_id=$1 FOR UPDATE', [companyId],
      )).rows[0];
      if (settings?.published) {
        const other = await c.query(
          `SELECT 1 FROM myfin.shop_locations
            WHERE company_id=$1 AND id<>$2 AND active AND fulfillment_mode IN ('pickup','both') LIMIT 1`,
          [companyId, id],
        );
        if (!other.rowCount) v.fail(409, 'storefront_pickup_location_required');
      }
    }
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
    await validateStorefrontAssetOwnership(c, companyId, input);
    const currentProduct = (await c.query(
      `SELECT p.data,sp.online_price_sen,sp.image_url FROM myfin.products p LEFT JOIN myfin.storefront_products sp
         ON sp.company_id=p.company_id AND sp.product_id=p.id
        WHERE p.company_id=$1 AND p.id=$2 FOR SHARE OF p`, [companyId, productId],
    )).rows[0];
    const product = currentProduct?.data;
    if (!product) v.fail(404, 'product_not_found');
    const known = new Set((product.variants || []).map(variant => variant.id));
    if ((input.variantIds || []).some(id => !known.has(id))) v.fail(400, 'invalid_product_variant');
    const selected = [...known];
    const requestedOverrides = input.variantOverrides || [];
    if (new Set(requestedOverrides.map(row => row.variantId)).size !== requestedOverrides.length ||
        requestedOverrides.some(row => !known.has(row.variantId)))
      v.fail(400, 'invalid_product_variant');
    const existingVariants = (await c.query(
      `SELECT variant_id,online_price_sen,sold_out FROM myfin.storefront_product_variants
        WHERE company_id=$1 AND product_id=$2 FOR SHARE`, [companyId, productId],
    )).rows;
    const existingPrice = new Map(existingVariants.map(row => [row.variant_id,
      row.online_price_sen === null || row.online_price_sen === undefined ? null : Number(row.online_price_sen)]));
    const existingSoldOut = new Map(existingVariants.map(row => [row.variant_id,Boolean(row.sold_out)]));
    const overridePrice = new Map(requestedOverrides.map(row => [row.variantId, row.onlinePriceSen]));
    const onlinePriceSen = input.onlinePriceSen === undefined
      ? (currentProduct.online_price_sen === null || currentProduct.online_price_sen === undefined
        ? null : Number(currentProduct.online_price_sen)) : input.onlinePriceSen;
    const imageUrl = input.imageUrl === undefined ? (currentProduct.image_url || '') : input.imageUrl;
    await c.query(
      `INSERT INTO myfin.storefront_products(company_id,product_id,published,sold_out,sort_order,display_name,description,
         online_price_sen,image_url,updated_by)
       VALUES($1,$2,$3,$4,$5,'','',$6,$7,$8) ON CONFLICT(company_id,product_id) DO UPDATE SET
       published=EXCLUDED.published,sold_out=EXCLUDED.sold_out,sort_order=EXCLUDED.sort_order,
       display_name=EXCLUDED.display_name,description=EXCLUDED.description,
      online_price_sen=EXCLUDED.online_price_sen,image_url=EXCLUDED.image_url,
       updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [companyId, productId, product.active !== false, input.soldOut, input.sortOrder,
        onlinePriceSen, imageUrl, req.identity.id],
    );
    await c.query('DELETE FROM myfin.storefront_product_variants WHERE company_id=$1 AND product_id=$2', [companyId, productId]);
    let sort = 0;
    for (const id of selected) await c.query(
      `INSERT INTO myfin.storefront_product_variants(company_id,product_id,variant_id,published,sold_out,sort_order,online_price_sen)
       VALUES($1,$2,$3,true,$4,$5,$6)`, [companyId, productId, id, existingSoldOut.get(id) || false, sort++,
        input.variantOverrides === undefined ? (existingPrice.get(id) ?? null) : (overridePrice.get(id) ?? null)],
    );
    await audit(c, req.identity, companyId, 'Storefront product',
      `${product.name} · ${product.active === false ? 'Inactive catalogue item' : input.soldOut ? 'Sold out' : 'Available'}`);
    return configOutput(c, companyId);
  }));
}
