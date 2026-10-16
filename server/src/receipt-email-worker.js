import { pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import { loadConfig } from './config.js';
import { createDatabase } from './database.js';

const retryMinutes = Object.freeze([1,5,15,30,60,180,360,720]);
const terminalCodes = new Set(['smtp_authentication_failed','recipient_rejected','message_rejected']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function configurationError() {
  return Object.assign(new Error('invalid_receipt_email_configuration'), { code:'invalid_receipt_email_configuration' });
}

export function createReceiptEmailRuntime(env = process.env, readFile = readFileSync) {
  const enabled = String(env.RECEIPT_EMAIL_ENABLED || 'false').toLowerCase() === 'true';
  if (!enabled) return Object.freeze({ enabled:false });
  const host = String(env.RECEIPT_SMTP_ADDRESS || ''), port = Number(env.RECEIPT_SMTP_PORT || 587),
    username = String(env.RECEIPT_SMTP_USERNAME || ''), passwordFile = String(env.RECEIPT_SMTP_PASSWORD_FILE || ''),
    fromAddress = String(env.RECEIPT_EMAIL_FROM_ADDRESS || '').toLowerCase(),
    fromName = String(env.RECEIPT_EMAIL_FROM_NAME || 'MyFin Receipts'),
    tlsServername = String(env.RECEIPT_SMTP_TLS_SERVERNAME || '');
  if (!(isIP(host) || /^[A-Za-z0-9.-]{1,253}$/.test(host)) || ![465,587,2525].includes(port) ||
      !username || username.length > 254 || /[\r\n\0]/.test(username) ||
      !passwordFile.startsWith('/') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddress) ||
      !fromName || fromName.length > 120 || /[\r\n\0]/.test(fromName) ||
      !/^[A-Za-z0-9.-]{1,253}$/.test(tlsServername) || isIP(tlsServername)) throw configurationError();
  let password;
  try { password = readFile(passwordFile,'utf8').replace(/\r?\n$/,''); } catch { throw configurationError(); }
  if (!password || password === 'disabled' || password.length > 4096 || /[\r\n\0]/.test(password)) throw configurationError();
  return Object.freeze({ enabled:true,host,port,secure:port===465,username,password,fromAddress,fromName,tlsServername });
}

export function receiptEmailWorkerIdentity(base = 'receipt-email-worker', nonce = randomUUID()) {
  if (!/^[A-Za-z0-9._:-]{1,91}$/.test(String(base || '')) || !uuidPattern.test(String(nonce || '')))
    throw new TypeError('invalid_receipt_email_worker_id');
  return `${base}:${nonce}`;
}

export function classifySmtpFailure(error) {
  const code = String(error?.code || ''), command = String(error?.command || ''), response = Number(error?.responseCode || 0);
  if (code === 'EAUTH' || response === 535) return { code:'smtp_authentication_failed',retry:false,unknown:false };
  if ([550,551,552,553].includes(response) || (Array.isArray(error?.rejected) && error.rejected.length))
    return { code:'recipient_rejected',retry:false,unknown:false };
  if (response >= 500 && response < 600) return { code:'message_rejected',retry:false,unknown:false };
  if (response >= 400 && response < 500) return { code:'smtp_temporary_rejection',retry:true,unknown:false };
  if (command === 'CONN' || ['ECONNECTION','EDNS','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH'].includes(code))
    return { code:'smtp_connect_unavailable',retry:true,unknown:false };
  // A timeout, socket close after DATA, or process interruption may happen
  // after the SMTP server accepted the message. Never auto-resend it.
  return { code:'delivery_outcome_unknown',retry:false,unknown:true };
}

function retryAt(now, attemptCount) {
  const delay = retryMinutes[Math.min(Math.max(Number(attemptCount) - 1,0),retryMinutes.length - 1)];
  return new Date(new Date(now).getTime()+delay*60_000);
}

export async function claimReceiptEmailDeliveries(database, {
  workerId, now = new Date(), limit = 10, leaseMs = 120000,
} = {}) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime()) || !/^[A-Za-z0-9._:-]{1,128}$/.test(String(workerId || '')) ||
      !Number.isInteger(limit) || limit < 1 || limit > 25 ||
      !Number.isInteger(leaseMs) || leaseMs < 30000 || leaseMs > 300000)
    throw new TypeError('invalid_receipt_email_claim');
  return database.transaction(async c => {
    const stale = (await c.query(
      `UPDATE myfin.receipt_email_deliveries SET state='delivery_unknown',lease_owner=NULL,
          lease_expires_at=NULL,last_error_code='delivery_outcome_unknown',updated_at=$1
        WHERE state='running' AND lease_expires_at<=$1 RETURNING company_id,id,attempt_count`, [instant])).rows;
    for (const row of stale) await c.query(
      `INSERT INTO myfin.receipt_email_events(company_id,id,delivery_id,event_type,error_code,attempt_count,created_at)
       VALUES($1,$2,$3,'delivery_unknown','delivery_outcome_unknown',$4,$5)`,
      [row.company_id,randomUUID(),row.id,row.attempt_count,instant]);

    const exhausted = (await c.query(
      `UPDATE myfin.receipt_email_deliveries SET state='failed',last_error_code='retry_budget_exhausted',
          updated_at=$1 WHERE state IN ('queued','retry_wait') AND
          (attempt_count>=max_attempts OR retry_budget_expires_at<=$1)
        RETURNING company_id,id,attempt_count`, [instant])).rows;
    for (const row of exhausted) await c.query(
      `INSERT INTO myfin.receipt_email_events(company_id,id,delivery_id,event_type,error_code,attempt_count,created_at)
       VALUES($1,$2,$3,'failed','retry_budget_exhausted',$4,$5)`,
      [row.company_id,randomUUID(),row.id,row.attempt_count,instant]);

    const leaseExpiresAt = new Date(instant.getTime()+leaseMs);
    const jobs = (await c.query(
      `WITH candidates AS (
         SELECT company_id,id FROM myfin.receipt_email_deliveries
          WHERE state IN ('queued','retry_wait') AND next_attempt_at<=$1
            AND attempt_count<max_attempts AND retry_budget_expires_at>$1
          ORDER BY next_attempt_at,created_at,company_id,id
          FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE myfin.receipt_email_deliveries delivery
          SET state='running',attempt_count=delivery.attempt_count+1,last_error_code='',
              lease_owner=$3,lease_expires_at=$4,updated_at=$1
         FROM candidates WHERE delivery.company_id=candidates.company_id AND delivery.id=candidates.id
       RETURNING delivery.*`, [instant,limit,workerId,leaseExpiresAt])).rows;
    for (const row of jobs) await c.query(
      `INSERT INTO myfin.receipt_email_events(company_id,id,delivery_id,event_type,attempt_count,created_at)
       VALUES($1,$2,$3,'attempt_started',$4,$5)`,
      [row.company_id,randomUUID(),row.id,row.attempt_count,instant]);
    return { stale:stale.length,exhausted:exhausted.length,jobs };
  });
}

