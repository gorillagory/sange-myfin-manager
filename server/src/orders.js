import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as v from './validation.js';
import { manager, owner, requireCapability } from './access.js';

const statuses = ['pending', 'preparing', 'ready', 'completed'];
const nextStatuses = {
  pending: ['preparing', 'ready', 'completed'],
  preparing: ['ready', 'completed'],
  ready: ['completed'],
  completed: [],
};
const querySchema = z.strictObject({
  view: z.enum(['active', 'completed', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.string().min(1).max(512).optional(),
});
const transitionSchema = z.strictObject({
  requestId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  status: z.enum(statuses),
  note: z.string().trim().max(1000).default(''),
});

const line = item => ({
  productId: item.productId || '', variantId: item.variantId || '',
  description: item.desc || '', variant: item.variant || '',
  quantity: Number(item.qty || 0), unit: item.unit || '', sku: item.sku || '',
});
function displayName(row) {
  const name = row.customer_display || row.customer_name || 'Walk-in customer';
  const trimmed = name.trim();
  const email = row.sale_data?.customerEmail?.trim().toLowerCase();
  return (email && trimmed.toLowerCase() === email) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
    ? 'Customer' : name;
}
const output = row => ({
  id: row.id, saleId: row.id, companyId: row.company_id,
  number: row.sale_data?.number || '', status: row.status,
  version: Number(row.version), legacy: row.legacy,
  clientId: row.client_id || '',
  customerName: displayName(row),
  items: (row.sale_data?.items || []).map(line),
  saleDate: row.sale_data?.date || null,
  createdAt: row.created_at, updatedAt: row.updated_at,
  completedAt: row.completed_at,
});
const eventOutput = row => ({
  id: row.id, version: Number(row.version), action: row.action, fromStatus: row.from_status,
  toStatus: row.to_status, note: row.note,
  actorId: row.actor_id, actorName: row.display_name || 'Team member',
  createdAt: row.created_at,
});
const countsFrom = rows => {
  const counts = Object.fromEntries(statuses.map(status => [status, 0]));
  for (const row of rows) counts[row.status] = Number(row.count);
  return { ...counts, active: counts.pending + counts.preparing + counts.ready };
};
const privileged = who => owner(who) || manager(who);
function encodeCursor(row) {
  return Buffer.from(JSON.stringify([new Date(row.created_at).toISOString(), row.id])).toString('base64url');
}
function decodeCursor(value) {
  if (!value) return [null, null];
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== 2 ||
        !Number.isFinite(Date.parse(decoded[0])) ||
        new Date(decoded[0]).toISOString() !== decoded[0]) throw Error('invalid');
    return [decoded[0], v.parse(v.id, decoded[1])];
  } catch { v.fail(400, 'invalid_order_cursor'); }
}
async function counts(c, companyId, who) {
  const result = await c.query(
    `SELECT o.status,count(*)::integer AS count FROM myfin.orders o
     JOIN myfin.transactions t ON t.company_id=o.company_id AND t.id=o.id
     WHERE o.company_id=$1 AND ($2 OR o.status<>'completed' OR t.actor_id=$3)
     GROUP BY o.status`, [companyId, privileged(who), who.id],
  );
  return countsFrom(result.rows);
}
async function order(c, companyId, id, who, lock = false) {
  const result = await c.query(`SELECT o.*,t.data AS sale_data,t.actor_id AS sale_actor_id,
    coalesce(nullif(o.customer_name,''),cl.data->>'name','Walk-in customer') AS customer_display
    FROM myfin.orders o JOIN myfin.transactions t ON t.company_id=o.company_id AND t.id=o.id
    LEFT JOIN myfin.clients cl ON cl.company_id=o.company_id AND cl.id=o.client_id
    WHERE o.company_id=$1 AND o.id=$2 AND ($3 OR o.status<>'completed' OR t.actor_id=$4)
    ${lock ? 'FOR UPDATE OF o' : ''}`, [companyId, id, who ? privileged(who) : true, who?.id || '']);
  if (!result.rowCount) v.fail(404, 'order_not_found');
  return result.rows[0];
}
async function events(c, companyId, id) {
  const result = await c.query(`SELECT e.*,i.display_name FROM myfin.order_events e
    JOIN myfin.app_identities i ON i.id=e.actor_id
    WHERE e.company_id=$1 AND e.order_id=$2 ORDER BY e.version`, [companyId, id]);
  return result.rows.map(eventOutput);
}

// The transaction INSERT trigger creates the order in that same commit, including
// when an older API process is still serving during a rolling deployment.
export async function assertOrderCreated(c, companyId, saleId) {
  const found = await c.query('SELECT id FROM myfin.orders WHERE company_id=$1 AND id=$2', [companyId, saleId]);
  if (found.rowCount !== 1) v.fail(500, 'order_creation_failed');
}

