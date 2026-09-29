import test from 'node:test';
import assert from 'node:assert/strict';
import { presentDocument, presentReceipt, documentTextLines } from '../src/domain/documentPresentation.js';
import { buildDocumentViewModel, templateDefaults, documentDefaults } from '../src/domain/documents.js';
import { createDocumentPdf } from '../src/services/documentPdf.js';
import { receiptLines, receiptMailto, receiptPrintJob } from '../src/domain/receipt.js';
import { totalsFor, checkoutTotalsFor } from '../src/domain/pos.js';
import { resolveDocumentTemplate } from '../src/domain/documentTemplates.js';
const company={name:'Original Shop',registration:'SYNTHETIC-001',address:'12 Test Street',phone:'0000000000',email:'shop@example.test',preferences:{currency:'RM'}};
const customer={name:'Original Customer',registration:'SYNTHETIC-C',address:'44 Test Lane',email:'customer@example.test'};
const template={settings:{...templateDefaults('Invoice'),bankName:'Synthetic Bank',accountName:'Test Account',accountNumber:'TEST-1234',terms:'Original payment terms',footer:'Original footer'}};
const draft=()=>({...documentDefaults('Invoice'),date:'2026-09-13',dueDate:'2026-09-30',items:[{desc:'Consulting',qty:2,price:100,unit:'hours',cost:99}],taxRate:6,discount:10});
const content=pdf=>pdf.internal.pages.slice(1).map(page=>page.join('\n'));

test('percentage discounts become currency amounts using document cent arithmetic, without exposing costs',()=>{
 const view=presentDocument(draft(),company,customer,template);
 assert.equal(view.subtotal,200);assert.equal(view.discountAmount,20);assert.equal(view.tax,10.8);assert.equal(view.total,190.8);assert.equal('cost' in view.items[0],false);
 assert(documentTextLines(view).includes('Discount (10%): -RM 20.00'));
 const fraction=presentDocument({...draft(),items:[{desc:'Fractional item',qty:0.333,price:1.005}],taxRate:0,discount:0},company);
 assert.equal(fraction.items[0].amount,0.34);assert.equal(fraction.total,0.34);
});
test('issued facts and banking remain frozen while current paid status and final cent update',()=>{
 const snapshot=buildDocumentViewModel({...draft(),number:'INV-0001',status:'Issued',documentState:'issued'},company,customer,template);
 const before=structuredClone(snapshot);
 const record={issuedSnapshot:snapshot,status:'Paid',documentState:'issued',paidAmount:190.8,outstandingAmount:0};
 const view=presentDocument(record,{...company,name:'Changed shop'},{...customer,name:'Changed customer'},{settings:{...template.settings,bankName:'Changed bank',terms:'Changed terms'}});
 assert.equal(view.company.name,'Original Shop');assert.equal(view.customer.name,'Original Customer');assert.equal(view.terms,'Original payment terms');assert.equal(view.total,190.8);assert.equal(view.discountAmount,20);assert.equal(view.isDraft,false);assert.equal(view.isPaid,true);assert.equal(view.amountPaid,190.8);assert.equal(view.balance,0);
 assert.match(view.paymentInstructions,/Bank: Synthetic Bank/);assert.match(view.paymentInstructions,/Account number: TEST-1234/);assert.doesNotMatch(documentTextLines(view).join('\n'),/Changed/);assert.deepEqual(snapshot,before);
 const voided=presentDocument({...record,status:'Voided'});assert.equal(voided.isPaid,false);assert.equal(voided.status,'Voided');
});
test('date-only due and validity values survive presentation without timezone conversion',()=>{
 const invoice=presentDocument(draft(),company,customer,template);assert.equal(invoice.date,'2026-09-13');assert.equal(invoice.dueDate,'2026-09-30');
 const quote=presentDocument({...draft(),type:'Quote',dueDate:'',validUntil:'2026-10-01'},company,customer);assert.equal(quote.validUntil,'2026-10-01');assert(documentTextLines(quote).includes('Quote valid until: 2026-10-01'));
});
test('transient invalid drafts show a repair state and cannot generate a misleading PDF',async()=>{
 for(const patch of [{taxRate:101},{discount:-1},{items:[{desc:'Service',qty:0,price:1}]},{items:[{desc:'Service',qty:1,price:-2}]},{items:[{desc:'',qty:1,price:0}]}]){
  const view=presentDocument({...draft(),...patch},company,customer,template);assert.equal(view.invalid,true);assert.match(view.previewError,/Complete each line/);await assert.rejects(createDocumentPdf(view),/Complete the draft/);
 }
 assert.equal(presentDocument({...draft(),taxRate:0},company).invalid,false);assert.doesNotThrow(()=>presentDocument(null,null,null,null));
 assert.throws(()=>presentDocument({...draft(),documentState:'issued',taxRate:101},company));
});
test('receipt channels use saved merchant/template and disclose Malaysian counter rounding',()=>{
 const items=[{desc:'Coffee',qty:2,price:10,unit:'pcs'}];
 const sale={id:'receipt-test',schemaVersion:3,date:'2026-09-12T18:00:00Z',number:'POS-SYNTHETIC',type:'Invoice',status:'Cleared',syncStatus:'pending',items,...checkoutTotalsFor(items,6,10),paymentMethod:'Cash',received:30,change:10.9,cashierName:'Test cashier',storeSnapshot:{...company,currency:'RM',paperWidth:'58',footer:'Saved checkout footer'},companySnapshot:{...company,currency:'RM'},templateSnapshot:{...templateDefaults('Receipt'),bankName:'Saved bank',accountNumber:'TEST-58'}};
 const view=presentReceipt(sale,{name:'Changed company',preferences:{paperWidth:'80'}});assert.equal(view.company.name,'Original Shop');assert.equal(view.settings.paperWidth,'58');assert.equal(view.footer,'Saved checkout footer');assert.equal(view.pending,true);assert.equal(view.isPaid,true);assert.equal(view.totalBeforeRounding,19.08);assert.equal(view.rounding,.02);assert.equal(view.total,19.1);
 assert.deepEqual(receiptLines(sale),documentTextLines(view));assert.deepEqual(receiptPrintJob(sale,'58').lines,receiptLines(sale));assert.match(decodeURIComponent(receiptMailto(sale,'customer@example.test')),/Awaiting server sync/);assert.match(documentTextLines(view).join('\n'),/Saved bank/);assert.ok(documentTextLines(view).includes('Total before rounding: RM 19.08'));assert.ok(documentTextLines(view).includes('Rounding: +RM 0.02'));assert.match(view.displayDate,/13/);
 const legacy={...sale,schemaVersion:2,...totalsFor(items,6,10),change:10.92};delete legacy.totalBeforeRounding;delete legacy.rounding;assert.equal(presentReceipt(legacy).total,19.08);assert.doesNotMatch(receiptLines(legacy).join('\n'),/Rounding/);
});
test('A4 PDF is selectable text with repeated table headers, wrapped long descriptions and numbered pages',async()=>{
 const doc=presentDocument({...draft(),items:Array.from({length:85},(_,index)=>({desc:`Service ${index+1}: `+'Long detailed description with enough content to wrap across the page width. '.repeat(3),qty:1,unit:'hours',price:10})),notes:'Final notes retained after the last item.'},company,customer,template);
 const pdf=await createDocumentPdf(doc);assert(pdf.getNumberOfPages()>2);assert(Math.abs(pdf.internal.pageSize.getWidth()-210)<0.1);assert(Math.abs(pdf.internal.pageSize.getHeight()-297)<0.1);
 const pages=content(pdf);assert(pages.filter(text=>text.includes('(Description)')).length>2);assert(pages.every(text=>text.includes('Original Shop')));assert(pages.join('\n').includes('Final notes retained'));assert(pages.join('\n').includes('DRAFT'));assert(pages.join('\n').includes('Synthetic Bank'));
});
test('thermal PDF uses 58/80 mm paper, stacked item detail and measured short roll length',async()=>{
 const items=[{desc:'Coffee with a deliberately long variant name',qty:12,price:10,unit:'pcs'}];
 const view=presentReceipt({id:'s',schemaVersion:3,number:'POS-THERMAL',type:'Invoice',status:'Paid',date:'2026-09-13T00:00:00Z',items,...checkoutTotalsFor(items),paymentMethod:'Cash',received:120,change:0,storeSnapshot:{name:'Test Shop',currency:'RM',footer:'Thank you'}});
 for(const paperWidth of ['58','80']){const pdf=await createDocumentPdf(view,{paperWidth});assert.equal(pdf.getNumberOfPages(),1);assert(Math.abs(pdf.internal.pageSize.getWidth()-Number(paperWidth))<0.1);assert(pdf.internal.pageSize.getHeight()<297);const text=content(pdf).join('\n');assert(text.includes('12 pcs'));assert(text.includes('120.00'));assert(text.includes('Rounding'));assert(text.includes('Thank you'));}
});

