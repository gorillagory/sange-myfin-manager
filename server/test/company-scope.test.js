import assert from 'node:assert/strict';
import test from 'node:test';
import { registerBusiness } from '../src/business.js';
import { registerManagement } from '../src/management.js';

function captureApp() {
  const routes=new Map(),app={ decorateRequest(){},addHook(){} };
  for(const method of ['get','post','put','patch','delete'])app[method]=(path,...handlers)=>{
    routes.set(`${method.toUpperCase()} ${path}`,handlers.at(-1));
  };
  return {app,routes};
}

test('GET /api/me selects and authorizes the requested company membership', async () => {
  const {app,routes}=captureApp();
  let transactions=0;
  const c={query:async(sql,params=[])=>{
    if(sql.includes('FROM myfin.auth_session'))return {rowCount:1,rows:[{id:'session-a'}]};
    if(sql.includes('SELECT * FROM myfin.app_identities'))return {rowCount:1,rows:[{id:'manager-a',is_super:false}]};
    if(sql.includes('SELECT id,workspace_id FROM myfin.companies'))return {rowCount:1,rows:[{id:params[0],workspace_id:'workspace-a'}]};
    if(sql.includes('FROM myfin.workspace_memberships'))return {rowCount:0,rows:[]};
    if(sql.includes('FROM myfin.memberships m'))return {rowCount:1,rows:[{role:'manager',module_ids:['finance','access']}]};
    assert.fail(`unexpected query: ${sql}`);
  }};
  const db={transaction:fn=>{transactions++;return fn(c);}};
  registerBusiness(app,{database:db,auth:{},authOptions:{voucherHmacSecret:'test'},paymentGateway:{}});
  const first={id:'manager-a',uid:'manager-a',role:'manager',company_id:'company-a',workspace_id:'workspace-a',module_grants:['workspace']};
  const handler=routes.get('GET /api/me');
  const selected=await handler({identity:first,query:{company:'company-b'},authLevel:'password',authSessionId:'session-a'});
  assert.equal(selected.company_id,'company-b');
  assert.equal(selected.role,'manager');
  assert.deepEqual(selected.module_grants,['finance','access']);
  assert.equal(first.company_id,'company-a','the pre-handler identity must not be mutated across requests');
  assert.equal(transactions,1);

  const global={id:'root',uid:'root',role:'super_admin',globalRole:'super_admin'};
  assert.equal(await handler({identity:global,query:{}}),global);
  assert.equal(transactions,1,'global /me remains a zero-query compatibility path');
});

function managementHarness({targetDisabled=false}={}) {
  const {app,routes}=captureApp(),authorizeCalls=[],authorizeActors=[],queries=[],auditCalls=[];
  const actor={id:'manager-a',username:'Manager',email:'manager@example.test',role:'manager',company_id:'company-a',
    workspace_id:'workspace-a',module_grants:['workspace'],assignments:[{company_id:'company-a',role:'manager'}],workspace_ids:[],disabled:false};
  const target={id:'operator-b',username:'Operator',email:'operator@example.test',role:'operator',company_id:'company-a',
    workspace_id:'',module_grants:['workspace'],assignments:[
      {company_id:'company-a',role:'operator',modules:['workspace']},
      {company_id:'company-b',role:'operator',modules:['finance','access']},
    ],workspace_ids:[],disabled:targetDisabled};
  const c={query:async(sql,params=[])=>{
    queries.push({sql,params});
    if(sql.includes('pg_advisory_xact_lock'))return {rowCount:1,rows:[{}]};
    if(sql.includes('FROM myfin.auth_session'))return {rowCount:1,rows:[{id:'session-a'}]};
    if(sql.includes('FROM myfin.app_identities i LEFT JOIN')&&sql.includes('WHERE i.id=$1'))
      return {rowCount:1,rows:[params[0]===target.id?target:actor]};
    if(sql.includes('FROM myfin.app_identities i LEFT JOIN'))return {rowCount:1,rows:[target]};
    if(sql.includes('SELECT workspace_id FROM myfin.companies'))return {rowCount:1,rows:[{workspace_id:'workspace-a'}]};
    return {rowCount:1,rows:[{}]};
  }};
  const db={transaction:fn=>fn(c)};
  const authorize=async(_c,who,company,admin=false)=>{
    authorizeCalls.push({company,admin});
    authorizeActors.push({...who});
    if(who.host_company_id&&who.host_company_id!==company)throw Object.assign(new Error('not_found'),{statusCode:404});
    who.role='manager';who.company_id=company;who.workspace_id='workspace-a';who.module_grants=['access'];
  };
  registerManagement(app,{db,authOptions:{},authorize,requireSuper:async()=>{},validateFileRefs:async()=>{},audit:async(...args)=>{auditCalls.push(args);}});
  const request=(extra={})=>({identity:{id:actor.id,role:'manager',company_id:'company-a',workspace_id:'workspace-a',module_grants:['workspace']},
    authLevel:'password',authSessionId:'session-a',query:{company:'company-b'},params:{},...extra});
  return {routes,authorizeCalls,authorizeActors,queries,auditCalls,request,target};
}