export async function sendReceiptEmail(runtime, delivery, { createTransport = nodemailer.createTransport } = {}) {
  if (!runtime?.enabled) throw configurationError();
  const domain = runtime.fromAddress.slice(runtime.fromAddress.lastIndexOf('@')+1);
  const transport = createTransport({
    host:runtime.host,port:runtime.port,secure:runtime.secure,requireTLS:!runtime.secure,
    auth:{user:runtime.username,pass:runtime.password},
    tls:{rejectUnauthorized:true,servername:runtime.tlsServername},
    connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000,
    pool:false,disableFileAccess:true,disableUrlAccess:true,
  });
  try {
    const result = await transport.sendMail({
      from:{name:runtime.fromName,address:runtime.fromAddress},to:delivery.recipient,
      subject:delivery.subject,text:delivery.text_body,html:delivery.html_body,
      messageId:`<receipt-${delivery.id}@${domain}>`,
      headers:{'X-MyFin-Delivery-ID':delivery.id},
    });
    if (!result?.accepted?.some(value => String(value).toLowerCase() === delivery.recipient.toLowerCase()))
      throw Object.assign(new Error('recipient_rejected'), { code:'EENVELOPE',responseCode:550,rejected:[delivery.recipient] });
    return true;
  } finally { transport.close?.(); }
}

