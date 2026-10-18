import { promotionPayload, senFromRinggit } from './studentPrograms.js';

const text = value => String(value ?? '').normalize('NFKC').trim();
const positiveInteger = (value, label, { nullable = true } = {}) => {
  if (nullable && (value === '' || value === null || value === undefined)) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive whole number.`);
  return number;
};
const boundedInteger = (value, label, { min, max, fallback = 0 } = {}) => {
  const number = value === '' || value === null || value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return number;
};
const iso = (value, label, { nullable = false } = {}) => {
  if (nullable && !text(value)) return null;
  const parsed = new Date(value);
  if (!text(value) || Number.isNaN(parsed.getTime())) throw new Error(`${label} must be a valid date and time.`);
  return parsed.toISOString();
};
const unique = values => [...new Set(values.map(text).filter(Boolean))];

export const MARKETING_TABS = Object.freeze([
  { id:'overview', label:'Overview' },
  { id:'campaigns', label:'Campaigns' },
  { id:'offers', label:'Offers & vouchers' },
  { id:'loyalty', label:'Loyalty' },
  { id:'audiences', label:'Audiences' },
  { id:'eligibility', label:'Eligibility' },
]);

export const CAMPAIGN_GOALS = Object.freeze([
  { id:'acquisition', label:'Win new customers', description:'Encourage a first attributed purchase.' },
  { id:'repeat_purchase', label:'Bring customers back', description:'Invite known customers to purchase again.' },
  { id:'loyalty', label:'Retain regulars', description:'Reward customers who already return.' },
  { id:'basket_growth', label:'Grow basket value', description:'Encourage a larger qualifying order.' },
  { id:'inventory_clearance', label:'Move selected stock', description:'Promote chosen products or categories.' },
]);

export const OFFER_TYPES = Object.freeze([
  { id:'percentage', label:'Percentage discount', unit:'%' },
  { id:'fixed', label:'Fixed discount', unit:'RM' },
  { id:'free_item', label:'Free item', unit:'item' },
  { id:'bonus_points', label:'Bonus points', unit:'points' },
]);

export const MARKETING_CHANNELS = Object.freeze([
  { id:'storefront', label:'Online storefront' },
  { id:'pos', label:'Checkout / POS' },
  { id:'email', label:'Email' },
]);

export function promotionCode(row = {}) {
  return text(row.displayCode ?? row.code ?? row.reusableCode ?? row.voucherCode).toLocaleUpperCase('en-US');
}

export function promotionShareTarget(row = {}) {
  return text(row.shareUrl ?? row.storefrontUrl ?? row.deepLink ?? row.qrPayload) || promotionCode(row);
}

export function normalizePosPromotionCatalog(input = {}) {
  const source = Array.isArray(input) ? input
    : input.promotions || input.rows || input.offers || input.availablePromotions || [];
  return source.flatMap(promotion => {
    const codes = promotion.vouchers || promotion.codes || [];
    const rows = codes.length ? codes.map(code => ({ ...promotion, ...code,
      promotionId:code.promotionId || promotion.promotionId || promotion.id,
      promotionVersion:code.promotionVersion || promotion.promotionVersion || promotion.version,
      promotionName:code.promotionName || promotion.promotionName || promotion.name,
      campaignId:code.campaignId || promotion.campaignId,
      campaignName:code.campaignName || promotion.campaignName,
      redemptionMode:'voucher',
    })) : [promotion];
    return rows.map((row, index) => {
      const displayCode = promotionCode(row);
      const redemptionMode = text(row.redemptionMode || (displayCode || row.codeHint ? 'voucher' : 'automatic')).toLowerCase();
      return { ...row,
        id:row.voucherId || row.id || `${row.promotionId || promotion.id || 'promotion'}:${row.promotionVersion || promotion.version || 0}:${index}`,
        promotionId:row.promotionId || promotion.id || row.id,
        promotionVersion:Number(row.promotionVersion || promotion.version || row.version || 0),
        name:row.promotionName || row.name || promotion.name || 'Promotion',
        campaignName:row.campaignName || promotion.campaignName || '',
        redemptionMode, displayCode,
        shareUrl:promotionShareTarget(row),
        codeHint:text(row.codeHint || row.code_hint),
        legacyMasked:redemptionMode === 'voucher' && !displayCode && Boolean(text(row.codeHint || row.code_hint)),
        enabled:row.enabled !== false && promotion.enabled !== false,
      };
    });
  });
}

export function suggestPromotionCode(label = 'PROMO', existing = [], now = new Date()) {
  const stem = text(label).toLocaleUpperCase('en-US').replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'PROMO';
  const year = String(now.getFullYear()).slice(-2);
  const base = `${stem.slice(0, 24)}-${year}`;
  const used = new Set(existing.map(value => text(value).toLocaleUpperCase('en-US')));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base.slice(0, 31 - String(suffix).length)}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${stem.slice(0, 19)}-${Date.now().toString(36).toLocaleUpperCase('en-US')}`.slice(0, 32);
}

