import { z } from 'zod';
import { manager, owner } from './access.js';
import * as v from './validation.js';

const querySchema = z.strictObject({
  q: z.string().trim().max(120).default(''),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: v.id.optional(),
});

const allowed = who => owner(who) || manager(who);
const literalLike = value => value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

function profileOutput(row) {
  return {
    customerId: row.id,
    displayName: row.profile_name || row.account_name || 'Customer',
    phone: row.profile_phone || '',
    email: row.primary_email || '',
    emailVerified: !!row.email_verified,
    active: !row.disabled_at,
    orderCount: Number(row.order_count),
    paidOrderCount: Number(row.paid_order_count),
    paidSpend: Number(row.paid_spend || 0),
    firstOrderAt: row.first_order_at,
    lastOrderAt: row.last_order_at,
    loyaltyBalance: Number(row.stamp_balance || 0),
    marketingConsent: Object.fromEntries(['email','sms','whatsapp'].map(channel => {
      const consent = row.consents?.[channel];
      return [channel, consent ? { granted: !!consent.granted, noticeVersion: consent.noticeVersion,
        source: consent.source, updatedAt: consent.updatedAt } : null];
    })),
  };
}

export function registerCustomerProfiles(app, { scoped }) {
  app.get('/api/companies/:company/customer-profiles', req => scoped(req, async (c, companyId) => {
    if (!allowed(req.identity)) v.fail(403, 'access_denied');
    const query = v.parse(querySchema, req.query);
    const company = (await c.query(
      'SELECT workspace_id FROM myfin.companies WHERE id=$1', [companyId],
    )).rows[0];
    if (!company) v.fail(404, 'not_found');
    const search = query.q ? `%${literalLike(query.q.toLowerCase())}%` : '';
    const result = await c.query(
      `WITH order_stats AS (
         SELECT customer_id,count(*)::integer AS order_count,
                count(*) FILTER(WHERE payment_state='paid')::integer AS paid_order_count,
                coalesce(sum(total) FILTER(WHERE payment_state='paid'),0)::numeric AS paid_spend,
                min(created_at) AS first_order_at,max(created_at) AS last_order_at
           FROM myfin.customer_order_requests
          WHERE company_id=$1 AND customer_id IS NOT NULL GROUP BY customer_id
       ), latest_consents AS (
         SELECT DISTINCT ON(customer_id,channel) customer_id,channel,granted,notice_version,source,created_at
           FROM myfin.customer_consent_events
          WHERE workspace_id=$2 AND purpose='marketing'
          ORDER BY customer_id,channel,created_at DESC,id DESC
       ), consent_map AS (
         SELECT customer_id,jsonb_object_agg(channel,jsonb_build_object(
           'granted',granted,'noticeVersion',notice_version,'source',source,'updatedAt',created_at)) AS consents
           FROM latest_consents GROUP BY customer_id
       )
       SELECT a.id,a.display_name AS account_name,a.primary_email,a.email_verified_at IS NOT NULL AS email_verified,
              a.disabled_at,p.display_name AS profile_name,p.phone AS profile_phone,
              s.order_count,s.paid_order_count,s.paid_spend,s.first_order_at,s.last_order_at,
              coalesce(l.stamp_balance,0) AS stamp_balance,coalesce(cm.consents,'{}'::jsonb) AS consents
         FROM order_stats s JOIN myfin.customer_accounts a ON a.id=s.customer_id
         LEFT JOIN myfin.customer_workspace_profiles p ON p.workspace_id=$2 AND p.customer_id=a.id
         LEFT JOIN myfin.customer_loyalty_accounts l ON l.workspace_id=$2 AND l.customer_id=a.id
         LEFT JOIN consent_map cm ON cm.customer_id=a.id
        WHERE ($3='' OR lower(coalesce(p.display_name,'')) LIKE $3 ESCAPE '\\'
                       OR lower(coalesce(a.display_name,'')) LIKE $3 ESCAPE '\\'
                       OR lower(coalesce(a.primary_email,'')) LIKE $3 ESCAPE '\\'
                       OR lower(coalesce(p.phone,'')) LIKE $3 ESCAPE '\\')
          AND ($4='' OR a.id>$4)
        ORDER BY a.id LIMIT $5`,
      [companyId, company.workspace_id, search, query.after || '', query.limit + 1],
    );
    const visible = result.rows.slice(0, query.limit);
    const loyalty = (await c.query(
      `SELECT enabled,stamps_required,reward_label,minimum_spend
         FROM myfin.workspace_loyalty_settings WHERE workspace_id=$1`, [company.workspace_id],
    )).rows[0];
    return {
      workspaceId: company.workspace_id,
      loyaltySettings: { enabled: loyalty?.enabled ?? true, stampsRequired: Number(loyalty?.stamps_required ?? 10),
        rewardLabel: loyalty?.reward_label || 'Reward', minimumSpend: Number(loyalty?.minimum_spend ?? 0),
        earnRule: 'one_stamp_per_eligible_paid_order' },
      rows: visible.map(profileOutput),
      next: result.rowCount > query.limit ? visible.at(-1).id : null,
    };
  }));
}

export { literalLike, profileOutput };
