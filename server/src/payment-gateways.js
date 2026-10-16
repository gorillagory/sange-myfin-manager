import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Transform } from 'node:stream';
import { z } from 'zod';
import { requireCapability } from './access.js';
import { customerSession } from './customer-auth.js';
import {
  PaymentProviderError, createHitPayAdapter, normalizeHitPayCompletedWebhook,
} from './payment-gateway-hitpay.js';
import { storefrontRateKey } from './storefront-public.js';
import { lockOrderPayment, onlinePaymentStates } from './online-payment-lock.js';
import { extendOrderReservations } from './customer-order-reservations.js';
import { extendOrderPromotionReservations } from './pricing-engine.js';
import * as v from './validation.js';

const guestCookieName = '__Host-myfin_guest_order';
const secretRefPattern = /^secretref:\/\/[A-Za-z0-9][A-Za-z0-9/_-]{0,239}$/;
const safeProviderIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const payableStatuses = new Set(['accepted', 'preparing', 'ready']);
const emptyBodySchema = z.strictObject({});
const publicCodeSchema = z.string().regex(/^[A-Z0-9]{8}$/);
const idempotencySchema = z.uuid();
const webhookPath = '/api/public/payment-gateways/hitpay/webhook';
const checkoutExpiryMinutes = 10;
const paymentHoldMinutes = 15;
const reconcilableStates = new Set(['creating', 'pending', 'reconciliation_required']);
const connectionSchema = z.strictObject({
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['disabled', 'active']),
  providerEnvironment: z.enum(['sandbox', 'production']),
  accountHint: z.string().trim().max(80).default(''),
  secretRef: z.union([z.literal(''), z.string().regex(secretRefPattern)]),
});

class GatewayUnavailableError extends Error {
  constructor() { super('online_payment_unavailable'); this.name = 'GatewayUnavailableError'; }
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const guestTokenDigest = token => sha256(`myfin-guest-order:${token}`);

function cookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(at + 1).trim()); } catch { return ''; }
  }
  return '';
}

function header(req, name) {
  const value = req.headers[name];
  return typeof value === 'string' ? value : '';
}

function publicContext(req) {
  if (req.tenant?.surface !== 'storefront') v.fail(404, 'not_found');
  return req.tenant;
}

function amountSen(value) {
  const text = String(value ?? '');
  if (!/^\d{1,13}(?:\.\d{1,2})?$/.test(text)) v.fail(409, 'online_payment_amount_invalid');
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 9_000_000_000_000_000)
    v.fail(409, 'online_payment_amount_invalid');
  return amount;
}

function currencyCode(value) {
  if (!['RM', 'MYR'].includes(String(value || '').toUpperCase()))
    v.fail(409, 'online_payment_currency_invalid');
  return 'MYR';
}

function paymentRequestDigest(order, connection) {
  return sha256(JSON.stringify([
    order.company_id, order.id, order.public_code, amountSen(order.total), currencyCode(order.currency),
    connection.id, Number(connection.version), connection.provider_environment,
  ]));
}

function strictCredentialDocument(source, secretRef) {
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : String(source);
  if (Buffer.byteLength(text) > 1024 * 1024) throw new GatewayUnavailableError();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new GatewayUnavailableError(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new GatewayUnavailableError();
  const entry = parsed[secretRef];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !== 'apiKey,webhookSalt') throw new GatewayUnavailableError();
  const { apiKey, webhookSalt } = entry;
  if (typeof apiKey !== 'string' || apiKey.length < 16 || apiKey.length > 500 || /[\r\n\0]/.test(apiKey) ||
      typeof webhookSalt !== 'string' || webhookSalt.length < 16 || webhookSalt.length > 500 ||
      /[\r\n\0]/.test(webhookSalt)) throw new GatewayUnavailableError();
  return Object.freeze({ apiKey, webhookSalt });
}

/**
 * Missing or invalid operator secrets deliberately do not make API readiness fail.
 * The affected payment route returns a generic 503 without serialising a path,
 * secret reference, parser error, API key or webhook salt.
 */
export function createPaymentGatewayRuntime(env = process.env, {
  readFile = readFileSync, fetch: fetchImpl = globalThis.fetch, timeoutMs = 8000,
} = {}) {
  const enabled = env.PAYMENT_GATEWAY_ENABLED === 'true';
  const secretFile = typeof env.PAYMENT_GATEWAY_SECRET_FILE === 'string' &&
    isAbsolute(env.PAYMENT_GATEWAY_SECRET_FILE) ? env.PAYMENT_GATEWAY_SECRET_FILE : '';
  const adapter = createHitPayAdapter({ fetch: fetchImpl, timeoutMs });
  const credentialsFor = secretRef => {
    if (!enabled || !secretFile || !secretRefPattern.test(String(secretRef || '')))
      throw new GatewayUnavailableError();
    let source;
    try { source = readFile(secretFile); } catch { throw new GatewayUnavailableError(); }
    return strictCredentialDocument(source, secretRef);
  };
  return Object.freeze({ enabled, adapter, credentialsFor });
}

