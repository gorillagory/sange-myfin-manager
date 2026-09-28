import { totalsFor,businessDate } from "./pos.js";
export const DOCUMENT_TYPES=Object.freeze(["Invoice","Quote"]);
export const TEMPLATE_KINDS=Object.freeze(["Invoice","Quote","Receipt"]);
export function templateDefaults(kind="Invoice"){
  return {layout:"clean",primaryColor:"#245c49",fontFamily:"system",labels:{title:kind==="Receipt"?"RECEIPT":kind,billTo:kind==="Receipt"?"Customer":"Bill to",total:kind==="Receipt"?"TOTAL":"Total"},showLogo:true,showPaymentQr:true,showSignature:false,signatureLabel:"Authorized signature",paymentInstructions:"",bankName:"",accountName:"",accountNumber:"",terms:"",footer:"Thank you for your business.",paperWidth:kind==="Receipt"?"80":"A4"};
}
export function documentDefaults(type="Invoice"){
  return {type,status:"Draft",documentState:"draft",client_id:"",date:businessDate(),dueDate:"",validUntil:"",items:[{desc:"",qty:1,unit:"pcs",price:0}],discount:0,taxRate:0,notes:"",paymentInstructions:"",bankName:"",accountName:"",accountNumber:"",terms:"",footer:"",signatureLabel:"",templateId:"",assignedTo:""};
}
const clone=value=>JSON.parse(JSON.stringify(value));
export function buildDocumentViewModel(doc={},company={},client={},template={}){
  const snapshot=doc.issuedSnapshot || doc.issued_snapshot;
  if(snapshot)return {...clone(snapshot),...(doc.status!==undefined?{status:doc.status}:{}),...(doc.documentState!==undefined?{documentState:doc.documentState}:{}),...(doc.paidAmount!==undefined?{paidAmount:doc.paidAmount}:{}),...(doc.outstandingAmount!==undefined?{outstandingAmount:doc.outstandingAmount}:{})};
  const settings={...templateDefaults(doc.type),...(template.settings || template),labels:{...templateDefaults(doc.type).labels,...(template.settings?.labels || template.labels || {})}};
  const companySnapshot=doc.companySnapshot || {name:company.name||"",registration:company.registration||"",address:company.address||"",phone:company.phone||"",email:company.email||"",logo:company.logo||"",qrCode:company.qrCode||company.qrCodeUrl||"",currency:company.preferences?.currency||"RM"};
  const clientSnapshot=doc.clientSnapshot || {name:client.name||doc.customerName||"",registration:client.registration||"",address:client.address||"",phone:client.phone||"",email:client.email||doc.customerEmail||""};
  const templateSnapshot=doc.templateSnapshot || settings;
  const items=(doc.items||[]).map(({desc,qty,unit,price,productId,variantId,sku})=>({desc:desc||"",qty:Number(qty)||0,unit:unit||"pcs",price:Number(price)||0,...(productId?{productId}:{}),...(variantId?{variantId}:{}),...(sku?{sku}:{})}));
  let totals={subtotal:0,discountAmount:0,tax:0,total:0,discount:Number(doc.discount)||0,taxRate:Number(doc.taxRate)||0};
  if(items.length && items.every(item=>item.qty>0))totals=totalsFor(items,doc.taxRate||0,doc.discount||0);
  return {id:doc.id||"",number:doc.number||"DRAFT",type:doc.type||"Invoice",status:doc.status||"Draft",documentState:doc.documentState||"draft",date:doc.date||"",dueDate:doc.dueDate||"",validUntil:doc.validUntil||"",companySnapshot,clientSnapshot,templateSnapshot,company:companySnapshot,customer:clientSnapshot,template:templateSnapshot,items,...totals,notes:doc.notes||"",paymentInstructions:doc.paymentInstructions||settings.paymentInstructions||"",terms:doc.terms||settings.terms||"",footer:doc.footer||settings.footer||"",signatureLabel:doc.signatureLabel||settings.signatureLabel||"",correctionOf:doc.correctionOf||null};
}
export const normalizeDocument=buildDocumentViewModel;
