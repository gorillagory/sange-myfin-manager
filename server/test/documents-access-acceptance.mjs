import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/database.js";
import { authConfig,createAuth,createIdentity } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createSale,cartItem,businessDate } from "../../src/domain/pos.js";
import { templateDefaults,buildDocumentViewModel } from "../../src/domain/documents.js";
import { stripConfidential } from "../../src/domain/permissions.js";
const marker="myfin-phase05-pg-20260913",cfg=loadConfig(),privateDir=process.env.MYFIN_TEST_PRIVATE;
if(process.env.MYFIN_ISOLATED_ACCEPTANCE!==marker||cfg.database.host!=="127.0.0.1"||cfg.database.port!==25435||cfg.database.database!=="myfin_dev"||!privateDir)throw Error("unsafe_phase05_test_target");
const admin=new pg.Client({...cfg.database,user:"postgres",password:(await readFile(privateDir+"/admin.secret","utf8")).trim()});await admin.connect();assert.equal((await admin.query("SHOW cluster_name")).rows[0].cluster_name,marker);
const db=createDatabase(cfg.database),authOptions=authConfig(),auth=createAuth(db.pool,authOptions),app=buildApp({database:db,authOptions,auth,uploadDir:process.env.UPLOAD_DIR});
const password=(await readFile(privateDir+"/seed.secret","utf8")).trim(),tag=randomUUID().slice(0,8),email=key=>`${key}-${tag}@myfin.test`;
const co="phase05-"+tag,other="other-"+tag,company={id:co,name:"Phase05 shop",preferences:{currency:"RM",taxRate:0,staffDiscountLimit:0}},today=businessDate();
let root,manager,staff,peer,rootCookie,managerCookie,staffCookie,peerCookie,product,customer,supplier,quote,issued,template;
async function request(path,{cookie=rootCookie,method="GET",body,origin=authOptions.origin,headers={}}={}){return app.inject({url:"/api"+path,method,headers:{...(cookie?{cookie}:{}),...(origin?{origin}:{}),...headers},...(body===undefined?{}:{payload:body})});}
async function json(path,options){const r=await request(path,options);assert.equal(r.statusCode,200,`${path}: ${r.statusCode} ${r.json().error||""}`);return r.json();}
async function login(key){const r=await request("/auth/sign-in/email",{cookie:null,method:"POST",body:{email:email(key),password}});assert.equal(r.statusCode,200,"synthetic login");const cs=r.headers["set-cookie"];return(Array.isArray(cs)?cs:[cs]).map(x=>x.split(";")[0]).join("; ");}
const route=(suffix)=>`/companies/${co}${suffix}`;
const wire=sale=>{const x=stripConfidential(sale);delete x.companySnapshot;delete x.templateSnapshot;delete x.syncStatus;delete x.syncError;return x;};
function intent(p=product,{id=randomUUID(),user=staff,qty=1,offline=false,discount=0,reason}={}){const sale=createSale({id,items:[{...cartItem(p),qty}],company,user:{uid:user,username:user===staff?"staff":"manager"},method:"Cash",received:10000,confirmed:true,offline,discount,...(reason?{overrideReason:reason}:{})});return wire(sale);}
const doc=(patch={})=>({type:"Quote",client_id:customer.id,date:today,dueDate:"",validUntil:"",items:[{desc:"Consulting",qty:1,unit:"hour",price:10.1}],discount:0,taxRate:0,notes:"",paymentInstructions:"",terms:"",footer:"",signatureLabel:"",templateId:"",assignedTo:"",...patch});
function noFinancial(value){const raw=JSON.stringify(value);assert.doesNotMatch(raw,/"(?:cost|costs|margin|profit|privateFinancial|unitCost)"\s*:/);assert.ok(!raw.includes("77191.37"));}
try{
await test("fixtures and role projections isolate costs, suppliers, expenses, audit and company scope",async()=>{
 await db.transaction(async c=>{for(const id of [co,other])await c.query("INSERT INTO myfin.companies(id,name,data) VALUES($1,$2,$3)",[id,id===co?company.name:"Other",{preferences:company.preferences}]);root=await createIdentity(c,{username:"owner",email:email("owner"),password,role:"super",company_id:""});manager=await createIdentity(c,{username:"manager",email:email("manager"),password,role:"company_admin",company_id:co});staff=await createIdentity(c,{username:"staff",email:email("staff"),password,role:"company_user",company_id:co});peer=await createIdentity(c,{username:"peer",email:email("peer"),password,role:"company_user",company_id:co});});
 rootCookie=await login("owner");managerCookie=await login("manager");staffCookie=await login("staff");peerCookie=await login("peer");
 product=await json(route("/products"),{method:"POST",body:{name:"Private cost product",sku:"SKU-"+tag,price:10,cost:77191.37,stock:20,trackStock:true,variants:[]}});
 customer=await json(route("/clients"),{method:"POST",cookie:staffCookie,body:{name:"Customer",type:"Client"}});
 supplier=await json(route("/clients"),{method:"POST",body:{name:"Private supplier",type:"Supplier"}});
 await json(route("/expenses"),{method:"POST",body:{amount:50,date:today,description:"Private expense"}});
 for(const cookie of [staffCookie,managerCookie]){
  const rows=await json(route("/products"),{cookie});assert.equal(rows.rows[0].price,10);noFinancial(rows);
  const clients=await json(route("/clients"),{cookie});assert.ok(!clients.rows.some(row=>row.id===supplier.id));
  for(const path of ["/expenses","/activities","/reports/summary"])assert.equal((await request(route(path),{cookie})).statusCode,403);
  assert.equal((await request(`/companies/${other}/products`,{cookie})).statusCode,403);
 }
 assert.equal((await json(route("/products"))).rows[0].cost,77191.37);
 assert.equal((await request(route("/products"),{cookie:staffCookie,method:"POST",body:{...product,id:"forbidden"}})).statusCode,403);
 assert.equal((await request(route("/import-products"),{cookie:staffCookie,method:"POST",body:[product]})).statusCode,403);
 assert.equal((await request(route("/clients/"+customer.id),{cookie:staffCookie,method:"PUT",body:customer})).statusCode,403);
 assert.equal((await request(route("/clients"),{cookie:managerCookie,method:"POST",body:{name:"No supplier",type:"Supplier"}})).statusCode,403);
});
await test("manager catalog edits preserve confidential costs and manager accounts remain owner controlled",async()=>{
 const safe=wire(product);safe.price=11;const saved=await json(route("/products/"+product.id),{cookie:managerCookie,method:"PUT",body:safe});noFinancial(saved);
 product=await db.query("SELECT data FROM myfin.products WHERE company_id=$1 AND id=$2",[co,product.id]).then(r=>r.rows[0].data);assert.equal(product.cost,77191.37);
 assert.equal((await request(route("/products/"+product.id),{cookie:managerCookie,method:"PUT",body:{...saved,cost:1}})).statusCode,403);
 assert.equal((await request("/users",{cookie:managerCookie,method:"POST",body:{username:"Forbidden manager",email:email("no-manager"),password,role:"company_admin",company_id:co}})).statusCode,403);
 assert.equal((await request("/users/"+manager+"/revoke-sessions",{cookie:managerCookie,method:"POST"})).statusCode,403);
 const staffRow=(await json("/users",{cookie:managerCookie})).find(u=>u.id===peer);assert.ok(staffRow);assert.ok(!(await json("/users",{cookie:managerCookie})).some(u=>u.role==="company_admin"));
 assert.equal((await request("/users/"+peer,{cookie:managerCookie,method:"PUT",body:{id:peer,username:"peer",email:email("peer"),role:"company_admin",company_id:co}})).statusCode,403);
 assert.equal((await request(route(""),{cookie:managerCookie,method:"PUT",body:{name:company.name,preferences:{staffDiscountLimit:50}}})).statusCode,403);
});
await test("draft ownership, explicit assignment and protected financial actions are enforced server-side",async()=>{
 quote=await json(route("/documents"),{cookie:staffCookie,method:"POST",body:doc()});noFinancial(quote);
 assert.equal((await json(route("/documents"),{cookie:peerCookie})).length,0);
 assert.equal((await request(route("/documents/"+quote.id),{cookie:peerCookie})).statusCode,404);
 for(const action of ["issue","convert","payments","void","corrections"])assert.equal((await request(route("/documents/"+quote.id+"/"+action),{cookie:staffCookie,method:"POST",body:action==="payments"?{amount:1,method:"Cash"}:{reason:"No privilege"}})).statusCode,403);
 assert.equal((await request(route("/documents"),{cookie:staffCookie,method:"POST",body:doc({assignedTo:peer})})).statusCode,403);
 quote=await json(route("/documents/"+quote.id),{cookie:managerCookie,method:"PUT",body:doc({version:quote.version,assignedTo:peer})});
 assert.equal((await json(route("/documents/"+quote.id),{cookie:peerCookie})).id,quote.id);
 assert.equal((await request(route("/documents/"+quote.id),{cookie:peerCookie,method:"PUT",body:doc({version:quote.version,assignedTo:""})})).statusCode,403);
 assert.equal((await request(route("/documents"),{cookie:staffCookie,method:"POST",body:doc({items:[{desc:"No cost write",qty:1,price:10,cost:1}]})})).statusCode,403);
 assert.equal((await request(route("/transactions"),{cookie:staffCookie,method:"POST",body:{type:"Invoice"}})).statusCode,403);
});
await test("published template versions and issued company/customer snapshots remain immutable",async()=>{
 const settings={...templateDefaults("Quote"),bankName:"Test Bank",accountName:"Shop",accountNumber:"TEST-001",terms:"Original terms"};
 template=await json(route("/templates"),{cookie:managerCookie,method:"POST",body:{name:"Quote layout",kind:"Quote",settings}});
 assert.equal((await json(route("/templates"),{cookie:staffCookie})).length,0);
 await json(route("/templates/"+template.id+"/publish"),{cookie:managerCookie,method:"POST",body:{version:1}});
 quote=await json(route("/documents/"+quote.id),{cookie:managerCookie,method:"PUT",body:doc({version:quote.version,templateId:template.id,assignedTo:peer})});
 issued=await json(route("/documents/"+quote.id+"/issue"),{cookie:managerCookie,method:"POST",body:{version:quote.version,expectedTemplateVersion:1}});
 assert.match(issued.number,/^QUO-\d{4}-\d{6}$/);assert.equal(issued.issuedSnapshot.number,issued.number);assert.equal(issued.issuedSnapshot.templateSnapshot.bankName,"Test Bank");
 assert.equal((await request(route("/documents/"+quote.id),{cookie:staffCookie})).statusCode,404);
 await json(route("/templates/"+template.id),{cookie:managerCookie,method:"PUT",body:{name:"New layout",version:1,settings:{...settings,terms:"Changed terms"}}});
 await json(route("/templates/"+template.id+"/publish"),{cookie:managerCookie,method:"POST",body:{version:2}});
 await json(route("/clients/"+customer.id),{cookie:managerCookie,method:"PUT",body:{...customer,name:"Changed customer"}});
 const reprint=await json(route("/documents/"+quote.id),{cookie:managerCookie});assert.equal(reprint.issuedSnapshot.templateSnapshot.terms,"Original terms");assert.equal(reprint.issuedSnapshot.clientSnapshot.name,"Customer");noFinancial(reprint);
 assert.equal((await request(route("/documents/"+quote.id),{cookie:managerCookie,method:"PUT",body:doc({version:quote.version})})).statusCode,409);
 await assert.rejects(db.query("UPDATE myfin.transactions SET total=1 WHERE company_id=$1 AND id=$2",[co,quote.id]),e=>e.code==="23514");
});
await test("concurrent numbering, quote conversion, cent-exact partial payments and status overlays",async()=>{
 const drafts=await Promise.all([1,2,3].map(i=>json(route("/documents"),{cookie:managerCookie,method:"POST",body:doc({type:"Invoice",items:[{desc:"Number test",qty:1,price:10.1}]})})));
 const numbers=await Promise.all(drafts.map(d=>json(route("/documents/"+d.id+"/issue"),{cookie:managerCookie,method:"POST",body:{version:d.version}})));assert.equal(new Set(numbers.map(d=>d.number)).size,3);
 const [conversion,repeat]=await Promise.all([1,2].map(()=>json(route("/documents/"+quote.id+"/convert"),{cookie:managerCookie,method:"POST"})));assert.equal(conversion.id,repeat.id);
 const invoice=await json(route("/documents/"+conversion.id+"/issue"),{cookie:managerCookie,method:"POST",body:{}});
 const first=await json(route("/documents/"+invoice.id+"/payments"),{cookie:managerCookie,method:"POST",body:{id:randomUUID(),amount:10,method:"Cash",date:today}});assert.equal(first.outstandingAmount,.1);
 const last=await json(route("/documents/"+invoice.id+"/payments"),{cookie:managerCookie,method:"POST",body:{id:randomUUID(),amount:.1,method:"Cash",date:today}});assert.equal(last.status,"Paid");assert.equal(last.outstandingAmount,0);assert.equal(buildDocumentViewModel(last).status,"Paid");assert.equal(last.issuedSnapshot.total,10.1);
 assert.equal((await request(route("/documents/"+invoice.id+"/void"),{cookie:managerCookie,method:"POST",body:{reason:"Not a refund"}})).statusCode,409);
 assert.equal((await request(route("/documents/"+invoice.id+"/corrections"),{cookie:managerCookie,method:"POST",body:{reason:"No credit ledger"}})).statusCode,409);
 const summary=await json(route("/reports/summary?from="+today+"&to="+today));assert.equal(summary.collected,10.1);assert.equal(summary.expenses,50);
});
await test("unpaid linked corrections preserve originals and only replace status after new issue",async()=>{
 const d=await json(route("/documents"),{cookie:managerCookie,method:"POST",body:doc({type:"Invoice"})});const old=await json(route("/documents/"+d.id+"/issue"),{cookie:managerCookie,method:"POST",body:{}});
 let correction=await json(route("/documents/"+d.id+"/corrections"),{cookie:managerCookie,method:"POST",body:{reason:"Correct line description"}});assert.equal((await json(route("/documents/"+d.id),{cookie:managerCookie})).documentState,"issued");
 correction=await json(route("/documents/"+correction.id),{cookie:managerCookie,method:"PUT",body:doc({type:"Invoice",version:correction.version,items:[{desc:"Corrected",qty:1,price:12}]})});
 const replacement=await json(route("/documents/"+correction.id+"/issue"),{cookie:managerCookie,method:"POST",body:{}});assert.equal(replacement.correctionOf,d.id);
 const retained=await json(route("/documents/"+d.id),{cookie:managerCookie});assert.equal(retained.documentState,"corrected");assert.deepEqual(retained.issuedSnapshot,old.issuedSnapshot);
});
await test("checkout retains exactly-once stock, own receipt scope and strips old queued costs",async()=>{
 const sale=intent();const [first,retry]=await Promise.all([1,2].map(()=>json(route("/checkout"),{cookie:staffCookie,method:"POST",body:sale})));assert.equal(first.id,retry.id);noFinancial(first);
 assert.equal((await db.query("SELECT stock FROM myfin.products WHERE company_id=$1 AND id=$2",[co,product.id])).rows[0].stock,"19.000");
 assert.equal((await request(route("/documents/"+sale.id),{cookie:peerCookie})).statusCode,404);
 const mine=await json(route("/transactions"),{cookie:staffCookie});assert.ok(mine.rows.some(x=>x.id===sale.id));noFinancial(mine);
 const others=await json(route("/transactions"),{cookie:peerCookie});assert.ok(!others.rows.some(x=>x.id===sale.id));
 const row=(await db.query("SELECT data FROM myfin.transactions WHERE company_id=$1 AND id=$2",[co,sale.id])).rows[0];assert.equal(row.data.items[0].cost,77191.37);
 const legacy=intent(undefined,{id:randomUUID()});const legacyData={...legacy,items:legacy.items.map(x=>({...x,cost:4444})),stockShortage:false};
 const crypto=await import("node:crypto");const canonical=await import("../../src/domain/pos.js");const original={...legacy,items:legacy.items.map(x=>({...x,cost:4444}))};
 await db.query("INSERT INTO myfin.transactions(company_id,id,actor_id,source,total,fingerprint,data) VALUES($1,$2,$3,'pos',$4,$5,$6)",[co,legacy.id,staff,legacy.total,crypto.createHash("sha256").update(JSON.stringify(canonical.canonical(original))).digest("hex"),legacyData]);
 noFinancial(await json(route("/checkout"),{cookie:staffCookie,method:"POST",body:legacy}));
 assert.equal((await db.query("SELECT stock FROM myfin.products WHERE company_id=$1 AND id=$2",[co,product.id])).rows[0].stock,"19.000");
 await assert.rejects(db.query("UPDATE myfin.transactions SET document_state='draft' WHERE company_id=$1 AND id=$2",[co,quote.id]),e=>e.code==="23514");
 assert.equal((await request(route("/assign-project"),{cookie:managerCookie,method:"POST",body:{ids:[sale.id],projectName:"Immutable"}})).statusCode,409);
});
await test("paid offline policy drift enters review and concurrent approvals post original intent once",async()=>{
 const sale=intent(undefined,{offline:true});sale.items[0].price=5;Object.assign(sale,{subtotal:5,discountAmount:0,tax:0,total:5,received:10000,change:9995});
 assert.equal((await request(route("/checkout"),{cookie:staffCookie,method:"POST",body:sale})).statusCode,409);
 assert.equal((await request(route("/receipt-reviews"),{cookie:peerCookie,method:"POST",body:{sale}})).statusCode,403);
 const review=await json(route("/receipt-reviews"),{cookie:staffCookie,method:"POST",body:{sale}});assert.equal(review.status,"pending");
 assert.equal((await request(route("/receipt-reviews/"+sale.id+"/approve"),{cookie:staffCookie,method:"POST",body:{reason:"Not manager"}})).statusCode,403);
 const approvals=await Promise.all([1,2].map(()=>json(route("/receipt-reviews/"+sale.id+"/approve"),{cookie:managerCookie,method:"POST",body:{reason:"Accept original paid offline price"}})));assert.equal(approvals[0].receipt.cashierId,staff);assert.equal(approvals[0].receipt.total,5);noFinancial(approvals);
 const receipt=await json(route("/checkout"),{cookie:staffCookie,method:"POST",body:sale});assert.equal(receipt.total,5);assert.equal(receipt.id,sale.id);
 assert.equal((await db.query("SELECT stock FROM myfin.products WHERE company_id=$1 AND id=$2",[co,product.id])).rows[0].stock,"18.000");
 assert.equal((await db.query("SELECT id FROM myfin.transactions WHERE company_id=$1 AND id=$2",[co,sale.id])).rowCount,1);
});
await test("separate tills serialize final stock and changed receipt payload never reposts",async()=>{
 const last=await json(route("/products"),{method:"POST",body:{name:"Last stock",sku:"LAST-"+tag,price:10,cost:3,stock:1,trackStock:true,variants:[]}});
 const results=await Promise.all([1,2].map(()=>request(route("/checkout"),{cookie:staffCookie,method:"POST",body:intent(last)})));assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
 assert.equal((await db.query("SELECT stock FROM myfin.products WHERE company_id=$1 AND id=$2",[co,last.id])).rows[0].stock,"0.000");
 const saved=results.find(r=>r.statusCode===200).json(),changed=wire(saved);delete changed.stockShortage;delete changed.company_id;changed.company_id=co;changed.total=1;
 assert.equal((await request(route("/checkout"),{cookie:staffCookie,method:"POST",body:changed})).statusCode,409);
});
await test("fractional variants and services preserve stock semantics",async()=>{
 const variant=await json(route("/products"),{method:"POST",body:{name:"Fractional",sku:"FRAC-"+tag,price:12,cost:3,stock:1.5,trackStock:true,variants:[{id:"v1",name:"Variant",sku:"V-"+tag,price:12,cost:3,stock:1.5}]}});
 const fractional=createSale({id:randomUUID(),items:[{...cartItem(variant,variant.variants[0]),qty:.25}],company,user:{uid:staff,username:"staff"},method:"Cash",received:10,confirmed:true});
 noFinancial(await json(route("/checkout"),{cookie:staffCookie,method:"POST",body:wire(fractional)}));
 assert.equal((await db.query("SELECT stock FROM myfin.product_variants WHERE company_id=$1 AND product_id=$2 AND id='v1'",[co,variant.id])).rows[0].stock,"1.250");
 const service=await json(route("/products"),{method:"POST",body:{name:"Service",sku:"SERVICE-"+tag,category:"Service",price:10,cost:3,stock:0,trackStock:false,variants:[]}});
 await json(route("/checkout"),{cookie:staffCookie,method:"POST",body:intent(service,{qty:2})});assert.equal((await db.query("SELECT stock FROM myfin.products WHERE company_id=$1 AND id=$2",[co,service.id])).rows[0].stock,"0.000");
});
await test("manager overrides require reason, supplier side effects denied, and receipt-template versions stay stable",async()=>{
 const receiptTemplate=await json(route("/templates"),{cookie:managerCookie,method:"POST",body:{name:"Receipt version",kind:"Receipt",settings:{...templateDefaults("Receipt"),footer:"Original receipt footer"}}});
 await json(route("/templates/"+receiptTemplate.id+"/publish"),{cookie:managerCookie,method:"POST",body:{version:1}});
 const captured=intent(undefined,{offline:true});captured.receiptTemplateId=receiptTemplate.id;captured.receiptTemplateVersion=1;
 await json(route("/templates/"+receiptTemplate.id),{cookie:managerCookie,method:"PUT",body:{name:"Receipt changed",version:1,settings:{...templateDefaults("Receipt"),footer:"Changed footer"}}});await json(route("/templates/"+receiptTemplate.id+"/publish"),{cookie:managerCookie,method:"POST",body:{version:2}});
 const saved=await json(route("/checkout"),{cookie:staffCookie,method:"POST",body:captured});assert.equal(saved.templateSnapshot.footer,"Original receipt footer");
 const override=intent(undefined,{user:manager});override.items[0].price=5;Object.assign(override,{subtotal:5,discountAmount:0,tax:0,total:5,change:9995});assert.equal((await request(route("/checkout"),{cookie:managerCookie,method:"POST",body:override})).statusCode,409);
 noFinancial(await json(route("/checkout"),{cookie:managerCookie,method:"POST",body:{...override,overrideReason:"Authorized price exception"}}));
 const supplierAttempt=intent();supplierAttempt.client_id=supplier.id;supplierAttempt.customerEmail="changed@myfin.test";assert.equal((await request(route("/checkout"),{cookie:staffCookie,method:"POST",body:supplierAttempt})).statusCode,403);
});
await test("private expense and historical file downloads reject nonowners over HTTP",async()=>{
 const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SgAAAABJRU5ErkJggg==","base64"),boundary="myfin"+tag;
 const upload=await request(route("/files/receipts"),{method:"POST",headers:{"content-type":"multipart/form-data; boundary="+boundary},body:Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt.png"\r\nContent-Type: image/png\r\n\r\n`),png,Buffer.from(`\r\n--${boundary}--\r\n`)])});assert.equal(upload.statusCode,200);const file=upload.json();
 await json(route("/expenses"),{method:"POST",body:{amount:3,date:today,description:"Private attachment",receiptPath:file.path,receiptUrl:file.url}});
 assert.equal((await request(file.url.slice(4))).statusCode,200);
 for(const cookie of [staffCookie,managerCookie]){assert.equal((await request(file.url.slice(4),{cookie})).statusCode,403);assert.equal((await request(route("/files/receipts"),{cookie,method:"POST"})).statusCode,403);}
});

await test("legacy nested confidential objects never escape public scalar projections",async()=>{
 const id="nested-"+tag;
 await db.query("INSERT INTO myfin.products(company_id,id,data,stock,price,cost) VALUES($1,$2,$3,0,1,77191.37)",[co,id,{id,name:"Nested fixture",price:1,cost:77191.37,description:{privateFinancial:77191.37},variants:[{id:"nested-v",name:"Variant",price:1,stock:0,cost:77191.37,sku:{costs:77191.37}}]}]);
 await db.query("UPDATE myfin.clients SET data=data||$3::jsonb WHERE company_id=$1 AND id=$2",[co,customer.id,{notes:{unitCost:77191.37}}]);
 await db.query("UPDATE myfin.companies SET data=jsonb_set(data,'{preferences,labels}',$2::jsonb) WHERE id=$1",[co,{invoice:"Invoice",privateFinancial:{cost:77191.37}}]);
 for(const cookie of [staffCookie,managerCookie])for(const path of [route("/products"),route("/clients"),"/companies"])noFinancial(await json(path,{cookie}));
});
await test("draft create retries deduplicate and Manager issuance above policy requires audited reason",async()=>{
 const body=doc({id:randomUUID(),discount:10});const [draft,retry]=await Promise.all([1,2].map(()=>json(route("/documents"),{cookie:staffCookie,method:"POST",body})));assert.equal(draft.id,retry.id);
 assert.equal((await db.query("SELECT id FROM myfin.document_events WHERE company_id=$1 AND document_id=$2 AND action='create_draft'",[co,draft.id])).rowCount,1);
 assert.equal((await request(route("/documents"),{cookie:staffCookie,method:"POST",body:{...body,notes:"Changed retry"}})).statusCode,409);
 assert.equal((await request(route("/documents/"+draft.id+"/issue"),{cookie:managerCookie,method:"POST",body:{version:draft.version}})).statusCode,409);
 const saved=await json(route("/documents/"+draft.id+"/issue"),{cookie:managerCookie,method:"POST",body:{version:draft.version,reason:"Approved customer discount"}});assert.equal(saved.discount,10);
 assert.equal((await db.query("SELECT details->>'reason' AS reason FROM myfin.document_events WHERE company_id=$1 AND document_id=$2 AND action='issue_document'",[co,draft.id])).rows[0].reason,"Approved customer discount");
 await assert.rejects(db.query("UPDATE myfin.transactions SET document_state='draft' WHERE company_id=$1 AND id=$2",[co,draft.id]),e=>e.code==="23514");
});
await test("catalog locks prevent a queued Manager from overwriting a concurrent owner cost change",async()=>{
 const p=await json(route("/products"),{method:"POST",body:{name:"Cost race",sku:"COST-"+tag,price:10,cost:3,stock:2,trackStock:true,variants:[]}});
 await admin.query("BEGIN");await admin.query("SELECT id FROM myfin.products WHERE company_id=$1 AND id=$2 FOR UPDATE",[co,p.id]);
 const future={...wire(p),version:p.version+1,price:12},pending=request(route("/products/"+p.id),{cookie:managerCookie,method:"PUT",body:future});
 try{let waiting=false;for(let i=0;i<100;i++){await admin.query("SELECT pg_stat_clear_snapshot()");const r=await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname='myfin_dev' AND wait_event_type='Lock' AND query LIKE 'SELECT data FROM myfin.products%' LIMIT 1");if(r.rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true,"Manager waits before confidential cost read");
 await admin.query("UPDATE myfin.products SET cost=19,version=version+1,data=jsonb_set(jsonb_set(data,'{cost}','19'::jsonb),'{version}',to_jsonb(version+1)) WHERE company_id=$1 AND id=$2",[co,p.id]);
 }finally{await admin.query("COMMIT");}
 const result=await pending;assert.equal(result.statusCode,200);noFinancial(result.json());const saved=(await db.query("SELECT cost,data FROM myfin.products WHERE company_id=$1 AND id=$2",[co,p.id])).rows[0];assert.equal(Number(saved.cost),19);assert.equal(saved.data.cost,19);
});
await test("late checkout failure rolls back transaction, customer update, stock and movement together",async()=>{
 const before=(await db.query("SELECT stock FROM myfin.products WHERE company_id=$1 AND id=$2",[co,product.id])).rows[0].stock;
 const sale=intent(undefined,{user:manager});sale.client_id=customer.id;sale.customerEmail="rollback@myfin.test";
 const oldClient=(await db.query("SELECT data FROM myfin.clients WHERE company_id=$1 AND id=$2",[co,customer.id])).rows[0].data;
 await db.query("INSERT INTO myfin.activities(company_id,id,actor_id,data) VALUES($1,$2,$3,$4)",[co,sale.id,manager,{action:"Synthetic late audit collision"}]);
 assert.equal((await request(route("/checkout"),{cookie:managerCookie,method:"POST",body:sale})).statusCode,409);
 assert.equal((await db.query("SELECT stock FROM myfin.products WHERE company_id=$1 AND id=$2",[co,product.id])).rows[0].stock,before);
 for(const table of ["transactions","stock_movements"])assert.equal((await db.query(`SELECT id FROM myfin.${table} WHERE company_id=$1 AND id=$2`,[co,sale.id])).rowCount,0);
 assert.deepEqual((await db.query("SELECT data FROM myfin.clients WHERE company_id=$1 AND id=$2",[co,customer.id])).rows[0].data,oldClient);
 const staffSale=intent();staffSale.client_id=customer.id;staffSale.customerEmail="receipt-only@myfin.test";assert.equal((await json(route("/checkout"),{cookie:staffCookie,method:"POST",body:staffSale})).customerEmail,staffSale.customerEmail);
 assert.deepEqual((await db.query("SELECT data FROM myfin.clients WHERE company_id=$1 AND id=$2",[co,customer.id])).rows[0].data,oldClient);
});
await test("pending paid intents stay immutable and preserve original merchant or missing catalog for review",async()=>{
 const sale=intent(undefined,{offline:true});sale.storeSnapshot.name="Previous merchant name";
 const review=await json(route("/receipt-reviews"),{cookie:staffCookie,method:"POST",body:{sale}});assert.equal(review.status,"pending");
 await assert.rejects(db.query("UPDATE myfin.receipt_reviews SET payload=payload||'{\"total\":1}'::jsonb WHERE company_id=$1 AND id=$2",[co,sale.id]),e=>e.code==="23514");
 const approved=await json(route("/receipt-reviews/"+sale.id+"/approve"),{cookie:managerCookie,method:"POST",body:{reason:"Preserve offline merchant snapshot"}});assert.equal(approved.receipt.storeSnapshot.name,"Previous merchant name");
 const lost=intent(undefined,{offline:true});lost.items[0].productId="deleted-product-"+tag;
 const pending=await json(route("/receipt-reviews"),{cookie:staffCookie,method:"POST",body:{sale:lost}});assert.equal(pending.status,"pending");assert.match(pending.reasonCode,/product_changed/);
 assert.equal((await request(route("/receipt-reviews/"+lost.id+"/approve"),{cookie:managerCookie,method:"POST",body:{reason:"Needs explicit catalog reconciliation"}})).statusCode,409);
 assert.equal((await db.query("SELECT payload FROM myfin.receipt_reviews WHERE company_id=$1 AND id=$2",[co,lost.id])).rows[0].payload.total,lost.total);
 assert.equal((await db.query("SELECT id FROM myfin.transactions WHERE company_id=$1 AND id=$2",[co,lost.id])).rowCount,0);
 const bad=intent();bad.receiptTemplateId=template.id;bad.receiptTemplateVersion=0;assert.equal((await request(route("/checkout"),{cookie:staffCookie,method:"POST",body:bad})).statusCode,400);
});
await test("issued snapshot assets survive branding changes and queued file requests reject revoked sessions",async()=>{
 const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SgAAAABJRU5ErkJggg==","base64"),boundary="branding"+tag;
 const up=await request(route("/files/products"),{method:"POST",headers:{"content-type":"multipart/form-data; boundary="+boundary},body:Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`),png,Buffer.from(`\r\n--${boundary}--\r\n`)])});assert.equal(up.statusCode,200);const file=up.json();
 await db.query("UPDATE myfin.companies SET data=data||$2::jsonb WHERE id=$1",[co,{logo:file.url}]);
 const d=await json(route("/documents"),{cookie:managerCookie,method:"POST",body:doc()});const issued=await json(route("/documents/"+d.id+"/issue"),{cookie:managerCookie,method:"POST",body:{}});assert.equal(issued.issuedSnapshot.companySnapshot.logo,file.url);
 await db.query("UPDATE myfin.companies SET data=data-'logo' WHERE id=$1",[co]);assert.equal((await request(file.url.slice(4),{method:"DELETE"})).statusCode,409);assert.equal((await request(file.url.slice(4),{cookie:managerCookie})).statusCode,200);
 const blocker=await db.pool.connect();await blocker.query("BEGIN");await blocker.query("SELECT pg_advisory_xact_lock(1297697102,4)");
 const pending=[request(file.url.slice(4),{cookie:managerCookie}),request(file.url.slice(4),{cookie:managerCookie,method:"DELETE"}),request(route("/files/products"),{cookie:managerCookie,method:"POST"})];
 try{let waiting=false;for(let i=0;i<100;i++){const r=await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname='myfin_dev' AND wait_event_type='Lock' AND wait_event='advisory'");if(r.rows[0].n>=3){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true,"all file operations reached current-session guard");await admin.query('DELETE FROM myfin.auth_session WHERE "userId"=$1',[manager]);}finally{await blocker.query("COMMIT");blocker.release();}
 for(const result of await Promise.all(pending))assert.equal(result.statusCode,401);
 managerCookie=await login("manager");
});

await test("authoritative default template identity prevents same-version preview drift",async()=>{
 const make=async(name,terms)=>json(route("/templates"),{cookie:managerCookie,method:"POST",body:{name,kind:"Invoice",settings:{...templateDefaults("Invoice"),terms}}});
 const first=await make("A invoice template","First layout terms"),last=await make("Z invoice template","Actual default terms");
 await json(route("/templates/"+first.id+"/publish"),{cookie:managerCookie,method:"POST",body:{version:1}});
 const pending=await json(route("/documents"),{cookie:managerCookie,method:"POST",body:doc({type:"Invoice"})});
 await json(route("/templates/"+last.id+"/publish"),{cookie:managerCookie,method:"POST",body:{version:1}});
 for(const cookie of [managerCookie,staffCookie]){const templates=await json(route("/templates"),{cookie}),a=templates.find(t=>t.id===first.id),b=templates.find(t=>t.id===last.id);assert.equal(a.publishedVersion,1);assert.equal(b.publishedVersion,1);assert.equal(a.isDefault,false);assert.equal(a.defaultVersion,null);assert.equal(b.isDefault,true);assert.equal(b.defaultVersion,1);assert.equal(templates.filter(t=>t.kind==="Invoice"&&t.isDefault).length,1);}
 const drift=await request(route("/documents/"+pending.id+"/issue"),{cookie:managerCookie,method:"POST",body:{version:pending.version,expectedTemplateId:first.id,expectedTemplateVersion:1}});assert.equal(drift.statusCode,409);assert.equal(drift.json().error,"template_changed");assert.equal((await json(route("/documents/"+pending.id),{cookie:managerCookie})).documentState,"draft");
 const issued=await json(route("/documents/"+pending.id+"/issue"),{cookie:managerCookie,method:"POST",body:{version:pending.version,expectedTemplateId:last.id,expectedTemplateVersion:1}});assert.equal(issued.issuedSnapshot.templateId,last.id);assert.equal(issued.issuedSnapshot.templateVersion,1);assert.equal(issued.issuedSnapshot.templateSnapshot.terms,"Actual default terms");
 const next=await json(route("/documents"),{cookie:managerCookie,method:"POST",body:doc({type:"Invoice"})});
 await json(route("/templates/"+last.id),{cookie:managerCookie,method:"PUT",body:{name:last.name,version:1,settings:{...templateDefaults("Invoice"),terms:"Next version"}}});await json(route("/templates/"+last.id+"/publish"),{cookie:managerCookie,method:"POST",body:{version:2}});
 assert.equal((await request(route("/documents/"+next.id+"/issue"),{cookie:managerCookie,method:"POST",body:{version:next.version,expectedTemplateId:last.id,expectedTemplateVersion:1}})).statusCode,409);
 const explicit=await json(route("/documents"),{cookie:managerCookie,method:"POST",body:doc({type:"Invoice",templateId:first.id})});const selected=await json(route("/documents/"+explicit.id+"/issue"),{cookie:managerCookie,method:"POST",body:{version:explicit.version,expectedTemplateId:first.id,expectedTemplateVersion:1}});assert.equal(selected.issuedSnapshot.templateId,first.id);assert.equal(selected.issuedSnapshot.templateSnapshot.terms,"First layout terms");
});
}finally{await app.close();await admin.end();}
