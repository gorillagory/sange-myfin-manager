import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { bindPosPricingQuote, cents, totalsFor, roundToFiveSen, checkoutTotalsFor, saleTotalsFor, normalizeProduct, cartItem, createSale, deductItems, isPaid, businessDate, expenseRecords, limitsSaleQuantity, posPricingQuoteMatchesCheckout, pricingQuoteTenderState, sellableQuantity } from '../src/domain/pos.js';
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
test('displayed exact cash is accepted; rounded tender and catalog evidence persist',()=>{const sale=createSale({id:'stable',items:[cartItem(product)],company,user,method:'Cash',received:0.10});assert.equal(sale.schemaVersion,3);assert.equal(sale.totalBeforeRounding,0.11);assert.equal(sale.rounding,-0.01);assert.equal(sale.total,0.10);assert.equal(sale.change,0);assert.equal(sale.received,0.10);assert.equal(sale.items[0].productId,'coffee');assert.equal(sale.items[0].catalogPrice,.1);assert.equal(sale.items[0].catalogVersion,1);assert.equal(sale.items[0].priceSource,'catalog');assert.equal(sale.storeSnapshot.name,'Shop');for(const method of ['QR Pay','Card']){const external=createSale({id:method.replace(' ',''),items:[cartItem(product)],company,user,method,confirmed:true});assert.equal(external.total,0.10);assert.equal(external.received,0.10);assert.equal(external.change,0);}});
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
test('snapshot-backed POS sales preserve a separately disclosed discretionary percentage',()=>{
 const items=[cartItem({...product,price:20})];
 const lockedTotals={subtotal:20,discountAmount:2.15,tax:1.07,taxRate:6,discount:5,
   promotionDiscountAmount:1.25,manualDiscountAmount:.90,totalBeforeRounding:18.92,rounding:-.02,total:18.90};
 const sale=createSale({id:'combined-discount-sale',items,company,user,method:'Cash',received:20,
   lockedTotals,pricingSnapshotId:'snapshot-combined'});
 assert.equal(sale.discount,5);assert.equal(sale.discountAmount,2.15);assert.equal(sale.change,1.10);
 assert.deepEqual(saleTotalsFor(sale),{subtotal:20,discountAmount:2.15,tax:1.07,taxRate:6,
   totalBeforeRounding:18.92,rounding:-.02,total:18.90,discount:5});
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
test('legacy SKU, tax, variants, active state and service stock adapt without data migration',()=>{const p=normalizeProduct({id:'v',code:'OLD',category:'Retail',variants:[{name:'Blue',price:10,stock:2}]});assert.equal(p.sku,'OLD');assert.equal(p.active,true);assert.equal(normalizeProduct({name:'Retired',active:false}).active,false);assert.equal(p.variants[0].id,'legacy-0');assert.equal(cartItem(p,p.variants[0]).variantId,'legacy-0');assert.equal(normalizeProduct({name:'Service',category:'Service',stock:0}).trackStock,false);assert.equal(normalizeProduct({name:'Uncounted'}).trackStock,false);});
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
 assert.match(posSource,/Store\.state\.products\.filter\(product=>product\.active!==false\)/);
});
test('staff POS previews automatic promotions without writes and locks the authoritative quote at payment',()=>{
 assert.match(posSource,/watch\(\[cart,customerId,discount,voucherCode,sourceRequest\],schedulePricing/);
 assert.match(posSource,/lock:required/);
 assert.match(posSource,/checkoutId:saleId\.value/);
 assert.match(posSource,/required&&!force&&lockedPricingReady\(\)/);
 assert.match(posSource,/const quoteDiscounts=computed\(\(\)=>sourceRequest\.value\?\.discounts\|\|pricingQuote\.value\?\.discounts/);
 assert.match(posSource,/Discretionary discount/);
 assert.match(posSource,/Scan or enter reusable code/);
 assert.match(posSource,/\/pos\/promotions/);
 assert.match(posSource,/Promotions for this checkout/);
 assert.match(posSource,/Automatic offers are checked/);
 assert.match(posSource,/Customer saves/);
 assert.match(posSource,/offer\.voucherApplied\?'Code':'Automatic'/);
 assert.match(posSource,/clearPromotionCode/);
 assert.match(posSource,/voucher_invalid_or_unavailable/);
 assert.match(posSource,/<s v-if="pricingLine\(i\)\?\.savings">/);
 assert.match(posSource,/Automatic reward/);
 assert.match(posSource,/quotedSaleItems\(activeQuote\)/);
 assert.match(posSource,/line\.automaticReward/);
 assert.match(posSource,/quoteStockError\(currentLockedPricingQuote\(\)\)/);
 assert.match(posSource,/serverClockOffsetMs/);
 assert.match(posSource,/pos\/quote\/release/);
 assert.match(posSource,/pricingBusy\|\|!ready/);
});
test('a delayed locked quote pauses tender before server expiry',()=>{
 const quote={pricingSnapshotId:'snapshot-a',expiresAt:'2026-10-16T10:05:00.000Z'};
 assert.deepEqual(pricingQuoteTenderState(quote,new Date('2026-10-16T10:00:00.000Z')),
  {remainingMs:300000,secondsRemaining:300,ready:true});
 assert.equal(pricingQuoteTenderState(quote,new Date('2026-10-16T10:04:00.000Z')).ready,false);
 assert.equal(pricingQuoteTenderState({...quote,pricingSnapshotId:''},new Date('2026-10-16T10:00:00.000Z')).ready,false);
 assert.deepEqual(pricingQuoteTenderState({...quote,serverClockOffsetMs:120000},new Date('2026-10-16T09:58:00.000Z')),
  {remainingMs:300000,secondsRemaining:300,ready:true},'the countdown follows server time despite a slow device clock');
 assert.match(posSource,/if\(pricingHoldRequired\.value&&!lockedPricingReady\(\)\)/);
 assert.match(posSource,/Price hold paused before expiry\. Do not collect or confirm payment/);
 assert.match(posSource,/:disabled="busy\|\|!!tenderRetry\|\|!pricingTenderReady"/);
 assert.match(posSource,/@click="refreshPaymentPricing"/);
});
test('an offline POS quote stays usable only for the exact locked checkout and principal',()=>{
 const checkout={companyId:'company-a',staffId:'cashier-a',checkoutId:'sale-a',
  lines:[{productId:'latte',variantId:'large',quantityMilli:2000},{productId:'cake',variantId:'',quantityMilli:1000}],
  clientId:'client-a',voucherCode:' SAVE10 ',manualDiscountBasisPoints:250};
 const quote=bindPosPricingQuote({pricingSnapshotId:'snapshot-a',expiresAt:'2026-10-16T10:05:00.000Z'},checkout);
 assert.equal(posPricingQuoteMatchesCheckout(quote,checkout),true);
 const changes=[
  {companyId:'company-b'},{staffId:'cashier-b'},{checkoutId:'sale-b'},{clientId:'client-b'},
  {voucherCode:'SAVE20'},{manualDiscountBasisPoints:251},
  {lines:[...checkout.lines].reverse()},
  {lines:[{...checkout.lines[0],quantityMilli:1000},checkout.lines[1]]},
 ];
 for(const change of changes)assert.equal(posPricingQuoteMatchesCheckout(quote,{...checkout,...change}),false);
 assert.equal(posPricingQuoteMatchesCheckout({...quote,pricingSnapshotId:''},checkout),false);
 assert.match(posSource,/pricingQuote:pricingQuote\.value\?\.pricingSnapshotId\?pricingQuote\.value:null/);
 assert.match(posSource,/function currentLockedPricingQuote\(\)\{return posPricingQuoteMatchesCheckout/);
 assert.match(posSource,/if\(pricingHoldRequired\.value&&!lockedPricingReady\(\)\)/);
 assert.doesNotMatch(posSource,/if\(activeQuote&&!sourceRequest\.value&&\(!Store\.state\.online\|\|Store\.state\.fromCache\)\)/);
 assert.match(posSource,/if\(sourceRequest\.value&&\(!Store\.state\.online\|\|Store\.state\.fromCache\)\)return Store\.notify\('Reconnect before taking payment for an online order request\.'/);
 assert.match(posSource,/sourceRequest\.value\?\(Store\.state\.online&&!Store\.state\.fromCache\):pricingTender\.value\.ready/);
 assert.match(posSource,/modal\.value!=='payment'&&pricingQuote\.value\?\.pricingSnapshotId&&!lockedPricingReady\(\)/);
 assert.match(posSource,/if\(!Store\.state\.online\|\|Store\.state\.fromCache\)\{error\.value='Reconnect to refresh and lock promotional pricing before collecting payment\.'/);
 assert.match(posSource,/let sale=tenderRetry\.value\?\.sale/,'an already-paid interrupted tender still bypasses new quote creation');
});
test('a server-aligned capture instant is recorded for an online locked tender',()=>{
 const occurredAt='2026-10-16T10:01:02.000Z',sale=createSale({id:'server-clock',items:[cartItem(product)],company,user,
  method:'Cash',received:1,occurredAt});
 assert.equal(sale.date,occurredAt);
 assert.equal(sale.businessDate,'2026-10-16');
 assert.throws(()=>createSale({id:'bad-clock',items:[cartItem(product)],company,user,method:'Cash',received:1,
  occurredAt:'not-a-time'}),/payment time is invalid/i);
});
test('staff POS verifies online-payment evidence before loading a customer order',()=>{
 assert.match(posSource,/Promise\.all\(\[api\(orderPath\),api\(`\$\{orderPath\}\/online-payment`\)\]\)/);
 assert.match(posSource,/isTenderableCustomerOrder\(detail\.order,onlinePayment\)/);
 assert.match(posSource,/blocksCounterPayment\(onlinePayment\)/);
 assert.match(posSource,/Do not collect payment again\. Review the provider evidence in Sales Orders\./);
});
test('deduction aggregates quantities, isolates variants and rejects overselling',()=>{const p=normalizeProduct({id:'v',name:'Cup',trackStock:true,variants:[{id:'a',name:'A',price:10,stock:2},{id:'b',name:'B',price:10,stock:4}]});const result=deductItems([p],[{...cartItem(p,p.variants[0]),qty:2}]);assert.equal(result.updates[0].variants[0].stock,0);assert.equal(result.updates[0].variants[1].stock,4);assert.equal(p.variants[0].stock,2);assert.throws(()=>deductItems([product],[{...cartItem(product),qty:4}]));});
test('accepted offline sale preserves stock shortage for review',()=>{const result=deductItems([product],[{...cartItem(product),qty:4}],true);assert.equal(result.updates[0].stock,-1);assert.equal(result.shortage,true);});
test('reports agree on legacy paid statuses and Malaysian dates',()=>{assert.ok(isPaid({type:'Invoice',status:'Cleared'}));assert.ok(isPaid({type:'Invoice',status:'Paid'}));assert.equal(isPaid({type:'Quote',status:'Paid'}),false);assert.equal(businessDate('2026-09-09T18:00:00Z'),'2026-09-10');assert.equal(businessDate('2026-09-09'),'2026-09-09');});
test('voided historical expenses do not appear in expense records or report inputs',()=>{const rows=expenseRecords({expenses:[],transactions:[{id:'active',type:'Expense',status:'Paid',total:12},{id:'voided',type:'Payment Voucher',status:'Voided',total:40}]});assert.deepEqual(rows.map(row=>[row.id,row.amount]),[['active',12]]);});
