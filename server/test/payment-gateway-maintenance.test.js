import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PaymentProviderError } from '../src/payment-gateway-hitpay.js';
import {
  paymentGatewayMaintenanceInternals,runOnlinePaymentReconciliation,
} from '../src/payment-gateway-maintenance.js';

const now = new Date('2026-10-16T04:00:00.000Z');

function fixture({ status='pending',providerError='',attemptCount=1 }={}) {
  const calls=[],events=[];
  const state={ lifecycle:'running',attemptCount,openEscalations:0,orderExpired:false };
  const intent={
    company_id:'company-a',id:'intent-a',order_id:'order-a',provider_reference:'reference-a',
    amount_sen:1290,currency_code:'MYR',provider_environment:'sandbox',
    secret_ref_snapshot:'secretref://myfin/company-a/hitpay',
    provider_payment_request_id:'request-a',payment_state:'pending',attempt_count:attemptCount,
    budget_expires_at:'2026-10-17T03:00:00.000Z',
  };
  const query=async (sql,params=[])=>{
    calls.push({sql,params});
    if (sql.includes('UPDATE myfin.online_payment_reconciliation_jobs job') &&
        sql.includes("payment.state<>ALL")) return { rowCount:0,rows:[] };
    if (sql.includes('INSERT INTO myfin.online_payment_reconciliation_jobs'))
      return { rowCount:0,rows:[] };
    if (sql.includes('SELECT job.company_id,job.intent_id AS id')) return { rowCount:0,rows:[] };
    if (sql.includes('WITH candidates AS') && sql.includes("SET state='running'"))
      return { rowCount:1,rows:[{ company_id:intent.company_id,intent_id:intent.id,
        attempt_count:attemptCount,budget_expires_at:intent.budget_expires_at }] };
    if (sql.includes('SELECT i.*,payment.provider_payment_request_id'))
      return { rowCount:1,rows:[{...intent}] };
    if (sql.includes('pg_advisory_xact_lock')) return { rowCount:1,rows:[{}] };
    if (sql.includes('SELECT id FROM myfin.online_payment_events')) return { rowCount:0,rows:[] };
    if (sql.includes('coalesce(max(event_no),0)+1'))
      return { rowCount:1,rows:[{event_no:events.length+1}] };
    if (sql.includes('INSERT INTO myfin.online_payment_events')) {
      events.push({type:params[4],key:params[5],status:params[8],failure:params[12]});
      return { rowCount:1,rows:[] };
    }
    if (sql.includes("SET state='retry_wait'")) {
      state.lifecycle='retry_wait'; return {rowCount:1,rows:[]};
    }
    if (sql.includes("SET state='operator_escalation'")) {
      state.lifecycle='operator_escalation';state.openEscalations=1;return {rowCount:1,rows:[]};
    }
    if (sql.includes("SET state='terminal_unpaid'")) {
      state.lifecycle='terminal_unpaid';return {rowCount:1,rows:[]};
    }
    if (sql.includes('SELECT status,payment_state,version FROM myfin.customer_order_requests'))
      return {rowCount:1,rows:[{status:'accepted',payment_state:'unpaid',version:3}]};
    if (sql.includes("SET status='expired'")) {
      state.orderExpired=true;return {rowCount:1,rows:[{id:'order-a'}]};
    }
    if (sql.includes('UPDATE myfin.customer_order_reservations') ||
        sql.includes('UPDATE myfin.customer_order_recipe_reservations')) return {rowCount:1,rows:[]};
    if (sql.includes('release_order_promotion_reservations')) return {rowCount:1,rows:[{count:1}]};
    if (sql.includes('INSERT INTO myfin.customer_order_events')) return {rowCount:1,rows:[]};
    if (sql.includes("count(*)::integer AS count") &&
        sql.includes('online_payment_reconciliation_jobs'))
      return {rowCount:1,rows:[{count:state.openEscalations}]};
    throw new Error(`unhandled_query:${sql.replace(/\s+/g,' ').slice(0,120)}`);
  };
  const database={transaction:fn=>fn({query})};
  const adapter={
    async getPaymentRequest() {
      if (providerError) throw new PaymentProviderError(providerError);
      return {requestId:'request-a',referenceNumber:'reference-a',amountSen:1290,
        currencyCode:'MYR',status,checkoutUrl:'https://securecheckout.sandbox.hit-pay.com/payment-request/a',
        updatedAt:'2026-10-16T03:59:00.000Z'};
    },
    async findPaymentRequestByReference() { throw new Error('unexpected_reference_search'); },
  };
  const runtime={enabled:true,adapter,credentialsFor:()=>({apiKey:'a'.repeat(20)})};
  return {database,runtime,calls,events,state};
}

