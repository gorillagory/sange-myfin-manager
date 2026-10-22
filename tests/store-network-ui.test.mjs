import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import {
  TERMINAL_TYPES, cashSen, formatCashSen, mergeShiftContext, normalizeStoreNetwork, storePayload, terminalPayload,
  terminalCapabilitiesForType, terminalPresence,
} from '../src/domain/storeNetwork.js';
import { permissionsFor } from '../src/domain/permissions.js';
import { canVisit } from '../src/domain/viewAccess.js';
import { WORKSPACE_MODULES } from '../src/domain/workspaceModules.js';
import { networkRecordBody } from '../src/services/storeNetwork.js';

const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('store hierarchy normalizes legacy field names and staff area rows', () => {
  const network=normalizeStoreNetwork({
    policy:{terminalEnforcement:true},
    stores:[{id:'store-a',name:'Central',code:'CTR',address:{formatted:'1 Main Road'}}],
    locations:[{id:'area-a',store_id:'store-a',name:'Front',code:'FRONT'}],
    terminals:[{id:'term-a',store_id:'store-a',location_id:'area-a',name:'Till 1',code:'T1',enrolled_at:'2026-10-22T00:00:00Z'}],
    staffAssignments:[
      {identityId:'staff-a',locationId:'area-a'},
      {identity_id:'staff-a',location_id:'area-b'},
      {identityId:'staff-b',locationIds:['area-c']},
    ],
  });
  assert.equal(network.policy.terminalEnforcement,true);
  assert.equal(network.locations[0].storeId,'store-a');
  assert.equal(network.terminals[0].locationId,'area-a');
  assert.deepEqual(network.staffAssignments.find(row=>row.identityId==='staff-a').locationIds,['area-a','area-b']);
  assert.deepEqual(network.staffAssignments.find(row=>row.identityId==='staff-b').locationIds,['area-c']);
});

test('store and terminal payloads follow database-safe contracts', () => {
  assert.deepEqual(storePayload({name:'Bali / KL',code:'FRONT_COUNTER',address:' 1 Main Road '}),{
    code:'FRONT-COUNTER',name:'Bali / KL',type:'branch',status:'active',timeZone:'Asia/Kuala_Lumpur',address:{formatted:'1 Main Road'},
  });
  assert.deepEqual(storePayload({name:'Warehouse',address:{formatted:'Lot 8'}}).address,{formatted:'Lot 8'});
  assert.deepEqual(terminalPayload({name:'Till 1',storeId:'s',locationId:'l',capabilities:['pos','pos','stock']}),{
    storeId:'s',locationId:'l',code:'TILL-1',name:'Till 1',type:'pos',status:'pending',capabilities:['pos','stock'],
  });
  assert.deepEqual(TERMINAL_TYPES.map(item=>item.value),[
    'pos','kitchen_display','customer_display','back_office','print_connector','stock','multi_use',
  ]);
  assert.deepEqual(terminalCapabilitiesForType('pos'),['pos']);
  assert.deepEqual(terminalCapabilitiesForType('kitchen_display'),['kitchen']);
  assert.deepEqual(terminalCapabilitiesForType('customer_display'),['customer_display']);
  assert.deepEqual(terminalCapabilitiesForType('print_connector'),['label_printing']);
  assert.deepEqual(terminalCapabilitiesForType('multi_use'),[],'multi-use authority must be selected explicitly');
  assert.deepEqual(networkRecordBody({name:'Till 1',status:'pending',version:0}),{name:'Till 1'});
  assert.deepEqual(networkRecordBody({id:'terminal-a',name:'Till 1',status:'active',version:2}),{name:'Till 1',status:'active',version:2});
});

test('authoritative null shift values clear stale browser context while absent values preserve it', () => {
  const prior={staffSession:{id:'staff-session'},workShift:{id:'work'},registerShift:{id:'register'}};
  assert.deepEqual(mergeShiftContext(prior,{registerShift:null}),{
    staffSession:prior.staffSession,workShift:prior.workShift,registerShift:null,
  });
  assert.deepEqual(mergeShiftContext(prior,{staffSession:null,workShift:null,registerShift:null}),{
    staffSession:null,workShift:null,registerShift:null,
  });
  assert.equal(mergeShiftContext(prior,{}).registerShift,prior.registerShift);
});

test('presence language reports browser heartbeats without claiming network discovery', () => {
  assert.equal(terminalPresence({status:'pending'}).label,'Not enrolled');
  const recent=terminalPresence({status:'active',enrolledAt:'2026-10-22',lastSeenAt:'2026-10-22T10:00:00Z'},Date.parse('2026-10-22T10:01:00Z'));
  assert.equal(recent.state,'online');
  assert.match(recent.detail,/Reported/);
  assert.equal(cashSen('12.345'),1235);
  assert.equal(cashSen('-1'),null);
  assert.match(formatCashSen(1234,'RM'),/12\.34/);
});

test('network and shift permissions follow module grants and POS code sessions stay operational', () => {
  const owner={role:'workspace_owner'};
  assert.equal(permissionsFor(owner).networkPolicyManage,true);
  assert.equal(canVisit(owner,'/store-network'),true);
  const manager={role:'manager',module_grants:['administration','workspace']};
  assert.equal(permissionsFor(manager).storeNetworkManage,true);
  assert.equal(permissionsFor(manager).networkPolicyManage,false);
  assert.equal(canVisit(manager,'/shifts'),true);
  const fast={...manager,authLevel:'pos_code'};
  assert.equal(canVisit(fast,'/shifts'),true);
  assert.equal(canVisit(fast,'/receipt-reviews'),false,'finance grant remains required');
  assert.equal(canVisit(fast,'/store-network'),false);
  assert.equal(canVisit(fast,'/companies'),false);
  assert.equal(canVisit(fast,'/users'),false);
  assert.equal(canVisit(fast,'/marketing'),false);
});

