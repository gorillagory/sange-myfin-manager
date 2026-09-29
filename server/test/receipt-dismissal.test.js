import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSale,cartItem,canonical } from '../../src/domain/pos.js';
import { stripConfidential } from '../../src/domain/permissions.js';
import { registerReceiptReviews } from '../src/receipt-reviews.js';

test('a posted transaction takes precedence over an earlier pending dismissal request',async()=>{
 const actor={id:'cashier-a',role:'operator'},company={id:'company-a',name:'Synthetic shop',preferences:{currency:'RM',taxRate:0}};
 const sale=stripConfidential(createSale({id:'paid-before-dismissal',items:[cartItem({id:'product-a',name:'Item',price:10,stock:1})],company,user:{uid:actor.id,username:'Cashier'},method:'Cash',received:20}));
 const digest=createHash('sha256').update(JSON.stringify(canonical(sale))).digest('hex');
 const review={id:sale.id,company_id:company.id,actor_id:actor.id,status:'pending',payload:sale,request_digest:digest,reason_code:'cashier_requested_dismissal',created_at:new Date().toISOString()};
 let posted=false,checkoutCalls=0,transactionChecks=0;
 const client={query:async sql=>{
  if(sql.includes('FROM myfin.auth_session'))return {rowCount:1,rows:[{id:'session-a'}]};
  if(sql.includes('FROM myfin.receipt_reviews'))return {rowCount:1,rows:[review]};
  if(sql.includes('FROM myfin.transactions')){transactionChecks++;return {rowCount:posted?1:0,rows:posted?[{id:sale.id}]:[]};}
  if(sql.includes('pg_advisory_xact_lock'))return {rowCount:1,rows:[]};
  throw Error(`Unexpected query: ${sql}`);
 }};
 const routes=new Map(),app={post:(path,handler)=>routes.set(path,handler),get:()=>{}};
 registerReceiptReviews(app,{db:{transaction:async fn=>fn(client)},authorize:async()=>{},checkout:async(_client,who,co,input)=>{checkoutCalls++;assert.equal(who.id,actor.id);assert.equal(co,company.id);assert.deepEqual(input,sale);return {id:sale.id,total:sale.total};},audit:async()=>{throw Error('Existing review must not add another audit row.');}});
 const handler=routes.get('/api/companies/:company/receipt-dismissal-requests');
 const req={params:{company:company.id},identity:actor,authLevel:'password',authSessionId:'session-a',body:{sale}};
 const pending=await handler(req);assert.equal(pending.status,'pending');assert.equal(checkoutCalls,0);
 posted=true;
 const acknowledged=await handler(req);assert.deepEqual(acknowledged,{id:sale.id,status:'posted',receipt:{id:sale.id,total:sale.total}});assert.equal(checkoutCalls,1);
 const changed={...sale,received:21,change:11};
 await assert.rejects(handler({...req,body:{sale:changed}}),error=>error.statusCode===409&&error.message==='receipt_payload_changed');
 assert.equal(transactionChecks,2,'changed paid facts must fail before the posted lookup');
});
