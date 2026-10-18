import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileScript,compileTemplate,parse} from '@vue/compiler-sfc';
import {expenseTemplateCsv,exportExpensesCsv,importExpensesCsv} from '../src/domain/expensesCsv.js';
import {effectiveExpenseStatus,expenseCommittedRefreshError,expenseHasCashImpact,expenseSaveFailureDisposition,normalizeExpenseLifecycle} from '../src/domain/expenseLifecycle.js';
import {duplicateStockItem,findStockCode,normalizeStockItem,stockConversionText,stockMovement,stockUnitCorrectionPreview,validateStockItem} from '../src/domain/stock.js';
import {recipeAvailability,validateRecipeStockUnits} from '../src/domain/inventoryRecipes.js';

test('expense CSV template imports cents and links an exact supplier',()=>{
 const suppliers=[{id:'supplier-a',name:'Roaster & Co',type:'Supplier'}];
 const csv='date,description,category,amount,supplier_id,supplier_name,payee\n2026-09-29,Beans,Inventory,19.90,,Roaster & Co,';
  assert.deepEqual(importExpensesCsv(csv,suppliers),[{date:'2026-09-29',description:'Beans',category:'Inventory',amount:19.9,
  supplier_id:'supplier-a',payee:'Roaster & Co',status:'paid',paidByType:'other',paidByUserId:'',paidByName:'Imported / unspecified',
  creditTermsDays:null,creditDueDate:'',paidOn:'2026-09-29',pettyCashFundId:'',links:[]}]);
 assert.match(expenseTemplateCsv('2026-09-29'),/"date","description"/);
 assert.match(exportExpensesCsv([{date:'2026-09-29',description:'=bad',amount:1}],[]),/"'=bad"/);
 const exported=exportExpensesCsv([{date:'2026-09-28T16:30:00.000Z',description:'Legacy expense',amount:2.5}],[]);
 assert.equal(importExpensesCsv(exported,[])[0].date,'2026-09-29');
});

test('expense CSV round-trips credit terms and fixed stock and procurement links',()=>{
 const csv='date,description,amount,status,paid_by_type,credit_terms_days,credit_due_date,stock_item_ids,stock_movement_ids,purchase_order_ids,goods_receipt_ids\n'
  +'2026-09-29,Beans on account,42.05,pending,credit,30,2026-10-29,beans;milk,move-1,po-1,gr-1';
 const [expense]=importExpensesCsv(csv,[]);
 assert.deepEqual(expense,{date:'2026-09-29',description:'Beans on account',category:'General',amount:42.05,
  supplier_id:'',payee:'',status:'pending_payment',paidByType:'credit',paidByUserId:'',paidByName:'',pettyCashFundId:'',creditTermsDays:30,
  creditDueDate:'2026-10-29',paidOn:'',links:[{type:'stock_item',id:'beans'},{type:'stock_item',id:'milk'},
   {type:'stock_movement',id:'move-1'},{type:'purchase_order',id:'po-1'},{type:'goods_receipt',id:'gr-1'}]});
 assert.deepEqual(importExpensesCsv(exportExpensesCsv([expense],[]),[]),[expense]);
});

test('expense CSV rejects ambiguous suppliers, invalid dates and excess decimals',()=>{
 const suppliers=[{id:'a',name:'Same',type:'Supplier'},{id:'b',name:'Same',type:'Supplier'}];
 assert.throws(()=>importExpensesCsv('date,description,amount,supplier_name\n2026-09-29,Beans,1,Same',suppliers),/exactly one/);
 assert.throws(()=>importExpensesCsv('date,description,amount\n2026-02-30,Beans,1.001',[]),/date|decimal/);
 assert.throws(()=>importExpensesCsv('date,description,amount,status,paid_by_type\n2026-09-29,Beans,1,pending,petty_cash',[]),/petty cash fund/i);
 assert.throws(()=>importExpensesCsv('date,description,amount,status,paid_by_type,credit_terms_days,credit_due_date\n2026-09-29,Beans,1,pending,credit,30,2026-10-30',[]),/do not match/);
 assert.throws(()=>importExpensesCsv('date,description,amount,stock_item_ids\n2026-09-29,Beans,1,item-1;item-1',[]),/duplicate expense link/i);
 assert.throws(()=>importExpensesCsv('date,description,amount,paid_by_type,paid_on\n2026-09-29,Beans,1,legacy_unspecified,2026-09-29',[]),/Choose who paid/);
 assert.throws(()=>importExpensesCsv('date,description,amount,paid_on\n2026-09-29,Beans,1,2099-01-01',[]),/future/);
 assert.throws(()=>importExpensesCsv('date,description,amount,status\n2026-09-29,Beans,10,partially_paid',[]),/cannot recreate their payment history.*pending_payment/i);
});

