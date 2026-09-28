import { randomUUID, createHmac } from "node:crypto";
import { z } from "zod";
import * as v from "./validation.js";
import { createIdentity } from "./auth.js";
import { owner,publicCompany } from "./access.js";
import { publishedTemplate } from "./documents.js";
import { canonical } from "../../src/domain/pos.js";

// All company and identity lifecycle writes take this lock before row locks.
// This makes last-administrator checks atomic and revalidates a waiting actor.
export async function managementLock(c) {
  await c.query("SELECT pg_advisory_xact_lock(1297697102,4)");
}
export async function managementSession(c, req) {
  const current = await c.query('SELECT id FROM myfin.auth_session WHERE id=$1 AND "userId"=$2 AND "expiresAt">now() FOR SHARE',[req.authSessionId,req.identity.id]);
  if(!current.rowCount)v.fail(401,"session_required");
}
const userSelect = `SELECT i.id,coalesce(i.display_name,u.name,'') AS username,
  coalesce(u.email,'') AS email,i.disabled_at IS NOT NULL AS disabled,i.created_at,
  EXISTS(SELECT 1 FROM myfin.auth_account a WHERE a."userId"=i.id AND a."providerId"='credential' AND length(a.password)>0) AS login_available,
  CASE WHEN i.is_super THEN 'super' ELSE m.role END AS role,
  coalesce(m.company_id,'') AS company_id
  FROM myfin.app_identities i LEFT JOIN myfin.auth_user u ON u.id=i.id
  LEFT JOIN myfin.memberships m ON m.identity_id=i.id`;
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
const enrollment = z.strictObject({enrollmentId:z.uuid(),company:v.company,administrator});