test('manager directory projects only the selected operator assignment', async () => {
  const h=managementHarness();
  const users=await h.routes.get('GET /api/users')(h.request());
  assert.equal(users[0].id,h.target.id);
  assert.equal(users[0].role,'operator');
  assert.equal(users[0].company_id,'company-b');
  assert.deepEqual(users[0].assignments,[{company_id:'company-b',role:'operator',modules:['finance','access']}]);
  assert.deepEqual(users[0].workspace_ids,[]);
  assert.deepEqual(h.authorizeCalls.slice(0,2),[
    {company:'company-b',admin:false},{company:'company-b',admin:true},
  ]);
  const listQuery=h.queries.find(row=>row.sql.includes('ORDER BY i.id LIMIT 1001'));
  assert.equal(listQuery.params[2],'company-b','manager visibility must use the selected company');
  assert.match(listQuery.sql,/NOT i\.is_super/);
  assert.match(listQuery.sql,/NOT EXISTS\(SELECT 1 FROM myfin\.workspace_memberships/);
});

test('tenant-host marker survives management actor refresh', async () => {
  const h=managementHarness();
  await assert.rejects(h.routes.get('GET /api/users')(h.request({identity:{...h.request().identity,host_company_id:'company-a'}})),
    error=>error.statusCode===404&&error.message==='not_found');
  assert.equal(h.authorizeActors[0].host_company_id,'company-a');
});

test('manager edits only the selected slice and revokes only company sessions', async () => {
  const h=managementHarness(),body={username:h.target.username,email:h.target.email,role:'operator',company_id:'company-b',workspace_id:'',
    assignments:[{company_id:'company-b',role:'operator',modules:['finance']}],disabled:false};
  await h.routes.get('PUT /api/users/:id')(h.request({params:{id:h.target.id},body}));
  const membershipDelete=h.queries.find(row=>row.sql.includes('DELETE FROM myfin.memberships WHERE identity_id=$1 AND company_id=$2'));
  assert.deepEqual(membershipDelete.params,[h.target.id,'company-b']);
  assert.equal(h.queries.some(row=>row.sql.includes('UPDATE myfin.app_identities SET display_name')),false);
  assert.equal(h.queries.some(row=>row.sql.includes('UPDATE myfin.auth_user SET name')),false);
  assert.equal(h.queries.some(row=>row.sql.includes('DELETE FROM myfin.auth_session')),false);
  assert.ok(h.queries.some(row=>row.sql.includes('UPDATE myfin.session_handoffs')&&row.sql.includes('target_hostname')&&row.sql.includes('tenant_hosts')&&row.params[1]==='company-b'));
  assert.ok(h.queries.some(row=>row.sql.includes('UPDATE myfin.app_sessions')&&row.sql.includes('tenant_hosts')&&row.params[1]==='company-b'));
  assert.ok(h.queries.some(row=>row.sql.includes('UPDATE myfin.pos_sessions')&&row.sql.includes('company_id=$2')&&row.params[1]==='company-b'));
  assert.equal(h.queries.some(row=>/^\s*(?:DELETE|UPDATE|INSERT)/.test(row.sql)&&row.params.includes('company-a')),false);
  const event=h.queries.find(row=>row.sql.includes('INSERT INTO myfin.management_events'));
  assert.equal(event.params[2],'company-b');
  assert.deepEqual(event.params[5].before.assignments,[{company_id:'company-b',role:'operator',modules:['finance','access']}]);
  assert.deepEqual(event.params[5].after.assignments,[{company_id:'company-b',role:'operator',modules:['finance'],workspace_id:'workspace-a'}]);
  assert.deepEqual(h.auditCalls.map(call=>call[2]),['company-b']);

  h.queries.length=0;
  await h.routes.get('POST /api/users/:id/revoke-sessions')(h.request({params:{id:h.target.id},body:{}}));
  assert.equal(h.queries.some(row=>row.sql.includes('DELETE FROM myfin.auth_session')),false);
  assert.ok(h.queries.some(row=>row.sql.includes('UPDATE myfin.session_handoffs')&&row.sql.includes('target_hostname')&&row.sql.includes('tenant_hosts')));
  assert.ok(h.queries.some(row=>row.sql.includes('UPDATE myfin.app_sessions')&&row.sql.includes('tenant_hosts')));
  assert.ok(h.queries.some(row=>row.sql.includes('UPDATE myfin.pos_sessions')&&row.params[1]==='company-b'));
});

test('manager cannot suspend or reactivate the shared identity', async () => {
  const active=managementHarness();
  await assert.rejects(active.routes.get('DELETE /api/users/:id')(active.request({params:{id:active.target.id}})),
    error=>error.statusCode===403&&error.message==='access_denied');
  assert.equal(active.queries.some(row=>row.sql.includes('UPDATE myfin.app_identities SET disabled_at')),false);
  const renamed={username:'Changed everywhere',email:active.target.email,role:'operator',company_id:'company-b',workspace_id:'',
    assignments:[{company_id:'company-b',role:'operator',modules:['access']}],disabled:false};
  await assert.rejects(active.routes.get('PUT /api/users/:id')(active.request({params:{id:active.target.id},body:renamed})),
    error=>error.statusCode===403&&error.message==='access_denied');

  const disabled=managementHarness({targetDisabled:true});
  const body={username:disabled.target.username,email:disabled.target.email,role:'operator',company_id:'company-b',workspace_id:'',
    assignments:[{company_id:'company-b',role:'operator',modules:['access']}],disabled:false};
  await assert.rejects(disabled.routes.get('PUT /api/users/:id')(disabled.request({params:{id:disabled.target.id},body})),
    error=>error.statusCode===403&&error.message==='access_denied');
  assert.equal(disabled.queries.some(row=>row.sql.includes('UPDATE myfin.app_identities SET display_name')),false);
});

test('manager cannot delegate a module outside their own selected-company grant', async () => {
  const h=managementHarness(),body={username:'New operator',email:'new-operator@example.test',password:'Strong test password 123!',
    role:'operator',company_id:'company-b',workspace_id:'',
    assignments:[{company_id:'company-b',role:'operator',modules:['finance']}],disabled:false};
  await assert.rejects(h.routes.get('POST /api/users')(h.request({body})),
    error=>error.statusCode===403&&error.message==='module_delegation_denied');
  assert.equal(h.queries.some(row=>row.sql.includes('INSERT INTO myfin.app_identities')),false);

  const edit={username:h.target.username,email:h.target.email,role:'operator',company_id:'company-b',workspace_id:'',
    assignments:[{company_id:'company-b',role:'operator',modules:['finance','workspace']}],disabled:false};
  await assert.rejects(h.routes.get('PUT /api/users/:id')(h.request({params:{id:h.target.id},body:edit})),
    error=>error.statusCode===403&&error.message==='module_delegation_denied');
});

function workspaceOwnerHarness({external=true}={}) {
  const {app,routes}=captureApp(),queries=[],auditCalls=[];
  const actor={id:'owner-a',username:'Owner',email:'owner@example.test',role:'workspace_owner',company_id:'company-a',
    workspace_id:'workspace-a',module_grants:null,assignments:[],workspace_ids:['workspace-a'],disabled:false};
  const localAssignment={company_id:'company-a',workspace_id:'workspace-a',role:'manager',modules:['access','finance']};
  const externalAssignment={company_id:'company-z',workspace_id:'workspace-z',role:'operator',modules:['workspace']};
  const target={id:'shared-user',username:'Shared User',email:'shared@example.test',role:external?'workspace_owner':'manager',
    company_id:'company-a',workspace_id:external?'workspace-z':'',module_grants:null,
    assignments:external?[localAssignment,externalAssignment]:[localAssignment],
    workspace_ids:external?['workspace-z']:[],disabled:false};
  const c={query:async(sql,params=[])=>{
    queries.push({sql,params});
    if(sql.includes('pg_advisory_xact_lock'))return {rowCount:1,rows:[{}]};
    if(sql.includes('FROM myfin.auth_session')&&!sql.trimStart().startsWith('DELETE'))return {rowCount:1,rows:[{id:'session-owner'}]};
    if(sql.includes('FROM myfin.app_identities i LEFT JOIN')&&sql.includes('WHERE i.id=$1'))
      return {rowCount:1,rows:[params[0]===target.id?target:actor]};
    if(sql.includes('FROM myfin.app_identities i LEFT JOIN'))return {rowCount:1,rows:[target]};
    if(sql.includes('SELECT 1 WHERE EXISTS'))return {rowCount:1,rows:[{}]};
    if(sql.includes(' AS external'))return {rowCount:1,rows:[{external}]};
    if(sql.includes('SELECT workspace_id FROM myfin.companies'))
      return {rowCount:1,rows:[{workspace_id:params[0]==='company-a'?'workspace-a':'workspace-z'}]};
    if(/^\s*(?:DELETE|UPDATE|INSERT)/.test(sql))return {rowCount:1,rows:[{}]};
    assert.fail(`unexpected query: ${sql}`);
  }};
  registerManagement(app,{db:{transaction:fn=>fn(c)},authOptions:{},authorize:async()=>{},requireSuper:async()=>{},
    validateFileRefs:async()=>{},audit:async(...args)=>{auditCalls.push(args);}});
  const request=(extra={})=>({identity:{id:actor.id,role:'workspace_owner',company_id:'company-a',workspace_id:'workspace-a',module_grants:null},
    authLevel:'password',authSessionId:'session-owner',query:{},params:{},...extra});
  const editBody=(overrides={})=>({username:target.username,email:target.email,role:'manager',company_id:'company-a',workspace_id:'',
    assignments:[{company_id:'company-a',role:'manager',modules:['access']}],disabled:false,...overrides});
  return {routes,queries,auditCalls,request,target,editBody};
}

test('workspace owner directory projection hides other-workspace assignments', async () => {
  const h=workspaceOwnerHarness();
  const users=await h.routes.get('GET /api/users')(h.request());
  assert.equal(users.length,1);
  assert.equal(users[0].id,h.target.id);
  assert.equal(users[0].role,'manager');
  assert.equal(users[0].company_id,'company-a');
  assert.equal(users[0].workspace_id,'');
  assert.deepEqual(users[0].assignments,[
    {company_id:'company-a',workspace_id:'workspace-a',role:'manager',modules:['access','finance']},
  ]);
  assert.deepEqual(users[0].workspace_ids,[]);
  assert.equal(JSON.stringify(users[0]).includes('workspace-z'),false);
  assert.equal(JSON.stringify(users[0]).includes('company-z'),false);
});

test('workspace owner cannot rename, suspend, or delete a shared identity', async () => {
  for(const [method,body] of [
    ['PUT',{username:'Renamed User'}],
    ['PUT',{disabled:true}],
    ['DELETE',null],
  ]){
    const h=workspaceOwnerHarness(),handler=h.routes.get(`${method} /api/users/:id`);
    const request={params:{id:h.target.id}};
    if(body)request.body=h.editBody(body);
    await assert.rejects(handler(h.request(request)),
      error=>error.statusCode===403&&error.message==='shared_identity_requires_super_admin');
    assert.equal(h.queries.some(row=>/^\s*(?:DELETE|UPDATE|INSERT)/.test(row.sql)),false);
  }
});

test('workspace owner assignment edit preserves external scope and revokes only workspace sessions', async () => {
  const h=workspaceOwnerHarness();
  await h.routes.get('PUT /api/users/:id')(h.request({params:{id:h.target.id},body:h.editBody()}));

  const externalChecks=h.queries.filter(row=>row.sql.includes(' AS external'));
  assert.equal(externalChecks.length,2);
  for(const check of externalChecks){
    assert.deepEqual(check.params,[h.target.id,'workspace-a']);
    assert.match(check.sql,/workspace_memberships WHERE identity_id=\$1 AND workspace_id<>\$2/);
    assert.match(check.sql,/memberships m JOIN myfin\.companies co .*co\.workspace_id<>\$2/s);
  }
  const membershipDelete=h.queries.find(row=>row.sql.includes('DELETE FROM myfin.memberships m USING myfin.companies co'));
  assert.deepEqual(membershipDelete.params,[h.target.id,'workspace-a']);
  assert.match(membershipDelete.sql,/co\.workspace_id=\$2/);
  assert.ok(h.queries.some(row=>row.sql.includes('DELETE FROM myfin.workspace_memberships WHERE identity_id=$1 AND workspace_id=$2')
    &&row.params[0]===h.target.id&&row.params[1]==='workspace-a'));
  assert.equal(h.queries.some(row=>row.sql.trim()==='DELETE FROM myfin.memberships WHERE identity_id=$1'),false);
  assert.equal(h.queries.some(row=>row.sql.trim()==='DELETE FROM myfin.workspace_memberships WHERE identity_id=$1'),false);
  const membershipWrites=h.queries.filter(row=>row.sql.includes('INSERT INTO myfin.memberships'));
  assert.deepEqual(membershipWrites.map(row=>row.params.slice(0,2)),[['company-a',h.target.id]]);
  const grantWrites=h.queries.filter(row=>row.sql.includes('INSERT INTO myfin.membership_module_grants'));
  assert.deepEqual(grantWrites.map(row=>row.params.slice(0,2)),[['company-a',h.target.id]]);
  assert.equal(h.queries.some(row=>row.sql.includes('UPDATE myfin.app_identities SET display_name')),false);
  assert.equal(h.queries.some(row=>row.sql.includes('UPDATE myfin.auth_user SET name')),false);

  const sessionMutations=h.queries.filter(row=>/^\s*(?:DELETE|UPDATE)/.test(row.sql)
    &&/(?:auth_session|session_handoffs|app_sessions|pos_sessions)/.test(row.sql));
  assert.equal(sessionMutations.some(row=>row.sql.includes('DELETE FROM myfin.auth_session')),false);
  assert.equal(sessionMutations.length,3);
  const handoff=sessionMutations.find(row=>row.sql.includes('UPDATE myfin.session_handoffs'));
  const appSession=sessionMutations.find(row=>row.sql.includes('UPDATE myfin.app_sessions'));
  const posSession=sessionMutations.find(row=>row.sql.includes('UPDATE myfin.pos_sessions'));
  assert.match(handoff.sql,/target_hostname IN .*tenant_hosts WHERE workspace_id=\$2/s);
  assert.match(appSession.sql,/hostname IN .*tenant_hosts WHERE workspace_id=\$2/s);
  assert.match(posSession.sql,/FROM myfin\.companies co .*co\.workspace_id=\$2/s);
  assert.deepEqual([handoff.params,appSession.params,posSession.params],Array(3).fill([h.target.id,'workspace-a']));
  const event=h.queries.find(row=>row.sql.includes('INSERT INTO myfin.management_events'));
  assert.deepEqual(event.params[5].before.assignments,[
    {company_id:'company-a',workspace_id:'workspace-a',role:'manager',modules:['access','finance']},
  ]);
  assert.deepEqual(event.params[5].after.assignments,[
    {company_id:'company-a',role:'manager',modules:['access'],workspace_id:'workspace-a'},
  ]);
  assert.equal(h.queries.some(row=>/^\s*(?:DELETE|UPDATE|INSERT)/.test(row.sql)
    &&/(?:company-z|workspace-z)/.test(JSON.stringify(row.params))),false);
  assert.deepEqual(h.auditCalls.map(call=>call[2]),['company-a']);
});

test('workspace owner edit keeps global session revocation for an exclusive identity', async () => {
  const h=workspaceOwnerHarness({external:false});
  await h.routes.get('PUT /api/users/:id')(h.request({params:{id:h.target.id},body:h.editBody()}));

  const sessionMutations=h.queries.filter(row=>/^\s*(?:DELETE|UPDATE)/.test(row.sql)
    &&/(?:auth_session|session_handoffs|app_sessions|pos_sessions)/.test(row.sql));
  assert.equal(sessionMutations.length,4);
  assert.ok(sessionMutations.some(row=>row.sql.includes('DELETE FROM myfin.auth_session')&&row.params[0]===h.target.id));
  const handoff=sessionMutations.find(row=>row.sql.includes('UPDATE myfin.session_handoffs'));
  const appSession=sessionMutations.find(row=>row.sql.includes('UPDATE myfin.app_sessions'));
  const posSession=sessionMutations.find(row=>row.sql.includes('UPDATE myfin.pos_sessions'));
  assert.equal(handoff.sql.includes('target_hostname'),false);
  assert.equal(appSession.sql.includes('tenant_hosts'),false);
  assert.equal(posSession.sql.includes('workspace_id=$2'),false);
  assert.deepEqual([handoff.params,appSession.params,posSession.params],Array(3).fill([h.target.id]));
});

test('global SuperAdmin directory and identity-wide session revocation remain available', async () => {
  const {app,routes}=captureApp();let authorizeCalls=0;const queries=[];
  const root={id:'root',username:'Root',email:'root@example.test',role:'super_admin',company_id:'',workspace_id:'',
    module_grants:null,assignments:[],workspace_ids:[],disabled:false};
  const target={id:'operator',username:'Operator',email:'operator@example.test',role:'operator',company_id:'company-a',workspace_id:'',
    module_grants:['workspace'],assignments:[{company_id:'company-a',role:'operator'}],workspace_ids:[],disabled:false};
  const c={query:async(sql,params=[])=>{
    queries.push({sql,params});
    if(sql.includes('pg_advisory_xact_lock'))return {rowCount:1,rows:[{}]};
    if(sql.includes('FROM myfin.auth_session'))return {rowCount:1,rows:[{id:'session-root'}]};
    if(sql.includes('FROM myfin.app_identities i LEFT JOIN')&&sql.includes('WHERE i.id=$1'))return {rowCount:1,rows:[params[0]===target.id?target:root]};
    if(sql.includes('FROM myfin.app_identities i LEFT JOIN'))return {rowCount:2,rows:[root,target]};
    if(sql.includes('SELECT id FROM myfin.app_identities'))return {rowCount:1,rows:[{id:'root'}]};
    if(/^\s*(?:DELETE|UPDATE|INSERT)/.test(sql))return {rowCount:1,rows:[{}]};
    assert.fail(`unexpected query: ${sql}`);
  }};
  registerManagement(app,{db:{transaction:fn=>fn(c)},authOptions:{},authorize:async()=>{authorizeCalls++;},
    requireSuper:async()=>{},validateFileRefs:async()=>{},audit:async()=>{}});
  const users=await routes.get('GET /api/users')({identity:root,authLevel:'password',authSessionId:'session-root',query:{},params:{}});
  assert.deepEqual(users.map(user=>user.id),['root','operator']);
  assert.equal(authorizeCalls,0);
  queries.length=0;
  await routes.get('POST /api/users/:id/revoke-sessions')({identity:root,authLevel:'password',authSessionId:'session-root',query:{},params:{id:target.id}});
  assert.ok(queries.some(row=>row.sql.includes('DELETE FROM myfin.auth_session')&&row.params[0]===target.id));
  assert.ok(queries.some(row=>row.sql.includes('UPDATE myfin.session_handoffs')&&!row.sql.includes('target_hostname')));
  assert.ok(queries.some(row=>row.sql.includes('UPDATE myfin.app_sessions')&&!row.sql.includes('tenant_hosts')));
  assert.ok(queries.some(row=>row.sql.includes('UPDATE myfin.pos_sessions')&&!row.sql.includes('company_id=$2')));
});
