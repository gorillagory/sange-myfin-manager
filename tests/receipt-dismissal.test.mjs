import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { createSale,cartItem,totalsFor,cents } from '../src/domain/pos.js';
import { canBulkApproveReceipt,receiptBulkApprovalBlock } from '../src/domain/receiptReviews.js';

const storage=new Map();
globalThis.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
const cashier={uid:'receipt-cashier',id:'receipt-cashier',role:'company_user',company_id:'receipt-company'};
const company={id:'receipt-company',name:'Original shop',preferences:{currency:'RM',taxRate:6}};
const product={id:'receipt-item',name:'Synthetic item',price:19.93,cost:88.77,stock:4};
const make=id=>createSale({id,items:[cartItem(product)],company,user:{uid:cashier.uid,username:'Cashier'},method:'Cash',received:100});
const v3=make('rounded-paid'),v2=make('legacy-paid'),legacyTotals=totalsFor(v2.items,v2.taxRate,v2.discount);
Object.assign(v2,{schemaVersion:2,...legacyTotals,change:(cents(v2.received)-cents(legacyTotals.total))/100});
delete v2.totalBeforeRounding;delete v2.rounding;
assert.notEqual(v2.total,v3.total);

// Start with a real v2 device cache; opening the current store must upgrade both paid intents.
const old=await new Promise((resolve,reject)=>{const request=indexedDB.open('myfin-pos',2);request.onupgradeneeded=()=>{for(const name of ['catalog','profiles','drafts'])request.result.createObjectStore(name);request.result.createObjectStore('outbox',{keyPath:'id'});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
await new Promise((resolve,reject)=>{const tx=old.transaction('outbox','readwrite');for(const sale of [v2,v3])tx.objectStore('outbox').put({...sale,companySnapshot:{name:'Original shop'},templateSnapshot:{footer:'Original receipt'}});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});old.close();

const vite=await createServer({server:{middlewareMode:true,hmr:{port:0}},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
const {Store}=await vite.ssrLoadModule('/src/store/editionStore.js');
const {localPos}=await vite.ssrLoadModule('/src/services/posLocal.js');
const {checkoutPayload}=await vite.ssrLoadModule('/src/services/postSale.js');
const {receiptRecoveryBucket}=await vite.ssrLoadModule('/src/domain/offlinePolicy.js');
const response=(value,status=200)=>({ok:status<400,status,json:async()=>value});
const requests=[],modes=new Map();
let actor={...cashier};
globalThis.fetch=async(path,options={})=>{
 requests.push({path,options});
 if(path==='/api/me')return response(actor);
 if(path.endsWith('/checkout')){
  const sale=JSON.parse(options.body),mode=modes.get(sale.id);
  return mode==='dismissed'?response({error:'receipt_dismissed'},409):mode==='posted'?response(sale):response({error:'unexpected_checkout'},500);
 }
 if(path.endsWith('/receipt-dismissal-requests')){
  const sale=JSON.parse(options.body).sale,mode=modes.get(sale.id);
  return response({id:sale.id,status:mode==='posted'?'posted':mode==='dismissed'?'dismissed':'pending',reasonCode:'cashier_requested_dismissal',...(mode==='posted'?{receipt:sale}:{})});
 }
 if(path.endsWith('/receipt-reviews/approve-all')){
  const body=JSON.parse(options.body);
  return response({
   approved:body.reviewIds.slice(0,1).map(id=>({id,status:'approved',inventoryRecipeResolution:null,receipt:{id,company_id:company.id}})),
   skipped:body.reviewIds.slice(1).map(id=>({id,status:'pending',reasonCode:'receipt_review_required_recipe_stock'})),
  });
 }
 if(path.endsWith('/approve')){
  const body=JSON.parse(options.body);
  return response({id:'recipe-timing-sale',status:'approved',inventoryRecipeResolution:body.inventoryRecipeResolution,receipt:{id:'recipe-timing-sale'}});
 }
 if(path.endsWith('/receipt-reviews'))return response([]);
 return response({rows:[],next:null});
};
function reset(){Store.clearSession();Store.state.currentUser={...cashier};Store.state.selectedCompany={...company};Store.state.companies=[Store.state.selectedCompany];Store.state.online=true;Store.state.fromCache=false;actor={...cashier};requests.length=0;modes.clear();}
const sent=(suffix,method='POST')=>requests.filter(row=>row.path.endsWith(suffix)&&row.options.method===method).map(row=>JSON.parse(row.options.body));
try{
 await test('a cashier dismissal request keeps the upgraded v2 paid queue and sends its original facts',async()=>{
  reset();await localPos.ready();
  const queued=(await localPos.sales(cashier.uid,company.id)).find(row=>row.id===v2.id);
  assert.equal(queued.schemaVersion,2);assert.equal(queued.total,v2.total);assert.equal(queued.change,v2.change);
  assert.equal(queued.totalBeforeRounding,undefined);assert.equal(queued.rounding,undefined);
  assert.equal(queued.items[0].cost,undefined);
  const result=await Store.requestReceiptDismissal(queued);
  assert.equal(result.status,'pending');assert.ok((await localPos.sales(cashier.uid,company.id)).some(row=>row.id===v2.id));
  assert.deepEqual(sent('/receipt-dismissal-requests')[0].sale,checkoutPayload(v2));
  Store.state.currentUser={...cashier,uid:'another-cashier'};
  await assert.rejects(Store.requestReceiptDismissal(queued),/original cashier/);
  assert.equal(sent('/receipt-dismissal-requests').length,1);
 });
 await test('server dismissal confirmation clears only the original cashier queue after a failed checkout retry',async()=>{
  reset();for(const sale of [v2,v3])modes.set(sale.id,'dismissed');
  const other={...v3,id:'other-cashier-paid',cashierId:'another-cashier'};await localPos.putSale(other);
  const summary=await Store.syncSales({feedback:false});
  assert.deepEqual({status:summary.status,attempted:summary.attempted,synced:summary.synced,dismissed:summary.dismissed,pending:summary.pending},{status:'dismissed',attempted:2,synced:0,dismissed:2,pending:0});
  assert.equal((await localPos.sales(cashier.uid,company.id)).length,0);
  assert.equal((await localPos.sales(other.cashierId,company.id)).length,1);
  const bodies=sent('/receipt-dismissal-requests').map(row=>row.sale);
  assert.deepEqual(bodies.map(row=>[row.id,row.schemaVersion,row.total,row.change]),[[v2.id,2,v2.total,v2.change],[v3.id,3,v3.total,v3.change]]);
  assert.equal(bodies[0].rounding,undefined);assert.equal(bodies[1].rounding,v3.rounding);
 });
 await test('a posted server acknowledgement clears a saved v3 receipt without another checkout',async()=>{
  reset();await localPos.putSale(v3);modes.set(v3.id,'posted');
  const result=await Store.requestReceiptDismissal(v3);
  assert.equal(result.status,'posted');assert.equal((await localPos.sales(cashier.uid,company.id)).length,0);
  assert.equal(sent('/checkout').length,0);
 });
 await test('receipt recovery keeps infrastructure failures in retry sync and reserves dismissal for a reconciled receipt',()=>{
  for(const error of [undefined,'internal_error','network_error','Network unavailable','unexpected_checkout'])
   assert.equal(receiptRecoveryBucket(error),'retry',String(error));
  for(const error of ['receipt_review_required','receipt_review_required_pricing_policy','stock_unavailable','stock_reserved_or_unavailable','record_conflict'])
   assert.equal(receiptRecoveryBucket(error),'review',error);
  assert.equal(receiptRecoveryBucket('receipt_dismissed'),'dismissal');
 });
 await test('successful v2 and v3 checkout retries preserve each schema and rounded amount',async()=>{
  reset();await localPos.putSale(v2);await localPos.putSale(v3);for(const sale of [v2,v3])modes.set(sale.id,'posted');
  const summary=await Store.syncSales({feedback:false});
  assert.deepEqual({status:summary.status,attempted:summary.attempted,synced:summary.synced,pending:summary.pending},{status:'synced',attempted:2,synced:2,pending:0});
  const bodies=sent('/checkout');
  assert.deepEqual(bodies.map(row=>[row.id,row.schemaVersion,row.total,row.change]),[[v2.id,2,v2.total,v2.change],[v3.id,3,v3.total,v3.change]]);
  assert.equal(bodies[0].totalBeforeRounding,undefined);assert.equal(bodies[0].rounding,undefined);
  assert.equal(bodies[1].totalBeforeRounding,v3.totalBeforeRounding);assert.equal(bodies[1].rounding,v3.rounding);
  for(const body of bodies){assert.equal(body.items[0].cost,undefined);assert.equal(body.companySnapshot,undefined);assert.equal(body.templateSnapshot,undefined);}
 });
 await test('operator expense void forwards manager approval to the API',async()=>{
  reset();
  const approval={managerCode:'123456',reason:'Duplicate network entry'};
  await Store.deleteExpense('expense-1',approval);
  assert.deepEqual(sent('/expenses/expense-1','DELETE'),[approval]);
 });
 await test('recipe timing review forwards only a valid explicit inventory resolution',async()=>{
  reset();Store.state.currentUser={uid:'receipt-manager',id:'receipt-manager',role:'manager',company_id:company.id};
  actor={...Store.state.currentUser};
  Store.state.receiptReviews=[{id:'recipe-timing-sale',reasonCode:'receipt_review_required_recipe_timing'}];
  await assert.rejects(Store.approveReceiptReview('recipe-timing-sale','Approve original sale'),/Choose whether inventory/);
  await assert.rejects(Store.approveReceiptReview('recipe-timing-sale','Approve original sale','invented_recipe'),/valid inventory recipe resolution/);
  await Store.approveReceiptReview('recipe-timing-sale','  Use captured recipe  ','captured_recipe');
  assert.deepEqual(sent('/receipt-reviews/recipe-timing-sale/approve'),[{
   reason:'Use captured recipe',inventoryRecipeResolution:'captured_recipe',
  }]);
 });
 await test('bulk receipt approval sends one reviewed snapshot and reports partial outcomes',async()=>{
  reset();Store.state.currentUser={uid:'receipt-manager',id:'receipt-manager',role:'manager',company_id:company.id};
  actor={...Store.state.currentUser};
  Store.state.receiptReviews=[
   {id:'offline-sale',status:'pending',reasonCode:'receipt_review_required_offline_sync'},
   {id:'delayed-sale',status:'pending',reasonCode:'receipt_review_required_delayed_sync'},
  ];
  await assert.rejects(Store.approveAllEligibleReceiptReviews([], 'Reviewed batch'),/No eligible payments/);
  await assert.rejects(Store.approveAllEligibleReceiptReviews(['offline-sale'], '  '),/at least 3 characters/);
  await assert.rejects(Store.approveAllEligibleReceiptReviews(['offline-sale'], 'x'.repeat(1001)),/within 1000 characters/);
  const result=await Store.approveAllEligibleReceiptReviews(['offline-sale','delayed-sale','offline-sale'],'  Verified original paid receipts  ');
  assert.deepEqual(sent('/receipt-reviews/approve-all'),[{
   reviewIds:['offline-sale','delayed-sale'],reason:'Verified original paid receipts',
  }]);
  assert.deepEqual(result.approved.map(row=>row.id),['offline-sale']);
  assert.deepEqual(result.skipped.map(row=>row.id),['delayed-sale']);
 });
 await test('bulk receipt eligibility is an explicit safe allowlist',()=>{
  for(const reasonCode of ['receipt_review_required_offline_sync','receipt_review_required_delayed_sync'])
   assert.equal(canBulkApproveReceipt({status:'pending',reasonCode}),true,reasonCode);
  for(const reasonCode of [
   'receipt_review_required_offline_time','receipt_review_required_pricing_policy',
   'receipt_review_required_merchant_changed','receipt_review_required_product_changed',
   'receipt_review_required_recipe_timing','receipt_review_required_recipe_stock',
   'receipt_review_required_record_conflict','manager_override_reason_required',
   'stock_unavailable','stock_reserved_or_unavailable','cashier_requested_dismissal','new_unknown_review_reason',undefined,
  ])assert.equal(canBulkApproveReceipt({status:'pending',reasonCode}),false,String(reasonCode));
  assert.equal(canBulkApproveReceipt({status:'approved',reasonCode:'receipt_review_required_offline_sync'}),false);
  assert.equal(receiptBulkApprovalBlock({status:'pending',reasonCode:'new_unknown_review_reason'}),'Individual verification required');
 });
 await test('recipe timing review UI requires and explains the structured recipe choice',async()=>{
  const source=await readFile(new URL('../src/components/dashboard/ReceiptReviews.vue',import.meta.url),'utf8');
  assert.match(source,/receiptRecoveryBucket\(sale\.syncError\) === 'dismissal'/);
 assert.match(source,/receiptRecoveryBucket\(sale\.syncError\) === 'retry'/);
 assert.match(source,/<h2>Retry sync<\/h2>/);
 assert.match(source,/await Store\.refreshPending\(\);\s*await Store\.refreshReceiptReviews\(\);/,
  'payment reviews must re-read the IndexedDB outbox before classifying recovery rows');
  assert.match(source,/receipt_review_required_recipe_timing/);
  assert.match(source,/receipt_review_required_delayed_sync/);
  assert.match(source,/receipt_review_required_offline_sync/);
  assert.match(source,/receipt_review_required_offline_time/);
  assert.match(source,/<option value="current_recipe">Current recipe<\/option>/);
 assert.match(source,/<option value="captured_recipe">Recipe active when the sale was captured<\/option>/);
 assert.match(source,/:disabled="approvalBlocked"/);
 assert.match(source,/approveReceiptReview\(selected\.value\.id, explanation, inventoryRecipeResolution\.value\)/);
  assert.match(source,/row\?\.recipeTimingRequired === true/);
  assert.match(source,/e\.message === 'receipt_review_required_recipe_timing'/);
 assert.match(source,/selected\.value = \{ \.\.\.selected\.value, recipeTimingRequired: true \}/);
 assert.match(source,/Approve all eligible/);
 assert.match(source,/Store\.approveAllEligibleReceiptReviews\(bulkRows\.value\.map\(row => row\.id\), explanation\)/);
 assert.match(source,/This records each saved payment and deducts its stock once/);
 assert.match(source,/This reason is recorded against every payment approved in this batch/);
 assert.match(source,/Refresh approval status/);
 assert.match(source,/server response was interrupted/);
 });
 await test('payment reviews refresh across devices and expose server pending reviews in navigation',async()=>{
  const [reviews,shell,pos,preview]=await Promise.all([
   readFile(new URL('../src/components/dashboard/ReceiptReviews.vue',import.meta.url),'utf8'),
   readFile(new URL('../src/components/EditionShell.vue',import.meta.url),'utf8'),
   readFile(new URL('../src/components/dashboard/EditionPos.vue',import.meta.url),'utf8'),
   readFile(new URL('../src/components/dashboard/docdesign/DocumentPreview.vue',import.meta.url),'utf8'),
  ]);
  assert.match(reviews,/addEventListener\('focus', refreshVisible\)/);
  assert.match(reviews,/setInterval\(refreshVisible, 10000\)/);
  assert.match(reviews,/Choose a company to review payments/);
  assert.match(shell,/serverReviewCount/);
  assert.match(shell,/pending payment reviews/);
  assert.match(pos,/syncStatus==='review'/);
  assert.match(pos,/Payment secured on the server\. Manager review pending\./);
  assert.match(pos,/The full payment record is secured on the server and is awaiting a manager or workspace owner/);
  assert.match(preview,/Payment secured on server · Awaiting manager review/);
 });
}finally{Store.clearSession();await vite.close();}
