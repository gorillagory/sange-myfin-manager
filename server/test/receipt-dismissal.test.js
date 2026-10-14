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

test('a generic record conflict is durably queued and the requesting manager can approve it exactly once',async()=>{
 const manager={id:'manager-self-review',role:'manager',username:'Manager'},company={id:'company-self-review',name:'Synthetic shop',preferences:{currency:'RM',taxRate:0}};
 const sale=stripConfidential(createSale({id:'generic-record-conflict',items:[cartItem({id:'product-a',name:'Item',price:10,stock:2})],company,user:{uid:manager.id,username:manager.username},method:'Cash',received:20}));
 let review=null,inserts=0,audits=0,updates=0,posts=0;
 const client={query:async(sql,args=[])=>{
  if(sql.includes('FROM myfin.auth_session'))return {rowCount:1,rows:[{id:'session-manager'}]};
  if(sql.includes('pg_advisory_xact_lock'))return {rowCount:1,rows:[]};
  if(sql.includes('FROM myfin.receipt_reviews'))return {rowCount:review?1:0,rows:review?[review]:[]};
  if(/^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT)/.test(sql))return {rowCount:0,rows:[]};
  if(sql.includes('INSERT INTO myfin.receipt_reviews')){
   inserts++;review={id:sale.id,company_id:company.id,actor_id:manager.id,payload:sale,request_digest:args[4],
    reason_code:args[5],status:'pending',inventory_recipe_resolution:null,created_at:new Date().toISOString()};
   return {rowCount:1,rows:[]};
  }
  if(sql.includes('FROM myfin.app_identities'))return {rowCount:1,rows:[{id:manager.id,username:manager.username}]};
  if(sql.includes('UPDATE myfin.receipt_reviews')){
   updates++;Object.assign(review,{status:'approved',approved_by:manager.id,approval_reason:args[3],approved_at:new Date().toISOString()});
   return {rowCount:1,rows:[]};
  }
  throw Error(`Unexpected query: ${sql}`);
 }};
 const routes=new Map(),app={post:(path,handler)=>routes.set(`POST ${path}`,handler),get:(path,handler)=>routes.set(`GET ${path}`,handler)};
 registerReceiptReviews(app,{db:{transaction:async fn=>fn(client)},authorize:async()=>{},audit:async()=>{audits++;},
  checkout:async(_client,actor,co,payload,approval)=>{
   if(!approval)throw Object.assign(Error('private unique constraint detail'),{code:'23505'});
   assert.deepEqual(actor,{id:manager.id,username:manager.username,role:'operator',company_id:company.id});
   assert.equal(co,company.id);assert.deepEqual(payload,sale);assert.equal(approval.who,manager);
   if(!review.posted){review.posted=true;posts++;}return sale;
  }});
 const submit=routes.get('POST /api/companies/:company/receipt-reviews'),context={
  params:{company:company.id},identity:manager,authLevel:'password',authSessionId:'session-manager',
 };
 const pending=await submit({...context,body:{sale}});
 assert.deepEqual(pending,{id:sale.id,status:'pending',reasonCode:'receipt_review_required_record_conflict'});
 assert.equal(inserts,1);assert.equal(audits,1);assert.equal(posts,0);
 const retry=await submit({...context,body:{sale}});
 assert.equal(retry.status,'pending');assert.equal(inserts,1);assert.equal(audits,1);
 await assert.rejects(submit({...context,body:{sale:{...sale,customerName:'Changed paid intent'}}}),
  error=>error.statusCode===409&&error.message==='receipt_payload_changed');
 const approve=routes.get('POST /api/companies/:company/receipt-reviews/:id/approve'),approval={...context,
  params:{company:company.id,id:sale.id},body:{reason:'Manager verified the recorded payment'},
 };
 const approved=await approve(approval);assert.equal(approved.status,'approved');assert.equal(posts,1);assert.equal(updates,1);
 const replay=await approve(approval);assert.equal(replay.status,'approved');assert.equal(posts,1);assert.equal(updates,1);
});