export function paymentGatewayWebhookRequest(req) {
  return req.method === 'POST' && req.url.split('?')[0] === webhookPath;
}

export function captureGatewayRawBody(req, _reply, payload, done) {
  const chunks = [];
  let size = 0;
  const copy = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size <= 256 * 1024) chunks.push(bytes);
      this.receivedEncodedLength = (this.receivedEncodedLength || 0) + bytes.length;
      callback(null, bytes);
    },
    flush(callback) {
      req.gatewayRawBody = size <= 256 * 1024 ? Buffer.concat(chunks) : null;
      callback();
    },
  });
  copy.receivedEncodedLength = 0;
  payload.pipe(copy);
  done(null, copy);
}

async function ownedOrder(c, req, context, code, lock = false) {
  const customer = await customerSession(c, req);
  const token = cookie(req.headers.cookie, guestCookieName);
  const guestDigest = /^[A-Za-z0-9_-]{32,128}$/.test(token) ? guestTokenDigest(token) : null;
  if (!customer && !guestDigest) v.fail(401, 'guest_session_required');
  const row = (await c.query(
    `SELECT o.* FROM myfin.customer_order_requests o
       LEFT JOIN myfin.customer_guest_sessions gs
         ON gs.token_digest=o.guest_session_digest AND gs.storefront_hostname=$3
        AND gs.revoked_at IS NULL AND gs.expires_at>now()
      WHERE o.company_id=$1 AND o.public_code=$2 AND
        (($4::text IS NOT NULL AND o.customer_id=$4) OR
         ($5::text IS NOT NULL AND o.customer_id IS NULL AND gs.token_digest=$5))
      ${lock ? 'FOR UPDATE OF o' : ''}`,
    [context.company_id, code, context.hostname, customer?.customerId || null, guestDigest],
  )).rows[0];
  if (!row) v.fail(404, 'order_not_found');
  return row;
}

async function paymentState(c, companyId, orderId, intentId = '') {
  return (await c.query(
    `SELECT s.*,i.provider_reference,i.idempotency_key,i.request_digest,i.secret_ref_snapshot,
            i.order_version,i.order_status_snapshot,i.public_code_snapshot,
            i.provider_environment,c.provider_key,c.account_hint
       FROM myfin.customer_order_online_payment_state s
       JOIN myfin.online_payment_intents i
         ON i.company_id=s.company_id AND i.id=s.intent_id
       JOIN myfin.payment_gateway_connections c
         ON c.company_id=i.company_id AND c.id=i.connection_id
      WHERE s.company_id=$1 AND s.order_id=$2
        AND ($3::text='' OR s.intent_id=$3)
      ORDER BY CASE s.state WHEN 'finalized' THEN 0 WHEN 'reconciliation_required' THEN 1
               WHEN 'confirmed_unposted' THEN 2 WHEN 'pending' THEN 3
               WHEN 'creating' THEN 4 ELSE 5 END,
               s.confirmed_at DESC NULLS LAST,s.created_at DESC,s.intent_id DESC LIMIT 1`,
    [companyId, orderId, intentId],
  )).rows[0] || null;
}

function publicPaymentOutput(row, available) {
  if (!row) return { available, provider: 'hitpay', state: 'not_started' };
  return {
    available, provider: row.provider_key || 'hitpay', environment: row.provider_environment,
    state: row.state, amountSen: Number(row.amount_sen), currencyCode: row.currency_code,
    holdUntil: row.hold_until, providerStatus: row.provider_status || '',
    ...(row.state === 'pending' && row.checkout_url ? { checkoutUrl: row.checkout_url } : {}),
    ...(['reconciliation_required', 'confirmed_unposted', 'finalized'].includes(row.state) &&
      row.provider_payment_id ? { confirmation: {
      method: row.provider_method_code || 'unknown', status: row.provider_status,
      confirmedAt: row.confirmed_at,
    } } : {}),
  };
}

function observationDigest(observed) {
  return sha256(JSON.stringify([
    observed.requestId, observed.referenceNumber, observed.amountSen, observed.currencyCode,
    observed.status, observed.checkoutUrl, observed.updatedAt,
  ]));
}

function assertMatchingObservation(intent, observed) {
  if (observed.referenceNumber !== intent.provider_reference)
    v.fail(409, 'online_payment_reference_mismatch');
  if (observed.amountSen !== Number(intent.amount_sen))
    v.fail(409, 'online_payment_amount_mismatch');
  if (observed.currencyCode !== intent.currency_code)
    v.fail(409, 'online_payment_currency_mismatch');
  if (intent.provider_payment_request_id &&
      observed.requestId !== intent.provider_payment_request_id)
    v.fail(409, 'online_payment_request_mismatch');
}

