import { createHmac,randomBytes } from "node:crypto";
import { z } from "zod";
import * as v from "./validation.js";
import { requestHostname } from "./tenancy.js";

const cookieName="myfin.handoff_session";
const digest=(secret,purpose,host,token)=>createHmac("sha256",secret).update(`myfin:${purpose}:v1\0${host}\0${token}`).digest("hex");
const readCookie=req=>{for(const part of String(req.headers.cookie||"").split(";")){const [name,...value]=part.trim().split("=");if(name===cookieName)return decodeURIComponent(value.join("="));}return "";};
const setCookie=(token,secure)=>`${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure?"; Secure":""}; Max-Age=28800`;
const clearCookie=secure=>`${cookieName}=; Path=/; HttpOnly; SameSite=Lax${secure?"; Secure":""}; Max-Age=0`;

export async function handoffSubject(db,req,options){
  const token=readCookie(req),host=requestHostname(req);if(!token||!host)return null;
  const tokenDigest=digest(options.secret,"handoff-session",host,token);
  const row=(await db.query(`SELECT s.identity_id FROM myfin.app_sessions s JOIN myfin.app_identities i ON i.id=s.identity_id
    WHERE s.token_digest=$1 AND s.hostname=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND i.disabled_at IS NULL`,[tokenDigest,host])).rows[0];
  return row?{subject:row.identity_id,digest:tokenDigest}:null;
}

export function registerHandoffPublic(app,{db,authOptions}){
  app.post("/api/session-handoffs/consume",{config:{rateLimit:{max:20,timeWindow:60000}}},async(req,reply)=>{
    if(req.tenant?.surface!=="tenant")return reply.code(404).send({error:"not_found"});const {token}=v.parse(z.strictObject({token:z.string().min(32).max(200)}),req.body),host=requestHostname(req),transferDigest=digest(authOptions.secret,"handoff",host,token);
    const session=await db.transaction(async c=>{const row=(await c.query("SELECT * FROM myfin.session_handoffs WHERE token_digest=$1 AND target_hostname=$2 AND used_at IS NULL AND expires_at>now() FOR UPDATE",[transferDigest,host])).rows[0];if(!row)v.fail(401,"handoff_expired");
      const permitted=(await c.query(`SELECT 1 FROM myfin.app_identities i JOIN myfin.companies co ON co.id=$2
        WHERE i.id=$1 AND i.disabled_at IS NULL AND (i.is_super OR EXISTS(SELECT 1 FROM myfin.workspace_memberships wm WHERE wm.identity_id=i.id AND wm.workspace_id=co.workspace_id AND wm.suspended_at IS NULL) OR EXISTS(SELECT 1 FROM myfin.memberships m WHERE m.identity_id=i.id AND m.company_id=co.id))`,[row.identity_id,req.tenant.company_id])).rowCount;if(!permitted)v.fail(403,"access_denied");
      await c.query("UPDATE myfin.session_handoffs SET used_at=now() WHERE token_digest=$1",[transferDigest]);const sessionToken=randomBytes(32).toString("base64url"),sessionDigest=digest(authOptions.secret,"handoff-session",host,sessionToken);await c.query("INSERT INTO myfin.app_sessions(token_digest,identity_id,hostname,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",[sessionDigest,row.identity_id,host]);return sessionToken;});
    reply.header("set-cookie",setCookie(session,authOptions.secure));return {ok:true};
  });
  app.post("/api/session-handoffs/sign-out",async(req,reply)=>{const session=await handoffSubject(db,req,authOptions);if(session)await db.query("UPDATE myfin.app_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE token_digest=$1",[session.digest]);reply.header("set-cookie",clearCookie(authOptions.secure));return {ok:true};});
}

export async function createHandoff(c,req,options,targetHostname){
  const target=(await c.query(`SELECT h.hostname,h.company_id,h.workspace_id FROM myfin.tenant_hosts h JOIN myfin.companies co ON co.id=h.company_id JOIN myfin.workspaces w ON w.id=h.workspace_id
    WHERE h.hostname=$1 AND h.canonical AND h.disabled_at IS NULL AND co.archived_at IS NULL AND co.suspended_at IS NULL AND w.archived_at IS NULL AND w.suspended_at IS NULL FOR SHARE`,[targetHostname])).rows[0];if(!target)v.fail(404,"not_found");
  const permitted=(await c.query(`SELECT 1 FROM myfin.app_identities i WHERE i.id=$1 AND i.disabled_at IS NULL AND (i.is_super OR EXISTS(SELECT 1 FROM myfin.workspace_memberships wm WHERE wm.identity_id=i.id AND wm.workspace_id=$2 AND wm.suspended_at IS NULL) OR EXISTS(SELECT 1 FROM myfin.memberships m WHERE m.identity_id=i.id AND m.company_id=$3))`,[req.identity.id,target.workspace_id,target.company_id])).rowCount;if(!permitted)v.fail(403,"access_denied");
  const token=randomBytes(32).toString("base64url"),tokenDigest=digest(options.secret,"handoff",target.hostname,token);await c.query("DELETE FROM myfin.session_handoffs WHERE expires_at<=now() OR used_at IS NOT NULL");await c.query("INSERT INTO myfin.session_handoffs(token_digest,identity_id,target_hostname) VALUES($1,$2,$3)",[tokenDigest,req.identity.id,target.hostname]);
  return {url:`${options.protocol}//${target.hostname}/session-handoff#token=${encodeURIComponent(token)}`};
}