export function marketingPaths(companyId) {
  const base = `/companies/${encodeURIComponent(companyId)}/marketing`;
  return Object.freeze({ base, campaigns:`${base}/campaigns`, audiences:`${base}/audiences`,
    loyalty:`${base}/loyalty`, legacy:`/companies/${encodeURIComponent(companyId)}/student-programs` });
}

export function campaignLifecycle(row = {}, now = new Date()) {
  const explicit = text(row.status || row.lifecycle).toLowerCase();
  if (['draft','scheduled','active','paused','completed','ended','archived'].includes(explicit)) return explicit === 'ended' ? 'completed' : explicit;
  if (row.enabled === false) return 'draft';
  const start = new Date(row.startsAt || row.validFrom || 0);
  const end = row.endsAt || row.validUntil ? new Date(row.endsAt || row.validUntil) : null;
  if (!Number.isNaN(start.getTime()) && start > now) return 'scheduled';
  if (end && !Number.isNaN(end.getTime()) && end <= now) return 'completed';
  return row.enabled ? 'active' : 'draft';
}

export function campaignLifecycleLabel(value) {
  return ({ draft:'Draft', scheduled:'Scheduled', active:'Live', paused:'Paused', completed:'Completed', archived:'Archived' })[value] || 'Draft';
}

export function normalizeMarketingWorkspace(input = {}) {
  const campaigns = (input.campaigns || input.promotions || []).map(row => ({
    ...row,
    id:row.id || row.campaignId,
    name:row.name || row.title || 'Untitled campaign',
    goal:row.goal || row.objective || 'acquisition',
    status:campaignLifecycle(row),
    source:row.source || (input.promotions ? 'legacy-promotion' : 'campaign'),
    startsAt:row.startsAt || row.validFrom || null,
    endsAt:row.endsAt || row.validUntil || null,
    offer:row.offer || {
      type:row.discountType,
      percentageBasisPoints:row.discountBasisPoints,
      amountSen:row.discountSen,
      rewardProductId:row.rewardProductId,
      rewardVariantId:row.rewardVariantId,
      bonusPoints:row.bonusPoints,
    },
    analytics:row.analytics || row.metrics || row.attribution?.metrics || row.attribution || {
      voucherRedemptions:Number(row.redeemedCount || row.redemptionCount || 0),
    },
  }));
  const analytics = input.analytics?.metrics || input.summary?.metrics || input.summary || input.attribution?.metrics || {};
  const metric = (...values) => {
    const value = values.find(item => item !== undefined && item !== null);
    return value === undefined ? null : Number(value);
  };
  return {
    scope:input.scope || 'company',
    campaigns,
    audiences:input.audiences || [],
    customers:input.customers || input.customerProfiles || [],
    offers:(input.availablePromotions || input.offers || campaigns.map(campaign => ({ ...campaign.offer, campaignId:campaign.id, campaignName:campaign.name }))).map(row => ({
      ...row, id:row.id || row.promotionId, version:Number(row.version || row.promotionVersion || 0),
    })),
    vouchers:input.vouchers || campaigns.flatMap(campaign => (campaign.vouchers || []).map(voucher => ({ ...voucher, campaignId:campaign.id, campaignName:campaign.name }))),
    loyalty:input.loyalty || input.loyaltySettings || null,
    eligibility:input.eligibility || input.students || input.eligibilities || [],
    customerCohort:input.customerCohort || null,
    analytics:{
      qualifiedQuotes:metric(analytics.qualifiedQuotes,analytics.qualified_quotes),
      conversions:metric(analytics.conversions,analytics.orders),
      attributedRevenueSen:metric(analytics.attributedRevenueSen,analytics.attributed_revenue_sen),
      discountCostSen:metric(analytics.discountCostSen,analytics.discount_cost_sen),
      averageOrderValueSen:metric(analytics.averageOrderValueSen,analytics.average_order_value_sen),
      voucherRedemptions:metric(analytics.voucherRedemptions,analytics.voucherUses,analytics.voucher_redemptions),
    },
    policy:input.policy || {},
    legacy:Boolean(input.promotions && !input.campaigns),
  };
}

