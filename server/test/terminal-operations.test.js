import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  ensureRequestTerminalStaff,
  registerTerminalOperations,
  registerTerminalPublic,
  terminalCredentialDigest,
  terminalEnrollmentDigest,
} from '../src/terminal-operations.js';
import { permissionsFor } from '../../src/domain/permissions.js';

const root=fileURLToPath(new URL('../..',import.meta.url));
const source=path=>readFile(`${root}/${path}`,'utf8');

test('terminal credentials are purpose and tenant separated HMAC digests',()=>{
  const options={pos:{sessionSecret:'test-secret-with-enough-entropy'}};
  const first=terminalCredentialDigest(options,'company-a','same-secret');
  assert.match(first,/^[a-f0-9]{64}$/);
  assert.equal(first,terminalCredentialDigest(options,'company-a','same-secret'));
  assert.notEqual(first,terminalCredentialDigest(options,'company-b','same-secret'));
  assert.notEqual(first,terminalEnrollmentDigest(options,'company-a','same-secret'));
});

test('unpaired terminal context exposes only safe rollout policy while clearing stale cookie',async()=>{
  const routes=new Map();
  const app={
    get:(path,handler)=>routes.set(`GET ${path}`,handler),
    post:(path,options,handler)=>routes.set(`POST ${path}`,handler||options),
  };
  const db={query:async sql=>{
    assert.match(sql,/FROM myfin\.companies/);
    return {rows:[{terminal_enforcement_enabled:true,terminal_enforcement_from:'2026-10-22T00:00:00Z',
      require_open_register_for_pos:false,require_open_register_from:null}]};
  }};
  registerTerminalPublic(app,{db,authOptions:{secure:true,pos:{sessionSecret:'secret'}}});
  let status=0,payload=null,cookie='';
  const reply={header:(name,value)=>{if(name==='set-cookie')cookie=value;return reply;},
    code:value=>{status=value;return reply;},send:value=>{payload=value;return value;}};
  await routes.get('GET /api/terminal-context')({headers:{},tenant:{surface:'tenant',company_id:'company-a'}},reply);
  assert.equal(status,401);
  assert.match(cookie,/Max-Age=0/);
  assert.deepEqual(payload,{error:'terminal_enrollment_required',policy:{terminalEnforcement:true,
    terminalEnforcementFrom:'2026-10-22T00:00:00Z',requireOpenRegisterForPos:false,requireOpenRegisterFrom:null}});
  assert.equal(JSON.stringify(payload).includes('secret'),false);
});

test('store-network and recovery route contract is registered as one vertical slice',()=>{
  const routes=[];
  const app={};
  for(const method of ['get','post','put','patch','delete'])app[method]=(path)=>routes.push(`${method.toUpperCase()} ${path}`);
  registerTerminalOperations(app,{db:{},scoped(){},audit(){},authOptions:{pos:{sessionSecret:'secret'}}});
  for(const route of [
    'GET /api/companies/:company/store-network',
    'PUT /api/companies/:company/store-network',
    'POST /api/terminal-context/staff-sign-out',
    'GET /api/companies/:company/staff-shifts',
    'POST /api/companies/:company/staff-shifts/:id/force-clock-out',
    'GET /api/companies/:company/register-shifts',
    'POST /api/companies/:company/register-shifts/:id/force-close',
  ])assert.ok(routes.includes(route),route);
});

test('terminal and shift capabilities preserve role delegation boundaries',()=>{
  const owner=permissionsFor({role:'workspace_owner'});
  const manager=permissionsFor({role:'manager'});
  const operator=permissionsFor({role:'operator'});
  assert.equal(owner.networkPolicyManage,true);
  assert.equal(manager.networkPolicyManage,false);
  assert.equal(manager.storeNetworkManage,true);
  assert.equal(operator.storeNetworkRead,false);
  assert.equal(operator.shiftRead,true);
  assert.equal(operator.shiftOperate,true);
  assert.equal(operator.shiftManage,false);
});

