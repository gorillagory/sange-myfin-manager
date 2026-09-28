import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as v from "./validation.js";
import { managementLock,managementSession,requirePasswordSession } from "./management.js";
import { generatePosCode,protectPosCode } from "./pos-auth.js";

const slug=z.string().trim().toLowerCase().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const name=z.string().trim().min(1).max(160);

async function isSuper(c,who){return (await c.query("SELECT 1 FROM myfin.app_identities WHERE id=$1 AND is_super AND disabled_at IS NULL",[who.id])).rowCount>0;}
async function owns(c,who,workspaceId){if(await isSuper(c,who))return true;return (await c.query("SELECT 1 FROM myfin.workspace_memberships WHERE workspace_id=$1 AND identity_id=$2 AND suspended_at IS NULL",[workspaceId,who.id])).rowCount>0;}
async function requireOwner(c,who,workspaceId){if(!await owns(c,who,workspaceId))v.fail(403,"access_denied");}
const record=row=>({id:row.id,name:row.name,slug:row.slug,suspended:!!row.suspended_at,archived:!!row.archived_at,created_at:row.created_at});

function hostname(workspaceSlug,companySlug,rootDomain){
  if(!rootDomain)return "";const label=`${workspaceSlug}-${companySlug}`;
  if(label.length>63)v.fail(400,"combined_slug_too_long");return `${label}.${rootDomain}`;
}
async function setCanonicalHost(c,workspace,company,rootDomain){
  const next=hostname(workspace.slug,company.slug,rootDomain);if(!next)return "";
  const current=(await c.query("SELECT hostname FROM myfin.tenant_hosts WHERE company_id=$1 AND canonical AND disabled_at IS NULL FOR UPDATE",[company.id])).rows[0]?.hostname;
  if(current===next)return next;
  if(current)await c.query("UPDATE myfin.tenant_hosts SET canonical=false,redirect_to=$2 WHERE hostname=$1",[current,next]);
  await c.query(`INSERT INTO myfin.tenant_hosts(hostname,workspace_id,company_id,canonical,redirect_to)
    VALUES($1,$2,$3,true,NULL) ON CONFLICT(hostname) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,company_id=EXCLUDED.company_id,canonical=true,redirect_to=NULL,disabled_at=NULL`,[next,workspace.id,company.id]);
  return next;
}
async function revokeScopeSessions(c,workspaceId,companyId=null){
  if(companyId){await c.query("UPDATE myfin.pos_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE company_id=$1",[companyId]);
    await c.query("UPDATE myfin.app_sessions s SET revoked_at=coalesce(revoked_at,now()) WHERE s.identity_id IN (SELECT identity_id FROM myfin.memberships WHERE company_id=$1 UNION SELECT identity_id FROM myfin.workspace_memberships WHERE workspace_id=$2)",[companyId,workspaceId]);
    await c.query('DELETE FROM myfin.auth_session WHERE "userId" IN (SELECT identity_id FROM myfin.memberships WHERE company_id=$1 UNION SELECT identity_id FROM myfin.workspace_memberships WHERE workspace_id=$2)',[companyId,workspaceId]);return;}
  await c.query("UPDATE myfin.pos_sessions s SET revoked_at=coalesce(revoked_at,now()) FROM myfin.companies co WHERE co.workspace_id=$1 AND s.company_id=co.id",[workspaceId]);
  await c.query("UPDATE myfin.app_sessions s SET revoked_at=coalesce(revoked_at,now()) WHERE s.identity_id IN (SELECT identity_id FROM myfin.workspace_memberships WHERE workspace_id=$1 UNION SELECT m.identity_id FROM myfin.memberships m JOIN myfin.companies co ON co.id=m.company_id WHERE co.workspace_id=$1)",[workspaceId]);
  await c.query('DELETE FROM myfin.auth_session WHERE "userId" IN (SELECT identity_id FROM myfin.workspace_memberships WHERE workspace_id=$1 UNION SELECT m.identity_id FROM myfin.memberships m JOIN myfin.companies co ON co.id=m.company_id WHERE co.workspace_id=$1)',[workspaceId]);
}