export async function loadMarketingWorkspace(request, companyId) {
  const paths = marketingPaths(companyId);
  try {
    const primary = await request(paths.base);
    const supplements = await Promise.allSettled([
      primary.customerProfiles ? Promise.resolve({ rows:primary.customerProfiles })
        : request(`/companies/${encodeURIComponent(companyId)}/customer-profiles?limit=100`),
      primary.loyalty ? Promise.resolve(primary.loyalty) : request(paths.loyalty),
      request(`${paths.legacy}?limit=100`),
      request(`${paths.base}/promotions`),
    ]);
    const legacy = supplements[2].status === 'fulfilled' ? supplements[2].value : {};
    const legacyPromotions = legacy.promotions || [];
    const catalog = supplements[3].status === 'fulfilled' ? supplements[3].value : {};
    const catalogPromotions = catalog.promotions || [];
    const primaryPromotions = primary.availablePromotions || [];
    const detailPromotions = catalogPromotions.length ? catalogPromotions : legacyPromotions;
    const availablePromotions = (primaryPromotions.length ? primaryPromotions : detailPromotions).map(row => {
      const id = row.promotionId || row.id;
      const version = Number(row.promotionVersion || row.version || 0);
      const details = detailPromotions.find(item => (item.id || item.promotionId) === id
        && Number(item.version || item.promotionVersion) === version) || {};
      return { ...details, ...row, promotionId:id, promotionVersion:version };
    });
    const legacyVouchers = detailPromotions.flatMap(promotion => (promotion.vouchers || promotion.codes || []).map(voucher => ({
      ...voucher, promotionName:promotion.name, promotionId:promotion.id || promotion.promotionId,
    })));
    const primaryVouchers = primary.vouchers || primary.codes || [];
    const vouchers = [...legacyVouchers, ...primaryVouchers].reduce((rows, voucher) => {
      const key=voucher.id || `${voucher.promotionId || voucher.promotion_id}:${promotionCode(voucher) || voucher.codeHint || voucher.code_hint}`;
      rows.set(key,{...(rows.get(key)||{}),...voucher});return rows;
    },new Map());
    return normalizeMarketingWorkspace({ ...primary,
      availablePromotions,
      customerProfiles:supplements[0].status === 'fulfilled' ? supplements[0].value.rows || [] : [],
      loyalty:primary.loyalty || (supplements[1].status === 'fulfilled' ? supplements[1].value : null),
      eligibility:legacy.students || legacy.eligibilities || [],
      vouchers:[...vouchers.values()],
    });
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  const [programs, loyalty, profiles] = await Promise.allSettled([
    request(`${paths.legacy}?limit=100`),
    request(`/companies/${encodeURIComponent(companyId)}/loyalty`),
    request(`/companies/${encodeURIComponent(companyId)}/customer-profiles?limit=100`),
  ]);
  if (programs.status === 'rejected') throw programs.reason;
  const source = programs.value || {};
  return normalizeMarketingWorkspace({ ...source,
    loyalty:loyalty.status === 'fulfilled' ? loyalty.value : null,
    customerProfiles:profiles.status === 'fulfilled' ? profiles.value.rows || [] : [],
  });
}

export function emptyCampaign(now = new Date()) {
  const startsAt = new Date(now.getTime() + 5 * 60000);
  startsAt.setSeconds(0, 0);
  const localStart = new Date(startsAt.getTime() - startsAt.getTimezoneOffset() * 60000).toISOString().slice(0,16);
  return { expectedVersion:0, name:'', goal:'acquisition', audienceId:'',
    offerMode:'new', offerType:'percentage', offerValue:'10', rewardProductId:'', rewardVariantId:'',
    redemptionMode:'automatic', stackable:false, priority:'0', targetProductKeys:[], targetCategoryKeys:[],
    channels:['storefront','pos'], startsAt:localStart, endsAt:'',
    minimumSpend:'0.00', maxDiscount:'', budget:'', maxRedemptions:'', perCustomerLimit:'1',
    description:'', status:'draft', source:'campaign', promotionLinks:[], existingPromotionKey:'' };
}

export function campaignPayload(input = {}, { publish = false } = {}) {
  const name = text(input.name);
  if (name.length < 2 || name.length > 160) throw new Error('Campaign name must contain 2 to 160 characters.');
  const goal = text(input.goal);
  if (!CAMPAIGN_GOALS.some(item => item.id === goal)) throw new Error('Choose a campaign goal.');
  const audienceId = text(input.audienceId);
  const offerType = text(input.offerType);
  if (!OFFER_TYPES.some(item => item.id === offerType)) throw new Error('Choose an offer type.');
  const startsAt = iso(input.startsAt, 'Campaign start');
  const endsAt = iso(input.endsAt, 'Campaign end', { nullable:true });
  if (endsAt && new Date(endsAt) <= new Date(startsAt)) throw new Error('Campaign end must be after its start.');
  const channels = unique(input.channels || []);
  if (!channels.length) throw new Error('Choose at least one campaign channel.');
  if (channels.some(channel => !MARKETING_CHANNELS.some(item => item.id === channel))) throw new Error('Choose valid campaign channels.');
  if (publish && !channels.some(channel => ['storefront','pos'].includes(channel)))
    throw new Error('Add POS or Online storefront before publishing this campaign.');
  const offer = { type:offerType };
  if (offerType === 'bonus_points') {
    if (text(input.maxRedemptions) || text(input.perCustomerLimit))
      throw new Error('Bonus-point award caps are not available in this release.');
    offer.bonusPoints = positiveInteger(input.offerValue, 'Bonus points', { nullable:false });
  }
  const promotionLinks = Array.isArray(input.promotionLinks) ? input.promotionLinks.map(link => ({
    promotionId:text(link.promotionId || link.id), promotionVersion:Number(link.promotionVersion || link.version),
  })).filter(link => link.promotionId && Number.isSafeInteger(link.promotionVersion) && link.promotionVersion > 0) : [];
  if (offerType !== 'bonus_points' && !promotionLinks.length)
    throw new Error('Choose or create a valid campaign offer.');
  const audienceLinks = audienceId ? [{ audienceId, audienceVersion:Number(
    input.audienceVersion || (input.availableAudiences || []).find(row => row.id === audienceId)?.version || 1,
  ) }] : [];
  return {
    expectedVersion:Number(input.expectedVersion || input.version || 0), name,
    description:text(input.description), objective:goal, channels, startsAt, endsAt,
    budgetSen:senFromRinggit(input.budget, 'Campaign budget', { nullable:true }),
    currencyCode:text(input.currencyCode || 'MYR').toUpperCase(),
    offerKind:offerType === 'bonus_points' ? 'bonus_points' : 'promotion',
    bonusPoints:offerType === 'bonus_points' ? offer.bonusPoints : null,
    bonusMinimumSpendSen:offerType === 'bonus_points' ? senFromRinggit(input.minimumSpend || '0', 'Minimum spend') : null,
    promotionLinks, audienceLinks,
  };
}

export function campaignStepError(step, input = {}, context = {}) {
  if (step === 0) {
    if (text(input.name).length < 2) return 'Name this campaign so staff can identify it.';
    if (!CAMPAIGN_GOALS.some(item => item.id === text(input.goal))) return 'Choose the result this campaign should support.';
  }
  if (step === 1 && text(input.audienceId) && !(context.audiences || []).some(row => row.id === input.audienceId))
    return 'Choose an audience that is still available.';
  if (step === 2) {
    if (input.offerMode === 'existing') {
      if (!(context.offers || []).some(row => `${row.id}:${row.version}` === input.existingPromotionKey))
        return 'Choose an available offer version.';
      return '';
    }
    if (!OFFER_TYPES.some(item => item.id === text(input.offerType))) return 'Choose an offer.';
    try {
      if (input.offerType === 'percentage') {
        const value = Number(text(input.offerValue));
        if (!Number.isFinite(value) || value <= 0 || value > 100) throw new Error();
      } else if (input.offerType === 'fixed') senFromRinggit(input.offerValue, 'Fixed discount');
      else if (input.offerType === 'bonus_points') positiveInteger(input.offerValue, 'Bonus points', { nullable:false });
      else {
        const rewardProductId = text(input.rewardProductId);
        if (!rewardProductId) return 'Choose the free item.';
        const rewardProduct = (context.products || []).find(row => row.id === rewardProductId);
        if (rewardProduct?.variants?.length && !text(input.rewardVariantId))
          return 'Choose the exact product option for the free item.';
      }
    } catch { return 'Enter a valid offer value.'; }
  }
  if (step === 3 && !unique(input.channels || []).length) return 'Choose at least one channel.';
  if (step === 4) {
    try {
      const start = iso(input.startsAt, 'Campaign start');
      const end = iso(input.endsAt, 'Campaign end', { nullable:true });
      if (end && new Date(end) <= new Date(start)) return 'Campaign end must be after its start.';
      if (input.offerType === 'bonus_points'
          && (text(input.maxRedemptions) || text(input.perCustomerLimit)))
        return 'Bonus-point award caps are not available in this release.';
      if (input.offerType !== 'bonus_points')
        boundedInteger(input.priority, 'Offer priority', { min:-1_000_000, max:1_000_000 });
      positiveInteger(input.maxRedemptions, 'Maximum redemptions');
      positiveInteger(input.perCustomerLimit, 'Per-customer limit');
      senFromRinggit(input.minimumSpend || '0', 'Minimum spend');
      senFromRinggit(input.budget, 'Campaign budget', { nullable:true });
    } catch (error) { return error.message; }
  }
  return '';
}

export function selectedProduct(products = [], productId = '', variantId = '') {
  const product = products.find(row => row.id === productId);
  if (!product) return null;
  const variant = variantId ? (product.variants || []).find(row => row.id === variantId) : null;
  return { product, variant, label:variant ? `${product.name} · ${variant.name}` : product.name };
}

const localDateTime = value => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16);
};

