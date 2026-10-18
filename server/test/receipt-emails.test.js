import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  receiptEmailFeatureEnabled, registerReceiptEmails, renderReceiptEmail, receiptEmailInternals,
} from '../src/receipt-emails.js';
import {
  classifySmtpFailure, claimReceiptEmailDeliveries, createReceiptEmailRuntime,
  receiptEmailWorkerIdentity, sendReceiptEmail,
} from '../src/receipt-email-worker.js';

const companyId='company-1',saleId='sale-1',actor={id:'staff-1',role:'operator'};
const sale={id:saleId,company_id:companyId,source:'pos',schemaVersion:3,type:'Invoice',number:'POS-100',
  status:'Paid',date:'2026-10-17T02:00:00.000Z',cashierName:'Cashier',customerName:'Customer',customerEmail:'customer@example.test',
  items:[{productId:'p-1',desc:'Latte',qty:1,unit:'cup',price:8}],subtotal:8,discount:0,discountAmount:0,
  taxRate:0,tax:0,total:8,paymentMethod:'Cash',received:10,change:2,
  storeSnapshot:{name:'Ba|Li Coffee',address:'Kuala Lumpur',phone:'',registration:'',currency:'RM',footer:'Thank you',paperWidth:'80'}};

function appRoutes(){const routes=new Map();return {routes,get(path,handler){routes.set(`GET ${path}`,handler);},post(path,handler){routes.set(`POST ${path}`,handler);}};}

test('receipt email rendering uses the immutable receipt snapshot and escapes untrusted HTML',()=>{
  const message=renderReceiptEmail({...sale,number:'POS-100\r\nBcc: attacker@example.test',
    storeSnapshot:{...sale.storeSnapshot,name:'<script>alert(1)</script>'}});
  assert.doesNotMatch(message.subject,/\r|\n/);
  assert.match(message.textBody,/TOTAL: RM 8\.00/);
  assert.match(message.textBody,/does not subscribe you to marketing/);
  assert.doesNotMatch(message.htmlBody,/<script>/);
  assert.match(message.htmlBody,/&lt;script&gt;/);
});

test('feature flag is explicitly opt-in',()=>{
  assert.equal(receiptEmailFeatureEnabled({}),false);
  assert.equal(receiptEmailFeatureEnabled({RECEIPT_EMAIL_ENABLED:'true'}),true);
  assert.equal(receiptEmailFeatureEnabled({RECEIPT_EMAIL_ENABLED:'TRUE'}),true);
  assert.equal(receiptEmailFeatureEnabled({RECEIPT_EMAIL_ENABLED:'1'}),false);
});

test('disabled API rejects enqueue before reading a transaction and still exposes status capability',async()=>{
  const app=appRoutes();let queries=0;
  registerReceiptEmails(app,{enabled:false,audit:async()=>{},scoped:(_req,fn)=>fn({query:async()=>{queries++;return {rows:[]};}},companyId)});
  await assert.rejects(app.routes.get('POST /api/companies/:company/transactions/:transactionId/receipt-emails')({
    identity:actor,params:{company:companyId,transactionId:saleId},body:{recipient:'customer@example.test',idempotencyKey:randomUUID()},
  }),error=>error.statusCode===503&&error.message==='receipt_email_unavailable');
  assert.equal(queries,0);
});

test('API rejects non-v4 idempotency keys before database work',async()=>{
  const app=appRoutes();let queries=0;
  registerReceiptEmails(app,{enabled:true,audit:async()=>{},scoped:(_req,fn)=>fn({query:async()=>{queries++;return {rows:[]};}},companyId)});
  await assert.rejects(app.routes.get('POST /api/companies/:company/transactions/:transactionId/receipt-emails')({
    identity:actor,params:{company:companyId,transactionId:saleId},
    body:{recipient:'customer@example.test',idempotencyKey:'6ba7b810-9dad-11d1-80b4-00c04fd430c8'},
  }),error=>error.statusCode===400&&error.message==='invalid_input');
  assert.equal(queries,0);
});