test('workspace navigation places shifts under Workspace and Store Network under Administration', () => {
  const workspace=WORKSPACE_MODULES.find(module=>module.id==='workspace');
  const administration=WORKSPACE_MODULES.find(module=>module.id==='administration');
  assert.equal(workspace.pages.find(page=>page.path==='/shifts').title,'Shifts & Cash');
  assert.equal(administration.pages.find(page=>page.path==='/store-network').title,'Store Network');
});

test('terminal enrollment uses an HttpOnly cookie contract and never stores a secret', async () => {
  const [api,service,identity]=await Promise.all([
    source('src/services/api.js'),source('src/services/storeNetwork.js'),source('src/services/terminalIdentity.js'),
  ]);
  assert.match(api,/credentials: "same-origin"/);
  assert.match(api,/error\.body = result/);
  assert.doesNotMatch(`${api}\n${service}\n${identity}`,/X-Myfin-Terminal-Secret|terminalRequestHeaders|saveTerminalCredential|credential\.secret/);
  assert.match(service,/\/terminal-enrollment\/claim/);
  assert.match(service,/skipSessionExpiry:true/);
  assert.match(service,/\/terminal-context\/heartbeat/);
  assert.match(service,/\/terminal-context\/staff-sign-out/);
});

test('terminal and shift browser state follows authoritative context and company boundaries', async () => {
  const [store,shifts]=await Promise.all([
    source('src/store/editionStore.js'),source('src/components/dashboard/ShiftsTab.vue'),
  ]);
  assert.match(store,/companyId:value\.companyId \|\| value\.company_id \|\| null/);
  assert.match(store,/state\.shiftContext=\{staffSession:null,workShift:null,registerShift:null\}/);
  assert.match(store,/clearCompany\(options = \{\}\)[\s\S]*?state\.shiftContext=\{ staffSession:null, workShift:null, registerShift:null \}/);
  assert.match(store,/clearCompany\(\{nextCompanyId:company\?\.id \|\| null\}\)/);
  assert.match(store,/emptyTerminalContext\(true,error\.body\?\.policy \|\| \{\}\)/);
  assert.match(shifts,/const canOperate=computed\(\(\)=>Boolean\(context\.value\.enrolled && Store\.can\('shiftOperate'\)\)\)/);
  assert.doesNotMatch(shifts,/canOperate[^\n]*authLevel/);
  const logout=store.slice(store.indexOf('async logout()'),store.indexOf('clearCompany(options'));
  assert.ok(logout.indexOf('signOutTerminalStaff()')<logout.indexOf('api("/auth/sign-out"'),'terminal occupancy ends before password logout');
});

test('store network, shift, setup, login, and shell components compile with accessible workflows', async () => {
  const paths=[
    'src/components/TerminalSetup.vue','src/components/PosLogin.vue','src/components/EditionShell.vue',
    'src/components/dashboard/StoreNetworkTab.vue','src/components/dashboard/ShiftsTab.vue',
  ];
  for(const path of paths){
    const contents=await source(path),parsed=parse(contents,{filename:path});
    assert.deepEqual(parsed.errors,[],`${path} parse`);
    const script=compileScript(parsed.descriptor,{id:`store-network-${path.replace(/\W/g,'-')}`});
    const template=compileTemplate({source:parsed.descriptor.template.content,filename:path,id:`store-network-${path.replace(/\W/g,'-')}`,compilerOptions:{bindingMetadata:script.bindings}});
    assert.deepEqual(template.errors,[],`${path} template`);
  }
  const [setup,pos,shell,network,shifts]=await Promise.all(paths.map(source));
  assert.match(setup,/MyFin does not scan your network or fingerprint this machine/);
  assert.match(setup,/pairing code is valid only on its canonical company host/);
  assert.match(network,/Physical operations and public ordering stay distinct/);
  assert.match(network,/All company stores/);
  assert.match(network,/Create pairing code/);
  assert.match(network,/delete payload\.status/);
  assert.match(network,/An enrolled terminal keeps its historical store and area/);
  assert.match(network,/Pairing is the only way a pending terminal becomes active/);
  assert.match(shifts,/Take over register/);
  assert.match(shifts,/currentExpectedCashSen/);
  assert.match(shifts,/cashRequestId\.value=crypto\.randomUUID\(\)/);
  assert.match(shifts,/requestId:cashRequestId\.value/);
  assert.match(shifts,/closeRequestId\.value=crypto\.randomUUID\(\)/);
  assert.match(shifts,/requestId:closeRequestId\.value/);
  assert.match(pos,/terminalRequired/);
  assert.match(shell,/mf-sidebar-terminal/);
});

test('terminal and shift routes are lazy and terminal setup is reachable before staff login', async () => {
  const [router,auth,pos]=await Promise.all([source('src/router/index.js'),source('src/components/AuthManager.vue'),source('src/components/dashboard/EditionPos.vue')]);
  assert.match(router,/path: '\/terminal-setup'/);
  assert.match(router,/path: '\/store-network'/);
  assert.match(router,/path: '\/shifts'/);
  assert.match(auth,/\$route\.path==='\/terminal-setup'/);
  assert.match(pos,/terminalDraftId=Store\.state\.terminalContext\?\.terminal\?\.id\|\|'legacy'/);
  assert.match(pos,/requiresOpenRegister/);
});