function reconciliationLookupFailure(error) {
  if (error instanceof PaymentProviderError && error.code === 'provider_request_not_found')
    v.fail(409, 'online_payment_provider_request_not_found');
  if (error instanceof PaymentProviderError && error.code === 'provider_response_invalid')
    v.fail(502, 'online_payment_provider_response_invalid');
  v.fail(503, 'online_payment_reconciliation_unavailable');
}

async function isAvailable(runtime, c, companyId) {
  if (!runtime.enabled) return false;
  const connection = (await c.query(
    `SELECT secret_ref FROM myfin.payment_gateway_connections
      WHERE company_id=$1 AND provider_key='hitpay' AND status='active'`, [companyId],
  )).rows[0];
  if (!connection) return false;
  try { runtime.credentialsFor(connection.secret_ref); return true; } catch { return false; }
}

async function appendEvent(c, intent, event) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`online-payment:${intent.company_id}:${intent.id}`]);
  if (event.providerEventKey) {
    const prior = await c.query(
      `SELECT id FROM myfin.online_payment_events
        WHERE company_id=$1 AND intent_id=$2 AND provider_event_key=$3`,
      [intent.company_id, intent.id, event.providerEventKey],
    );
    if (prior.rowCount) return false;
  }
  if (['payment_confirmed', 'payment_reconciliation_required'].includes(event.eventType)) {
    const prior = await c.query(
      `SELECT id FROM myfin.online_payment_events
        WHERE company_id=$1 AND intent_id=$2
          AND event_type=ANY($3::text[])`,
      [intent.company_id, intent.id, ['payment_confirmed', 'payment_reconciliation_required']],
    );
    if (prior.rowCount) return false;
  }
  const eventNo = Number((await c.query(
    `SELECT coalesce(max(event_no),0)+1 AS event_no FROM myfin.online_payment_events
      WHERE company_id=$1 AND intent_id=$2`, [intent.company_id, intent.id],
  )).rows[0].event_no);
  await c.query(
    `INSERT INTO myfin.online_payment_events(
       company_id,id,intent_id,event_no,event_type,provider_event_key,payload_digest,
       provider_payment_request_id,provider_payment_id,provider_method_code,provider_status,
       checkout_url,observed_amount_sen,observed_currency_code,failure_code,provider_occurred_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [intent.company_id, randomUUID(), intent.id, eventNo, event.eventType,
      event.providerEventKey || null, event.payloadDigest || null,
      event.providerPaymentRequestId || null, event.providerPaymentId || null,
      event.providerMethodCode || '', event.providerStatus || '', event.checkoutUrl || null,
      event.observedAmountSen || null, event.observedCurrencyCode || null,
      event.failureCode || '', event.providerOccurredAt || null],
  );
  return true;
}

async function startPayment(db, runtime, req, context, code, idempotencyKey) {
  if (!runtime.enabled) v.fail(503, 'online_payment_unavailable');
  const prepared = await db.transaction(async c => {
    // Tenant resolution happens before this transaction. Lock and revalidate the
    // exact public host so a concurrent hostname rotation cannot strand a newly
    // created payment intent on a webhook URL that has just been disabled.
    const activeHost = await c.query(
      `SELECT 1 FROM myfin.storefront_hosts
        WHERE company_id=$1 AND hostname=$2 AND disabled_at IS NULL
        FOR SHARE`,
      [context.company_id, context.hostname],
    );
    if (!activeHost.rowCount) v.fail(409, 'storefront_hostname_changed');
    const order = await ownedOrder(c, req, context, code, true);
    await lockOrderPayment(c, context.company_id, order.id);
    const sameKey = (await c.query(
      `SELECT * FROM myfin.online_payment_intents
        WHERE company_id=$1 AND idempotency_key=$2`, [context.company_id, idempotencyKey],
    )).rows[0];
    if (sameKey) {
      const expected = paymentRequestDigest(order, {
        id: sameKey.connection_id, version: sameKey.connection_version,
        provider_environment: sameKey.provider_environment,
      });
      if (sameKey.order_id !== order.id || sameKey.request_digest !== expected)
        v.fail(409, 'idempotency_conflict');
      return { existing: await paymentState(c, context.company_id, order.id, sameKey.id) };
    }
    const activePrior = await c.query(
      `SELECT state FROM myfin.customer_order_online_payment_state
        WHERE company_id=$1 AND order_id=$2 AND state<>'failed'
        ORDER BY created_at DESC,intent_id DESC LIMIT 1`, [context.company_id, order.id],
    );
    if (activePrior.rowCount) v.fail(409, 'online_payment_already_started');
    if (!payableStatuses.has(order.status) || order.payment_state !== 'unpaid' ||
        new Date(order.expires_at).getTime() <= Date.now()) v.fail(409, 'order_not_payable');
    const connection = (await c.query(
      `SELECT id,provider_key,provider_environment,secret_ref,version
         FROM myfin.payment_gateway_connections
        WHERE company_id=$1 AND provider_key='hitpay' AND status='active'`, [context.company_id],
    )).rows[0];
    if (!connection) v.fail(503, 'online_payment_unavailable');
    let credentials;
    try { credentials = runtime.credentialsFor(connection.secret_ref); }
    catch { v.fail(503, 'online_payment_unavailable'); }
    const amount = amountSen(order.total), currency = currencyCode(order.currency);
    const holdUntil = (await c.query(
      `SELECT greatest($1::timestamptz,now()+make_interval(mins=>$2)) AS hold_until`,
      [order.expires_at, paymentHoldMinutes],
    )).rows[0].hold_until;
    const intent = {
      company_id: context.company_id, id: randomUUID(), order_id: order.id,
      provider_reference: randomUUID(), amount_sen: amount, currency_code: currency,
      provider_environment: connection.provider_environment, hold_until: holdUntil,
    };
    const requestDigest = paymentRequestDigest(order, connection);
    await c.query(
      `INSERT INTO myfin.online_payment_intents(
         company_id,id,order_id,connection_id,connection_version,provider_environment,
         secret_ref_snapshot,idempotency_key,request_digest,provider_reference,
         amount_sen,currency_code,order_version,order_status_snapshot,public_code_snapshot,hold_until)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [intent.company_id, intent.id, intent.order_id, connection.id, connection.version,
        connection.provider_environment, connection.secret_ref, idempotencyKey, requestDigest,
        intent.provider_reference, amount, currency, order.version, order.status, order.public_code,
        holdUntil],
    );
    await appendEvent(c, intent, { eventType: 'checkout_creation_started' });
    if (new Date(holdUntil).getTime() > new Date(order.expires_at).getTime()) {
      const nextVersion = Number(order.version) + 1;
      const updated = (await c.query(
        `UPDATE myfin.customer_order_requests
            SET expires_at=$3,version=$4,updated_at=now()
          WHERE company_id=$1 AND id=$2 AND version=$5
            AND status=ANY($6::text[]) AND payment_state='unpaid'
          RETURNING version,expires_at`,
        [context.company_id, order.id, holdUntil, nextVersion, order.version, [...payableStatuses]],
      )).rows[0];
      if (!updated) v.fail(409, 'customer_order_changed');
      await extendOrderReservations(c, context.company_id, order.id, holdUntil);
      await extendOrderPromotionReservations(c, {
        companyId: context.company_id, orderId: order.id, expiresAt: holdUntil,
      });
      const holdRequestId = `payment-hold:${intent.id}`;
      await c.query(
        `INSERT INTO myfin.customer_order_events(
           company_id,id,order_id,version,actor_type,request_id,request_digest,
           action,from_status,to_status,note)
         VALUES($1,$2,$3,$4,'system',$5,$6,'status_changed',$7,$7,
           'Reservation window extended for hosted checkout.')`,
        [context.company_id, randomUUID(), order.id, nextVersion, holdRequestId,
          sha256(holdRequestId), order.status],
      );
    }
    return { intent, credentials, orderCode: order.public_code };
  });
  if (prepared.existing) return { created: false, state: prepared.existing };
  const redirectUrl = new URL(`/order/${encodeURIComponent(prepared.orderCode)}?payment=return`,
    `${context.protocol || 'https:'}//${context.hostname}`).toString();
  try {
    const checkout = await runtime.adapter.createCheckout({
      apiKey: prepared.credentials.apiKey, environment: prepared.intent.provider_environment,
      amountSen: prepared.intent.amount_sen, currencyCode: prepared.intent.currency_code,
      referenceNumber: prepared.intent.provider_reference,
      purpose: `Order ${prepared.orderCode}`, redirectUrl, expiresAfterMinutes: checkoutExpiryMinutes,
    });
    await db.transaction(c => appendEvent(c, prepared.intent, {
      eventType: 'checkout_created', providerPaymentRequestId: checkout.id,
      providerStatus: 'pending', checkoutUrl: checkout.checkoutUrl,
    }));
    return { created: true, state: await db.transaction(c => paymentState(
      c, prepared.intent.company_id, prepared.intent.order_id, prepared.intent.id,
    )) };
  } catch (error) {
    const definitive = error instanceof PaymentProviderError &&
      error.code === 'provider_request_rejected';
    await db.transaction(c => appendEvent(c, prepared.intent, {
      eventType: definitive ? 'checkout_creation_failed' : 'checkout_creation_unknown',
      failureCode: definitive ? 'provider_request_rejected' : 'provider_outcome_unknown',
    }));
    v.fail(503, 'online_payment_unavailable');
  }
}