test('only validated paid intents and whitelisted constraint failures enter automatic review',async()=>{
 const actor={id:'cashier-safe-conflict',role:'operator',username:'Cashier'},company={id:'company-safe-conflict',name:'Synthetic shop',preferences:{currency:'RM',taxRate:0}};
 const make=id=>stripConfidential(createSale({id,items:[cartItem({id:'product-a',name:'Item',price:10,stock:2})],company,user:{uid:actor.id,username:actor.username},method:'Cash',received:20}));
 const reviews=new Map();let inserts=0;
 const client={query:async(sql,args=[])=>{
  if(sql.includes('FROM myfin.auth_session'))return {rowCount:1,rows:[{id:'session-safe-conflict'}]};
  if(sql.includes('pg_advisory_xact_lock')||/^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT)/.test(sql))return {rowCount:0,rows:[]};
  if(sql.includes('FROM myfin.receipt_reviews')){const row=reviews.get(args[1]);return {rowCount:row?1:0,rows:row?[row]:[]};}
  if(sql.includes('INSERT INTO myfin.receipt_reviews')){
   inserts++;reviews.set(args[1],{id:args[1],company_id:args[0],actor_id:args[2],payload:args[3],request_digest:args[4],reason_code:args[5],status:'pending',created_at:new Date().toISOString()});
   return {rowCount:1,rows:[]};
  }
  throw Error(`Unexpected query: ${sql}`);
 }};
 const routes=new Map(),app={post:(path,handler)=>routes.set(path,handler),get:()=>{}};
 registerReceiptReviews(app,{db:{transaction:async fn=>fn(client)},authorize:async(_client,identity)=>{
   if(identity.id==='denied-cashier')throw Object.assign(Error('access_denied'),{statusCode:403});
  },audit:async()=>{},
  checkout:async(_client,_actor,_co,sale)=>{
   if(sale.id==='safe-constraint')throw Object.assign(Error('private constraint detail'),{code:'23505'});
   throw Object.assign(Error('database unavailable'),{code:'57P01'});
  }});
 const submit=routes.get('/api/companies/:company/receipt-reviews'),request=(sale,extra={})=>submit({
  params:{company:company.id},identity:actor,authLevel:'password',authSessionId:'session-safe-conflict',body:{sale,...extra},
 });
 const pending=await request(make('safe-constraint'));
 assert.equal(pending.reasonCode,'receipt_review_required_record_conflict');assert.equal(inserts,1);
 await assert.rejects(request(make('internal-failure')),error=>error.code==='57P01');assert.equal(inserts,1);
 await assert.rejects(request(make('invalid-conflict-code'),{conflictCode:'internal_error'}),error=>error.statusCode===400&&error.message==='invalid_input');assert.equal(inserts,1);
 await assert.rejects(request({...make('wrong-actor'),cashierId:'somebody-else'}),error=>error.statusCode===403&&error.message==='invalid_sale_actor');assert.equal(inserts,1);
 await assert.rejects(submit({params:{company:company.id},identity:{...actor,id:'denied-cashier'},authLevel:'password',authSessionId:'session-safe-conflict',body:{sale:{...make('denied-sale'),cashierId:'denied-cashier'}}}),
  error=>error.statusCode===403&&error.message==='access_denied');assert.equal(inserts,1);
 await assert.rejects(submit({params:{company:company.id},identity:actor,authLevel:'password',authSessionId:'session-safe-conflict',body:{sale:{}}}),
  error=>error.statusCode===400&&error.message==='invalid_input');assert.equal(inserts,1);
});

