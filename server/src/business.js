import { randomUUID, createHash } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import * as v from "./validation.js";
import { registerManagement, managementLock, managementSession, requirePasswordSession } from "./management.js";
import {
  canonical,
  deductItems,
  totalsFor,
  normalizeProduct,
  cents,
  businessDate,
  expenseRecords,
} from "../../src/domain/pos.js";
import { validateProduct } from "../../src/domain/inventoryCsv.js";
import { owner,manager,operator,requireCapability,containsConfidential,publicProduct,publicClient,publicTransaction,recordVisible,recordOutput,publicStockMovement } from "./access.js";
import { registerDocuments,publishedTemplate } from "./documents.js";
import { templateDefaults } from "../../src/domain/documents.js";
import { registerReceiptReviews } from "./receipt-reviews.js";
import { posIdentity,verifyManagerCode } from "./pos-auth.js";
import { registerWorkspaces } from "./workspaces.js";
import { handoffSubject,createHandoff } from "./session-handoff.js";

export async function identity(db, subject, tenant=null) {
  const r = (await db.query(
    `SELECT i.id,i.display_name AS username,i.is_super,i.disabled_at,u.email
       FROM myfin.identity_mappings x JOIN myfin.app_identities i ON i.id=x.identity_id
       JOIN myfin.auth_user u ON u.id=x.subject
      WHERE x.provider='better-auth' AND x.subject=$1`,[subject])).rows[0];
  if (!r || r.disabled_at) v.fail(401, "session_required");
  const workspaces=(await db.query(`SELECT wm.workspace_id,wm.role FROM myfin.workspace_memberships wm
    JOIN myfin.workspaces w ON w.id=wm.workspace_id WHERE wm.identity_id=$1 AND wm.suspended_at IS NULL
    AND w.suspended_at IS NULL AND w.archived_at IS NULL ORDER BY wm.workspace_id`,[r.id])).rows;
  const companies=(await db.query(`SELECT m.company_id,m.role,c.workspace_id FROM myfin.memberships m
    JOIN myfin.companies c ON c.id=m.company_id JOIN myfin.workspaces w ON w.id=c.workspace_id
    WHERE m.identity_id=$1 AND c.suspended_at IS NULL AND c.archived_at IS NULL
      AND w.suspended_at IS NULL AND w.archived_at IS NULL ORDER BY m.company_id`,[r.id])).rows;
  const target=tenant?.surface==="tenant"?tenant.company_id:companies[0]?.company_id||"";
  const company=companies.find(x=>x.company_id===target),workspaceId=tenant?.workspace_id||company?.workspace_id||workspaces[0]?.workspace_id||"";
  const workspaceOwner=workspaces.some(x=>x.workspace_id===workspaceId);
  const role=r.is_super?"super_admin":workspaceOwner?"workspace_owner":company?.role;
  if(!role&&!r.is_super)v.fail(403,"access_denied");
  return {id:r.id,uid:r.id,username:r.username,email:r.email,role,globalRole:r.is_super?"super_admin":"",
    workspace_id:workspaceId,company_id:target,workspaceMemberships:workspaces,companyMemberships:companies,
    authLevel:"password",host_company_id:tenant?.surface==="tenant"?tenant.company_id:""};
}
export async function authorize(c, who, companyId, admin = false) {
  const { rows } = await c.query(
    "SELECT * FROM myfin.app_identities WHERE id=$1 AND disabled_at IS NULL FOR SHARE",
    [who.id],
  );
  if (!rows[0]) v.fail(401, "session_required");
  const company = await c.query(
    "SELECT id,workspace_id FROM myfin.companies WHERE id=$1 AND archived_at IS NULL AND suspended_at IS NULL FOR SHARE",
    [companyId],
  );
  if (!company.rowCount) v.fail(404, "not_found");
  if(who.host_company_id&&who.host_company_id!==companyId)v.fail(404,"not_found");
  if (rows[0].is_super) {who.role="super_admin";who.globalRole="super_admin";who.company_id=companyId;who.workspace_id=company.rows[0].workspace_id;return;}
  const wm=await c.query("SELECT 1 FROM myfin.workspace_memberships WHERE identity_id=$1 AND workspace_id=$2 AND suspended_at IS NULL",[who.id,company.rows[0].workspace_id]);
  if(wm.rowCount){who.role="workspace_owner";who.company_id=companyId;who.workspace_id=company.rows[0].workspace_id;return;}
  const m = await c.query(
    "SELECT role FROM myfin.memberships WHERE identity_id=$1 AND company_id=$2 FOR SHARE",
    [who.id, companyId],
  );
  if (!m.rowCount || (admin && m.rows[0].role !== "manager"))
    v.fail(403, "access_denied");
  who.role=m.rows[0].role;who.company_id=companyId;who.workspace_id=company.rows[0].workspace_id;
}
async function requireSuper(c, who) {
  const r = await c.query(
    "SELECT id FROM myfin.app_identities WHERE id=$1 AND is_super AND disabled_at IS NULL FOR SHARE",
    [who.id],
  );
  if (!r.rowCount) v.fail(403, "access_denied");
}
async function validateFileRefs(c, companyId, data) {
  const paths = [data.imagePath, data.receiptPath, data.attachmentPath].filter(
    Boolean,
  );
  for (const url of [data.imageUrl, data.receiptUrl, data.attachmentUrl, data.logo, data.qrCode, data.qrCodeUrl].filter(
    Boolean,
  )) {
    if (url.startsWith("/api/files/")) paths.push(url.slice(11));
    else if ([data.receiptUrl, data.attachmentUrl].includes(url)) v.fail(400, "private_file_required");
  }
  for (const path of paths) {
    const file = v.parse(v.id, path);
    const r = await c.query(
      "SELECT id FROM myfin.files WHERE id=$1 AND company_id=$2 FOR KEY SHARE",
      [file, companyId],
    );
    if (!r.rowCount) v.fail(403, "invalid_file_reference");
  }
}
const asRecord = (r) => ({
  ...r.data,
  id: r.id,
  company_id: r.company_id,
  ...(r.version === undefined ? {} : { version: Number(r.version) }),
});
export async function audit(
  c,
  who,
  companyId,
  action,
  details,
  id = randomUUID(),
) {
  await c.query(
    "INSERT INTO myfin.activities(company_id,id,actor_id,data) VALUES($1,$2,$3,$4)",
    [
      companyId,
      id,
      who.id,
      {
        action,
        details,
        user: who.username,
        actorId: who.id,
        date: new Date().toISOString(),
      },
    ],
  );
}
async function saveProduct(c, companyId, data, create = false) {
  const p = normalizeProduct(data);
  if (create) p.version = 1;
  else {
    const current = await c.query(
      "SELECT version FROM myfin.products WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [companyId, p.id],
    );
    if (!current.rowCount) v.fail(404, "not_found");
    if (p.version !== Number(current.rows[0].version))
      v.fail(409, "Product changed. Refresh and reopen it before saving.");
    p.version++;
  }
  const prior = await c.query(
    "SELECT id,data FROM myfin.products WHERE company_id=$1 ORDER BY id",
    [companyId],
  );
  try {
    validateProduct(
      {
        ...p,
        hasVariants: p.variants.length > 0,
        imageUrl: p.imageUrl?.startsWith("/api/files/") ? "" : p.imageUrl,
      },
      prior.rows.map(asRecord),
    );
  } catch {
    v.fail(400, "invalid_or_duplicate_product");
  }
  if (create) {
    await c.query(
      "INSERT INTO myfin.products(company_id,id,data,stock,price,cost) VALUES($1,$2,$3,$4,$5,$6)",
      [companyId, p.id, p, p.stock, p.price, p.cost],
    );
  } else {
    const r = await c.query(
      "UPDATE myfin.products SET data=$3,stock=$4,price=$5,cost=$6,version=version+1 WHERE company_id=$1 AND id=$2",
      [companyId, p.id, p, p.stock, p.price, p.cost],
    );
    if (!r.rowCount) v.fail(404, "not_found");
  }
  await c.query(
    "DELETE FROM myfin.product_variants WHERE company_id=$1 AND product_id=$2",
    [companyId, p.id],
  );
  for (const x of p.variants)
    await c.query(
      "INSERT INTO myfin.product_variants(company_id,product_id,id,stock,price,cost) VALUES($1,$2,$3,$4,$5,$6)",
      [companyId, p.id, x.id, x.stock, x.price, x.cost],
    );
  const old = prior.rows.find((x) => x.id === p.id)?.data;
  const movements = [];
  for (const target of p.variants.length ? p.variants : [p]) {
    const variantId = p.variants.length ? target.id : "";
    const previous = variantId
      ? old?.variants?.find((x) => x.id === variantId)?.stock
      : old?.stock;
    const quantity =
      Math.round((target.stock - Number(previous || 0)) * 1000) / 1000;
    if (p.trackStock && quantity)
      movements.push({
        productId: p.id,
        variantId,
        quantity,
        stockAfter: target.stock,
      });
  }
  return { ...p, _adjustments: movements };
}
export async function checkout(c, who, companyId, input, approval=null) {
  const sale = v.parse(v.sale, input);
  if (sale.company_id !== companyId || sale.cashierId !== who.id)
    v.fail(403, "invalid_sale_actor");
  if (
    sale.number !== `POS-${sale.id.toUpperCase()}` ||
    sale.businessDate !== businessDate(sale.date) ||
    cents(sale.received) / 100 !== sale.received ||
    cents(sale.change) / 100 !== sale.change
  )
    v.fail(400, "invalid_receipt_fields");
  if((sale.receiptTemplateId&&!(sale.receiptTemplateVersion>0))||(!sale.receiptTemplateId&&sale.receiptTemplateVersion>0))v.fail(400,"invalid_receipt_template_reference");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonical(sale)))
    .digest("hex");
  // Serialize same receipt before checking existence; different receipts then lock
  // product rows in a stable order. Both lock classes are transaction-scoped.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7))", [
    companyId + ":sale:" + sale.id,
  ]);
  const existing = await c.query(
    "SELECT * FROM myfin.transactions WHERE company_id=$1 AND id=$2",
    [companyId, sale.id],
  );
  if (existing.rowCount) {
    // Old paid queues may have had confidential cost fields scrubbed by the access
    // upgrade. Match their complete operational intent, never repost stock.
    const intent=value=>{
      const copy=Object.fromEntries(Object.keys(v.sale.shape).filter(key=>value[key]!==undefined&&!['cashierName','overrideReason'].includes(key)).map(key=>[key,value[key]]));
      copy.items=(copy.items||[]).map(({cost,...item})=>item);return JSON.stringify(canonical(copy));
    };
    if (existing.rows[0].fingerprint !== fingerprint && intent(existing.rows[0].data)!==intent(sale))
      v.fail(409, "receipt_payload_changed");
    return publicTransaction(asRecord(existing.rows[0]),who);
  }
  const ids = [...new Set(sale.items.map((i) => i.productId))].sort();
  if (ids.length > 100) v.fail(400, "too_many_products");
  const rows = await c.query(
    "SELECT * FROM myfin.products WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",
    [companyId, ids],
  );
  if (rows.rowCount !== ids.length) v.fail(409, "receipt_review_required_product_changed");
  const companyRow=(await c.query("SELECT name,data FROM myfin.companies WHERE id=$1",[companyId])).rows[0];
  const company={...companyRow.data,name:companyRow.name},prefs=company.preferences||{};
  const expectedStore={name:company.name||"",address:company.address||"",phone:company.phone||"",registration:company.registration||"",currency:prefs.currency||"RM",footer:prefs.receiptFooter||"Thank you for shopping with us.",paperWidth:prefs.paperWidth||"80"};
  if(!approval&&JSON.stringify(canonical(sale.storeSnapshot))!==JSON.stringify(canonical(expectedStore)))v.fail(409,"receipt_review_required_merchant_changed");
  const canonicalItems=sale.items.map(item=>{
    const product=rows.rows.find(row=>row.id===item.productId)?.data;
    const variant=item.variantId?product?.variants?.find(v=>v.id===item.variantId):null;
    if(!product||(item.variantId&&!variant))v.fail(409,"receipt_review_required_product_changed");
    return {...item,cost:Number(variant?.cost??product.cost??0),catalogPrice:Number(variant?.price??product.price)};
  });
  const priceChanged=canonicalItems.some(item=>item.price!==item.catalogPrice),taxChanged=sale.taxRate!==Number(prefs.taxRate??prefs.tax??0),limit=Number(prefs.staffDiscountLimit||0);
  if(!approval&&operator(who)&&(priceChanged||taxChanged||sale.discount>limit))v.fail(409,"receipt_review_required_pricing_policy");
  if(!approval&&manager(who)&&(priceChanged||taxChanged||sale.discount>limit)&&!sale.overrideReason)v.fail(409,"manager_override_reason_required");
  sale.items=canonicalItems.map(({catalogPrice,...item})=>item);
  const template=sale.receiptTemplateId?await publishedTemplate(c,companyId,"Receipt",sale.receiptTemplateId,sale.receiptTemplateVersion):sale.receiptTemplateVersion===0?{settings:templateDefaults("Receipt")}:await publishedTemplate(c,companyId,"Receipt");
  if(approval)Object.assign(expectedStore,sale.storeSnapshot);
  const companySnapshot={...expectedStore,email:company.email||"",logo:company.logo||"",qrCode:company.qrCode||company.qrCodeUrl||""};
  const totals = totalsFor(sale.items, sale.taxRate, sale.discount);
  if (
    totals.total <= 0 ||
    Object.entries(totals).some(([k, n]) => sale[k] !== n) ||
    cents(sale.received) < cents(totals.total) ||
    cents(sale.change) !== cents(sale.received) - cents(totals.total)
  )
    v.fail(400, "invalid_sale_totals");
  if (sale.paymentMethod !== "Cash" && sale.received !== sale.total)
    v.fail(400, "invalid_tender");
  let deduction;
  try {
    deduction = deductItems(rows.rows.map(asRecord), sale.items, sale.offline||!!approval);
  } catch {
    v.fail(409, "stock_unavailable");
  }
  const { updates, movements, shortage } = deduction;
  if (sale.client_id) {
    const customer = await c.query(
      "SELECT data FROM myfin.clients WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [companyId, sale.client_id],
    );
    if(!owner(who)&&customer.rows[0]?.data.type==="Supplier")v.fail(403,"supplier_restricted");
    if (sale.customerEmail && (!customer.rowCount || !operator(who))) {
      const data = {
        ...(customer.rows[0]?.data || {
          name: sale.customerName,
          type: "Client",
        }),
        email: sale.customerEmail,
      };
      await c.query(
        "INSERT INTO myfin.clients(company_id,id,data) VALUES($1,$2,$3) ON CONFLICT(company_id,id) DO UPDATE SET data=EXCLUDED.data",
        [companyId, sale.client_id, data],
      );
    } else if (!customer.rowCount) v.fail(404, "customer_not_found");
  }
  const saved = {
    ...sale,
    cashierId: who.id,
    cashierName: who.username,
    stockShortage: shortage,
    storeSnapshot:expectedStore,companySnapshot,templateSnapshot:template.settings,
  };
  await c.query(
    "INSERT INTO myfin.transactions(company_id,id,actor_id,source,total,fingerprint,data) VALUES($1,$2,$3,'pos',$4,$5,$6)",
    [companyId, sale.id, who.id, sale.total, fingerprint, saved],
  );
  for (const p of updates) {
    p.version++;
    await c.query(
      "UPDATE myfin.products SET data=$3,stock=$4,version=version+1 WHERE company_id=$1 AND id=$2",
      [companyId, p.id, p, p.stock],
    );
    for (const x of p.variants)
      await c.query(
        "UPDATE myfin.product_variants SET stock=$4 WHERE company_id=$1 AND product_id=$2 AND id=$3",
        [companyId, p.id, x.id, x.stock],
      );
  }
  await c.query(
    "INSERT INTO myfin.stock_movements(company_id,id,actor_id,data,sale_id) VALUES($1,$2,$3,$4,$2)",
    [
      companyId,
      sale.id,
      who.id,
      {
        saleId: sale.id,
        date: sale.date,
        cashierId: who.id,
        movements,
        shortage,
      },
    ],
  );
  await audit(
    c,
    who,
    companyId,
    "POS sale",
    `${sale.number} · ${sale.paymentMethod} · ${sale.total.toFixed(2)}${shortage ? " · Stock needs review" : ""}`,
    sale.id,
  );
  if(approval)await audit(c,approval.who,companyId,"Approve paid receipt",sale.id+" · "+approval.reason);
  return publicTransaction(saved,who);
}
export function registerBusiness(app, { database: db, auth, authOptions }) {
  app.decorateRequest("identity", null);
  app.decorateRequest("authSessionId", null);
  app.addHook("preHandler", async (req) => {
    if (req.url.startsWith("/api/health/") || req.url.startsWith("/api/auth/") || req.url.startsWith("/api/pos-auth/") || req.url==="/api/tenant-context" || req.url==="/api/session-handoffs/consume" || req.url==="/api/session-handoffs/sign-out")
      return;
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (session) {
      req.identity = await identity(db, session.user.id,req.tenant);
      req.authSessionId = session.session.id;
      req.authLevel="password";
      return;
    }
    const handoff=await handoffSubject(db,req,authOptions);
    if(handoff){req.identity=await identity(db,handoff.subject,req.tenant);req.identity.authLevel="handoff_password";req.identity.handoffSessionDigest=handoff.digest;req.authLevel="handoff_password";return;}
    req.identity=await posIdentity(db,req,authOptions);
    if(!req.identity)v.fail(401,"session_required");
    req.authLevel="pos_code";
  });
  app.get("/api/me", async (req) => req.identity);
  app.post("/api/session-handoffs",async req=>db.transaction(async c=>{
    requirePasswordSession(req);await managementLock(c);await managementSession(c,req);
    const {targetHostname}=v.parse(z.strictObject({targetHostname:z.string().trim().toLowerCase().max(253)}),req.body);
    return createHandoff(c,req,authOptions,targetHostname);
  }));
  app.patch("/api/me", async (req) => {
    requirePasswordSession(req);
    const data = v.parse(
      z.strictObject({ username: z.string().min(1).max(120) }),
      req.body,
    );
    await db.transaction(async (c) => {
      await managementLock(c);
      await managementSession(c,req);
      const active = await c.query("SELECT id FROM myfin.app_identities WHERE id=$1 AND disabled_at IS NULL FOR SHARE", [req.identity.id]);
      if (!active.rowCount) v.fail(401, "session_required");
      await c.query(
        "UPDATE myfin.app_identities SET display_name=$2 WHERE id=$1",
        [req.identity.id, data.username],
      );
      await c.query(
        'UPDATE myfin.auth_user SET name=$2,"updatedAt"=now() WHERE id=$1',
        [req.identity.id, data.username],
      );
    });
    return { ok: true };
  });
  registerManagement(app, { db, authOptions, authorize, requireSuper, validateFileRefs, audit });
  registerWorkspaces(app,{db,authOptions,authorize,audit,validateFileRefs});
  registerDocuments(app,{db,authorize,audit});
  registerReceiptReviews(app,{db,authorize,checkout,audit});
  const scoped = (req, fn, admin = false) => {
    const company = v.parse(v.id, req.params.company);
    return db.transaction(async (c) => {
      await managementSession(c,req);
      await authorize(c, req.identity, company, admin);
      return fn(c, company);
    });
  };
  app.get("/api/companies/:company/reports/summary",req=>scoped(req,async(c,co)=>{
    requireCapability(req.identity,"financialReports");
    const dates=v.parse(z.strictObject({from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}),req.query);
    const to=dates.to||businessDate(),from=dates.from||businessDate(new Date(Date.now()-6*86400000));
    const span=(Date.parse(to)-Date.parse(from))/86400000;
    if(!Number.isInteger(span)||span<0||span>366||new Date(from).toISOString().slice(0,10)!==from||new Date(to).toISOString().slice(0,10)!==to)v.fail(400,"invalid_report_range");
    const tx=(await c.query("SELECT * FROM myfin.transactions WHERE company_id=$1",[co])).rows;
    const exp=(await c.query("SELECT * FROM myfin.expenses WHERE company_id=$1 AND voided_at IS NULL",[co])).rows.map(asRecord);
    const payments=(await c.query("SELECT amount,paid_at FROM myfin.document_payments WHERE company_id=$1",[co])).rows;
    const days=new Map();for(let i=0;i<=span;i++){const day=new Date(Date.parse(from)+i*86400000).toISOString().slice(0,10);days.set(day,{date:day,sales:0,tax:0,cashIn:0,expenses:0});}
    const add=(date,kind,amount)=>{const row=days.get(date);if(row)row[kind]+=cents(amount);};
    for(const row of tx){
      const saleDate=row.data.businessDate||businessDate(row.issued_at||row.data.date);
      if(row.source==="pos"){add(saleDate,"sales",row.total);add(saleDate,"tax",Number(row.data.tax||0));add(saleDate,"cashIn",row.total);}
      else if(row.document_state==="issued"&&row.data.type==="Invoice"){add(saleDate,"sales",row.total);add(saleDate,"tax",Number(row.issued_snapshot?.tax??row.data.tax??0));}
      else if(row.document_state==="legacy"&&row.data.type==="Invoice"&&["Paid","Cleared"].includes(row.data.status)){add(saleDate,"sales",row.total);add(saleDate,"tax",Number(row.data.tax||0));add(saleDate,"cashIn",row.total);}
    }
    for(const payment of payments)add(businessDate(payment.paid_at),"cashIn",payment.amount);
    for(const expense of expenseRecords({expenses:exp,transactions:tx.filter(row=>row.document_state==="legacy").map(asRecord)}))add(businessDate(expense.date),"expenses",expense.amount);
    const calculated=[...days.values()].map(row=>({date:row.date,sales:row.sales/100,tax:row.tax/100,cashIn:row.cashIn/100,expenses:row.expenses/100,cashFlow:(row.cashIn-row.expenses)/100}));
    const sum=key=>calculated.reduce((total,row)=>total+cents(row[key]),0)/100;
    const sales=sum("sales"),tax=sum("tax"),cashIn=sum("cashIn"),expenses=sum("expenses"),cashFlow=(cents(cashIn)-cents(expenses))/100;
    const daily=calculated.map(row=>({date:row.date,sales:row.sales,tax:row.tax,expenses:row.expenses,cashFlow:row.cashFlow}));
    return {from,to,sales,tax,expenses,cashFlow,daily,basis:"Sales and tax use POS business date or invoice issue date; cash flow uses receipts, invoice payments and expenses."};
  }));
  app.post("/api/companies/:company/stock-adjustments",req=>scoped(req,async(c,co)=>{
    requireCapability(req.identity,"inventoryTransact");
    const body=v.parse(z.strictObject({reason:z.string().trim().min(3).max(500),adjustments:z.array(z.strictObject({productId:v.id,variantId:z.string().max(128).optional(),quantity:z.number().min(-1e6).max(1e6).refine(n=>n!==0)})).min(1).max(100)}),req.body);
    const ids=[...new Set(body.adjustments.map(x=>x.productId))].sort();
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,8))",[co]);
    const rows=await c.query("SELECT * FROM myfin.products WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",[co,ids]);
    if(rows.rowCount!==ids.length)v.fail(404,"product_not_found");
    const movements=[];
    for(const row of rows.rows){
      const product=normalizeProduct(row.data);if(!product.trackStock)v.fail(409,"stock_tracking_required");
      for(const item of body.adjustments.filter(x=>x.productId===row.id)){
        const target=item.variantId?product.variants.find(x=>x.id===item.variantId):product;
        if(!target||(product.variants.length&&!item.variantId))v.fail(404,"variant_not_found");
        const after=Math.round((Number(target.stock)+item.quantity)*1000)/1000;if(after<0)v.fail(409,"stock_unavailable");
        target.stock=after;movements.push({productId:row.id,variantId:item.variantId||"",quantity:item.quantity,stockAfter:after});
      }
      product.stock=product.variants.length?product.variants.reduce((n,x)=>n+Number(x.stock),0):product.stock;product.version=Number(row.version)+1;
      await c.query("UPDATE myfin.products SET data=$3,stock=$4,version=version+1 WHERE company_id=$1 AND id=$2",[co,row.id,product,product.stock]);
      for(const item of product.variants)await c.query("UPDATE myfin.product_variants SET stock=$4 WHERE company_id=$1 AND product_id=$2 AND id=$3",[co,row.id,item.id,item.stock]);
    }
    const id=randomUUID(),data={id,company_id:co,action:"Inventory transaction",reason:body.reason,date:new Date().toISOString(),cashierId:req.identity.id,movements};
    await c.query("INSERT INTO myfin.stock_movements(company_id,id,actor_id,data) VALUES($1,$2,$3,$4)",[co,id,req.identity.id,data]);
    await audit(c,req.identity,co,"Inventory transaction",`${id} · ${body.reason}`);
    return publicStockMovement(data,req.identity);
  }));
  const schemas = {
    products: v.product,
    clients: v.client,
    transactions: v.transaction,
    expenses: v.expense,
  };
  for (const name of [
    ...Object.keys(schemas),
    "activities",
    "stock_movements",
  ]) {
    app.get(`/api/companies/:company/${name}`, (req) =>
      scoped(req, async (c, co) => {
        const q = v.parse(
          z.strictObject({
            after: v.id.optional(),
            limit: z.coerce.number().int().min(1).max(500).default(500),
          }),
          req.query,
        );
        if(["expenses","activities"].includes(name))requireCapability(req.identity,name==="expenses"?"expensesRead":"activityRead");
        if(name==="stock_movements")requireCapability(req.identity,"stockHistoryRead");
        const predicates=["company_id=$1","id>$2"],args=[co,q.after||""];
        if(name==="expenses")predicates.push("voided_at IS NULL");
        if(name==="expenses"&&operator(req.identity)){args.push(req.identity.id);predicates.push(`created_by=$${args.length}`);}
        if(!owner(req.identity)&&name==="clients")predicates.push("coalesce(data->>'type','Customer')<>'Supplier'");
        if(!owner(req.identity)&&name==="transactions"){
          if(operator(req.identity)){args.push(req.identity.id);predicates.push(`((source='pos' AND actor_id=$${args.length}) OR (document_state='draft' AND data->>'type' IN ('Invoice','Quote') AND (actor_id=$${args.length} OR assigned_to=$${args.length})))`);}
          else predicates.push("(source='pos' OR (document_state<>'legacy' AND data->>'type' IN ('Invoice','Quote')))");
        }
        args.push(q.limit+1);
        const select=name==="transactions"?"t.*,(SELECT coalesce(sum(amount),0) FROM myfin.document_payments p WHERE p.company_id=t.company_id AND p.document_id=t.id) AS paid_amount":"*";
        const r=await c.query(`SELECT ${select} FROM myfin.${name} t WHERE ${predicates.join(" AND ")} ORDER BY id LIMIT $${args.length}`,args);
        return {rows:r.rows.slice(0,q.limit).map(row=>name==="products"?publicProduct(asRecord(row),req.identity):name==="clients"?publicClient(asRecord(row),req.identity):name==="transactions"?recordOutput(row,req.identity):name==="stock_movements"?publicStockMovement(asRecord(row),req.identity):asRecord(row)),next:r.rows.length>q.limit?r.rows[q.limit-1].id:null};
      }),
    );
    if (!schemas[name]) continue;
    const save = (req, update) =>
      scoped(req, async (c, co) => {
        let input=req.body;
        if(name==="products"){
          requireCapability(req.identity,"inventoryWrite");
          await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,8))",[co]);
          const currentProduct=update?(await c.query("SELECT data FROM myfin.products WHERE company_id=$1 AND id=$2 FOR UPDATE",[co,v.parse(v.id,req.params.id)])).rows[0]?.data:null;
          if(!owner(req.identity)){
            if(containsConfidential(input))v.fail(403,"financial_fields_restricted");
            const prior=currentProduct;
            input={...input,cost:prior?.cost||0,variants:(input.variants||[]).map(item=>({...item,cost:prior?.variants?.find(v=>v.id===item.id)?.cost||0}))};
          }
        }
        if(name==="expenses")requireCapability(req.identity,update?"expensesWrite":"expensesCreate");
        if(name==="transactions"){
          if(!owner(req.identity))v.fail(403,"use_document_workflow");
          if(!["Expense","Payment Voucher"].includes(input?.type))v.fail(409,"use_document_workflow");
        }
        if(name==="clients"){
          requireCapability(req.identity,update?"clientsWrite":"clientsCreate");
          if(!owner(req.identity)&&input?.type==="Supplier")v.fail(403,"supplier_restricted");
          if(update){const prior=(await c.query("SELECT data FROM myfin.clients WHERE company_id=$1 AND id=$2 FOR UPDATE",[co,v.parse(v.id,req.params.id)])).rows[0];if(!owner(req.identity)&&prior?.data.type==="Supplier")v.fail(403,"supplier_restricted");}
        }
        const data = v.parse(schemas[name], input),
          id = update ? v.parse(v.id, req.params.id) : data.id || randomUUID();
        if (
          (data.company_id && data.company_id !== co) ||
          (data.id && data.id !== id)
        )
          v.fail(403, "invalid_tenant_or_id");
        data.id = id;
        data.company_id = co;
        await validateFileRefs(c, co, data);
        if (name === "products") {
          await c.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,8))",
            [co],
          );
          await c.query(
            "SELECT id FROM myfin.products WHERE company_id=$1 AND id=$2 FOR UPDATE",
            [co, id],
          );
          const saved = await saveProduct(c, co, data, !update);
          data.version = saved.version;
          if (saved._adjustments.length)
            await c.query(
              "INSERT INTO myfin.stock_movements(company_id,id,actor_id,data) VALUES($1,$2,$3,$4)",
              [
                co,
                randomUUID(),
                req.identity.id,
                {
                  action: "Stock adjustment",
                  date: new Date().toISOString(),
                  cashierId: req.identity.id,
                  movements: saved._adjustments,
                },
              ],
            );
        } else {
          const old = await c.query(
            `SELECT * FROM myfin.${name} WHERE company_id=$1 AND id=$2 FOR UPDATE`,
            [co, id],
          );
          if (old.rows[0]?.source === "pos")
            v.fail(409, "posted_pos_immutable");
          if (update && !old.rowCount) v.fail(404, "not_found");
          if (!update && old.rowCount) v.fail(409, "already_exists");
          if (name === "transactions") {
            if (
              (!update &&
                (data.quoteId ||
                  data.convertedTo ||
                  data.status === "Converted")) ||
              (update &&
                (old.rows[0].data.status === "Converted" ||
                  data.quoteId !== old.rows[0].data.quoteId ||
                  data.convertedTo !== old.rows[0].data.convertedTo ||
                  data.type !== old.rows[0].data.type))
            )
              v.fail(409, "conversion_fields_protected");
            if (data.number.startsWith("POS-"))
              v.fail(400, "reserved_receipt_number");
            if (data.client_id) {
              const r = await c.query(
                "SELECT id FROM myfin.clients WHERE company_id=$1 AND id=$2",
                [co, data.client_id],
              );
              if (!r.rowCount) v.fail(404, "customer_not_found");
            }
            if (["Expense", "Payment Voucher"].includes(data.type)) {
              if (data.amount === undefined || !data.description)
                v.fail(400, "invalid_expense");
              data.amount = cents(data.amount) / 100;
              data.total = data.amount;
            } else {
              if (!data.items.length) v.fail(400, "items_required");
              Object.assign(
                data,
                totalsFor(data.items, data.taxRate, data.discount),
              );
              if (data.subtotal > 1e9 || data.total > 1e9)
                v.fail(400, "amount_too_large");
            }
            if (update)
              await c.query(
                "UPDATE myfin.transactions SET data=$3,total=$4 WHERE company_id=$1 AND id=$2",
                [co, id, data, data.total],
              );
            else
              await c.query(
                "INSERT INTO myfin.transactions(company_id,id,actor_id,source,total,data) VALUES($1,$2,$3,'manual',$4,$5)",
                [co, id, req.identity.id, data.total, data],
              );
          } else if (name === "expenses") {
            data.amount = cents(data.amount) / 100;
            if (update)
              await c.query(
                "UPDATE myfin.expenses SET data=$3,amount=$4 WHERE company_id=$1 AND id=$2",
                [co, id, data, data.amount],
              );
            else
              await c.query(
                "INSERT INTO myfin.expenses(company_id,id,data,amount,created_by) VALUES($1,$2,$3,$4,$5)",
                [co, id, data, data.amount,req.identity.id],
              );
          } else if (update)
            await c.query(
              "UPDATE myfin.clients SET data=$3 WHERE company_id=$1 AND id=$2",
              [co, id, data],
            );
          else
            await c.query(
              "INSERT INTO myfin.clients(company_id,id,data) VALUES($1,$2,$3)",
              [co, id, data],
            );
        }
        await audit(
          c,
          req.identity,
          co,
          `${update ? "Update" : "Create"} ${name}`,
          name === "products"
            ? `${data.name} · Stock ${data.stock}${data.variants.length ? " · " + data.variants.map((x) => x.name + ": " + x.stock).join(", ") : ""}`
            : id,
        );
        return name==="products"?publicProduct(data,req.identity):name==="clients"?publicClient(data,req.identity):data;
      });
    app.post(`/api/companies/:company/${name}`, (req) => save(req, false));
    app.put(`/api/companies/:company/${name}/:id`, (req) => save(req, true));
    app.delete(`/api/companies/:company/${name}/:id`, (req) =>
      scoped(
        req,
        async (c, co) => {
          const id = v.parse(v.id, req.params.id);
          const old = await c.query(
            `SELECT * FROM myfin.${name} WHERE company_id=$1 AND id=$2 FOR UPDATE`,
            [co, id],
          );
          if (!old.rowCount) v.fail(404, "not_found");
          if(name==="expenses"){
            const approval=v.parse(z.strictObject({reason:z.string().trim().min(3).max(1000).optional(),managerCode:z.string().regex(/^\d{6}$/).optional()}),req.body||{});
            if(operator(req.identity)){
              if(!authOptions.pos||!approval.managerCode)v.fail(403,"manager_approval_required");
              const approver=await verifyManagerCode(c,authOptions.pos,co,approval.managerCode);
              await c.query("INSERT INTO myfin.action_approvals(id,company_id,actor_id,approver_id,action,subject_type,subject_id,reason) VALUES($1,$2,$3,$4,'void','expense',$5,$6)",[randomUUID(),co,req.identity.id,approver,id,approval.reason||"Manager-approved expense void"]);
            }else requireCapability(req.identity,"expensesVoid");
            await c.query("UPDATE myfin.expenses SET voided_at=coalesce(voided_at,now()),voided_by=coalesce(voided_by,$3),void_reason=coalesce(void_reason,$4) WHERE company_id=$1 AND id=$2",[co,id,req.identity.id,approval.reason||"Expense voided"]);
            await audit(c,req.identity,co,"Void expense",id);return {ok:true};
          }
          if(name==="transactions")v.fail(409,"financial_history_immutable");
          if(name==="transactions"&&old.rows[0].document_state!=="legacy")v.fail(409,"use_document_workflow");
          if(name==="clients"&&!owner(req.identity)&&old.rows[0].data.type==="Supplier")v.fail(403,"supplier_restricted");
          if (old.rows[0].source === "pos") v.fail(409, "posted_pos_immutable");
          await c.query(
            `DELETE FROM myfin.${name} WHERE company_id=$1 AND id=$2`,
            [co, id],
          );
          await audit(c, req.identity, co, `Delete ${name}`, id);
          return { ok: true };
        },
        name !== "expenses",
      ),
    );
  }
  app.post("/api/companies/:company/checkout", (req) =>
    scoped(req, (c, co) => checkout(c, req.identity, co, req.body)),
  );
  app.post("/api/companies/:company/import-products", (req) =>
    scoped(req, async (c, co) => {
      requireCapability(req.identity,"inventoryWrite");
      if(!owner(req.identity)&&containsConfidential(req.body))v.fail(403,"financial_fields_restricted");
      const input=owner(req.identity)?req.body:(req.body||[]).map(p=>({...p,cost:0,variants:(p.variants||[]).map(x=>({...x,cost:0}))}));
      const products = v.parse(z.array(v.product).min(1).max(300), input);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,8))", [
        co,
      ]);
      for (const p of products) {
        if (p.company_id && p.company_id !== co) v.fail(403, "invalid_tenant");
        await validateFileRefs(c, co, p);
        const saved = await saveProduct(
          c,
          co,
          { ...p, id: randomUUID() },
          true,
        );
        if (saved._adjustments.length)
          await c.query(
            "INSERT INTO myfin.stock_movements(company_id,id,actor_id,data) VALUES($1,$2,$3,$4)",
            [
              co,
              randomUUID(),
              req.identity.id,
              {
                action: "Opening stock",
                date: new Date().toISOString(),
                cashierId: req.identity.id,
                movements: saved._adjustments,
              },
            ],
          );
      }
      await audit(
        c,
        req.identity,
        co,
        "Import products",
        String(products.length),
      );
      return { count: products.length };
    }),
  );
  app.post("/api/companies/:company/convert-quote/:id",req=>scoped(req,async()=>{v.fail(409,"use_document_workflow");}));
  app.post("/api/companies/:company/assign-project", (req) =>
    scoped(req, async (c, co) => {
      requireCapability(req.identity,"documentsIssue");
      const data = v.parse(
        z.strictObject({
          ids: z.array(v.id).min(1).max(500),
          projectName: z.string().max(500),
        }),
        req.body,
      );
      const r = await c.query(
        "SELECT * FROM myfin.transactions WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",
        [co, data.ids],
      );
      if (
        r.rowCount !== new Set(data.ids).size
      )
        v.fail(409, "invalid_project_documents");
      if(r.rows.some(row=>row.source==="pos"||!recordVisible(row,req.identity)||row.document_state==="issued"||row.document_state==="voided"||row.document_state==="corrected"))v.fail(409,"issued_document_immutable");
      for (const x of r.rows)
        await c.query(
          "UPDATE myfin.transactions SET data=$3 WHERE company_id=$1 AND id=$2",
          [co, x.id, { ...x.data, project: data.projectName }],
        );
      await audit(c, req.identity, co, "Assign project", data.projectName);
      return { ok: true };
    }),
  );
}