test('enqueue is tenant scoped, idempotent and writes one immutable queue event',async()=>{
  const app=appRoutes(),calls=[];let audits=0;
  const delivery={company_id:companyId,id:randomUUID(),transaction_id:saleId,recipient:'customer@example.test',state:'queued',
    attempt_count:0,max_attempts:8,next_attempt_at:new Date(),accepted_at:null,created_at:new Date(),updated_at:new Date(),last_error_code:''};
  const client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.includes('FROM myfin.transactions'))return {rows:[{company_id:companyId,id:saleId,actor_id:actor.id,source:'pos',data:sale}]};
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[{}]};
    if(sql.includes('WHERE company_id=$1 AND idempotency_key=$2'))return {rows:[]};
    if(sql.includes('transaction_id=$2 AND recipient=$3'))return {rows:[]};
    if(sql.includes('count(*)::integer'))return {rows:[{count:0}]};
    if(sql.includes('INSERT INTO myfin.receipt_email_deliveries'))return {rowCount:1,rows:[delivery]};
    if(sql.includes('INSERT INTO myfin.receipt_email_events'))return {rowCount:1,rows:[]};
    throw new Error(`unexpected query: ${sql}`);
  }};
  registerReceiptEmails(app,{enabled:true,audit:async()=>{audits++;},scoped:(_req,fn)=>fn(client,companyId)});
  const result=await app.routes.get('POST /api/companies/:company/transactions/:transactionId/receipt-emails')({
    identity:actor,params:{company:companyId,transactionId:saleId},body:{recipient:'CUSTOMER@example.test',idempotencyKey:randomUUID()},
  });
  assert.equal(result.state,'queued');assert.equal(result.recipient,'customer@example.test');assert.equal(audits,1);
  const insert=calls.find(call=>call.sql.includes('INSERT INTO myfin.receipt_email_deliveries'));
  assert.equal(insert.params[0],companyId);assert.equal(insert.params[2],saleId);assert.equal(insert.params[4],actor.id);
  assert.equal(calls.filter(call=>call.sql.includes('INSERT INTO myfin.receipt_email_events')).length,1);
});

test('idempotent replay requires the exact transaction, recipient and rendered message',async()=>{
  const message=renderReceiptEmail(sale),key=randomUUID(),existing={company_id:companyId,id:randomUUID(),transaction_id:saleId,
    idempotency_key:key,recipient:'customer@example.test',subject:message.subject,text_body:message.textBody,html_body:message.htmlBody};
  const client={query:async(sql)=>{
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[{}]};
    if(sql.includes('WHERE company_id=$1 AND idempotency_key=$2'))return {rows:[existing]};
    throw new Error('unexpected query');
  }};
  assert.equal((await receiptEmailInternals.insertDelivery(client,{companyId,transactionId:saleId,recipient:existing.recipient,
    idempotencyKey:key,actorId:actor.id,message})).id,existing.id);
  await assert.rejects(receiptEmailInternals.insertDelivery(client,{companyId,transactionId:saleId,recipient:'changed@example.test',
    idempotencyKey:key,actorId:actor.id,message}),error=>error.statusCode===409&&error.message==='receipt_email_payload_changed');
});

test('ordinary staff cannot create another copy after any prior delivery outcome',async()=>{
  const message=renderReceiptEmail(sale),prior={company_id:companyId,id:randomUUID(),transaction_id:saleId,
    idempotency_key:randomUUID(),recipient:'customer@example.test',subject:message.subject,
    text_body:message.textBody,html_body:message.htmlBody,state:'failed'};
  let inserts=0;
  const client={query:async(sql)=>{
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[{}]};
    if(sql.includes('WHERE company_id=$1 AND idempotency_key=$2'))return {rows:[]};
    if(sql.includes('transaction_id=$2 AND recipient=$3'))return {rows:[prior]};
    if(sql.includes('INSERT INTO myfin.receipt_email_deliveries')){inserts++;return {rowCount:1,rows:[]};}
    throw new Error(`unexpected query: ${sql}`);
  }};
  await assert.rejects(receiptEmailInternals.insertDelivery(client,{companyId,transactionId:saleId,
    recipient:prior.recipient,idempotencyKey:randomUUID(),actorId:actor.id,message}),
  error=>error.statusCode===409&&error.message==='receipt_email_already_requested');
  assert.equal(inserts,0);
});