export function registerWorkspaces(app,{db,authOptions,authorize,audit,validateFileRefs}){
  const scope=(req,fn)=>db.transaction(async c=>{requirePasswordSession(req);await managementLock(c);await managementSession(c,req);return fn(c,req.identity);});
  app.get("/api/workspaces",req=>scope(req,async(c,who)=>{
    const all=await isSuper(c,who);const r=await c.query(`SELECT w.* FROM myfin.workspaces w WHERE w.archived_at IS NULL AND
      ($1 OR EXISTS(SELECT 1 FROM myfin.workspace_memberships wm WHERE wm.workspace_id=w.id AND wm.identity_id=$2 AND wm.suspended_at IS NULL)
       OR EXISTS(SELECT 1 FROM myfin.companies co JOIN myfin.memberships m ON m.company_id=co.id WHERE co.workspace_id=w.id AND m.identity_id=$2))
      ORDER BY w.slug LIMIT 1001`,[all,who.id]);if(r.rowCount>1000)v.fail(409,"workspace_limit_exceeded");return r.rows.map(record);
  }));
  app.post("/api/workspaces",req=>scope(req,async(c,who)=>{
    if(!await isSuper(c,who))v.fail(403,"access_denied");const data=v.parse(z.strictObject({name,slug}),req.body),id=randomUUID();
    await c.query("INSERT INTO myfin.workspaces(id,name,slug) VALUES($1,$2,$3)",[id,data.name,data.slug]);
    await c.query("INSERT INTO myfin.workspace_memberships(workspace_id,identity_id,role) VALUES($1,$2,'workspace_owner')",[id,who.id]);
    return {id,...data};
  }));
  app.put("/api/workspaces/:workspace",req=>scope(req,async(c,who)=>{
    const id=v.parse(v.id,req.params.workspace);await requireOwner(c,who,id);const data=v.parse(z.strictObject({name,slug}),req.body);
    const old=(await c.query("SELECT * FROM myfin.workspaces WHERE id=$1 FOR UPDATE",[id])).rows[0];if(!old)v.fail(404,"not_found");
    await c.query("UPDATE myfin.workspaces SET name=$2,slug=$3,updated_at=now() WHERE id=$1",[id,data.name,data.slug]);
    if(old.slug!==data.slug&&authOptions.rootDomain){const companies=(await c.query("SELECT * FROM myfin.companies WHERE workspace_id=$1",[id])).rows;for(const company of companies)await setCanonicalHost(c,{id,slug:data.slug},company,authOptions.rootDomain);}
    return {id,...data};
  }));
  app.post("/api/workspaces/:workspace/suspend",req=>scope(req,async(c,who)=>{
    if(!await isSuper(c,who))v.fail(403,"access_denied");const id=v.parse(v.id,req.params.workspace),{suspended}=v.parse(z.strictObject({suspended:z.boolean()}),req.body);
    const r=await c.query("UPDATE myfin.workspaces SET suspended_at=CASE WHEN $2 THEN coalesce(suspended_at,now()) ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING id",[id,suspended]);if(!r.rowCount)v.fail(404,"not_found");await revokeScopeSessions(c,id);return {ok:true};
  }));
  app.get("/api/workspaces/:workspace/companies",req=>scope(req,async(c,who)=>{
    const id=v.parse(v.id,req.params.workspace);if(!await owns(c,who,id)&&!(await c.query("SELECT 1 FROM myfin.companies co JOIN myfin.memberships m ON m.company_id=co.id WHERE co.workspace_id=$1 AND m.identity_id=$2",[id,who.id])).rowCount)v.fail(403,"access_denied");
    const r=await c.query("SELECT c.*,(SELECT hostname FROM myfin.tenant_hosts h WHERE h.company_id=c.id AND h.canonical AND h.disabled_at IS NULL) AS hostname FROM myfin.companies c WHERE c.workspace_id=$1 AND c.archived_at IS NULL ORDER BY c.slug",[id]);return r.rows.map(x=>({...x.data,id:x.id,name:x.name,slug:x.slug,workspace_id:x.workspace_id,hostname:x.hostname||"",suspended:!!x.suspended_at}));
  }));
  app.post("/api/workspaces/:workspace/companies",req=>scope(req,async(c,who)=>{
    const workspaceId=v.parse(v.id,req.params.workspace);await requireOwner(c,who,workspaceId);
    const body=v.parse(z.strictObject({slug,company:v.company}),req.body),id=body.company.id||randomUUID();
    await validateFileRefs(c,id,body.company);const workspace=(await c.query("SELECT * FROM myfin.workspaces WHERE id=$1 AND archived_at IS NULL FOR UPDATE",[workspaceId])).rows[0];if(!workspace)v.fail(404,"not_found");
    await c.query("INSERT INTO myfin.companies(id,workspace_id,slug,name,data) VALUES($1,$2,$3,$4,$5)",[id,workspaceId,body.slug,body.company.name,body.company]);
    const host=await setCanonicalHost(c,workspace,{id,slug:body.slug},authOptions.rootDomain);await audit(c,who,id,"Create company",body.company.name);return {...body.company,id,workspace_id:workspaceId,slug:body.slug,hostname:host};
  }));
  app.put("/api/workspaces/:workspace/companies/:company/routing",req=>scope(req,async(c,who)=>{
    const workspaceId=v.parse(v.id,req.params.workspace),companyId=v.parse(v.id,req.params.company);await requireOwner(c,who,workspaceId);const {slug:nextSlug}=v.parse(z.strictObject({slug}),req.body);
    const workspace=(await c.query("SELECT * FROM myfin.workspaces WHERE id=$1 FOR UPDATE",[workspaceId])).rows[0],company=(await c.query("SELECT * FROM myfin.companies WHERE id=$1 AND workspace_id=$2 FOR UPDATE",[companyId,workspaceId])).rows[0];if(!workspace||!company)v.fail(404,"not_found");
    await c.query("UPDATE myfin.companies SET slug=$3 WHERE id=$1 AND workspace_id=$2",[companyId,workspaceId,nextSlug]);const host=await setCanonicalHost(c,workspace,{...company,slug:nextSlug},authOptions.rootDomain);return {id:companyId,slug:nextSlug,hostname:host};
  }));
  app.post("/api/companies/:company/suspend",req=>scope(req,async(c,who)=>{
    const companyId=v.parse(v.id,req.params.company),row=(await c.query("SELECT workspace_id FROM myfin.companies WHERE id=$1",[companyId])).rows[0];if(!row)v.fail(404,"not_found");await requireOwner(c,who,row.workspace_id);const {suspended}=v.parse(z.strictObject({suspended:z.boolean()}),req.body);
    await c.query("UPDATE myfin.companies SET suspended_at=CASE WHEN $2 THEN coalesce(suspended_at,now()) ELSE NULL END WHERE id=$1",[companyId,suspended]);await revokeScopeSessions(c,row.workspace_id,companyId);return {ok:true};
  }));
  app.post("/api/companies/:company/users/:user/pos-code",req=>scope(req,async(c,who)=>{
    if(!authOptions.pos)v.fail(503,"pos_code_unavailable");const companyId=v.parse(v.id,req.params.company),identityId=v.parse(v.id,req.params.user);await authorize(c,who,companyId,true);
    const target=(await c.query("SELECT role FROM myfin.memberships WHERE company_id=$1 AND identity_id=$2",[companyId,identityId])).rows[0];if(!target||!["manager","operator"].includes(target.role))v.fail(404,"not_found");if(who.role==="manager"&&target.role!=="operator")v.fail(403,"access_denied");
    let code,protectedCode;for(let i=0;i<20;i++){code=generatePosCode();protectedCode=await protectPosCode(authOptions.pos,companyId,code);if(!(await c.query("SELECT 1 FROM myfin.pos_access_codes WHERE company_id=$1 AND lookup_digest=$2 AND identity_id<>$3",[companyId,protectedCode.lookupDigest,identityId])).rowCount)break;code=null;}if(!code)v.fail(503,"pos_code_generation_failed");
    await c.query(`INSERT INTO myfin.pos_access_codes(company_id,identity_id,lookup_digest,salt,verifier,created_by)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(company_id,identity_id) DO UPDATE SET lookup_digest=EXCLUDED.lookup_digest,salt=EXCLUDED.salt,verifier=EXCLUDED.verifier,created_by=EXCLUDED.created_by,rotated_at=now(),disabled_at=NULL`,[companyId,identityId,protectedCode.lookupDigest,protectedCode.salt,protectedCode.verifier,who.id]);
    await c.query("UPDATE myfin.pos_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE company_id=$1 AND identity_id=$2",[companyId,identityId]);return {code};
  }));
  app.delete("/api/companies/:company/users/:user/pos-code",req=>scope(req,async(c,who)=>{
    const companyId=v.parse(v.id,req.params.company),identityId=v.parse(v.id,req.params.user);await authorize(c,who,companyId,true);const target=(await c.query("SELECT role FROM myfin.memberships WHERE company_id=$1 AND identity_id=$2",[companyId,identityId])).rows[0];if(!target)v.fail(404,"not_found");if(who.role==="manager"&&target.role!=="operator")v.fail(403,"access_denied");
    await c.query("UPDATE myfin.pos_access_codes SET disabled_at=coalesce(disabled_at,now()) WHERE company_id=$1 AND identity_id=$2",[companyId,identityId]);await c.query("UPDATE myfin.pos_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE company_id=$1 AND identity_id=$2",[companyId,identityId]);return {ok:true};
  }));
}