export function registerOrders(app, { scoped, audit }) {
  app.get('/api/companies/:company/orders/summary', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'checkout');
    return { counts: await counts(c, companyId, req.identity) };
  }));
  app.get('/api/companies/:company/orders', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'checkout');
    const { view, limit, before } = v.parse(querySchema, req.query);
    const [beforeDate, beforeId] = decodeCursor(before);
    const result = await c.query(`SELECT o.*,t.data AS sale_data,
      coalesce(nullif(o.customer_name,''),cl.data->>'name','Walk-in customer') AS customer_display
      FROM myfin.orders o JOIN myfin.transactions t ON t.company_id=o.company_id AND t.id=o.id
      LEFT JOIN myfin.clients cl ON cl.company_id=o.company_id AND cl.id=o.client_id
      WHERE o.company_id=$1 AND ($2='all' OR ($2='active' AND o.status<>'completed') OR o.status=$2)
        AND ($3 OR o.status<>'completed' OR t.actor_id=$4)
        AND ($5::timestamptz IS NULL OR (o.created_at,o.id)<($5::timestamptz,$6))
      ORDER BY o.created_at DESC,o.id DESC LIMIT $7`,
    [companyId, view, privileged(req.identity), req.identity.id, beforeDate, beforeId, limit + 1]);
    const visible = result.rows.slice(0, limit);
    return {
      rows: visible.map(output),
      counts: await counts(c, companyId, req.identity),
      next: result.rowCount > limit ? encodeCursor(visible.at(-1)) : null,
    };
  }));
  app.get('/api/companies/:company/orders/:id', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'checkout');
    const id = v.parse(v.id, req.params.id);
    return { order: output(await order(c, companyId, id, req.identity)), events: await events(c, companyId, id) };
  }));
  app.post('/api/companies/:company/orders/:id/transitions', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'checkout');
    const id = v.parse(v.id, req.params.id);
    const change = v.parse(transitionSchema, req.body);
    const digest = createHash('sha256').update(JSON.stringify({
      orderId: id, actorId: req.identity.id, expectedVersion: change.expectedVersion,
      status: change.status, note: change.note,
    })).digest('hex');
    const current = await order(c, companyId, id, null, true);
    const previous = await c.query('SELECT * FROM myfin.order_events WHERE company_id=$1 AND request_id=$2',
      [companyId, change.requestId]);
    if (!privileged(req.identity) && current.status === 'completed' &&
        current.sale_actor_id !== req.identity.id &&
        !(previous.rowCount && previous.rows[0].order_id === id &&
          previous.rows[0].actor_id === req.identity.id &&
          previous.rows[0].to_status === 'completed' &&
          Number(previous.rows[0].version) === Number(current.version)))
      v.fail(404, 'order_not_found');
    if (previous.rowCount) {
      if (previous.rows[0].order_id !== id || previous.rows[0].actor_id !== req.identity.id ||
          previous.rows[0].request_digest !== digest) v.fail(409, 'order_request_id_reused');
      return { order: output(current), events: await events(c, companyId, id) };
    }
    if (Number(current.version) !== change.expectedVersion) v.fail(409, 'order_changed');
    const reopening = current.status === 'completed' && change.status === 'pending';
    if (reopening) {
      if (!(owner(req.identity) || manager(req.identity))) v.fail(403, 'manager_required');
      if (change.note.length < 3) v.fail(400, 'order_reopen_reason_required');
    } else if (!nextStatuses[current.status]?.includes(change.status)) v.fail(409, 'invalid_order_transition');
    const changed = await c.query(`UPDATE myfin.orders SET status=$3,version=version+1,updated_at=now(),
      completed_at=CASE WHEN $3='completed' THEN now() ELSE NULL END
      WHERE company_id=$1 AND id=$2 RETURNING status,version,updated_at,completed_at`, [companyId, id, change.status]);
    await c.query(`INSERT INTO myfin.order_events(company_id,id,order_id,version,actor_id,request_id,
      request_digest,action,from_status,to_status,note)
      VALUES($1,$2,$3,$4,$5,$6,$7,'status_changed',$8,$9,$10)`,
    [companyId, randomUUID(), id, change.expectedVersion + 1, req.identity.id, change.requestId, digest,
      current.status, change.status, change.note]);
    await audit(c, req.identity, companyId, 'Order status',
      `${current.sale_data?.number || id} · ${current.status} → ${change.status}`);
    return { order: output({ ...current, ...changed.rows[0] }), events: await events(c, companyId, id) };
  }));
}
