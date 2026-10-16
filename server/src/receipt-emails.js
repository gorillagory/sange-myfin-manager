import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as v from './validation.js';
import { manager, owner, recordVisible, requireCapability } from './access.js';
import { receiptLines } from '../../src/domain/receipt.js';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  .transform(value => value.toLowerCase());
const enqueueInput = z.strictObject({
  recipient:z.email().max(254).transform(value => value.trim().toLowerCase()),
  idempotencyKey:uuid,
  sendAgain:z.boolean().default(false),
});
const retryInput = z.strictObject({ idempotencyKey:uuid });

export function receiptEmailFeatureEnabled(env = process.env) {
  return String(env.RECEIPT_EMAIL_ENABLED || 'false').toLowerCase() === 'true';
}

function escapeHtml(value) {
  return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;')
    .replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
}

export function renderReceiptEmail(sale) {
  const lines = receiptLines(sale).map(line=>String(line).replaceAll('\0','')),
    safeHeader=value=>String(value).replace(/[\r\n\0]+/g,' ').trim(),
    number = safeHeader(sale.number || sale.id || 'Receipt').slice(0, 120),
    store = safeHeader(sale.companySnapshot?.name || sale.storeSnapshot?.name || 'MyFin').slice(0, 120),
    subject = `Receipt ${number} — ${store}`;
  return {
    subject,
    textBody:`${lines.join('\r\n')}\r\n\r\nThis transactional receipt was requested at checkout. It does not subscribe you to marketing.`,
    htmlBody:`<!doctype html><html><body style="margin:0;background:#f5f7f5;color:#16231f;font-family:Arial,sans-serif"><main style="max-width:640px;margin:0 auto;padding:28px"><section style="background:#fff;border:1px solid #dfe5e1;border-radius:12px;padding:24px"><h1 style="font-size:20px;margin:0 0 18px">${escapeHtml(subject)}</h1><pre style="white-space:pre-wrap;font:14px/1.55 Arial,sans-serif;margin:0">${escapeHtml(lines.join('\n'))}</pre><p style="color:#60706a;font-size:12px;margin:24px 0 0">This transactional receipt was requested at checkout. It does not subscribe you to marketing.</p></section></main></body></html>`,
  };
}

function output(row) {
  return {
    id:row.id,idempotencyKey:row.idempotency_key,transactionId:row.transaction_id,recipient:row.recipient,state:row.state,
    attemptCount:Number(row.attempt_count),maxAttempts:Number(row.max_attempts),
    nextAttemptAt:row.next_attempt_at,acceptedAt:row.accepted_at,createdAt:row.created_at,
    updatedAt:row.updated_at,errorCode:row.last_error_code || '',
  };
}

async function transaction(c, companyId, transactionId, who) {
  const result = await c.query(
    `SELECT company_id,id,actor_id,source,total,data,document_state,assigned_to
       FROM myfin.transactions WHERE company_id=$1 AND id=$2 FOR SHARE`,
    [companyId,v.parse(v.id,transactionId)],
  );
  const row = result.rows[0];
  if (!row || !['pos','manual_sale'].includes(row.source) || !recordVisible(row,who))
    v.fail(404,'not_found');
  if (!['Paid','Cleared'].includes(row.data?.status) && row.data?.paymentStatus !== 'Paid')
    v.fail(409,'paid_receipt_required');
  return row;
}