test('explicit resend requires the latest delivery to match the server-validated outcome',async()=>{
  const message=renderReceiptEmail(sale),prior={company_id:companyId,id:randomUUID(),transaction_id:saleId,
    idempotency_key:randomUUID(),recipient:'customer@example.test',subject:message.subject,
    text_body:message.textBody,html_body:message.htmlBody,state:'running'};
  const client={query:async(sql)=>{
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[{}]};
    if(sql.includes('WHERE company_id=$1 AND idempotency_key=$2'))return {rows:[]};
    if(sql.includes('transaction_id=$2 AND recipient=$3'))return {rows:[prior]};
    throw new Error(`unexpected query: ${sql}`);
  }};
  await assert.rejects(receiptEmailInternals.insertDelivery(client,{companyId,transactionId:saleId,
    recipient:prior.recipient,idempotencyKey:randomUUID(),actorId:actor.id,message,
    requiredPrior:{states:['sent']}}),error=>error.statusCode===409&&error.message==='receipt_email_resend_not_allowed');
  await assert.rejects(receiptEmailInternals.insertDelivery(client,{companyId,transactionId:saleId,
    recipient:prior.recipient,idempotencyKey:randomUUID(),actorId:actor.id,message,
    requiredPrior:{id:randomUUID(),states:['failed','delivery_unknown']}}),
  error=>error.statusCode===409&&error.message==='receipt_email_resend_not_allowed');
});

test('SMTP runtime reads a file only when explicitly enabled and enforces validated TLS identity',()=>{
  let reads=0;
  assert.deepEqual(createReceiptEmailRuntime({},()=>{reads++;return 'secret';}),{enabled:false});assert.equal(reads,0);
  const env={RECEIPT_EMAIL_ENABLED:'true',RECEIPT_SMTP_ADDRESS:'192.168.1.18',RECEIPT_SMTP_PORT:'587',
    RECEIPT_SMTP_USERNAME:'receipts@finn3.com',RECEIPT_SMTP_PASSWORD_FILE:'/run/secrets/receipt_smtp_password',
    RECEIPT_SMTP_TLS_SERVERNAME:'smtp.finn3.com',RECEIPT_EMAIL_FROM_ADDRESS:'receipts@finn3.com',RECEIPT_EMAIL_FROM_NAME:'Finn3 receipts'};
  const runtime=createReceiptEmailRuntime(env,path=>{reads++;assert.equal(path,env.RECEIPT_SMTP_PASSWORD_FILE);return 'secret\n';});
  assert.equal(runtime.password,'secret');assert.equal(runtime.host,'192.168.1.18');assert.equal(runtime.secure,false);assert.equal(reads,1);
  assert.throws(()=>createReceiptEmailRuntime({...env,RECEIPT_SMTP_TLS_SERVERNAME:'192.168.1.18'},()=> 'secret'),{code:'invalid_receipt_email_configuration'});
  assert.throws(()=>createReceiptEmailRuntime(env,()=> 'disabled\n'),{code:'invalid_receipt_email_configuration'});
});

test('SMTP failure classes retry only known pre-acceptance or explicit temporary failures',()=>{
  assert.deepEqual(classifySmtpFailure({code:'ECONNECTION',command:'CONN'}),{code:'smtp_connect_unavailable',retry:true,unknown:false});
  assert.deepEqual(classifySmtpFailure({responseCode:451}),{code:'smtp_temporary_rejection',retry:true,unknown:false});
  assert.deepEqual(classifySmtpFailure({code:'EAUTH'}),{code:'smtp_authentication_failed',retry:false,unknown:false});
  assert.deepEqual(classifySmtpFailure({code:'ETIMEDOUT',command:'DATA'}),{code:'delivery_outcome_unknown',retry:false,unknown:true});
});

test('SMTP sender requires TLS, blocks file/URL access and uses a deterministic message id',async()=>{
  const captured={};let closed=0;
  const runtime={enabled:true,host:'smtp.finn3.com',port:587,secure:false,username:'receipts@finn3.com',password:'secret',
    fromAddress:'receipts@finn3.com',fromName:'Finn3 receipts',tlsServername:'smtp.finn3.com'};
  await sendReceiptEmail(runtime,{id:'26fd6e24-a245-4cc0-b2b4-8c3affed322a',recipient:'customer@example.test',subject:'Receipt',text_body:'text',html_body:'<p>text</p>'},{createTransport:options=>{
    Object.assign(captured,{options});return {sendMail:async message=>{captured.message=message;return {accepted:['customer@example.test']};},close:()=>{closed++;}};
  }});
  assert.equal(captured.options.requireTLS,true);assert.equal(captured.options.tls.rejectUnauthorized,true);
  assert.equal(captured.options.disableFileAccess,true);assert.equal(captured.options.disableUrlAccess,true);
  assert.equal(captured.message.messageId,'<receipt-26fd6e24-a245-4cc0-b2b4-8c3affed322a@finn3.com>');assert.equal(closed,1);
});

