import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { cents, totalsFor, roundToFiveSen, checkoutTotalsFor, saleTotalsFor, normalizeProduct, cartItem, createSale, deductItems, isPaid, businessDate, expenseRecords, limitsSaleQuantity, sellableQuantity } from '../src/domain/pos.js';
const company={id:'shop',name:'Shop',preferences:{tax:6,currency:'RM'}},user={uid:'cashier',username:'Cashier'};
const product=normalizeProduct({id:'coffee',name:'Coffee',sku:'COF-1',price:0.1,stock:3,trackStock:true});
const posFilename=new URL('../src/components/dashboard/EditionPos.vue',import.meta.url);
const posSource=await readFile(posFilename,'utf8');
test('currency rounds at line and tax boundaries',()=>{const totals=totalsFor([{qty:3,price:0.1}],6);assert.equal(totals.total,0.32);assert.equal(totals.tax,0.02);assert.equal(cents(36.5),3650);});
test('Malaysian counter rounding covers every sen ending without changing ordinary document totals',()=>{
 const expected=[[19.90,0,19.90],[19.91,-.01,19.90],[19.92,-.02,19.90],[19.93,.02,19.95],[19.94,.01,19.95],[19.95,0,19.95],[19.96,-.01,19.95],[19.97,-.02,19.95],[19.98,.02,20],[19.99,.01,20]];
 for(const [before,rounding,total] of expected)assert.deepEqual(roundToFiveSen(before),{totalBeforeRounding:before,rounding,total});
 assert.equal(totalsFor([{qty:1,price:19.93}]).total,19.93);assert.deepEqual(checkoutTotalsFor([{qty:1,price:19.93}]),{subtotal:19.93,discountAmount:0,tax:0,totalBeforeRounding:19.93,rounding:.02,total:19.95,taxRate:0,discount:0});
 const items=[{qty:1,price:19.93}],rounded={schemaVersion:3,items,taxRate:0,discount:0,totalBeforeRounding:19.93,rounding:.02};assert.equal(saleTotalsFor(rounded).total,19.95);assert.equal(saleTotalsFor({schemaVersion:2,items,taxRate:0,discount:0}).total,19.93);assert.throws(()=>saleTotalsFor({...rounded,rounding:undefined}),/required/);assert.throws(()=>saleTotalsFor({schemaVersion:2,items,taxRate:0,discount:0,rounding:0}),/Legacy/);
});
test('displayed exact cash is accepted; rounded tender and change persist',()=>{const sale=createSale({id:'stable',items:[cartItem(product)],company,user,method:'Cash',received:0.10});assert.equal(sale.schemaVersion,3);assert.equal(sale.totalBeforeRounding,0.11);assert.equal(sale.rounding,-0.01);assert.equal(sale.total,0.10);assert.equal(sale.change,0);assert.equal(sale.received,0.10);assert.equal(sale.items[0].productId,'coffee');assert.equal(sale.storeSnapshot.name,'Shop');for(const method of ['QR Pay','Card']){const external=createSale({id:method.replace(' ',''),items:[cartItem(product)],company,user,method,confirmed:true});assert.equal(external.total,0.10);assert.equal(external.received,0.10);assert.equal(external.change,0);}});
test('delivery fee is an exact-sen sale fact collected before five-sen rounding',()=>{
 const items=[{qty:1,price:19.91}],totals=checkoutTotalsFor(items,0,0,2.53);
 assert.deepEqual(totals,{subtotal:19.91,discountAmount:0,tax:0,deliveryFee:2.53,totalBeforeRounding:22.44,rounding:.01,total:22.45,taxRate:0,discount:0});
 const delivery=createSale({id:'delivery',items:[cartItem({...product,price:19.91})],company:{...company,preferences:{...company.preferences,tax:0}},user,method:'Cash',received:22.45,deliveryFee:2.53});
 assert.equal(delivery.deliveryFee,2.53);assert.equal(delivery.total,22.45);assert.equal(delivery.received,22.45);assert.equal(delivery.change,0);
 assert.deepEqual(saleTotalsFor(delivery),totals);
 assert.throws(()=>createSale({id:'short',items:[cartItem({...product,price:19.91})],company:{...company,preferences:{...company.preferences,tax:0}},user,method:'Cash',received:22.44,deliveryFee:2.53}),/enough cash/);
 assert.throws(()=>checkoutTotalsFor(items,0,0,2.531),/exact amount in sen/);
 assert.throws(()=>saleTotalsFor({schemaVersion:2,items,taxRate:0,discount:0,deliveryFee:0}),/Legacy/);
 assert.equal(Object.hasOwn(createSale({id:'pickup',items:[cartItem(product)],company,user,method:'Cash',received:1}),'deliveryFee'),false);
 assert.equal(createSale({id:'free-delivery',items:[cartItem(product)],company,user,method:'Cash',received:1,deliveryFee:0}).deliveryFee,0);
});
test('snapshot-backed sales preserve fixed discounts without inventing a percentage',()=>{
 const items=[cartItem({...product,price:20})];
 const lockedTotals={subtotal:20,discountAmount:1.25,tax:1.13,taxRate:6,totalBeforeRounding:19.88,rounding:.02,total:19.90};
 const sale=createSale({id:'promotion-sale',items,company,user,method:'Cash',received:20,
   lockedTotals,pricingSnapshotId:'snapshot-a'});
 assert.equal(sale.discount,0);assert.equal(sale.discountAmount,1.25);
 assert.equal(sale.pricingSnapshotId,'snapshot-a');assert.equal(sale.change,.10);
 assert.deepEqual(saleTotalsFor(sale),{...lockedTotals,discount:0});
 assert.throws(()=>createSale({id:'changed-promotion',items,company,user,method:'Cash',received:20,
   lockedTotals:{...lockedTotals,discountAmount:1.24},pricingSnapshotId:'snapshot-a'}),/accepted quote totals are invalid/);
 assert.throws(()=>createSale({id:'missing-snapshot',items,company,user,method:'Cash',received:20,
   lockedTotals}),/accepted quote is incomplete/);
});
test('snapshot-backed fractional quantities use the server integer-sen rounding boundary',()=>{
 const items=[{...cartItem({...product,price:.25}),qty:.58}];
 const lockedTotals={subtotal:.15,discountAmount:0,tax:0,taxRate:0,totalBeforeRounding:.15,rounding:0,total:.15};
 const sale=createSale({id:'fractional-promotion-sale',items,company,user,method:'Cash',received:.15,
   lockedTotals,pricingSnapshotId:'snapshot-fractional'});
 assert.equal(sale.subtotal,.15);assert.equal(sale.total,.15);
 assert.throws(()=>createSale({id:'over-precise-quantity',items:[{...items[0],qty:.5801}],company,user,
   method:'Cash',received:.15,lockedTotals,pricingSnapshotId:'snapshot-fractional'}),/accepted quote totals are invalid/);
});
test('invalid tender, quantity and external confirmation are rejected',()=>{for(const received of [0,-1,NaN])assert.throws(()=>createSale({id:'x',items:[cartItem(product)],company,user,method:'Cash',received}));assert.throws(()=>totalsFor([{price:1,qty:0}]));assert.throws(()=>createSale({id:'x',items:[cartItem(product)],company,user,method:'Card',received:1,confirmed:false}));});
test('legacy SKU, tax, variants and service stock adapt without data migration',()=>{const p=normalizeProduct({id:'v',code:'OLD',category:'Retail',variants:[{name:'Blue',price:10,stock:2}]});assert.equal(p.sku,'OLD');assert.equal(p.variants[0].id,'legacy-0');assert.equal(cartItem(p,p.variants[0]).variantId,'legacy-0');assert.equal(normalizeProduct({name:'Service',category:'Service',stock:0}).trackStock,false);assert.equal(normalizeProduct({name:'Uncounted'}).trackStock,false);});
test('recipe-tracked products use projected sellable quantities without changing legacy untracked products',()=>{
 const root=normalizeProduct({id:'latte',name:'Latte',trackStock:false,recipeTracked:true,availableQuantity:3});
 const variants=normalizeProduct({id:'tea',name:'Tea',trackStock:false,recipeTracked:true,availableQuantity:99,variants:[
  {id:'hot',name:'Hot',recipeTracked:true,availableQuantity:2},{id:'iced',name:'Iced',recipeTracked:true,availableQuantity:4},{id:'unprojected',name:'Unprojected'},
 ]});
 assert.equal(limitsSaleQuantity(root),true);assert.equal(sellableQuantity(root),3);
 assert.equal(sellableQuantity(variants,variants.variants[0]),2);
 assert.equal(sellableQuantity(variants,variants.variants[2]),Infinity);
 assert.equal(sellableQuantity(variants,{id:'missing'}),0);
 assert.equal(sellableQuantity({...root,availableQuantity:'3'}),0);
 assert.equal(sellableQuantity({...root,availableQuantity:NaN}),0);
 const service=normalizeProduct({id:'service',name:'Service',trackStock:false,availableQuantity:0});
 assert.equal(limitsSaleQuantity(service),false);assert.equal(sellableQuantity(service),Infinity);
 const mixed=normalizeProduct({id:'mixed',name:'Mixed',trackStock:false,recipeTracked:true,variants:[
  {id:'made',name:'Made',recipeTracked:true,availableQuantity:1},{id:'service',name:'Service'},
 ]});
 assert.equal(limitsSaleQuantity(mixed,mixed.variants[0]),true);
 assert.equal(limitsSaleQuantity(mixed,mixed.variants[1]),false);
 assert.equal(sellableQuantity(mixed,mixed.variants[1]),Infinity);
});
test('recipe availability subtracts matching queued receipts and fails closed on an invalid matching quantity',()=>{
 const product=normalizeProduct({id:'latte',name:'Latte',trackStock:false,recipeTracked:true,availableQuantity:5,variants:[
  {id:'large',name:'Large',recipeTracked:true,availableQuantity:3},{id:'small',name:'Small',recipeTracked:true,availableQuantity:4},
 ]});
 const pending=[{items:[{productId:'latte',variantId:'large',qty:2},{productId:'latte',variantId:'small',qty:1},{productId:'other',variantId:'',qty:10}]}];
 assert.equal(sellableQuantity(product,product.variants[0],pending),1);
 assert.equal(sellableQuantity(product,product.variants[1],pending),3);
 assert.equal(sellableQuantity(product,product.variants[0],[...pending,{items:[{productId:'latte',variantId:'large',qty:'bad'}]}]),0);
 const catalog=normalizeProduct({id:'cup',name:'Cup',trackStock:true,stock:4});
 assert.equal(sellableQuantity(catalog,null,[{items:[{productId:'cup',variantId:'',qty:1}]}]),3);
});
test('staff POS compiles and applies the shared availability guard across cart controls',()=>{
 const parsed=parse(posSource,{filename:posFilename.pathname});assert.deepEqual(parsed.errors,[]);
 const script=compileScript(parsed.descriptor,{id:'edition-pos-availability-test'});
 const template=compileTemplate({source:parsed.descriptor.template.content,filename:posFilename.pathname,
  id:'edition-pos-availability-test',compilerOptions:{bindingMetadata:script.bindings}});
 assert.deepEqual(template.errors,[]);
 assert.match(posSource,/return sellableQuantity\(product,variant,Store\.state\.pendingSales\)/);
 assert.match(posSource,/limitsSaleQuantity\(product,variant\)&&quantityInCart\(product,variant\)\+1>available/);
 assert.match(posSource,/limitsSaleQuantity\(product,variant\)&&q>available/);
 assert.match(posSource,/limitsSaleQuantity\(p,v\)&&item\.qty>available/);
 assert.match(posSource,/p\.variants\.every\(v=>limitsSaleQuantity\(p,v\)&&available/);
 assert.match(posSource,/limitsSaleQuantity\(variantProduct,v\)&&available/);
});
test('deduction aggregates quantities, isolates variants and rejects overselling',()=>{const p=normalizeProduct({id:'v',name:'Cup',trackStock:true,variants:[{id:'a',name:'A',price:10,stock:2},{id:'b',name:'B',price:10,stock:4}]});const result=deductItems([p],[{...cartItem(p,p.variants[0]),qty:2}]);assert.equal(result.updates[0].variants[0].stock,0);assert.equal(result.updates[0].variants[1].stock,4);assert.equal(p.variants[0].stock,2);assert.throws(()=>deductItems([product],[{...cartItem(product),qty:4}]));});
test('accepted offline sale preserves stock shortage for review',()=>{const result=deductItems([product],[{...cartItem(product),qty:4}],true);assert.equal(result.updates[0].stock,-1);assert.equal(result.shortage,true);});
test('reports agree on legacy paid statuses and Malaysian dates',()=>{assert.ok(isPaid({type:'Invoice',status:'Cleared'}));assert.ok(isPaid({type:'Invoice',status:'Paid'}));assert.equal(isPaid({type:'Quote',status:'Paid'}),false);assert.equal(businessDate('2026-09-09T18:00:00Z'),'2026-09-10');assert.equal(businessDate('2026-09-09'),'2026-09-09');});
test('voided historical expenses do not appear in expense records or report inputs',()=>{const rows=expenseRecords({expenses:[],transactions:[{id:'active',type:'Expense',status:'Paid',total:12},{id:'voided',type:'Payment Voucher',status:'Voided',total:40}]});assert.deepEqual(rows.map(row=>[row.id,row.amount]),[['active',12]]);});
