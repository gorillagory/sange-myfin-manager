// Mutating fixtures are allowed only on the disposable Phase06 cluster marker.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/database.js";
import { authConfig,createAuth,createIdentity } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createSale,cartItem,totalsFor,cents } from "../../src/domain/pos.js";
import { stripConfidential } from "../../src/domain/permissions.js";

const marker="myfin-phase06-pg-20260928",cfg=loadConfig();
if(process.env.MYFIN_ISOLATED_ACCEPTANCE!==marker||cfg.database.host!=="127.0.0.1"||cfg.database.port!==25436||cfg.database.database!=="myfin_dev"||!process.env.MYFIN_TEST_PRIVATE)throw Error("unsafe_phase06_test_target");
const admin=new pg.Client({...cfg.database,user:"postgres",password:(await readFile(process.env.MYFIN_TEST_PRIVATE+"/admin.secret","utf8")).trim()});await admin.connect();
assert.equal((await admin.query("SHOW cluster_name")).rows[0].cluster_name,marker);
const db=createDatabase(cfg.database),configured=authConfig(),authOptions={...configured,origin:"https://bfsb-bali.test",protocol:"https:",allowedHosts:["bfsb-bali.test","bfsb-other.test","unknown.test"],controlHosts:[],enforceTenantHosts:true,secure:true,rootDomain:"test"};
const auth=createAuth(db.pool,authOptions),app=buildApp({database:db,authOptions,auth,uploadDir:process.env.UPLOAD_DIR});
const password=(await readFile(process.env.MYFIN_TEST_PRIVATE+"/seed.secret","utf8")).trim(),tag=randomUUID().slice(0,8),email=key=>`${key}-${tag}@myfin.test`;
const workspace=`workspace-${tag}`,companyA=`company-a-${tag}`,companyB=`company-b-${tag}`;
let superId,ownerId,managerId,operatorId,superCookie,ownerCookie,managerCookie,operatorCookie,managerCode,expenseId;
const headers=(host,cookie,origin=true)=>({host,...(origin?{origin:`https://${host}`}:{}) ,...(cookie?{cookie}:{})});
async function request(host,path,{cookie,method="GET",body,origin=true}={}){return app.inject({url:"/api"+path,method,headers:headers(host,cookie,origin),...(body===undefined?{}:{payload:body})});}
async function json(host,path,options){const r=await request(host,path,options);assert.equal(r.statusCode,200,`${host}${path}: ${r.statusCode} ${r.body}`);return r.json();}
async function login(host,address){const r=await request(host,"/auth/sign-in/email",{method:"POST",body:{email:address,password}});assert.equal(r.statusCode,200,r.body);const values=r.headers["set-cookie"];return (Array.isArray(values)?values:[values]).map(x=>x.split(";")[0]).join("; ");}
function responseCookie(response){const values=response.headers["set-cookie"];return (Array.isArray(values)?values:[values]).map(x=>x.split(";")[0]).join("; ");}