test('expense CSV round-trips petty cash fund references and unpaid drafts',()=>{
 const csv='date,description,amount,status,paid_by_type,petty_cash_fund_id,paid_on\n'
  +'2026-10-17,Counter supplies,12.50,paid,petty_cash,fund-1,2026-10-17\n'
  +'2026-10-17,Claim awaiting review,8.40,draft,unassigned,,';
 const rows=importExpensesCsv(csv,[]);
 assert.equal(rows[0].pettyCashFundId,'fund-1');assert.equal(rows[0].status,'paid');assert.equal(rows[0].paidOn,'2026-10-17');
 assert.equal(rows[1].status,'draft');assert.equal(rows[1].paidByType,'unassigned');assert.equal(rows[1].paidOn,'');
 assert.deepEqual(importExpensesCsv(exportExpensesCsv(rows,[]),[]),rows);
 const [pending]=importExpensesCsv('date,description,amount,status\n2026-10-17,Utility bill,55,pending_payment',[]);
 assert.equal(pending.paidByType,'unassigned');assert.equal(pending.paidOn,'');
});

test('expense lifecycle history attributes each event to its actor',async()=>{
 const filename=new URL('../src/components/dashboard/EditionExpenses.vue',import.meta.url);
 const source=await readFile(filename,'utf8'),parsed=parse(source,{filename:filename.pathname});
 assert.equal(parsed.errors.length,0);
 compileScript(parsed.descriptor,{id:'expense-lifecycle-history'});
 const template=compileTemplate({source:parsed.descriptor.template.content,filename:filename.pathname,
  id:'expense-lifecycle-history',compilerOptions:{bindingMetadata:{}}});
 assert.equal(template.errors.length,0);
 assert.match(source,/by \{\{ actorName\(event\.actorId\) \}\}/);
 assert.match(source,/Store\.permissions\(\)\.operator\)return values\.filter\(user=>user\.id===currentUserId\.value/);
 assert.match(source,/let expenseEventRequest=0/);
 assert.match(source,/const request=\+\+expenseEventRequest/);
 assert.match(source,/request===expenseEventRequest&&form\.value\?\.id===id/);
 assert.match(source,/function closeEditor\(\)\{[\s\S]*invalidateExpenseEvents\(\);form\.value=null;[\s\S]*\}/);
 assert.doesNotMatch(source,/@close="form=null"/);
 assert.match(source,/const paymentLifecycleLocked=computed\(\(\)=>Number\(form\.value\?\.paidAmountSen\|\|0\)>0\)/);
 assert.match(source,/recorded payments are part of the audit trail/);
 assert.match(source,/:disabled="paymentLifecycleLocked\|\|form\.status==='partially_paid'"/);
 assert.match(source,/:disabled="paymentLifecycleLocked"/);
 assert.match(source,/allowRecordedPaymentState:paymentLifecycleLocked\.value/);
});

test('only the recorded-payment validation path accepts settled legacy source states',()=>{
 const base={date:'2026-10-02',status:'paid',paidOn:'2026-10-03',links:[]};
 assert.throws(()=>normalizeExpenseLifecycle({...base,paidByType:'unassigned'}),/Choose who paid/);
 assert.throws(()=>normalizeExpenseLifecycle({...base,paidByType:'credit',creditTermsDays:30,
  creditDueDate:'2026-11-01'}),/Record the credit expense as pending/);
 assert.equal(normalizeExpenseLifecycle({...base,paidByType:'unassigned'},
  {allowRecordedPaymentState:true}).paidByType,'unassigned');
 const credit=normalizeExpenseLifecycle({...base,paidByType:'credit',creditTermsDays:30,
  creditDueDate:'2026-11-01'},{allowRecordedPaymentState:true});
 assert.equal(credit.status,'paid');assert.equal(credit.paidByType,'credit');
 assert.throws(()=>normalizeExpenseLifecycle({...base,status:'partially_paid',paidOn:'',paidByType:'unassigned'}),/Choose who paid/);
 assert.equal(normalizeExpenseLifecycle({...base,status:'partially_paid',paidOn:'',paidByType:'unassigned'},
  {allowRecordedPaymentState:true}).status,'partially_paid');
});

