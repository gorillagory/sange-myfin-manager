import * as v from './validation.js';

const keyFor = (productId, variantId = '') => `${productId}\u0000${variantId || ''}`;

export async function activeReservationQuantities(c, companyId, productIds, excludedOrderId = '') {
  if (!productIds.length) return new Map();
  const result = await c.query(
    `SELECT r.product_id,coalesce(r.variant_id,'') AS variant_id,sum(r.quantity)::numeric AS quantity
       FROM myfin.customer_order_reservations r
       JOIN myfin.customer_order_requests o ON o.company_id=r.company_id AND o.id=r.order_id
      WHERE r.company_id=$1 AND r.product_id=ANY($2::text[])
        AND r.released_at IS NULL AND r.expires_at>now()
        AND o.status IN ('accepted','preparing','ready')
        AND ($3='' OR r.order_id<>$3)
      GROUP BY r.product_id,r.variant_id`,
    [companyId, productIds, excludedOrderId],
  );
  return new Map(result.rows.map(row => [keyFor(row.product_id, row.variant_id), Number(row.quantity)]));
}

// The caller has already locked product rows. Acceptance and checkout take the
// same locks in stable product-id order, so two tills cannot consume a reserved unit.
export async function assertUnreservedSaleStock(c, companyId, productRows, items, excludedOrderId = '') {
  const tracked = productRows.filter(row => row.data?.trackStock);
  if (!tracked.length) return;
  const reserved = await activeReservationQuantities(c, companyId, tracked.map(row => row.id), excludedOrderId);
  const requested = new Map();
  for (const item of items) {
    const product = tracked.find(row => row.id === item.productId);
    if (!product) continue;
    const variantId = item.variantId || '';
    const key = keyFor(item.productId, variantId);
    requested.set(key, (requested.get(key) || 0) + Number(item.qty));
  }
  for (const [key, quantity] of requested) {
    const [productId, variantId] = key.split('\u0000');
    const product = tracked.find(row => row.id === productId)?.data;
    const target = variantId ? product?.variants?.find(row => row.id === variantId) : product;
    if (!target || Number(target.stock || 0) - (reserved.get(key) || 0) < quantity)
      v.fail(409, 'stock_reserved_or_unavailable');
  }
}

export async function assertProductReservationFloor(c, companyId, product) {
  const reserved = await activeReservationQuantities(c, companyId, [product.id]);
  if (!reserved.size) return;
  if (!product.trackStock) v.fail(409, 'active_order_reservations');
  for (const [key, quantity] of reserved) {
    const [, variantId] = key.split('\u0000');
    if (!variantId && product.variants?.length) v.fail(409, 'active_order_reservations');
    const target = variantId ? product.variants?.find(row => row.id === variantId) : product;
    if (!target || Number(target.stock || 0) < quantity) v.fail(409, 'active_order_reservations');
  }
}

export async function releaseOrderReservations(c, companyId, orderId, reason) {
  await c.query(
    `UPDATE myfin.customer_order_reservations
        SET released_at=coalesce(released_at,now()),release_reason=coalesce(release_reason,$3)
      WHERE company_id=$1 AND order_id=$2 AND released_at IS NULL`,
    [companyId, orderId, reason],
  );
}