test('migrations enforce complete store, terminal, staff and register contexts',async()=>{
  const [stores,terminals,shifts]=await Promise.all([
    source('db/migrations/0049_store_network.sql'),source('db/migrations/0050_terminal_enrollment.sql'),
    source('db/migrations/0051_staff_register_shifts.sql'),
  ]);
  assert.match(stores,/UNIQUE\(company_id,store_id,id\)/);
  assert.match(stores,/require_open_register_from timestamptz/);
  assert.match(terminals,/pos_sessions_terminal_credential_fk/);
  assert.match(terminals,/terminal_login_guards/);
  assert.match(shifts,/REFERENCES myfin\.terminals\(company_id,store_id,store_location_id,id\)/);
  assert.match(shifts,/REFERENCES myfin\.terminal_staff_sessions\(company_id,id,terminal_id,store_id,store_location_id,identity_id\)/);
  assert.match(shifts,/WHERE source_type<>''/);
  assert.match(shifts,/force_clock_out/);
  assert.match(shifts,/immutable_register_shift_event/);
  assert.match(shifts,/ON DELETE CASCADE/);
});

test('receipt review origin migration preserves old writers without mutating immutable rows',async()=>{
  const shifts=await source('db/migrations/0051_staff_register_shifts.sql');
  assert.match(shifts,/origin_legacy boolean NOT NULL DEFAULT true/);
  assert.doesNotMatch(shifts,/UPDATE\s+myfin\.receipt_reviews\b/i);
  assert.match(shifts,/CHECK\(origin_legacy=\(origin_terminal_id IS NULL\)\)/);
});

test('receipt replay snapshots register cutover and never borrows approver terminal context',async()=>{
  const [reviews,business,operations]=await Promise.all([
    source('server/src/receipt-reviews.js'),source('server/src/business.js'),source('server/src/terminal-operations.js'),
  ]);
  assert.match(reviews,/origin_register_policy_required/);
  assert.match(reviews,/capturedAt<policyFrom/);
  assert.match(reviews,/originRegisterPolicyRequired:row\.origin_register_policy_required/);
  assert.match(business,/options\.originRegisterPolicyRequired===true/);
  assert.match(business,/terminalAttribution:terminalExempt\?'online_payment':'legacy'/);
  assert.match(operations,/rawToken\.slice\(-4\)/);
  assert.match(operations,/terminal_activation_requires_enrollment/);
  assert.match(operations,/enrolled_terminal_cannot_be_relocated/);
});

test('terminal rotation, cash retries and forced clock-out preserve active-operation invariants',async()=>{
  const operations=await source('server/src/terminal-operations.js');
  const idleGuard=operations.match(/async function assertTerminalIdleForEnrollment[\s\S]*?\n\}/)?.[0] || '';
  assert.match(idleGuard,/register_shifts[\s\S]*status='open'/);
  assert.match(idleGuard,/terminal_staff_sessions[\s\S]*status='active'/);
  assert.equal((operations.match(/await assertTerminalIdleForEnrollment\(/g)||[]).length,3);

  const cashRoute=operations.slice(operations.indexOf("register-shifts/cash-entry"),operations.indexOf("register-shifts/close"));
  assert.ok(cashRoute.indexOf('pg_advisory_xact_lock')<cashRoute.indexOf('FROM myfin.register_cash_entries'));
  assert.match(cashRoute,/cash_entry_request_changed/);

  const forceClockOut=operations.slice(operations.indexOf("staff-shifts/:id/force-clock-out"),operations.indexOf("register-shifts',"));
  assert.match(forceClockOut,/r\.opened_by=\$3/);
  assert.match(forceClockOut,/ss\.work_shift_id=\$2[\s\S]*ss\.status='active'/);
});

