import * as v from './validation.js';

const httpsUrl = value => {
  try { return new URL(value).protocol === 'https:'; }
  catch { return false; }
};

export function storefrontPrivacyComplete(value = {}) {
  const controllerName = String(value.privacy_controller_name ?? value.privacyControllerName ?? '').trim();
  const controllerContact = String(value.privacy_controller_contact ?? value.privacyControllerContact ?? '').trim();
  const noticeUrl = String(value.privacy_notice_url ?? value.privacyNoticeUrl ?? '').trim();
  const noticeEn = String(value.privacy_notice_en ?? value.privacyNoticeEn ?? '').trim();
  const noticeMs = String(value.privacy_notice_ms ?? value.privacyNoticeMs ?? '').trim();
  return Boolean(controllerName && controllerContact && noticeEn && noticeMs && httpsUrl(noticeUrl));
}

export function storefrontPrivacyOutput(value = {}) {
  return {
    controllerName: value.privacy_controller_name || '',
    controllerContact: value.privacy_controller_contact || '',
    noticeUrl: value.privacy_notice_url || '',
    noticeEn: value.privacy_notice_en || '',
    noticeMs: value.privacy_notice_ms || '',
    guestContactRetentionDays: Number(value.guest_data_retention_days ?? 90),
  };
}

export async function requirePublishedStorefrontPrivacy(c, companyId) {
  const row = (await c.query(
    `SELECT published,guest_data_retention_days,privacy_controller_name,privacy_controller_contact,
            privacy_notice_url,privacy_notice_en,privacy_notice_ms
       FROM myfin.storefront_settings WHERE company_id=$1 AND published`, [companyId],
  )).rows[0];
  if (!row || !storefrontPrivacyComplete(row)) v.fail(409, 'storefront_privacy_notice_unavailable');
  return row;
}

export async function redactExpiredOrderContacts(c, companyId, requestedLimit = 100) {
  const parsed = Number(requestedLimit);
  const limit = Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, 500)) : 100;
  const result = await c.query(
    `WITH candidates AS (
       SELECT o.company_id,o.id
         FROM myfin.customer_order_requests o
         JOIN myfin.storefront_settings s ON s.company_id=o.company_id
        WHERE o.company_id=$1 AND o.pii_redacted_at IS NULL
          AND o.status IN ('cancelled','expired','paid')
          AND o.updated_at < now()-make_interval(days=>s.guest_data_retention_days)
        ORDER BY o.updated_at,o.id
        LIMIT $2
        FOR UPDATE OF o SKIP LOCKED
     )
     UPDATE myfin.customer_order_requests o
        SET guest_name=CASE WHEN o.customer_id IS NULL THEN 'Guest' ELSE 'Customer' END,
            guest_email='',guest_phone='',notes='',pii_redacted_at=now()
       FROM candidates x
      WHERE o.company_id=x.company_id AND o.id=x.id
      RETURNING o.id`,
    [companyId, limit],
  );
  return result.rowCount ?? result.rows?.length ?? 0;
}
