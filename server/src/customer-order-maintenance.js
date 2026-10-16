import { createHash, randomUUID } from 'node:crypto';
import { releaseOrderReservations } from './customer-order-reservations.js';
import { releaseOrderPromotionReservations } from './pricing-engine.js';
import { redactExpiredOrderContacts } from './storefront-privacy.js';
import { onlinePaymentReleaseBlocker } from './online-payment-lock.js';

const activeStatuses = Object.freeze(['awaiting_acceptance','accepted','preparing','ready']);
const terminalStatuses = Object.freeze(['cancelled','expired','paid']);

function batchLimit(value = 100) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500)
    throw new TypeError('invalid_customer_order_maintenance_limit');
  return parsed;
}

const digest = value => createHash('sha256').update(value).digest('hex');
const expiryRequestId = order => `expiry:${digest(`${order.company_id}\0${order.id}`)}`;

/**
 * This scheduled path intentionally mirrors the request-time expiry transition.
 * Keeping it independent avoids coupling background privacy work to public-order
 * pricing and tender routes while those routes evolve. Both paths use the same
 * active states, terminal state, reservation release and immutable event shape.
 */
export async function expireStaleCustomerOrders(c, { now = new Date(), limit = 100 } = {}) {
  const instant = new Date(now), bounded = batchLimit(limit);
  if (!Number.isFinite(instant.getTime())) throw new TypeError('invalid_customer_order_maintenance_time');
  const candidates = await c.query(
    `SELECT o.company_id,o.id,o.status,o.version
       FROM myfin.customer_order_requests o
      WHERE o.status=ANY($1::text[]) AND o.expires_at<=$2
      ORDER BY o.expires_at,o.company_id,o.id
      LIMIT $3
      FOR UPDATE OF o SKIP LOCKED`,
    [activeStatuses, instant, bounded],
  );
  let expired = 0;
  for (const order of candidates.rows) {
    if (await onlinePaymentReleaseBlocker(c, order.company_id, order.id)) continue;
    const nextVersion = Number(order.version) + 1;
    const updated = await c.query(
      `UPDATE myfin.customer_order_requests
          SET status='expired',version=$4,updated_at=$5
        WHERE company_id=$1 AND id=$2 AND status=$3 AND version=$6
          AND expires_at<=$5
        RETURNING id`,
      [order.company_id, order.id, order.status, nextVersion, instant, order.version],
    );
    if (!updated.rowCount) continue;
    await releaseOrderReservations(c, order.company_id, order.id, 'expired');
    await releaseOrderPromotionReservations(c, {
      companyId:order.company_id, orderId:order.id, reason:'expired',
    });
    const requestId = expiryRequestId(order);
    await c.query(
      `INSERT INTO myfin.customer_order_events(
         company_id,id,order_id,version,actor_type,request_id,request_digest,
         action,from_status,to_status,note,created_at)
       VALUES($1,$2,$3,$4,'system',$5,$6,'expired',$7,'expired',
         'Order expired before payment.',$8)`,
      [order.company_id, randomUUID(), order.id, nextVersion, requestId,
        digest(requestId), order.status, instant],
    );
    expired++;
  }
  return { selected:candidates.rows.length, expired, capped:candidates.rows.length === bounded };
}

/**
 * Find every tenant with stale terminal-order contact data, including suspended,
 * archived and unpublished shops, then reuse the request-path redaction mutation.
 * The remaining row budget is passed per tenant so one cycle can never redact
 * more than the configured bound.
 */
export async function redactRetainedCustomerOrderContacts(c, { limit = 100 } = {}) {
  const bounded = batchLimit(limit);
  const candidates = await c.query(
    `SELECT o.company_id,min(o.updated_at) AS oldest
       FROM myfin.customer_order_requests o
       JOIN myfin.storefront_settings s ON s.company_id=o.company_id
      WHERE o.pii_redacted_at IS NULL
        AND o.status=ANY($1::text[])
        AND o.updated_at<now()-make_interval(days=>s.guest_data_retention_days)
      GROUP BY o.company_id
      ORDER BY oldest,o.company_id
      LIMIT $2`,
    [terminalStatuses, bounded + 1],
  );
  let redacted = 0, companies = 0;
  for (const row of candidates.rows) {
    const remaining = bounded - redacted;
    if (remaining <= 0) break;
    redacted += await redactExpiredOrderContacts(c, row.company_id, remaining);
    companies++;
  }
  return {
    companies, redacted,
    capped:redacted === bounded || candidates.rows.length === bounded + 1,
  };
}

/**
 * Public quotes persist immutable pricing evidence so an accepted order can be
 * checked against exactly what the customer saw. Quotes that expired without
 * ever being attached to an order or redemption have no accounting value. A
 * guarded SECURITY DEFINER function removes only that bounded, unbound set;
 * the runtime role never receives DELETE on the evidence tables themselves.
 */
export async function cleanupExpiredStorefrontPricingSnapshots(c, { limit = 100 } = {}) {
  const bounded = batchLimit(limit);
  const result = await c.query(
    `SELECT selected_count,deleted_count
       FROM myfin.cleanup_expired_unbound_storefront_pricing_snapshots($1)`,
    [bounded],
  );
  const row = Array.isArray(result?.rows) && result.rows.length === 1 ? result.rows[0] : null;
  const selected = Number(row?.selected_count);
  const deleted = Number(row?.deleted_count);
  if (!row || row.selected_count == null || row.deleted_count == null ||
      !Number.isSafeInteger(selected) || selected < 0 || selected > bounded ||
      !Number.isSafeInteger(deleted) || deleted < 0 || deleted > selected)
    throw new Error('invalid_pricing_snapshot_cleanup_result');
  return { selected,deleted,capped:selected === bounded };
}

export async function maintainCustomerOrders(c, options = {}) {
  const expiry = await expireStaleCustomerOrders(c, options);
  const privacy = await redactRetainedCustomerOrderContacts(c, options);
  const pricing = await cleanupExpiredStorefrontPricingSnapshots(c, options);
  return {
    selected:expiry.selected,
    expired:expiry.expired,
    redacted:privacy.redacted,
    companies:privacy.companies,
    storefrontPricingSnapshotsSelected:pricing.selected,
    storefrontPricingSnapshotsDeleted:pricing.deleted,
    hasMore:expiry.capped || privacy.capped || pricing.capped,
  };
}

export async function runCustomerOrderMaintenance(database, options = {}) {
  return database.transaction(c => maintainCustomerOrders(c, options));
}

export const customerOrderMaintenanceInternals = Object.freeze({
  activeStatuses, terminalStatuses, batchLimit, expiryRequestId,
});
