import { randomUUID, createHmac } from "node:crypto";
import { z } from "zod";
import * as v from "./validation.js";
import { createIdentity } from "./auth.js";
import { owner,manager,publicCompany } from "./access.js";
import { publishedTemplate } from "./documents.js";
import { canonical } from "../../src/domain/pos.js";
import { registerReporting } from './reporting.js';

// All company and identity lifecycle writes take this lock before row locks.
// This makes last-administrator checks atomic and revalidates a waiting actor.
export async function managementLock(c) {
  await c.query("SELECT pg_advisory_xact_lock(1297697102,4)");
}
export async function managementSession(c, req) {
  if(req.authLevel==="pos_code"){
    const current=await c.query("SELECT 1 FROM myfin.pos_sessions WHERE token_digest=$1 AND identity_id=$2 AND company_id=$3 AND revoked_at IS NULL AND expires_at>now() FOR SHARE",[req.identity.posSessionDigest,req.identity.id,req.identity.company_id]);
    if(!current.rowCount)v.fail(401,"session_required");
    return;
  }
  if(req.authLevel==="handoff_password"){
    const current=await c.query("SELECT 1 FROM myfin.app_sessions WHERE token_digest=$1 AND identity_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE",[req.identity.handoffSessionDigest,req.identity.id]);
    if(!current.rowCount)v.fail(401,"session_required");return;
  }
  const current = await c.query('SELECT id FROM myfin.auth_session WHERE id=$1 AND "userId"=$2 AND "expiresAt">now() FOR SHARE',[req.authSessionId,req.identity.id]);
  if(!current.rowCount)v.fail(401,"session_required");
}
export function requirePasswordSession(req){if(!["password","handoff_password"].includes(req.authLevel))v.fail(403,"password_reauthentication_required");}
const userSelect = `SELECT i.id,coalesce(i.display_name,u.name,'') AS username,
  coalesce(u.email,'') AS email,i.disabled_at IS NOT NULL AS disabled,i.created_at,
  EXISTS(SELECT 1 FROM myfin.auth_account a WHERE a."userId"=i.id AND a."providerId"='credential' AND length(a.password)>0) AS login_available,
  CASE WHEN i.is_super THEN 'super_admin'
       WHEN EXISTS(SELECT 1 FROM myfin.workspace_memberships wm WHERE wm.identity_id=i.id AND wm.suspended_at IS NULL) THEN 'workspace_owner'
       ELSE coalesce((SELECT m.role FROM myfin.memberships m WHERE m.identity_id=i.id ORDER BY m.company_id LIMIT 1),'operator') END AS role,
  coalesce((SELECT m.company_id FROM myfin.memberships m WHERE m.identity_id=i.id ORDER BY m.company_id LIMIT 1),'') AS company_id,
  coalesce((SELECT wm.workspace_id FROM myfin.workspace_memberships wm WHERE wm.identity_id=i.id AND wm.suspended_at IS NULL ORDER BY wm.workspace_id LIMIT 1),'') AS workspace_id,
  coalesce((SELECT jsonb_agg(jsonb_build_object('company_id',m.company_id,'role',m.role) ORDER BY m.company_id) FROM myfin.memberships m WHERE m.identity_id=i.id),'[]') AS assignments,
  coalesce((SELECT jsonb_agg(wm.workspace_id ORDER BY wm.workspace_id) FROM myfin.workspace_memberships wm WHERE wm.identity_id=i.id AND wm.suspended_at IS NULL),'[]') AS workspace_ids
  FROM myfin.app_identities i LEFT JOIN myfin.auth_user u ON u.id=i.id`;
const companyRecord = r => ({ ...r.data, id:r.id, name:r.name,
  archived:!!r.archived_at, archived_at:r.archived_at, created_at:r.created_at });