test('multiple published templates resolve by exact company default, not alphabetic order or equal version',()=>{
 const records=[{id:'a-first',name:'Alphabetic first',kind:'Invoice',version:3,publishedVersion:1,published:true,isDefault:false,defaultVersion:null,settings:{...templateDefaults(),labels:{title:'UNPUBLISHED EDIT'}},publishedSettings:{...templateDefaults(),labels:{title:'FIRST PUBLISHED'}}},{id:'z-default',name:'Z company default',kind:'Invoice',version:2,publishedVersion:1,published:true,isDefault:true,defaultVersion:1,settings:{...templateDefaults(),labels:{title:'DRAFT EDIT'}},publishedSettings:{...templateDefaults(),labels:{title:'EXACT DEFAULT'}}}];
 const chosen=resolveDocumentTemplate(records,'Invoice','');assert.equal(chosen.id,'z-default');assert.equal(chosen.version,1);assert.equal(presentDocument(draft(),company,customer,{settings:chosen.settings}).settings.labels.title,'EXACT DEFAULT');
 const explicit=resolveDocumentTemplate(records,'Invoice','a-first');assert.equal(explicit.id,'a-first');assert.equal(explicit.version,1);assert.equal(explicit.settings.labels.title,'FIRST PUBLISHED');
 const switched=resolveDocumentTemplate(records.map(record=>({...record,isDefault:record.id==='a-first',defaultVersion:record.id==='a-first'?1:null})),'Invoice','');assert.equal(switched.id,'a-first');assert.equal(switched.version,chosen.version);assert.notEqual(switched.id,chosen.id);
 assert.equal(resolveDocumentTemplate(records,'Quote','').id,'');assert.equal(resolveDocumentTemplate([], 'Invoice','').version,0);assert.equal(resolveDocumentTemplate(records,'Quote','a-first').unavailable,true);assert.equal(resolveDocumentTemplate(records,'Invoice','missing').unavailable,true);
});
