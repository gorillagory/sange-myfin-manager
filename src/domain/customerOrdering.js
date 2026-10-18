const text = value => String(value ?? '').trim();

export const CUSTOMER_SURFACE_PATHS = ['/shop', '/menu', '/display', '/order', '/privacy'];

const safeColor = (value, fallback) => /^#[0-9a-f]{6}$/i.test(text(value)) ? text(value) : fallback;
const safeHttps = value => text(value).length <= 2048 && /^https:\/\/\S+$/i.test(text(value)) ? text(value) : '';
const safeAction = value => text(value).length <= 2048 && (/^https:\/\/\S+$/i.test(text(value)) ||
  (/^\/[A-Za-z0-9/_?&=.%#-]*$/.test(text(value)) && !text(value).startsWith('//'))) ? text(value) : '';
const safeMoney = (value, fallback = 0) => value !== null && value !== undefined && value !== '' &&
  Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;

const FONT_STACKS = Object.freeze({
  geist: "'Geist Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  system: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  serif: "Georgia, 'Times New Roman', ui-serif, serif",
});

export function storefrontFontStack(value = 'geist') {
  return FONT_STACKS[text(value)] || FONT_STACKS.geist;
}

function colorChannels(value) {
  const color = safeColor(value, '#000000').slice(1);
  return [0,2,4].map(index => Number.parseInt(color.slice(index,index + 2),16) / 255);
}

export function storefrontContrastRatio(foreground, background) {
  const luminance = value => {
    const channels = colorChannels(value).map(channel => channel <= 0.04045
      ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const left = luminance(foreground), right = luminance(background);
  return (Math.max(left,right) + 0.05) / (Math.min(left,right) + 0.05);
}

export function accessibleStorefrontText(background, preferred = '#ffffff') {
  if (storefrontContrastRatio(preferred,background) >= 4.5) return safeColor(preferred,'#ffffff');
  return storefrontContrastRatio('#ffffff',background) >= storefrontContrastRatio('#111111',background)
    ? '#ffffff' : '#111111';
}

export function storefrontContrastIssues(theme = {}, slides = []) {
  const issues = [];
  if (storefrontContrastRatio(theme.textColor || '#15382c',theme.backgroundColor || '#fbfcf8') < 4.5)
    issues.push('Text and background colors need stronger contrast.');
  if (storefrontContrastRatio('#ffffff',theme.primaryColor || '#17624d') < 4.5)
    issues.push('Primary color must be dark enough for white button labels.');
  for (const [index,slide] of slides.entries()) if (
    storefrontContrastRatio('#ffffff',slide.backgroundColor || '#17624d') < 4.5
  ) issues.push(`Slide ${index + 1} background must be dark enough for white text.`);
  return issues;
}

export function customerProductDisplayPrice(product = {}, key = 'onlinePrice') {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const orderable = variants.filter(variant => variant.available !== false);
  const options = orderable.length ? orderable : variants.length ? variants : [product];
  const advertised = options.reduce((lowest, item) => Number(item.onlinePrice ?? item.price ?? 0) <
    Number(lowest.onlinePrice ?? lowest.price ?? 0) ? item : lowest, options[0] || product);
  return Number(advertised?.[key] ?? advertised?.price ?? 0);
}

export function isCustomerSurfacePath(pathname = '') {
  const path = String(pathname).split('?')[0].replace(/\/+$/, '') || '/';
  return CUSTOMER_SURFACE_PATHS.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

export function isStorefrontHostname(hostname = '') {
  return text(hostname).toLowerCase().split('.')[0].startsWith('order-');
}

export function normalizeStorefront(payload = {}) {
  const storefront = payload.storefront || {};
  const privacy = storefront.privacy || {};
  const currency = text(storefront.currency) || 'RM';
  const locations = (payload.locations || []).map(location => ({
    id: text(location.id),
    name: text(location.name) || 'Pickup counter',
    fulfillmentMode: ['pickup', 'table', 'both'].includes(location.fulfillmentMode) ? location.fulfillmentMode : 'pickup',
  })).filter(location => location.id);
  const deliveryZones = (payload.deliveryZones || []).map(zone => ({
    id: text(zone.id), name: text(zone.name), fee: Number(zone.fee),
    minimumOrder: Number(zone.minimumOrder), leadTimeMinutes: Math.floor(Number(zone.leadTimeMinutes)),
    serviceInstructions: text(zone.serviceInstructions),
  })).filter(zone => zone.id && zone.name && Number.isFinite(zone.fee) && zone.fee >= 0 &&
    Number.isFinite(zone.minimumOrder) && zone.minimumOrder >= 0 &&
    Number.isInteger(zone.leadTimeMinutes) && zone.leadTimeMinutes >= 5 && zone.leadTimeMinutes <= 1440);
  const products = (payload.products || []).map(product => {
    const storePrice = safeMoney(product.storePrice, safeMoney(product.price));
    const onlinePrice = safeMoney(product.onlinePrice, safeMoney(product.price, storePrice));
    return {
      id: text(product.id).slice(0, 128), name: text(product.name).slice(0, 120),
      description: text(product.description).slice(0, 2000),
      category: text(product.category).slice(0, 120) || 'Menu', subcategory: text(product.subcategory).slice(0, 120),
      imageUrl: safeHttps(product.imageUrl), unit: text(product.unit).slice(0, 40) || 'item',
      storePrice, onlinePrice, price: onlinePrice,
      hasOnlinePriceOverride: onlinePrice !== storePrice,
      available: product.available !== false,
      maxQuantity: Math.max(0, Math.floor(Number(product.maxQuantity ?? 20) || 0)),
      variants: (product.variants || []).map(variant => {
        const variantStorePrice = safeMoney(variant.storePrice, safeMoney(variant.price, storePrice));
        const variantOnlinePrice = safeMoney(variant.onlinePrice, safeMoney(variant.price, variantStorePrice));
        return { id: text(variant.id).slice(0, 128), name: text(variant.name).slice(0, 120), storePrice: variantStorePrice,
          onlinePrice: variantOnlinePrice, price: variantOnlinePrice,
          hasOnlinePriceOverride: variantOnlinePrice !== variantStorePrice,
          available: variant.available !== false,
          maxQuantity: Math.max(0, Math.floor(Number(variant.maxQuantity ?? product.maxQuantity ?? 20) || 0)) };
      }).filter(variant => variant.id && variant.name),
    };
  }).filter(product => product.id && product.name && Number.isFinite(product.price) && product.price >= 0);
  const theme = storefront.theme || {};
  const hero = storefront.hero || {};
  const slides = (payload.slides || []).slice(0, 12).map(slide => ({
    id: text(slide.id), badge: text(slide.badge).slice(0, 80), title: text(slide.title).slice(0, 160),
    description: text(slide.description).slice(0, 1000), imageUrl: safeHttps(slide.imageUrl),
    backgroundColor: safeColor(slide.backgroundColor, '#17624d'),
    ctaLabel: text(slide.ctaLabel).slice(0, 60), ctaUrl: safeAction(slide.ctaUrl),
  })).filter(slide => slide.id && slide.title && Boolean(slide.ctaLabel) === Boolean(slide.ctaUrl));
  return {
    storefront: {
      companyId: text(storefront.companyId),
      name: text(storefront.name).slice(0, 120) || 'Online ordering',
      description: text(storefront.description).slice(0, 2000),
      currency: currency.slice(0, 8),
      pickupInstructions: text(storefront.pickupInstructions).slice(0, 2000),
      logoUrl: safeHttps(storefront.logoUrl),
      theme: { primaryColor: safeColor(theme.primaryColor, '#17624d'),
        accentColor: safeColor(theme.accentColor, '#d7a43b'),
        backgroundColor: safeColor(theme.backgroundColor, '#fbfcf8'),
        textColor: safeColor(theme.textColor, '#15382c'),
        fontFamily: ['geist','system','serif'].includes(text(theme.fontFamily)) ? text(theme.fontFamily) : 'geist' },
      hero: { eyebrow: text(hero.eyebrow).slice(0, 80), title: text(hero.title).slice(0, 160),
        description: text(hero.description).slice(0, 1000), imageUrl: safeHttps(hero.imageUrl) },
      carouselIntervalSeconds: Math.max(3, Math.min(30,
        Math.floor(Number(storefront.carouselIntervalSeconds) || 7))),
      privacy: {
        controllerName: text(privacy.controllerName),
        controllerContact: text(privacy.controllerContact),
        noticeUrl: /^https:\/\/\S+$/i.test(text(privacy.noticeUrl)) ? text(privacy.noticeUrl) : '',
        noticeEn: text(privacy.noticeEn),
        noticeMs: text(privacy.noticeMs),
        guestContactRetentionDays: Math.max(7, Math.min(3650,
          Math.floor(Number(privacy.guestContactRetentionDays) || 90))),
      },
    },
    slides,
    locations,
    deliveryZones,
    location: payload.location ? {
      id: text(payload.location.id),
      name: text(payload.location.name) || 'This location',
      fulfillmentMode: ['pickup', 'table', 'both'].includes(payload.location.fulfillmentMode) ? payload.location.fulfillmentMode : 'pickup',
    } : null,
    products,
  };
}

export function deliveryOrderDetails(zoneId, address = {}, zones = []) {
  const id = text(zoneId), zone = zones.find(item => item.id === id);
  if (!zone) throw new Error('Choose an available delivery zone.');
  const value = {
    addressLine1: text(address.addressLine1), addressLine2: text(address.addressLine2),
    postcode: text(address.postcode), city: text(address.city), state: text(address.state),
    countryCode: 'MY', instructions: text(address.instructions),
  };
  if (!value.addressLine1 || !value.postcode || !value.city || !value.state)
    throw new Error('Add the delivery address, postcode, city, and state.');
  if (value.addressLine1.length > 160 || value.addressLine2.length > 160 || value.postcode.length > 20 ||
      value.city.length > 120 || value.state.length > 120 || value.instructions.length > 500)
    throw new Error('Shorten the delivery address or instructions.');
  return { zoneId: id, address: value };
}

export function publicCartLine(product, variantId = '') {
  if (!product?.id || product.available === false) throw new Error('This item is unavailable.');
  const variants = product.variants || [];
  const variant = variantId ? variants.find(item => item.id === variantId) : null;
  if (variants.length && !variant) throw new Error('Choose an available option.');
  if (variant?.available === false) throw new Error('This option is unavailable.');
  const maxQuantity = Math.max(0, Math.floor(Number(variant?.maxQuantity ?? product.maxQuantity ?? 20) || 0));
  if (!maxQuantity) throw new Error('This item is sold out.');
  return {
    key: `${product.id}:${variant?.id || ''}`,
    productId: product.id,
    variantId: variant?.id || '',
    name: product.name,
    variantName: variant?.name || '',
    unit: product.unit || 'item',
    price: Number(variant?.price ?? product.price),
    quantity: 1,
    maxQuantity,
  };
}

export function addPublicCartLine(lines = [], nextLine) {
  const found = lines.find(line => line.key === nextLine.key);
  if (!found) return [...lines, nextLine];
  if (found.quantity >= found.maxQuantity) throw new Error(`You can order up to ${found.maxQuantity} of this item.`);
  return lines.map(line => line.key === nextLine.key ? { ...line, quantity: line.quantity + 1 } : line);
}

export function setPublicCartQuantity(lines = [], key, quantity) {
  const amount = Math.floor(Number(quantity));
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Choose a valid quantity.');
  if (amount === 0) return lines.filter(line => line.key !== key);
  return lines.map(line => {
    if (line.key !== key) return line;
    if (amount > line.maxQuantity) throw new Error(`You can order up to ${line.maxQuantity} of this item.`);
    return { ...line, quantity: amount };
  });
}

export function publicCartSummary(lines = []) {
  const summary=lines.reduce((result, line) => {
    const quantity = Math.max(0, Math.floor(Number(line?.quantity) || 0));
    const priceSen = Math.max(0, Math.round((Number(line?.price) || 0) * 100));
    result.itemCount += quantity;
    result.estimatedTotalSen += priceSen * quantity;
    return result;
  }, { itemCount: 0, estimatedTotalSen: 0 });
  return {itemCount:summary.itemCount,estimatedTotal:summary.estimatedTotalSen/100};
}

export const cartRequestItems = lines => lines.map(line => ({
  productId: line.productId,
  ...(line.variantId ? { variantId: line.variantId } : {}),
  quantity: line.quantity,
}));

export function validateGuestOrder({ fulfillmentMode, guest = {}, notes = '' } = {}) {
  const name = text(guest.name);
  const email = text(guest.email).toLowerCase();
  const phone = text(guest.phone);
  if (fulfillmentMode !== 'table' && name.length < 2) throw new Error('Enter a name for collection.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (phone && !/^\+?[0-9 ()-]{7,24}$/.test(phone)) throw new Error('Enter a valid phone number.');
  if (fulfillmentMode !== 'table' && !email && !phone) throw new Error('Add an email address or phone number so the shop can contact you.');
  if (text(notes).length > 500) throw new Error('Keep order notes within 500 characters.');
  return { name: name || 'Guest', email, phone, notes: text(notes) };
}

export function customerOrderSubmission({ order = {}, quoteToken, fulfillmentMode, guest, notes } = {}) {
  if (!text(quoteToken)) throw new Error('Review the latest shop quote before placing this order.');
  const details = validateGuestOrder({ fulfillmentMode, guest, notes });
  return {
    ...order,
    quoteToken,
    guest: {
      name: details.name,
      ...(details.email ? { email: details.email } : {}),
      ...(details.phone ? { phone: details.phone } : {}),
    },
    ...(details.notes ? { notes: details.notes } : {}),
  };
}

export function orderProgress(status, fulfillmentStatus = '') {
  const steps = ['submitted', 'accepted', 'preparing', 'ready', 'completed'];
  let value = text(status).toLowerCase();
  if (['pending', 'awaiting_acceptance'].includes(value)) value = 'submitted';
  if (value === 'paid') {
    const fulfillment = text(fulfillmentStatus).toLowerCase();
    value = fulfillment === 'completed' ? 'completed'
      : fulfillment === 'ready' ? 'ready'
        : fulfillment === 'preparing' ? 'preparing' : 'accepted';
  }
  const terminal = ['cancelled', 'expired', 'declined'].includes(value);
  const index = steps.indexOf(value);
  return { steps, current: value, currentIndex: index < 0 ? 0 : index, terminal };
}

export function formatCustomerMoney(value, currency = 'RM') {
  return `${currency} ${Number(value || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