test('expense mutations require live data and failed saves clean only uncommitted receipt uploads',async()=>{
 const [source,finance]=await Promise.all([
  readFile(new URL('../src/components/dashboard/EditionExpenses.vue',import.meta.url),'utf8'),
  readFile(new URL('../src/store/finance.js',import.meta.url),'utf8'),
 ]);
 assert.match(source,/const writeReady=computed\(\(\)=>Store\.state\.online&&!Store\.state\.fromCache\)/);
 assert.match(source,/if\(!writeReady\.value\)\{error\.value='Reconnect and refresh live data before saving this expense\.'/);
 assert.match(source,/if\(!writeReady\.value\|\|!Store\.can\('expensesWrite'\)\)\{error\.value='Reconnect and refresh live data before importing expenses\.'/);
 assert.match(source,/if\(!writeReady\.value\)\{Store\.notify\('Reconnect and refresh live data before voiding an expense\.'/);
 assert.match(source,/let uploaded=null,saved=false/);
 assert.match(finance,/mutationCommitted:true,mutationResult:result/);
 assert.match(source,/if\(disposition==='committed'\)\{[\s\S]*saved=true;[\s\S]*removeFile\(oldPath\)[\s\S]*closeEditor\(\);Store\.notify\('Expense saved, but live data could not be refreshed\./);
 assert.match(source,/disposition==='ambiguous'\)\{[\s\S]*Store\.state\.fromCache=true;Store\.state\.dataError='Expense save outcome requires reconciliation\.'/);
 assert.match(source,/The server outcome is unknown[\s\S]+request identity and uploaded receipt were retained/);
 assert.match(source,/else\{if\(uploaded\?\.path&&!saved\)await removeFile\(uploaded\.path\)\.catch\(\(\)=>\{\}\);error\.value=caught\.message;\}/);
 assert.match(source,/:disabled="busy\|\|!writeReady" type="submit" form="expense-form"/);
 assert.match(source,/v-if="canVoidRecord\(expense\)"/);
});

test('expense save failures preserve evidence for committed or network-ambiguous outcomes',()=>{
 assert.equal(expenseSaveFailureDisposition({mutationCommitted:true}),'committed');
 assert.equal(expenseSaveFailureDisposition({network:true}),'ambiguous');
 assert.equal(expenseSaveFailureDisposition({status:400}),'rejected');
});

test('expense refresh-result failure remains a confirmed committed mutation',()=>{
 const mutationResult={id:'expense-a'};
 const error=expenseCommittedRefreshError({status:'failed',refreshed:false,error:'offline'},mutationResult);
 assert.equal(error.message,'offline');
 assert.equal(error.mutationCommitted,true);
 assert.equal(error.mutationResult,mutationResult);
 assert.equal(error.refreshResult.status,'failed');
 assert.equal(expenseCommittedRefreshError({status:'refreshed'},mutationResult),null);
});

test('expense cash status normalizes legacy vouchers without changing typed lifecycle rows',()=>{
 const pendingVoucher={type:'Payment Voucher',status:'Pending'};
 const paidVoucher={type:'Payment Voucher',status:'Paid'};
 const clearedVoucher={type:'Payment Voucher',status:'Cleared'};
  assert.equal(effectiveExpenseStatus(pendingVoucher),'pending_payment');
 assert.equal(expenseHasCashImpact(pendingVoucher),false);
 assert.equal(effectiveExpenseStatus(paidVoucher),'paid');
 assert.equal(expenseHasCashImpact(paidVoucher),true);
 assert.equal(effectiveExpenseStatus(clearedVoucher),'paid');
 assert.equal(expenseHasCashImpact(clearedVoucher),true);
 assert.equal(effectiveExpenseStatus({status:'pending',creditDueDate:'2026-09-01'},'2026-10-13'),'overdue');
 assert.equal(expenseHasCashImpact({status:'pending'}),false);
 assert.equal(effectiveExpenseStatus({status:'paid'}),'paid');
 assert.equal(expenseHasCashImpact({status:'paid'}),true);
});

test('stock records support counted, weight and packaging barcode quantities',()=>{
 const beans=validateStockItem({name:'Coffee beans',trackingMode:'weight',baseUnit:'g',onHand:2000,reorderLevel:500,packagings:[{label:'1 kg bag',barcode:'BEANS-1KG',quantityInBase:1000}]});
 assert.equal(beans.trackingMode,'weight');assert.equal(findStockCode([beans],'beans-1kg').quantity,1000);
 assert.equal(findStockCode([{...beans,active:false}],'beans-1kg'),null);
 assert.deepEqual(stockMovement({kind:'receive',quantity:1000},beans.onHand),{kind:'receive',inputQuantity:1000,delta:1000,quantityAfter:3000});
 assert.deepEqual(stockMovement({kind:'count',quantity:1875},2000),{kind:'count',inputQuantity:1875,delta:-125,quantityAfter:1875});
 assert.throws(()=>stockMovement({kind:'waste',quantity:2500},2000),/negative/);
 assert.equal(normalizeStockItem({name:'Cup'}).baseUnit,'pcs');
});

test('package conversions and recipes model pumps and millilitres exactly',()=>{
 const syrup=validateStockItem({id:'syrup',internalCode:'STK-000001',name:'Syrup',trackingMode:'count',baseUnit:'pump',onHand:50,reorderLevel:10,
  packagings:[{label:'1 L bottle',barcode:'SYRUP-1L',quantityInBase:50}]});
 const milk=validateStockItem({id:'milk',name:'Milk',trackingMode:'volume',baseUnit:'ml',onHand:1000,reorderLevel:250,
  packagings:[{label:'1 L carton',barcode:'MILK-1L',quantityInBase:1000}]});
 assert.equal(stockConversionText(syrup.packagings[0],syrup.baseUnit),'1 L bottle = 50 pump');
 assert.equal(stockConversionText(milk.packagings[0],milk.baseUnit),'1 L carton = 1,000 ml');
 assert.equal(findStockCode([syrup],'stk-000001').item.id,'syrup');
 assert.deepEqual(recipeAvailability([{stockItemId:'syrup',quantityPerUnit:1},{stockItemId:'milk',quantityPerUnit:250}],[syrup,milk]),
  {units:4,limitingStockItemId:'milk',complete:true});
 assert.throws(()=>validateRecipeStockUnits({components:[{stockItemId:'syrup',quantityPerUnit:.5}]},[syrup]),/whole base units/);
 assert.doesNotThrow(()=>validateRecipeStockUnits({components:[{stockItemId:'milk',quantityPerUnit:250}]},[milk]));
});

test('unit correction preview distinguishes relabeling from exact scale conversion',()=>{
 const item={trackingMode:'volume',baseUnit:'L',onHand:1.25,reorderLevel:.25,
  packagings:[{id:'carton',label:'Carton',barcode:'MILK-1L',quantityInBase:1}]};
 assert.deepEqual(stockUnitCorrectionPreview(item,{strategy:'relabel',conversionFactor:1}),{
  strategy:'relabel',factor:1,onHand:1.25,reorderLevel:.25,
  packagings:[{id:'carton',label:'Carton',barcode:'MILK-1L',quantityInBase:1}],
 });
 assert.deepEqual(stockUnitCorrectionPreview(item,{strategy:'convert',conversionFactor:1000}),{
  strategy:'convert',factor:1000,onHand:1250,reorderLevel:250,
  packagings:[{id:'carton',label:'Carton',barcode:'MILK-1L',quantityInBase:1000}],
 });
 assert.equal(stockUnitCorrectionPreview(item,{strategy:'convert',conversionFactor:0}),null);
});

test('stock duplication keeps conversion settings without cloning balances or codes',()=>{
 const copy=duplicateStockItem({id:'milk',company_id:'company',version:3,internalCode:'STK-000007',name:'Milk',category:'Ingredients',
  trackingMode:'volume',baseUnit:'ml',barcode:'MILK',onHand:1200,reorderLevel:250,preferredSupplierId:'supplier',notes:'Chilled',
  packagings:[{id:'carton',label:'1 L carton',barcode:'955123',quantityInBase:1000}]});
 assert.deepEqual(copy,{name:'Milk copy',category:'Ingredients',trackingMode:'volume',baseUnit:'ml',barcode:'',onHand:0,reorderLevel:250,
  preferredSupplierId:'supplier',active:true,notes:'Chilled',packagings:[{label:'1 L carton',barcode:'',quantityInBase:1000}]});
 assert.throws(()=>validateStockItem({name:'Syrup',trackingMode:'count',baseUnit:'pump',packagings:[{label:'bottle',quantityInBase:50.5}]}),/whole base units/);
 assert.throws(()=>validateStockItem({name:'Other',barcode:'STK-000007'},[{id:'milk',internalCode:'STK-000007',packagings:[]}]),/already assigned/);
});
