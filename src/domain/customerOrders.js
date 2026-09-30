const STATUS_LABELS = Object.freeze({
  awaiting_acceptance: 'New request',
  submitted: 'New request',
  accepted: 'Accepted',
  preparing: 'Preparing',
  ready: 'Ready for collection',
  paid: 'Paid',
  cancelled: 'Cancelled',
  expired: 'Expired',
});

const ACTIVE = new Set(['awaiting_acceptance', 'submitted', 'accepted', 'preparing', 'ready']);

export const customerOrderStatusLabel = status => STATUS_LABELS[status] || 'Order request';
export const isActiveCustomerOrder = order => ACTIVE.has(order?.status);
export const isTenderableCustomerOrder = order => ['accepted', 'preparing', 'ready'].includes(order?.status) && order?.paymentStatus !== 'paid';

export function customerOrderActions(order) {
  if (!order || order.paymentStatus === 'paid') return [];
  if (['awaiting_acceptance','submitted'].includes(order.status)) return ['accepted', 'cancelled', 'expired'];
  if (order.status === 'accepted') return ['preparing', 'cancelled', 'expired'];
  if (order.status === 'preparing') return ['ready', 'cancelled', 'expired'];
  if (order.status === 'ready') return ['cancelled', 'expired'];
  return [];
}

export function customerOrderCounts(value = {}) {
  const counts = value.counts || value;
  const number = key => Math.max(0, Number(counts[key] || 0));
  return {
    active: number('active') || number('awaiting_acceptance') + number('awaitingAcceptance') + number('submitted') + number('accepted') + number('preparing') + number('ready'),
    submitted: number('awaiting_acceptance') || number('awaitingAcceptance') || number('submitted'),
    accepted: number('accepted'),
    preparing: number('preparing'),
    ready: number('ready'),
    paid: number('paid'),
  };
}

export function customerOrderCart(order = {}) {
  return (order.checkoutCart?.items || order.items || []).map(item => ({
    productId: String(item.productId || item.product_id || ''),
    variantId: String(item.variantId || item.variant_id || ''),
    desc: String(item.description || item.desc || item.name || ''),
    variant: String(item.variant || item.variantName || ''),
    unit: String(item.unit || 'item'),
    qty: Number(item.quantity ?? item.qty),
    price: Number(item.unitPrice ?? item.price),
  }));
}

export function customerOrderCustomer(order = {}) {
  const customer = order.checkoutCart?.customer || order.customer || {};
  return {
    id: String(order.clientId || order.client_id || customer.clientId || ''),
    name: String(order.customerName || order.guestName || customer.name || ''),
    email: String(order.customerEmail || order.guestEmail || customer.email || ''),
  };
}

export function validCustomerOrderCart(items) {
  return Array.isArray(items) && items.length > 0 && items.every(item =>
    item.productId && item.desc && Number.isFinite(item.qty) && item.qty > 0 &&
    Number.isFinite(item.price) && item.price >= 0,
  );
}

export function customerOrderTenderMatches(sale, totals = {}) {
  const fields = ['subtotal','discountAmount','tax','taxRate','totalBeforeRounding','rounding','total'];
  return fields.every(field => Number(sale?.[field]) === Number(totals?.[field])) && Number(sale?.discount || 0) === Number(totals?.discount || 0);
}
