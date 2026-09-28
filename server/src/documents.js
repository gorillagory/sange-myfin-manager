import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as v from "./validation.js";
import { totalsFor,cents,businessDate,canonical } from "../../src/domain/pos.js";
import { templateDefaults,buildDocumentViewModel } from "../../src/domain/documents.js";
import { requireCapability,owner,manager,operator,containsConfidential,recordVisible,recordOutput,publicTemplate } from "./access.js";
import { managementLock,managementSession } from "./management.js";
const text=z.string().max(10000),short=z.string().max(120),date=z.union([z.literal(""),z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(x=>Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x)]);
const settings=z.strictObject({layout:z.enum(["clean","modern","corporate"]),primaryColor:z.string().regex(/^#[0-9a-fA-F]{6}$/),fontFamily:z.enum(["system","serif","sans"]),labels:z.strictObject({title:short,billTo:short,total:short}),showLogo:z.boolean(),showPaymentQr:z.boolean(),showSignature:z.boolean(),signatureLabel:short,paymentInstructions:text,bankName:short.default(""),accountName:short.default(""),accountNumber:short.default(""),terms:text,footer:text,paperWidth:z.enum(["A4","58","80"])});
const line=z.strictObject({desc:z.string().min(1).max(500),qty:z.number().positive().max(1e6),unit:short.optional(),price:z.number().min(0).max(1e9),productId:v.id.optional(),variantId:z.string().max(128).optional(),sku:short.optional()});
const draft=z.strictObject({id:v.id.optional(),type:z.enum(["Invoice","Quote"]),client_id:z.string().max(128).default(""),date,dueDate:date.default(""),validUntil:date.default(""),items:z.array(line).min(1).max(500),discount:z.number().min(0).max(100).default(0),taxRate:z.number().min(0).max(100).default(0),notes:text.default(""),paymentInstructions:text.default(""),terms:text.default(""),footer:text.default(""),signatureLabel:short.default(""),templateId:z.string().max(128).default(""),assignedTo:z.string().max(128).default(""),version:z.number().int().positive().optional()});
async function event(c,who,co,id,action,details={}){await c.query("INSERT INTO myfin.document_events(id,company_id,document_id,actor_id,action,details) VALUES($1,$2,$3,$4,$5,$6)",[randomUUID(),co,id,who.id,action,details]);}
export async function publishedTemplate(c,co,kind,templateId="",version=null){
 if(templateId&&version){const exact=await c.query("SELECT * FROM myfin.document_template_versions WHERE template_id=$1 AND version=$2 AND company_id=$3 AND kind=$4",[templateId,version,co,kind]);if(!exact.rowCount)v.fail(409,"published_template_required");return exact.rows[0];}
 const r=templateId?await c.query("SELECT v.* FROM myfin.document_templates t JOIN myfin.document_template_versions v ON v.template_id=t.id AND v.version=t.published_version WHERE t.id=$1 AND t.company_id=$2 AND t.kind=$3",[templateId,co,kind]):await c.query("SELECT v.* FROM myfin.document_template_defaults d JOIN myfin.document_template_versions v ON v.template_id=d.template_id AND v.version=d.version WHERE d.company_id=$1 AND d.kind=$2",[co,kind]);
 if(templateId&&!r.rowCount)v.fail(409,"published_template_required");
 return r.rows[0]||{template_id:null,version:0,settings:templateDefaults(kind)};
}
export function registerDocuments(app,{db,authorize,audit}){
 const scope=(req,fn)=>db.transaction(async c=>{
  await managementLock(c);await managementSession(c,req);
  const co=v.parse(v.id,req.params.company);await authorize(c,req.identity,co);
  return fn(c,co,req.identity);
 });
 const get=async(c,co,id,who)=>{
  const r=await c.query("SELECT t.*,(SELECT coalesce(sum(amount),0) FROM myfin.document_payments p WHERE p.company_id=t.company_id AND p.document_id=t.id) AS paid_amount,(SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'amount',p.amount,'method',p.method,'reference',p.reference,'date',p.paid_at)),'[]') FROM myfin.document_payments p WHERE p.company_id=t.company_id AND p.document_id=t.id) AS payments FROM myfin.transactions t WHERE company_id=$1 AND id=$2 FOR UPDATE",[co,v.parse(v.id,id)]);
  if(!r.rowCount||!recordVisible(r.rows[0],who))v.fail(404,"not_found");return r.rows[0];
 };
 const output=async(c,co,id,who)=>recordOutput(await get(c,co,id,who),who);
 app.get("/api/companies/:company/documents",req=>scope(req,async(c,co,who)=>{
  const r=await c.query("SELECT t.*,(SELECT coalesce(sum(amount),0) FROM myfin.document_payments p WHERE p.company_id=t.company_id AND p.document_id=t.id) AS paid_amount FROM myfin.transactions t WHERE company_id=$1 AND source<>'pos' AND ($2 OR (document_state<>'legacy' AND data->>'type' IN ('Invoice','Quote') AND ($3 OR (document_state='draft' AND (actor_id=$4 OR assigned_to=$4))))) ORDER BY id LIMIT 10001",[co,owner(who),manager(who),who.id]);
  if(r.rowCount>10000)v.fail(409,"document_list_limit");return r.rows.filter(row=>row.source!=="pos"&&recordVisible(row,who)).map(row=>recordOutput(row,who));
 }));
 app.get("/api/companies/:company/documents/:id",req=>scope(req,async(c,co,who)=>output(c,co,req.params.id,who)));
 async function save(req,update){return scope(req,async(c,co,who)=>{
  requireCapability(who,"documentsDraft");if(containsConfidential(req.body))v.fail(403,"financial_fields_restricted");
  const data=v.parse(draft,req.body),id=update?v.parse(v.id,req.params.id):data.id||randomUUID();
  const old=update?await get(c,co,id,who):null;
  if(old&&(old.document_state!=="draft"||old.source==="pos"))v.fail(409,"issued_document_immutable");
  if(old&&(data.version!==old.document_version||data.type!==old.data.type))v.fail(409,"document_changed");
  if(operator(who)&&data.assignedTo!==(old?.assigned_to||""))v.fail(403,"assignment_restricted");
  if(data.assignedTo){const r=await c.query("SELECT i.id FROM myfin.app_identities i JOIN myfin.memberships m ON m.identity_id=i.id WHERE i.id=$1 AND m.company_id=$2 AND i.disabled_at IS NULL",[data.assignedTo,co]);if(!r.rowCount)v.fail(400,"invalid_assignee");}
  if(data.client_id){const r=await c.query("SELECT data FROM myfin.clients WHERE company_id=$1 AND id=$2",[co,data.client_id]);if(!r.rowCount||(!owner(who)&&r.rows[0].data.type==="Supplier"))v.fail(404,"customer_not_found");}
  if(data.templateId)await publishedTemplate(c,co,data.type,data.templateId);
  if(!data.date||(data.dueDate&&data.dueDate<data.date)||(data.validUntil&&data.validUntil<data.date))v.fail(400,"invalid_document_dates");
  const totals=totalsFor(data.items,data.taxRate,data.discount);if(totals.total>1e9)v.fail(400,"amount_too_large");
  const clean={...data,...totals,id,company_id:co,number:"DRAFT",status:"Draft",source:"manual"};delete clean.version;delete clean.assignedTo;
  if(old?.quote_id)clean.quoteId=old.quote_id;if(old?.correction_of)clean.correctionOf=old.correction_of;
  if(!update){const existing=(await c.query("SELECT * FROM myfin.transactions WHERE company_id=$1 AND id=$2 FOR UPDATE",[co,id])).rows[0];if(existing){if(existing.actor_id!==who.id||existing.document_state!=="draft"||existing.assigned_to!==(data.assignedTo||null)||JSON.stringify(canonical(existing.data))!==JSON.stringify(canonical(clean)))v.fail(409,"document_payload_changed");return output(c,co,id,who);}}
  if(update)await c.query("UPDATE myfin.transactions SET data=$3,total=$4,assigned_to=$5,document_version=document_version+1 WHERE company_id=$1 AND id=$2",[co,id,clean,totals.total,data.assignedTo||null]);
  else await c.query("INSERT INTO myfin.transactions(company_id,id,actor_id,source,total,data,document_state,assigned_to) VALUES($1,$2,$3,'manual',$4,$5,'draft',$6)",[co,id,who.id,totals.total,clean,data.assignedTo||null]);
  await event(c,who,co,id,update?"update_draft":"create_draft");return output(c,co,id,who);
 });}
 app.post("/api/companies/:company/documents",req=>save(req,false));
 app.put("/api/companies/:company/documents/:id",req=>save(req,true));
 app.delete("/api/companies/:company/documents/:id",req=>scope(req,async(c,co,who)=>{
  const row=await get(c,co,req.params.id,who);if(row.document_state!=="draft")v.fail(409,"issued_document_immutable");
  // Retain drafts as cancelled history instead of deleting their audit lineage.
  await c.query("UPDATE myfin.transactions SET document_state='voided' WHERE company_id=$1 AND id=$2",[co,row.id]);await event(c,who,co,row.id,"cancel_draft");return {ok:true};
 }));
 app.post("/api/companies/:company/documents/:id/issue",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"documentsIssue");const options=v.parse(z.strictObject({reason:text.optional(),version:z.number().int().positive().optional(),expectedTemplateId:z.union([z.literal(""),v.id]).optional(),expectedTemplateVersion:z.number().int().nonnegative().optional()}),req.body||{});
  const row=await get(c,co,req.params.id,who);if(row.document_state==="issued")return recordOutput(row,who);if(row.document_state!=="draft")v.fail(409,"draft_required");
  if(options.version!==undefined&&options.version!==row.document_version)v.fail(409,"document_changed");
  const company=(await c.query("SELECT * FROM myfin.companies WHERE id=$1",[co])).rows[0];
  if(manager(who)&&row.data.discount>Number(company.data.preferences?.staffDiscountLimit||0)&&(!options.reason||options.reason.trim().length<3))v.fail(409,"manager_override_reason_required");
  const client=row.data.client_id?(await c.query("SELECT data FROM myfin.clients WHERE company_id=$1 AND id=$2",[co,row.data.client_id])).rows[0]?.data:{};
  if(row.data.client_id&&!client)v.fail(409,"customer_not_found");if(!owner(who)&&client?.type==="Supplier")v.fail(403,"supplier_restricted");
  const template=await publishedTemplate(c,co,row.data.type,row.data.templateId);
  if((options.expectedTemplateId!==undefined&&options.expectedTemplateId!==(template.template_id||""))||(options.expectedTemplateVersion!==undefined&&options.expectedTemplateVersion!==template.version))v.fail(409,"template_changed");
  const year=Number(businessDate().slice(0,4));const n=(await c.query("INSERT INTO myfin.document_number_sequences(company_id,kind,year,value) VALUES($1,$2,$3,1) ON CONFLICT(company_id,kind,year) DO UPDATE SET value=myfin.document_number_sequences.value+1 RETURNING value",[co,row.data.type,year])).rows[0].value;
  const number=`${row.data.type==="Invoice"?"INV":"QUO"}-${year}-${String(n).padStart(6,"0")}`;
  const data={...row.data,number,status:row.data.type==="Quote"?"Issued":"Pending",documentState:"issued",correctionOf:row.correction_of};
  const snapshot=buildDocumentViewModel(data,{...company.data,id:company.id,name:company.name},client,{settings:template.settings});
  snapshot.templateVersion=template.version;snapshot.templateId=template.template_id;
  await c.query("UPDATE myfin.transactions SET data=$3,document_state='issued',issued_snapshot=$4,issued_at=now() WHERE company_id=$1 AND id=$2",[co,row.id,data,snapshot]);
  if(row.correction_of){const original=await get(c,co,row.correction_of,who);if(original.document_state!=="issued"||Number(original.paid_amount)>0||original.converted_to)v.fail(409,"correction_target_changed");await c.query("UPDATE myfin.transactions SET document_state='corrected' WHERE company_id=$1 AND id=$2",[co,original.id]);}
  await event(c,who,co,row.id,"issue_document",{number,templateId:template.template_id,templateVersion:template.version,...(options.reason?{reason:options.reason.trim()}:{})});await audit(c,who,co,"Issue document",number);return output(c,co,row.id,who);
 }));
 app.post("/api/companies/:company/documents/:id/convert",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"documentsConvert");const row=await get(c,co,req.params.id,who);
  if(row.converted_to)return {id:row.converted_to};if(row.document_state!=="issued"||row.data.type!=="Quote")v.fail(409,"issued_quote_required");
  if(row.data.validUntil&&row.data.validUntil<businessDate())v.fail(409,"quote_expired");
  const id=randomUUID(),data={...row.data,id,type:"Invoice",status:"Draft",number:"DRAFT",documentState:"draft",quoteId:row.id,templateId:"",validUntil:"",date:businessDate()};
  await c.query("INSERT INTO myfin.transactions(company_id,id,actor_id,source,total,data,document_state,quote_id) VALUES($1,$2,$3,'manual',$4,$5,'draft',$6)",[co,id,who.id,row.total,data,row.id]);
  await c.query("UPDATE myfin.transactions SET converted_to=$3 WHERE company_id=$1 AND id=$2",[co,row.id,id]);await event(c,who,co,row.id,"convert_quote",{invoiceId:id});return {id};
 }));
 app.post("/api/companies/:company/documents/:id/payments",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"documentsPayment");const data=v.parse(z.strictObject({id:v.id,amount:z.number().positive().max(1e9),method:short.min(1),reference:z.string().max(500).optional(),date:date.optional()}),req.body);
  const row=await get(c,co,req.params.id,who);if(row.document_state!=="issued"||row.data.type!=="Invoice")v.fail(409,"issued_invoice_required");
  const amount=cents(data.amount)/100;if(amount<=0||amount!==data.amount)v.fail(400,"invalid_payment_amount");const id=data.id||randomUUID();
  const old=await c.query("SELECT * FROM myfin.document_payments WHERE id=$1",[id]);if(old.rowCount){if(old.rows[0].company_id!==co||old.rows[0].document_id!==row.id||Number(old.rows[0].amount)!==amount||old.rows[0].method!==data.method||old.rows[0].reference!==(data.reference||"")||(data.date&&businessDate(old.rows[0].paid_at)!==data.date))v.fail(409,"payment_payload_changed");return output(c,co,row.id,who);}
  if(cents(amount)>cents(row.total)-cents(row.paid_amount))v.fail(409,"payment_exceeds_outstanding");
  await c.query("INSERT INTO myfin.document_payments(id,company_id,document_id,actor_id,amount,method,reference,paid_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,co,row.id,who.id,amount,data.method,data.reference||"",data.date||new Date().toISOString()]);await event(c,who,co,row.id,"record_payment",{paymentId:id,amount,method:data.method});return output(c,co,row.id,who);
 }));
 app.post("/api/companies/:company/documents/:id/void",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"documentsCorrect");const {reason}=v.parse(z.strictObject({reason:z.string().trim().min(3).max(1000)}),req.body);const row=await get(c,co,req.params.id,who);
  if(row.document_state!=="issued"||Number(row.paid_amount)>0||row.converted_to)v.fail(409,"only_unpaid_unconverted_document_can_be_voided");
  await c.query("UPDATE myfin.transactions SET document_state='voided' WHERE company_id=$1 AND id=$2",[co,row.id]);await event(c,who,co,row.id,"void_document",{reason});return output(c,co,row.id,who);
 }));
 app.post("/api/companies/:company/documents/:id/corrections",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"documentsCorrect");const {reason}=v.parse(z.strictObject({reason:z.string().trim().min(3).max(1000)}),req.body);const row=await get(c,co,req.params.id,who);
  if(row.document_state!=="issued"||Number(row.paid_amount)>0||row.converted_to)v.fail(409,"paid_or_converted_document_requires_separate_credit_workflow");
  const existing=await c.query("SELECT id FROM myfin.transactions WHERE company_id=$1 AND correction_of=$2 AND document_state='draft'",[co,row.id]);if(existing.rowCount)return output(c,co,existing.rows[0].id,who);
  const id=randomUUID(),data={...row.data,id,status:"Draft",number:"DRAFT",documentState:"draft",correctionOf:row.id};
  await c.query("INSERT INTO myfin.transactions(company_id,id,actor_id,source,total,data,document_state,correction_of) VALUES($1,$2,$3,'manual',$4,$5,'draft',$6)",[co,id,who.id,row.total,data,row.id]);await event(c,who,co,id,"create_correction",{originalId:row.id,reason});return output(c,co,id,who);
 }));
 app.get("/api/companies/:company/templates",req=>scope(req,async(c,co,who)=>{
  const r=await c.query("SELECT t.*,v.settings AS published_settings,d.version AS default_version FROM myfin.document_templates t LEFT JOIN myfin.document_template_versions v ON v.template_id=t.id AND v.version=t.published_version LEFT JOIN myfin.document_template_defaults d ON d.company_id=t.company_id AND d.kind=t.kind AND d.template_id=t.id WHERE t.company_id=$1 ORDER BY t.kind,t.name",[co]);
  return r.rows.filter(row=>!operator(who)||row.published_version).map(row=>({id:row.id,name:row.name,kind:row.kind,settings:publicTemplate(operator(who)?row.published_settings:row.settings),version:operator(who)?row.published_version:row.version,published:!!row.published_version,publishedVersion:row.published_version,isDefault:row.default_version!=null&&row.default_version===row.published_version,defaultVersion:row.default_version??null,publishedSettings:row.published_settings?publicTemplate(row.published_settings):null}));
 }));
 app.post("/api/companies/:company/templates",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"templatesWrite");const data=v.parse(z.strictObject({name:short.min(1),kind:z.enum(["Invoice","Quote","Receipt"]),settings}),req.body),id=randomUUID();
  await c.query("INSERT INTO myfin.document_templates(id,company_id,kind,name,settings,actor_id) VALUES($1,$2,$3,$4,$5,$6)",[id,co,data.kind,data.name,data.settings,who.id]);await audit(c,who,co,"Create template",id);return {id,...data,version:1,published:false};
 }));
 app.put("/api/companies/:company/templates/:id",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"templatesWrite");const data=v.parse(z.strictObject({name:short.min(1),settings,version:z.number().int().positive()}),req.body),id=v.parse(v.id,req.params.id);
  const r=await c.query("UPDATE myfin.document_templates SET name=$3,settings=$4,version=version+1 WHERE id=$1 AND company_id=$2 AND version=$5 RETURNING version,kind,published_version",[id,co,data.name,data.settings,data.version]);if(!r.rowCount)v.fail(409,"template_changed");await audit(c,who,co,"Update template",id);return {id,...data,version:r.rows[0].version,kind:r.rows[0].kind,published:!!r.rows[0].published_version};
 }));
 app.post("/api/companies/:company/templates/:id/publish",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"templatesWrite");const data=v.parse(z.strictObject({version:z.number().int().positive()}),req.body),id=v.parse(v.id,req.params.id);
  const r=await c.query("SELECT * FROM myfin.document_templates WHERE id=$1 AND company_id=$2 FOR UPDATE",[id,co]);if(!r.rowCount||r.rows[0].version!==data.version)v.fail(409,"template_changed");const row=r.rows[0];
  await c.query("INSERT INTO myfin.document_template_versions(template_id,version,company_id,kind,name,settings,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(template_id,version) DO NOTHING",[id,row.version,co,row.kind,row.name,row.settings,who.id]);
  await c.query("UPDATE myfin.document_templates SET published_version=version WHERE id=$1",[id]);await c.query("INSERT INTO myfin.document_template_defaults(company_id,kind,template_id,version) VALUES($1,$2,$3,$4) ON CONFLICT(company_id,kind) DO UPDATE SET template_id=EXCLUDED.template_id,version=EXCLUDED.version",[co,row.kind,id,row.version]);await audit(c,who,co,"Publish template",id);return {id,version:row.version,published:true};
 }));
}
