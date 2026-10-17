import { createHash } from "node:crypto";
import { z } from "zod";
import * as v from "./validation.js";
import { canonical,saleTotalsFor,cents,businessDate } from "../../src/domain/pos.js";
import { stripConfidential } from "../../src/domain/permissions.js";
import { requireCapability,publicTransaction,operator } from "./access.js";
import { managementLock,managementSession } from "./management.js";
const reviewableConstraintCodes=new Set(["23503","23505","23514"]);
const conflictReviewReason="receipt_review_required_record_conflict";
const bulkApprovalReasons=new Set(["receipt_review_required_offline_sync","receipt_review_required_delayed_sync"]);
function automaticReviewReason(error){
 const message=typeof error?.message==="string"?error.message:"";
 if(/^receipt_review_required_|^manager_override_reason_required$|^stock_(?:reserved_or_)?unavailable$/.test(message))return message;
 if(reviewableConstraintCodes.has(error?.code))return conflictReviewReason;
 return "";
}
function bulkReplayReason(error){
 return automaticReviewReason(error)||
  (error?.message==="original_cashier_unavailable"?error.message:"");
}
export function registerReceiptReviews(app,{db,authorize,checkout,audit}){
 const scope=(req,fn)=>db.transaction(async c=>{await managementLock(c);await managementSession(c,req);const co=v.parse(v.id,req.params.company);await authorize(c,req.identity,co);return fn(c,co,req.identity);});
 const lockSale=(c,co,id)=>c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7))",[co+":sale:"+id]);
 const output=(row,who)=>({id:row.id,status:row.status,reasonCode:row.reason_code,
  inventoryRecipeResolution:row.inventory_recipe_resolution||null,sale:publicTransaction(row.payload,who),
  createdAt:row.created_at,approvedAt:row.approved_at,dismissedAt:row.dismissed_at,dismissalReason:row.dismissal_reason});
 const approvalInput=z.strictObject({
  reason:z.string().trim().min(3).max(1000),inventoryRecipeResolution:z.enum(["current_recipe","captured_recipe"]).optional(),
 });
 const approveLocked=async(c,co,who,row,{reason,inventoryRecipeResolution},{revalidatePolicy=false,allowInventoryShortage=false}={})=>{
  if(row.status==="dismissed")v.fail(409,"receipt_dismissed");
  const recipeTiming=row.reason_code==="receipt_review_required_recipe_timing",storedResolution=row.inventory_recipe_resolution||null,
   historicalCapture=row.payload?.offline===true||row.reason_code==="receipt_review_required_delayed_sync";
  if((inventoryRecipeResolution||storedResolution)&&!historicalCapture)v.fail(400,"inventory_recipe_resolution_not_applicable");
  if(recipeTiming&&!inventoryRecipeResolution)v.fail(400,"inventory_recipe_resolution_required");
  if(storedResolution&&inventoryRecipeResolution&&storedResolution!==inventoryRecipeResolution)v.fail(409,"inventory_recipe_resolution_changed");
  // A different review cause can remain pending long enough for its captured
  // recipe to diverge from the current recipe. In that case checkout discovers
  // the timing ambiguity and the manager retries with an explicit choice. Keep
  // the original reason as evidence while forwarding that later resolution.
  const resolution=inventoryRecipeResolution||storedResolution||null;
  const actor=(await c.query("SELECT id,display_name AS username FROM myfin.app_identities WHERE id=$1",[row.actor_id])).rows[0];if(!actor)v.fail(409,"original_cashier_unavailable");
  // Approval is server context; clients cannot pass an approver to ordinary checkout.
  const approval={who,reason,...(resolution?{inventoryRecipeResolution:resolution}:{}),
    ...(row.payload?.pricingSnapshotId?{pricingExpiryResolution:'honor_paid_tender'}:{}),
    ...(allowInventoryShortage?{inventoryShortageResolution:'record_shortage'}:{}),
    ...(revalidatePolicy?{revalidatePolicy:true}:{})};
  const receipt=await checkout(c,{...actor,role:"operator",company_id:co},co,row.payload,approval);
  if(row.status!=="approved")await c.query("UPDATE myfin.receipt_reviews SET status='approved',approved_by=$3,approval_reason=$4,inventory_recipe_resolution=$5,approved_at=now() WHERE company_id=$1 AND id=$2",[co,row.id,who.id,reason,resolution]);
  return {id:row.id,status:"approved",inventoryRecipeResolution:resolution,receipt:publicTransaction(receipt,who)};
 };
 const paidIntent=(input,co,who)=>{
  const sale=stripConfidential(v.parse(v.sale,input));
  if(sale.company_id!==co||sale.cashierId!==who.id)v.fail(403,"invalid_sale_actor");
  let totals;try{totals=saleTotalsFor(sale);}catch{v.fail(400,"invalid_sale_rounding");}
  if(sale.number!==`POS-${sale.id.toUpperCase()}`||sale.businessDate!==businessDate(sale.date)||totals.total<=0||Object.entries(totals).some(([key,value])=>sale[key]!==value)||cents(sale.received)<cents(sale.total)||cents(sale.change)!==cents(sale.received)-cents(sale.total))v.fail(400,"invalid_paid_intent");
  return {sale,digest:createHash("sha256").update(JSON.stringify(canonical(sale))).digest("hex")};
 };
 app.post("/api/companies/:company/receipt-reviews",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"checkout");const body=v.parse(z.strictObject({sale:v.sale}),req.body),{sale,digest}=paidIntent(body.sale,co,who);
  await lockSale(c,co,sale.id);
  const existing=(await c.query("SELECT * FROM myfin.receipt_reviews WHERE company_id=$1 AND id=$2 FOR UPDATE",[co,sale.id])).rows[0];
  if(existing){if(existing.actor_id!==who.id||existing.request_digest!==digest)v.fail(409,"receipt_payload_changed");return {...output(existing,who),status:existing.status==="approved"?"posted":existing.status};}
  await c.query("SAVEPOINT paid_review_probe");let reason;
  try{const receipt=await checkout(c,who,co,sale);await c.query("RELEASE SAVEPOINT paid_review_probe");return {id:sale.id,status:"posted",receipt};}
  catch(error){
   await c.query("ROLLBACK TO SAVEPOINT paid_review_probe");await c.query("RELEASE SAVEPOINT paid_review_probe");
   reason=automaticReviewReason(error);if(!reason)throw error;
  }
  await c.query("INSERT INTO myfin.receipt_reviews(company_id,id,actor_id,payload,request_digest,reason_code) VALUES($1,$2,$3,$4,$5,$6)",[co,sale.id,who.id,sale,digest,reason]);
  await audit(c,who,co,"Request paid receipt review",sale.id);return {id:sale.id,status:"pending",reasonCode:reason};
 }));
 app.post("/api/companies/:company/receipt-dismissal-requests",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"checkout");const body=v.parse(z.strictObject({sale:v.sale}),req.body),{sale,digest}=paidIntent(body.sale,co,who);
  await lockSale(c,co,sale.id);
  const existing=(await c.query("SELECT * FROM myfin.receipt_reviews WHERE company_id=$1 AND id=$2 FOR UPDATE",[co,sale.id])).rows[0];
  if(existing&& (existing.actor_id!==who.id||existing.request_digest!==digest))v.fail(409,"receipt_payload_changed");
  const posted=(await c.query("SELECT id FROM myfin.transactions WHERE company_id=$1 AND id=$2 FOR SHARE",[co,sale.id])).rows[0];
  if(posted){const receipt=await checkout(c,who,co,sale);return {id:sale.id,status:"posted",receipt};}
  if(existing)return output(existing,who);
  await c.query("INSERT INTO myfin.receipt_reviews(company_id,id,actor_id,payload,request_digest,reason_code) VALUES($1,$2,$3,$4,$5,'cashier_requested_dismissal')",[co,sale.id,who.id,sale,digest]);
  await audit(c,who,co,"Request paid receipt dismissal",sale.id);return {id:sale.id,status:"pending",reasonCode:"cashier_requested_dismissal"};
 }));
 app.get("/api/companies/:company/receipt-reviews",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"receiptReviewsRead");const r=await c.query("SELECT * FROM myfin.receipt_reviews WHERE company_id=$1 AND ($2 OR actor_id=$3) ORDER BY created_at DESC LIMIT 1001",[co,!operator(who),who.id]);if(r.rowCount>1000)v.fail(409,"receipt_review_list_limit");return r.rows.map(row=>output(row,who));
 }));
 app.post("/api/companies/:company/receipt-reviews/approve-all",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"receiptReviewsResolve");
  const {reason,reviewIds}=v.parse(z.strictObject({
   reason:z.string().trim().min(3).max(1000),
   reviewIds:z.array(v.id).min(1).max(1000).refine(ids=>new Set(ids).size===ids.length),
  }),req.body);
  const approved=[],skipped=[];
  // Every batch takes overlapping receipt locks in the same order so two
  // managers cannot deadlock by submitting the same snapshot in reverse order.
  for(const id of [...reviewIds].sort()){
   await lockSale(c,co,id);
   const row=(await c.query("SELECT * FROM myfin.receipt_reviews WHERE company_id=$1 AND id=$2 FOR UPDATE",[co,id])).rows[0];
   if(!row){skipped.push({id,reasonCode:"not_found"});continue;}
   if(row.status!=="pending"){skipped.push({id,status:row.status,reasonCode:row.reason_code});continue;}
   if(!bulkApprovalReasons.has(row.reason_code)){
    skipped.push({id,status:row.status,reasonCode:row.reason_code});continue;
   }
   await c.query("SAVEPOINT bulk_receipt_approval");
   try{
    const result=await approveLocked(c,co,who,row,{reason},{revalidatePolicy:true});
    await c.query("RELEASE SAVEPOINT bulk_receipt_approval");
    approved.push(result);
   }catch(error){
    await c.query("ROLLBACK TO SAVEPOINT bulk_receipt_approval");
    await c.query("RELEASE SAVEPOINT bulk_receipt_approval");
    const reasonCode=bulkReplayReason(error);
    if(!reasonCode)throw error;
    skipped.push({id,status:"pending",reasonCode});
   }
  }
  return {approved,skipped};
 }));
 app.post("/api/companies/:company/receipt-reviews/:id/approve",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"receiptReviewsResolve");const input=v.parse(approvalInput,req.body),id=v.parse(v.id,req.params.id);
  await lockSale(c,co,id);
  const r=await c.query("SELECT * FROM myfin.receipt_reviews WHERE company_id=$1 AND id=$2 FOR UPDATE",[co,id]);if(!r.rowCount)v.fail(404,"not_found");const row=r.rows[0];
  return approveLocked(c,co,who,row,input,{allowInventoryShortage:true});
 }));
 app.post("/api/companies/:company/receipt-reviews/:id/dismiss",req=>scope(req,async(c,co,who)=>{
  requireCapability(who,"receiptReviewsResolve");const {reason}=v.parse(z.strictObject({reason:z.string().trim().min(3).max(1000)}),req.body),id=v.parse(v.id,req.params.id);
  await lockSale(c,co,id);
  const row=(await c.query("SELECT * FROM myfin.receipt_reviews WHERE company_id=$1 AND id=$2 FOR UPDATE",[co,id])).rows[0];if(!row)v.fail(404,"not_found");
  const posted=await c.query("SELECT id FROM myfin.transactions WHERE company_id=$1 AND id=$2 FOR SHARE",[co,id]);if(posted.rowCount)v.fail(409,"receipt_already_posted");
  if(row.status==="approved")v.fail(409,"receipt_already_approved");
  if(row.status!=="dismissed"){
    await c.query("UPDATE myfin.receipt_reviews SET status='dismissed',dismissed_by=$3,dismissal_reason=$4,dismissed_at=now() WHERE company_id=$1 AND id=$2",[co,id,who.id,reason]);
    await audit(c,who,co,"Dismiss paid receipt",id+" · "+reason);
  }
  return {id,status:"dismissed"};
 }));
}
