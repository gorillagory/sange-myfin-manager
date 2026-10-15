import test from 'node:test';
import assert from 'node:assert/strict';
import { registerReceiptReviews } from '../src/receipt-reviews.js';
import { checkout } from '../src/business.js';
import { businessDate, cartItem, createSale } from '../../src/domain/pos.js';

const companyId='bulk-company',manager={id:'bulk-manager',role:'manager',username:'Manager'};

function register(reviews,checkoutHandler,{serverNow}={}){
 const routes=new Map(),queries=[];
 const app={post:(path,handler)=>routes.set(path,handler),get:()=>{}};
 const client={query:async(sql,args=[])=>{
  queries.push({sql,args});
  if(sql.includes('FROM myfin.auth_session'))return {rowCount:1,rows:[{id:'bulk-session'}]};
  if(sql.includes('pg_advisory_xact_lock')||/^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT)/.test(sql))return {rowCount:0,rows:[]};
  if(sql.includes('SELECT now() AS server_now'))return {rowCount:1,rows:[{server_now:serverNow}]};
  if(sql.includes('FROM myfin.transactions'))return {rowCount:0,rows:[]};
  if(sql.includes('FROM myfin.receipt_reviews')){
   const row=reviews.get(args[1]);return {rowCount:row?1:0,rows:row?[row]:[]};
  }
  if(sql.includes('FROM myfin.app_identities')){
   const row=[...reviews.values()].find(item=>item.actor_id===args[0]);
   return row?.actor_id==='missing-cashier'?{rowCount:0,rows:[]}:
    {rowCount:1,rows:[{id:args[0],username:`Cashier ${args[0]}`}]};
  }
  if(sql.includes('UPDATE myfin.receipt_reviews')){
   const row=reviews.get(args[1]);Object.assign(row,{status:'approved',approved_by:args[2],approval_reason:args[3],
    inventory_recipe_resolution:args[4],approved_at:new Date().toISOString()});return {rowCount:1,rows:[]};
  }
  throw Error(`Unexpected query: ${sql}`);
 }};
 registerReceiptReviews(app,{db:{transaction:async fn=>fn(client)},authorize:async()=>{},checkout:checkoutHandler,audit:async()=>{}});
 return {handler:routes.get('/api/companies/:company/receipt-reviews/approve-all'),queries};
}

const review=(id,reasonCode,status='pending',actorId=`cashier-${id}`)=>({
 id,company_id:companyId,actor_id:actorId,status,reason_code:reasonCode,inventory_recipe_resolution:null,
 payload:{id,company_id:companyId,cashierId:actorId,number:`POS-${id.toUpperCase()}`,items:[],total:10},
 created_at:new Date().toISOString(),
});
const request=(handler,reviewIds,body={})=>handler({params:{company:companyId},identity:{...manager},
 authLevel:'password',authSessionId:'bulk-session',body:{reason:'Verified routine recovered payments',reviewIds,...body}});

test('bulk approval posts only the explicit routine recovery allowlist and reports every skipped review',async()=>{
 const rows=[
  review('offline','receipt_review_required_offline_sync'),
  review('delayed','receipt_review_required_delayed_sync'),
  review('offline-time','receipt_review_required_offline_time'),
  review('pricing','receipt_review_required_pricing_policy'),
  review('merchant','receipt_review_required_merchant_changed'),
  review('product','receipt_review_required_product_changed'),
  review('timing','receipt_review_required_recipe_timing'),
  review('recipe-stock','receipt_review_required_recipe_stock'),
  review('conflict','receipt_review_required_record_conflict'),
  review('stock','stock_unavailable'),
  review('override','manager_override_reason_required'),
  review('dismissal','cashier_requested_dismissal'),
  review('unknown','future_review_reason'),
  review('complete','receipt_review_required_offline_sync','approved'),
 ];
 const reviews=new Map(rows.map(row=>[row.id,row])),checkoutIds=[];
 const {handler}=register(reviews,async(_client,actor,co,payload,approval)=>{
  checkoutIds.push(payload.id);assert.equal(co,companyId);assert.equal(actor.role,'operator');
  assert.deepEqual(approval,{who:manager,reason:'Verified routine recovered payments',revalidatePolicy:true});
  return payload;
 });
 const ids=[...rows.map(row=>row.id),'absent'];
 const result=await request(handler,ids);
 assert.deepEqual(result.approved.map(row=>row.id),['delayed','offline']);
 assert.deepEqual(checkoutIds,['delayed','offline']);
 assert.equal(reviews.get('offline').status,'approved');
 assert.equal(reviews.get('delayed').status,'approved');
 assert.deepEqual(result.skipped.map(row=>row.id),ids.filter(id=>!['offline','delayed'].includes(id)).sort());
 assert.deepEqual(result.skipped.find(row=>row.id==='complete'),{
  id:'complete',status:'approved',reasonCode:'receipt_review_required_offline_sync',
 });
 assert.deepEqual(result.skipped.find(row=>row.id==='absent'),{id:'absent',reasonCode:'not_found'});
 for(const row of rows.slice(2,13))assert.equal(reviews.get(row.id).status,'pending');
});

