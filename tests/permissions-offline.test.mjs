import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {stripConfidential,permissionsFor} from '../src/domain/permissions.js';
import {canVisit,hydrationCollections,manageableAccount} from '../src/domain/viewAccess.js';
import {CACHE_POLICY_VERSION,safePaidSale,localReceiptPresentation,needsReceiptReview} from '../src/domain/offlinePolicy.js';
import {createSale} from '../src/domain/pos.js';
import {exportProductsCsv,importProductsCsv,templateCsv,parseCsv} from '../src/domain/inventoryCsv.js';
const owner={uid:'owner',role:'super'},manager={uid:'manager',role:'company_admin',company_id:'a'},staff={uid:'staff',role:'company_user',company_id:'a'};
const aliases={cost:2,totalCost:8,unit_cost:2,purchase_price:2,cost_price:2,gross_profit:3,net_profit:3,cost_total:8,inventory_value:10,financial_reports:{secret:1}};
const original={id:'already-paid-original',schemaVersion:2,cashierId:'staff',company_id:'a',date:'2026-09-12T22:30:00Z',number:'POS-ORIGINAL',subtotal:20,discount:5,discountAmount:1,taxRate:6,tax:1.14,total:20.14,received:50,change:29.86,items:[{productId:'p',variantId:'v',desc:'Original goods',qty:2,price:10,...aliases}],storeSnapshot:{name:'Original merchant',currency:'RM',footer:'Original footer',...aliases},...aliases};
const raw=await new Promise((resolve,reject)=>{const r=indexedDB.open('myfin-pos',2);r.onupgradeneeded=()=>{for(const n of ['catalog','profiles','drafts'])r.result.createObjectStore(n);r.result.createObjectStore('outbox',{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
await new Promise((resolve,reject)=>{const tx=raw.transaction(['catalog','profiles','drafts','outbox'],'readwrite');tx.objectStore('catalog').put({products:[{id:'p',...aliases,variants:[{id:'v',price:10,...aliases}]}],clients:[{id:'customer',type:'Customer'},{id:'supplier',type:'Supplier'}],expenses:[{amount:999}]},'staff:a');tx.objectStore('profiles').put({user:{...staff,password:'must not survive'},companies:[{id:'a',name:'A',financialSummary:{amount:999},preferences:{currency:'RM',staffDiscountLimit:0,cashBalance:999},...aliases}]},'staff');tx.objectStore('drafts').put({cart:original.items,held:[{items:original.items}]},'staff:a:till');tx.objectStore('outbox').put(original);tx.objectStore('outbox').put({...original,id:'different-cashier',cashierId:'other'});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});raw.close();
const {localPos}=await import('../src/services/posLocal.js');
await test('v2 cache migration strips confidential data in every store without changing paid receipt identity or amounts',async()=>{
 await localPos.ready();
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('myfin-pos',CACHE_POLICY_VERSION);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 try{for(const name of ['catalog','profiles','drafts','outbox']){const rows=await new Promise((resolve,reject)=>{const tx=db.transaction(name),r=tx.objectStore(name).getAll();tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);});assert.deepEqual(rows,stripConfidential(rows));}
 const queue=await localPos.sales('staff','a');assert.equal(queue.length,1);assert.deepEqual(queue[0],safePaidSale(original));for(const key of ['id','cashierId','company_id','number','date','total','subtotal','discount','discountAmount','taxRate','tax','received','change'])assert.equal(queue[0][key],original[key]);
 assert.equal((await localPos.sales('other','a')).length,1);assert.equal((await localPos.sales('staff','b')).length,0);
 const catalog=await localPos.getCatalog('staff','a');assert.deepEqual(catalog.clients.map(c=>c.id),['customer']);assert.equal(catalog.expenses,undefined);
 const profile=await localPos.getProfile('staff');assert.equal(profile.user.password,undefined);assert.equal(profile.companies[0].financialSummary,undefined);assert.equal(profile.companies[0].preferences.cashBalance,undefined);
 const draft=await localPos.getDraft('staff:a:till');assert.deepEqual(draft.cart,safePaidSale(original.items));assert.deepEqual(draft.held[0].items,draft.cart);
 }finally{db.close();}
});
await test('new owner caches and paid-queue rewrites remain costless; retry errors never change original payment facts',async()=>{
 await localPos.putCatalog('owner','a',{products:[{id:'p',...aliases}],clients:[]});assert.deepEqual((await localPos.getCatalog('owner','a')).products,[{id:'p'}]);
 await localPos.putSale({...original,syncError:'receipt_review_required'});assert.deepEqual((await localPos.sales('staff','a'))[0],{...safePaidSale(original),syncError:'receipt_review_required'});
});
await test('one shared permission matrix controls routes, data hydration and staff-account management',()=>{
 for(const actor of [manager,staff])for(const action of ['costsRead','costsWrite','bulkExport','managersManage'])assert.equal(permissionsFor(actor)[action],false);
 for(const action of ['financialReports','expensesRead','expensesWrite','suppliersRead'])assert.equal(permissionsFor(manager)[action],true);
 for(const action of ['financialReports','expensesWrite','suppliersRead'])assert.equal(permissionsFor(staff)[action],false);
 assert.equal(permissionsFor(staff).expensesRead,true);
 for(const actor of [owner,manager,staff])assert.ok(canVisit(actor,'/receipt-reviews'));
 for(const path of ['/analytics','/expenses','/activity'])assert.equal(canVisit(manager,path),true);
 assert.equal(canVisit(staff,'/expenses'),true);
 for(const path of ['/analytics','/activity'])assert.equal(canVisit(staff,path),false);
 assert.equal(canVisit(staff,'/users'),false);assert.equal(canVisit(manager,'/templates'),true);
 assert.deepEqual(hydrationCollections(staff),['products','transactions','clients','expenses','stock_items']);assert.deepEqual(hydrationCollections(manager),['products','transactions','clients','expenses','activities','stock_items','stock_movements','stock_ledger']);assert.equal(hydrationCollections(owner).length,8);
 assert.equal(manageableAccount(manager,staff),true);assert.equal(manageableAccount(manager,{...staff,company_id:'b'}),false);assert.equal(manageableAccount(manager,{...manager,uid:'other-manager'}),false);assert.equal(manageableAccount(staff,staff),false);
});
await test('manager inventory CSV has no cost column or values and rejects owner cost imports',()=>{
 const rows=[{sku:'A',name:'Item',category:'Retail',unit:'pcs',trackStock:true,price:11,cost:93847,stock:2}];
 const csv=exportProductsCsv(rows,{includeCosts:false});assert.ok(!csv.includes('93847'));assert.ok(!parseCsv(csv)[0].includes('cost'));
 const imported=importProductsCsv(csv,[],{includeCosts:false});assert.equal(imported[0].cost,undefined);assert.equal(imported[0].price,11);
 assert.throws(()=>importProductsCsv(templateCsv(),[],{includeCosts:false}),/cost-free/);assert.ok(!parseCsv(templateCsv({includeCosts:false}))[0].includes('cost'));
});
await test('discount totals and immutable template reference retain receipt ID with presentation stored separately',()=>{
 const company={id:'a',name:'Merchant',receiptTemplate:{id:'published-v',version:3,settings:{accent:'#123456'}},preferences:{taxRate:6,currency:'RM'}};
 const sale=createSale({id:'fixed-paid-id',items:[{productId:'p',qty:2,price:10}],company,user:staff,method:'Cash',received:50,discount:5,overrideReason:'Approved offer'});
 assert.equal(sale.schemaVersion,3);assert.equal(sale.totalBeforeRounding,20.14);assert.equal(sale.rounding,.01);assert.equal(sale.total,20.15);assert.equal(sale.received,50);assert.equal(sale.change,29.85);assert.equal(sale.id,'fixed-paid-id');assert.equal(sale.receiptTemplateVersion,3);assert.equal(sale.templateSnapshot,undefined);assert.equal(sale.companySnapshot,undefined);
 const local=localReceiptPresentation(sale,company);assert.deepEqual(local.templateSnapshot,company.receiptTemplate.settings);assert.equal(local.companySnapshot.name,'Merchant');assert.equal(local.id,sale.id);assert.equal(local.total,sale.total);
});

await test('review eligibility matches real suffixed server codes without retrying altered receipt payloads',()=>{
 for(const message of ['receipt_review_required','receipt_review_required_pricing_policy','receipt_review_required_merchant_changed','receipt_review_required_product_changed','manager_override_reason_required','stock_unavailable'])assert.ok(needsReceiptReview({message}));
 for(const message of ['receipt_payload_changed','invalid_input','session_required','product_not_found'])assert.equal(needsReceiptReview(message),false);
});