function webhookFailureCode(error) {
  return error instanceof PaymentProviderError && error.code === 'payment_not_succeeded'
    ? 'payment_not_succeeded' : 'provider_response_invalid';
}

async function activeConnection(c, companyId) {
  return (await c.query(
    `SELECT secret_ref FROM myfin.payment_gateway_connections
      WHERE company_id=$1 AND provider_key='hitpay' AND status='active'`, [companyId],
  )).rows[0] || null;
}

async function handleWebhook(db, runtime, req, context) {
  if (!runtime.enabled) v.fail(503, 'online_payment_unavailable');
  if (header(req, 'hitpay-event-type') !== 'completed' ||
      header(req, 'hitpay-event-object') !== 'payment_request') v.fail(400, 'invalid_webhook');
  const rawBody = req.gatewayRawBody;
  const signature = header(req, 'hitpay-signature');
  if (!Buffer.isBuffer(rawBody) || !rawBody.length || !signature) v.fail(400, 'invalid_webhook');
  const candidateReference = String(req.body?.reference_number || '');
  const candidate = safeProviderIdPattern.test(candidateReference) ? await db.transaction(async c => {
    return (await c.query(
      `SELECT i.*,e.provider_payment_request_id
         FROM myfin.online_payment_intents i
         LEFT JOIN LATERAL (
           SELECT provider_payment_request_id FROM myfin.online_payment_events
            WHERE company_id=i.company_id AND intent_id=i.id
              AND event_type IN ('checkout_created','checkout_discovered')
            ORDER BY event_no DESC LIMIT 1
         ) e ON true
        WHERE i.company_id=$1 AND i.provider_reference=$2`,
      [context.company_id, candidateReference],
    )).rows[0] || null;
  }) : null;
  const secretRef = candidate?.secret_ref_snapshot || await db.transaction(async c =>
    (await activeConnection(c, context.company_id))?.secret_ref || '');
  let credentials;
  try { credentials = runtime.credentialsFor(secretRef); }
  catch { v.fail(503, 'online_payment_unavailable'); }
  if (!runtime.adapter.verifyWebhook({ rawBody, signature, webhookSalt: credentials.webhookSalt }))
    v.fail(401, 'invalid_webhook_signature');
  if (!candidate) return { accepted: false };
  const payloadDigest = sha256(rawBody);
  let normalized;
  try { normalized = normalizeHitPayCompletedWebhook(req.body); }
  catch (error) {
    await db.transaction(c => appendEvent(c, candidate, {
      eventType: 'webhook_rejected', providerEventKey: `invalid:${payloadDigest}`,
      payloadDigest, providerPaymentRequestId: safeProviderIdPattern.test(String(req.body?.id || ''))
        ? String(req.body.id) : null,
      failureCode: webhookFailureCode(error),
    }));
    return { accepted: false };
  }
  let failureCode = '';
  if (normalized.referenceNumber !== candidate.provider_reference) failureCode = 'reference_mismatch';
  else if (normalized.amountSen !== Number(candidate.amount_sen)) failureCode = 'amount_mismatch';
  else if (normalized.currencyCode !== candidate.currency_code) failureCode = 'currency_mismatch';
  else if (candidate.provider_payment_request_id &&
      normalized.requestId !== candidate.provider_payment_request_id) failureCode = 'payment_request_mismatch';
  const providerEventKey = failureCode ? `rejected:${payloadDigest}`
    : `completed:${sha256(`${normalized.requestId}\0${normalized.paymentId}`)}`;
  const payableConfirmation = await db.transaction(async c => {
    const order = (await c.query(
      `SELECT status,payment_state FROM myfin.customer_order_requests
        WHERE company_id=$1 AND id=$2 FOR UPDATE`,
      [candidate.company_id, candidate.order_id],
    )).rows[0];
    await lockOrderPayment(c, candidate.company_id, candidate.order_id);
    const orderPayable = order && payableStatuses.has(order.status) && order.payment_state === 'unpaid';
    const actualFailure = failureCode || (orderPayable ? '' : 'order_not_payable');
    await appendEvent(c, candidate, {
      eventType: failureCode ? 'webhook_rejected' : orderPayable
        ? 'payment_confirmed' : 'payment_reconciliation_required', providerEventKey,
      payloadDigest, providerPaymentRequestId: normalized.requestId,
      providerPaymentId: normalized.paymentId, providerMethodCode: normalized.methodCode,
      providerStatus: normalized.providerStatus, observedAmountSen: normalized.amountSen,
      observedCurrencyCode: normalized.currencyCode, failureCode: actualFailure,
      providerOccurredAt: normalized.occurredAt,
    });
    return orderPayable;
  });
  return { accepted: !failureCode && payableConfirmation };
}