test('terminal authority defaults and enforcement readiness use actual capabilities',async()=>{
  const [operations,migration,pos]=await Promise.all([
    source('server/src/terminal-operations.js'),source('db/migrations/0050_terminal_enrollment.sql'),
    source('server/src/pos-auth.js'),
  ]);
  assert.match(operations,/kitchen_display:\['kitchen'\]/);
  assert.match(operations,/customer_display:\['customer_display'\]/);
  assert.match(operations,/multi_use:\[\]/);
  assert.match(migration,/capabilities jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
  const policy=operations.slice(operations.indexOf("app.put('/api/companies/:company/store-network'"),
    operations.indexOf("store-network/stores'"));
  assert.match(policy,/t\.capabilities \? 'pos'/);
  assert.doesNotMatch(policy,/t\.type IN/);
  assert.match(operations,/last_active_pos_terminal_required/);
  assert.ok((operations.match(/assertUsablePosTerminalRemains\(/g)||[]).length>=3);
  assert.match(operations,/losesLiveAuthority[\s\S]*await assertTerminalIdleForEnrollment\(c,co,id\)/);
  assert.match(pos,/currentTerminal&&!\(currentTerminal\.capabilities\|\|\[\]\)\.includes\('pos'\)/);
});

test('terminal operations revalidate the current credential and active staff session in-transaction',async()=>{
  const operations=await source('server/src/terminal-operations.js');
  const ensure=operations.slice(operations.indexOf('export async function ensureRequestTerminalStaff'),
    operations.indexOf('export async function endTerminalStaffSession'));
  assert.match(ensure,/JOIN myfin\.terminal_credentials[\s\S]*revoked_at IS NULL/);
  assert.match(ensure,/t\.credential_version=\$3[\s\S]*FOR SHARE OF t,k/);
  assert.match(ensure,/terminal_staff_sessions[\s\S]*status='active'[\s\S]*FOR SHARE/);
  assert.match(ensure,/staff_location_assignments[\s\S]*terminal_location_not_assigned/);
  assert.match(ensure,/terminal_staff_session_required/);
});

test('an existing terminal staff session is rejected after its location assignment is removed',async()=>{
  const queries=[];
  const c={query:async(sql,params=[])=>{
    queries.push({sql,params});
    if(sql.includes('FROM myfin.terminals t JOIN myfin.terminal_credentials'))return {rows:[{
      id:'terminal-a',company_id:'company-a',store_id:'store-a',store_location_id:'location-a',
      credential_version:3,capabilities:['pos'],status:'active',time_zone:'Asia/Kuala_Lumpur',
      terminal_enforcement_enabled:true,terminal_enforcement_from:null,
      require_open_register_for_pos:false,require_open_register_from:null,
    }]};
    if(sql.includes('EXISTS(SELECT 1 FROM myfin.staff_location_assignments'))
      return {rows:[{restricted:true,assigned:false}]};
    return {rows:[]};
  }};
  const req={identity:{id:'staff-a',role:'operator',company_id:'company-a',terminalId:'terminal-a',
    terminalCredentialVersion:3,staffSessionId:'staff-session-a'}};
  await assert.rejects(ensureRequestTerminalStaff(c,req),error=>{
    assert.equal(error.statusCode,403);
    assert.equal(error.message,'terminal_location_not_assigned');
    return true;
  });
  assert.equal(queries.some(({sql})=>sql.includes('FROM myfin.terminal_staff_sessions')),false,
    'assignment is revalidated before an existing staff session can be reused');
});

test('changing staff assignments terminates displaced terminal and POS sessions',async()=>{
  const routes=new Map(),queries=[];
  const app={};
  for(const method of ['get','post','put','patch','delete'])
    app[method]=(path,handler)=>routes.set(`${method.toUpperCase()} ${path}`,handler);
  const c={query:async(sql,params=[])=>{
    queries.push({sql,params});
    if(sql.includes('SELECT role FROM myfin.memberships'))return {rows:[{role:'operator'}]};
    if(sql.includes('SELECT id,store_id FROM myfin.store_locations'))return {rows:[{id:'location-b',store_id:'store-a'}]};
    if(sql.includes("ended_reason='location_assignment_changed'"))return {rows:[{id:'staff-session-a'}]};
    return {rows:[]};
  }};
  const scoped=(_req,work)=>work(c,'company-a');
  registerTerminalOperations(app,{db:{},scoped,audit:async()=>{},authOptions:{pos:{sessionSecret:'secret'}}});
  const handler=routes.get('PUT /api/companies/:company/store-network/staff/:identity/assignments');
  const result=await handler({authLevel:'password',identity:{id:'owner-a',role:'workspace_owner'},
    params:{identity:'staff-a'},body:{locationIds:['location-b']}});
  assert.deepEqual(result,{identityId:'staff-a',locationIds:['location-b']});
  const terminalEnd=queries.find(({sql})=>sql.includes("ended_reason='location_assignment_changed'"));
  assert.deepEqual(terminalEnd.params,['company-a','staff-a']);
  const posRevoke=queries.find(({sql})=>sql.includes('UPDATE myfin.pos_sessions'));
  assert.deepEqual(posRevoke.params,['company-a',['staff-session-a']]);
});

test('receipt review policy snapshots and approval use one register-first lock order',async()=>{
  const reviews=await source('server/src/receipt-reviews.js');
  const origin=reviews.slice(reviews.indexOf('const originFor='),reviews.indexOf('const insertReview='));
  assert.match(origin,/FROM myfin\.companies WHERE id=\$1 FOR SHARE/);
  assert.match(origin,/policy\.require_open_register_for_pos/);
  assert.doesNotMatch(origin,/who\.requireOpenRegisterForPos/);
  const approval=reviews.slice(reviews.indexOf('receipt-reviews/:id/approve'),reviews.indexOf('receipt-reviews/:id/dismiss'));
  assert.ok(approval.indexOf('lockReviewOriginRegister')<approval.indexOf('lockSale'));
  const bulk=reviews.slice(reviews.indexOf('receipt-reviews/approve-all'),reviews.indexOf('receipt-reviews/:id/approve'));
  assert.ok(bulk.indexOf('lockReviewOriginRegister')<bulk.indexOf('lockSale'));
});

test('physical closure, staff revocation and shift handover fail closed without stranding drawers',async()=>{
  const [operations,publicShop,management]=await Promise.all([
    source('server/src/terminal-operations.js'),source('server/src/storefront-public.js'),source('server/src/management.js'),
  ]);
  assert.match(operations,/shop_locations WHERE company_id=\$1 AND store_id=\$2 AND active/);
  assert.match(operations,/shop_locations WHERE company_id=\$1 AND store_location_id=\$2 AND active/);
  assert.match(publicShop,/JOIN myfin\.store_locations sl[\s\S]*sl\.status='active'[\s\S]*s\.status='active'/);
  assert.match(management,/UPDATE myfin\.terminal_staff_sessions[\s\S]*ended_reason=\$[23]/);
  assert.match(management,/access_revoked/);
  assert.match(operations,/ended\.ended_reason='access_revoked'/);
  assert.match(operations,/location_assignment_changed[\s\S]*staff_session_id=ANY/);
  const open=operations.slice(operations.indexOf("register-shifts/open'"),operations.indexOf("register-shifts/join'"));
  assert.ok(open.indexOf('pg_advisory_xact_lock')<open.indexOf('FROM myfin.register_shifts'));
  const force=operations.slice(operations.indexOf('staff-shifts/:id/force-clock-out'),operations.indexOf("register-shifts',"));
  assert.match(force,/replacement\.identity_id<>\$3[\s\S]*rw\.status='open'/);
  assert.ok(force.indexOf('FROM myfin.terminal_staff_sessions ss')<force.indexOf('staff_work_shifts WHERE company_id=$1 AND id=$2 FOR UPDATE'));
});