async function userRecord(c, id) {
  return (await c.query(userSelect+" WHERE i.id=$1",[id])).rows[0];
}
async function managementEvent(c, who, action, subjectId, companyId = null, details = {}) {
  await c.query(`INSERT INTO myfin.management_events(id,actor_id,company_id,subject_id,action,details)
    VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(),who.id,companyId || null,subjectId,action,details]);
}
const administrator = z.discriminatedUnion("mode",[
  z.strictObject({mode:z.literal("self")}),
  z.strictObject({mode:z.literal("new"),user:z.strictObject({
    username:z.string().trim().min(1).max(120),email:z.email().max(254).transform(x=>x.toLowerCase()),
    password:z.string().min(12).max(128)
  })}),
  z.strictObject({mode:z.literal("existing"),userId:v.id})
]);
const routeSlug=value=>String(value||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,54)||"workspace";
const routeSlugSchema=z.string().trim().toLowerCase().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const enrollment = z.strictObject({enrollmentId:z.uuid(),company:v.company,companySlug:routeSlugSchema.optional(),workspace:z.strictObject({name:z.string().trim().min(1).max(160),slug:routeSlugSchema}).optional(),administrator});

export function registerManagement(app,{db,authOptions,authorize,requireSuper,validateFileRefs,audit}) {
  const managed = (req, fn) => db.transaction(async c => {
    requirePasswordSession(req);
    await managementLock(c);
    await managementSession(c,req);
    const stored=await userRecord(c,req.identity.id),who=stored?{...stored,role:req.identity.role,company_id:req.identity.company_id,workspace_id:req.identity.workspace_id}:null;
    if(!who || who.disabled) v.fail(401,"session_required");
    return fn(c,who);
  });
  registerReporting(app, { db, managed, authorize, managementSession });
  const superOnly = async(c,who) => {
    if(who.role!=="super_admin")v.fail(403,"access_denied");
    await requireSuper(c,who);
  };
  const workspaceOwnerOnly=async(c,who,workspaceId)=>{
    if(who.role==="super_admin")return requireSuper(c,who);
    const r=await c.query("SELECT 1 FROM myfin.workspace_memberships WHERE workspace_id=$1 AND identity_id=$2 AND suspended_at IS NULL",[workspaceId,who.id]);
    if(!r.rowCount)v.fail(403,"access_denied");
  };
  app.get("/api/companies",req=>managed(req,async(c,who)=>{
    const query=v.parse(z.strictObject({includeArchived:z.enum(["true","false"]).optional()}),req.query);
    const archived=query.includeArchived==="true";
    if(archived && who.role!=="super_admin")v.fail(403,"access_denied");
    const r=await c.query(`SELECT c.*,w.name AS workspace_name,w.slug AS workspace_slug,
      (SELECT hostname FROM myfin.tenant_hosts h WHERE h.company_id=c.id AND h.canonical AND h.disabled_at IS NULL) AS hostname
      FROM myfin.companies c JOIN myfin.workspaces w ON w.id=c.workspace_id WHERE ($3 OR c.archived_at IS NULL)
      AND ($1 OR EXISTS(SELECT 1 FROM myfin.workspace_memberships wm WHERE wm.workspace_id=c.workspace_id AND wm.identity_id=$2 AND wm.suspended_at IS NULL)
        OR EXISTS(SELECT 1 FROM myfin.memberships m WHERE m.company_id=c.id AND m.identity_id=$2))
      ORDER BY c.id LIMIT 1001`,[who.role==="super_admin",who.id,archived]);
    if(r.rowCount>1000)v.fail(409,"company_limit_exceeded");
    // The active legacy list stays editable without metadata projection.
    return Promise.all(r.rows.map(async row=>{const template=await publishedTemplate(c,row.id,"Receipt");return publicCompany({...row.data,id:row.id,name:row.name,workspace_id:row.workspace_id,workspace_name:row.workspace_name,workspace_slug:row.workspace_slug,slug:row.slug,hostname:row.hostname||"",suspended:!!row.suspended_at,...(archived?{archived:!!row.archived_at,archived_at:row.archived_at,created_at:row.created_at}:{}),receiptTemplate:{id:template.template_id||"",version:template.version,settings:template.settings}},who);}));
}));
  app.post("/api/companies/enroll",req=>managed(req,async(c,who)=>{
    await superOnly(c,who);
    const data=v.parse(enrollment,req.body);
    if(!authOptions?.secret)v.fail(503,"enrollment_unavailable");
    const digest=createHmac("sha256",authOptions.secret).update("myfin-company-enrollment-v1:")
      .update(JSON.stringify(canonical(data))).digest("hex");
    const previous=await c.query("SELECT actor_id,request_digest,result FROM myfin.company_enrollments WHERE enrollment_id=$1",[data.enrollmentId]);
    if(previous.rowCount){
      if(previous.rows[0].actor_id!==who.id || previous.rows[0].request_digest!==digest)v.fail(409,"enrollment_payload_changed");
      return previous.rows[0].result;
    }
    const co=data.company.id || randomUUID();
    const workspaceId=randomUUID();let workspaceSlug=data.workspace?.slug||routeSlug(data.company.name),companySlug=data.companySlug||routeSlug(data.company.name);
    if((await c.query("SELECT 1 FROM myfin.workspaces WHERE slug=$1",[workspaceSlug])).rowCount)workspaceSlug+=`-${workspaceId.replaceAll("-","").slice(0,8)}`;
    await validateFileRefs(c,co,data.company);
    await c.query("INSERT INTO myfin.workspaces(id,name,slug,data) VALUES($1,$2,$3,$4)",[workspaceId,data.workspace?.name||data.company.name,workspaceSlug,{enrollment:true}]);
    await c.query("INSERT INTO myfin.companies(id,workspace_id,slug,name,data) VALUES($1,$2,$3,$4,$5)",[co,workspaceId,companySlug,data.company.name,data.company]);
    let canonicalHostname="";
    if(authOptions.rootDomain){const label=`${workspaceSlug}-${companySlug}`;if(label.length>63)v.fail(400,"combined_slug_too_long");canonicalHostname=`${label}.${authOptions.rootDomain}`;await c.query("INSERT INTO myfin.tenant_hosts(hostname,workspace_id,company_id,canonical) VALUES($1,$2,$3,true)",[canonicalHostname,workspaceId,co]);}
    let admin=null;
    if(data.administrator.mode==="new"){
      const uid=await createIdentity(c,{...data.administrator.user,role:"manager",company_id:co});
      await c.query("INSERT INTO myfin.workspace_memberships(workspace_id,identity_id,role) VALUES($1,$2,'workspace_owner')",[workspaceId,uid]);
      admin=await userRecord(c,uid);
      await managementEvent(c,who,"create_user",uid,co,{role:"workspace_owner",disabled:false});
    } else if(data.administrator.mode==="existing"){
      const uid=data.administrator.userId;
      const target=await userRecord(c,uid);
      if(!target || !target.login_available || target.disabled || target.role==="super_admin" || target.assignments.length || target.workspace_ids.length)v.fail(409,"administrator_not_eligible");
      await c.query("INSERT INTO myfin.memberships(company_id,identity_id,role) VALUES($1,$2,'manager')",[co,uid]);
      await c.query("INSERT INTO myfin.workspace_memberships(workspace_id,identity_id,role) VALUES($1,$2,'workspace_owner')",[workspaceId,uid]);
      await c.query('DELETE FROM myfin.auth_session WHERE "userId"=$1',[uid]);
      admin=await userRecord(c,uid);
      await managementEvent(c,who,"assign_workspace_owner",uid,co,{role:"workspace_owner"});
    }
    const result={workspace:{id:workspaceId,name:data.workspace?.name||data.company.name,slug:workspaceSlug},company:{...data.company,id:co,workspace_id:workspaceId,slug:companySlug,hostname:canonicalHostname},administrator:admin};
    await c.query(`INSERT INTO myfin.company_enrollments(enrollment_id,actor_id,company_id,request_digest,result)
      VALUES($1,$2,$3,$4,$5)`,[data.enrollmentId,who.id,co,digest,result]);
    await audit(c,who,co,"Enroll company",data.company.name);
    await managementEvent(c,who,"enroll_company",co,co,{mode:data.administrator.mode,administratorId:admin?.id || null});
    return result;
  }));
  app.post("/api/companies",req=>managed(req,async(c,who)=>{
    await superOnly(c,who);
    const data=v.parse(v.company,req.body),id=data.id || randomUUID(),workspaceId=randomUUID();let slug=routeSlug(data.name);
    if((await c.query("SELECT 1 FROM myfin.workspaces WHERE slug=$1",[slug])).rowCount)slug+=`-${workspaceId.replaceAll("-","").slice(0,8)}`;
    await validateFileRefs(c,id,data);
    await c.query("INSERT INTO myfin.workspaces(id,name,slug,data) VALUES($1,$2,$3,$4)",[workspaceId,data.name,slug,{legacyEnrollment:true}]);
    await c.query("INSERT INTO myfin.companies(id,workspace_id,slug,name,data) VALUES($1,$2,$3,$4,$5)",[id,workspaceId,slug,data.name,data]);
    await audit(c,who,id,"Create company",data.name);
    await managementEvent(c,who,"create_company",id,id);
    return {...data,id,workspace_id:workspaceId,slug};
  }));
  app.put("/api/companies/:company",req=>managed(req,async(c,who)=>{
    const id=v.parse(v.id,req.params.company),data=v.parse(v.company,req.body);
    await authorize(c,who,id,true);
    if(!owner(who)){
      const current=(await c.query("SELECT data FROM myfin.companies WHERE id=$1",[id])).rows[0].data;
      const protectedPreferences=["currency","tax","taxRate","staffDiscountLimit","fiscalYearStart","invoiceNumbering"];
      if(JSON.stringify(data.integrations||{})!==JSON.stringify(current.integrations||{}))v.fail(403,"owner_integration_settings_required");
      for(const key of protectedPreferences)if(data.preferences?.[key]!==undefined&&JSON.stringify(data.preferences[key])!==JSON.stringify(current.preferences?.[key]))v.fail(403,"owner_financial_settings_required");
      data.integrations=current.integrations;
      data.preferences={...data.preferences,...Object.fromEntries(protectedPreferences.filter(key=>current.preferences?.[key]!==undefined).map(key=>[key,current.preferences[key]]))};
    }
    if(data.id && data.id!==id)v.fail(400,"invalid_id");
    await validateFileRefs(c,id,data);
    await c.query("UPDATE myfin.companies SET name=$2,data=$3 WHERE id=$1",[id,data.name,data]);
    await audit(c,who,id,"Update company",data.name);
    await managementEvent(c,who,"update_company",id,id);
    return {...data,id};
  }));
  app.delete("/api/companies/:company",req=>managed(req,async(c,who)=>{
    const co=v.parse(v.id,req.params.company);
    const r=await c.query("SELECT archived_at,workspace_id FROM myfin.companies WHERE id=$1 FOR UPDATE",[co]);
    if(!r.rowCount)v.fail(404,"not_found");
    await workspaceOwnerOnly(c,who,r.rows[0].workspace_id);
    if(r.rows[0].archived_at)return {ok:true};
    await c.query("UPDATE myfin.companies SET archived_at=now() WHERE id=$1",[co]);
    await c.query('DELETE FROM myfin.auth_session WHERE "userId" IN (SELECT identity_id FROM myfin.memberships WHERE company_id=$1 UNION SELECT identity_id FROM myfin.workspace_memberships WHERE workspace_id=$2)',[co,r.rows[0].workspace_id]);
    await c.query("UPDATE myfin.app_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE identity_id IN (SELECT identity_id FROM myfin.memberships WHERE company_id=$1 UNION SELECT identity_id FROM myfin.workspace_memberships WHERE workspace_id=$2)",[co,r.rows[0].workspace_id]);
    await c.query("UPDATE myfin.pos_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE company_id=$1",[co]);
    await audit(c,who,co,"Archive company",co);
    await managementEvent(c,who,"archive_company",co,co);
    return {ok:true};
  }));
  app.post("/api/companies/:company/restore",req=>managed(req,async(c,who)=>{
    const co=v.parse(v.id,req.params.company);
    const r=await c.query("SELECT archived_at,workspace_id FROM myfin.companies WHERE id=$1 FOR UPDATE",[co]);
    if(!r.rowCount)v.fail(404,"not_found");
    await workspaceOwnerOnly(c,who,r.rows[0].workspace_id);
    if(!r.rows[0].archived_at)return {ok:true};
    await c.query("UPDATE myfin.companies SET archived_at=NULL WHERE id=$1",[co]);
    // Clear even sessions opened while archived; access starts with a fresh login.
    await c.query('DELETE FROM myfin.auth_session WHERE "userId" IN (SELECT identity_id FROM myfin.memberships WHERE company_id=$1 UNION SELECT identity_id FROM myfin.workspace_memberships WHERE workspace_id=$2)',[co,r.rows[0].workspace_id]);
    await c.query("UPDATE myfin.app_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE identity_id IN (SELECT identity_id FROM myfin.memberships WHERE company_id=$1 UNION SELECT identity_id FROM myfin.workspace_memberships WHERE workspace_id=$2)",[co,r.rows[0].workspace_id]);
    await audit(c,who,co,"Restore company",co);
    await managementEvent(c,who,"restore_company",co,co);
    return {ok:true};
  }));
  app.get("/api/users",req=>managed(req,async(c,who)=>{
    if(!["super_admin","workspace_owner","manager"].includes(who.role))return [];
    if(who.role==="manager")await authorize(c,who,who.company_id,true);
    const r=await c.query(userSelect+` WHERE $1
      OR ($2='workspace_owner' AND (EXISTS(SELECT 1 FROM myfin.workspace_memberships tw WHERE tw.identity_id=i.id AND tw.workspace_id=$4)
        OR EXISTS(SELECT 1 FROM myfin.memberships tm JOIN myfin.companies tc ON tc.id=tm.company_id WHERE tm.identity_id=i.id AND tc.workspace_id=$4)))
      OR ($2='manager' AND EXISTS(SELECT 1 FROM myfin.memberships tm WHERE tm.identity_id=i.id AND tm.company_id=$3 AND tm.role='operator'))
      ORDER BY i.id LIMIT 1001`,[who.role==="super_admin",who.role,who.company_id,who.workspace_id]);
    if(r.rowCount>1000)v.fail(409,"user_limit_exceeded");
    return r.rows;
}));
  const normalizeRole=role=>({super:"super_admin",company_admin:"manager",company_user:"operator"}[role]||role);
  const desired=data=>{
    const role=normalizeRole(data.role),assignments=(data.assignments?.length?data.assignments:(data.company_id&&["manager","operator"].includes(role)?[{company_id:data.company_id,role}]:[])).map(x=>({...x,role:normalizeRole(x.role)}));
    if(new Set(assignments.map(x=>x.company_id)).size!==assignments.length)v.fail(400,"duplicate_company_assignment");
    return {role,assignments,workspace_id:data.workspace_id||""};
  };
  async function actorWorkspace(c,who){
    if(who.role!=="workspace_owner")return "";
    const id=who.workspace_id||(await c.query("SELECT workspace_id FROM myfin.workspace_memberships WHERE identity_id=$1 AND suspended_at IS NULL ORDER BY workspace_id LIMIT 1",[who.id])).rows[0]?.workspace_id;
    if(!id)v.fail(403,"access_denied");return id;
  }
  async function manageTarget(c,who,targetId){
    if(!["super_admin","workspace_owner","manager"].includes(who.role))v.fail(403,"access_denied");
    if(who.role==="super_admin")await requireSuper(c,who);
    else if(who.role==="manager")await authorize(c,who,who.company_id,true);
    if(targetId===who.id)v.fail(403,"use_self_profile");
    if(!targetId)return null;
    const target=await userRecord(c,targetId);
    if(!target)v.fail(404,"not_found");
    if(who.role==="manager"&&!target.assignments.some(x=>x.company_id===who.company_id&&x.role==="operator"))v.fail(403,"access_denied");
    if(who.role==="workspace_owner"){
      const workspaceId=await actorWorkspace(c,who);
      const visible=(await c.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM myfin.workspace_memberships WHERE identity_id=$1 AND workspace_id=$2)
        OR EXISTS(SELECT 1 FROM myfin.memberships m JOIN myfin.companies co ON co.id=m.company_id WHERE m.identity_id=$1 AND co.workspace_id=$2)`,[targetId,workspaceId])).rowCount;
      if(!visible)v.fail(403,"access_denied");
    }
    return target;
  }
  async function protectAdministrators(c,target,next,scopeWorkspace=""){
    if(target.disabled)return;
    if(target.role==="super_admin" && (next.disabled || next.role!=="super_admin")){
      const r=await c.query("SELECT count(*)::int AS n FROM myfin.app_identities WHERE is_super AND disabled_at IS NULL AND id<>$1",[target.id]);
      if(!r.rows[0].n)v.fail(409,"last_active_super");
    }
    for(const workspaceId of target.workspace_ids.filter(id=>!scopeWorkspace||id===scopeWorkspace)){
      if(next.disabled||next.role!=="workspace_owner"||next.workspace_id!==workspaceId){const r=await c.query(`SELECT count(*)::int AS n FROM myfin.workspace_memberships wm JOIN myfin.app_identities i ON i.id=wm.identity_id
        WHERE wm.workspace_id=$1 AND wm.suspended_at IS NULL AND i.disabled_at IS NULL AND i.id<>$2`,[workspaceId,target.id]);if(!r.rows[0].n)v.fail(409,"last_active_workspace_owner");}
    }
  }
  async function validateDesired(c,who,data,target=null){
    const next=desired(data);if(next.role==="super_admin"&&(next.workspace_id||next.assignments.length))v.fail(400,"super_scope_not_allowed");
    if(next.role==="workspace_owner"&&!next.workspace_id)v.fail(400,"workspace_required");
    if(["manager","operator"].includes(next.role)&&!next.assignments.length)v.fail(400,"company_assignment_required");
    for(const assignment of next.assignments){if(!["manager","operator"].includes(assignment.role))v.fail(400,"invalid_role");const row=(await c.query("SELECT workspace_id FROM myfin.companies WHERE id=$1 AND archived_at IS NULL",[assignment.company_id])).rows[0];if(!row)v.fail(400,"invalid_company");assignment.workspace_id=row.workspace_id;}
    if(who.role==="manager"&&(next.role!=="operator"||next.workspace_id||next.assignments.some(x=>x.company_id!==who.company_id||x.role!=="operator")))v.fail(403,"access_denied");
    if(who.role==="workspace_owner"){
      const workspaceId=await actorWorkspace(c,who);if(next.role==="super_admin"||(next.role==="workspace_owner"&&next.workspace_id!==workspaceId)||next.assignments.some(x=>x.workspace_id!==workspaceId))v.fail(403,"access_denied");
    }
    return next;
  }
  async function writeAssignments(c,who,id,next){
    if(who.role==="super_admin"){await c.query("DELETE FROM myfin.memberships WHERE identity_id=$1",[id]);await c.query("DELETE FROM myfin.workspace_memberships WHERE identity_id=$1",[id]);}
    else if(who.role==="workspace_owner"){
      const workspaceId=await actorWorkspace(c,who);await c.query("DELETE FROM myfin.memberships m USING myfin.companies co WHERE m.identity_id=$1 AND m.company_id=co.id AND co.workspace_id=$2",[id,workspaceId]);await c.query("DELETE FROM myfin.workspace_memberships WHERE identity_id=$1 AND workspace_id=$2",[id,workspaceId]);
    }else await c.query("DELETE FROM myfin.memberships WHERE identity_id=$1 AND company_id=$2",[id,who.company_id]);
    if(next.role==="workspace_owner")await c.query("INSERT INTO myfin.workspace_memberships(workspace_id,identity_id,role) VALUES($1,$2,'workspace_owner') ON CONFLICT(workspace_id,identity_id) DO UPDATE SET suspended_at=NULL",[next.workspace_id,id]);
    for(const assignment of next.assignments)await c.query("INSERT INTO myfin.memberships(company_id,identity_id,role) VALUES($1,$2,$3) ON CONFLICT(company_id,identity_id) DO UPDATE SET role=EXCLUDED.role",[assignment.company_id,id,assignment.role]);
  }
  const manage=(req,remove=false)=>managed(req,async(c,who)=>{
    const targetId=req.params.id?v.parse(v.id,req.params.id):null;
    const target=await manageTarget(c,who,targetId);
    const data=remove?null:v.parse(v.user,req.body);
    if(data?.id && data.id!==targetId)v.fail(400,"invalid_id");
    if(target && data?.password)v.fail(400,"use_password_reauthentication");
    const next=data?await validateDesired(c,who,data,target):null;
    if(!target){
      if(!data.password)v.fail(400,"password_required");
      const first=next.assignments[0],id=await createIdentity(c,{...data,role:next.role==="super_admin"?"super_admin":next.role==="workspace_owner"?"workspace_owner":first.role,company_id:first?.company_id||"",workspace_id:next.workspace_id});
      await writeAssignments(c,who,id,next);
      await managementEvent(c,who,"create_user",id,first?.company_id||null,{role:next.role,assignments:next.assignments.map(x=>({companyId:x.company_id,role:x.role})),disabled:!!data.disabled});
      for(const co of next.assignments.map(x=>x.company_id))await audit(c,who,co,"Create user",data.username);
      return {id};
    }
    if(data && data.email.toLowerCase()!==target.email.toLowerCase())v.fail(400,"email_change_not_supported");
    const updated=remove?{...target,disabled:true}:{...next,disabled:data.disabled ?? target.disabled};
    await protectAdministrators(c,target,updated,who.role==="workspace_owner"?await actorWorkspace(c,who):"");
    if(remove){
      await c.query("UPDATE myfin.app_identities SET disabled_at=coalesce(disabled_at,now()) WHERE id=$1",[targetId]);
    }else{
      await c.query("UPDATE myfin.app_identities SET display_name=$2,is_super=$3,disabled_at=CASE WHEN $4 THEN coalesce(disabled_at,now()) ELSE NULL END WHERE id=$1",[targetId,data.username,next.role==="super_admin",updated.disabled]);
      await c.query('UPDATE myfin.auth_user SET name=$2,"updatedAt"=now() WHERE id=$1',[targetId,data.username]);
      await writeAssignments(c,who,targetId,next);
    }
    await c.query('DELETE FROM myfin.auth_session WHERE "userId"=$1',[targetId]);
    await c.query("UPDATE myfin.app_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE identity_id=$1",[targetId]);
    await c.query("UPDATE myfin.pos_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE identity_id=$1",[targetId]);
    const action=remove || (!target.disabled && updated.disabled)?"suspend_user":target.disabled && !updated.disabled?"restore_user":"update_user";
    await managementEvent(c,who,action,targetId,updated.assignments?.[0]?.company_id||target.company_id||null,{before:{role:target.role,assignments:target.assignments,disabled:target.disabled},after:{role:updated.role,assignments:updated.assignments,disabled:updated.disabled}});
    for(const co of new Set([...(target.assignments||[]).map(x=>x.company_id),...(updated.assignments||[]).map(x=>x.company_id)]))await audit(c,who,co,action.replaceAll("_"," "),updated.username||target.username);
    return {ok:true};
  });
  app.post("/api/users",req=>manage(req));
  app.put("/api/users/:id",req=>manage(req));
  app.delete("/api/users/:id",req=>manage(req,true));
  app.post("/api/users/:id/revoke-sessions",req=>managed(req,async(c,who)=>{
    const targetId=v.parse(v.id,req.params.id),target=await manageTarget(c,who,targetId);
    await c.query('DELETE FROM myfin.auth_session WHERE "userId"=$1',[targetId]);
    await c.query("UPDATE myfin.app_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE identity_id=$1",[targetId]);
    await c.query("UPDATE myfin.pos_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE identity_id=$1",[targetId]);
    await managementEvent(c,who,"revoke_sessions",targetId,target.company_id);
    if(target.company_id)await audit(c,who,target.company_id,"Revoke sessions",target.username);
    return {ok:true};
  }));
}