test('automatic reconciliation records a pending observation and schedules a bounded retry',async()=>{
  const f=fixture();
  const result=await runOnlinePaymentReconciliation(f.database,f.runtime,{now,limit:5,workerId:'worker-a'});
  assert.equal(result.claimed,1);assert.equal(result.observed,1);assert.equal(result.pending,1);
  assert.equal(result.retrying,1);assert.equal(result.escalated,0);
  assert.equal(f.state.lifecycle,'retry_wait');assert.equal(f.state.orderExpired,false);
  assert.deepEqual(f.events.map(event=>[event.type,event.status,event.failure]),
    [['provider_status_observed','pending','']]);
});

test('only an exact provider terminal-unpaid observation expires the order and releases reservations',async()=>{
  const f=fixture({status:'expired'});
  const result=await runOnlinePaymentReconciliation(f.database,f.runtime,{now,limit:5,workerId:'worker-a'});
  assert.equal(result.terminalUnpaid,1);assert.equal(result.expiredOrders,1);
  assert.equal(f.state.lifecycle,'terminal_unpaid');assert.equal(f.state.orderExpired,true);
  assert.ok(f.calls.some(call=>call.sql.includes('UPDATE myfin.customer_order_reservations')));
  assert.ok(f.calls.some(call=>call.sql.includes('release_order_promotion_reservations')));
});

test('completed lookup stays fail-closed and escalates until a signed webhook arrives',async()=>{
  const f=fixture({status:'completed'});
  const result=await runOnlinePaymentReconciliation(f.database,f.runtime,{now,limit:5,workerId:'worker-a'});
  assert.equal(result.escalated,1);assert.equal(result.expiredOrders,0);
  assert.equal(f.state.lifecycle,'operator_escalation');assert.equal(f.state.orderExpired,false);
  assert.deepEqual(f.events.map(event=>[event.type,event.failure]),[
    ['provider_status_observed',''],['operator_escalation_required','completed_without_signed_webhook'],
  ]);
  assert.equal(f.calls.some(call=>call.sql.includes("SET status='expired'")),false);
});

test('unknown provider outcomes retry, then become a durable escalation at the attempt budget',async()=>{
  const retry=fixture({providerError:'provider_unavailable',attemptCount:4});
  const retryResult=await runOnlinePaymentReconciliation(retry.database,retry.runtime,
    {now,limit:5,workerId:'worker-a'});
  assert.equal(retryResult.retrying,1);assert.equal(retry.state.lifecycle,'retry_wait');
  assert.equal(retry.state.orderExpired,false);

  const exhausted=fixture({providerError:'provider_request_not_found',attemptCount:24});
  const result=await runOnlinePaymentReconciliation(exhausted.database,exhausted.runtime,
    {now,limit:5,workerId:'worker-a'});
  assert.equal(result.escalated,1);assert.equal(result.openEscalations,1);
  assert.equal(exhausted.state.lifecycle,'operator_escalation');
  assert.deepEqual(exhausted.events.map(event=>event.failure),[
    'provider_request_not_found','reconciliation_budget_exhausted',
  ]);
  assert.equal(exhausted.state.orderExpired,false);
});

test('lifecycle schema and worker contract are bounded, least-privilege and PII-free',async()=>{
  const [migration,worker,override]=await Promise.all([
    readFile(new URL('../../db/migrations/0040_payment_gateway_lifecycle.sql',import.meta.url),'utf8'),
    readFile(new URL('../src/report-worker.js',import.meta.url),'utf8'),
    readFile(new URL('../../deploy/payment-gateway.override.yml',import.meta.url),'utf8'),
  ]);
  assert.match(migration,/attempt_count integer[\s\S]*BETWEEN 0 AND 24/);
  assert.match(migration,/budget_expires_at timestamptz NOT NULL/);
  assert.match(migration,/operator_escalation/);
  assert.doesNotMatch(migration,/customer_email|customer_phone|contact_name|guest_name/);
  assert.match(worker,/runOnlinePaymentReconciliation/);
  assert.match(override,/report-worker:[\s\S]*PAYMENT_GATEWAY_ENABLED:[ ]*'true'/);
  assert.equal(paymentGatewayMaintenanceInternals.retryDelay(1),2);
  assert.equal(paymentGatewayMaintenanceInternals.retryDelay(24),60);
  assert.equal(paymentGatewayMaintenanceInternals.maxAttempts,24);
});
