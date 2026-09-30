const text = value => String(value ?? '').trim();

export const CUSTOMER_SURFACE_PATHS = ['/shop', '/menu', '/order', '/privacy'];

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
  const products = (payload.products || []).map(product => ({
    id: text(product.id),
    name: text(product.name),
    description: text(product.description),
    category: text(product.category) || 'Menu',
    subcategory: text(product.subcategory),
    imageUrl: text(product.imageUrl),
    unit: text(product.unit) || 'item',
    price: Number(product.price || 0),
    available: product.available !== false,
    maxQuantity: Math.max(0, Math.floor(Number(product.maxQuantity ?? 20) || 0)),
    variants: (product.variants || []).map(variant => ({
      id: text(variant.id),
      name: text(variant.name),
      price: Number(variant.price ?? product.price ?? 0),
      available: variant.available !== false,
      maxQuantity: Math.max(0, Math.floor(Number(variant.maxQuantity ?? product.maxQuantity ?? 20) || 0)),
    })).filter(variant => variant.id && variant.name),
  })).filter(product => product.id && product.name && Number.isFinite(product.price) && product.price >= 0);
  return {
    storefront: {
      companyId: text(storefront.companyId),
      name: text(storefront.name) || 'Online ordering',
      description: text(storefront.description),
      currency,
      pickupInstructions: text(storefront.pickupInstructions),
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
    locations,
    location: payload.location ? {
      id: text(payload.location.id),
      name: text(payload.location.name) || 'This location',
      fulfillmentMode: ['pickup', 'table', 'both'].includes(payload.location.fulfillmentMode) ? payload.location.fulfillmentMode : 'pickup',
    } : null,
    products,
  };
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
