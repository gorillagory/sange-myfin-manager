import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createSale,cartItem,totalsFor,cents } from '../src/domain/pos.js';

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
}finally{Store.clearSession();await vite.close();}
