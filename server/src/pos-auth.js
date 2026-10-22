import { createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import * as v from "./validation.js";
import { permissionsFor } from "../../src/domain/permissions.js";
import { bindTerminalStaffSession, endTerminalStaffSession, resolveTerminalContext, terminalPrincipalContext } from "./terminal-operations.js";

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
async function failedTerminalAttempt(c,companyId,terminalId,guard){
  const windowAge=Date.now()-new Date(guard.window_started_at).getTime();
  const failures=windowAge>10*60*1000?1:Number(guard.failure_count)+1;
  await c.query(`UPDATE myfin.terminal_login_guards SET failure_count=$3,
    window_started_at=CASE WHEN $4 THEN now() ELSE window_started_at END,
    locked_until=CASE WHEN $3>=5 THEN now()+interval '15 minutes' ELSE NULL END,updated_at=now()
    WHERE company_id=$1 AND terminal_id=$2`,[companyId,terminalId,failures,windowAge>10*60*1000]);
}

export async function posIdentity(db, req, options) {
  if(!options?.pos || req.tenant?.surface!=="tenant")return null;
  const token=cookie(req);if(!token)return null;
  const digest=hmac(options.pos.sessionSecret,"session",req.tenant.company_id,token);
  const {rows}=await db.query(`SELECT s.token_digest,s.identity_id AS id,i.display_name AS username,u.email,s.company_id,s.role,s.expires_at,
      s.created_at AS pos_session_created_at,s.terminal_id,s.store_id,s.store_location_id,s.terminal_credential_version,
      s.staff_session_id,s.work_shift_id,s.register_shift_id,g.module_ids,c.terminal_enforcement_enabled,
      c.terminal_enforcement_from,c.require_open_register_for_pos,c.require_open_register_from,
      ts.status AS staff_session_status,
      ws.status AS work_shift_status,rs.status AS register_shift_status
    FROM myfin.pos_sessions s JOIN myfin.app_identities i ON i.id=s.identity_id
    JOIN myfin.auth_user u ON u.id=i.id JOIN myfin.memberships m ON m.company_id=s.company_id AND m.identity_id=s.identity_id AND m.role=s.role
    LEFT JOIN myfin.membership_module_grants g ON g.company_id=m.company_id AND g.identity_id=m.identity_id
    JOIN myfin.companies c ON c.id=s.company_id JOIN myfin.workspaces w ON w.id=c.workspace_id
    LEFT JOIN myfin.terminal_staff_sessions ts ON ts.company_id=s.company_id AND ts.id=s.staff_session_id
    LEFT JOIN myfin.staff_work_shifts ws ON ws.company_id=s.company_id AND ws.id=s.work_shift_id
    LEFT JOIN myfin.register_shifts rs ON rs.company_id=s.company_id AND rs.id=s.register_shift_id
    WHERE s.token_digest=$1 AND s.company_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now()
      AND i.disabled_at IS NULL AND c.suspended_at IS NULL AND c.archived_at IS NULL
      AND w.suspended_at IS NULL AND w.archived_at IS NULL
      AND (s.terminal_id IS NOT NULL OR NOT c.terminal_enforcement_enabled OR s.created_at<c.terminal_enforcement_from)
      AND (s.terminal_id IS NULL OR ts.status='active')`,[digest,req.tenant.company_id]);
  const row=rows[0];if(!row)return null;
  let terminal=null;
  if(row.terminal_id){
    terminal=await resolveTerminalContext(db,req,options);
    if(!terminal||terminal.id!==row.terminal_id||Number(terminal.credential_version)!==Number(row.terminal_credential_version))return null;
  }
  db.query("UPDATE myfin.pos_sessions SET last_seen_at=now() WHERE token_digest=$1 AND last_seen_at<now()-interval '5 minutes'",[digest]).catch(()=>{});
  const principal={id:row.id,uid:row.id,username:row.username,email:row.email,role:row.role,company_id:row.company_id,
    workspace_id:req.tenant.workspace_id,module_grants:row.module_ids,authLevel:"pos_code",posSessionDigest:digest,
    posSessionCreatedAt:row.pos_session_created_at,terminalEnforcement:row.terminal_enforcement_enabled,
    terminalEnforcementFrom:row.terminal_enforcement_from,requireOpenRegisterForPos:row.require_open_register_for_pos,
    requireOpenRegisterFrom:row.require_open_register_from};
  if(terminal)Object.assign(principal,{terminalId:row.terminal_id,storeId:row.store_id,storeLocationId:row.store_location_id,
    terminalCredentialVersion:Number(row.terminal_credential_version),terminalContext:terminal.context,storeTimeZone:terminal.time_zone,
    terminalType:terminal.type,terminalCapabilities:terminal.capabilities||[],
    staffSessionId:row.staff_session_id,workShiftId:row.work_shift_id||'',workShiftStatus:row.work_shift_status||'',
    registerShiftId:row.register_shift_id||'',registerShiftStatus:row.register_shift_status||''});
  return principal;
}

export function registerPosAuth(app,{db,authOptions}) {
  app.post("/api/pos-auth/sign-in",{config:{rateLimit:{max:20,timeWindow:60000}}},async(req,reply)=>{
    if(!authOptions.pos || req.tenant?.surface!=="tenant" || !req.tenant.canonical)return reply.code(404).send({error:"not_found"});
    const {code}=v.parse(z.strictObject({code:codeSchema}),req.body);
    const companyId=req.tenant.company_id;
    const terminal=await resolveTerminalContext(db,req,authOptions);
    const result=await db.transaction(async c=>{
      const policy=(await c.query(`SELECT terminal_enforcement_enabled FROM myfin.companies WHERE id=$1 FOR SHARE`,[companyId])).rows[0];
      if(policy?.terminal_enforcement_enabled&&!terminal)v.fail(401,'terminal_enrollment_required');
      if(terminal&&!(terminal.capabilities||[]).includes('pos'))v.fail(403,'terminal_capability_required');
      let guard;
      if(terminal){
        await c.query(`INSERT INTO myfin.terminal_login_guards(company_id,terminal_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[companyId,terminal.id]);
        guard=(await c.query(`SELECT * FROM myfin.terminal_login_guards WHERE company_id=$1 AND terminal_id=$2 FOR UPDATE`,[companyId,terminal.id])).rows[0];
      }else{
        await c.query("INSERT INTO myfin.pos_login_guards(company_id) VALUES($1) ON CONFLICT DO NOTHING",[companyId]);
        guard=(await c.query("SELECT * FROM myfin.pos_login_guards WHERE company_id=$1 FOR UPDATE",[companyId])).rows[0];
      }
      if(guard.locked_until&&new Date(guard.locked_until)>now())v.fail(429,"pos_login_locked");
      const digest=hmac(authOptions.pos.codeSecret,"code-lookup",companyId,code);
      const row=(await c.query(`SELECT p.*,m.role,i.display_name AS username,u.email,g.module_ids,
          co.terminal_enforcement_enabled,co.terminal_enforcement_from,co.require_open_register_for_pos,
          co.require_open_register_from
        FROM myfin.pos_access_codes p JOIN myfin.memberships m ON m.company_id=p.company_id AND m.identity_id=p.identity_id
        LEFT JOIN myfin.membership_module_grants g ON g.company_id=m.company_id AND g.identity_id=m.identity_id
        JOIN myfin.app_identities i ON i.id=p.identity_id JOIN myfin.auth_user u ON u.id=i.id
        JOIN myfin.companies co ON co.id=p.company_id
        WHERE p.company_id=$1 AND p.lookup_digest=$2 AND p.disabled_at IS NULL AND i.disabled_at IS NULL
          AND m.role IN ('manager','operator') FOR UPDATE OF p`,[companyId,digest])).rows[0];
      const valid=row&&equalHex(row.verifier,await verifier(authOptions.pos.codeSecret,companyId,code,row.salt));
      if(!valid){if(terminal)await failedTerminalAttempt(c,companyId,terminal.id,guard);else await failedAttempt(c,companyId,guard);v.fail(401,"authentication_failed");}
      if(terminal)await c.query(`UPDATE myfin.terminal_login_guards SET failure_count=0,window_started_at=now(),locked_until=NULL,updated_at=now()
        WHERE company_id=$1 AND terminal_id=$2`,[companyId,terminal.id]);
      else await c.query("UPDATE myfin.pos_login_guards SET failure_count=0,window_started_at=now(),locked_until=NULL,updated_at=now() WHERE company_id=$1",[companyId]);
      const token=randomBytes(32).toString("base64url"),tokenDigest=hmac(authOptions.pos.sessionSecret,"session",companyId,token);
      await c.query("DELETE FROM myfin.pos_sessions WHERE expires_at<=now() OR revoked_at IS NOT NULL");
      const bound=terminal?await bindTerminalStaffSession(c,terminal,row):null,
        currentTerminal=terminal?{...terminal,...bound.terminal,context:terminal.context}:null;
      if(currentTerminal&&!(currentTerminal.capabilities||[]).includes('pos'))v.fail(403,'terminal_capability_required');
      await c.query(`INSERT INTO myfin.pos_sessions(token_digest,company_id,identity_id,role,expires_at,
        terminal_id,store_id,store_location_id,terminal_credential_version,staff_session_id,work_shift_id,register_shift_id)
        VALUES($1,$2,$3,$4,now()+($5||' hours')::interval,$6,$7,$8,$9,$10,$11,$12)`,
      [tokenDigest,companyId,row.identity_id,row.role,String(authOptions.pos.sessionHours),currentTerminal?.id||null,currentTerminal?.store_id||null,
        currentTerminal?.store_location_id||null,currentTerminal?.credential_version||null,bound?.session?.id||null,bound?.work?.id||null,bound?.register?.id||null]);
      await c.query("INSERT INTO myfin.management_events(id,actor_id,workspace_id,company_id,subject_id,action,details) VALUES($1,$2,$3,$4,$2,'pos_code_sign_in',$5)",
        [randomUUID(),row.identity_id,req.tenant.workspace_id,companyId,{authLevel:"pos_code"}]);
      const user={id:row.identity_id,uid:row.identity_id,username:row.username,email:row.email,role:row.role,
        company_id:companyId,workspace_id:req.tenant.workspace_id,module_grants:row.module_ids,authLevel:"pos_code",
        posSessionDigest:tokenDigest,posSessionCreatedAt:new Date(),terminalEnforcement:row.terminal_enforcement_enabled,
        terminalEnforcementFrom:row.terminal_enforcement_from,requireOpenRegisterForPos:row.require_open_register_for_pos,
        requireOpenRegisterFrom:row.require_open_register_from};
      if(currentTerminal)Object.assign(user,terminalPrincipalContext(currentTerminal,bound));
      return {token,user,bound};
    });
    reply.header("set-cookie",cookieHeader(result.token,authOptions.secure,authOptions.pos.sessionHours));
    return {user:result.user,terminalContext:result.user.terminalContext||null,
      staffSession:result.bound?.session||null,workShift:result.bound?.work||null,registerShift:result.bound?.register||null};
  });
  app.get("/api/pos-auth/session",async(req,reply)=>{
    const user=await posIdentity(db,req,authOptions);if(!user)return reply.code(401).send({error:"session_required"});return {user};
  });
  app.post("/api/pos-auth/sign-out",async(req,reply)=>{
    const token=cookie(req);
    if(token&&req.tenant?.company_id&&authOptions.pos){const digest=hmac(authOptions.pos.sessionSecret,"session",req.tenant.company_id,token);await db.transaction(async c=>{
      const row=(await c.query("UPDATE myfin.pos_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE token_digest=$1 RETURNING company_id,staff_session_id",[digest])).rows[0];
      if(row)await endTerminalStaffSession(c,row.company_id,row.staff_session_id,'sign_out');
    });}
    reply.header("set-cookie",clearCookie(authOptions.secure));return {ok:true};
  });
}

export async function verifyManagerCode(c,options,companyId,code,capability="") {
  await c.query("INSERT INTO myfin.pos_login_guards(company_id) VALUES($1) ON CONFLICT DO NOTHING",[companyId]);
  const guard=(await c.query("SELECT * FROM myfin.pos_login_guards WHERE company_id=$1 FOR UPDATE",[companyId])).rows[0];
  if(guard.locked_until&&new Date(guard.locked_until)>now())v.fail(429,"pos_login_locked");
  const parsed=v.parse(codeSchema,code),digest=hmac(options.codeSecret,"code-lookup",companyId,parsed);
  const row=(await c.query(`SELECT p.identity_id,p.salt,p.verifier,g.module_ids FROM myfin.pos_access_codes p
    JOIN myfin.memberships m ON m.company_id=p.company_id AND m.identity_id=p.identity_id AND m.role='manager'
    JOIN myfin.app_identities i ON i.id=p.identity_id AND i.disabled_at IS NULL
    LEFT JOIN myfin.membership_module_grants g ON g.company_id=m.company_id AND g.identity_id=m.identity_id
    WHERE p.company_id=$1 AND p.lookup_digest=$2 AND p.disabled_at IS NULL FOR UPDATE OF p`,[companyId,digest])).rows[0];
  if(!row||!equalHex(row.verifier,await verifier(options.codeSecret,companyId,parsed,row.salt))){await failedAttempt(c,companyId,guard);v.fail(403,"manager_approval_required");}
  if(capability&&!permissionsFor({role:"manager",module_grants:row.module_ids})[capability])v.fail(403,"manager_approval_required");
  await c.query("UPDATE myfin.pos_login_guards SET failure_count=0,window_started_at=now(),locked_until=NULL,updated_at=now() WHERE company_id=$1",[companyId]);
  return row.identity_id;
}