export function registerManagement(app,{db,authOptions,authorize,requireSuper,validateFileRefs,audit}) {
  const managed = (req, fn) => db.transaction(async c => {
    await managementLock(c);
    await managementSession(c,req);
    const who=await userRecord(c,req.identity.id);
    if(!who || who.disabled) v.fail(401,"session_required");
    return fn(c,who);
  });
  const superOnly = async(c,who) => {
    if(who.role!=="super")v.fail(403,"access_denied");
    await requireSuper(c,who);
  };
  app.get("/api/companies",req=>managed(req,async(c,who)=>{
    const query=v.parse(z.strictObject({includeArchived:z.enum(["true","false"]).optional()}),req.query);
    const archived=query.includeArchived==="true";
    if(archived && who.role!=="super")v.fail(403,"access_denied");
    const r=await c.query(`SELECT c.* FROM myfin.companies c WHERE ($3 OR c.archived_at IS NULL)
      AND ($1 OR EXISTS(SELECT 1 FROM myfin.memberships m WHERE m.company_id=c.id AND m.identity_id=$2))
      ORDER BY c.id LIMIT 1001`,[who.role==="super",who.id,archived]);
    if(r.rowCount>1000)v.fail(409,"company_limit_exceeded");
    // The active legacy list stays editable without metadata projection.
    return Promise.all(r.rows.map(async row=>{const template=await publishedTemplate(c,row.id,"Receipt");return publicCompany({...row.data,id:row.id,name:row.name,...(archived?{archived:!!row.archived_at,archived_at:row.archived_at,created_at:row.created_at}:{}),receiptTemplate:{id:template.template_id||"",version:template.version,settings:template.settings}},who);}));
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
    await validateFileRefs(c,co,data.company);
    await c.query("INSERT INTO myfin.companies(id,name,data) VALUES($1,$2,$3)",[co,data.company.name,data.company]);
    let admin=null;
    if(data.administrator.mode==="new"){
      const uid=await createIdentity(c,{...data.administrator.user,role:"company_admin",company_id:co});
      admin=await userRecord(c,uid);
      await managementEvent(c,who,"create_user",uid,co,{role:"company_admin",disabled:false});
    } else if(data.administrator.mode==="existing"){
      const uid=data.administrator.userId;
      const target=await userRecord(c,uid);
      if(!target || !target.login_available || target.disabled || target.role==="super" || target.company_id)v.fail(409,"administrator_not_eligible");
      await c.query("INSERT INTO myfin.memberships(company_id,identity_id,role) VALUES($1,$2,'company_admin')",[co,uid]);
      await c.query('DELETE FROM myfin.auth_session WHERE "userId"=$1',[uid]);
      admin=await userRecord(c,uid);
      await managementEvent(c,who,"assign_company_administrator",uid,co,{role:"company_admin"});
    }
    const result={company:{...data.company,id:co},administrator:admin};
    await c.query(`INSERT INTO myfin.company_enrollments(enrollment_id,actor_id,company_id,request_digest,result)
      VALUES($1,$2,$3,$4,$5)`,[data.enrollmentId,who.id,co,digest,result]);
    await audit(c,who,co,"Enroll company",data.company.name);
    await managementEvent(c,who,"enroll_company",co,co,{mode:data.administrator.mode,administratorId:admin?.id || null});
    return result;
  }));
  app.post("/api/companies",req=>managed(req,async(c,who)=>{
    await superOnly(c,who);
    const data=v.parse(v.company,req.body),id=data.id || randomUUID();
    await validateFileRefs(c,id,data);
    await c.query("INSERT INTO myfin.companies(id,name,data) VALUES($1,$2,$3)",[id,data.name,data]);
    await audit(c,who,id,"Create company",data.name);
    await managementEvent(c,who,"create_company",id,id);
    return {...data,id};
  }));
  app.put("/api/companies/:company",req=>managed(req,async(c,who)=>{
    const id=v.parse(v.id,req.params.company),data=v.parse(v.company,req.body);
    await authorize(c,who,id,true);
    if(!owner(who)){
      const current=(await c.query("SELECT data FROM myfin.companies WHERE id=$1",[id])).rows[0].data;
      const oldLimit=Number(current.preferences?.staffDiscountLimit||0);
      if(data.preferences?.staffDiscountLimit!==undefined&&Number(data.preferences.staffDiscountLimit)!==oldLimit)v.fail(403,"owner_discount_policy_required");
      data.preferences={...data.preferences,staffDiscountLimit:oldLimit};
    }
    if(data.id && data.id!==id)v.fail(400,"invalid_id");
    await validateFileRefs(c,id,data);
    await c.query("UPDATE myfin.companies SET name=$2,data=$3 WHERE id=$1",[id,data.name,data]);
    await audit(c,who,id,"Update company",data.name);
    await managementEvent(c,who,"update_company",id,id);
    return {...data,id};
  }));
  app.delete("/api/companies/:company",req=>managed(req,async(c,who)=>{
    await superOnly(c,who);
    const co=v.parse(v.id,req.params.company);
    const r=await c.query("SELECT archived_at FROM myfin.companies WHERE id=$1 FOR UPDATE",[co]);
    if(!r.rowCount)v.fail(404,"not_found");
    if(r.rows[0].archived_at)return {ok:true};
    await c.query("UPDATE myfin.companies SET archived_at=now() WHERE id=$1",[co]);
    await c.query('DELETE FROM myfin.auth_session WHERE "userId" IN (SELECT identity_id FROM myfin.memberships WHERE company_id=$1)',[co]);
    await audit(c,who,co,"Archive company",co);
    await managementEvent(c,who,"archive_company",co,co);
    return {ok:true};
  }));
  app.post("/api/companies/:company/restore",req=>managed(req,async(c,who)=>{
    await superOnly(c,who);
    const co=v.parse(v.id,req.params.company);
    const r=await c.query("SELECT archived_at FROM myfin.companies WHERE id=$1 FOR UPDATE",[co]);
    if(!r.rowCount)v.fail(404,"not_found");
    if(!r.rows[0].archived_at)return {ok:true};
    await c.query("UPDATE myfin.companies SET archived_at=NULL WHERE id=$1",[co]);
    // Clear even sessions opened while archived; access starts with a fresh login.
    await c.query('DELETE FROM myfin.auth_session WHERE "userId" IN (SELECT identity_id FROM myfin.memberships WHERE company_id=$1)',[co]);
    await audit(c,who,co,"Restore company",co);
    await managementEvent(c,who,"restore_company",co,co);
    return {ok:true};
  }));
  app.get("/api/users",req=>managed(req,async(c,who)=>{
    if(!["super","company_admin"].includes(who.role))return [];
    if(who.role!=="super")await authorize(c,who,who.company_id,true);
    const r=await c.query(userSelect+" WHERE $1 OR (m.company_id=$2 AND NOT i.is_super AND m.role='company_user') ORDER BY i.id LIMIT 1001",[who.role==="super",who.company_id]);
    if(r.rowCount>1000)v.fail(409,"user_limit_exceeded");
    return r.rows;
}));
  async function manageTarget(c,who,targetId){
    if(!["super","company_admin"].includes(who.role))v.fail(403,"access_denied");
    if(who.role==="super")await requireSuper(c,who);
    else await authorize(c,who,who.company_id,true);
    if(targetId===who.id)v.fail(403,"use_self_profile");
    if(!targetId)return null;
    const target=await userRecord(c,targetId);
    if(!target)v.fail(404,"not_found");
    if(who.role!=="super" && (target.role!=="company_user" || !target.company_id || target.company_id!==who.company_id))v.fail(403,"access_denied");
    return target;
  }
  async function protectAdministrators(c,target,next){
    if(target.disabled)return;
    if(target.role==="super" && (next.disabled || next.role!=="super")){
      const r=await c.query("SELECT count(*)::int AS n FROM myfin.app_identities WHERE is_super AND disabled_at IS NULL AND id<>$1",[target.id]);
      if(!r.rows[0].n)v.fail(409,"last_active_super");
    }
    if(target.role==="company_admin" && (next.disabled || next.role!=="company_admin" || next.company_id!==target.company_id)){
      const active=await c.query("SELECT id FROM myfin.companies WHERE id=$1 AND archived_at IS NULL",[target.company_id]);
      if(!active.rowCount)return;
      const r=await c.query(`SELECT count(*)::int AS n FROM myfin.memberships m JOIN myfin.app_identities i ON i.id=m.identity_id
        WHERE m.company_id=$1 AND m.role='company_admin' AND i.disabled_at IS NULL AND i.id<>$2`,[target.company_id,target.id]);
      if(!r.rows[0].n)v.fail(409,"last_active_company_admin");
    }
  }
  const manage=(req,remove=false)=>managed(req,async(c,who)=>{
    const targetId=req.params.id?v.parse(v.id,req.params.id):null;
    const target=await manageTarget(c,who,targetId);
    const data=remove?null:v.parse(v.user,req.body);
    if(data?.id && data.id!==targetId)v.fail(400,"invalid_id");
    if(target && data?.password)v.fail(400,"use_password_reauthentication");
    if(data && who.role!=="super" && (data.role!=="company_user" || data.company_id!==who.company_id))v.fail(403,"access_denied");
    if(data?.role!=="super" && data)await authorize(c,who,data.company_id,true);
    if(data?.role==="super" && data.company_id)v.fail(400,"super_company_not_allowed");
    if(!target){
      if(!data.password)v.fail(400,"password_required");
      const id=await createIdentity(c,data);
      await managementEvent(c,who,"create_user",id,data.company_id,{role:data.role,disabled:!!data.disabled});
      if(data.company_id)await audit(c,who,data.company_id,"Create user",data.username);
      return {id};
    }
    if(data && data.email.toLowerCase()!==target.email.toLowerCase())v.fail(400,"email_change_not_supported");
    const next=remove?{...target,disabled:true}:{...data,disabled:data.disabled ?? target.disabled};
    await protectAdministrators(c,target,next);
    if(remove){
      await c.query("UPDATE myfin.app_identities SET disabled_at=coalesce(disabled_at,now()) WHERE id=$1",[targetId]);
    }else{
      await c.query("UPDATE myfin.app_identities SET display_name=$2,is_super=$3,disabled_at=CASE WHEN $4 THEN coalesce(disabled_at,now()) ELSE NULL END WHERE id=$1",[targetId,data.username,data.role==="super",next.disabled]);
      await c.query('UPDATE myfin.auth_user SET name=$2,"updatedAt"=now() WHERE id=$1',[targetId,data.username]);
      await c.query("DELETE FROM myfin.memberships WHERE identity_id=$1",[targetId]);
      if(data.role!=="super")await c.query("INSERT INTO myfin.memberships(company_id,identity_id,role) VALUES($1,$2,$3)",[data.company_id,targetId,data.role]);
    }
    await c.query('DELETE FROM myfin.auth_session WHERE "userId"=$1',[targetId]);
    const action=remove || (!target.disabled && next.disabled)?"suspend_user":target.disabled && !next.disabled?"restore_user":"update_user";
    await managementEvent(c,who,action,targetId,next.company_id,{before:{role:target.role,companyId:target.company_id,disabled:target.disabled},after:{role:next.role,companyId:next.company_id,disabled:next.disabled}});
    for(const co of new Set([target.company_id,next.company_id].filter(Boolean)))await audit(c,who,co,action.replaceAll("_"," "),next.username);
    return {ok:true};
  });
  app.post("/api/users",req=>manage(req));
  app.put("/api/users/:id",req=>manage(req));
  app.delete("/api/users/:id",req=>manage(req,true));
  app.post("/api/users/:id/revoke-sessions",req=>managed(req,async(c,who)=>{
    const targetId=v.parse(v.id,req.params.id),target=await manageTarget(c,who,targetId);
    await c.query('DELETE FROM myfin.auth_session WHERE "userId"=$1',[targetId]);
    await managementEvent(c,who,"revoke_sessions",targetId,target.company_id);
    if(target.company_id)await audit(c,who,target.company_id,"Revoke sessions",target.username);
    return {ok:true};
  }));
}