export function campaignToForm(row = {}, offers = [], audiences = []) {
  const link = row.promotionLinks?.[0];
  const linkedOffer = link && offers.find(offer => offer.id === link.promotionId && Number(offer.version) === Number(link.promotionVersion));
  const audience = row.audienceLinks?.[0];
  const bonus = ['bonus_points','mixed'].includes(row.offerKind);
  const offerType = bonus ? 'bonus_points' : linkedOffer?.discountType || 'percentage';
  const offerValue = bonus ? String(row.bonusPoints || '')
    : offerType === 'percentage' ? String(Number(linkedOffer?.discountBasisPoints || 0) / 100)
      : offerType === 'fixed' ? ringgit(linkedOffer?.discountSen) : '';
  return { ...emptyCampaign(), id:row.id, expectedVersion:Number(row.version || 0), name:row.name || '',
    description:row.description || '', goal:row.objective || row.goal || 'acquisition', channels:row.channels || ['storefront'],
    startsAt:localDateTime(row.startsAt), endsAt:localDateTime(row.endsAt), budget:row.budgetSen == null ? '' : ringgit(row.budgetSen),
    currencyCode:row.currencyCode || 'MYR', audienceId:audience?.audienceId || '',
    audienceVersion:audience?.audienceVersion || audiences.find(item => item.id === audience?.audienceId)?.version,
    offerMode:bonus ? 'new' : 'existing', offerType, offerValue,
    rewardProductId:linkedOffer?.rewardProductId || '', rewardVariantId:linkedOffer?.rewardVariantId || '',
    redemptionMode:linkedOffer?.redemptionMode || 'automatic',
    stackable:Boolean(linkedOffer?.stackable), priority:String(Number(linkedOffer?.priority || 0)),
    targetProductKeys:(linkedOffer?.productTargets || []).map(target => JSON.stringify([target.productId,target.variantId || ''])),
    targetCategoryKeys:(linkedOffer?.categoryTargets || []).map(target => JSON.stringify([target.category,target.subcategory || ''])),
    minimumSpend:bonus ? ringgit(row.bonusMinimumSpendSen || 0) : ringgit(linkedOffer?.minSubtotalSen || 0),
    maxDiscount:linkedOffer?.maxDiscountSen == null ? '' : ringgit(linkedOffer.maxDiscountSen),
    maxRedemptions:linkedOffer?.maxTotalRedemptions == null ? '' : String(linkedOffer.maxTotalRedemptions),
    perCustomerLimit:linkedOffer?.perCustomerLimit == null ? '' : String(linkedOffer.perCustomerLimit),
    existingPromotionKey:linkedOffer ? `${linkedOffer.id}:${linkedOffer.version}` : '',
    promotionLinks:row.promotionLinks || [], offerChanged:false,
  };
}

