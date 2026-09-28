import { createHash } from "node:crypto";
import { z } from "zod";
import * as v from "./validation.js";
import { canonical,totalsFor,cents,businessDate } from "../../src/domain/pos.js";
import { stripConfidential } from "../../src/domain/permissions.js";
import { requireCapability,publicTransaction,operator } from "./access.js";
import { managementLock,managementSession } from "./management.js";
export function registerReceiptReviews(app,{db,authorize,checkout,audit}){
 const scope=(req,fn)=>db.transaction(async c=>{await managementLock(c);await managementSession(c,req);const co=v.parse(v.id,req.params.company);await authorize(c,req.identity,co);return fn(c,co,req.identity);});
 const output=(row,who)=>({id:row.id,status:row.status,reasonCode:row.reason_code,sale:publicTransaction(row.payload,who),createdAt:row.created_at,approvedAt:row.approved_at});
 app.post("/api/companies/:company/receipt-reviews",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"checkout");const body=v.parse(z.strictObject({sale:v.sale}),req.body),sale=stripConfidential(body.sale);
  if(sale.company_id!==co||sale.cashierId!==who.id)v.fail(403,"invalid_sale_actor");
  const totals=totalsFor(sale.items,sale.taxRate,sale.discount);
  if(sale.number!==`POS-${sale.id.toUpperCase()}`||sale.businessDate!==businessDate(sale.date)||totals.total<=0||Object.entries(totals).some(([key,value])=>sale[key]!==value)||cents(sale.received)<cents(sale.total)||cents(sale.change)!==cents(sale.received)-cents(sale.total))v.fail(400,"invalid_paid_intent");
  const digest=createHash("sha256").update(JSON.stringify(canonical(sale))).digest("hex");
  const existing=(await c.query("SELECT * FROM myfin.receipt_reviews WHERE company_id=$1 AND id=$2 FOR UPDATE",[co,sale.id])).rows[0];
  if(existing){if(existing.actor_id!==who.id||existing.request_digest!==digest)v.fail(409,"receipt_payload_changed");return {...output(existing,who),status:existing.status==="approved"?"posted":"pending"};}
  await c.query("SAVEPOINT paid_review_probe");let reason;
  try{const receipt=await checkout(c,who,co,sale);await c.query("RELEASE SAVEPOINT paid_review_probe");return {id:sale.id,status:"posted",receipt};}
  catch(error){await c.query("ROLLBACK TO SAVEPOINT paid_review_probe");await c.query("RELEASE SAVEPOINT paid_review_probe");if(!/^receipt_review_required_|^manager_override_reason_required$|^stock_unavailable$/.test(error.message))throw error;reason=error.message;}
  await c.query("INSERT INTO myfin.receipt_reviews(company_id,id,actor_id,payload,request_digest,reason_code) VALUES($1,$2,$3,$4,$5,$6)",[co,sale.id,who.id,sale,digest,reason]);
  await audit(c,who,co,"Request paid receipt review",sale.id);return {id:sale.id,status:"pending",reasonCode:reason};
 }));
 app.get("/api/companies/:company/receipt-reviews",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"checkout");const r=await c.query("SELECT * FROM myfin.receipt_reviews WHERE company_id=$1 AND ($2 OR actor_id=$3) ORDER BY created_at DESC LIMIT 1001",[co,!operator(who),who.id]);if(r.rowCount>1000)v.fail(409,"receipt_review_list_limit");return r.rows.map(row=>output(row,who));
 }));
 app.post("/api/companies/:company/receipt-reviews/:id/approve",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"documentsIssue");const {reason}=v.parse(z.strictObject({reason:z.string().trim().min(3).max(1000)}),req.body),id=v.parse(v.id,req.params.id);
  const r=await c.query("SELECT * FROM myfin.receipt_reviews WHERE company_id=$1 AND id=$2 FOR UPDATE",[co,id]);if(!r.rowCount)v.fail(404,"not_found");const row=r.rows[0];
  const actor=(await c.query("SELECT id,display_name AS username FROM myfin.app_identities WHERE id=$1",[row.actor_id])).rows[0];if(!actor)v.fail(409,"original_cashier_unavailable");
  // Approval is server context; clients cannot pass an approver to ordinary checkout.
  const receipt=await checkout(c,{...actor,role:"operator",company_id:co},co,row.payload,{who,reason});
  if(row.status!=="approved")await c.query("UPDATE myfin.receipt_reviews SET status='approved',approved_by=$3,approval_reason=$4,approved_at=now() WHERE company_id=$1 AND id=$2",[co,id,who.id,reason]);
  return {id,status:"approved",receipt:publicTransaction(receipt,who)};
 }));
}
