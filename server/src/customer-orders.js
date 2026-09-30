import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonical, cents } from '../../src/domain/pos.js';
import { manager, owner, requireCapability } from './access.js';
import { assertUnreservedSaleStock, activeReservationQuantities, releaseOrderReservations } from './customer-order-reservations.js';
import { expireIfNeeded, orderLines, orderOutput } from './storefront-public.js';
import { redactExpiredOrderContacts } from './storefront-privacy.js';
import * as v from './validation.js';

const activeStatuses = ['awaiting_acceptance','accepted','preparing','ready'];
const statuses = [...activeStatuses, 'cancelled','expired','paid'];
const transitions = {
  awaiting_acceptance: ['accepted','cancelled','expired'],
  accepted: ['preparing','ready','cancelled','expired'],
  preparing: ['ready','cancelled','expired'],
  ready: ['cancelled','expired'], cancelled: [], expired: [], paid: [],
};
const transitionSchema = z.strictObject({
  requestId: z.uuid(), expectedVersion: z.number().int().positive(), status: z.enum(statuses),
  note: z.string().trim().max(1000).default(''), pickupAt: z.string().datetime().optional(),
});
const tenderSchema = z.strictObject({
  requestId: z.uuid(), expectedVersion: z.number().int().positive(), sale: v.sale,
});
const listSchema = z.strictObject({
  view: z.enum(['active','all','submitted',...statuses]).default('active'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const loyaltySchema = z.strictObject({
  enabled: z.boolean(), stampsRequired: z.number().int().min(2).max(1000),
  rewardLabel: z.string().trim().min(1).max(120), minimumSpend: z.number().min(0).max(1000000),
});
const hash = value => createHash('sha256').update(value).digest('hex');
const privileged = who => owner(who) || manager(who);
const apiStatus = status => status === 'awaiting_acceptance' ? 'submitted' : status;

async function expireCompany(c, companyId) {
  const rows = (await c.query(
    `SELECT * FROM myfin.customer_order_requests WHERE company_id=$1
      AND status=ANY($2::text[]) AND expires_at<=now()
      ORDER BY expires_at,id LIMIT 200 FOR UPDATE SKIP LOCKED`, [companyId, activeStatuses],
  )).rows;
  for (const row of rows) await expireIfNeeded(c, row);
}

async function findOrder(c, companyId, id, lock = false) {
  const result = await c.query(
    `SELECT o.*,l.name AS location_name,l.fulfillment_mode,l.table_label,l.pickup_instructions,
            p.sale_id,fo.status AS fulfillment_status
       FROM myfin.customer_order_requests o
       JOIN myfin.shop_locations l ON l.company_id=o.company_id AND l.id=o.location_id
       LEFT JOIN myfin.customer_order_payments p ON p.company_id=o.company_id AND p.order_id=o.id
       LEFT JOIN myfin.orders fo ON fo.company_id=p.company_id AND fo.id=p.sale_id
      WHERE o.company_id=$1 AND o.id=$2 ${lock ? 'FOR UPDATE OF o' : ''}`, [companyId, id],
  );
  if (!result.rowCount) v.fail(404, 'customer_order_not_found');
  return result.rows[0];
}

function staffOutput(row, lines) {
  const base = orderOutput(row, lines);
  return {
    ...base, customerId: row.customer_id || '',
    items: lines.map(line => ({ productId: line.product_id, variantId: line.variant_id || '',
      description: line.description, variant: line.variant_name || '', sku: line.sku || '', unit: line.unit,
      quantity: Number(line.quantity), unitPrice: Number(line.unit_price), lineTotal: Number(line.line_total) })),
    guestEmail: row.guest_email || '', guestPhone: row.guest_phone || '',
    location: { id: row.location_id, name: row.location_name, fulfillmentMode: row.fulfillment_mode,
      tableLabel: row.table_label || '', pickupInstructions: row.pickup_instructions || '' },
    saleId: row.sale_id || '',
    checkoutCart: {
      items: lines.map(line => ({ productId: line.product_id, variantId: line.variant_id || '',
        variant: line.variant_name || '', sku: line.sku || '', desc: line.description,
        price: Number(line.unit_price), unit: line.unit, qty: Number(line.quantity) })),
      customer: { id: '', name: row.guest_name || '', email: row.guest_email || '', phone: row.guest_phone || '' },
      totals: { subtotal: Number(row.subtotal), discountAmount: Number(row.discount_amount), tax: Number(row.tax),
        taxRate: Number(row.tax_rate), discount: 0, totalBeforeRounding: Number(row.total_before_rounding),
        rounding: Number(row.rounding), total: Number(row.total) },
    },
  };
}

async function eventRows(c, companyId, orderId) {
  return (await c.query(
    `SELECT e.*,i.display_name FROM myfin.customer_order_events e LEFT JOIN myfin.app_identities i ON i.id=e.staff_actor_id
      WHERE e.company_id=$1 AND e.order_id=$2 ORDER BY e.version`, [companyId, orderId],
  )).rows.map(row => ({ id: row.id, version: Number(row.version), action: row.action,
    fromStatus: apiStatus(row.from_status || ''), toStatus: apiStatus(row.to_status), note: row.note,
    actorType: row.actor_type, actorId: row.staff_actor_id || row.customer_actor_id || '',
    actorName: row.display_name || '', createdAt: row.created_at }));
}

async function reserve(c, companyId, order, lines) {
  const ids = [...new Set(lines.map(line => line.product_id))].sort();
  const products = await c.query(
    `SELECT * FROM myfin.products WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE`,
    [companyId, ids],
  );
  if (products.rowCount !== ids.length) v.fail(409, 'menu_item_unavailable');
  const reserved = await activeReservationQuantities(c, companyId, ids, order.id);
  for (const line of lines) {
    const product = products.rows.find(row => row.id === line.product_id)?.data;
    if (!product?.trackStock) continue;
    const variant = line.variant_id ? product.variants?.find(entry => entry.id === line.variant_id) : null;
    if (line.variant_id && !variant) v.fail(409, 'menu_item_unavailable');
    const target = variant || product, key = `${line.product_id}\u0000${line.variant_id || ''}`;
    if (Number(target.stock || 0) - (reserved.get(key) || 0) < Number(line.quantity))
      v.fail(409, 'stock_reserved_or_unavailable');
  }
  for (const line of lines) {
    const product = products.rows.find(row => row.id === line.product_id)?.data;
    if (!product?.trackStock) continue;
    await c.query(
      `INSERT INTO myfin.customer_order_reservations(company_id,order_id,line_no,product_id,variant_id,quantity,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(company_id,order_id,line_no) DO NOTHING`,
      [companyId, order.id, line.line_no, line.product_id, line.variant_id, line.quantity, order.expires_at],
    );
  }
}

function assertTenderMatches(order, lines, sale) {
  const expected = lines.map(line => ({ productId: line.product_id, variantId: line.variant_id || '',
    quantity: Number(line.quantity), price: Number(line.unit_price) }));
  const actual = sale.items.map(line => ({ productId: line.productId, variantId: line.variantId || '',
    quantity: Number(line.qty), price: Number(line.price) }));
  const fieldsMatch = sale.company_id === order.company_id && sale.storeSnapshot?.currency === order.currency &&
    sale.subtotal === Number(order.subtotal) &&
    sale.discountAmount === Number(order.discount_amount) && sale.discount === 0 &&
    sale.tax === Number(order.tax) && sale.taxRate === Number(order.tax_rate) &&
    sale.totalBeforeRounding === Number(order.total_before_rounding) && sale.rounding === Number(order.rounding) &&
    sale.total === Number(order.total);
  if (!fieldsMatch || JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected)))
    v.fail(409, 'customer_order_checkout_changed');
}

async function canonicalTenderSale(c, order, lines, sale) {
  let clientId = '';
  if (order.customer_id) clientId = (await c.query(
    `SELECT client_id FROM myfin.customer_company_links WHERE company_id=$1 AND customer_id=$2`,
    [order.company_id, order.customer_id],
  )).rows[0]?.client_id || '';
  return {
    ...sale,
    items: lines.map(line => ({ productId: line.product_id, variantId: line.variant_id || '',
      variant: line.variant_name || '', sku: line.sku || '', desc: line.description,
      price: Number(line.unit_price), unit: line.unit, qty: Number(line.quantity) })),
    client_id: clientId,
    customerName: order.customer_id ? (order.guest_name || 'Customer') : 'Walk-in customer',
    // Guest identity and pickup contact are operational order data, not consent
    // to copy them into the long-lived receipt/customer directory.
    customerEmail: '',
  };
}

async function earnLoyalty(c, order, saleId, actorId) {
  if (!order.customer_id) return;
  const company = (await c.query('SELECT workspace_id FROM myfin.companies WHERE id=$1', [order.company_id])).rows[0];
  const config = (await c.query(
    'SELECT * FROM myfin.workspace_loyalty_settings WHERE workspace_id=$1', [company.workspace_id],
  )).rows[0] || { enabled: true, stamps_per_order: 1, minimum_spend: 0 };
  if (!config.enabled || Number(order.total) < Number(config.minimum_spend)) return;
  const prior = await c.query(
    `SELECT 1 FROM myfin.customer_loyalty_events
      WHERE workspace_id=$1 AND company_id=$2 AND source_sale_id=$3 AND kind='earn' FOR SHARE`,
    [company.workspace_id, order.company_id, saleId],
  );
  if (prior.rowCount) return;
  await c.query(
    `INSERT INTO myfin.customer_loyalty_accounts(workspace_id,customer_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [company.workspace_id, order.customer_id],
  );
  const account = (await c.query(
    `SELECT stamp_balance FROM myfin.customer_loyalty_accounts
      WHERE workspace_id=$1 AND customer_id=$2 FOR UPDATE`, [company.workspace_id, order.customer_id],
  )).rows[0];
  const next = Number(account.stamp_balance) + 1;
  await c.query(
    `UPDATE myfin.customer_loyalty_accounts SET stamp_balance=$3,version=version+1,updated_at=now()
      WHERE workspace_id=$1 AND customer_id=$2`, [company.workspace_id, order.customer_id, next],
  );
  await c.query(
    `INSERT INTO myfin.customer_loyalty_events(workspace_id,id,customer_id,company_id,kind,stamps,balance_after,source_sale_id,reason,actor_id)
     VALUES($1,$2,$3,$4,'earn',1,$5,$6,'Eligible paid order',$7)`,
    [company.workspace_id, randomUUID(), order.customer_id, order.company_id, next, saleId, actorId],
  );
}

export function registerCustomerOrders(app, { scoped, audit, checkout }) {
  app.get('/api/companies/:company/customer-orders/summary', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'checkout');
    await expireCompany(c, companyId);
    await redactExpiredOrderContacts(c, companyId);
    const rows = (await c.query(
      `SELECT status,payment_state,count(*)::integer AS count FROM myfin.customer_order_requests
        WHERE company_id=$1 GROUP BY status,payment_state`, [companyId],
    )).rows;
    const byStatus = Object.fromEntries(statuses.map(status => [apiStatus(status), 0]));
    let unpaid = 0, paid = 0;
    for (const row of rows) { byStatus[apiStatus(row.status)] = Number(row.count); row.payment_state === 'paid' ? paid += Number(row.count) : unpaid += Number(row.count); }
    return { counts: { ...byStatus, active: activeStatuses.reduce((sum, status) => sum + byStatus[apiStatus(status)], 0), unpaid, paid } };
  }));

  app.get('/api/companies/:company/customer-orders', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'checkout');
    const query = v.parse(listSchema, req.query);
    await expireCompany(c, companyId);
    await redactExpiredOrderContacts(c, companyId);
    const view = query.view === 'submitted' ? 'awaiting_acceptance' : query.view;
    const result = await c.query(
      `SELECT o.*,l.name AS location_name,l.fulfillment_mode,l.table_label,l.pickup_instructions,
              p.sale_id,fo.status AS fulfillment_status
         FROM myfin.customer_order_requests o
         JOIN myfin.shop_locations l ON l.company_id=o.company_id AND l.id=o.location_id
         LEFT JOIN myfin.customer_order_payments p ON p.company_id=o.company_id AND p.order_id=o.id
         LEFT JOIN myfin.orders fo ON fo.company_id=p.company_id AND fo.id=p.sale_id
        WHERE o.company_id=$1 AND ($2='all' OR ($2='active' AND o.status=ANY($3::text[])) OR o.status=$2)
        ORDER BY o.created_at DESC,o.id DESC LIMIT $4`, [companyId, view, activeStatuses, query.limit],
    );
    const rows = [];
    for (const row of result.rows) rows.push(staffOutput(row, await orderLines(c, companyId, row.id)));
    const grouped = (await c.query(
      `SELECT status,count(*)::integer AS count FROM myfin.customer_order_requests WHERE company_id=$1 GROUP BY status`,
      [companyId],
    )).rows;
    const counts = Object.fromEntries(statuses.map(status => [apiStatus(status), 0]));
    for (const item of grouped) counts[apiStatus(item.status)] = Number(item.count);
    counts.active = activeStatuses.reduce((sum, status) => sum + counts[apiStatus(status)], 0);
    return { rows, counts, next: null };
  }));

  app.get('/api/companies/:company/customer-orders/:id', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'checkout');
    const id = v.parse(v.id, req.params.id);
    await redactExpiredOrderContacts(c, companyId);
    let row = await findOrder(c, companyId, id, true);
    const routed = row;
    row = { ...await expireIfNeeded(c, row), location_name: routed.location_name,
      fulfillment_mode: routed.fulfillment_mode, table_label: routed.table_label,
      pickup_instructions: routed.pickup_instructions, sale_id: routed.sale_id,
      fulfillment_status: routed.fulfillment_status };
    const lines = await orderLines(c, companyId, id);
    return { order: staffOutput(row, lines), events: await eventRows(c, companyId, id) };
  }));

  app.post('/api/companies/:company/customer-orders/:id/transitions', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'checkout');
    const id = v.parse(v.id, req.params.id), change = v.parse(transitionSchema, req.body);
    if (['cancelled','expired'].includes(change.status) && !privileged(req.identity)) v.fail(403, 'manager_required');
    const requestDigest = hash(JSON.stringify(canonical({ orderId: id, actorId: req.identity.id, ...change })));
    const replay = (await c.query(
      'SELECT request_digest FROM myfin.customer_order_events WHERE company_id=$1 AND request_id=$2',
      [companyId, change.requestId],
    )).rows[0];
    if (replay) {
      if (replay.request_digest !== requestDigest) v.fail(409, 'request_id_reused');
      const current = await findOrder(c, companyId, id);
      return { order: staffOutput(current, await orderLines(c, companyId, id)), events: await eventRows(c, companyId, id) };
    }
    let row = await findOrder(c, companyId, id, true);
    row = await expireIfNeeded(c, row);
    if (row.version !== change.expectedVersion) v.fail(409, 'customer_order_changed');
    if (!transitions[row.status]?.includes(change.status)) v.fail(409, 'invalid_customer_order_transition');
    if (change.pickupAt) {
      const pickup = new Date(change.pickupAt);
      if (pickup <= new Date() || pickup > new Date(Date.now() + 7 * 86400000)) v.fail(400, 'invalid_pickup_time');
    }
    const lines = await orderLines(c, companyId, id);
    const nextVersion = Number(row.version) + 1;
    const expiresAt = change.pickupAt ? new Date(new Date(change.pickupAt).getTime() + 30 * 60000)
      : change.status === 'accepted' ? new Date(Math.max(new Date(row.expires_at).getTime(), Date.now() + 60 * 60000))
      : row.expires_at;
    if (change.status === 'accepted') {
      row.expires_at = expiresAt;
      await reserve(c, companyId, row, lines);
    }
    if (['cancelled','expired'].includes(change.status)) await releaseOrderReservations(c, companyId, id, change.status);
    const updated = (await c.query(
      `UPDATE myfin.customer_order_requests SET status=$3,version=$4,updated_at=now(),
         accepted_at=CASE WHEN $3='accepted' THEN now() ELSE accepted_at END,
         pickup_at=coalesce($5,pickup_at),expires_at=$6
       WHERE company_id=$1 AND id=$2 AND version=$7 RETURNING *`,
      [companyId, id, change.status, nextVersion, change.pickupAt || null, expiresAt, row.version],
    )).rows[0];
    if (!updated) v.fail(409, 'customer_order_changed');
    await c.query(
      `INSERT INTO myfin.customer_order_events(company_id,id,order_id,version,actor_type,staff_actor_id,request_id,request_digest,action,from_status,to_status,note)
       VALUES($1,$2,$3,$4,'staff',$5,$6,$7,'status_changed',$8,$9,$10)`,
      [companyId, randomUUID(), id, nextVersion, req.identity.id, change.requestId, requestDigest, row.status, change.status, change.note],
    );
    await audit(c, req.identity, companyId, 'Customer order status', `${row.public_code} · ${row.status} → ${change.status}`);
    return { order: staffOutput({ ...updated, location_name: row.location_name, fulfillment_mode: row.fulfillment_mode,
      table_label: row.table_label, pickup_instructions: row.pickup_instructions }, lines), events: await eventRows(c, companyId, id) };
  }));

  app.post('/api/companies/:company/customer-orders/:id/tender', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'checkout');
    const id = v.parse(v.id, req.params.id), input = v.parse(tenderSchema, req.body);
    const requestDigest = hash(JSON.stringify(canonical({ orderId: id, actorId: req.identity.id,
      expectedVersion: input.expectedVersion, sale: input.sale })));
    const replay = (await c.query(
      `SELECT p.request_digest,p.sale_id FROM myfin.customer_order_payments p
        WHERE p.company_id=$1 AND p.request_id=$2`, [companyId, input.requestId],
    )).rows[0];
    if (replay) {
      if (replay.request_digest !== requestDigest) v.fail(409, 'request_id_reused');
      const current = await findOrder(c, companyId, id);
      if (current.sale_id !== replay.sale_id) v.fail(409, 'request_id_reused');
      return { order: staffOutput(current, await orderLines(c, companyId, id)), saleId: replay.sale_id };
    }
    const order = await findOrder(c, companyId, id, true);
    if (order.version !== input.expectedVersion) v.fail(409, 'customer_order_changed');
    if (!['accepted','preparing','ready'].includes(order.status) || order.payment_state !== 'unpaid')
      v.fail(409, 'customer_order_not_tenderable');
    if (new Date(order.expires_at) <= new Date()) v.fail(409, 'customer_order_expired');
    const lines = await orderLines(c, companyId, id);
    assertTenderMatches(order, lines, input.sale);
    const acceptedSale = await canonicalTenderSale(c, order, lines, input.sale);
    const sale = await checkout(c, req.identity, companyId, acceptedSale, null, { reservationOrderId: id });
    await c.query(
      `INSERT INTO myfin.customer_order_payments(company_id,order_id,sale_id,actor_id,request_id,request_digest)
       VALUES($1,$2,$3,$4,$5,$6)`, [companyId, id, input.sale.id, req.identity.id, input.requestId, requestDigest],
    );
    const nextVersion = Number(order.version) + 1;
    const updated = (await c.query(
      `UPDATE myfin.customer_order_requests SET status='paid',payment_state='paid',version=$3,updated_at=now()
        WHERE company_id=$1 AND id=$2 AND version=$4 RETURNING *`, [companyId, id, nextVersion, order.version],
    )).rows[0];
    if (!updated) v.fail(409, 'customer_order_changed');
    await releaseOrderReservations(c, companyId, id, 'paid');
    await c.query(
      `INSERT INTO myfin.customer_order_events(company_id,id,order_id,version,actor_type,staff_actor_id,request_id,request_digest,action,from_status,to_status,note)
       VALUES($1,$2,$3,$4,'staff',$5,$6,$7,'paid',$8,'paid','Paid at counter')`,
      [companyId, randomUUID(), id, nextVersion, req.identity.id, input.requestId, requestDigest, order.status],
    );
    const carryStatus = order.status === 'preparing' ? 'preparing' : order.status === 'ready' ? 'ready' : 'pending';
    if (carryStatus !== 'pending') {
      const fulfillment = (await c.query(
        `UPDATE myfin.orders SET status=$3,version=version+1,updated_at=now()
          WHERE company_id=$1 AND id=$2 AND status='pending' RETURNING version`,
        [companyId, input.sale.id, carryStatus],
      )).rows[0];
      if (fulfillment) await c.query(
        `INSERT INTO myfin.order_events(company_id,id,order_id,version,actor_id,request_id,request_digest,action,from_status,to_status,note)
         VALUES($1,$2,$3,$4,$5,$6,$7,'status_changed','pending',$8,'Carried from unpaid customer order')`,
        [companyId, randomUUID(), input.sale.id, fulfillment.version, req.identity.id,
          `customer:${input.requestId}`, hash(`customer:${requestDigest}`), carryStatus],
      );
    }
    await earnLoyalty(c, order, input.sale.id, req.identity.id);
    await audit(c, req.identity, companyId, 'Customer order paid', `${order.public_code} · ${input.sale.number}`);
    return { order: staffOutput({ ...updated, location_name: order.location_name, fulfillment_mode: order.fulfillment_mode,
      table_label: order.table_label, pickup_instructions: order.pickup_instructions,
      sale_id: input.sale.id, fulfillment_status: carryStatus }, lines), sale, saleId: input.sale.id };
  }));

  app.get('/api/companies/:company/loyalty', req => scoped(req, async (c, companyId) => {
    if (!privileged(req.identity)) v.fail(403, 'access_denied');
    const company = (await c.query('SELECT workspace_id FROM myfin.companies WHERE id=$1', [companyId])).rows[0];
    const row = (await c.query(
      'SELECT * FROM myfin.workspace_loyalty_settings WHERE workspace_id=$1', [company.workspace_id],
    )).rows[0];
    return { workspaceId: company.workspace_id, enabled: row?.enabled ?? true,
      stampsRequired: Number(row?.stamps_required ?? 10), rewardLabel: row?.reward_label || 'Reward',
      minimumSpend: Number(row?.minimum_spend ?? 0), earnRule: 'one_stamp_per_eligible_paid_order' };
  }));

  app.put('/api/companies/:company/loyalty', req => scoped(req, async (c, companyId) => {
    if (!owner(req.identity)) v.fail(403, 'workspace_owner_required');
    const input = v.parse(loyaltySchema, req.body);
    const company = (await c.query('SELECT workspace_id FROM myfin.companies WHERE id=$1', [companyId])).rows[0];
    await c.query(
      `INSERT INTO myfin.workspace_loyalty_settings(workspace_id,enabled,stamps_required,reward_label,minimum_spend,updated_by)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id) DO UPDATE SET enabled=EXCLUDED.enabled,
       stamps_required=EXCLUDED.stamps_required,reward_label=EXCLUDED.reward_label,
       minimum_spend=EXCLUDED.minimum_spend,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [company.workspace_id, input.enabled, input.stampsRequired, input.rewardLabel, input.minimumSpend, req.identity.id],
    );
    await audit(c, req.identity, companyId, 'Loyalty settings', input.enabled ? 'Enabled' : 'Disabled');
    return { workspaceId: company.workspace_id, ...input, earnRule: 'one_stamp_per_eligible_paid_order' };
  }));

  app.get('/api/companies/:company/loyalty/events', req => scoped(req, async (c, companyId) => {
    if (!privileged(req.identity)) v.fail(403, 'access_denied');
    const query = v.parse(z.strictObject({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const company = (await c.query('SELECT workspace_id FROM myfin.companies WHERE id=$1', [companyId])).rows[0];
    const result = await c.query(
      `SELECT e.*,a.display_name,a.primary_email FROM myfin.customer_loyalty_events e
       JOIN myfin.customer_accounts a ON a.id=e.customer_id
       WHERE e.workspace_id=$1 AND ($2 OR e.company_id=$3)
       ORDER BY e.created_at DESC,e.id DESC LIMIT $4`,
      [company.workspace_id, owner(req.identity), companyId, query.limit],
    );
    return { rows: result.rows.map(row => ({ id: row.id, customerId: row.customer_id,
      customerName: row.display_name || 'Customer', customerEmail: row.primary_email || '', companyId: row.company_id,
      kind: row.kind, stamps: Number(row.stamps), balanceAfter: Number(row.balance_after), saleId: row.source_sale_id || '',
      reason: row.reason, createdAt: row.created_at })) };
  }));
}

export { assertTenderMatches, canonicalTenderSale, assertUnreservedSaleStock };
