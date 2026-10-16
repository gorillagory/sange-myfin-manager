import * as v from './validation.js';

const blockingStates = new Set([
  'creating', 'pending', 'reconciliation_required', 'confirmed_unposted', 'finalized',
]);

export async function lockOrderPayment(c, companyId, orderId) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`online-payment-order:${companyId}:${orderId}`]);
}

export async function onlinePaymentStates(c, companyId, orderId, { lock = true } = {}) {
  if (lock) await lockOrderPayment(c, companyId, orderId);
  return (await c.query(
    `SELECT state FROM myfin.customer_order_online_payment_state
      WHERE company_id=$1 AND order_id=$2
      ORDER BY created_at DESC,intent_id DESC`, [companyId, orderId],
  )).rows.map(row => row.state);
}

export async function onlinePaymentReleaseBlocker(c, companyId, orderId, options) {
  const states = await onlinePaymentStates(c, companyId, orderId, options);
  return states.find(state => blockingStates.has(state)) || '';
}

export async function assertOnlinePaymentAllowsRelease(c, companyId, orderId) {
  if (await onlinePaymentReleaseBlocker(c, companyId, orderId))
    v.fail(409, 'online_payment_holds_order');
}

export const ONLINE_PAYMENT_BLOCKING_STATES = blockingStates;