export function audiencePayload(input = {}, { workspace = false } = {}) {
  const name = text(input.name);
  if (name.length < 2 || name.length > 120) throw new Error('Audience name must contain 2 to 120 characters.');
  const consentRequired = Boolean(input.consentRequired ?? input.consent?.required);
  const channels = consentRequired ? unique(input.consentChannels || input.consent?.channels || []) : [];
  if (consentRequired && !channels.length) throw new Error('Choose at least one consent channel.');
  if (channels.some(channel => !['email','sms','whatsapp'].includes(channel))) throw new Error('Choose valid consent channels.');
  const studentStatus = text(input.studentStatus || input.eligibility?.studentStatus || 'any');
  if (!['any','verified','not_verified'].includes(studentStatus)) throw new Error('Choose a valid eligibility rule.');
  const ids = value => unique(value || []);
  return {
    expectedVersion:Number(input.expectedVersion || input.version || 0),
    name, description:text(input.description), scope:workspace ? 'workspace' : 'company',
    consent:{ required:consentRequired, channels },
    eligibility:{ studentStatus },
    customer:{
      accountRequired:Boolean(input.accountRequired ?? input.customer?.accountRequired ?? true),
      minOrderCount:positiveInteger(input.minOrderCount ?? input.customer?.minOrderCount) || 0,
      minSpendSen:senFromRinggit(input.minSpend ?? (input.customer?.minSpendSen != null ? String(Number(input.customer.minSpendSen)/100) : '0'), 'Minimum customer spend', { nullable:true }) || 0,
      minLoyaltyPoints:positiveInteger(input.minLoyaltyPoints ?? input.customer?.minLoyaltyPoints) || 0,
      lastPurchaseWithinDays:positiveInteger(input.lastPurchaseWithinDays ?? input.customer?.lastPurchaseWithinDays),
      includeCustomerIds:ids(input.includeCustomerIds ?? input.customer?.includeCustomerIds),
      excludeCustomerIds:ids(input.excludeCustomerIds ?? input.customer?.excludeCustomerIds),
    },
  };
}