test('bulk approval isolates expected replay conflicts but aborts on an unexpected failure',async()=>{
 const expected=review('expected','receipt_review_required_delayed_sync'),reserved=review('reserved','receipt_review_required_offline_sync'),
  fatal=review('fatal','receipt_review_required_offline_sync');
 const reviews=new Map([[expected.id,expected],[reserved.id,reserved],[fatal.id,fatal]]),{handler,queries}=register(reviews,async(_c,_actor,_co,payload)=>{
  if(payload.id==='expected')throw Object.assign(Error('receipt_review_required_recipe_timing'),{statusCode:409});
  if(payload.id==='reserved')throw Object.assign(Error('stock_reserved_or_unavailable'),{statusCode:409});
  throw Object.assign(Error('database unavailable'),{code:'57P01'});
 });
 const partial=await request(handler,['expected','reserved']);
 assert.deepEqual(partial,{approved:[],skipped:[
  {id:'expected',status:'pending',reasonCode:'receipt_review_required_recipe_timing'},
  {id:'reserved',status:'pending',reasonCode:'stock_reserved_or_unavailable'},
 ]});
 await assert.rejects(request(handler,['fatal']),error=>error.code==='57P01');
 assert.equal(expected.status,'pending');assert.equal(reserved.status,'pending');assert.equal(fatal.status,'pending');
 assert.equal(queries.filter(row=>row.sql==='ROLLBACK TO SAVEPOINT bulk_receipt_approval').length,3);
});

test('bulk approval leaves unusually old and future delayed captures for individual review',async()=>{
 const serverNow='2026-10-14T12:00:00.000Z',company={id:companyId,name:'Bulk shop',preferences:{currency:'RM',taxRate:0}},
  product={id:'bulk-product',name:'Item',price:10,stock:3,trackStock:true,unit:'unit'};
 const sale=(id,date)=>{
  const value=createSale({id,items:[cartItem(product)],company,user:{uid:`cashier-${id}`,username:'Cashier'},
   method:'Cash',received:10,offline:false});
  value.date=date;value.businessDate=businessDate(date);return value;
 };
 const old=review('delayed-old','receipt_review_required_delayed_sync'),
  future=review('delayed-future','receipt_review_required_delayed_sync');
 old.payload=sale(old.id,'2026-10-11T11:59:59.000Z');
 future.payload=sale(future.id,'2026-10-14T12:05:01.000Z');
 const reviews=new Map([[old.id,old],[future.id,future]]),{handler,queries}=register(reviews,checkout,{serverNow});
 const result=await request(handler,[old.id,future.id]);
 assert.deepEqual(result,{approved:[],skipped:[
  {id:'delayed-future',status:'pending',reasonCode:'receipt_review_required_offline_time'},
  {id:'delayed-old',status:'pending',reasonCode:'receipt_review_required_offline_time'},
 ]});
 assert.equal(queries.some(row=>row.sql.includes('UPDATE myfin.receipt_reviews')),false);
 assert.equal(old.status,'pending');assert.equal(future.status,'pending');
});

test('bulk approval validates a unique explicit snapshot and manager capability',async()=>{
 const rows=new Map(),{handler}=register(rows,async()=>{throw Error('checkout must not run');});
 await assert.rejects(request(handler,['same','same']),error=>error.statusCode===400&&error.message==='invalid_input');
 await assert.rejects(handler({params:{company:companyId},identity:{id:'operator',role:'operator'},authLevel:'password',
  authSessionId:'bulk-session',body:{reason:'Verified payments',reviewIds:['one']}}),
 error=>error.statusCode===403&&error.message==='access_denied');
});