export function registerPaymentGatewayPublic(app, { db, authOptions, runtime }) {
  const rate = max => ({ max, timeWindow: 60_000,
    keyGenerator: req => storefrontRateKey(req, authOptions) });
  if (!app.hasRequestDecorator('gatewayRawBody')) app.decorateRequest('gatewayRawBody', null);
  app.post('/api/public/order-requests/:code/online-payment', {
    config: { rateLimit: rate(10) }, bodyLimit: 1024,
  }, async (req, reply) => {
    const context = publicContext(req);
    const code = v.parse(publicCodeSchema, String(req.params.code || '').toUpperCase());
    v.parse(emptyBodySchema, req.body || {});
    const idempotencyKey = v.parse(idempotencySchema, header(req, 'idempotency-key'));
    const result = await startPayment(db, runtime, req, context, code, idempotencyKey);
    if (result.created) reply.code(201);
    return { onlinePayment: publicPaymentOutput(result.state, true) };
  });
  app.get('/api/public/order-requests/:code/online-payment', {
    config: { rateLimit: rate(60) },
  }, async req => {
    const context = publicContext(req);
    const code = v.parse(publicCodeSchema, String(req.params.code || '').toUpperCase());
    return db.transaction(async c => {
      const order = await ownedOrder(c, req, context, code);
      const [state, available] = await Promise.all([
        paymentState(c, context.company_id, order.id), isAvailable(runtime, c, context.company_id),
      ]);
      return { onlinePayment: publicPaymentOutput(state, available) };
    });
  });
  app.post(webhookPath, {
    config: { rateLimit: rate(120) }, bodyLimit: 256 * 1024,
    preParsing: captureGatewayRawBody,
  }, async req => handleWebhook(db, runtime, req, publicContext(req)));
}