export function audienceToForm(row = {}) {
  return { id:row.id, expectedVersion:Number(row.version || 0), name:row.name || '', description:row.description || '',
    workspace:row.scope === 'workspace', consentRequired:Boolean(row.consent?.required), consentChannels:row.consent?.channels || [],
    studentStatus:row.eligibility?.studentStatus || 'any', accountRequired:Boolean(row.customer?.accountRequired),
    minOrderCount:row.customer?.minOrderCount || '', minSpend:row.customer?.minSpendSen != null ? ringgit(row.customer.minSpendSen) : '',
    minLoyaltyPoints:row.customer?.minLoyaltyPoints || '', lastPurchaseWithinDays:row.customer?.lastPurchaseWithinDays || '',
    includeCustomerIds:row.customer?.includeCustomerIds || [], excludeCustomerIds:row.customer?.excludeCustomerIds || [] };
}

const ringgit = sen => `${Math.floor(Number(sen||0)/100)}.${String(Number(sen||0)%100).padStart(2,'0')}`;

export function legacyPromotionPayload(campaign, { publish = false } = {}) {
  const offerType = text(campaign.offerType);
  if (offerType === 'bonus_points') throw new Error('Bonus points are saved directly on the campaign.');
  const targetTuples = (values, label) => unique(values || []).map(value => {
    try { const parsed=JSON.parse(value); if(Array.isArray(parsed)&&parsed.length===2&&text(parsed[0]))return parsed; } catch {}
    throw new Error(`Choose valid ${label}.`);
  });
  const productTargets = targetTuples(campaign.targetProductKeys || [], 'product targets')
    .map(([productId,variantId]) => ({ productId:text(productId), variantId:text(variantId) }));
  const categoryTargets = targetTuples(campaign.targetCategoryKeys || [], 'category targets')
    .map(([category,subcategory]) => ({ category:text(category), subcategory:text(subcategory) }));
  const redemptionMode = text(campaign.redemptionMode || 'automatic');
  if (!['automatic','voucher'].includes(redemptionMode)) throw new Error('Choose automatic or voucher redemption.');
  const base = {
    expectedVersion:Number(campaign.offerExpectedVersion || 0),
    name:text(campaign.offerName || campaign.name),
    enabled:false,
    redemptionMode,
    validFrom:iso(campaign.startsAt, 'Campaign start'),
    validUntil:iso(campaign.endsAt, 'Campaign end', { nullable:true }),
    discountType:offerType,
    discountBasisPoints:offerType === 'percentage' ? Math.round(Number(campaign.offerValue) * 100) : null,
    discountSen:offerType === 'fixed' ? senFromRinggit(campaign.offerValue, 'Fixed discount') : null,
    maxDiscountSen:offerType === 'free_item' ? null : senFromRinggit(campaign.maxDiscount, 'Maximum discount', { nullable:true }),
    minSubtotalSen:senFromRinggit(campaign.minimumSpend || '0', 'Minimum spend'),
    maxTotalRedemptions:positiveInteger(campaign.maxRedemptions, 'Maximum redemptions'),
    perCustomerLimit:positiveInteger(campaign.perCustomerLimit, 'Per-customer limit'),
    requiresCustomer:Boolean(text(campaign.audienceId)),
    requiresStudent:false,
    stackable:Boolean(campaign.stackable),
    priority:boundedInteger(campaign.priority, 'Offer priority', { min:-1_000_000, max:1_000_000 }),
    productTargets, categoryTargets, customerTargets:[],
  };
  if (offerType !== 'free_item') return promotionPayload(base);
  return { ...base, discountBasisPoints:null, discountSen:null,
    rewardProductId:text(campaign.rewardProductId), rewardVariantId:text(campaign.rewardVariantId),
    rewardQuantityMilli:1000 };
}

