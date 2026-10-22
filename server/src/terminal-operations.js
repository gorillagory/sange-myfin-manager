import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as v from './validation.js';
import { requireCapability, manager, owner } from './access.js';
import { requirePasswordSession } from './management.js';

const terminalCookieName = 'myfin.terminal';
const terminalCookieSeconds = 365 * 24 * 60 * 60;
const terminalTypes = ['pos','kitchen_display','customer_display','back_office','print_connector','stock','multi_use'];
const terminalCapabilities = ['pos','kitchen','label_printing','customer_display','stock','admin'];
const terminalTypeCapabilities = Object.freeze({
  pos:['pos'],kitchen_display:['kitchen'],customer_display:['customer_display'],
  back_office:['admin'],print_connector:['label_printing'],stock:['stock'],multi_use:[],
});
const defaultTerminalCapabilities = type => [...(terminalTypeCapabilities[type] || [])];
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{0,31}$/);
const jsonObject = z.unknown().refine(value => value !== null && typeof value === 'object' && !Array.isArray(value));
const moneySen = z.number().int().min(-1000000000000000).max(1000000000000000);
const positiveMoneySen = z.number().int().min(0).max(1000000000000000);
const enrollmentAlphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const enrollmentToken=()=>{
  const bytes=randomBytes(12);let value='';
  for(let index=0;index<12;index++)value+=enrollmentAlphabet[bytes[index]&31];
  return value;
};
const normalizeEnrollmentToken=value=>String(value||'').toUpperCase().replace(/[\s-]/g,'').replaceAll('O','0').replace(/[IL]/g,'1');
const requestDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

const secretDigest = (options, purpose, companyId, value) => createHmac('sha256', options.pos.sessionSecret)
  .update(`myfin:${purpose}:v1\0${companyId}\0${value}`).digest('hex');
export const terminalCredentialDigest = (options, companyId, secret) =>
  secretDigest(options, 'terminal-credential', companyId, secret);
export const terminalEnrollmentDigest = (options, companyId, token) =>
  secretDigest(options, 'terminal-enrollment', companyId, token);

function cookieValue(req) {
  const source = String(req.headers.cookie || '');
  for (const part of source.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === terminalCookieName) return decodeURIComponent(value.join('='));
  }
  return '';
}
function terminalCookie(terminalId, secret, secure) {
  const id = Buffer.from(terminalId, 'utf8').toString('base64url');
  return `${terminalCookieName}=${encodeURIComponent(`${id}.${secret}`)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${terminalCookieSeconds}`;
}
export function clearTerminalCookie(secure) {
  return `${terminalCookieName}=; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=0`;
}
function parseTerminalCookie(req) {
  const value = cookieValue(req), separator = value.indexOf('.');
  if (separator <= 0) return null;
  try {
    const terminalId = Buffer.from(value.slice(0, separator), 'base64url').toString('utf8');
    const secret = value.slice(separator + 1);
    if (!v.id.safeParse(terminalId).success || !/^[A-Za-z0-9_-]{40,128}$/.test(secret)) return null;
    return { terminalId, secret };
  } catch { return null; }
}

const storeOutput = row => ({
  id:row.id, code:row.code, name:row.name, type:row.type, status:row.status,
  timeZone:row.time_zone, address:row.address || {}, phone:row.phone, email:row.email,
  latitude:row.latitude === null ? null : Number(row.latitude),
  longitude:row.longitude === null ? null : Number(row.longitude),
  geofenceRadiusM:row.geofence_radius_m, version:Number(row.version),
  createdAt:row.created_at, updatedAt:row.updated_at,
});
const locationOutput = row => ({
  id:row.id, storeId:row.store_id, code:row.code, name:row.name, type:row.type,
  status:row.status, customerFacing:row.customer_facing, version:Number(row.version),
  createdAt:row.created_at, updatedAt:row.updated_at,
});
const terminalOutput = row => ({
  id:row.id, storeId:row.store_id, locationId:row.store_location_id, code:row.code,
  name:row.name, type:row.type, status:row.status, capabilities:row.capabilities || [],
  deviceProfile:row.device_profile || {}, credentialVersion:Number(row.credential_version || 0),
  lastSeenAt:row.last_seen_at, enrolledAt:row.enrolled_at, version:Number(row.version),
  currentStaff:row.current_identity_id?{id:row.current_identity_id,name:row.current_staff_name||'',
    sessionId:row.current_staff_session_id,workShiftId:row.current_work_shift_id||'',
    workShiftStatus:row.current_work_shift_status||''}:null,
  openRegisterShiftId:row.open_register_shift_id||'',
  createdAt:row.created_at, updatedAt:row.updated_at,
});
const workShiftOutput = row => row ? ({
  id:row.id, identityId:row.identity_id, storeId:row.store_id,
  locationId:row.store_location_id, status:row.status, clockedInAt:row.clocked_in_at,
  breakStartedAt:row.break_started_at, breakSeconds:Number(row.break_seconds || 0),
  clockedOutAt:row.clocked_out_at, notes:row.notes || '', version:Number(row.version),
  identityName:row.identity_name||'',storeName:row.store_name||'',locationName:row.location_name||'',
  openedTerminalName:row.opened_terminal_name||'',closedTerminalName:row.closed_terminal_name||'',
}) : null;
const staffSessionOutput = row => row ? ({
  id:row.id, identityId:row.identity_id, terminalId:row.terminal_id,
  storeId:row.store_id, locationId:row.store_location_id, workShiftId:row.work_shift_id || '',
  status:row.status, authenticatedAt:row.authenticated_at, lastSeenAt:row.last_seen_at,
}) : null;
const registerShiftOutput = row => row ? ({
  id:row.id, terminalId:row.terminal_id, storeId:row.store_id,
  locationId:row.store_location_id, businessDate:String(row.business_date).slice(0,10),
  status:row.status, openingCashSen:Number(row.opening_cash_sen),
  currentExpectedCashSen:row.current_expected_cash_sen === undefined ? undefined : Number(row.current_expected_cash_sen),
  expectedCashSen:row.expected_cash_sen === null ? null : Number(row.expected_cash_sen),
  countedCashSen:row.counted_cash_sen === null ? null : Number(row.counted_cash_sen),
  varianceSen:row.variance_sen === null ? null : Number(row.variance_sen),
  openedBy:row.opened_by, openedAt:row.opened_at, closedBy:row.closed_by,
  terminalName:row.terminal_name || '', locationName:row.location_name || '',
  openedByName:row.opened_by_name || '',
  closedAt:row.closed_at, varianceReason:row.variance_reason || '', notes:row.notes || '',
  version:Number(row.version),
}) : null;

function terminalContextOutput(row) {
  return {
    companyId:row.company_id,
    policy:{
      terminalEnforcement:row.terminal_enforcement_enabled,
      terminalEnforcementFrom:row.terminal_enforcement_from,
      requireOpenRegisterForPos:row.require_open_register_for_pos,
      requireOpenRegisterFrom:row.require_open_register_from,
    },
    store:{id:row.store_id,code:row.store_code,name:row.store_name,timeZone:row.time_zone},
    location:{id:row.store_location_id,code:row.location_code,name:row.location_name,type:row.location_type},
    terminal:terminalOutput(row),
  };
}

export async function resolveTerminalContext(db, req, authOptions, { touch=true } = {}) {
  if (!authOptions?.pos || req.tenant?.surface !== 'tenant' || !req.tenant.company_id) return null;
  const credential = parseTerminalCookie(req);
  if (!credential) return null;
  const digest = terminalCredentialDigest(authOptions, req.tenant.company_id, credential.secret);
  const { rows } = await db.query(`SELECT t.*,s.code AS store_code,s.name AS store_name,s.time_zone,
      l.code AS location_code,l.name AS location_name,l.type AS location_type,
      c.terminal_enforcement_enabled,c.terminal_enforcement_from,c.require_open_register_for_pos,
      c.require_open_register_from
    FROM myfin.terminals t
    JOIN myfin.terminal_credentials k ON k.company_id=t.company_id AND k.terminal_id=t.id
      AND k.version=t.credential_version AND k.secret_digest=$3 AND k.revoked_at IS NULL
    JOIN myfin.stores s ON s.company_id=t.company_id AND s.id=t.store_id AND s.status='active'
    JOIN myfin.store_locations l ON l.company_id=t.company_id AND l.store_id=t.store_id
      AND l.id=t.store_location_id AND l.status='active'
    JOIN myfin.companies c ON c.id=t.company_id
    WHERE t.company_id=$1 AND t.id=$2 AND t.status='active'`,
  [req.tenant.company_id, credential.terminalId, digest]);
  const row = rows[0];
  if (!row) return null;
  if (touch) {
    await db.query(`UPDATE myfin.terminals SET last_seen_at=now(),updated_at=now()
      WHERE company_id=$1 AND id=$2 AND (last_seen_at IS NULL OR last_seen_at<now()-interval '5 minutes')`,
    [row.company_id,row.id]);
    await db.query(`UPDATE myfin.terminal_credentials SET last_used_at=now()
      WHERE company_id=$1 AND terminal_id=$2 AND version=$3
        AND (last_used_at IS NULL OR last_used_at<now()-interval '5 minutes')`,
    [row.company_id,row.id,row.credential_version]);
  }
  return {...row, credentialDigest:digest, context:terminalContextOutput(row)};
}

async function activeShiftContext(c, companyId, terminalId, identityId) {
  const session=(await c.query(`SELECT * FROM myfin.terminal_staff_sessions
    WHERE company_id=$1 AND terminal_id=$2 AND ($3::text IS NULL OR identity_id=$3)
      AND status='active' FOR UPDATE`,[companyId,terminalId,identityId||null])).rows[0] || null;
  const work=session ? (await c.query(`SELECT * FROM myfin.staff_work_shifts
    WHERE company_id=$1 AND id=$2`,[companyId,session.work_shift_id])).rows[0] || null : null;
  const register=(await c.query(`SELECT r.*,coalesce(sum(e.amount_sen),0) AS current_expected_cash_sen
    FROM myfin.register_shifts r LEFT JOIN myfin.register_cash_entries e
      ON e.company_id=r.company_id AND e.register_shift_id=r.id
    WHERE r.company_id=$1 AND r.terminal_id=$2 AND r.status='open'
    GROUP BY r.company_id,r.id`,[companyId,terminalId])).rows[0] || null;
  return { session, work, register };
}