try{
await test("fixtures preserve workspace ownership and multi-company assignments",async()=>{
 await db.transaction(async c=>{
  await c.query("INSERT INTO myfin.workspaces(id,name,slug) VALUES($1,'Bayam Food Services Sdn Bhd','bfsb')",[workspace]);
  await c.query("INSERT INTO myfin.companies(id,workspace_id,slug,name,data) VALUES($1,$3,'bali','Ba|Li',$4),($2,$3,'other','Other brand',$4)",[companyA,companyB,workspace,{preferences:{currency:"RM",taxRate:6,staffDiscountLimit:0}}]);
  await c.query("INSERT INTO myfin.tenant_hosts(hostname,workspace_id,company_id,canonical) VALUES('bfsb-bali.test',$1,$2,true),('bfsb-other.test',$1,$3,true)",[workspace,companyA,companyB]);
  superId=await createIdentity(c,{username:"Super",email:email("super"),password,role:"super_admin",company_id:""});
  ownerId=await createIdentity(c,{username:"Owner",email:email("owner"),password,role:"workspace_owner",workspace_id:workspace,company_id:""});
  managerId=await createIdentity(c,{username:"Manager",email:email("manager"),password,role:"manager",company_id:companyA});
  operatorId=await createIdentity(c,{username:"Operator",email:email("operator"),password,role:"operator",company_id:companyA});
  await c.query("INSERT INTO myfin.memberships(company_id,identity_id,role) VALUES($1,$2,'manager'),($1,$3,'operator')",[companyB,managerId,operatorId]);
 });
 [superCookie,ownerCookie,managerCookie,operatorCookie]=await Promise.all([login("bfsb-bali.test",email("super")),login("bfsb-bali.test",email("owner")),login("bfsb-bali.test",email("manager")),login("bfsb-bali.test",email("operator"))]);
 assert.equal((await json("bfsb-bali.test","/me",{cookie:ownerCookie})).role,"workspace_owner");
 assert.equal((await json("bfsb-bali.test","/me",{cookie:managerCookie})).role,"manager");
 assert.equal((await json("bfsb-bali.test","/me",{cookie:operatorCookie})).role,"operator");
});
await test("unknown hosts fail before login and exact host context is public",async()=>{
 assert.equal((await request("unknown.test","/tenant-context")).statusCode,404);
 const context=await json("bfsb-bali.test","/tenant-context");assert.equal(context.workspace.slug,"bfsb");assert.equal(context.company.slug,"bali");
});
await test("manager reports expose only sales, tax, expenses and cash flow",async()=>{
 await db.query("INSERT INTO myfin.transactions(company_id,id,actor_id,source,total,data) VALUES($1,$2,$3,'pos',106,$4)",[companyA,"sale-"+tag,operatorId,{type:"Receipt",date:new Date().toISOString(),businessDate:new Date().toISOString().slice(0,10),total:106,tax:6}]);
 await db.query("INSERT INTO myfin.expenses(company_id,id,data,amount,created_by) VALUES($1,$2,$3,20,$4)",[companyA,"report-expense-"+tag,{id:"report-expense-"+tag,company_id:companyA,date:new Date().toISOString().slice(0,10),description:"Rent",amount:20},operatorId]);
 const report=await json("bfsb-bali.test",`/companies/${companyA}/reports/summary`,{cookie:managerCookie});
 assert.equal(report.sales,106);assert.equal(report.tax,6);assert.equal(report.expenses,20);assert.equal(report.cashFlow,86);
 assert.deepEqual(Object.keys(report).sort(),["basis","cashFlow","daily","expenses","from","sales","tax","to"]);
 assert.deepEqual(Object.keys(report.daily[0]).sort(),["cashFlow","date","expenses","sales","tax"]);
 assert.equal(JSON.stringify(report).match(/cashIn|collected|cost|margin|profit|surplus|valuation/i),null);
 assert.equal((await request("bfsb-bali.test",`/companies/${companyA}/reports/summary`,{cookie:operatorCookie})).statusCode,403);
});
await test("company-scoped POS code cannot enter password administration",async()=>{
 managerCode=(await json("bfsb-bali.test",`/companies/${companyA}/users/${managerId}/pos-code`,{cookie:ownerCookie,method:"POST",body:{}})).code;
 const operatorCode=(await json("bfsb-bali.test",`/companies/${companyA}/users/${operatorId}/pos-code`,{cookie:ownerCookie,method:"POST",body:{}})).code;
 const signed=await request("bfsb-bali.test","/pos-auth/sign-in",{method:"POST",body:{code:operatorCode}});assert.equal(signed.statusCode,200,signed.body);const posCookie=responseCookie(signed);
 const me=await json("bfsb-bali.test","/me",{cookie:posCookie});assert.equal(me.authLevel,"pos_code");assert.equal(me.role,"operator");
 assert.equal((await request("bfsb-bali.test","/users",{cookie:posCookie})).statusCode,403);
 assert.equal((await request("bfsb-other.test","/me",{cookie:posCookie})).statusCode,401);
});
await test("operator expense void consumes a manager-code approval and keeps the row",async()=>{
 expenseId="operator-expense-"+tag;await json("bfsb-bali.test",`/companies/${companyA}/expenses`,{cookie:operatorCookie,method:"POST",body:{id:expenseId,company_id:companyA,date:new Date().toISOString().slice(0,10),description:"Operator purchase",category:"General",payee:"Shop",amount:10,receiptUrl:"",receiptPath:""}});
 assert.equal((await request("bfsb-bali.test",`/companies/${companyA}/expenses/${expenseId}`,{cookie:operatorCookie,method:"DELETE",body:{reason:"Wrong entry"}})).statusCode,403);
 await json("bfsb-bali.test",`/companies/${companyA}/expenses/${expenseId}`,{cookie:operatorCookie,method:"DELETE",body:{reason:"Duplicate entry",managerCode}});
 const row=(await db.query("SELECT voided_at FROM myfin.expenses WHERE company_id=$1 AND id=$2",[companyA,expenseId])).rows[0];assert.ok(row.voided_at);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM myfin.action_approvals WHERE company_id=$1 AND subject_id=$2",[companyA,expenseId])).rows[0].n,1);
 await assert.rejects(db.query("DELETE FROM myfin.expenses WHERE company_id=$1 AND id=$2",[companyA,expenseId]),error=>error.code==="23514");
});
await test("single-use handoff creates a host-only full session for another assigned company",async()=>{
 const issued=await json("bfsb-bali.test","/session-handoffs",{cookie:ownerCookie,method:"POST",body:{targetHostname:"bfsb-other.test"}}),url=new URL(issued.url),token=new URLSearchParams(url.hash.slice(1)).get("token");assert.ok(token);
 const consumed=await request("bfsb-other.test","/session-handoffs/consume",{method:"POST",body:{token}});assert.equal(consumed.statusCode,200,consumed.body);const cookie=responseCookie(consumed);
 const me=await json("bfsb-other.test","/me",{cookie});assert.equal(me.company_id,companyB);assert.equal(me.role,"workspace_owner");assert.equal(me.authLevel,"handoff_password");
 assert.equal((await request("bfsb-other.test","/session-handoffs/consume",{method:"POST",body:{token}})).statusCode,401);
 assert.equal((await request("bfsb-bali.test",`/companies/${companyB}/products`,{cookie:ownerCookie})).statusCode,404);
});
await test("membership constraint permits multiple companies and protects uniqueness per company",async()=>{
 const roles=(await db.query("SELECT company_id,role FROM myfin.memberships WHERE identity_id=$1 ORDER BY company_id",[operatorId])).rows;assert.deepEqual(roles,[{company_id:companyA,role:"operator"},{company_id:companyB,role:"operator"}]);
 await assert.rejects(db.query("INSERT INTO myfin.memberships(company_id,identity_id,role) VALUES($1,$2,'operator')",[companyA,operatorId]),error=>error.code==="23505");
});
await test("v2 and v3 paid retries keep their original totals and never deduct stock twice",async()=>{
 const product=await json("bfsb-bali.test",`/companies/${companyA}/products`,{cookie:ownerCookie,method:"POST",body:{name:"Receipt retry item",sku:`RETRY-${tag}`,price:19.93,cost:7.77,stock:12,trackStock:true,variants:[]}});
 const merchant={id:companyA,name:"Ba|Li",preferences:{currency:"RM",taxRate:6,staffDiscountLimit:0}};
 const make=id=>createSale({id,items:[cartItem(product)],company:merchant,user:{uid:operatorId,username:"Operator"},method:"Cash",received:100});
 const v3=make(`rounded-${tag}`),v2=make(`legacy-${tag}`),legacyTotals=totalsFor(v2.items,v2.taxRate,v2.discount);
 Object.assign(v2,{schemaVersion:2,...legacyTotals,change:(cents(v2.received)-cents(legacyTotals.total))/100});delete v2.totalBeforeRounding;delete v2.rounding;
 assert.notEqual(v3.total,v2.total,"the fixture must distinguish rounded and legacy receipts");
 for(const sale of [v2,v3]){
  const path=`/companies/${companyA}/checkout`,first=await json("bfsb-bali.test",path,{cookie:operatorCookie,method:"POST",body:sale});
  const stockAfter=(await db.query("SELECT stock FROM myfin.products WHERE company_id=$1 AND id=$2",[companyA,product.id])).rows[0].stock;
  const retry=stripConfidential({...sale,cashierName:"Name changed after payment"});
  const second=await json("bfsb-bali.test",path,{cookie:operatorCookie,method:"POST",body:retry});
  assert.equal(first.id,sale.id);assert.equal(first.schemaVersion,sale.schemaVersion);assert.equal(first.total,sale.total);
  assert.equal(second.id,sale.id);assert.equal(second.total,sale.total);assert.equal(second.change,sale.change);
  assert.equal((await db.query("SELECT stock FROM myfin.products WHERE company_id=$1 AND id=$2",[companyA,product.id])).rows[0].stock,stockAfter);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM myfin.stock_movements WHERE company_id=$1 AND sale_id=$2",[companyA,sale.id])).rows[0].n,1);
  const changed={...retry,items:[{...retry.items[0],price:retry.items[0].price+1}]};
  const rejected=await request("bfsb-bali.test",path,{cookie:operatorCookie,method:"POST",body:changed});
  assert.equal(rejected.statusCode,409);assert.equal(rejected.json().error,"receipt_payload_changed");
 }
});
await test("a cashier dismissal request is immutable and only a manager can resolve an unposted payment",async()=>{
 const product=(await json("bfsb-bali.test",`/companies/${companyA}/products`,{cookie:operatorCookie})).rows.find(row=>row.sku===`RETRY-${tag}`);
 const sale=stripConfidential(createSale({id:`dismiss-${tag}`,items:[cartItem(product)],company:{id:companyA,name:"Ba|Li",preferences:{currency:"RM",taxRate:6,staffDiscountLimit:0}},user:{uid:operatorId,username:"Operator"},method:"Cash",received:100,offline:true}));
 const requests=`/companies/${companyA}/receipt-dismissal-requests`,reviews=`/companies/${companyA}/receipt-reviews`,decision=`${reviews}/${sale.id}`;
 const pending=await json("bfsb-bali.test",requests,{cookie:operatorCookie,method:"POST",body:{sale}});
 assert.deepEqual({id:pending.id,status:pending.status,reasonCode:pending.reasonCode},{id:sale.id,status:"pending",reasonCode:"cashier_requested_dismissal"});
 assert.equal((await json("bfsb-bali.test",requests,{cookie:operatorCookie,method:"POST",body:{sale}})).status,"pending");
 assert.equal((await request("bfsb-bali.test",requests,{cookie:managerCookie,method:"POST",body:{sale}})).statusCode,403);
 const changed={...sale,received:101,change:Math.round((101-sale.total)*100)/100};
 const conflict=await request("bfsb-bali.test",requests,{cookie:operatorCookie,method:"POST",body:{sale:changed}});
 assert.equal(conflict.statusCode,409);assert.equal(conflict.json().error,"receipt_payload_changed");
 assert.equal((await request("bfsb-bali.test",`${decision}/dismiss`,{cookie:operatorCookie,method:"POST",body:{reason:"Duplicate payment"}})).statusCode,403);
 assert.equal((await request("bfsb-bali.test",`${decision}/dismiss`,{cookie:managerCookie,method:"POST",body:{reason:"No"}})).statusCode,400);
 const dismissed=await json("bfsb-bali.test",`${decision}/dismiss`,{cookie:managerCookie,method:"POST",body:{reason:"Payment was not recorded"}});
 assert.deepEqual(dismissed,{id:sale.id,status:"dismissed"});
 assert.equal((await json("bfsb-bali.test",requests,{cookie:operatorCookie,method:"POST",body:{sale}})).status,"dismissed");
 const listed=(await json("bfsb-bali.test",reviews,{cookie:operatorCookie})).find(row=>row.id===sale.id);
 assert.equal(listed.status,"dismissed");assert.equal(listed.dismissalReason,"Payment was not recorded");
 assert.equal((await request("bfsb-bali.test",`${decision}/approve`,{cookie:managerCookie,method:"POST",body:{reason:"Post it anyway"}})).statusCode,409);
 const checkout=await request("bfsb-bali.test",`/companies/${companyA}/checkout`,{cookie:operatorCookie,method:"POST",body:sale});
 assert.equal(checkout.statusCode,409);assert.equal(checkout.json().error,"receipt_dismissed");
 assert.equal((await db.query("SELECT count(*)::int AS n FROM myfin.transactions WHERE company_id=$1 AND id=$2",[companyA,sale.id])).rows[0].n,0);
});
await test("a pending dismissal cannot cancel a payment that the server posts first",async()=>{
 const product=(await json("bfsb-bali.test",`/companies/${companyA}/products`,{cookie:operatorCookie})).rows.find(row=>row.sku===`RETRY-${tag}`);
 const sale=stripConfidential(createSale({id:`posted-after-request-${tag}`,items:[cartItem(product)],company:{id:companyA,name:"Ba|Li",preferences:{currency:"RM",taxRate:6,staffDiscountLimit:0}},user:{uid:operatorId,username:"Operator"},method:"Cash",received:100}));
 const requests=`/companies/${companyA}/receipt-dismissal-requests`,review=`/companies/${companyA}/receipt-reviews/${sale.id}`;
 assert.equal((await json("bfsb-bali.test",requests,{cookie:operatorCookie,method:"POST",body:{sale}})).status,"pending");
 assert.equal((await json("bfsb-bali.test",`/companies/${companyA}/checkout`,{cookie:operatorCookie,method:"POST",body:sale})).id,sale.id);
 const raced=await json("bfsb-bali.test",requests,{cookie:operatorCookie,method:"POST",body:{sale}});
 assert.equal(raced.status,"posted");assert.equal(raced.receipt.id,sale.id);
 const rejected=await request("bfsb-bali.test",`${review}/dismiss`,{cookie:managerCookie,method:"POST",body:{reason:"Payment already posted"}});
 assert.equal(rejected.statusCode,409);assert.equal(rejected.json().error,"receipt_already_posted");
 assert.equal((await db.query("SELECT count(*)::int AS n FROM myfin.transactions WHERE company_id=$1 AND id=$2",[companyA,sale.id])).rows[0].n,1);
 const next=stripConfidential(createSale({id:`posted-before-request-${tag}`,items:[cartItem(product)],company:{id:companyA,name:"Ba|Li",preferences:{currency:"RM",taxRate:6,staffDiscountLimit:0}},user:{uid:operatorId,username:"Operator"},method:"Cash",received:100}));
 await json("bfsb-bali.test",`/companies/${companyA}/checkout`,{cookie:operatorCookie,method:"POST",body:next});
 const acknowledged=await json("bfsb-bali.test",requests,{cookie:operatorCookie,method:"POST",body:{sale:next}});
 assert.equal(acknowledged.status,"posted");assert.equal(acknowledged.receipt.id,next.id);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM myfin.receipt_reviews WHERE company_id=$1 AND id=$2",[companyA,next.id])).rows[0].n,0);
});
}finally{await app.close();await admin.end();}