export async function assertOrderHasNoConfirmedOnlinePayment(c, companyId, orderId) {
  const states = await onlinePaymentStates(c, companyId, orderId);
  if (states.some(state => ['confirmed_unposted', 'finalized'].includes(state)))
    v.fail(409, 'online_payment_already_confirmed');
  if (states.includes('reconciliation_required'))
    v.fail(409, 'online_payment_reconciliation_required');
  if (states.some(state => ['creating', 'pending'].includes(state)))
    v.fail(409, 'online_payment_in_progress');
}

export async function confirmedOnlinePaymentForOrder(c, companyId, orderId) {
  await lockOrderPayment(c, companyId, orderId);
  const confirmed = await c.query(
    `SELECT s.*,i.provider_reference,i.order_version,i.order_status_snapshot,
            i.public_code_snapshot,i.provider_environment
       FROM myfin.customer_order_online_payment_state s
       JOIN myfin.online_payment_intents i
         ON i.company_id=s.company_id AND i.id=s.intent_id
      WHERE s.company_id=$1 AND s.order_id=$2
        AND s.state=ANY($3::text[])
      ORDER BY s.confirmed_at DESC NULLS LAST,s.created_at DESC,s.intent_id DESC LIMIT 2`,
    [companyId, orderId, ['confirmed_unposted', 'finalized']],
  );
  if (confirmed.rowCount > 1) v.fail(409, 'online_payment_reconciliation_required');
  return confirmed.rows[0] || null;
}

function connectionOutput(row, credentialAvailable, webhookUrls = []) {
  return row ? {
    configured: true, provider: 'hitpay', status: row.status,
    providerEnvironment: row.provider_environment, accountHint: row.account_hint || '',
    secretRef: row.secret_ref || '', version: Number(row.version), credentialAvailable,
    webhookUrls,
  } : {
    configured: false, provider: 'hitpay', status: 'disabled', providerEnvironment: 'sandbox',
    accountHint: '', secretRef: '', version: 0, credentialAvailable: false, webhookUrls,
  };
}

async function staffPaymentDetails(c, state) {
  if (!state) return { onlinePayment: null, events: [] };
  const eventsResult = await c.query(
    `SELECT event_no,event_type,provider_payment_request_id,provider_payment_id,
            provider_method_code,provider_status,checkout_url,observed_amount_sen,
            observed_currency_code,failure_code,provider_occurred_at,created_at
       FROM myfin.online_payment_events
      WHERE company_id=$1 AND intent_id=$2 ORDER BY event_no`,
    [state.company_id, state.intent_id],
  );
  const lifecycleResult = await c.query(
    `SELECT state,attempt_count,next_attempt_at,last_outcome_code,escalation_reason,
            escalated_at,resolved_at
       FROM myfin.online_payment_reconciliation_jobs
      WHERE company_id=$1 AND intent_id=$2`,
    [state.company_id,state.intent_id],
  );
  const events = eventsResult.rows, lifecycle = lifecycleResult.rows[0] || null;
  return {
    onlinePayment: {
      provider: state.provider_key, environment: state.provider_environment,
      accountHint: state.account_hint || '', state: state.state,
      amountSen: Number(state.amount_sen), currencyCode: state.currency_code,
      reference: state.provider_reference, orderVersion: Number(state.order_version),
      orderStatusSnapshot: state.order_status_snapshot, createdAt: state.created_at,
      holdUntil: state.hold_until, providerStatus: state.provider_status || '',
      checkoutUrl: state.checkout_url || '',
      paymentRequestId: state.provider_payment_request_id || '',
      paymentId: state.provider_payment_id || '', method: state.provider_method_code || '',
      confirmedAt: state.confirmed_at || null,
      finalizedSaleId: state.finalized_sale_id || '', finalizedAt: state.finalized_at || null,
      reconciliationState: lifecycle?.state || '',
      reconciliationAttemptCount: Number(lifecycle?.attempt_count || 0),
      reconciliationNextAttemptAt: lifecycle?.next_attempt_at || null,
      reconciliationLastOutcome: lifecycle?.last_outcome_code || '',
      escalationReason: lifecycle?.escalation_reason || '',
      escalatedAt: lifecycle?.escalated_at || null,
      reconciliationResolvedAt: lifecycle?.resolved_at || null,
    },
    events: events.map(event => ({
      number: Number(event.event_no), type: event.event_type,
      paymentRequestId: event.provider_payment_request_id || '',
      paymentId: event.provider_payment_id || '', method: event.provider_method_code || '',
      providerStatus: event.provider_status || '', checkoutUrl: event.checkout_url || '',
      amountSen: event.observed_amount_sen === null ? null : Number(event.observed_amount_sen),
      currencyCode: event.observed_currency_code || '', failureCode: event.failure_code || '',
      providerOccurredAt: event.provider_occurred_at || null, createdAt: event.created_at,
    })),
  };
}

