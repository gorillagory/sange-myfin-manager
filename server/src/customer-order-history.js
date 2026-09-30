import { z } from 'zod';
import { customerSession } from './customer-auth.js';
import { expireIfNeeded, orderOutput, storefrontRateKey } from './storefront-public.js';
import { redactExpiredOrderContacts } from './storefront-privacy.js';
import * as v from './validation.js';

const querySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const apiStatus = status => status === 'awaiting_acceptance' ? 'submitted' : status;

function publicContext(req) {
  if (req.tenant?.surface !== 'storefront') v.fail(404, 'not_found');
  return req.tenant;
}

export function registerCustomerOrderHistory(app, { db, authOptions }) {
  app.get('/api/public/customer/orders', { config: { rateLimit: {
    max: 120, timeWindow: 60000, keyGenerator: req => storefrontRateKey(req, authOptions),
  } } }, async req => {
    const context = publicContext(req), query = v.parse(querySchema, req.query);
    return db.transaction(async c => {
      const session = await customerSession(c, req);
      if (!session) v.fail(401, 'customer_session_required');
      await redactExpiredOrderContacts(c, context.company_id);
      const result = await c.query(
        `SELECT o.*,fo.status AS fulfillment_status,l.name AS location_name,l.fulfillment_mode,
                l.table_label,l.pickup_instructions
           FROM myfin.customer_order_requests o
           JOIN myfin.shop_locations l ON l.company_id=o.company_id AND l.id=o.location_id
           LEFT JOIN myfin.customer_order_payments op ON op.company_id=o.company_id AND op.order_id=o.id
           LEFT JOIN myfin.orders fo ON fo.company_id=op.company_id AND fo.id=op.sale_id
          WHERE o.company_id=$1 AND o.customer_id=$2
          ORDER BY o.created_at DESC,o.id DESC LIMIT $3`,
        [context.company_id, session.customerId, query.limit],
      );
      const routedRows = [];
      for (const routed of result.rows) routedRows.push({ ...await expireIfNeeded(c, routed),
        fulfillment_status: routed.fulfillment_status, location_name: routed.location_name,
        fulfillment_mode: routed.fulfillment_mode, table_label: routed.table_label,
        pickup_instructions: routed.pickup_instructions });
      const ids = routedRows.map(row => row.id);
      const lines = ids.length ? (await c.query(
        `SELECT * FROM myfin.customer_order_lines
          WHERE company_id=$1 AND order_id=ANY($2::text[]) ORDER BY order_id,line_no`,
        [context.company_id, ids],
      )).rows : [];
      const events = ids.length ? (await c.query(
        `SELECT order_id,version,to_status,created_at FROM myfin.customer_order_events
          WHERE company_id=$1 AND order_id=ANY($2::text[]) ORDER BY order_id,version`,
        [context.company_id, ids],
      )).rows : [];
      return { rows: routedRows.map(row => {
        const { customerId: _customerId, guestName: _guestName, ...safeOrder } = orderOutput(
          row, lines.filter(line => line.order_id === row.id),
        );
        return { ...safeOrder, events: events.filter(event => event.order_id === row.id).map(event => ({
          version: Number(event.version), status: apiStatus(event.to_status), createdAt: event.created_at,
        })) };
      }) };
    });
  });
}
