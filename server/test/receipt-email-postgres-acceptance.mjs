// Explicit opt-in: creates and drops one database on a disposable, locally
// bound PostgreSQL 16 cluster with the exact marker below.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readMigrations,runMigrations } from '../src/migrations.js';
import { claimReceiptEmailDeliveries } from '../src/receipt-email-worker.js';

const marker='myfin-receipt-email-pg16',adminConnection=process.env.MYFIN_RECEIPT_EMAIL_DATABASE_URL||'';
if(process.env.MYFIN_RECEIPT_EMAIL_ACCEPTANCE!==marker||!adminConnection)throw Error('receipt_email_opt_in_required');
const parsed=new URL(adminConnection);
if(!['127.0.0.1','localhost','::1'].includes(parsed.hostname)||parsed.pathname!=='/postgres')throw Error('unsafe_receipt_email_target');
const admin=new pg.Client({connectionString:adminConnection});await admin.connect();
assert.match((await admin.query('SELECT version() AS version')).rows[0].version,/PostgreSQL 16\./);
assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name,marker);
const databaseName=`myfin_receipt_email_${randomUUID().replaceAll('-','').slice(0,16)}`;
const databaseUrl=new URL(adminConnection);databaseUrl.pathname=`/${databaseName}`;
let pool;
const database={transaction:async work=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}}};
const id=()=>randomUUID(),fingerprint='a'.repeat(64);

try{
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const migrator=new pg.Client({connectionString:databaseUrl.href});await migrator.connect();
  try{await migrator.query('CREATE SCHEMA myfin');const migrations=await readMigrations();assert.deepEqual(await runMigrations(migrator,migrations),migrations.map(row=>row.version));assert.deepEqual(await runMigrations(migrator,migrations),[]);}finally{await migrator.end();}
  pool=new pg.Pool({connectionString:databaseUrl.href,max:4});
  const workspace='workspace-email',company='company-email',actor='actor-email',sale='sale-email';
  await pool.query("INSERT INTO myfin.workspaces(id,name,slug) VALUES($1,'Email workspace','email-workspace')",[workspace]);
  await pool.query("INSERT INTO myfin.app_identities(id,display_name) VALUES($1,'Email cashier')",[actor]);
  await pool.query("INSERT INTO myfin.companies(id,name,workspace_id,slug,data) VALUES($1,'Email shop',$2,'email-shop','{}')",[company,workspace]);
  await pool.query(`INSERT INTO myfin.transactions(company_id,id,actor_id,source,total,fingerprint,data)
    VALUES($1,$2,$3,'pos',1,$4,$5)`,[company,sale,actor,fingerprint,{id:sale,number:'POS-EMAIL',status:'Paid',total:1}]);
  const anchor=new Date(),past=hours=>new Date(anchor.getTime()-hours*3600000),future=hours=>new Date(anchor.getTime()+hours*3600000);
  const insert=async({state='queued',attempt=0,created=past(1),budget=future(72),leaseOwner=null,leaseExpires=null}={})=>{
    const delivery=id();await pool.query(`INSERT INTO myfin.receipt_email_deliveries(
      company_id,id,transaction_id,idempotency_key,requested_by,recipient,subject,text_body,html_body,
      state,attempt_count,next_attempt_at,retry_budget_expires_at,lease_owner,lease_expires_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'customer@example.test','Receipt','text','<p>text</p>',$6,$7,$8,$9,$10,$11,$12,$12)`,
    [company,delivery,sale,id(),actor,state,attempt,past(1),new Date(budget),leaseOwner,leaseExpires&&new Date(leaseExpires),new Date(created)]);return delivery;};

  await test('worker exhaustion and stale-lease transitions satisfy the immutable lifecycle trigger',async()=>{
    const exhausted=await insert({attempt:8}),budget=await insert({state:'retry_wait',created:past(96),budget:past(72)}),
      stale=await insert({state:'running',attempt:1,leaseOwner:'dead-worker',leaseExpires:past(2)}),due=await insert();
    const result=await claimReceiptEmailDeliveries(database,{workerId:'acceptance-worker',now:anchor,limit:5});
    assert.deepEqual({stale:result.stale,exhausted:result.exhausted,jobs:result.jobs.length},{stale:1,exhausted:2,jobs:1});
    const rows=(await pool.query(`SELECT id,state,last_error_code FROM myfin.receipt_email_deliveries
      WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id`,[company,[exhausted,budget,stale,due]])).rows;
    const states=Object.fromEntries(rows.map(row=>[row.id,[row.state,row.last_error_code]]));
    assert.deepEqual(states[exhausted],['failed','retry_budget_exhausted']);assert.deepEqual(states[budget],['failed','retry_budget_exhausted']);
    assert.deepEqual(states[stale],['delivery_unknown','delivery_outcome_unknown']);assert.deepEqual(states[due],['running','']);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM myfin.receipt_email_events WHERE company_id=$1',[company])).rows[0].count,4);
  });

  await test('premature exhaustion, content mutation and event mutation are rejected by PostgreSQL',async()=>{
    const early=await insert();
    await assert.rejects(pool.query(`UPDATE myfin.receipt_email_deliveries SET state='failed',
      last_error_code='retry_budget_exhausted',updated_at=now() WHERE company_id=$1 AND id=$2`,[company,early]),error=>error.code==='23514');
    await assert.rejects(pool.query(`UPDATE myfin.receipt_email_deliveries SET recipient='other@example.test'
      WHERE company_id=$1 AND id=$2`,[company,early]),error=>error.code==='23514');
    const event=(await pool.query('SELECT id FROM myfin.receipt_email_events WHERE company_id=$1 LIMIT 1',[company])).rows[0];
    await assert.rejects(pool.query('DELETE FROM myfin.receipt_email_events WHERE company_id=$1 AND id=$2',[company,event.id]),error=>error.code==='23514');
  });
}finally{
  await pool?.end().catch(()=>{});await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(()=>{});await admin.end();
}
