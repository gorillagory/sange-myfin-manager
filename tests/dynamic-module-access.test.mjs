import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import {
  MODULE_IDS, actorForCompany, defaultModulesForRole, effectiveModulesFor, moduleCeilingFor, permissionsFor,
} from '../src/domain/permissions.js';
import { userPayload } from '../src/domain/management.js';
import { canVisit, hydrationCollections } from '../src/domain/viewAccess.js';
import { userManagementPath } from '../src/services/api.js';

test('module grants are explicit per company while role ceilings remain authoritative', () => {
  assert.deepEqual(defaultModulesForRole('manager'), MODULE_IDS);
  assert.deepEqual(moduleCeilingFor('operator'), [
    'workspace', 'inventory', 'finance', 'administration', 'settings',
  ]);
  assert.deepEqual(effectiveModulesFor({ role:'manager', module_grants:null }), MODULE_IDS);
  assert.deepEqual(effectiveModulesFor({ role:'manager', module_grants:[] }), []);
  assert.deepEqual(effectiveModulesFor({ role:'operator', module_grants:['workspace','analytics','workspace'] }), ['workspace']);
});

test('owners cannot be locked out and explicit manager grants gate every module family', () => {
  for (const role of ['super_admin','workspace_owner']) {
    const owner = permissionsFor({ role, module_grants:[] });
    assert.deepEqual(owner.modules, MODULE_IDS);
    for (const capability of ['checkout','inventoryWrite','expensesWrite','analyticsRead',
      'companyWrite','templatesWrite','usersManage']) assert.equal(owner[capability], true, `${role} ${capability}`);
  }

  const cases = [
    ['workspace','checkout'], ['inventory','inventoryWrite'], ['finance','expensesWrite'],
    ['analytics','analyticsRead'], ['administration','companyWrite'],
    ['settings','templatesWrite'], ['access','usersManage'],
  ];
  for (const [module, capability] of cases) {
    assert.equal(permissionsFor({ role:'manager', module_grants:[] })[capability], false, capability);
    assert.equal(permissionsFor({ role:'manager', module_grants:[module] })[capability], true, capability);
  }
});

test('navigation and hydration follow the effective company assignment', () => {
  const finance = { role:'manager', module_grants:['finance'] };
  assert.equal(canVisit(finance, '/expenses'), true);
  assert.equal(canVisit(finance, '/receipt-reviews'), true);
  assert.equal(canVisit(finance, '/pos'), false);
  assert.equal(canVisit(finance, '/analytics'), false);
  assert.equal(canVisit(finance, '/users'), false);
  assert.deepEqual(hydrationCollections(finance), ['products','transactions','clients','expenses']);

  const workspace = { role:'operator', module_grants:['workspace'] };
  assert.equal(canVisit(workspace, '/pos'), true);
  assert.equal(canVisit(workspace, '/receipt-reviews'), false);
  assert.equal(canVisit(workspace, '/products'), false);
  assert.deepEqual(hydrationCollections(workspace), ['products','transactions','clients']);
});

test('management payload keeps grants company-scoped and removes modules outside the target role ceiling', () => {
  const payload = userPayload({
    username:' Team member ', email:'TEAM@example.com', password:'long-enough-password', role:'operator',
    company_ids:['company-a','company-b'], module_grants_by_company:{
      'company-a':['workspace','finance','analytics'], 'company-b':[],
    },
  });
  assert.deepEqual(payload.assignments, [
    { company_id:'company-a', role:'operator', modules:['workspace','finance'] },
    { company_id:'company-b', role:'operator', modules:[] },
  ]);
});

