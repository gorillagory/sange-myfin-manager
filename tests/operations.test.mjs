import test from 'node:test';
import assert from 'node:assert/strict';
import {expenseTemplateCsv,exportExpensesCsv,importExpensesCsv} from '../src/domain/expensesCsv.js';
import {duplicateStockItem,findStockCode,normalizeStockItem,stockConversionText,stockMovement,validateStockItem} from '../src/domain/stock.js';
import {recipeAvailability,validateRecipeStockUnits} from '../src/domain/inventoryRecipes.js';

test('expense CSV template imports cents and links an exact supplier',()=>{
 const suppliers=[{id:'supplier-a',name:'Roaster & Co',type:'Supplier'}];
 const csv='date,description,category,amount,supplier_id,supplier_name,payee\n2026-09-29,Beans,Inventory,19.90,,Roaster & Co,';
 assert.deepEqual(importExpensesCsv(csv,suppliers),[{date:'2026-09-29',description:'Beans',category:'Inventory',amount:19.9,supplier_id:'supplier-a',payee:'Roaster & Co'}]);
 assert.match(expenseTemplateCsv('2026-09-29'),/"date","description"/);
 assert.match(exportExpensesCsv([{date:'2026-09-29',description:'=bad',amount:1}],[]),/"'=bad"/);
 const exported=exportExpensesCsv([{date:'2026-09-28T16:30:00.000Z',description:'Legacy expense',amount:2.5}],[]);
 assert.equal(importExpensesCsv(exported,[])[0].date,'2026-09-29');
});

test('expense CSV rejects ambiguous suppliers, invalid dates and excess decimals',()=>{
 const suppliers=[{id:'a',name:'Same',type:'Supplier'},{id:'b',name:'Same',type:'Supplier'}];
 assert.throws(()=>importExpensesCsv('date,description,amount,supplier_name\n2026-09-29,Beans,1,Same',suppliers),/exactly one/);
 assert.throws(()=>importExpensesCsv('date,description,amount\n2026-02-30,Beans,1.001',[]),/date|decimal/);
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

test('stock duplication keeps conversion settings without cloning balances or codes',()=>{
 const copy=duplicateStockItem({id:'milk',company_id:'company',version:3,internalCode:'STK-000007',name:'Milk',category:'Ingredients',
  trackingMode:'volume',baseUnit:'ml',barcode:'MILK',onHand:1200,reorderLevel:250,preferredSupplierId:'supplier',notes:'Chilled',
  packagings:[{id:'carton',label:'1 L carton',barcode:'955123',quantityInBase:1000}]});
 assert.deepEqual(copy,{name:'Milk copy',category:'Ingredients',trackingMode:'volume',baseUnit:'ml',barcode:'',onHand:0,reorderLevel:250,
  preferredSupplierId:'supplier',active:true,notes:'Chilled',packagings:[{label:'1 L carton',barcode:'',quantityInBase:1000}]});
 assert.throws(()=>validateStockItem({name:'Syrup',trackingMode:'count',baseUnit:'pump',packagings:[{label:'bottle',quantityInBase:50.5}]}),/whole base units/);
 assert.throws(()=>validateStockItem({name:'Other',barcode:'STK-000007'},[{id:'milk',internalCode:'STK-000007',packagings:[]}]),/already assigned/);
});