function voucherCoversCampaign(voucher, startsAt, endsAt, campaignId = '') {
  if (!voucher?.enabled) return false;
  if (text(voucher.campaignId) && text(voucher.campaignId) !== text(campaignId)) return false;
  const voucherStart = new Date(voucher.validFrom).getTime();
  const campaignStart = new Date(startsAt).getTime();
  if (!Number.isFinite(voucherStart) || voucherStart > campaignStart) return false;
  if (endsAt) {
    const campaignEnd = new Date(endsAt).getTime();
    const voucherEnd = voucher.validUntil ? new Date(voucher.validUntil).getTime() : Infinity;
    if (!Number.isFinite(campaignEnd) || voucherEnd < campaignEnd) return false;
  } else if (voucher.validUntil) return false;
  return voucher.maxRedemptions == null || Number(voucher.redeemedCount || 0) < Number(voucher.maxRedemptions);
}

export function campaignPublishError(input = {}, offers = []) {
  if (!unique(input.channels || []).some(channel => ['storefront','pos'].includes(channel)))
    return 'Add POS or Online storefront before publishing this campaign.';
  if (text(input.offerType) === 'bonus_points') return '';
  const chosen = input.offerMode === 'existing' && input.offerChanged !== true
    ? offers.find(row => `${row.id}:${row.version}` === input.existingPromotionKey)
    : null;
  const redemptionMode = chosen?.redemptionMode || text(input.redemptionMode || 'automatic');
  if (redemptionMode !== 'voucher') return '';
  if (!chosen) return 'Save this voucher campaign as a draft, then create and enable its code in Offers & vouchers before publishing.';
  const startsAt = iso(input.startsAt, 'Campaign start');
  const endsAt = iso(input.endsAt, 'Campaign end', { nullable:true });
  if (!(chosen.vouchers || []).some(voucher => voucherCoversCampaign(voucher, startsAt, endsAt, input.id)))
    return 'Create and enable a voucher code that covers the full campaign schedule before publishing.';
  return '';
}