test('recipe timing approval requires, applies, persists and exposes an inventory recipe resolution',async()=>{
 const manager={id:'manager-a',role:'manager'},cashier={id:'cashier-a',username:'Cashier'},companyId='company-a';
 const review={id:'recipe-timing-sale',company_id:companyId,actor_id:cashier.id,status:'pending',
  payload:{id:'recipe-timing-sale',company_id:companyId,cashierId:cashier.id,items:[],offline:true},
  reason_code:'receipt_review_required_recipe_timing',inventory_recipe_resolution:null,created_at:new Date().toISOString()};
 let checkoutCalls=0;
 const client={query:async(sql,args=[])=>{
  if(sql.includes('FROM myfin.auth_session'))return {rowCount:1,rows:[{id:'session-a'}]};
  if(sql.includes('pg_advisory_xact_lock'))return {rowCount:1,rows:[]};
  if(sql.includes('FROM myfin.receipt_reviews'))return {rowCount:1,rows:[review]};
  if(sql.includes('FROM myfin.app_identities'))return {rowCount:1,rows:[cashier]};
  if(sql.includes('UPDATE myfin.receipt_reviews')){
   assert.match(sql,/inventory_recipe_resolution=\$5/);
   assert.deepEqual(args,[companyId,review.id,manager.id,'Use the current kitchen recipe','current_recipe']);
   Object.assign(review,{status:'approved',approved_by:manager.id,approval_reason:args[3],
    inventory_recipe_resolution:args[4],approved_at:new Date().toISOString()});
   return {rowCount:1,rows:[]};
  }
  throw Error(`Unexpected query: ${sql}`);
 }};
 const routes=new Map(),app={post:(path,handler)=>routes.set(`POST ${path}`,handler),
  get:(path,handler)=>routes.set(`GET ${path}`,handler)};
 registerReceiptReviews(app,{db:{transaction:async fn=>fn(client)},authorize:async()=>{},
  checkout:async(_client,actor,co,payload,approval)=>{
   if(review.reason_code!=='receipt_review_required_recipe_timing'&&approval?.inventoryRecipeResolution)
    throw Object.assign(Error('inventory_recipe_resolution_not_applicable'),{statusCode:400});
   checkoutCalls++;assert.deepEqual(actor,{...cashier,role:'operator',company_id:companyId});assert.equal(co,companyId);
   assert.equal(payload,review.payload);assert.deepEqual(approval,{who:manager,reason:'Use the current kitchen recipe',inventoryRecipeResolution:'current_recipe'});
   return payload;
  },audit:async()=>{}});
 const approve=routes.get('POST /api/companies/:company/receipt-reviews/:id/approve'),request=body=>approve({
  params:{company:companyId,id:review.id},identity:manager,authLevel:'password',authSessionId:'session-a',body,
 });
 await assert.rejects(request({reason:'Choose recipe'}),error=>error.statusCode===400&&error.message==='inventory_recipe_resolution_required');
 await assert.rejects(request({reason:'Choose recipe',inventoryRecipeResolution:'invented_recipe'}),
  error=>error.statusCode===400&&error.message==='invalid_input');
 review.reason_code='receipt_review_required_pricing_policy';
 review.payload.offline=false;
 await assert.rejects(request({reason:'Choose recipe',inventoryRecipeResolution:'current_recipe'}),
  error=>error.statusCode===400&&error.message==='inventory_recipe_resolution_not_applicable');
 assert.equal(checkoutCalls,0,'an online review must reject recipe evidence before checkout');
 review.payload.offline=true;
 await assert.rejects(request({reason:'Choose recipe',inventoryRecipeResolution:'current_recipe'}),
  error=>error.statusCode===400&&error.message==='inventory_recipe_resolution_not_applicable');
 review.reason_code='receipt_review_required_recipe_timing';
 const approved=await request({reason:'Use the current kitchen recipe',inventoryRecipeResolution:'current_recipe'});
 assert.equal(checkoutCalls,1);assert.equal(approved.inventoryRecipeResolution,'current_recipe');
 const listed=await routes.get('GET /api/companies/:company/receipt-reviews')({
  params:{company:companyId},identity:manager,authLevel:'password',authSessionId:'session-a',
 });
 assert.equal(listed[0].inventoryRecipeResolution,'current_recipe');
 await assert.rejects(request({reason:'Change the decision',inventoryRecipeResolution:'captured_recipe'}),
  error=>error.statusCode===409&&error.message==='inventory_recipe_resolution_changed');
 assert.equal(checkoutCalls,1);
});

