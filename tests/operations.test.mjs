import test from 'node:test';
import assert from 'node:assert/strict';
import {expenseTemplateCsv,exportExpensesCsv,importExpensesCsv} from '../src/domain/expensesCsv.js';
import {findStockCode,normalizeStockItem,stockMovement,validateStockItem} from '../src/domain/stock.js';

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
