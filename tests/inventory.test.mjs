import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCsv,importProductsCsv,exportProductsCsv,templateCsv,validateProduct,validEmail} from '../src/domain/inventoryCsv.js';
import {createSale,cartItem} from '../src/domain/pos.js';
import {receiptMailto,receiptLines,receiptPrintJob} from '../src/domain/receipt.js';
test('template imports simple products and stable variant identities',()=>{
 const products=importProductsCsv(templateCsv());assert.equal(products.length,2);assert.equal(products[1].variants.length,2);assert.equal(products[1].variants[0].sku,'BEV-EXAMPLE-ICED');assert.equal(new Set(products[1].variants.map(v=>v.id)).size,2);
 assert.equal(importProductsCsv(exportProductsCsv(products))[1].variants[1].price,8);
});
test('CSV handles BOM, CRLF, escaped quotes, commas and multiline text',()=>{
 assert.deepEqual(parseCsv('\uFEFFsku,name,price\r\nA,"Tea, ""Iced""\nLarge",9\r\n'),[['sku','name','price'],['A','Tea, "Iced"\nLarge','9']]);
 assert.equal(importProductsCsv('sku,name,price\nA,"Tea, iced",9')[0].name,'Tea, iced');
});
test('CSV rejects malformed files and conflicting SKUs before writing',()=>{
 for(const text of ['sku,name,price\nA,"Tea,9','sku,name,price\nA,Tea,-1','sku,name,price\nA,Tea,NaN','sku,name,price\nA,Tea,3,extra','sku,name,price\nA,Tea,3\nA,Tea,3','sku,name,price,track_stock\nA,Tea,3,yes','sku,name,price,unknown\nA,Tea,3,x'])assert.throws(()=>importProductsCsv(text));
 assert.throws(()=>importProductsCsv('sku,name,price\nabc,Tea,3',[{id:'x',name:'Existing',sku:'ABC'}]),/already belongs/);
 assert.throws(()=>importProductsCsv('sku,name,price,variant_name\nA,Tea,3,Hot\nA,Coffee,4,Iced'),/must match/);
 assert.throws(()=>importProductsCsv('sku,name,price,variant_name\nA,Tea,3,Hot\nA,Tea,4,Hot'),/unique name/);
});
test('services ignore stock, leading-zero barcode is preserved, unsafe image URL rejected',()=>{
 const p=importProductsCsv('sku,name,price,category,stock,barcode\nA,Wrap,3,Service,90,001234')[0];assert.equal(p.stock,0);assert.equal(p.trackStock,false);assert.equal(p.barcode,'001234');
 assert.throws(()=>importProductsCsv('sku,name,price,image_url\nA,Tea,3,javascript:alert(1)'),/https/);
 assert.throws(()=>validateProduct({name:'Tea',sku:'A',price:0,hasVariants:true,variants:[{name:'Hot',sku:'A'}]}),/unique/);
});
test('spreadsheet exports neutralize formula cells',()=>{assert.match(exportProductsCsv([{name:'=HYPERLINK("bad")',sku:'A',price:1,stock:1}]),/"'=HYPERLINK/);});
test('email receipt snapshots and encoded drafts preserve receipt totals',()=>{
 const s=createSale({id:'email-test',company:{id:'store',name:'Test Store'},user:{uid:'cashier',email:'cashier@example.test'},items:[cartItem({id:'tea',name:'Tea & cake',sku:'TEA',price:3.5})],method:'Cash',received:5,customer:{name:'Test Customer',email:' customer@example.test '}});
 assert.equal(s.client_id,'pos-email-test');assert.equal(s.customerEmail,'customer@example.test');assert.equal(s.change,1.5);
 const url=receiptMailto(s,s.customerEmail);assert.ok(url.startsWith('mailto:customer%40example.test?'));assert.ok(decodeURIComponent(url).includes('TOTAL: RM 3.50'));assert.ok(receiptLines(s).includes('Change: RM 1.50'));assert.equal(receiptPrintJob(s,'58').paperWidthMm,58);
 assert.throws(()=>receiptMailto(s,'bad\r\nBcc:someone@example.test'));
 assert.equal(validEmail('bad@'),false);
});

test('printed fractional line amounts agree with the checkout cent rounding contract',async()=>{
 const {totalsFor}=await import('../src/domain/pos.js');
 const {receiptLines}=await import('../src/domain/receipt.js');
 const items=[{desc:'Fractional item',qty:0.333,price:1.005}];
 const sale={items,...totalsFor(items),date:'2026-09-12T00:00:00Z',number:'POS-ROUND',storeSnapshot:{currency:'RM'}};
 assert.equal(sale.total,0.34);assert.ok(receiptLines(sale).some(line=>line.includes('= RM 0.34')));
});