async function insertDelivery(c, { companyId, transactionId, recipient, idempotencyKey, actorId, message, requiredPrior = null }) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,41))',
    [`${companyId}:receipt-email:${transactionId}`]);
  const replay = (await c.query(
    `SELECT * FROM myfin.receipt_email_deliveries
      WHERE company_id=$1 AND idempotency_key=$2`, [companyId,idempotencyKey],
  )).rows[0];
  if (replay) {
    if (replay.transaction_id !== transactionId || replay.recipient !== recipient ||
        replay.subject !== message.subject || replay.text_body !== message.textBody ||
        replay.html_body !== message.htmlBody) v.fail(409,'receipt_email_payload_changed');
    return replay;
  }
  const prior = (await c.query(
    `SELECT * FROM myfin.receipt_email_deliveries
      WHERE company_id=$1 AND transaction_id=$2 AND recipient=$3
      ORDER BY created_at DESC,id DESC LIMIT 1`, [companyId,transactionId,recipient],
  )).rows[0];
  if (requiredPrior) {
    const expectedStates=requiredPrior.states||[];
    if (!prior || (requiredPrior.id&&prior.id!==requiredPrior.id) || !expectedStates.includes(prior.state))
      v.fail(409,'receipt_email_resend_not_allowed');
  } else if (prior) {
    // A normal staff request can create only the first delivery for one receipt
    // and address. Later copies use the explicit manager-only paths below.
    v.fail(409,'receipt_email_already_requested');
  }
  const count = Number((await c.query(
    `SELECT count(*)::integer AS count FROM myfin.receipt_email_deliveries
      WHERE company_id=$1 AND transaction_id=$2`, [companyId,transactionId],
  )).rows[0]?.count || 0);
  if (count >= 10) v.fail(409,'receipt_email_limit_reached');
  const id = randomUUID();
  const inserted = await c.query(
    `INSERT INTO myfin.receipt_email_deliveries(company_id,id,transaction_id,idempotency_key,
       requested_by,recipient,subject,text_body,html_body)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(company_id,idempotency_key) DO NOTHING RETURNING *`,
    [companyId,id,transactionId,idempotencyKey,actorId,recipient,message.subject,message.textBody,message.htmlBody],
  );
  if (inserted.rowCount) {
    await c.query(
      `INSERT INTO myfin.receipt_email_events(company_id,id,delivery_id,actor_id,event_type,attempt_count)
       VALUES($1,$2,$3,$4,'queued',0)`,
      [companyId,randomUUID(),id,actorId],
    );
    return inserted.rows[0];
  }
  const raced = (await c.query(
    `SELECT * FROM myfin.receipt_email_deliveries
      WHERE company_id=$1 AND idempotency_key=$2`, [companyId,idempotencyKey],
  )).rows[0];
  if (!raced || raced.transaction_id !== transactionId || raced.recipient !== recipient ||
      raced.subject !== message.subject || raced.text_body !== message.textBody ||
      raced.html_body !== message.htmlBody)
    v.fail(409,'receipt_email_payload_changed');
  return raced;
}

export function registerReceiptEmails(app, { scoped, audit, enabled = false }) {
  app.get('/api/companies/:company/transactions/:transactionId/receipt-emails', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity,'documentsRead');
    await transaction(c,companyId,req.params.transactionId,req.identity);
    const rows = (await c.query(
      `SELECT id,idempotency_key,transaction_id,recipient,state,attempt_count,max_attempts,next_attempt_at,
              accepted_at,created_at,updated_at,last_error_code
         FROM myfin.receipt_email_deliveries
        WHERE company_id=$1 AND transaction_id=$2
        ORDER BY created_at DESC,id DESC LIMIT 50`,
      [companyId,req.params.transactionId],
    )).rows;
    return { enabled:Boolean(enabled), rows:rows.map(output) };
  }));

  app.post('/api/companies/:company/transactions/:transactionId/receipt-emails', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity,'documentsRead');
    if (!enabled) v.fail(503,'receipt_email_unavailable');
    const input = v.parse(enqueueInput,req.body), row = await transaction(c,companyId,req.params.transactionId,req.identity);
    if (input.sendAgain) requireCapability(req.identity,'receiptEmailsRetry');
    const message = renderReceiptEmail({ ...row.data,id:row.id,company_id:row.company_id,source:row.source });
    const delivery = await insertDelivery(c,{ companyId,transactionId:row.id,recipient:input.recipient,
      idempotencyKey:input.idempotencyKey,actorId:req.identity.id,message,
      requiredPrior:input.sendAgain?{states:['sent']}:null });
    await audit(c,req.identity,companyId,'Queue receipt email',row.data?.number || row.id);
    return output(delivery);
  }));

  app.post('/api/companies/:company/receipt-emails/:deliveryId/retry', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity,'receiptEmailsRetry');
    if (!enabled) v.fail(503,'receipt_email_unavailable');
    if (!owner(req.identity) && !manager(req.identity)) v.fail(403,'access_denied');
    const input = v.parse(retryInput,req.body), deliveryId = v.parse(v.id,req.params.deliveryId);
    const prior = (await c.query(
      `SELECT * FROM myfin.receipt_email_deliveries
        WHERE company_id=$1 AND id=$2 FOR SHARE`, [companyId,deliveryId],
    )).rows[0];
    if (!prior) v.fail(404,'not_found');
    if (!['failed','delivery_unknown'].includes(prior.state)) v.fail(409,'receipt_email_retry_not_required');
    await transaction(c,companyId,prior.transaction_id,req.identity);
    const created = await insertDelivery(c,{ companyId,transactionId:prior.transaction_id,
      recipient:prior.recipient,idempotencyKey:input.idempotencyKey,actorId:req.identity.id,
      message:{subject:prior.subject,textBody:prior.text_body,htmlBody:prior.html_body},
      requiredPrior:{id:prior.id,states:['failed','delivery_unknown']} });
    await audit(c,req.identity,companyId,'Retry receipt email',prior.transaction_id);
    return output(created);
  }));
}

export const receiptEmailInternals = Object.freeze({ escapeHtml, output, insertDelivery });
