import 'fake-indexeddb/auto';
import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'vite';
const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
const vite=await createServer({server:{middlewareMode:true,hmr:{port:0}},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
const {Store}=await vite.ssrLoadModule('/src/store/editionStore.js');
const {localPos}=await vite.ssrLoadModule('/src/services/posLocal.js');
const {checkoutPayload}=await vite.ssrLoadModule('/src/services/postSale.js');
const {inventoryModule}=await vite.ssrLoadModule('/src/store/inventory.js');
const staff={uid:'cashier',id:'cashier',role:'company_user',company_id:'a'};
const owner={...staff,role:'super',company_id:''};
const response=(value,status=200)=>({ok:status<400,status,json:async()=>value});
let actor=staff,requested=[],reviewRows=[],checkoutMode='conflict',reviewFails=false;
function installFetch(){globalThis.fetch=async(path,options={})=>{requested.push({path,options});if(path==='/api/me')return response(actor);if(path.endsWith('/receipt-reviews')){if(options.method==='POST'){if(reviewFails)return response({error:'internal_error'},500);reviewRows=[{id:'original-paid',status:'pending',sale:JSON.parse(options.body).sale}];return response({id:'original-paid',status:'pending'});}return response(reviewRows);}
 if(path.endsWith('/checkout'))return checkoutMode==='posted'?response(JSON.parse(options.body)):response({error:'receipt_review_required_pricing_policy'},409);
 if(options.method==='PUT'||options.method==='POST')return response(JSON.parse(options.body));
 return response({rows:[{id:'fresh',price:10,cost:5,variants:[{id:'v',cost:2,price:10}],type:'Customer'}],next:null});};}
function reset(user=staff){Store.clearSession();Store.state.currentUser={...user};Store.state.selectedCompany={id:'a',name:'A'};Store.state.companies=[Store.state.selectedCompany];Store.state.online=true;Store.state.fromCache=false;actor={...user};requested=[];reviewRows=[];installFetch();}
try{
 await test('reconnect refreshes actor and discards former owner data before staff hydration',async()=>{
  reset(owner);Store.state.products=[{id:'sensitive',cost:5}];Store.state.expenses=[{amount:999}];Store.state.activities=[{secret:1}];Store.state.users=[{id:'owner-only'}];actor=staff;
  await Store.refreshActor();assert.equal(Store.state.currentUser.role,'company_user');assert.deepEqual(Store.state.products,[]);assert.deepEqual(Store.state.expenses,[]);assert.deepEqual(Store.state.users,[]);
  await Store.refreshData();assert.equal(Store.state.products[0].cost,undefined);assert.equal(Store.state.products[0].variants[0].cost,undefined);
  for(const path of ['expenses','activities','stock_movements','users'])assert.ok(!requested.some(r=>r.path.endsWith('/'+path)));
  assert.equal(Store.state.sessionVerified,true);
 });
 await test('an in-flight owner hydration cannot repopulate costs after a role downgrade',async()=>{
  reset(owner);const held=[];globalThis.fetch=async path=>path==='/api/me'?response(staff):new Promise(resolve=>held.push(()=>resolve(response({rows:[{id:'late-owner',cost:88}],next:null}))));
  const earlier=Store.refreshData();await new Promise(r=>setTimeout(r,5));assert.equal(held.length,6);await Store.refreshActor();held.forEach(resolve=>resolve());await earlier;assert.deepEqual(Store.state.products,[]);assert.deepEqual(Store.state.expenses,[]);
 });
 await test('paid conflict requests review without changing original amounts; failed request stays queued; approved retry clears only same cashier receipt',async()=>{
  reset();checkoutMode='conflict';reviewFails=true;
  const original={id:'original-paid',schemaVersion:2,cashierId:'cashier',company_id:'a',number:'POS-ORIGINAL',total:20.14,received:50,change:29.86,items:[{productId:'p',price:10,qty:2,cost:7}],storeSnapshot:{name:'Original'},templateSnapshot:{accent:'blue'},companySnapshot:{name:'Original'},receiptTemplateId:'t',receiptTemplateVersion:3};
  const accepted=await Store.completeSale(original,'cashier:a:till',{cart:[]});assert.equal(accepted.syncStatus,'pending');assert.equal((await localPos.sales('cashier','a')).length,1);assert.equal(requested.filter(r=>r.path.endsWith('/receipt-reviews')&&r.options.method==='POST').length,1);
  reviewFails=false;requested=[];await Store.syncSales();assert.equal(requested[0].path,'/api/me');const review=requested.find(r=>r.path.endsWith('/receipt-reviews')&&r.options.method==='POST');const body=JSON.parse(review.options.body).sale;
  assert.equal(body.id,original.id);assert.equal(body.total,original.total);assert.equal(body.received,50);assert.equal(body.change,29.86);assert.equal(body.items[0].cost,undefined);assert.equal(body.templateSnapshot,undefined);assert.equal(body.companySnapshot,undefined);assert.equal(body.syncError,undefined);assert.deepEqual(body,checkoutPayload(original));
  assert.equal((await localPos.sales('cashier','a')).length,1);assert.equal(Store.state.receiptReviews[0].status,'pending');
  await localPos.putSale({...original,id:'another-cashier',cashierId:'another'});checkoutMode='posted';await Store.syncSales();assert.equal((await localPos.sales('cashier','a')).length,0);assert.equal((await localPos.sales('another','a')).length,1);
 });
 await test('fresh actor moved to another company cannot post an old workspace queue',async()=>{
  reset();await localPos.putSale({id:'old-workspace',cashierId:'cashier',company_id:'a',total:10});actor={...staff,company_id:'b'};await Store.syncSales();assert.ok(!requested.some(r=>r.path.endsWith('/checkout')));assert.equal((await localPos.sales('cashier','a')).length,1);assert.equal(Store.state.selectedCompany,null);
 });
 await test('manager product writes strip nested costs and staff cannot invoke catalog mutations',async()=>{
  const product={id:'p',sku:'A',name:'Item',price:10,cost:88,variants:[{id:'v',name:'Option',price:12,cost:99}],hasVariants:true,stock:3};
  const manager={...staff,role:'company_admin'};reset(manager);const mock={state:Store.state,can:action=>Store.can(action),refreshData:async()=>{},notify:()=>{}};
  await inventoryModule.updateProduct(mock,product);const write=requested.find(r=>r.options.method==='PUT');assert.ok(write);const sent=JSON.parse(write.options.body);assert.equal(sent.cost,undefined);assert.equal(sent.variants[0].cost,undefined);
  reset(staff);assert.throws(()=>inventoryModule.addProduct(mock,product),/not allow|manager|permission|access/i);assert.ok(!requested.some(r=>r.options.method==='POST'));
 });
}finally{Store.clearSession();await vite.close();}
