import { buildDocumentViewModel, templateDefaults } from './documents.js';
import { lineTotal, isPaid, money } from './pos.js';
export function presentDocument(document = {}, company = {}, customer = {}, template = {}) {
  document=document||{};company=company||{};customer=customer||{};template=template||{};
  if(Object.hasOwn(template,'settings')&&!template.settings)template={};
  const draft=document.documentState==='draft'&&!document.issuedSnapshot&&!document.issued_snapshot;
  const invalidInput=draft&&(!(document.items||[]).length||(document.items||[]).some(item=>!String(item.desc||'').trim()||!Number.isFinite(Number(item.qty))||Number(item.qty)<=0||!Number.isFinite(Number(item.price))||Number(item.price)<0)||[document.taxRate??0,document.discount??0].some(value=>!Number.isFinite(Number(value))||Number(value)<0||Number(value)>100));
  let raw,invalid=false;
  try{
    if(invalidInput)throw new Error('incomplete_draft');
    raw=buildDocumentViewModel(document,company,customer,template);
  }catch(failure){
    if(!draft)throw failure;
    invalid=true;
    raw=buildDocumentViewModel({...document,items:[],taxRate:0,discount:0},company,customer,template);
  }
  const settings={...templateDefaults(raw.type),...(raw.templateSnapshot||raw.template||{}),labels:{...templateDefaults(raw.type).labels,...(raw.templateSnapshot?.labels||raw.template?.labels||{})}};
  const kind=raw.type||document.type||'Invoice', paidAmount=Number(raw.paidAmount??document.paidAmount??0);
  settings.signatureLabel=raw.signatureLabel||settings.signatureLabel;
  const paymentInstructions=[settings.bankName&&'Bank: '+settings.bankName,settings.accountName&&'Account name: '+settings.accountName,settings.accountNumber&&'Account number: '+settings.accountNumber,raw.paymentInstructions].filter(Boolean).join('\n');
  return {...raw,invalid,previewError:invalid?'Complete each line with a description, a positive quantity and a valid price. Tax and discount must be between 0 and 100.':'',kind,format:kind==='Receipt'?'receipt':'a4',settings,
    company:raw.companySnapshot||raw.company||{},customer:raw.clientSnapshot||raw.customer||{},
    currency:(raw.companySnapshot||raw.company)?.currency||company.preferences?.currency||'RM',
    paymentInstructions,status:raw.status||document.status,isDraft:!document.issuedSnapshot&&!document.issued_snapshot&&(document.documentState||raw.documentState)==='draft',
    isPaid:isPaid(raw)||isPaid(document)||(kind==='Receipt'&&['Paid','Cleared'].includes(raw.status||document.status)),amountPaid:paidAmount,balance:raw.outstandingAmount??document.outstandingAmount??Math.max(0,Number(raw.total||0)-paidAmount),
    items:(raw.items||[]).map(item=>({...item,amount:lineTotal(item)})),project:raw.project||document.project||'',
  };
}
export function presentReceipt(sale, company = {}, customer = {}) {
  company=company||{};customer=customer||{};
  const saved=sale.companySnapshot||sale.storeSnapshot;
  const merchant=saved||{...company,currency:company.preferences?.currency||'RM',footer:company.preferences?.receiptFooter};
  const settings={...templateDefaults('Receipt'),...(sale.templateSnapshot||merchant.templateSnapshot||{}),paperWidth:sale.storeSnapshot?.paperWidth||sale.templateSnapshot?.paperWidth||company.preferences?.paperWidth||'80'};
  const raw={...sale,type:'Receipt',documentState:'issued',companySnapshot:{...merchant,qrCode:merchant.qrCode||merchant.qrCodeUrl||''},clientSnapshot:sale.clientSnapshot||{name:sale.customerName||customer.name||'Walk-in customer',email:sale.customerEmail||customer.email||'',phone:customer.phone||'',address:customer.address||''},templateSnapshot:settings,footer:sale.storeSnapshot?.footer||sale.footer||settings.footer};
  const view=presentDocument(raw,{},raw.clientSnapshot,{settings});
  const hasRounding=sale.totalBeforeRounding!==undefined&&sale.rounding!==undefined;
  return {...view,isDraft:false,pending:sale.syncStatus==='pending'||sale.pending===true,displayDate:new Date(sale.date).toLocaleString('en-MY',{timeZone:'Asia/Kuala_Lumpur'}),cashierName:sale.cashierName||sale.history?.[0]?.user||'—',paymentMethod:sale.paymentMethod||'Recorded payment',received:sale.received,change:sale.change,
    subtotal:sale.subtotal??view.subtotal,discountAmount:sale.discountAmount??view.discountAmount,tax:sale.tax??view.tax,...(hasRounding?{totalBeforeRounding:sale.totalBeforeRounding,rounding:sale.rounding}:{}),total:sale.total??view.total};
}
export function documentTextLines(doc) {
  const amount=value=>money(value||0,doc.currency||'RM'),signedAmount=value=>{const number=Number(value)||0;return `${number>0?'+':number<0?'-':''}${amount(Math.abs(number))}`;}, settings=doc.settings;
  return [
    doc.pending?'Payment recorded on this device · Awaiting server sync':null,
    doc.isDraft?'DRAFT · Not issued':null,
    doc.company.name,doc.company.registration&&'Registration: '+doc.company.registration,doc.company.address,doc.company.phone,doc.company.email,'',
    settings.labels.title,doc.number||'Assigned when issued',doc.isPaid?'PAID':doc.status,doc.displayDate||doc.date,doc.dueDate&&'Payment due: '+doc.dueDate,doc.validUntil&&'Quote valid until: '+doc.validUntil,doc.project&&'Project: '+doc.project,doc.cashierName&&'Cashier: '+doc.cashierName,'',
    settings.labels.billTo+': '+(doc.customer.name||'Walk-in customer'),doc.customer.registration,doc.customer.address,doc.customer.email,doc.customer.phone,'',
    ...doc.items.flatMap(item=>[item.desc, `${item.qty} ${item.unit||''} × ${amount(item.price)} = ${amount(item.amount)}`]),'',
    'Subtotal: '+amount(doc.subtotal),doc.discountAmount?`Discount (${doc.discount}%): -${amount(doc.discountAmount)}`:null,doc.tax||doc.taxRate?`Tax (${doc.taxRate}%): ${amount(doc.tax)}`:null,doc.totalBeforeRounding!=null?'Total before rounding: '+amount(doc.totalBeforeRounding):null,doc.rounding!=null?'Rounding: '+signedAmount(doc.rounding):null,settings.labels.total+': '+amount(doc.total),
    doc.paymentMethod&&'Payment: '+doc.paymentMethod,doc.received!=null?'Received: '+amount(doc.received):null,doc.change!=null?'Change: '+amount(doc.change):null,
    doc.format!=='receipt'&&doc.amountPaid?'Payments recorded: '+amount(doc.amountPaid):null,doc.format!=='receipt'&&doc.kind==='Invoice'&&!doc.isDraft?'Balance due: '+amount(doc.balance):null,'',
    doc.paymentInstructions&&'Payment instructions:\n'+doc.paymentInstructions,doc.notes&&'Notes:\n'+doc.notes,doc.terms&&'Terms:\n'+doc.terms,settings.showSignature&&settings.signatureLabel,doc.footer,
  ].filter(value=>value!==null&&value!==undefined&&value!==false&&value!=='');
}