export async function bindTerminalStaffSession(c, terminal, identity) {
  const companyId=terminal.company_id, terminalId=terminal.id,identityId=identity.identity_id||identity.id;
  for(const lockKey of [`${companyId}:identity:${identityId}`,`${companyId}:terminal:${terminalId}`].sort())
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,49))',[lockKey]);
  const currentTerminal=(await c.query(`SELECT t.*,s.time_zone,c.terminal_enforcement_enabled,c.terminal_enforcement_from,
      c.require_open_register_for_pos,c.require_open_register_from FROM myfin.terminals t
    JOIN myfin.stores s ON s.company_id=t.company_id AND s.id=t.store_id AND s.status='active'
    JOIN myfin.store_locations l ON l.company_id=t.company_id AND l.store_id=t.store_id
      AND l.id=t.store_location_id AND l.status='active'
    JOIN myfin.companies c ON c.id=t.company_id
    WHERE t.company_id=$1 AND t.id=$2 AND t.status='active' AND t.credential_version=$3
      AND EXISTS(SELECT 1 FROM myfin.terminal_credentials k WHERE k.company_id=t.company_id
        AND k.terminal_id=t.id AND k.version=t.credential_version AND k.revoked_at IS NULL)
    FOR SHARE OF t`,[companyId,terminalId,terminal.credential_version])).rows[0];
  if(!currentTerminal)v.fail(401,'terminal_enrollment_required');
  const assignment=(await c.query(`SELECT
      EXISTS(SELECT 1 FROM myfin.staff_location_assignments WHERE company_id=$1 AND identity_id=$2 AND revoked_at IS NULL) AS restricted,
      EXISTS(SELECT 1 FROM myfin.staff_location_assignments WHERE company_id=$1 AND identity_id=$2
        AND store_location_id=$3 AND revoked_at IS NULL) AS assigned`,
  [companyId,identityId,currentTerminal.store_location_id])).rows[0];
  if(assignment?.restricted&&!assignment?.assigned)v.fail(403,'terminal_location_not_assigned');
  const current=(await c.query(`SELECT * FROM myfin.terminal_staff_sessions WHERE company_id=$1
    AND terminal_id=$2 AND identity_id=$3 AND status='active' FOR UPDATE`,
  [companyId,terminalId,identityId])).rows[0];
  if(current){
    await c.query(`UPDATE myfin.terminal_staff_sessions SET last_seen_at=now() WHERE company_id=$1 AND id=$2`,[companyId,current.id]);
    const work=current.work_shift_id?(await c.query(`SELECT * FROM myfin.staff_work_shifts WHERE company_id=$1 AND id=$2`,[companyId,current.work_shift_id])).rows[0]||null:null;
    const register=(await c.query(`SELECT r.*,coalesce(sum(e.amount_sen),0) AS current_expected_cash_sen
      FROM myfin.register_shifts r LEFT JOIN myfin.register_cash_entries e ON e.company_id=r.company_id AND e.register_shift_id=r.id
      WHERE r.company_id=$1 AND r.terminal_id=$2 AND r.status='open' GROUP BY r.company_id,r.id`,[companyId,terminalId])).rows[0]||null;
    return {terminal:currentTerminal,session:current,work,register};
  }
  await c.query(`UPDATE myfin.terminal_staff_sessions SET status='ended',ended_at=now(),ended_reason='replaced_by_sign_in'
    WHERE company_id=$1 AND status='active' AND (terminal_id=$2 OR identity_id=$3)`,
  [companyId,terminalId,identityId]);
  const work=(await c.query(`SELECT * FROM myfin.staff_work_shifts w WHERE w.company_id=$1 AND w.identity_id=$2
      AND w.store_location_id=$3 AND w.status IN ('open','on_break')
      AND NOT EXISTS(SELECT 1 FROM myfin.terminal_staff_sessions ended
        WHERE ended.company_id=w.company_id AND ended.work_shift_id=w.id AND ended.ended_reason='access_revoked')
      ORDER BY w.clocked_in_at DESC LIMIT 1`,
  [companyId,identityId,currentTerminal.store_location_id])).rows[0] || null;
  const id=randomUUID();
  const session=(await c.query(`INSERT INTO myfin.terminal_staff_sessions(company_id,id,terminal_id,store_id,
      store_location_id,identity_id,work_shift_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
  [companyId,id,terminalId,currentTerminal.store_id,currentTerminal.store_location_id,identityId,work?.id || null])).rows[0];
  const register=(await c.query(`SELECT r.*,coalesce(sum(e.amount_sen),0) AS current_expected_cash_sen
    FROM myfin.register_shifts r LEFT JOIN myfin.register_cash_entries e
      ON e.company_id=r.company_id AND e.register_shift_id=r.id
    WHERE r.company_id=$1 AND r.terminal_id=$2 AND r.status='open'
    GROUP BY r.company_id,r.id`,[companyId,terminalId])).rows[0] || null;
  await c.query(`INSERT INTO myfin.terminal_events(company_id,id,terminal_id,action,actor_id,details)
    VALUES($1,$2,$3,'staff_handover',$4,$5)`,[companyId,randomUUID(),terminalId,identityId,
    {staffSessionId:id}]);
  return {terminal:currentTerminal,session,work,register};
}

export function terminalDeviceContext(terminal){
  return {terminalId:terminal.id,storeId:terminal.store_id,storeLocationId:terminal.store_location_id,
    terminalCredentialVersion:Number(terminal.credential_version),terminalContext:terminal.context,
    terminalType:terminal.type,terminalCapabilities:terminal.capabilities||[],
    storeTimeZone:terminal.time_zone,terminalEnforcement:terminal.terminal_enforcement_enabled,
    terminalEnforcementFrom:terminal.terminal_enforcement_from,
    requireOpenRegisterForPos:terminal.require_open_register_for_pos,
    requireOpenRegisterFrom:terminal.require_open_register_from};
}
export function terminalPrincipalContext(terminal,bound) {
  return {
    ...terminalDeviceContext(terminal),staffSessionId:bound.session.id,
    workShiftId:bound.work?.id||'',workShiftStatus:bound.work?.status||'',
    registerShiftId:bound.register?.id||'',registerShiftStatus:bound.register?.status||'',
    terminalEnforcement:terminal.terminal_enforcement_enabled,
    terminalEnforcementFrom:terminal.terminal_enforcement_from,
    requireOpenRegisterForPos:terminal.require_open_register_for_pos,
    requireOpenRegisterFrom:terminal.require_open_register_from,
  };
}

export async function ensureRequestTerminalStaff(c,req,{purpose='pos'}={}){
  requireCapability(req.identity,purpose==='staff'?'shiftOperate':'checkout');
  const terminalId=req.identity.terminalId||req.enrolledTerminal?.id;
  if(!terminalId)return req.identity;
  if(req.identity.staffSessionId){
    const companyId=req.identity.company_id||req.enrolledTerminal?.company_id,
      credentialVersion=Number(req.identity.terminalCredentialVersion||req.enrolledTerminal?.credential_version||0);
    for(const lockKey of [`${companyId}:identity:${req.identity.id}`,`${companyId}:terminal:${terminalId}`].sort())
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,49))',[lockKey]);
    const terminal=(await c.query(`SELECT t.*,s.time_zone,c.terminal_enforcement_enabled,c.terminal_enforcement_from,
        c.require_open_register_for_pos,c.require_open_register_from
      FROM myfin.terminals t JOIN myfin.terminal_credentials k ON k.company_id=t.company_id
        AND k.terminal_id=t.id AND k.version=t.credential_version AND k.revoked_at IS NULL
      JOIN myfin.stores s ON s.company_id=t.company_id AND s.id=t.store_id AND s.status='active'
      JOIN myfin.store_locations l ON l.company_id=t.company_id AND l.store_id=t.store_id
        AND l.id=t.store_location_id AND l.status='active'
      JOIN myfin.companies c ON c.id=t.company_id
      WHERE t.company_id=$1 AND t.id=$2 AND t.status='active' AND t.credential_version=$3
      FOR SHARE OF t,k`,[companyId,terminalId,credentialVersion])).rows[0];
    if(!terminal)v.fail(401,'terminal_enrollment_required');
    const assignment=(await c.query(`SELECT
        EXISTS(SELECT 1 FROM myfin.staff_location_assignments WHERE company_id=$1 AND identity_id=$2 AND revoked_at IS NULL) AS restricted,
        EXISTS(SELECT 1 FROM myfin.staff_location_assignments WHERE company_id=$1 AND identity_id=$2
          AND store_location_id=$3 AND revoked_at IS NULL) AS assigned`,
    [companyId,req.identity.id,terminal.store_location_id])).rows[0];
    if(assignment?.restricted&&!assignment?.assigned)v.fail(403,'terminal_location_not_assigned');
    const capabilities=terminal.capabilities||[],allowed=purpose==='staff'
      ? capabilities.some(item=>['pos','admin'].includes(item)) : capabilities.includes('pos');
    if(!allowed)v.fail(403,'terminal_capability_required');
    const session=(await c.query(`SELECT * FROM myfin.terminal_staff_sessions WHERE company_id=$1 AND id=$2
      AND terminal_id=$3 AND store_id=$4 AND store_location_id=$5 AND identity_id=$6 AND status='active'
      FOR SHARE`,[companyId,req.identity.staffSessionId,terminal.id,terminal.store_id,
      terminal.store_location_id,req.identity.id])).rows[0];
    if(!session)v.fail(403,'terminal_staff_session_required');
    const work=session.work_shift_id?(await c.query(`SELECT * FROM myfin.staff_work_shifts WHERE company_id=$1
      AND id=$2 AND identity_id=$3 FOR SHARE`,[companyId,session.work_shift_id,req.identity.id])).rows[0]||null:null;
    const register=(await c.query(`SELECT r.*,coalesce(sum(e.amount_sen),0) AS current_expected_cash_sen
      FROM myfin.register_shifts r LEFT JOIN myfin.register_cash_entries e
        ON e.company_id=r.company_id AND e.register_shift_id=r.id
      WHERE r.company_id=$1 AND r.terminal_id=$2 AND r.status='open'
      GROUP BY r.company_id,r.id`,[companyId,terminal.id])).rows[0]||null;
    Object.assign(req.identity,terminalPrincipalContext({...terminal,
      context:req.identity.terminalContext||req.enrolledTerminal?.context},{session,work,register}));
    return req.identity;
  }
  if(!req.enrolledTerminal)return req.identity;
  const bound=await bindTerminalStaffSession(c,req.enrolledTerminal,req.identity),terminal={...req.enrolledTerminal,...bound.terminal,
    context:req.enrolledTerminal.context};
  const capabilities=terminal.capabilities||[],allowed=purpose==='staff'
    ? capabilities.some(item=>['pos','admin'].includes(item)) : capabilities.includes('pos');
  if(!allowed)v.fail(403,'terminal_capability_required');
  Object.assign(req.identity,terminalPrincipalContext(terminal,bound));
  return req.identity;
}

export async function endTerminalStaffSession(c, companyId, staffSessionId, reason='sign_out') {
  if(!staffSessionId)return;
  await c.query(`UPDATE myfin.terminal_staff_sessions SET status='ended',ended_at=now(),ended_reason=$3
    WHERE company_id=$1 AND id=$2 AND status='active'`,[companyId,staffSessionId,reason]);
}

export function registerTerminalPublic(app,{db,authOptions}) {
  const publicPolicy=async companyId=>{
    const row=(await db.query(`SELECT terminal_enforcement_enabled,terminal_enforcement_from,
      require_open_register_for_pos,require_open_register_from FROM myfin.companies WHERE id=$1`,[companyId])).rows[0]||{};
    return {terminalEnforcement:row.terminal_enforcement_enabled===true,
      terminalEnforcementFrom:row.terminal_enforcement_from||null,
      requireOpenRegisterForPos:row.require_open_register_for_pos===true,
      requireOpenRegisterFrom:row.require_open_register_from||null};
  };
  app.post('/api/terminal-enrollment/claim',{config:{rateLimit:{max:10,timeWindow:60000}}},async(req,reply)=>{
    if(!authOptions?.pos||req.tenant?.surface!=='tenant'||!req.tenant.canonical)
      return reply.code(404).send({error:'not_found'});
    const body=v.parse(z.strictObject({
      token:z.string().trim().min(12).max(20).transform(normalizeEnrollmentToken).refine(value=>/^[0-9A-HJKMNP-TV-Z]{12}$/.test(value)),
      device:z.strictObject({
        label:z.string().trim().max(120).optional(), platform:z.string().trim().max(120).optional(),
        appVersion:z.string().trim().max(64).optional(),
      }).optional(),
    }),req.body);
    const companyId=req.tenant.company_id;
    const digest=terminalEnrollmentDigest(authOptions,companyId,body.token);
    const result=await db.transaction(async c=>{
      const row=(await c.query(`SELECT e.*,t.*,s.code AS store_code,s.name AS store_name,s.time_zone,
          l.code AS location_code,l.name AS location_name,l.type AS location_type,
          co.terminal_enforcement_enabled,co.terminal_enforcement_from,co.require_open_register_for_pos,
          co.require_open_register_from
        FROM myfin.terminal_enrollment_credentials e
        JOIN myfin.terminals t ON t.company_id=e.company_id AND t.id=e.terminal_id
        JOIN myfin.stores s ON s.company_id=t.company_id AND s.id=t.store_id AND s.status='active'
        JOIN myfin.store_locations l ON l.company_id=t.company_id AND l.store_id=t.store_id
          AND l.id=t.store_location_id AND l.status='active'
        JOIN myfin.companies co ON co.id=t.company_id
        WHERE e.token_digest=$1 AND e.company_id=$2 AND e.claimed_at IS NULL AND e.revoked_at IS NULL
          AND e.expires_at>now() AND t.status IN ('pending','active') FOR UPDATE OF e,t`,[digest,companyId])).rows[0];
      if(!row)v.fail(401,'terminal_enrollment_invalid');
      await assertTerminalIdleForEnrollment(c,companyId,row.terminal_id);
      const secret=randomBytes(32).toString('base64url'),version=Number(row.credential_version)+1;
      const terminalDigest=terminalCredentialDigest(authOptions,companyId,secret);
      await c.query(`UPDATE myfin.terminal_credentials SET revoked_at=coalesce(revoked_at,now())
        WHERE company_id=$1 AND terminal_id=$2 AND revoked_at IS NULL`,[companyId,row.terminal_id]);
      await c.query(`INSERT INTO myfin.terminal_credentials(company_id,terminal_id,version,secret_digest)
        VALUES($1,$2,$3,$4)`,[companyId,row.terminal_id,version,terminalDigest]);
      await c.query(`UPDATE myfin.terminal_enrollment_credentials SET claimed_at=now() WHERE token_digest=$1`,[digest]);
      const profile={...(row.device_profile||{}),...(body.device||{})};
      const terminal=(await c.query(`UPDATE myfin.terminals SET status='active',credential_version=$3,
          device_profile=$4,enrolled_at=now(),last_seen_at=now(),revoked_at=NULL,revoked_by=NULL,
          version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *`,
      [companyId,row.terminal_id,version,profile])).rows[0];
      await c.query(`INSERT INTO myfin.terminal_events(company_id,id,terminal_id,action,details)
        VALUES($1,$2,$3,'enrolled',$4)`,[companyId,randomUUID(),row.terminal_id,{credentialVersion:version}]);
      return {secret,version,row:{...row,...terminal}};
    });
    reply.header('set-cookie',terminalCookie(result.row.id,result.secret,authOptions.secure));
    return {terminalContext:terminalContextOutput(result.row),terminal:terminalOutput(result.row),
      credential:{terminalId:result.row.id,version:result.version,storage:'http_only_cookie'}};
  });

  app.get('/api/terminal-context',async(req,reply)=>{
    if(req.tenant?.surface!=='tenant'||!req.tenant.company_id)return reply.code(404).send({error:'not_found'});
    const terminal=await resolveTerminalContext(db,req,authOptions);
    if(!terminal){reply.header('set-cookie',clearTerminalCookie(authOptions.secure));return reply.code(401).send({
      error:'terminal_enrollment_required',policy:await publicPolicy(req.tenant?.company_id)});}
    const shifts=await db.transaction(c=>activeShiftContext(c,terminal.company_id,terminal.id,null));
    return {...terminal.context,staffSession:staffSessionOutput(shifts.session),
      workShift:workShiftOutput(shifts.work),registerShift:registerShiftOutput(shifts.register)};
  });

  app.post('/api/terminal-context/heartbeat',{config:{rateLimit:{max:60,timeWindow:60000}}},async(req,reply)=>{
    if(req.tenant?.surface!=='tenant'||!req.tenant.company_id)return reply.code(404).send({error:'not_found'});
    const terminal=await resolveTerminalContext(db,req,authOptions,{touch:false});
    if(!terminal){reply.header('set-cookie',clearTerminalCookie(authOptions.secure));return reply.code(401).send({
      error:'terminal_enrollment_required',policy:await publicPolicy(req.tenant?.company_id)});}
    const body=v.parse(z.strictObject({
      appVersion:z.string().trim().max(64).optional(),
      state:z.enum(['online','idle','busy']).optional(),
      connectivity:z.enum(['online','degraded']).optional(),
    }),req.body||{});
    const row=(await db.query(`UPDATE myfin.terminals SET last_seen_at=now(),device_profile=device_profile||$3::jsonb,
        updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *`,
    [terminal.company_id,terminal.id,body])).rows[0];
    await db.query(`UPDATE myfin.terminal_credentials SET last_used_at=now()
      WHERE company_id=$1 AND terminal_id=$2 AND version=$3`,
    [terminal.company_id,terminal.id,terminal.credential_version]);
    const shifts=await db.transaction(c=>activeShiftContext(c,terminal.company_id,terminal.id,null));
    return {...terminal.context,terminal:terminalOutput({...terminal,...row}),
      staffSession:staffSessionOutput(shifts.session),workShift:workShiftOutput(shifts.work),
      registerShift:registerShiftOutput(shifts.register)};
  });
}

const validTimeZone = value => { try { new Intl.DateTimeFormat('en',{timeZone:value}); return true; } catch { return false; } };
const storeCreate = z.strictObject({
  code,name:z.string().trim().min(1).max(120),
  type:z.enum(['outlet','branch','kiosk','warehouse','office','pop_up']).default('outlet'),
  timeZone:z.string().trim().min(1).max(80).refine(validTimeZone).default('Asia/Kuala_Lumpur'),
  address:jsonObject.default({}),phone:z.string().trim().max(80).default(''),email:z.union([z.literal(''),z.email().max(254)]).default(''),
  latitude:z.number().min(-90).max(90).nullable().default(null),longitude:z.number().min(-180).max(180).nullable().default(null),
  geofenceRadiusM:z.number().int().min(10).max(100000).nullable().default(null),
}).refine(data=>(data.latitude===null&&data.longitude===null&&data.geofenceRadiusM===null)||
  (data.latitude!==null&&data.longitude!==null&&data.geofenceRadiusM!==null));
const storeUpdate = z.strictObject({
  version:z.number().int().positive(),code:code.optional(),name:z.string().trim().min(1).max(120).optional(),
  type:z.enum(['outlet','branch','kiosk','warehouse','office','pop_up']).optional(),
  status:z.enum(['active','suspended','closed']).optional(),timeZone:z.string().trim().min(1).max(80).refine(validTimeZone).optional(),
  address:jsonObject.optional(),phone:z.string().trim().max(80).optional(),email:z.union([z.literal(''),z.email().max(254)]).optional(),
  latitude:z.number().min(-90).max(90).nullable().optional(),longitude:z.number().min(-180).max(180).nullable().optional(),
  geofenceRadiusM:z.number().int().min(10).max(100000).nullable().optional(),
});
const locationCreate = z.strictObject({
  storeId:v.id,code,name:z.string().trim().min(1).max(120),
  type:z.enum(['front_counter','kitchen','stockroom','office','service_area','other']).default('front_counter'),
  customerFacing:z.boolean().default(false),
});
const locationUpdate = z.strictObject({
  version:z.number().int().positive(),storeId:v.id.optional(),code:code.optional(),name:z.string().trim().min(1).max(120).optional(),
  type:z.enum(['front_counter','kitchen','stockroom','office','service_area','other']).optional(),
  status:z.enum(['active','suspended','closed']).optional(),customerFacing:z.boolean().optional(),
});
const terminalCreate = z.strictObject({
  storeId:v.id,locationId:v.id,code,name:z.string().trim().min(1).max(120),type:z.enum(terminalTypes).default('pos'),
  capabilities:z.array(z.enum(terminalCapabilities)).max(6).optional(),
});
const terminalUpdate = z.strictObject({
  version:z.number().int().positive(),storeId:v.id.optional(),locationId:v.id.optional(),code:code.optional(),
  name:z.string().trim().min(1).max(120).optional(),type:z.enum(terminalTypes).optional(),
  status:z.enum(['pending','active','suspended','retired']).optional(),
  capabilities:z.array(z.enum(terminalCapabilities)).max(6).optional(),
});

async function revokeTerminalAccess(c,companyId,terminalId,reason){
  await c.query(`UPDATE myfin.terminal_credentials SET revoked_at=coalesce(revoked_at,now())
    WHERE company_id=$1 AND terminal_id=$2`,[companyId,terminalId]);
  await c.query(`UPDATE myfin.terminal_enrollment_credentials SET revoked_at=coalesce(revoked_at,now())
    WHERE company_id=$1 AND terminal_id=$2 AND claimed_at IS NULL`,[companyId,terminalId]);
  await c.query(`UPDATE myfin.pos_sessions SET revoked_at=coalesce(revoked_at,now())
    WHERE company_id=$1 AND terminal_id=$2 AND revoked_at IS NULL`,[companyId,terminalId]);
  await c.query(`UPDATE myfin.terminal_staff_sessions SET status='ended',ended_at=now(),ended_reason=$3
    WHERE company_id=$1 AND terminal_id=$2 AND status='active'`,[companyId,terminalId,reason]);
}

async function assertTerminalIdleForEnrollment(c,companyId,terminalId){
  const active=(await c.query(`SELECT EXISTS(
      SELECT 1 FROM myfin.register_shifts WHERE company_id=$1 AND terminal_id=$2 AND status='open'
      UNION ALL
      SELECT 1 FROM myfin.terminal_staff_sessions WHERE company_id=$1 AND terminal_id=$2 AND status='active'
    ) AS found`,[companyId,terminalId])).rows[0]?.found;
  if(active)v.fail(409,'terminal_has_active_operations');
}

async function lockTerminalPolicy(c,companyId,mode='SHARE'){
  return (await c.query(`SELECT terminal_enforcement_enabled FROM myfin.companies WHERE id=$1 FOR ${mode}`,
    [companyId])).rows[0]||{};
}

async function assertUsablePosTerminalRemains(c,companyId,terminalId,prior,next){
  const wasUsable=prior.status==='active'&&(prior.capabilities||[]).includes('pos')&&Number(prior.credential_version)>0&&
    (await c.query(`SELECT 1 FROM myfin.terminal_credentials WHERE company_id=$1 AND terminal_id=$2
      AND version=$3 AND revoked_at IS NULL`,[companyId,terminalId,prior.credential_version])).rowCount>0;
  const remainsUsable=next.status==='active'&&(next.capabilities||[]).includes('pos')&&wasUsable;
  if(!wasUsable||remainsUsable)return;
  const other=(await c.query(`SELECT 1 FROM myfin.terminals t WHERE t.company_id=$1 AND t.id<>$2
      AND t.status='active' AND t.capabilities ? 'pos' AND t.credential_version>0
      AND EXISTS(SELECT 1 FROM myfin.terminal_credentials k WHERE k.company_id=t.company_id
        AND k.terminal_id=t.id AND k.version=t.credential_version AND k.revoked_at IS NULL) LIMIT 1`,
  [companyId,terminalId])).rowCount>0;
  if(!other)v.fail(409,'last_active_pos_terminal_required');
}

async function storeNetwork(c, companyId) {
  const company=(await c.query(`SELECT terminal_enforcement_enabled,terminal_enforcement_from,
    require_open_register_for_pos,require_open_register_from FROM myfin.companies WHERE id=$1`,[companyId])).rows[0];
  const stores=(await c.query(`SELECT * FROM myfin.stores WHERE company_id=$1 ORDER BY name,id`,[companyId])).rows;
  const locations=(await c.query(`SELECT * FROM myfin.store_locations WHERE company_id=$1 ORDER BY store_id,name,id`,[companyId])).rows;
  const terminals=(await c.query(`SELECT t.*,ss.id AS current_staff_session_id,ss.identity_id AS current_identity_id,
      i.display_name AS current_staff_name,ss.work_shift_id AS current_work_shift_id,
      ws.status AS current_work_shift_status,rs.id AS open_register_shift_id
    FROM myfin.terminals t
    LEFT JOIN myfin.terminal_staff_sessions ss ON ss.company_id=t.company_id AND ss.terminal_id=t.id AND ss.status='active'
    LEFT JOIN myfin.app_identities i ON i.id=ss.identity_id
    LEFT JOIN myfin.staff_work_shifts ws ON ws.company_id=ss.company_id AND ws.id=ss.work_shift_id
    LEFT JOIN myfin.register_shifts rs ON rs.company_id=t.company_id AND rs.terminal_id=t.id AND rs.status='open'
    WHERE t.company_id=$1 ORDER BY t.store_id,t.store_location_id,t.name,t.id`,[companyId])).rows;
  const assignments=(await c.query(`SELECT a.identity_id,a.store_id,a.store_location_id,i.display_name
    FROM myfin.staff_location_assignments a JOIN myfin.app_identities i ON i.id=a.identity_id
    WHERE a.company_id=$1 AND a.revoked_at IS NULL ORDER BY i.display_name,a.store_location_id`,[companyId])).rows;
  const shopLocations=(await c.query(`SELECT id,name,fulfillment_mode,active,store_id,store_location_id
    FROM myfin.shop_locations WHERE company_id=$1 ORDER BY created_at,id`,[companyId])).rows;
  return {policy:{terminalEnforcement:company.terminal_enforcement_enabled,
      terminalEnforcementFrom:company.terminal_enforcement_from,
      requireOpenRegisterForPos:company.require_open_register_for_pos,
      requireOpenRegisterFrom:company.require_open_register_from},
    stores:stores.map(storeOutput),locations:locations.map(locationOutput),terminals:terminals.map(terminalOutput),
    shopLocations:shopLocations.map(row=>({id:row.id,name:row.name,fulfillmentMode:row.fulfillment_mode,
      active:row.active,storeId:row.store_id||'',locationId:row.store_location_id||''})),
    staffAssignments:[...assignments.reduce((map,row)=>{
      const item=map.get(row.identity_id)||{identityId:row.identity_id,displayName:row.display_name||'',locationIds:[]};
      item.locationIds.push(row.store_location_id);map.set(row.identity_id,item);return map;
    },new Map()).values()]};
}

function managementAccess(req){requirePasswordSession(req);requireCapability(req.identity,'storeNetworkManage');}
async function terminalActor(c,req,{purpose='pos'}={}){
  requireCapability(req.identity,purpose==='staff'?'shiftOperate':'checkout');
  await ensureRequestTerminalStaff(c,req,{purpose});
  if(!req.identity.terminalId||!req.identity.staffSessionId)
    v.fail(403,'terminal_staff_session_required');
  return req.identity;
}

export function registerTerminalOperations(app,{db,scoped,audit,authOptions}) {
  app.post('/api/terminal-context/staff-sign-out',async req=>{
    v.parse(z.strictObject({}),req.body||{});
    if(!req.identity||req.identity.authLevel==='pos_code'||req.tenant?.surface!=='tenant')
      v.fail(401,'password_session_required');
    const terminal=await resolveTerminalContext(db,req,authOptions,{touch:false});
    if(!terminal)v.fail(401,'terminal_enrollment_required');
    return db.transaction(async c=>{
      const ended=(await c.query(`UPDATE myfin.terminal_staff_sessions SET status='ended',ended_at=now(),
          ended_reason='staff_sign_out' WHERE company_id=$1 AND terminal_id=$2 AND identity_id=$3
          AND status='active' RETURNING id`,[terminal.company_id,terminal.id,req.identity.id])).rows[0];
      if(ended)await c.query(`INSERT INTO myfin.terminal_events(company_id,id,terminal_id,action,actor_id,details)
        VALUES($1,$2,$3,'staff_sign_out',$4,$5)`,[terminal.company_id,randomUUID(),terminal.id,req.identity.id,
        {staffSessionId:ended.id}]);
      return {ok:true};
    });
  });
  app.get('/api/companies/:company/store-network',req=>scoped(req,async(c,co)=>{
    requireCapability(req.identity,'storeNetworkRead');return storeNetwork(c,co);
  }));
  app.put('/api/companies/:company/store-network',req=>scoped(req,async(c,co)=>{
    requirePasswordSession(req);requireCapability(req.identity,'networkPolicyManage');
    const body=v.parse(z.strictObject({terminalEnforcement:z.boolean(),requireOpenRegisterForPos:z.boolean()}),req.body);
    await lockTerminalPolicy(c,co,'UPDATE');
    if(body.terminalEnforcement){
      const count=(await c.query(`SELECT count(*)::int AS count FROM myfin.terminals t
        WHERE t.company_id=$1 AND t.status='active' AND t.capabilities ? 'pos'
          AND t.credential_version>0 AND EXISTS(SELECT 1 FROM myfin.terminal_credentials k
            WHERE k.company_id=t.company_id AND k.terminal_id=t.id AND k.version=t.credential_version
              AND k.revoked_at IS NULL)`,[co])).rows[0]?.count||0;
      if(!count)v.fail(409,'active_pos_terminal_required');
    }
    await c.query(`UPDATE myfin.companies SET terminal_enforcement_enabled=$2,
      terminal_enforcement_from=CASE WHEN $2 AND NOT terminal_enforcement_enabled THEN now()
        WHEN $2 THEN terminal_enforcement_from ELSE NULL END,
      require_open_register_for_pos=CASE WHEN $2 THEN $3 ELSE false END,
      require_open_register_from=CASE
        WHEN $2 AND $3 AND NOT require_open_register_for_pos THEN now()
        WHEN $2 AND $3 THEN require_open_register_from ELSE NULL END
      WHERE id=$1`,
    [co,body.terminalEnforcement,body.requireOpenRegisterForPos]);
    await audit(c,req.identity,co,'Update terminal policy',body.terminalEnforcement?'Enabled terminal enforcement':'Disabled terminal enforcement',co);
    return storeNetwork(c,co);
  }));

  app.post('/api/companies/:company/store-network/stores',req=>scoped(req,async(c,co)=>{
    managementAccess(req);const body=v.parse(storeCreate,req.body),id=randomUUID();
    const row=(await c.query(`INSERT INTO myfin.stores(company_id,id,code,name,type,time_zone,address,phone,email,
        latitude,longitude,geofence_radius_m,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [co,id,body.code,body.name,body.type,body.timeZone,body.address,body.phone,body.email,body.latitude,body.longitude,body.geofenceRadiusM,req.identity.id])).rows[0];
    await audit(c,req.identity,co,'Create store',row.name,row.id);return {store:storeOutput(row)};
  }));
  app.patch('/api/companies/:company/store-network/stores/:id',req=>scoped(req,async(c,co)=>{
    managementAccess(req);const id=v.parse(v.id,req.params.id),body=v.parse(storeUpdate,req.body);
    const prior=(await c.query('SELECT * FROM myfin.stores WHERE company_id=$1 AND id=$2 FOR UPDATE',[co,id])).rows[0];
    if(!prior)v.fail(404,'store_not_found');if(Number(prior.version)!==body.version)v.fail(409,'record_conflict');
    const next={...prior,code:body.code??prior.code,name:body.name??prior.name,type:body.type??prior.type,status:body.status??prior.status,
      time_zone:body.timeZone??prior.time_zone,address:body.address??prior.address,phone:body.phone??prior.phone,email:body.email??prior.email,
      latitude:body.latitude===undefined?prior.latitude:body.latitude,longitude:body.longitude===undefined?prior.longitude:body.longitude,
      geofence_radius_m:body.geofenceRadiusM===undefined?prior.geofence_radius_m:body.geofenceRadiusM};
    if((next.latitude===null)!==(next.longitude===null)||(next.latitude===null)!==(next.geofence_radius_m===null))v.fail(400,'invalid_geofence');
    if(prior.status==='active'&&next.status!=='active'){
      const dependent=(await c.query(`SELECT EXISTS(
        SELECT 1 FROM myfin.terminals WHERE company_id=$1 AND store_id=$2 AND status='active'
        UNION ALL SELECT 1 FROM myfin.staff_work_shifts WHERE company_id=$1 AND store_id=$2 AND status IN ('open','on_break')
        UNION ALL SELECT 1 FROM myfin.register_shifts WHERE company_id=$1 AND store_id=$2 AND status='open'
        UNION ALL SELECT 1 FROM myfin.shop_locations WHERE company_id=$1 AND store_id=$2 AND active) AS found`,[co,id])).rows[0]?.found;
      if(dependent)v.fail(409,'store_has_active_operations');
    }
    const row=(await c.query(`UPDATE myfin.stores SET code=$3,name=$4,type=$5,status=$6,time_zone=$7,address=$8,
      phone=$9,email=$10,latitude=$11,longitude=$12,geofence_radius_m=$13,version=version+1,updated_at=now(),
      archived_at=CASE WHEN $6='closed' THEN coalesce(archived_at,now()) ELSE NULL END WHERE company_id=$1 AND id=$2 RETURNING *`,
    [co,id,next.code,next.name,next.type,next.status,next.time_zone,next.address,next.phone,next.email,next.latitude,next.longitude,next.geofence_radius_m])).rows[0];
    await audit(c,req.identity,co,'Update store',row.name,row.id);return {store:storeOutput(row)};
  }));

  app.post('/api/companies/:company/store-network/locations',req=>scoped(req,async(c,co)=>{
    managementAccess(req);const body=v.parse(locationCreate,req.body),id=randomUUID();
    const parent=(await c.query(`SELECT id FROM myfin.stores WHERE company_id=$1 AND id=$2 AND status='active'`,[co,body.storeId])).rows[0];
    if(!parent)v.fail(409,'active_store_required');
    const row=(await c.query(`INSERT INTO myfin.store_locations(company_id,id,store_id,code,name,type,customer_facing,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[co,id,body.storeId,body.code,body.name,body.type,body.customerFacing,req.identity.id])).rows[0];
    await audit(c,req.identity,co,'Create store location',row.name,row.id);return {location:locationOutput(row)};
  }));
  app.patch('/api/companies/:company/store-network/locations/:id',req=>scoped(req,async(c,co)=>{
    managementAccess(req);const id=v.parse(v.id,req.params.id),body=v.parse(locationUpdate,req.body);
    const prior=(await c.query('SELECT * FROM myfin.store_locations WHERE company_id=$1 AND id=$2 FOR UPDATE',[co,id])).rows[0];
    if(!prior)v.fail(404,'store_location_not_found');if(Number(prior.version)!==body.version)v.fail(409,'record_conflict');
    const nextStoreId=body.storeId??prior.store_id,nextStatus=body.status??prior.status;
    if(nextStoreId!==prior.store_id){
      const parent=(await c.query(`SELECT id FROM myfin.stores WHERE company_id=$1 AND id=$2 AND status='active'`,[co,nextStoreId])).rows[0];
      if(!parent)v.fail(409,'active_store_required');
      const used=(await c.query(`SELECT EXISTS(
        SELECT 1 FROM myfin.terminals WHERE company_id=$1 AND store_location_id=$2
        UNION ALL SELECT 1 FROM myfin.staff_location_assignments WHERE company_id=$1 AND store_location_id=$2
        UNION ALL SELECT 1 FROM myfin.staff_work_shifts WHERE company_id=$1 AND store_location_id=$2
        UNION ALL SELECT 1 FROM myfin.register_shifts WHERE company_id=$1 AND store_location_id=$2) AS found`,[co,id])).rows[0]?.found;
      if(used)v.fail(409,'store_location_has_history');
    }
    if(prior.status==='active'&&nextStatus!=='active'){
      const dependent=(await c.query(`SELECT EXISTS(
        SELECT 1 FROM myfin.terminals WHERE company_id=$1 AND store_location_id=$2 AND status='active'
        UNION ALL SELECT 1 FROM myfin.staff_work_shifts WHERE company_id=$1 AND store_location_id=$2 AND status IN ('open','on_break')
        UNION ALL SELECT 1 FROM myfin.register_shifts WHERE company_id=$1 AND store_location_id=$2 AND status='open'
        UNION ALL SELECT 1 FROM myfin.shop_locations WHERE company_id=$1 AND store_location_id=$2 AND active) AS found`,[co,id])).rows[0]?.found;
      if(dependent)v.fail(409,'store_location_has_active_operations');
    }
    const row=(await c.query(`UPDATE myfin.store_locations SET store_id=$3,code=$4,name=$5,type=$6,status=$7,
      customer_facing=$8,version=version+1,updated_at=now(),archived_at=CASE WHEN $7='closed' THEN coalesce(archived_at,now()) ELSE NULL END
      WHERE company_id=$1 AND id=$2 RETURNING *`,[co,id,nextStoreId,body.code??prior.code,body.name??prior.name,
      body.type??prior.type,body.status??prior.status,body.customerFacing??prior.customer_facing])).rows[0];
    await audit(c,req.identity,co,'Update store location',row.name,row.id);return {location:locationOutput(row)};
  }));

  app.post('/api/companies/:company/store-network/terminals',req=>scoped(req,async(c,co)=>{
    managementAccess(req);const body=v.parse(terminalCreate,req.body),id=randomUUID(),
      capabilities=[...new Set(body.capabilities??defaultTerminalCapabilities(body.type))];
    const parent=(await c.query(`SELECT l.id FROM myfin.store_locations l JOIN myfin.stores s
      ON s.company_id=l.company_id AND s.id=l.store_id AND s.status='active'
      WHERE l.company_id=$1 AND l.store_id=$2 AND l.id=$3 AND l.status='active'`,[co,body.storeId,body.locationId])).rows[0];
    if(!parent)v.fail(409,'active_store_location_required');
    const row=(await c.query(`INSERT INTO myfin.terminals(company_id,id,store_id,store_location_id,code,name,type,capabilities,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[co,id,body.storeId,body.locationId,body.code,body.name,body.type,capabilities,req.identity.id])).rows[0];
    await c.query(`INSERT INTO myfin.terminal_events(company_id,id,terminal_id,action,actor_id,details)
      VALUES($1,$2,$3,'created',$4,$5)`,[co,randomUUID(),id,req.identity.id,{storeId:body.storeId,locationId:body.locationId}]);
    await audit(c,req.identity,co,'Create terminal',row.name,row.id);return {terminal:terminalOutput(row)};
  }));
  app.patch('/api/companies/:company/store-network/terminals/:id',req=>scoped(req,async(c,co)=>{
    managementAccess(req);const id=v.parse(v.id,req.params.id),body=v.parse(terminalUpdate,req.body);
    const policy=await lockTerminalPolicy(c,co);
    const prior=(await c.query('SELECT * FROM myfin.terminals WHERE company_id=$1 AND id=$2 FOR UPDATE',[co,id])).rows[0];
    if(!prior)v.fail(404,'terminal_not_found');if(Number(prior.version)!==body.version)v.fail(409,'record_conflict');
    if(body.status==='active'&&prior.status!=='active')v.fail(409,'terminal_activation_requires_enrollment');
    const relocating=(body.storeId&&body.storeId!==prior.store_id)||(body.locationId&&body.locationId!==prior.store_location_id);
    if(relocating&&Number(prior.credential_version)>0)v.fail(409,'enrolled_terminal_cannot_be_relocated');
    const nextStatus=body.status??prior.status,nextCapabilities=body.capabilities?[...new Set(body.capabilities)]:prior.capabilities,
      leavingActive=prior.status==='active'&&nextStatus!=='active';
    if(policy.terminal_enforcement_enabled)await assertUsablePosTerminalRemains(c,co,id,prior,
      {...prior,status:nextStatus,capabilities:nextCapabilities});
    const losesLiveAuthority=prior.status==='active'&&nextStatus==='active'&&(
      ((prior.capabilities||[]).includes('pos')&&!nextCapabilities.includes('pos'))||
      ((prior.capabilities||[]).includes('admin')&&!nextCapabilities.some(item=>['pos','admin'].includes(item))));
    if(losesLiveAuthority)await assertTerminalIdleForEnrollment(c,co,id);
    if(leavingActive){
      const open=(await c.query(`SELECT id FROM myfin.register_shifts WHERE company_id=$1 AND terminal_id=$2
        AND status='open' FOR SHARE`,[co,id])).rows[0];
      if(open)v.fail(409,'terminal_register_shift_open');
      await revokeTerminalAccess(c,co,id,`terminal_${nextStatus}`);
    }else if(relocating){
      await c.query(`UPDATE myfin.terminal_enrollment_credentials SET revoked_at=coalesce(revoked_at,now())
        WHERE company_id=$1 AND terminal_id=$2 AND claimed_at IS NULL`,[co,id]);
    }
    const row=(await c.query(`UPDATE myfin.terminals SET store_id=$3,store_location_id=$4,code=$5,name=$6,type=$7,
      status=$8,capabilities=$9,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *`,
    [co,id,body.storeId??prior.store_id,body.locationId??prior.store_location_id,body.code??prior.code,body.name??prior.name,
      body.type??prior.type,body.status??prior.status,nextCapabilities])).rows[0];
    await c.query(`INSERT INTO myfin.terminal_events(company_id,id,terminal_id,action,actor_id,details)
      VALUES($1,$2,$3,'updated',$4,$5)`,[co,randomUUID(),id,req.identity.id,{status:row.status,version:Number(row.version)}]);
    await audit(c,req.identity,co,'Update terminal',row.name,row.id);return {terminal:terminalOutput(row)};
  }));
  app.delete('/api/companies/:company/store-network/terminals/:id',req=>scoped(req,async(c,co)=>{
    managementAccess(req);const id=v.parse(v.id,req.params.id);
    const policy=await lockTerminalPolicy(c,co),prior=(await c.query(
      'SELECT * FROM myfin.terminals WHERE company_id=$1 AND id=$2 FOR UPDATE',[co,id])).rows[0];
    if(!prior)v.fail(404,'terminal_not_found');
    if(policy.terminal_enforcement_enabled)await assertUsablePosTerminalRemains(c,co,id,prior,
      {...prior,status:'revoked'});
    const open=(await c.query(`SELECT id FROM myfin.register_shifts WHERE company_id=$1 AND terminal_id=$2
      AND status='open' FOR SHARE`,[co,id])).rows[0];
    if(open)v.fail(409,'terminal_register_shift_open');
    const row=(await c.query(`UPDATE myfin.terminals SET status='revoked',revoked_at=now(),revoked_by=$3,
      version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 AND status<>'revoked' RETURNING *`,[co,id,req.identity.id])).rows[0];
    if(!row)v.fail(404,'terminal_not_found');
    await revokeTerminalAccess(c,co,id,'terminal_revoked');
    await c.query(`INSERT INTO myfin.terminal_events(company_id,id,terminal_id,action,actor_id,details)
      VALUES($1,$2,$3,'revoked',$4,'{}')`,[co,randomUUID(),id,req.identity.id]);
    await audit(c,req.identity,co,'Revoke terminal',row.name,row.id);return {ok:true};
  }));
  app.post('/api/companies/:company/store-network/terminals/:id/enrollment',req=>scoped(req,async(c,co)=>{
    managementAccess(req);const id=v.parse(v.id,req.params.id),{expiresInMinutes}=v.parse(z.strictObject({
      expiresInMinutes:z.number().int().min(5).max(1440).default(15),
    }),req.body||{});
    const terminal=(await c.query(`SELECT * FROM myfin.terminals WHERE company_id=$1 AND id=$2
      AND status IN ('pending','active') FOR UPDATE`,[co,id])).rows[0];
    if(!terminal)v.fail(404,'terminal_not_enrollable');
    await assertTerminalIdleForEnrollment(c,co,id);
    const rawToken=enrollmentToken(),token=`${rawToken.slice(0,4)}-${rawToken.slice(4,8)}-${rawToken.slice(8)}`,
      digest=terminalEnrollmentDigest(authOptions,co,rawToken);
    await c.query(`UPDATE myfin.terminal_enrollment_credentials SET revoked_at=coalesce(revoked_at,now())
      WHERE company_id=$1 AND terminal_id=$2 AND claimed_at IS NULL AND revoked_at IS NULL`,[co,id]);
    const enrollment=(await c.query(`INSERT INTO myfin.terminal_enrollment_credentials(token_digest,company_id,terminal_id,
      token_hint,created_by,expires_at) VALUES($1,$2,$3,$4,$5,now()+($6*interval '1 minute')) RETURNING expires_at`,
    [digest,co,id,rawToken.slice(-4),req.identity.id,expiresInMinutes])).rows[0];
    await c.query(`INSERT INTO myfin.terminal_events(company_id,id,terminal_id,action,actor_id,details)
      VALUES($1,$2,$3,'enrollment_issued',$4,$5)`,[co,randomUUID(),id,req.identity.id,{expiresAt:enrollment.expires_at}]);
    return {terminalId:id,token,expiresAt:enrollment.expires_at};
  }));

  app.put('/api/companies/:company/store-network/staff/:identity/assignments',req=>scoped(req,async(c,co)=>{
    managementAccess(req);requireCapability(req.identity,'usersManage');
    const identityId=v.parse(v.id,req.params.identity),{locationIds}=v.parse(z.strictObject({locationIds:z.array(v.id).max(100)}),req.body);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,49))',[`${co}:identity:${identityId}`]);
    const membership=(await c.query(`SELECT role FROM myfin.memberships WHERE company_id=$1 AND identity_id=$2
      AND role IN ('manager','operator')`,[co,identityId])).rows[0];
    if(!membership)v.fail(404,'staff_member_not_found');
    if(membership.role==='manager')requireCapability(req.identity,'managersManage');
    const unique=[...new Set(locationIds)];
    const locations=unique.length?(await c.query(`SELECT id,store_id FROM myfin.store_locations
      WHERE company_id=$1 AND id=ANY($2::text[]) AND status='active'`,[co,unique])).rows:[];
    if(locations.length!==unique.length)v.fail(404,'store_location_not_found');
    await c.query(`UPDATE myfin.staff_location_assignments SET revoked_at=coalesce(revoked_at,now())
      WHERE company_id=$1 AND identity_id=$2 AND revoked_at IS NULL`,[co,identityId]);
    for(const location of locations)await c.query(`INSERT INTO myfin.staff_location_assignments(company_id,identity_id,store_id,
      store_location_id,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(company_id,identity_id,store_location_id)
      DO UPDATE SET store_id=EXCLUDED.store_id,created_by=EXCLUDED.created_by,created_at=now(),revoked_at=NULL`,
    [co,identityId,location.store_id,location.id,req.identity.id]);
    const ended=(await c.query(`UPDATE myfin.terminal_staff_sessions ss SET status='ended',ended_at=now(),
        ended_reason='location_assignment_changed' WHERE ss.company_id=$1 AND ss.identity_id=$2 AND ss.status='active'
        AND EXISTS(SELECT 1 FROM myfin.staff_location_assignments any_scope WHERE any_scope.company_id=ss.company_id
          AND any_scope.identity_id=ss.identity_id AND any_scope.revoked_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM myfin.staff_location_assignments allowed WHERE allowed.company_id=ss.company_id
          AND allowed.identity_id=ss.identity_id AND allowed.store_location_id=ss.store_location_id
          AND allowed.revoked_at IS NULL) RETURNING ss.id`,[co,identityId])).rows;
    if(ended.length)await c.query(`UPDATE myfin.pos_sessions SET revoked_at=coalesce(revoked_at,now())
      WHERE company_id=$1 AND staff_session_id=ANY($2::text[])`,[co,ended.map(row=>row.id)]);
    await audit(c,req.identity,co,'Update staff store assignments',`${identityId} · ${unique.length||'unrestricted'}`,identityId);
    return {identityId,locationIds:unique};
  }));

  app.put('/api/companies/:company/store-network/shop-locations/:id',req=>scoped(req,async(c,co)=>{
    managementAccess(req);const id=v.parse(v.id,req.params.id),body=v.parse(z.strictObject({
      storeId:v.id.nullable(),locationId:v.id.nullable(),
    }).refine(value=>(value.storeId===null)===(value.locationId===null)),req.body);
    if(body.storeId){
      const location=(await c.query(`SELECT l.id FROM myfin.store_locations l JOIN myfin.stores s
        ON s.company_id=l.company_id AND s.id=l.store_id AND s.status='active'
        WHERE l.company_id=$1 AND l.store_id=$2 AND l.id=$3 AND l.status='active'`,
      [co,body.storeId,body.locationId])).rows[0];
      if(!location)v.fail(409,'active_store_location_required');
    }
    const row=(await c.query(`UPDATE myfin.shop_locations SET store_id=$3,store_location_id=$4,updated_at=now()
      WHERE company_id=$1 AND id=$2 RETURNING id,name,fulfillment_mode,active,store_id,store_location_id`,
    [co,id,body.storeId,body.locationId])).rows[0];
    if(!row)v.fail(404,'shop_location_not_found');
    await audit(c,req.identity,co,'Link shop ordering point',row.name,row.id);
    return {shopLocation:{id:row.id,name:row.name,fulfillmentMode:row.fulfillment_mode,active:row.active,
      storeId:row.store_id||'',locationId:row.store_location_id||''}};
  }));

  app.get('/api/companies/:company/staff-shifts',req=>scoped(req,async(c,co)=>{
    requireCapability(req.identity,'shiftRead');
    const query=v.parse(z.strictObject({status:z.enum(['open','on_break','closed']).optional(),
      identityId:v.id.optional(),limit:z.coerce.number().int().min(1).max(200).default(50)}),req.query||{});
    const canManage=owner(req.identity)||manager(req.identity);
    if(!canManage&&query.identityId&&query.identityId!==req.identity.id)v.fail(403,'access_denied');
    const rows=(await c.query(`SELECT w.*,i.display_name AS identity_name,s.name AS store_name,l.name AS location_name,
        ot.name AS opened_terminal_name,ct.name AS closed_terminal_name
      FROM myfin.staff_work_shifts w JOIN myfin.app_identities i ON i.id=w.identity_id
      JOIN myfin.stores s ON s.company_id=w.company_id AND s.id=w.store_id
      JOIN myfin.store_locations l ON l.company_id=w.company_id AND l.id=w.store_location_id
      JOIN myfin.terminals ot ON ot.company_id=w.company_id AND ot.id=w.opened_terminal_id
      LEFT JOIN myfin.terminals ct ON ct.company_id=w.company_id AND ct.id=w.closed_terminal_id
      WHERE w.company_id=$1 AND ($2::text IS NULL OR w.status=$2)
        AND ($3::text IS NULL OR w.identity_id=$3) AND ($4::boolean OR w.identity_id=$5)
      ORDER BY w.clocked_in_at DESC LIMIT $6`,
    [co,query.status||null,query.identityId||null,canManage,req.identity.id,query.limit])).rows;
    return {rows:rows.map(workShiftOutput)};
  }));

  app.post('/api/companies/:company/staff-shifts/clock-in',req=>scoped(req,async(c,co)=>{
    const who=await terminalActor(c,req,{purpose:'staff'});const body=v.parse(z.strictObject({notes:z.string().trim().max(1000).default('')}),req.body||{});
    const existing=(await c.query(`SELECT * FROM myfin.staff_work_shifts WHERE company_id=$1 AND identity_id=$2
      AND status IN ('open','on_break') FOR UPDATE`,[co,who.id])).rows[0];
    if(existing&&existing.store_location_id!==who.storeLocationId)v.fail(409,'staff_shift_open_elsewhere');
    const work=existing||(await c.query(`INSERT INTO myfin.staff_work_shifts(company_id,id,identity_id,store_id,
      store_location_id,opened_terminal_id,notes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [co,randomUUID(),who.id,who.storeId,who.storeLocationId,who.terminalId,body.notes])).rows[0];
    if(!existing)await c.query(`INSERT INTO myfin.staff_shift_events(company_id,id,work_shift_id,identity_id,
      terminal_id,store_id,store_location_id,action,actor_id,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,'clock_in',$4,$8)`,
    [co,randomUUID(),work.id,who.id,who.terminalId,who.storeId,who.storeLocationId,{notes:body.notes}]);
    await c.query(`UPDATE myfin.terminal_staff_sessions SET work_shift_id=$3,last_seen_at=now()
      WHERE company_id=$1 AND id=$2 AND status='active'`,[co,who.staffSessionId,work.id]);
    await c.query(`UPDATE myfin.pos_sessions SET work_shift_id=$3 WHERE company_id=$1 AND token_digest=$2`,[co,who.posSessionDigest,work.id]);
    return {workShift:workShiftOutput(work)};
  }));
  app.post('/api/companies/:company/staff-shifts/break',req=>scoped(req,async(c,co)=>{
    const who=await terminalActor(c,req,{purpose:'staff'});const work=(await c.query(`UPDATE myfin.staff_work_shifts SET status='on_break',break_started_at=now(),
      version=version+1 WHERE company_id=$1 AND id=$2 AND identity_id=$3 AND status='open' RETURNING *`,
    [co,who.workShiftId,who.id])).rows[0];if(!work)v.fail(409,'staff_shift_not_open');
    await c.query(`INSERT INTO myfin.staff_shift_events(company_id,id,work_shift_id,identity_id,terminal_id,
      store_id,store_location_id,action,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,'break_start',$4)`,
    [co,randomUUID(),work.id,who.id,who.terminalId,who.storeId,who.storeLocationId]);
    return {workShift:workShiftOutput(work)};
  }));
  app.post('/api/companies/:company/staff-shifts/resume',req=>scoped(req,async(c,co)=>{
    const who=await terminalActor(c,req,{purpose:'staff'});const work=(await c.query(`UPDATE myfin.staff_work_shifts SET status='open',
      break_seconds=break_seconds+greatest(0,extract(epoch from now()-break_started_at)::integer),break_started_at=NULL,
      version=version+1 WHERE company_id=$1 AND id=$2 AND identity_id=$3 AND status='on_break' RETURNING *`,
    [co,who.workShiftId,who.id])).rows[0];if(!work)v.fail(409,'staff_shift_not_on_break');
    await c.query(`INSERT INTO myfin.staff_shift_events(company_id,id,work_shift_id,identity_id,terminal_id,
      store_id,store_location_id,action,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,'break_end',$4)`,
    [co,randomUUID(),work.id,who.id,who.terminalId,who.storeId,who.storeLocationId]);
    return {workShift:workShiftOutput(work)};
  }));
  app.post('/api/companies/:company/staff-shifts/clock-out',req=>scoped(req,async(c,co)=>{
    const who=await terminalActor(c,req,{purpose:'staff'}),body=v.parse(z.strictObject({notes:z.string().trim().max(1000).optional()}),req.body||{});
    const register=(await c.query(`SELECT id FROM myfin.register_shifts WHERE company_id=$1 AND terminal_id=$2 AND status='open'`,[co,who.terminalId])).rows[0];
    if(register)v.fail(409,'register_shift_must_close_first');
    const work=(await c.query(`UPDATE myfin.staff_work_shifts SET status='closed',clocked_out_at=now(),
      break_seconds=break_seconds+CASE WHEN break_started_at IS NULL THEN 0 ELSE greatest(0,extract(epoch from now()-break_started_at)::integer) END,
      break_started_at=NULL,closed_terminal_id=$4,notes=CASE WHEN $5='' THEN notes ELSE $5 END,version=version+1
      WHERE company_id=$1 AND id=$2 AND identity_id=$3 AND status IN ('open','on_break') RETURNING *`,
    [co,who.workShiftId,who.id,who.terminalId,body.notes||''])).rows[0];
    if(!work)v.fail(409,'staff_shift_not_open');
    await c.query(`INSERT INTO myfin.staff_shift_events(company_id,id,work_shift_id,identity_id,terminal_id,
      store_id,store_location_id,action,actor_id,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,'clock_out',$4,$8)`,
    [co,randomUUID(),work.id,who.id,who.terminalId,who.storeId,who.storeLocationId,{notes:body.notes||''}]);
    await c.query(`UPDATE myfin.terminal_staff_sessions SET work_shift_id=NULL WHERE company_id=$1 AND id=$2`,[co,who.staffSessionId]);
    await c.query(`UPDATE myfin.pos_sessions SET work_shift_id=NULL WHERE company_id=$1 AND token_digest=$2`,[co,who.posSessionDigest]);
    return {workShift:workShiftOutput(work)};
  }));
  app.post('/api/companies/:company/staff-shifts/:id/force-clock-out',req=>scoped(req,async(c,co)=>{
    requirePasswordSession(req);requireCapability(req.identity,'shiftManage');
    const id=v.parse(v.id,req.params.id),{reason}=v.parse(z.strictObject({reason:z.string().trim().min(3).max(1000)}),req.body);
    const snapshot=(await c.query(`SELECT * FROM myfin.staff_work_shifts WHERE company_id=$1 AND id=$2`,[co,id])).rows[0];
    if(!snapshot)v.fail(404,'staff_shift_not_found');
    await c.query(`SELECT ss.id FROM myfin.terminal_staff_sessions ss WHERE ss.company_id=$1 AND ss.status='active'
      AND (ss.work_shift_id=$2 OR ss.identity_id=$3 OR ss.terminal_id IN(
        SELECT r.terminal_id FROM myfin.register_shifts r WHERE r.company_id=$1 AND r.status='open' AND r.opened_by=$3))
      ORDER BY ss.id FOR UPDATE`,[co,id,snapshot.identity_id]);
    const prior=(await c.query(`SELECT * FROM myfin.staff_work_shifts WHERE company_id=$1 AND id=$2 FOR UPDATE`,[co,id])).rows[0];
    if(prior.status==='closed')return {workShift:workShiftOutput(prior)};
    const openRegister=(await c.query(`SELECT r.id FROM myfin.register_shifts r WHERE r.company_id=$1
      AND r.status='open' AND (EXISTS(
        SELECT 1 FROM myfin.terminal_staff_sessions ss WHERE ss.company_id=r.company_id
          AND ss.work_shift_id=$2 AND ss.terminal_id=r.terminal_id AND ss.status='active'
      ) OR (r.opened_by=$3 AND NOT EXISTS(
        SELECT 1 FROM myfin.terminal_staff_sessions replacement
        JOIN myfin.staff_work_shifts rw ON rw.company_id=replacement.company_id AND rw.id=replacement.work_shift_id
        WHERE replacement.company_id=r.company_id AND replacement.terminal_id=r.terminal_id
          AND replacement.identity_id<>$3 AND replacement.status='active' AND rw.status='open'
      ))) LIMIT 1 FOR SHARE OF r`,[co,id,prior.identity_id])).rows[0];
    if(openRegister)v.fail(409,'register_shift_must_close_first');
    const work=(await c.query(`UPDATE myfin.staff_work_shifts SET status='closed',clocked_out_at=now(),
      break_seconds=break_seconds+CASE WHEN break_started_at IS NULL THEN 0 ELSE greatest(0,extract(epoch from now()-break_started_at)::integer) END,
      break_started_at=NULL,closed_terminal_id=opened_terminal_id,notes=concat_ws(E'\\n',nullif(notes,''),$3),version=version+1
      WHERE company_id=$1 AND id=$2 RETURNING *`,[co,id,`Force closed: ${reason}`])).rows[0];
    await c.query(`UPDATE myfin.terminal_staff_sessions SET work_shift_id=NULL WHERE company_id=$1 AND work_shift_id=$2`,[co,id]);
    await c.query(`UPDATE myfin.pos_sessions SET work_shift_id=NULL WHERE company_id=$1 AND work_shift_id=$2`,[co,id]);
    await c.query(`INSERT INTO myfin.staff_shift_events(company_id,id,work_shift_id,identity_id,terminal_id,
      store_id,store_location_id,action,actor_id,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,'force_clock_out',$8,$9)`,
    [co,randomUUID(),id,prior.identity_id,prior.opened_terminal_id,prior.store_id,prior.store_location_id,
      req.identity.id,{reason}]);
    await audit(c,req.identity,co,'Force close staff shift',reason,id);
    return {workShift:workShiftOutput(work)};
  }));

  app.get('/api/companies/:company/register-shifts',req=>scoped(req,async(c,co)=>{
    requireCapability(req.identity,'shiftRead');
    const query=v.parse(z.strictObject({status:z.enum(['open','closed','force_closed']).optional(),limit:z.coerce.number().int().min(1).max(200).default(50)}),req.query||{});
    const rows=(await c.query(`SELECT r.*,t.name AS terminal_name,l.name AS location_name,i.display_name AS opened_by_name,
      (SELECT coalesce(sum(e.amount_sen),0) FROM myfin.register_cash_entries e
        WHERE e.company_id=r.company_id AND e.register_shift_id=r.id) AS current_expected_cash_sen
      FROM myfin.register_shifts r JOIN myfin.terminals t ON t.company_id=r.company_id AND t.id=r.terminal_id
      JOIN myfin.store_locations l ON l.company_id=r.company_id AND l.id=r.store_location_id
      JOIN myfin.app_identities i ON i.id=r.opened_by
      WHERE r.company_id=$1 AND ($2::text IS NULL OR r.status=$2)
        AND ($4::boolean OR r.terminal_id=$5 OR r.opened_by=$6)
      ORDER BY r.opened_at DESC LIMIT $3`,
    [co,query.status||null,query.limit,owner(req.identity)||manager(req.identity),req.identity.terminalId||null,req.identity.id])).rows;
    return {rows:rows.map(registerShiftOutput)};
  }));
  app.post('/api/companies/:company/register-shifts/open',req=>scoped(req,async(c,co)=>{
    const who=await terminalActor(c,req),body=v.parse(z.strictObject({openingCashSen:positiveMoneySen,businessDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),notes:z.string().trim().max(1000).default('')}),req.body);
    if(!who.workShiftId||who.workShiftStatus!=='open')v.fail(409,'staff_shift_required');
    const date=body.businessDate||new Intl.DateTimeFormat('en-CA',{timeZone:who.storeTimeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,52))',[`${co}:register-open:${who.terminalId}`]);
    const prior=(await c.query(`SELECT * FROM myfin.register_shifts WHERE company_id=$1 AND terminal_id=$2 AND status='open' FOR UPDATE`,[co,who.terminalId])).rows[0];
    if(prior){
      if(prior.opened_by!==who.id||Number(prior.opening_cash_sen)!==body.openingCashSen||String(prior.business_date).slice(0,10)!==date)
        v.fail(409,'register_shift_already_open');
      return {registerShift:registerShiftOutput(prior)};
    }
    const id=randomUUID(),shift=(await c.query(`INSERT INTO myfin.register_shifts(company_id,id,terminal_id,store_id,store_location_id,
      business_date,opening_cash_sen,opened_by,opened_staff_session_id,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [co,id,who.terminalId,who.storeId,who.storeLocationId,date,body.openingCashSen,who.id,who.staffSessionId,body.notes])).rows[0];
    const openingRequest=`opening:${id}`,openingDigest=requestDigest({kind:'opening_float',amountSen:body.openingCashSen});
    await c.query(`INSERT INTO myfin.register_cash_entries(company_id,id,register_shift_id,terminal_id,store_id,store_location_id,
      staff_session_id,kind,amount_sen,source_type,source_id,request_id,request_digest,reason,actor_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'opening_float',$8,'register_shift',$3,$9,$10,'Opening float',$11)`,
    [co,randomUUID(),id,who.terminalId,who.storeId,who.storeLocationId,who.staffSessionId,body.openingCashSen,openingRequest,openingDigest,who.id]);
    await c.query(`UPDATE myfin.pos_sessions SET register_shift_id=$3 WHERE company_id=$1 AND token_digest=$2`,[co,who.posSessionDigest,id]);
    await c.query(`INSERT INTO myfin.register_shift_events(company_id,id,register_shift_id,terminal_id,store_id,
      store_location_id,staff_session_id,staff_identity_id,action,actor_id,request_id,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'opened',$8,$9,$10)`,
    [co,randomUUID(),id,who.terminalId,who.storeId,who.storeLocationId,who.staffSessionId,who.id,
      openingRequest,{openingCashSen:body.openingCashSen,businessDate:date}]);
    return {registerShift:registerShiftOutput({...shift,current_expected_cash_sen:body.openingCashSen})};
  }));
  app.post('/api/companies/:company/register-shifts/join',req=>scoped(req,async(c,co)=>{
    const who=await terminalActor(c,req),{registerShiftId}=v.parse(z.strictObject({registerShiftId:v.id}),req.body);
    if(!who.workShiftId||who.workShiftStatus!=='open')v.fail(409,'staff_shift_required');
    const shift=(await c.query(`SELECT r.*,coalesce(sum(e.amount_sen),0) AS current_expected_cash_sen
      FROM myfin.register_shifts r LEFT JOIN myfin.register_cash_entries e ON e.company_id=r.company_id AND e.register_shift_id=r.id
      WHERE r.company_id=$1 AND r.id=$2 AND r.terminal_id=$3 AND r.status='open' GROUP BY r.company_id,r.id`,
    [co,registerShiftId,who.terminalId])).rows[0];if(!shift)v.fail(404,'register_shift_not_open');
    await c.query(`UPDATE myfin.pos_sessions SET register_shift_id=$3 WHERE company_id=$1 AND token_digest=$2`,[co,who.posSessionDigest,shift.id]);
    await c.query(`INSERT INTO myfin.register_shift_events(company_id,id,register_shift_id,terminal_id,store_id,
      store_location_id,staff_session_id,staff_identity_id,action,actor_id,request_id,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'joined',$8,$9,'{}') ON CONFLICT DO NOTHING`,
    [co,randomUUID(),shift.id,who.terminalId,who.storeId,who.storeLocationId,who.staffSessionId,who.id,
      `join:${who.staffSessionId}`]);
    return {registerShift:registerShiftOutput(shift)};
  }));
  app.post('/api/companies/:company/register-shifts/cash-entry',req=>scoped(req,async(c,co)=>{
    const who=await terminalActor(c,req),body=v.parse(z.strictObject({registerShiftId:v.id,kind:z.enum(['paid_in','paid_out','adjustment']),
      amountSen:moneySen.refine(value=>value!==0),reason:z.string().trim().min(3).max(1000),requestId:v.id}),req.body);
    if(!who.workShiftId||who.workShiftStatus!=='open')v.fail(409,'staff_shift_required');
    if(!owner(who)&&!manager(who))v.fail(403,'cash_entry_manager_required');
    if(body.kind!=='adjustment'&&body.amountSen<0)v.fail(400,'cash_entry_amount_must_be_positive');
    const amount=body.kind==='paid_out'?-Math.abs(body.amountSen):body.amountSen,
      digest=requestDigest({kind:body.kind,amountSen:amount,reason:body.reason});
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,51))',
      [`${co}:register-cash:${body.registerShiftId}:${body.requestId}`]);
    const prior=(await c.query(`SELECT * FROM myfin.register_cash_entries WHERE company_id=$1 AND register_shift_id=$2
      AND request_id=$3`,[co,body.registerShiftId,body.requestId])).rows[0];
    if(prior){if(prior.request_digest!==digest)v.fail(409,'cash_entry_request_changed');return {entry:{id:prior.id,kind:prior.kind,amountSen:Number(prior.amount_sen),reason:prior.reason,createdAt:prior.created_at}};}
    const shift=(await c.query(`SELECT * FROM myfin.register_shifts WHERE company_id=$1 AND id=$2
      AND terminal_id=$3 AND status='open' FOR UPDATE`,[co,body.registerShiftId,who.terminalId])).rows[0];
    if(!shift)v.fail(404,'register_shift_not_open');
    const entry=(await c.query(`INSERT INTO myfin.register_cash_entries(company_id,id,register_shift_id,terminal_id,store_id,
      store_location_id,staff_session_id,kind,amount_sen,request_id,request_digest,reason,actor_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [co,randomUUID(),shift.id,who.terminalId,who.storeId,who.storeLocationId,who.staffSessionId,body.kind,amount,body.requestId,digest,body.reason,who.id])).rows[0];
    await c.query(`INSERT INTO myfin.register_shift_events(company_id,id,register_shift_id,terminal_id,store_id,
      store_location_id,staff_session_id,staff_identity_id,action,actor_id,request_id,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'cash_entry',$8,$9,$10)`,
    [co,randomUUID(),shift.id,who.terminalId,who.storeId,who.storeLocationId,who.staffSessionId,who.id,
      body.requestId,{entryId:entry.id,kind:entry.kind,amountSen:Number(entry.amount_sen)}]);
    return {entry:{id:entry.id,kind:entry.kind,amountSen:Number(entry.amount_sen),reason:entry.reason,createdAt:entry.created_at}};
  }));
  app.post('/api/companies/:company/register-shifts/close',req=>scoped(req,async(c,co)=>{
    const who=await terminalActor(c,req),body=v.parse(z.strictObject({registerShiftId:v.id,countedCashSen:positiveMoneySen,
      varianceReason:z.string().trim().max(1000).default(''),requestId:v.id}),req.body),
      digest=requestDigest({countedCashSen:body.countedCashSen,varianceReason:body.varianceReason});
    if(!who.workShiftId||who.workShiftStatus!=='open')v.fail(409,'staff_shift_required');
    const shift=(await c.query(`SELECT * FROM myfin.register_shifts WHERE company_id=$1 AND id=$2
      AND terminal_id=$3 FOR UPDATE`,[co,body.registerShiftId,who.terminalId])).rows[0];
    if(!shift)v.fail(404,'register_shift_not_found');
    if(shift.status!=='open'){
      if(shift.close_request_id===body.requestId&&shift.close_request_digest===digest)
        return {registerShift:registerShiftOutput(shift)};
      v.fail(409,'register_shift_already_closed');
    }
    const pending=(await c.query(`SELECT 1 FROM myfin.receipt_reviews WHERE company_id=$1
      AND origin_register_shift_id=$2 AND status='pending' LIMIT 1`,[co,shift.id])).rowCount;
    if(pending)v.fail(409,'pending_receipts_must_resolve_first');
    const expected=Number((await c.query(`SELECT coalesce(sum(amount_sen),0) AS amount FROM myfin.register_cash_entries
      WHERE company_id=$1 AND register_shift_id=$2`,[co,shift.id])).rows[0].amount),variance=body.countedCashSen-expected;
    if(variance!==0&&body.varianceReason.length<3)v.fail(400,'register_variance_reason_required');
    if(variance!==0&&!manager(who)&&!owner(who))v.fail(403,'register_variance_manager_required');
    const closed=(await c.query(`UPDATE myfin.register_shifts SET status='closed',expected_cash_sen=$3,counted_cash_sen=$4,
      variance_sen=$5,variance_reason=$6,closed_by=$7,closed_at=now(),close_request_id=$8,close_request_digest=$9,version=version+1
      WHERE company_id=$1 AND id=$2 RETURNING *`,[co,shift.id,expected,body.countedCashSen,variance,body.varianceReason,who.id,body.requestId,digest])).rows[0];
    await c.query(`UPDATE myfin.pos_sessions SET register_shift_id=NULL WHERE company_id=$1 AND register_shift_id=$2`,[co,shift.id]);
    await c.query(`INSERT INTO myfin.register_shift_events(company_id,id,register_shift_id,terminal_id,store_id,
      store_location_id,staff_session_id,staff_identity_id,action,actor_id,request_id,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'closed',$8,$9,$10)`,
    [co,randomUUID(),shift.id,who.terminalId,who.storeId,who.storeLocationId,who.staffSessionId,who.id,
      body.requestId,{expectedCashSen:expected,countedCashSen:body.countedCashSen,varianceSen:variance}]);
    return {registerShift:registerShiftOutput({...closed,current_expected_cash_sen:expected})};
  }));
  app.post('/api/companies/:company/register-shifts/:id/force-close',req=>scoped(req,async(c,co)=>{
    requirePasswordSession(req);requireCapability(req.identity,'shiftManage');
    const id=v.parse(v.id,req.params.id),body=v.parse(z.strictObject({countedCashSen:positiveMoneySen,
      reason:z.string().trim().min(3).max(1000),requestId:v.id}),req.body),
      digest=requestDigest({countedCashSen:body.countedCashSen,reason:body.reason,force:true});
    const shift=(await c.query(`SELECT * FROM myfin.register_shifts WHERE company_id=$1 AND id=$2 FOR UPDATE`,[co,id])).rows[0];
    if(!shift)v.fail(404,'register_shift_not_found');
    if(shift.status!=='open'){
      if(shift.close_request_id===body.requestId&&shift.close_request_digest===digest)
        return {registerShift:registerShiftOutput(shift)};
      v.fail(409,'register_shift_already_closed');
    }
    const pending=(await c.query(`SELECT 1 FROM myfin.receipt_reviews WHERE company_id=$1
      AND origin_register_shift_id=$2 AND status='pending' LIMIT 1`,[co,id])).rowCount;
    if(pending)v.fail(409,'pending_receipts_must_resolve_first');
    const expected=Number((await c.query(`SELECT coalesce(sum(amount_sen),0) AS amount FROM myfin.register_cash_entries
      WHERE company_id=$1 AND register_shift_id=$2`,[co,id])).rows[0].amount),variance=body.countedCashSen-expected;
    const closed=(await c.query(`UPDATE myfin.register_shifts SET status='force_closed',expected_cash_sen=$3,
      counted_cash_sen=$4,variance_sen=$5,variance_reason=$6,closed_by=$7,closed_at=now(),close_request_id=$8,
      close_request_digest=$9,version=version+1 WHERE company_id=$1 AND id=$2 RETURNING *`,
    [co,id,expected,body.countedCashSen,variance,body.reason,req.identity.id,body.requestId,digest])).rows[0];
    await c.query(`UPDATE myfin.pos_sessions SET register_shift_id=NULL WHERE company_id=$1 AND register_shift_id=$2`,[co,id]);
    await c.query(`INSERT INTO myfin.register_shift_events(company_id,id,register_shift_id,terminal_id,store_id,
      store_location_id,staff_session_id,staff_identity_id,action,actor_id,request_id,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'force_closed',$9,$10,$11)`,
    [co,randomUUID(),id,shift.terminal_id,shift.store_id,shift.store_location_id,shift.opened_staff_session_id,
      shift.opened_by,req.identity.id,body.requestId,
      {expectedCashSen:expected,countedCashSen:body.countedCashSen,varianceSen:variance,reason:body.reason}]);
    await audit(c,req.identity,co,'Force close register shift',body.reason,id);
    return {registerShift:registerShiftOutput({...closed,current_expected_cash_sen:expected})};
  }));
  app.get('/api/companies/:company/staff-shifts/:id/events',req=>scoped(req,async(c,co)=>{
    requireCapability(req.identity,'shiftRead');const id=v.parse(v.id,req.params.id);
    const shift=(await c.query(`SELECT identity_id FROM myfin.staff_work_shifts WHERE company_id=$1 AND id=$2`,[co,id])).rows[0];
    if(!shift)v.fail(404,'staff_shift_not_found');
    if(!owner(req.identity)&&!manager(req.identity)&&shift.identity_id!==req.identity.id)v.fail(403,'access_denied');
    const rows=(await c.query(`SELECT id,action,actor_id,terminal_id,details,created_at FROM myfin.staff_shift_events
      WHERE company_id=$1 AND work_shift_id=$2 ORDER BY created_at,id`,[co,id])).rows;
    return {rows:rows.map(row=>({id:row.id,action:row.action,actorId:row.actor_id,terminalId:row.terminal_id,details:row.details,createdAt:row.created_at}))};
  }));
  app.get('/api/companies/:company/register-shifts/:id/events',req=>scoped(req,async(c,co)=>{
    requireCapability(req.identity,'shiftRead');const id=v.parse(v.id,req.params.id);
    const shift=(await c.query(`SELECT terminal_id,opened_by FROM myfin.register_shifts WHERE company_id=$1 AND id=$2`,[co,id])).rows[0];
    if(!shift)v.fail(404,'register_shift_not_found');
    if(!owner(req.identity)&&!manager(req.identity)&&shift.opened_by!==req.identity.id&&shift.terminal_id!==req.identity.terminalId)
      v.fail(403,'access_denied');
    const rows=(await c.query(`SELECT id,action,actor_id,terminal_id,staff_session_id,request_id,details,created_at
      FROM myfin.register_shift_events WHERE company_id=$1 AND register_shift_id=$2 ORDER BY created_at,id`,[co,id])).rows;
    return {rows:rows.map(row=>({id:row.id,action:row.action,actorId:row.actor_id,terminalId:row.terminal_id,
      staffSessionId:row.staff_session_id,requestId:row.request_id,details:row.details,createdAt:row.created_at}))};
  }));
}
