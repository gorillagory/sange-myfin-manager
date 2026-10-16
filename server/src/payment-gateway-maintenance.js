import { createHash, randomUUID } from 'node:crypto';
import { PaymentProviderError } from './payment-gateway-hitpay.js';
import { lockOrderPayment } from './online-payment-lock.js';
import { releaseOrderReservations } from './customer-order-reservations.js';
import { releaseOrderPromotionReservations } from './pricing-engine.js';

const reconcilableStates = Object.freeze(['creating','pending','reconciliation_required']);
const activeOrderStatuses = Object.freeze(['awaiting_acceptance','accepted','preparing','ready']);
const terminalUnpaidStatuses = new Set(['failed','expired','canceled','inactive']);
const immediateEscalationCodes = new Set([
  'provider_request_rejected','provider_response_invalid','amount_mismatch','currency_mismatch',
  'reference_mismatch','payment_request_mismatch',
]);
const retryableCodes = new Set(['provider_unavailable','provider_request_not_found']);
const maxAttempts = 24;
const budgetHours = 24;
const initialDelayMinutes = 2;
const leaseMilliseconds = 180_000;
const retryMinutes = Object.freeze([2,5,10,15,30,60]);

const digest = value => createHash('sha256').update(value).digest('hex');

function batchLimit(value = 25) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100)
    throw new TypeError('invalid_payment_reconciliation_limit');
  return parsed;
}

function safeWorkerId(value) {
  const text = String(value || 'payment-reconciliation-worker');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(text)) throw new TypeError('invalid_payment_reconciliation_worker');
  return text;
}

function retryDelay(attempt) {
  return retryMinutes[Math.min(Math.max(Number(attempt) - 1, 0), retryMinutes.length - 1)];
}

function observationDigest(observed) {
  return digest(JSON.stringify([
    observed.requestId,observed.referenceNumber,observed.amountSen,observed.currencyCode,
    observed.status,observed.checkoutUrl,observed.updatedAt,
  ]));
}

function observationMismatch(intent, observed) {
  if (observed.referenceNumber !== intent.provider_reference) return 'reference_mismatch';
  if (observed.amountSen !== Number(intent.amount_sen)) return 'amount_mismatch';
  if (observed.currencyCode !== intent.currency_code) return 'currency_mismatch';
  if (intent.provider_payment_request_id &&
      observed.requestId !== intent.provider_payment_request_id) return 'payment_request_mismatch';
  return '';
}

function providerFailureCode(error) {
  const code = error instanceof PaymentProviderError ? error.code : '';
  if (retryableCodes.has(code) || immediateEscalationCodes.has(code)) return code;
  return 'provider_unavailable';
}

async function appendEvent(c, intent, event) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`online-payment:${intent.company_id}:${intent.id}`]);
  const prior = await c.query(
    `SELECT id FROM myfin.online_payment_events
      WHERE company_id=$1 AND intent_id=$2 AND provider_event_key=$3`,
    [intent.company_id,intent.id,event.providerEventKey],
  );
  if (prior.rowCount) return false;
  const eventNo = Number((await c.query(
    `SELECT coalesce(max(event_no),0)+1 AS event_no FROM myfin.online_payment_events
      WHERE company_id=$1 AND intent_id=$2`, [intent.company_id,intent.id],
  )).rows[0].event_no);
  await c.query(
    `INSERT INTO myfin.online_payment_events(
       company_id,id,intent_id,event_no,event_type,provider_event_key,payload_digest,
       provider_payment_request_id,provider_payment_id,provider_method_code,provider_status,
       checkout_url,observed_amount_sen,observed_currency_code,failure_code,provider_occurred_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,'',$9,$10,$11,$12,$13,$14)`,
    [intent.company_id,randomUUID(),intent.id,eventNo,event.eventType,event.providerEventKey,
      event.payloadDigest,event.providerPaymentRequestId || null,event.providerStatus || '',
      event.checkoutUrl || null,event.observedAmountSen ?? null,event.observedCurrencyCode || null,
      event.failureCode || '',event.providerOccurredAt || null],
  );
  return true;
}

