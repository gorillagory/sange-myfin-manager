// Mutating fixtures are forbidden except this disposable, independently marked cluster.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/database.js";
import { authConfig,createAuth,createIdentity } from "../src/auth.js";
import { buildApp } from "../src/app.js";
const phase05=process.env.MYFIN_ISOLATED_ACCEPTANCE === "myfin-phase05-pg-20260913";
const marker=phase05?"myfin-phase05-pg-20260913":"myfin-phase04-pg-20260912",cfg=loadConfig();
if(process.env.MYFIN_ISOLATED_ACCEPTANCE!==marker || cfg.database.host!=="127.0.0.1" || cfg.database.port!==(phase05?25435:25434) || cfg.database.database!=="myfin_dev" || !process.env.MYFIN_TEST_PRIVATE)throw Error("unsafe_management_test_target");
const admin=new pg.Client({...cfg.database,user:"postgres",password:(await readFile(process.env.MYFIN_TEST_PRIVATE+"/admin.secret","utf8")).trim()});
await admin.connect();
assert.equal((await admin.query("SHOW cluster_name")).rows[0].cluster_name,marker,"cluster marker before mutations");
const db=createDatabase(cfg.database),authOptions=authConfig(),auth=createAuth(db.pool,authOptions);
const app=buildApp({database:db,authOptions,auth,uploadDir:process.env.UPLOAD_DIR});
const password=(await readFile(process.env.MYFIN_TEST_PRIVATE+"/seed.secret","utf8")).trim(),tag=randomUUID().slice(0,8);
const email=key=>`${key}-${tag}@myfin.test`;
let root,rootCookie,company,manager,managerCookie,staff,staffCookie,secondManager;
async function request(path,{cookie=rootCookie,method="GET",body,origin=authOptions.origin}={}){
 return app.inject({url:"/api"+path,method,headers:{...(cookie?{cookie}:{}),...(origin?{origin}:{})},...(body===undefined?{}:{payload:body})});
}
async function json(path,options){const r=await request(path,options);assert.equal(r.statusCode,200,`${path}: ${r.statusCode}`);return r.json();}
async function login(address){const r=await request("/auth/sign-in/email",{cookie:null,method:"POST",body:{email:address,password}});assert.equal(r.statusCode,200,"login");const cookies=r.headers["set-cookie"];return (Array.isArray(cookies)?cookies:[cookies]).map(c=>c.split(";")[0]).join("; ");}
async function create(key,role,co,disabled=false){return (await json("/users",{method:"POST",body:{username:key,email:email(key),password,role,company_id:co,disabled}})).id;}
async function getUser(id){return (await json("/users")).find(u=>u.id===id);}
async function update(id,patch={}){const old=await getUser(id);return request("/users/"+id,{method:"PUT",body:{id,username:old.username,email:old.email,role:old.role,company_id:old.company_id,...patch}});}
try{
await test("atomic enrollment creates company and first manager with private idempotent receipt",async()=>{
 root=await db.transaction(c=>createIdentity(c,{username:"Management root",email:email("root"),password,role:"super",company_id:""}));
 rootCookie=await login(email("root"));
 const body={enrollmentId:randomUUID(),company:{name:"Management acceptance",preferences:{currency:"RM",taxRate:0}},administrator:{mode:"new",user:{username:"Manager",email:email("manager"),password}}};
 const [first,retry]=await Promise.all([json("/companies/enroll",{method:"POST",body}),json("/companies/enroll",{method:"POST",body})]);
 assert.deepEqual(first,retry);company=first.company.id;manager=first.administrator.id;assert.equal(first.administrator.role,"company_admin");
 assert.equal((await db.query("SELECT count(*)::int AS n FROM myfin.company_enrollments WHERE enrollment_id=$1",[body.enrollmentId])).rows[0].n,1);
 assert.equal((await request("/companies/enroll",{method:"POST",body:{...body,administrator:{...body.administrator,user:{...body.administrator.user,password:password+"x"}}}})).statusCode,409);
 const receipt=(await db.query("SELECT result,request_digest FROM myfin.company_enrollments WHERE enrollment_id=$1",[body.enrollmentId])).rows[0];
 assert.equal(receipt.request_digest.length,64);assert.ok(!JSON.stringify(receipt).includes(password));assert.ok(!JSON.stringify(receipt.result).includes("password"));
 const rollbackId="rollback-"+tag;
 assert.equal((await request("/companies/enroll",{method:"POST",body:{...body,enrollmentId:randomUUID(),company:{id:rollbackId,name:"Rollback"}}})).statusCode,409);
 assert.equal((await db.query("SELECT id FROM myfin.companies WHERE id=$1",[rollbackId])).rowCount,0);
 managerCookie=await login(email("manager"));
 assert.equal((await request("/companies/enroll",{cookie:managerCookie,method:"POST",body:{...body,enrollmentId:randomUUID()}})).statusCode,403);
 assert.equal((await request("/companies/enroll",{method:"POST",origin:null,body})).statusCode,403);
});
await test("self-managed enrollment and explicit existing administrator never move assigned users",async()=>{
 const self=await json("/companies/enroll",{method:"POST",body:{enrollmentId:randomUUID(),company:{name:"Owner-managed"},administrator:{mode:"self"}}});
 assert.equal(self.administrator,null);
 assert.equal((await db.query("SELECT identity_id FROM myfin.memberships WHERE company_id=$1",[self.company.id])).rowCount,0);
 const unassigned=await db.transaction(async c=>{
   const uid=await createIdentity(c,{username:"Unassigned",email:email("unassigned"),password,role:"super",company_id:""});
   await c.query("UPDATE myfin.app_identities SET is_super=false WHERE id=$1",[uid]);return uid;
 });
 const existing=await json("/companies/enroll",{method:"POST",body:{enrollmentId:randomUUID(),company:{name:"Existing admin"},administrator:{mode:"existing",userId:unassigned}}});
 assert.equal(existing.administrator.id,unassigned);assert.equal(existing.administrator.role,"company_admin");
 const badCo="not-moved-"+tag;
 assert.equal((await request("/companies/enroll",{method:"POST",body:{enrollmentId:randomUUID(),company:{id:badCo,name:"Must rollback"},administrator:{mode:"existing",userId:manager}}})).statusCode,409);
 assert.equal((await db.query("SELECT id FROM myfin.companies WHERE id=$1",[badCo])).rowCount,0);
 assert.equal((await getUser(manager)).company_id,company);
 const historical=await db.transaction(async c=>{
   const uid=await createIdentity(c,{username:"Historical metadata",email:email("historical"),password,role:"super",company_id:""});
   await c.query("UPDATE myfin.app_identities SET is_super=false WHERE id=$1",[uid]);
   await c.query('DELETE FROM myfin.auth_account WHERE "userId"=$1',[uid]);return uid;
 });
 assert.equal((await getUser(historical)).login_available,false);
 assert.equal((await request("/companies/enroll",{method:"POST",body:{enrollmentId:randomUUID(),company:{name:"No credentials"},administrator:{mode:"existing",userId:historical}}})).statusCode,409);
});
await test("suspend retains assignment, omitted status cannot reactivate, and restore needs fresh login",async()=>{
 staff=await create("staff","company_user",company);staffCookie=await login(email("staff"));
 const disabled=await create("disabled","company_user",company,true);
 assert.equal((await getUser(disabled)).disabled,true);
 assert.ok((await request("/auth/sign-in/email",{cookie:null,method:"POST",body:{email:email("disabled"),password}})).statusCode>=400);
 assert.equal((await request("/users/"+staff,{cookie:managerCookie,method:"DELETE"})).statusCode,200);
 const visible=(await json("/users",{cookie:managerCookie})).find(u=>u.id===staff);
 assert.equal(visible.disabled,true);assert.equal(visible.company_id,company);assert.equal(visible.role,"company_user");
 assert.equal((await request("/me",{cookie:staffCookie})).statusCode,401);
 assert.equal((await update(staff,{username:"Preserved suspension"})).statusCode,200);
 assert.equal((await getUser(staff)).disabled,true);
 assert.equal((await update(staff,{disabled:false,username:"Restored staff"})).statusCode,200);
 assert.equal((await request("/me",{cookie:staffCookie})).statusCode,401);
 staffCookie=await login(email("staff"));
 assert.equal((await json("/me",{cookie:staffCookie})).username,"Restored staff");
 assert.equal((await db.query("SELECT name FROM myfin.auth_user WHERE id=$1",[staff])).rows[0].name,"Restored staff");
 assert.equal((await update(staff,{email:email("changed")})).statusCode,400);
 assert.equal((await getUser(staff)).email,email("staff"));
});
await test("company archive preserves history and memberships; restored staff reauthenticate",async()=>{
 const before=(await db.query("SELECT identity_id,role FROM myfin.memberships WHERE company_id=$1 ORDER BY identity_id",[company])).rows;
 assert.equal((await request("/companies/"+company,{method:"DELETE"})).statusCode,200);
 assert.deepEqual((await db.query("SELECT identity_id,role FROM myfin.memberships WHERE company_id=$1 ORDER BY identity_id",[company])).rows,before);
 assert.ok(!(await json("/companies")).some(c=>c.id===company));
 assert.equal((await json("/companies?includeArchived=true")).find(c=>c.id===company).archived,true);
 assert.equal((await request("/companies/"+company+"/products")).statusCode,404);
 assert.equal((await request("/me",{cookie:staffCookie})).statusCode,401);
 assert.ok((await request("/auth/sign-in/email",{cookie:null,method:"POST",body:{email:email("staff"),password}})).statusCode>=400);
 assert.equal((await request("/companies/"+company+"/restore",{method:"POST"})).statusCode,200);
 assert.equal((await request("/me",{cookie:staffCookie})).statusCode,401);
 staffCookie=await login(email("staff"));managerCookie=await login(email("manager"));
 assert.equal((await json("/companies",{cookie:staffCookie}))[0].id,company);
 assert.equal((await request("/companies?includeArchived=true",{cookie:managerCookie})).statusCode,403);
});
await test("session revocation and lifecycle scope checks reject staff, cross-company and self edits",async()=>{
 const other=await json("/companies/enroll",{method:"POST",body:{enrollmentId:randomUUID(),company:{name:"Other scope"},administrator:{mode:"self"}}});
 const outsider=await create("outsider","company_user",other.company.id);
 assert.equal((await request("/users/"+outsider+"/revoke-sessions",{cookie:managerCookie,method:"POST"})).statusCode,403);
 assert.equal((await request("/users/"+manager+"/revoke-sessions",{cookie:staffCookie,method:"POST"})).statusCode,403);
 assert.equal((await request("/users/"+root,{method:"DELETE"})).statusCode,403);
 assert.equal((await request("/users/"+staff+"/revoke-sessions",{cookie:managerCookie,method:"POST"})).statusCode,200);
 assert.equal((await request("/me",{cookie:staffCookie})).statusCode,401);
 assert.equal((await getUser(staff)).disabled,false);
 assert.equal((await request("/companies/"+other.company.id+"/restore",{cookie:managerCookie,method:"POST"})).statusCode,403);
});
await test("a management request waiting for the lifecycle lock cannot use a revoked session",async()=>{
 const blocker=await db.pool.connect();
 await blocker.query("BEGIN");await blocker.query("SELECT pg_advisory_xact_lock(1297697102,4)");
 const pending=request("/companies/"+company,{cookie:managerCookie,method:"PUT",body:{name:"Must not change after revocation"}});
 try{
  let waiting=false;
  for(let i=0;i<100;i++){
   const row=await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname='myfin_dev' AND wait_event_type='Lock' AND wait_event='advisory' LIMIT 1");
   if(row.rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(waiting,true,"request reached the serialized management boundary");
  await admin.query('DELETE FROM myfin.auth_session WHERE "userId"=$1',[manager]);
 }finally{await blocker.query("COMMIT");blocker.release();}
 assert.equal((await pending).statusCode,401);
 assert.equal((await db.query("SELECT name FROM myfin.companies WHERE id=$1",[company])).rows[0].name,"Management acceptance");
});
await test("queued directory reads recheck current role and reject a revoked session",async()=>{
 const reader=root,readerCookie=rootCookie;
 managerCookie=await login(email("manager"));
 const blocker=await db.pool.connect();await blocker.query("BEGIN");await blocker.query("SELECT pg_advisory_xact_lock(1297697102,4)");
 const users=request("/users",{cookie:readerCookie});
 const companies=request("/companies?includeArchived=true",{cookie:readerCookie});
 const revoked=request("/users",{cookie:managerCookie});
 try{
  let waiting=false;
  for(let i=0;i<100;i++){
   const r=await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname='myfin_dev' AND wait_event_type='Lock' AND wait_event='advisory'");
   if(r.rows[0].n>=3){waiting=true;break;}await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(waiting,true,"all directory requests reached lifecycle lock");
  // Change only privilege here to prove list SQL cannot reuse the earlier super snapshot.
  // The separate request also exercises real session revocation while queued.
  await admin.query("UPDATE myfin.app_identities SET is_super=false WHERE id=$1",[reader]);
  await admin.query("INSERT INTO myfin.memberships(company_id,identity_id,role) VALUES($1,$2,'company_user')",[company,reader]);
  await admin.query('DELETE FROM myfin.auth_session WHERE "userId"=$1',[manager]);
 }finally{await blocker.query("COMMIT");blocker.release();}
 const [userResult,companyResult,revokedResult]=await Promise.all([users,companies,revoked]);
 // Restore only this disposable fixture's original privilege after queued reads finish.
 await admin.query("DELETE FROM myfin.memberships WHERE identity_id=$1",[root]);
 await admin.query("UPDATE myfin.app_identities SET is_super=true WHERE id=$1",[root]);
 assert.equal(userResult.statusCode,200);assert.deepEqual(userResult.json(),[]);
 assert.equal(companyResult.statusCode,403);
 assert.equal(revokedResult.statusCode,401);
});
await test("concurrent lifecycle requests cannot remove the final active manager",async()=>{
 secondManager=await create("second-manager","company_admin",company);
 const results=await Promise.all([manager,secondManager].map(id=>request("/users/"+id,{method:"DELETE"})));
 assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
 const remaining=(await db.query(`SELECT count(*)::int AS n FROM myfin.memberships m JOIN myfin.app_identities i ON i.id=m.identity_id WHERE m.company_id=$1 AND m.role='company_admin' AND i.disabled_at IS NULL`,[company])).rows[0].n;
 assert.equal(remaining,1);
 const active=(await json("/users")).find(u=>u.company_id===company && u.role==="company_admin" && !u.disabled);
 assert.equal((await update(active.id,{role:"company_user"})).statusCode,409);
});
await test("management audit and enrollment receipts are redacted and append-only to runtime",async()=>{
 const rows=(await db.query("SELECT action,details FROM myfin.management_events WHERE actor_id=$1",[root])).rows;
 for(const action of ["enroll_company","suspend_user","restore_user","archive_company","restore_company"])assert.ok(rows.some(r=>r.action===action));
 assert.ok(!JSON.stringify(rows).includes(password));
 for(const table of ["management_events","company_enrollments"]){
  const grants=(await db.query("SELECT has_table_privilege(current_user,$1,'UPDATE') AS u,has_table_privilege(current_user,$1,'DELETE') AS d",["myfin."+table])).rows[0];
  assert.equal(grants.u,false);assert.equal(grants.d,false);
 }
});
await test("serialized super changes revalidate a waiting actor instead of honoring stale privilege",async()=>{
 const second=await create("second-super","super","");
 const secondCookie=await login(email("second-super"));
 const results=await Promise.all([request("/users/"+second,{method:"DELETE"}),request("/users/"+root,{cookie:secondCookie,method:"DELETE"})]);
 assert.equal(results.filter(r=>r.statusCode===200).length,1);
 assert.ok(results.some(r=>[401,403].includes(r.statusCode)));
 const remaining=(await db.query("SELECT count(*)::int AS n FROM myfin.app_identities WHERE id=ANY($1::text[]) AND is_super AND disabled_at IS NULL",[[root,second]])).rows[0].n;
 assert.equal(remaining,1);
});
}finally{await app.close();await admin.end();}