async function reconcileOnlinePayment(scoped, runtime, audit, req) {
  v.parse(emptyBodySchema, req.body || {});
  const orderId = v.parse(v.id, req.params.id);
  const prepared = await scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'receiptReviewsResolve');
    const order = await c.query(
      `SELECT id FROM myfin.customer_order_requests WHERE company_id=$1 AND id=$2`,
      [companyId, orderId],
    );
    if (!order.rowCount) v.fail(404, 'customer_order_not_found');
    const state = await paymentState(c, companyId, orderId);
    if (!state) v.fail(404, 'online_payment_not_started');
    if (!reconcilableStates.has(state.state) || state.provider_payment_id)
      return { settled: true, companyId, state };
    if (!runtime?.enabled) v.fail(503, 'online_payment_reconciliation_unavailable');
    let credentials;
    try { credentials = runtime.credentialsFor(state.secret_ref_snapshot); }
    catch { v.fail(503, 'online_payment_reconciliation_unavailable'); }
    return {
      settled: false, companyId, credentials, intentId: state.intent_id,
      environment: state.provider_environment, referenceNumber: state.provider_reference,
      requestId: state.provider_payment_request_id || '',
      amountSen: Number(state.amount_sen), currencyCode: state.currency_code,
    };
  });
  if (prepared.settled) return scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'receiptReviewsResolve');
    return {
      ...(await staffPaymentDetails(c, await paymentState(c, companyId, orderId, prepared.state.intent_id))),
      reconciliation: { changed: false, providerStatus: prepared.state.provider_status || '' },
    };
  });

  let observed;
  try {
    observed = prepared.requestId
      ? await runtime.adapter.getPaymentRequest({
        apiKey: prepared.credentials.apiKey, environment: prepared.environment,
        requestId: prepared.requestId,
      })
      : await runtime.adapter.findPaymentRequestByReference({
        apiKey: prepared.credentials.apiKey, environment: prepared.environment,
        referenceNumber: prepared.referenceNumber,
      });
  } catch (error) { reconciliationLookupFailure(error); }
  assertMatchingObservation({
    provider_reference: prepared.referenceNumber, amount_sen: prepared.amountSen,
    currency_code: prepared.currencyCode, provider_payment_request_id: prepared.requestId,
  }, observed);

  return scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'receiptReviewsResolve');
    await lockOrderPayment(c, companyId, orderId);
    const state = await paymentState(c, companyId, orderId, prepared.intentId);
    if (!state) v.fail(409, 'online_payment_changed');
    if (!reconcilableStates.has(state.state) || state.provider_payment_id) return {
      ...(await staffPaymentDetails(c, state)),
      reconciliation: { changed: false, providerStatus: state.provider_status || '' },
    };
    assertMatchingObservation(state, observed);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`online-payment-request:${companyId}:${observed.requestId}`]);
    const binding = await c.query(
      `SELECT intent_id FROM myfin.online_payment_events
        WHERE company_id=$1 AND provider_payment_request_id=$2
          AND event_type=ANY($3::text[]) LIMIT 1`,
      [companyId, observed.requestId, ['checkout_created', 'checkout_discovered']],
    );
    if (binding.rowCount && binding.rows[0].intent_id !== state.intent_id)
      v.fail(409, 'online_payment_request_conflict');
    const discovered = !state.provider_payment_request_id;
    const digest = observationDigest(observed);
    const changed = await appendEvent(c, state, {
      eventType: discovered ? 'checkout_discovered' : 'provider_status_observed',
      providerEventKey: `${discovered ? 'discovery' : 'status'}:${observed.requestId}:${observed.status}`,
      payloadDigest: digest, providerPaymentRequestId: observed.requestId,
      providerStatus: observed.status, checkoutUrl: discovered ? observed.checkoutUrl : null,
      observedAmountSen: observed.amountSen, observedCurrencyCode: observed.currencyCode,
      providerOccurredAt: observed.updatedAt,
    });
    if (changed && audit) await audit(c, req.identity, companyId, 'Reconcile online payment',
      `HitPay · ${state.public_code_snapshot} · ${observed.status}`);
    const current = await paymentState(c, companyId, orderId, prepared.intentId);
    return {
      ...(await staffPaymentDetails(c, current)),
      reconciliation: { changed, providerStatus: observed.status },
    };
  });
}

