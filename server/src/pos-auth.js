import { createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import * as v from "./validation.js";

const scrypt = promisify(scryptCallback);
const cookieName = "myfin.pos_session";
const codeSchema = z.string().regex(/^\d{6}$/);
const now = () => new Date();

const hmac = (secret, purpose, companyId, value) => createHmac("sha256",secret)
  .update(`myfin:${purpose}:v1\0${companyId}\0${value}`).digest("hex");
const verifier = async(secret,companyId,code,salt) => (await scrypt(`${companyId}:${code}:${secret}`,salt,32,{N:16384,r:8,p:1,maxmem:64*1024*1024})).toString("hex");
const equalHex = (left,right) => {
  try { const a=Buffer.from(left,"hex"),b=Buffer.from(right,"hex"); return a.length===b.length&&timingSafeEqual(a,b); }
  catch { return false; }
};

export async function protectPosCode(options, companyId, code, salt=randomBytes(16).toString("hex")) {
  const parsed=v.parse(codeSchema,code);
  return { lookupDigest:hmac(options.codeSecret,"code-lookup",companyId,parsed), salt,
    verifier:await verifier(options.codeSecret,companyId,parsed,salt) };
}

export function generatePosCode() {
  return String(randomBytes(4).readUInt32BE(0)%1000000).padStart(6,"0");
}

function cookie(req) {
  const source=String(req.headers.cookie||"");
  for(const part of source.split(";")){const [name,...value]=part.trim().split("=");if(name===cookieName)return decodeURIComponent(value.join("="));}
  return "";
}
function cookieHeader(token, secure, hours) {
  return `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure?"; Secure":""}; Max-Age=${Math.round(hours*3600)}`;
}
function clearCookie(secure) { return `${cookieName}=; Path=/; HttpOnly; SameSite=Lax${secure?"; Secure":""}; Max-Age=0`; }

async function failedAttempt(c,companyId,guard) {
  const windowAge=Date.now()-new Date(guard.window_started_at).getTime();
  const failures=windowAge>10*60*1000?1:Number(guard.failure_count)+1;
  await c.query(`UPDATE myfin.pos_login_guards SET failure_count=$2,
    window_started_at=CASE WHEN $3 THEN now() ELSE window_started_at END,
    locked_until=CASE WHEN $2>=5 THEN now()+interval '15 minutes' ELSE NULL END,updated_at=now()
    WHERE company_id=$1`,[companyId,failures,windowAge>10*60*1000]);
}

export async function posIdentity(db, req, options) {
  if(!options?.pos || req.tenant?.surface!=="tenant")return null;
  const token=cookie(req);if(!token)return null;
  const digest=hmac(options.pos.sessionSecret,"session",req.tenant.company_id,token);
  const {rows}=await db.query(`SELECT s.token_digest,s.identity_id AS id,i.display_name AS username,u.email,s.company_id,s.role,s.expires_at
    FROM myfin.pos_sessions s JOIN myfin.app_identities i ON i.id=s.identity_id
    JOIN myfin.auth_user u ON u.id=i.id JOIN myfin.memberships m ON m.company_id=s.company_id AND m.identity_id=s.identity_id AND m.role=s.role
    JOIN myfin.companies c ON c.id=s.company_id JOIN myfin.workspaces w ON w.id=c.workspace_id
    WHERE s.token_digest=$1 AND s.company_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now()
      AND i.disabled_at IS NULL AND c.suspended_at IS NULL AND c.archived_at IS NULL
      AND w.suspended_at IS NULL AND w.archived_at IS NULL`,[digest,req.tenant.company_id]);
  const row=rows[0];if(!row)return null;
  db.query("UPDATE myfin.pos_sessions SET last_seen_at=now() WHERE token_digest=$1 AND last_seen_at<now()-interval '5 minutes'",[digest]).catch(()=>{});
  return {id:row.id,uid:row.id,username:row.username,email:row.email,role:row.role,company_id:row.company_id,
    workspace_id:req.tenant.workspace_id,authLevel:"pos_code",posSessionDigest:digest};
}

export function registerPosAuth(app,{db,authOptions}) {
  app.post("/api/pos-auth/sign-in",{config:{rateLimit:{max:20,timeWindow:60000}}},async(req,reply)=>{
    if(!authOptions.pos || req.tenant?.surface!=="tenant" || !req.tenant.canonical)return reply.code(404).send({error:"not_found"});
    const {code}=v.parse(z.strictObject({code:codeSchema}),req.body);
    const companyId=req.tenant.company_id;
    const result=await db.transaction(async c=>{
      await c.query("INSERT INTO myfin.pos_login_guards(company_id) VALUES($1) ON CONFLICT DO NOTHING",[companyId]);
      const guard=(await c.query("SELECT * FROM myfin.pos_login_guards WHERE company_id=$1 FOR UPDATE",[companyId])).rows[0];
      if(guard.locked_until&&new Date(guard.locked_until)>now())v.fail(429,"pos_login_locked");
      const digest=hmac(authOptions.pos.codeSecret,"code-lookup",companyId,code);
      const row=(await c.query(`SELECT p.*,m.role,i.display_name AS username,u.email
        FROM myfin.pos_access_codes p JOIN myfin.memberships m ON m.company_id=p.company_id AND m.identity_id=p.identity_id
        JOIN myfin.app_identities i ON i.id=p.identity_id JOIN myfin.auth_user u ON u.id=i.id
        WHERE p.company_id=$1 AND p.lookup_digest=$2 AND p.disabled_at IS NULL AND i.disabled_at IS NULL
          AND m.role IN ('manager','operator') FOR UPDATE OF p`,[companyId,digest])).rows[0];
      const valid=row&&equalHex(row.verifier,await verifier(authOptions.pos.codeSecret,companyId,code,row.salt));
      if(!valid){await failedAttempt(c,companyId,guard);v.fail(401,"authentication_failed");}
      await c.query("UPDATE myfin.pos_login_guards SET failure_count=0,window_started_at=now(),locked_until=NULL,updated_at=now() WHERE company_id=$1",[companyId]);
      const token=randomBytes(32).toString("base64url"),tokenDigest=hmac(authOptions.pos.sessionSecret,"session",companyId,token);
      await c.query("DELETE FROM myfin.pos_sessions WHERE expires_at<=now() OR revoked_at IS NOT NULL");
      await c.query("INSERT INTO myfin.pos_sessions(token_digest,company_id,identity_id,role,expires_at) VALUES($1,$2,$3,$4,now()+($5||' hours')::interval)",[tokenDigest,companyId,row.identity_id,row.role,String(authOptions.pos.sessionHours)]);
      await c.query("INSERT INTO myfin.management_events(id,actor_id,workspace_id,company_id,subject_id,action,details) VALUES($1,$2,$3,$4,$2,'pos_code_sign_in',$5)",
        [randomUUID(),row.identity_id,req.tenant.workspace_id,companyId,{authLevel:"pos_code"}]);
      return {token,user:{id:row.identity_id,uid:row.identity_id,username:row.username,email:row.email,role:row.role,company_id:companyId,workspace_id:req.tenant.workspace_id,authLevel:"pos_code"}};
    });
    reply.header("set-cookie",cookieHeader(result.token,authOptions.secure,authOptions.pos.sessionHours));
    return {user:result.user};
  });
  app.get("/api/pos-auth/session",async(req,reply)=>{
    const user=await posIdentity(db,req,authOptions);if(!user)return reply.code(401).send({error:"session_required"});return {user};
  });
  app.post("/api/pos-auth/sign-out",async(req,reply)=>{
    const token=cookie(req);
    if(token&&req.tenant?.company_id&&authOptions.pos){const digest=hmac(authOptions.pos.sessionSecret,"session",req.tenant.company_id,token);await db.query("UPDATE myfin.pos_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE token_digest=$1",[digest]);}
    reply.header("set-cookie",clearCookie(authOptions.secure));return {ok:true};
  });
}

export async function verifyManagerCode(c,options,companyId,code) {
  await c.query("INSERT INTO myfin.pos_login_guards(company_id) VALUES($1) ON CONFLICT DO NOTHING",[companyId]);
  const guard=(await c.query("SELECT * FROM myfin.pos_login_guards WHERE company_id=$1 FOR UPDATE",[companyId])).rows[0];
  if(guard.locked_until&&new Date(guard.locked_until)>now())v.fail(429,"pos_login_locked");
  const parsed=v.parse(codeSchema,code),digest=hmac(options.codeSecret,"code-lookup",companyId,parsed);
  const row=(await c.query(`SELECT p.identity_id,p.salt,p.verifier FROM myfin.pos_access_codes p
    JOIN myfin.memberships m ON m.company_id=p.company_id AND m.identity_id=p.identity_id AND m.role='manager'
    JOIN myfin.app_identities i ON i.id=p.identity_id AND i.disabled_at IS NULL
    WHERE p.company_id=$1 AND p.lookup_digest=$2 AND p.disabled_at IS NULL FOR UPDATE OF p`,[companyId,digest])).rows[0];
  if(!row||!equalHex(row.verifier,await verifier(options.codeSecret,companyId,parsed,row.salt))){await failedAttempt(c,companyId,guard);v.fail(403,"manager_approval_required");}
  await c.query("UPDATE myfin.pos_login_guards SET failure_count=0,window_started_at=now(),locked_until=NULL,updated_at=now() WHERE company_id=$1",[companyId]);
  return row.identity_id;
}