export async function saveMarketingCampaign(request, companyId, form, { publish = false } = {}) {
  const paths = marketingPaths(companyId);
  const id = text(form.id), campaignForm = { ...form };
  if (publish) {
    const issue = campaignPublishError(campaignForm, form.availableOffers || []);
    if (issue) throw new Error(issue);
  }
  let offerBody = null;
  if (campaignForm.offerType !== 'bonus_points') {
    const chosen = form.offerMode === 'existing' && form.offerChanged !== true
      ? (form.availableOffers || []).find(row => `${row.id}:${row.version}` === form.existingPromotionKey)
      : null;
    if (chosen) {
      campaignForm.offerType = chosen.discountType || 'percentage';
      campaignForm.promotionLinks = [{ promotionId:chosen.id, promotionVersion:Number(chosen.version) }];
    }
    else if (!campaignForm.promotionLinks?.length || form.offerChanged !== false) {
      offerBody = legacyPromotionPayload(form, { publish });
      campaignForm.promotionLinks = [{ promotionId:'pending-offer', promotionVersion:1 }];
    }
  } else campaignForm.promotionLinks = [];
  let body = campaignPayload(campaignForm, { publish });
  if (offerBody) {
      const savedOffer = await request(`${paths.base}/promotions`, { method:'POST', body:offerBody });
    campaignForm.promotionLinks = [{ promotionId:savedOffer.id, promotionVersion:Number(savedOffer.version) }];
    body = campaignPayload(campaignForm, { publish });
  }
  const saved = await request(id ? `${paths.campaigns}/${encodeURIComponent(id)}` : paths.campaigns,
    { method:id ? 'PUT' : 'POST', body });
  if (!publish) return saved;
  return request(`${paths.campaigns}/${encodeURIComponent(saved.id)}/publish`,
    { method:'POST', body:{ expectedVersion:Number(saved.version) } });
}

export function attributedMetricCards(analytics = {}, currency = 'RM', customerCohort = null) {
  const count = value => value === null || value === undefined ? '—' : Number(value).toLocaleString('en-MY');
  const amount = value => value === null || value === undefined ? '—' : `${currency} ${(Number(value) / 100).toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  return [
    { key:'qualifiedQuotes', label:'Qualified quotes', value:count(analytics.qualifiedQuotes) },
    { key:'conversions', label:'Attributed conversions', value:count(analytics.conversions) },
    { key:'attributedRevenueSen', label:'Attributed revenue', value:amount(analytics.attributedRevenueSen) },
    { key:'discountCostSen', label:'Discount cost', value:amount(analytics.discountCostSen) },
    { key:'averageOrderValueSen', label:'Attributed AOV', value:amount(analytics.averageOrderValueSen) },
    { key:'uniqueCustomers', label:'Unique customers', value:customerCohort?.suppressed ? `Hidden (<${customerCohort.cohortThreshold})` : count(customerCohort?.uniqueCustomers ?? analytics.uniqueCustomers) },
    { key:'voucherRedemptions', label:'Voucher redemptions', value:count(analytics.voucherRedemptions ?? analytics.voucherUses) },
    { key:'bonusPointsAwarded', label:'Bonus points awarded', value:count(analytics.bonusPointsAwarded) },
  ];
}

export const ATTRIBUTION_NOTICE = 'Attributed results show transactions carrying campaign or offer evidence. They do not prove that the campaign caused the sale or represent causal return on investment.';

export function offerPresentation(row = {}, currency = 'RM') {
  const type = row.discountType || row.type || row.offerType;
  if (type === 'percentage') return `${Number(row.discountBasisPoints ?? row.percentageBasisPoints ?? 0) / 100}% off`;
  if (type === 'fixed') return `${currency} ${(Number(row.discountSen ?? row.amountSen ?? 0) / 100).toFixed(2)} off`;
  if (type === 'free_item') return `Free ${row.rewardProductName || row.productName || 'selected item'}`;
  if (type === 'bonus_points') return `${Number(row.bonusPoints || 0)} bonus points`;
  return 'Offer details';
}