test('switching companies applies the selected membership grants rather than the first-company grants', () => {
  const user={ id:'manager-a',role:'manager',company_id:'company-a',workspace_id:'workspace-a',
    module_grants:['workspace'],companyMemberships:[
      {company_id:'company-a',workspace_id:'workspace-a',role:'manager',module_ids:['workspace']},
      {company_id:'company-b',workspace_id:'workspace-a',role:'manager',module_ids:['finance','access']},
    ],workspaceMemberships:[] };
  const next=actorForCompany(user,{id:'company-b',workspace_id:'workspace-a'});
  assert.equal(next.company_id,'company-b');
  assert.deepEqual(next.module_grants,['finance','access']);
  assert.equal(canVisit(next,'/expenses'),true);
  assert.equal(canVisit(next,'/pos'),false);
  assert.equal(canVisit(next,'/users'),true);

  const operator=actorForCompany({...user,id:'operator-a',role:'operator',companyMemberships:[
    {company_id:'company-a',workspace_id:'workspace-a',role:'operator',module_ids:['workspace']},
    {company_id:'company-b',workspace_id:'workspace-a',role:'operator',module_ids:['finance']},
  ]},{id:'company-b',workspace_id:'workspace-a'});
  assert.equal(operator.role,'operator');
  assert.deepEqual(operator.module_grants,['finance']);
  assert.equal(canVisit(operator,'/expenses'),true);
  assert.equal(canVisit(operator,'/pos'),false);
});

test('user administration paths preserve global mode and scope company mode', () => {
  assert.equal(userManagementPath('', '/operator-a'), '/users/operator-a');
  assert.equal(userManagementPath('company b', '/operator-a/revoke-sessions'),
    '/users/operator-a/revoke-sessions?company=company%20b');
});

test('team editor exposes accessible per-company module assignment controls', async () => {
  const source = await readFile(new URL('../src/components/management/UserEditor.vue', import.meta.url), 'utf8');
  assert.match(source, /module_grants_by_company/);
  assert.match(source, /:readonly="editing&&actor\.role==='manager'"/);
  assert.match(source, /Module access/);
  assert.match(source, /Enable all available/);
  assert.match(source, /Clear all/);
  const parsed = parse(source, { filename:'UserEditor.vue' });
  assert.deepEqual(parsed.errors, []);
  const script = compileScript(parsed.descriptor, { id:'dynamic-module-access' });
  const template = compileTemplate({
    source:parsed.descriptor.template.content, filename:'UserEditor.vue', id:'dynamic-module-access',
    compilerOptions:{ bindingMetadata:script.bindings },
  });
  assert.deepEqual(template.errors, []);
});

test('multi-company managers and operators can open the company switcher', async () => {
  const source = await readFile(new URL('../src/components/EditionShell.vue', import.meta.url), 'utf8');
  const storeSource = await readFile(new URL('../src/store/editionStore.js', import.meta.url), 'utf8');
  assert.match(source, /Store\.state\.companies\.length > 1/);
  assert.match(source, /:disabled="!canSwitchCompany"/);
  assert.match(storeSource, /actorForCompany\(state\.currentUser,company\)/);
  const parsed=parse(source,{filename:'EditionShell.vue'});
  assert.deepEqual(parsed.errors,[]);
  const script=compileScript(parsed.descriptor,{id:'company-switcher'});
  const template=compileTemplate({source:parsed.descriptor.template.content,filename:'EditionShell.vue',id:'company-switcher',compilerOptions:{bindingMetadata:script.bindings}});
  assert.deepEqual(template.errors,[]);
});

test('company-manager UI hides global lifecycle actions and labels scoped session revocation', async () => {
  const source = await readFile(new URL('../src/components/management/UserDirectory.vue', import.meta.url), 'utf8');
  assert.match(source, /!user\.disabled && Store\.can\('managersManage'\)/);
  assert.match(source, /user\.disabled && Store\.can\('managersManage'\)/);
  assert.match(source, /Sign out company sessions/);
  assert.match(source, /Other company sessions stay active/);
  const parsed=parse(source,{filename:'UserDirectory.vue'});
  assert.deepEqual(parsed.errors,[]);
  const script=compileScript(parsed.descriptor,{id:'manager-user-scope'});
  const template=compileTemplate({source:parsed.descriptor.template.content,filename:'UserDirectory.vue',id:'manager-user-scope',compilerOptions:{bindingMetadata:script.bindings}});
  assert.deepEqual(template.errors,[]);
});