test('a delayed online receipt can preserve captured-time recipe evidence during approval',async()=>{
 const manager={id:'manager-delayed',role:'manager'},cashier={id:'cashier-delayed',username:'Cashier'},companyId='company-delayed';
 const review={id:'delayed-sale',company_id:companyId,actor_id:cashier.id,status:'pending',
  payload:{id:'delayed-sale',company_id:companyId,cashierId:cashier.id,items:[],offline:false},
  reason_code:'receipt_review_required_delayed_sync',inventory_recipe_resolution:null,created_at:new Date().toISOString()};
 let updated=false;
 const client={query:async(sql,args=[])=>{
  if(sql.includes('FROM myfin.auth_session'))return {rowCount:1,rows:[{id:'session-delayed'}]};
  if(sql.includes('pg_advisory_xact_lock'))return {rowCount:1,rows:[]};
  if(sql.includes('FROM myfin.receipt_reviews'))return {rowCount:1,rows:[review]};
  if(sql.includes('FROM myfin.app_identities'))return {rowCount:1,rows:[cashier]};
  if(sql.includes('UPDATE myfin.receipt_reviews')){
   assert.deepEqual(args,[companyId,review.id,manager.id,'Verified delayed payment','captured_recipe']);
   updated=true;Object.assign(review,{status:'approved',inventory_recipe_resolution:args[4]});
   return {rowCount:1,rows:[]};
  }
  throw Error(`Unexpected query: ${sql}`);
 }};
 const routes=new Map(),app={post:(path,handler)=>routes.set(path,handler),get:()=>{}};
 registerReceiptReviews(app,{db:{transaction:async fn=>fn(client)},authorize:async()=>{},audit:async()=>{},
  checkout:async(_client,actor,co,payload,approval)=>{
   assert.deepEqual(actor,{...cashier,role:'operator',company_id:companyId});assert.equal(co,companyId);
   assert.equal(payload,review.payload);assert.equal(approval.inventoryRecipeResolution,'captured_recipe');
   return {...payload,date:'2026-10-11T08:00:00.000Z',businessDate:'2026-10-11'};
  }});
 const approve=routes.get('/api/companies/:company/receipt-reviews/:id/approve');
 const result=await approve({params:{company:companyId,id:review.id},identity:manager,authLevel:'password',
  authSessionId:'session-delayed',body:{reason:'Verified delayed payment',inventoryRecipeResolution:'captured_recipe'}});
 assert.equal(result.status,'approved');assert.equal(result.receipt.businessDate,'2026-10-11');assert.equal(updated,true);
});

test('recipe shortage stays pending until replenished, then approves and replays exactly once',async()=>{
 const cashier={id:'cashier-stock',role:'operator',username:'Cashier'},manager={id:'manager-stock',role:'manager'},
  company={id:'company-stock',name:'Synthetic shop',preferences:{currency:'RM',taxRate:0}};
 const sale=stripConfidential(createSale({id:'recipe-shortage',items:[cartItem({id:'latte',name:'Latte',price:10,
  stock:0,trackStock:false})],company,user:{uid:cashier.id,username:cashier.username},method:'Cash',received:10,offline:true}));
 let review=null,stockAvailable=false,recipeChanged=false,checkoutCalls=0,posts=0,updates=0;
 const client={query:async(sql,args=[])=>{
  if(sql.includes('FROM myfin.auth_session'))return {rowCount:1,rows:[{id:'session-stock'}]};
  if(sql.includes('pg_advisory_xact_lock')||/^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT)/.test(sql))
   return {rowCount:0,rows:[]};
  if(sql.includes('FROM myfin.receipt_reviews'))return {rowCount:review?1:0,rows:review?[review]:[]};
  if(sql.includes('INSERT INTO myfin.receipt_reviews')){
   review={id:sale.id,company_id:company.id,actor_id:cashier.id,payload:sale,request_digest:args[4],
    reason_code:args[5],status:'pending',inventory_recipe_resolution:null,created_at:new Date().toISOString()};
   return {rowCount:1,rows:[]};
  }
  if(sql.includes('FROM myfin.app_identities'))return {rowCount:1,rows:[cashier]};
  if(sql.includes('UPDATE myfin.receipt_reviews')){
   updates++;Object.assign(review,{status:'approved',approved_by:manager.id,approval_reason:args[3],
    inventory_recipe_resolution:args[4],approved_at:new Date().toISOString()});return {rowCount:1,rows:[]};
  }
  throw Error(`Unexpected query: ${sql}`);
 }};
 const routes=new Map(),app={post:(path,handler)=>routes.set(`POST ${path}`,handler),
  get:(path,handler)=>routes.set(`GET ${path}`,handler)};
 const shortage=()=>Object.assign(Error('receipt_review_required_recipe_stock'),{statusCode:409});
 const timing=()=>Object.assign(Error('receipt_review_required_recipe_timing'),{statusCode:409});
 registerReceiptReviews(app,{db:{transaction:async fn=>fn(client)},authorize:async()=>{},audit:async()=>{},
  checkout:async(_client,_actor,_company,_sale,approval)=>{checkoutCalls++;if(!stockAvailable)throw shortage();
   if(recipeChanged&&!approval?.inventoryRecipeResolution)throw timing();
   if(!review.posted){review.posted=true;posts++;}return sale;}});
 const context={params:{company:company.id},identity:cashier,authLevel:'password',authSessionId:'session-stock'};
 const submit=routes.get('POST /api/companies/:company/receipt-reviews');
 const pending=await submit({...context,body:{sale}});
 assert.equal(pending.status,'pending');assert.equal(pending.reasonCode,'receipt_review_required_recipe_stock');
 const approve=routes.get('POST /api/companies/:company/receipt-reviews/:id/approve'),approval={
  params:{company:company.id,id:sale.id},identity:manager,authLevel:'password',authSessionId:'session-stock',
  body:{reason:'Inventory was checked and replenished'},
 };
 await assert.rejects(approve(approval),error=>error.statusCode===409&&error.message==='receipt_review_required_recipe_stock');
 await assert.rejects(approve(approval),error=>error.statusCode===409&&error.message==='receipt_review_required_recipe_stock');
 assert.equal(review.status,'pending');assert.equal(updates,0);assert.equal(posts,0);
 stockAvailable=true;recipeChanged=true;
 await assert.rejects(approve(approval),error=>error.statusCode===409&&error.message==='receipt_review_required_recipe_timing');
 assert.equal(review.status,'pending');assert.equal(updates,0);assert.equal(posts,0);
 approval.body.inventoryRecipeResolution='current_recipe';
 const approved=await approve(approval);
 assert.equal(approved.status,'approved');assert.equal(review.status,'approved');assert.equal(updates,1);assert.equal(posts,1);
 assert.equal(review.inventory_recipe_resolution,'current_recipe');
 const replay=await approve(approval);
 assert.equal(replay.status,'approved');assert.equal(updates,1);assert.equal(posts,1);
 assert.equal(checkoutCalls,6);
});