async function appendEscalation(c, intent, reason, providerStatus = '') {
  return appendEvent(c,intent,{
    eventType:'operator_escalation_required',
    providerEventKey:`auto-escalation:${reason}`,
    payloadDigest:digest(JSON.stringify([intent.id,reason,providerStatus])),
    providerPaymentRequestId:intent.provider_payment_request_id || null,
    providerStatus, failureCode:reason,
  });
}

async function seedJobs(c, now, limit) {
  const result = await c.query(
    `INSERT INTO myfin.online_payment_reconciliation_jobs(
       company_id,intent_id,state,next_attempt_at,budget_expires_at,created_at,updated_at)
     SELECT i.company_id,i.id,'scheduled',greatest(i.created_at+make_interval(mins=>$3),$1),
            i.created_at+make_interval(hours=>$4),i.created_at,$1
       FROM myfin.online_payment_intents i
       JOIN myfin.customer_order_online_payment_state s
         ON s.company_id=i.company_id AND s.intent_id=i.id
      WHERE s.state=ANY($2::text[])
        AND NOT EXISTS(SELECT 1 FROM myfin.online_payment_reconciliation_jobs job
          WHERE job.company_id=i.company_id AND job.intent_id=i.id)
      ORDER BY i.created_at,i.company_id,i.id LIMIT $5
     ON CONFLICT(company_id,intent_id) DO NOTHING
     RETURNING intent_id`,
    [now,reconcilableStates,initialDelayMinutes,budgetHours,limit],
  );
  return result.rowCount;
}

async function closeSettledJobs(c, now) {
  const result = await c.query(
    `UPDATE myfin.online_payment_reconciliation_jobs job
        SET state='closed',resolved_at=$1,lease_owner=NULL,lease_expires_at=NULL,updated_at=$1
       FROM myfin.customer_order_online_payment_state payment
      WHERE payment.company_id=job.company_id AND payment.intent_id=job.intent_id
        AND job.state NOT IN ('terminal_unpaid','closed')
        AND payment.state<>ALL($2::text[])
      RETURNING job.intent_id`, [now,reconcilableStates],
  );
  return result.rowCount;
}

async function escalateExhausted(c, now, limit) {
  const candidates = await c.query(
    `SELECT job.company_id,job.intent_id AS id,state.provider_payment_request_id
       FROM myfin.online_payment_reconciliation_jobs job
       JOIN myfin.customer_order_online_payment_state state
         ON state.company_id=job.company_id AND state.intent_id=job.intent_id
      WHERE job.state IN ('scheduled','retry_wait','running')
        AND (job.state<>'running' OR job.lease_expires_at<=$1)
        AND (job.attempt_count>=$2 OR job.budget_expires_at<=$1)
        AND state.state=ANY($3::text[])
      ORDER BY job.budget_expires_at,job.company_id,job.intent_id
      LIMIT $4 FOR UPDATE OF job SKIP LOCKED`,
    [now,maxAttempts,reconcilableStates,limit],
  );
  for (const intent of candidates.rows) {
    await appendEscalation(c,intent,'reconciliation_budget_exhausted');
    await c.query(
      `UPDATE myfin.online_payment_reconciliation_jobs
          SET state='operator_escalation',last_outcome_code='reconciliation_budget_exhausted',
              escalation_reason='reconciliation_budget_exhausted',escalated_at=$3,
              lease_owner=NULL,lease_expires_at=NULL,updated_at=$3
        WHERE company_id=$1 AND intent_id=$2`, [intent.company_id,intent.id,now],
    );
  }
  return candidates.rowCount;
}

async function claimJobs(c, now, limit, workerId) {
  const leaseUntil = new Date(now.getTime()+leaseMilliseconds);
  return (await c.query(
    `WITH candidates AS (
       SELECT job.company_id,job.intent_id
         FROM myfin.online_payment_reconciliation_jobs job
         JOIN myfin.customer_order_online_payment_state payment
           ON payment.company_id=job.company_id AND payment.intent_id=job.intent_id
         JOIN myfin.online_payment_intents intent
           ON intent.company_id=job.company_id AND intent.id=job.intent_id
        WHERE payment.state=ANY($2::text[])
          AND job.attempt_count<$3 AND job.budget_expires_at>$1
          AND ((job.state IN ('scheduled','retry_wait') AND job.next_attempt_at<=$1) OR
               (job.state='running' AND job.lease_expires_at<=$1))
        ORDER BY job.next_attempt_at,job.company_id,job.intent_id
        LIMIT $4 FOR UPDATE OF job SKIP LOCKED
     )
     UPDATE myfin.online_payment_reconciliation_jobs job
        SET state='running',attempt_count=job.attempt_count+1,
            first_attempt_at=coalesce(job.first_attempt_at,$1),last_attempt_at=$1,
            lease_owner=$5,lease_expires_at=$6,updated_at=$1
       FROM candidates
      WHERE job.company_id=candidates.company_id AND job.intent_id=candidates.intent_id
      RETURNING job.company_id,job.intent_id,job.attempt_count,job.budget_expires_at`,
    [now,reconcilableStates,maxAttempts,limit,workerId,leaseUntil],
  )).rows;
}