test('queue claim marks stale outcomes unknown, exhausts budgets and uses SKIP LOCKED leases',async()=>{
  const calls=[],job={company_id:companyId,id:randomUUID(),attempt_count:1};
  const database={transaction:fn=>fn({query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.startsWith("UPDATE myfin.receipt_email_deliveries SET state='delivery_unknown'"))return {rows:[{...job,attempt_count:2}]};
    if(sql.startsWith("UPDATE myfin.receipt_email_deliveries SET state='failed'"))return {rows:[{...job,attempt_count:8}]};
    if(sql.includes('WITH candidates AS'))return {rows:[job]};
    if(sql.includes('INSERT INTO myfin.receipt_email_events'))return {rows:[],rowCount:1};
    throw new Error('unexpected query');
  }})};
  const result=await claimReceiptEmailDeliveries(database,{workerId:'worker-1',now:new Date('2026-10-17T00:00:00Z'),limit:5});
  assert.equal(result.stale,1);assert.equal(result.exhausted,1);assert.equal(result.jobs.length,1);
  assert.ok(calls.some(call=>/FOR UPDATE SKIP LOCKED LIMIT \$2/.test(call.sql)));
  assert.equal(calls.filter(call=>call.sql.includes('INSERT INTO myfin.receipt_email_events')).length,3);
  assert.match(receiptEmailWorkerIdentity('mail','26fd6e24-a245-4cc0-b2b4-8c3affed322a'),/^mail:/);
});

test('migration, ACL and deployment keep queue history immutable and SMTP egress isolated',async()=>{
  const [migration,runtime,devGrant,prodGrant,compose,ui,docs]=await Promise.all([
    readFile(new URL('../../db/migrations/0042_receipt_email_delivery.sql',import.meta.url),'utf8'),
    readFile(new URL('../src/runtime-privileges.js',import.meta.url),'utf8'),
    readFile(new URL('../../db/grant-development-runtime.sql',import.meta.url),'utf8'),
    readFile(new URL('../../db/grant-production-runtime.sql',import.meta.url),'utf8'),
    readFile(new URL('../../deploy/compose.yml',import.meta.url),'utf8'),
    readFile(new URL('../../src/components/dashboard/pos/ReceiptEmailPanel.vue',import.meta.url),'utf8'),
    readFile(new URL('../../docs/RECEIPT_EMAIL_DELIVERY.md',import.meta.url),'utf8'),
  ]);
  assert.match(migration,/CREATE TABLE myfin\.receipt_email_deliveries/);assert.match(migration,/CREATE TABLE myfin\.receipt_email_events/);
  assert.match(migration,/receipt_email_delivery_immutable/);assert.match(migration,/receipt_email_event_immutable/);
  assert.match(migration,/delivery_unknown is intentionally not retried automatically/);
  assert.doesNotMatch(migration,/smtp_password|smtp_username/i);
  assert.match(runtime,/0048_storefront_asset_library\.sql/);
  for(const grant of [devGrant,prodGrant]){assert.match(grant,/SELECT,INSERT,UPDATE ON myfin\.receipt_email_deliveries/);assert.match(grant,/GRANT INSERT ON myfin\.receipt_email_events/);assert.doesNotMatch(grant,/DELETE[^;]*receipt_email/);}
  const api=compose.match(/^  api:[\s\S]*?(?=^  report-worker:)/m)?.[0]||'',worker=compose.match(/^  receipt-email-worker:[\s\S]*?(?=^networks:)/m)?.[0]||'';
  assert.doesNotMatch(api,/receipt_smtp_password|smtp-egress/);assert.match(worker,/profiles: \[receipt-email\]/);assert.match(worker,/secrets: \[db_password, receipt_smtp_password\]/);assert.match(worker,/networks: \[nexus-data, smtp-egress\]/);
  assert.match(ui,/Send receipt email/);assert.match(ui,/email draft or PDF fallback/);assert.match(docs,/send-only SMTP identity/);assert.match(docs,/firewall/);
});