test('managers, workspace owners and super admins list reviews from another cashier',async()=>{
 const companyId='company-shared-review',cashierId='cashier-on-another-device';
 const review={id:'shared-review',company_id:companyId,actor_id:cashierId,status:'pending',payload:{
  id:'shared-review',company_id:companyId,cashierId,items:[],total:10,
 },request_digest:'digest',reason_code:'cashier_requested_dismissal',created_at:new Date().toISOString()};
 const filters=[];
 const client={query:async(sql,args=[])=>{
  if(sql.includes('FROM myfin.auth_session'))return {rowCount:1,rows:[{id:'session-shared'}]};
  if(sql.includes('pg_advisory_xact_lock'))return {rowCount:1,rows:[]};
  if(sql.includes('FROM myfin.receipt_reviews')){
   filters.push({allCompanyReviews:args[1],actorId:args[2]});
   return {rowCount:1,rows:[review]};
  }
  throw Error(`Unexpected query: ${sql}`);
 }};
 const routes=new Map(),app={post:(path,handler)=>routes.set(`POST ${path}`,handler),
  get:(path,handler)=>routes.set(`GET ${path}`,handler)};
 registerReceiptReviews(app,{db:{transaction:async fn=>fn(client)},authorize:async()=>{},checkout:async()=>{},audit:async()=>{}});
 const list=routes.get('GET /api/companies/:company/receipt-reviews');
 for(const role of ['manager','workspace_owner','super_admin']){
  const identity={id:`${role}-viewer`,role};
  const rows=await list({params:{company:companyId},identity,authLevel:'password',authSessionId:'session-shared'});
  assert.equal(rows[0].id,review.id);
  assert.deepEqual(filters.at(-1),{allCompanyReviews:true,actorId:identity.id});
 }
 const operatorIdentity={id:'operator-viewer',role:'operator'};
 await list({params:{company:companyId},identity:operatorIdentity,authLevel:'password',authSessionId:'session-shared'});
 assert.deepEqual(filters.at(-1),{allCompanyReviews:false,actorId:operatorIdentity.id});
});