async function claimedIntent(c, job, workerId) {
  return (await c.query(
    `SELECT i.*,payment.provider_payment_request_id,payment.state AS payment_state,
            job.attempt_count,job.budget_expires_at
       FROM myfin.online_payment_reconciliation_jobs job
       JOIN myfin.online_payment_intents i
         ON i.company_id=job.company_id AND i.id=job.intent_id
       JOIN myfin.customer_order_online_payment_state payment
         ON payment.company_id=i.company_id AND payment.intent_id=i.id
      WHERE job.company_id=$1 AND job.intent_id=$2 AND job.state='running'
        AND job.lease_owner=$3 FOR UPDATE OF job`,
    [job.company_id,job.intent_id,workerId],
  )).rows[0] || null;
}

async function scheduleRetry(c, intent, now, outcome) {
  const nextAttempt = new Date(now.getTime()+retryDelay(intent.attempt_count)*60_000);
  await c.query(
    `UPDATE myfin.online_payment_reconciliation_jobs
        SET state='retry_wait',next_attempt_at=least($4,budget_expires_at),
            last_outcome_code=$3,lease_owner=NULL,lease_expires_at=NULL,updated_at=$5
      WHERE company_id=$1 AND intent_id=$2`,
    [intent.company_id,intent.id,outcome,nextAttempt,now],
  );
}

async function escalate(c, intent, now, reason, providerStatus = '') {
  await appendEscalation(c,intent,reason,providerStatus);
  await c.query(
    `UPDATE myfin.online_payment_reconciliation_jobs
        SET state='operator_escalation',last_outcome_code=$3,escalation_reason=$3,
            escalated_at=$4,lease_owner=NULL,lease_expires_at=NULL,updated_at=$4
      WHERE company_id=$1 AND intent_id=$2`, [intent.company_id,intent.id,reason,now],
  );
}

async function expireTerminalOrder(c, intent, status, now) {
  const order = (await c.query(
    `SELECT status,payment_state,version FROM myfin.customer_order_requests
      WHERE company_id=$1 AND id=$2 FOR UPDATE`, [intent.company_id,intent.order_id],
  )).rows[0];
  await lockOrderPayment(c,intent.company_id,intent.order_id);
  if (!order || !activeOrderStatuses.includes(order.status) || order.payment_state!=='unpaid') return false;
  const nextVersion = Number(order.version)+1;
  const updated = await c.query(
    `UPDATE myfin.customer_order_requests
        SET status='expired',version=$4,expires_at=least(expires_at,$5),updated_at=$5
      WHERE company_id=$1 AND id=$2 AND status=$3 AND payment_state='unpaid' AND version=$6
      RETURNING id`,
    [intent.company_id,intent.order_id,order.status,nextVersion,now,order.version],
  );
  if (!updated.rowCount) return false;
  await releaseOrderReservations(c,intent.company_id,intent.order_id,'expired');
  await releaseOrderPromotionReservations(c,{
    companyId:intent.company_id,orderId:intent.order_id,reason:'expired',
  });
  const requestId = `gateway-terminal:${intent.id}`;
  await c.query(
    `INSERT INTO myfin.customer_order_events(
       company_id,id,order_id,version,actor_type,request_id,request_digest,
       action,from_status,to_status,note,created_at)
     VALUES($1,$2,$3,$4,'system',$5,$6,'expired',$7,'expired',$8,$9)
     ON CONFLICT(company_id,request_id) DO NOTHING`,
    [intent.company_id,randomUUID(),intent.order_id,nextVersion,requestId,digest(requestId),
      order.status,`Hosted checkout ended ${status}; reservations released.`,now],
  );
  return true;
}

