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
const COUNTER_PAYMENT_BLOCKED = new Set([
  'creating', 'pending', 'reconciliation_required', 'confirmed', 'confirmed_unposted', 'finalized', 'posted',
]);

export const customerOrderOnlinePaymentLabel = payment => ({
  creating: 'Opening secure checkout',
  pending: 'Secure checkout in progress',
  reconciliation_required: 'Provider reconciliation required',
  failed: 'Online payment failed',
  confirmed: 'Online payment confirmed',
  confirmed_unposted: 'Online payment confirmed',
  finalized: 'Online payment posted',
  posted: 'Online payment posted',
}[payment?.state] || 'No online payment started');

export const blocksCounterPayment = payment => COUNTER_PAYMENT_BLOCKED.has(payment?.state);

export const canReconcileCustomerOrderPayment = payment =>
  ['creating','pending','reconciliation_required'].includes(payment?.state) &&
  !payment?.paymentId;

export function onlinePaymentReconciliationError(error) {
  const code = typeof error === 'string' ? error : error?.message;
  if (code === 'online_payment_provider_request_not_found')
    return 'HitPay did not return one exact request for this reference. Keep counter payment locked and check the HitPay dashboard before retrying reconciliation.';
  if (code === 'online_payment_provider_response_invalid')
    return 'HitPay returned a response MyFin could not verify. Keep this order locked and retry after checking the provider service status.';
  if (code === 'online_payment_reconciliation_unavailable')
    return 'MyFin could not reach the configured HitPay account. Check the gateway connection, then retry; do not take another payment.';
  if (['online_payment_reference_mismatch','online_payment_amount_mismatch',
    'online_payment_currency_mismatch','online_payment_request_mismatch',
    'online_payment_request_conflict','online_payment_changed'].includes(code))
    return 'The provider record does not match this order or changed during review. Keep payment locked and escalate this evidence to the workspace owner.';
  return 'HitPay reconciliation could not be completed. Keep counter payment locked and retry from this order.';
}

export const isTenderableCustomerOrder = (order, payment = null) =>
  ['accepted', 'preparing', 'ready'].includes(order?.status) &&
  order?.paymentStatus !== 'paid' && !blocksCounterPayment(payment || { state:order?.onlinePaymentState });

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

export function customerOrderTenderMatches(sale, totals = {}, pricingSnapshotId = '') {
  const fields = ['subtotal','discountAmount','tax','taxRate','totalBeforeRounding','rounding','total'];
  return fields.every(field => Number(sale?.[field]) === Number(totals?.[field])) &&
    Number(sale?.deliveryFee || 0) === Number(totals?.deliveryFee || 0) &&
    Number(sale?.discount || 0) === Number(totals?.discount || 0) &&
    (!pricingSnapshotId || sale?.pricingSnapshotId === pricingSnapshotId);
}