async function finishDelivery(database, delivery, workerId, outcome, now = new Date()) {
  const instant = new Date(now);
  return database.transaction(async c => {
    const locked = (await c.query(
      `SELECT * FROM myfin.receipt_email_deliveries WHERE company_id=$1 AND id=$2
        AND state='running' AND lease_owner=$3 AND attempt_count=$4 FOR UPDATE`,
      [delivery.company_id,delivery.id,workerId,delivery.attempt_count])).rows[0];
    if (!locked) return false;
    let state, errorCode = '', nextAttemptAt = locked.next_attempt_at, acceptedAt = null;
    if (outcome.ok) { state='sent';acceptedAt=instant; }
    else if (outcome.failure.unknown) { state='delivery_unknown';errorCode=outcome.failure.code; }
    else if (outcome.failure.retry && locked.attempt_count<locked.max_attempts &&
      new Date(locked.retry_budget_expires_at)>instant) {
      state='retry_wait';errorCode=outcome.failure.code;
      nextAttemptAt=new Date(Math.min(retryAt(instant,locked.attempt_count).getTime(),new Date(locked.retry_budget_expires_at).getTime()));
    } else { state='failed';errorCode=terminalCodes.has(outcome.failure.code)?outcome.failure.code:'retry_budget_exhausted'; }
    const saved = await c.query(
      `UPDATE myfin.receipt_email_deliveries SET state=$5,next_attempt_at=$6,lease_owner=NULL,
          lease_expires_at=NULL,last_error_code=$7,accepted_at=$8,updated_at=$9
        WHERE company_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND attempt_count=$4
        RETURNING id`, [delivery.company_id,delivery.id,workerId,delivery.attempt_count,state,nextAttemptAt,errorCode,acceptedAt,instant]);
    if (!saved.rowCount) return false;
    const eventType = state === 'retry_wait' ? 'retry_scheduled' : state;
    await c.query(
      `INSERT INTO myfin.receipt_email_events(company_id,id,delivery_id,event_type,error_code,attempt_count,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [delivery.company_id,randomUUID(),delivery.id,eventType,errorCode,delivery.attempt_count,instant]);
    return true;
  });
}

export async function runReceiptEmailWorkerCycle(database, runtime, {
  workerId = receiptEmailWorkerIdentity(), now = new Date(), limit = 1,
  send = sendReceiptEmail, clock = () => new Date(),
} = {}) {
  if (!runtime?.enabled) return { enabled:false,claimed:0,sent:0,retrying:0,failed:0,unknown:0,stale:0,exhausted:0 };
  const claimed = await claimReceiptEmailDeliveries(database,{workerId,now,limit});
  const result = { enabled:true,claimed:claimed.jobs.length,sent:0,retrying:0,failed:0,unknown:0,
    stale:claimed.stale,exhausted:claimed.exhausted };
  for (const delivery of claimed.jobs) {
    try {
      await send(runtime,delivery);
      if (await finishDelivery(database,delivery,workerId,{ok:true},clock())) result.sent++;
    } catch (error) {
      const failure = classifySmtpFailure(error);
      if (await finishDelivery(database,delivery,workerId,{ok:false,failure},clock())) {
        if (failure.unknown) result.unknown++;
        else if (failure.retry) result.retrying++;
        else result.failed++;
      }
    }
  }
  return result;
}

export async function startReceiptEmailWorker(database, runtime, {
  workerId = receiptEmailWorkerIdentity(),pollMs = 2000,signals = process,onEvent = () => {},
  runCycle = runReceiptEmailWorkerCycle,
} = {}) {
  if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 300000) throw new TypeError('invalid_receipt_email_poll');
  let stopping = false, wake;
  const stop = () => { stopping=true;wake?.(); };
  signals.on('SIGTERM',stop);signals.on('SIGINT',stop);
  try {
    while (!stopping) {
      try { onEvent('receipt_email_worker_cycle',await runCycle(database,runtime,{workerId})); }
      catch { onEvent('receipt_email_worker_cycle_failed'); }
      if (!stopping) await new Promise(resolve => {
        const timer=setTimeout(resolve,pollMs);wake=()=>{clearTimeout(timer);resolve();};
      });
    }
  } finally {
    signals.removeListener('SIGTERM',stop);signals.removeListener('SIGINT',stop);await database.close();
  }
}

async function main() {
  try {
    const config=loadConfig(),database=createDatabase({...config.database,application_name:'myfin-receipt-email-worker'},
      {onError:event=>process.stderr.write(`${event}\n`)}),runtime=createReceiptEmailRuntime(process.env);
    await startReceiptEmailWorker(database,runtime,{
      workerId:receiptEmailWorkerIdentity(process.env.RECEIPT_EMAIL_WORKER_ID || 'receipt-email-worker'),
      pollMs:Number(process.env.RECEIPT_EMAIL_WORKER_POLL_MS || 2000),
      onEvent:(event,result)=>{
        if (event==='receipt_email_worker_cycle_failed' || result?.unknown || result?.exhausted)
          process.stderr.write(`${event}\n`);
      },
    });
  } catch {
    process.stderr.write('Receipt email worker startup failed: check configuration and database availability.\n');
    process.exitCode=1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export const receiptEmailWorkerInternals = Object.freeze({ retryAt,finishDelivery,retryMinutes });