async function recordFailure(database, job, workerId, now, code) {
  return database.transaction(async c => {
    const intent = await claimedIntent(c,job,workerId);
    if (!intent) return { retrying:0,escalated:0 };
    await appendEvent(c,intent,{
      eventType:'provider_reconciliation_failed',
      providerEventKey:`auto-failure:${intent.attempt_count}:${code}`,
      payloadDigest:digest(JSON.stringify([intent.id,intent.attempt_count,code])),
      providerPaymentRequestId:intent.provider_payment_request_id || null,
      failureCode:code,
    });
    if (immediateEscalationCodes.has(code)) {
      await escalate(c,intent,now,code);
      return { retrying:0,escalated:1 };
    }
    const exhausted = intent.attempt_count>=maxAttempts ||
      new Date(intent.budget_expires_at).getTime()<=now.getTime();
    if (exhausted) {
      await escalate(c,intent,now,'reconciliation_budget_exhausted');
      return { retrying:0,escalated:1 };
    }
    await scheduleRetry(c,intent,now,code);
    return { retrying:1,escalated:0 };
  });
}

async function recordObservation(database, job, workerId, now, observed) {
  return database.transaction(async c => {
    const intent = await claimedIntent(c,job,workerId);
    if (!intent) return { observed:0,pending:0,terminalUnpaid:0,expiredOrders:0,escalated:0,retrying:0 };
    if (!reconcilableStates.includes(intent.payment_state)) {
      await c.query(`UPDATE myfin.online_payment_reconciliation_jobs
        SET state='closed',resolved_at=$3,lease_owner=NULL,lease_expires_at=NULL,updated_at=$3
        WHERE company_id=$1 AND intent_id=$2`, [intent.company_id,intent.id,now]);
      return { observed:0,pending:0,terminalUnpaid:0,expiredOrders:0,escalated:0,retrying:0 };
    }
    const mismatch = observationMismatch(intent,observed);
    if (mismatch) {
      await appendEvent(c,intent,{
        eventType:'provider_reconciliation_failed',
        providerEventKey:`auto-failure:${intent.attempt_count}:${mismatch}`,
        payloadDigest:digest(JSON.stringify([intent.id,intent.attempt_count,mismatch])),
        providerPaymentRequestId:intent.provider_payment_request_id || null,
        failureCode:mismatch,
      });
      await escalate(c,intent,now,mismatch);
      return { observed:0,pending:0,terminalUnpaid:0,expiredOrders:0,escalated:1,retrying:0 };
    }
    if (!intent.provider_payment_request_id) {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`online-payment-request:${intent.company_id}:${observed.requestId}`]);
      const binding = await c.query(
        `SELECT intent_id FROM myfin.online_payment_events
          WHERE company_id=$1 AND provider_payment_request_id=$2
            AND event_type=ANY($3::text[]) LIMIT 1`,
        [intent.company_id,observed.requestId,['checkout_created','checkout_discovered']],
      );
      if (binding.rowCount && binding.rows[0].intent_id!==intent.id) {
        await appendEvent(c,intent,{
          eventType:'provider_reconciliation_failed',
          providerEventKey:`auto-failure:${intent.attempt_count}:payment_request_mismatch`,
          payloadDigest:digest(JSON.stringify([intent.id,intent.attempt_count,'payment_request_mismatch'])),
          providerPaymentRequestId:intent.provider_payment_request_id || null,
          failureCode:'payment_request_mismatch',
        });
        await escalate(c,intent,now,'payment_request_mismatch');
        return { observed:0,pending:0,terminalUnpaid:0,expiredOrders:0,escalated:1,retrying:0 };
      }
    }
    const discovered = !intent.provider_payment_request_id;
    const evidenceDigest = observationDigest(observed);
    await appendEvent(c,intent,{
      eventType:discovered?'checkout_discovered':'provider_status_observed',
      providerEventKey:`auto-status:${observed.requestId}:${observed.status}:${evidenceDigest}`,
      payloadDigest:evidenceDigest,providerPaymentRequestId:observed.requestId,
      providerStatus:observed.status,checkoutUrl:discovered?observed.checkoutUrl:null,
      observedAmountSen:observed.amountSen,observedCurrencyCode:observed.currencyCode,
      providerOccurredAt:observed.updatedAt,
    });
    if (terminalUnpaidStatuses.has(observed.status)) {
      const expired = await expireTerminalOrder(c,intent,observed.status,now);
      await c.query(`UPDATE myfin.online_payment_reconciliation_jobs
        SET state='terminal_unpaid',last_outcome_code=$3,resolved_at=$4,
            lease_owner=NULL,lease_expires_at=NULL,updated_at=$4
        WHERE company_id=$1 AND intent_id=$2`,
      [intent.company_id,intent.id,observed.status,now]);
      return { observed:1,pending:0,terminalUnpaid:1,expiredOrders:expired?1:0,escalated:0,retrying:0 };
    }
    if (observed.status==='completed') {
      await escalate(c,{...intent,provider_payment_request_id:observed.requestId},now,
        'completed_without_signed_webhook','completed');
      return { observed:1,pending:0,terminalUnpaid:0,expiredOrders:0,escalated:1,retrying:0 };
    }
    await scheduleRetry(c,intent,now,'pending');
    return { observed:1,pending:1,terminalUnpaid:0,expiredOrders:0,escalated:0,retrying:1 };
  });
}