export function registerPaymentGatewayStaff(app, { scoped, audit, runtime }) {
  app.get('/api/companies/:company/payment-gateway', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'integrationsRead');
    const row = (await c.query(
      `SELECT id,status,provider_environment,secret_ref,account_hint,version,created_at,updated_at
         FROM myfin.payment_gateway_connections
        WHERE company_id=$1 AND provider_key='hitpay'`, [companyId],
    )).rows[0] || null;
    const hosts = (await c.query(
      `SELECT hostname FROM myfin.storefront_hosts
        WHERE company_id=$1 AND disabled_at IS NULL ORDER BY hostname`, [companyId],
    )).rows.map(item => `https://${item.hostname}${webhookPath}`);
    let credentialAvailable = false;
    if (row && runtime?.enabled) {
      try { runtime.credentialsFor(row.secret_ref); credentialAvailable = true; } catch { /* safe unavailable */ }
    }
    return { connection: connectionOutput(row, credentialAvailable, hosts) };
  }));
  app.put('/api/companies/:company/payment-gateway', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'integrationSettingsWrite');
    const input = v.parse(connectionSchema, req.body);
    if (input.status === 'active') {
      if (!input.secretRef) v.fail(400, 'payment_gateway_secret_ref_required');
      try { runtime.credentialsFor(input.secretRef); }
      catch { v.fail(409, 'payment_gateway_secret_unavailable'); }
    }
    const current = (await c.query(
      `SELECT * FROM myfin.payment_gateway_connections
        WHERE company_id=$1 AND provider_key='hitpay' FOR UPDATE`, [companyId],
    )).rows[0] || null;
    if (Number(current?.version || 0) !== input.expectedVersion) v.fail(409, 'record_conflict');
    const id = current?.id || randomUUID(), nextVersion = input.expectedVersion + 1;
    const row = current ? (await c.query(
      `UPDATE myfin.payment_gateway_connections
          SET status=$3,provider_environment=$4,secret_ref=nullif($5,''),account_hint=$6,
              version=$7,updated_by=$8,updated_at=now()
        WHERE company_id=$1 AND id=$2 AND version=$9 RETURNING *`,
      [companyId, id, input.status, input.providerEnvironment, input.secretRef, input.accountHint,
        nextVersion, req.identity.id, input.expectedVersion],
    )).rows[0] : (await c.query(
      `INSERT INTO myfin.payment_gateway_connections(
         company_id,id,provider_key,provider_environment,status,secret_ref,account_hint,
         version,created_by,updated_by)
       VALUES($1,$2,'hitpay',$3,$4,nullif($5,''),$6,$7,$8,$8) RETURNING *`,
      [companyId, id, input.providerEnvironment, input.status, input.secretRef,
        input.accountHint, nextVersion, req.identity.id],
    )).rows[0];
    if (!row) v.fail(409, 'record_conflict');
    if (audit) await audit(c, req.identity, companyId, 'Update payment gateway',
      `HitPay · ${input.providerEnvironment} · ${input.status}`);
    let credentialAvailable = false;
    if (runtime?.enabled && row.secret_ref) {
      try { runtime.credentialsFor(row.secret_ref); credentialAvailable = true; } catch { /* safe unavailable */ }
    }
    return { connection: connectionOutput(row, credentialAvailable) };
  }));
  app.get('/api/companies/:company/customer-orders/:id/online-payment', req =>
    scoped(req, async (c, companyId) => {
      requireCapability(req.identity, 'checkout');
      const orderId = v.parse(v.id, req.params.id);
      const order = await c.query(
        `SELECT id FROM myfin.customer_order_requests WHERE company_id=$1 AND id=$2`,
        [companyId, orderId],
      );
      if (!order.rowCount) v.fail(404, 'customer_order_not_found');
      return staffPaymentDetails(c, await paymentState(c, companyId, orderId));
    }));
  app.post('/api/companies/:company/customer-orders/:id/online-payment/reconcile', req =>
    reconcileOnlinePayment(scoped, runtime, audit, req));
}

export const PAYMENT_GATEWAY_WEBHOOK_PATH = webhookPath;
export const paymentAmountSen = amountSen;