/**
 * Reconcile a bounded set outside SQL transactions. Provider lookups are
 * advisory only: only a signed completion webhook can confirm a payment.
 */
export async function runOnlinePaymentReconciliation(database, runtime, {
  now = new Date(),limit = 25,workerId = `payment-reconciliation-${randomUUID()}`,
} = {}) {
  const instant = new Date(now),bounded = batchLimit(limit),owner = safeWorkerId(workerId);
  if (!Number.isFinite(instant.getTime())) throw new TypeError('invalid_payment_reconciliation_time');
  const empty = { enabled:Boolean(runtime?.enabled),seeded:0,closed:0,claimed:0,observed:0,
    pending:0,terminalUnpaid:0,expiredOrders:0,retrying:0,escalated:0,openEscalations:0,hasMore:false };
  if (!runtime?.enabled) return empty;
  const prepared = await database.transaction(async c => {
    const closed = await closeSettledJobs(c,instant);
    const seeded = await seedJobs(c,instant,bounded);
    const escalated = await escalateExhausted(c,instant,bounded);
    const jobs = await claimJobs(c,instant,bounded,owner);
    return { closed,seeded,escalated,jobs };
  });
  const totals = { ...empty,enabled:true,seeded:prepared.seeded,closed:prepared.closed,
    claimed:prepared.jobs.length,escalated:prepared.escalated };
  for (const job of prepared.jobs) {
    let intent;
    try {
      intent = await database.transaction(c => claimedIntent(c,job,owner));
      if (!intent) continue;
      const credentials = runtime.credentialsFor(intent.secret_ref_snapshot);
      const observed = intent.provider_payment_request_id
        ? await runtime.adapter.getPaymentRequest({
          apiKey:credentials.apiKey,environment:intent.provider_environment,
          requestId:intent.provider_payment_request_id,
        })
        : await runtime.adapter.findPaymentRequestByReference({
          apiKey:credentials.apiKey,environment:intent.provider_environment,
          referenceNumber:intent.provider_reference,
        });
      const result = await recordObservation(database,job,owner,instant,observed);
      for (const key of ['observed','pending','terminalUnpaid','expiredOrders','retrying','escalated'])
        totals[key] += result[key] || 0;
    } catch (error) {
      const result = await recordFailure(database,job,owner,instant,providerFailureCode(error));
      totals.retrying += result.retrying;
      totals.escalated += result.escalated;
    }
  }
  totals.openEscalations = Number((await database.transaction(c => c.query(
    `SELECT count(*)::integer AS count FROM myfin.online_payment_reconciliation_jobs
      WHERE state='operator_escalation'`,
  ))).rows[0]?.count || 0);
  totals.hasMore = prepared.seeded===bounded || prepared.jobs.length===bounded ||
    prepared.escalated===bounded;
  return totals;
}

export const paymentGatewayMaintenanceInternals = Object.freeze({
  batchLimit,retryDelay,observationMismatch,providerFailureCode,maxAttempts,budgetHours,
  initialDelayMinutes,leaseMilliseconds,reconcilableStates,terminalUnpaidStatuses,
});
