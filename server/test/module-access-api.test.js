import assert from 'node:assert/strict';
import test from 'node:test';
import { registerAdvancedAnalytics } from '../src/advanced-analytics.js';
import { registerCustomerProfiles } from '../src/customer-profiles.js';
import { registerDocuments } from '../src/documents.js';
import { registerOrders } from '../src/orders.js';
import { registerStock } from '../src/stock.js';
import { registerWorkspaces } from '../src/workspaces.js';
import { registerReporting } from '../src/reporting.js';
import { checkout } from '../src/business.js';
import { cartItem, createSale } from '../../src/domain/pos.js';

function captureApp() {
  const routes = new Map(), app = {};
  for (const method of ['get','post','put','patch','delete']) app[method] = (path, ...rest) => {
    routes.set(`${method.toUpperCase()} ${path}`, rest.at(-1));
  };
  return { app, routes };
}
const denied = error => error?.statusCode === 403 && error?.message === 'access_denied';
const actor = modules => ({ id:'manager-a', role:'manager', company_id:'company-a', module_grants:modules });
const noQuery = { query:async () => assert.fail('authorization must reject before module data is queried') };
const scoped = req => fn => fn(noQuery, 'company-a');

test('direct API handlers deny a manager whose company grant omits each module family', async t => {
  const cases = [
    ['workspace', 'GET /api/companies/:company/orders/summary', ({app}) =>
      registerOrders(app, { scoped:(req,fn)=>scoped(req)(fn), audit:async()=>{} }), { query:{} }],
    ['inventory', 'GET /api/companies/:company/stock_items', ({app}) =>
      registerStock(app, { scoped:(req,fn)=>scoped(req)(fn), audit:async()=>{} }), { query:{} }],
    ['analytics', 'GET /api/companies/:company/analytics/operations', ({app}) =>
      registerAdvancedAnalytics(app, { scoped:(req,fn)=>scoped(req)(fn) }), { query:{} }],
    ['administration', 'GET /api/companies/:company/customer-profiles', ({app}) =>
      registerCustomerProfiles(app, { scoped:(req,fn)=>scoped(req)(fn) }), { query:{} }],
  ];
  for (const [family, key, register, extra] of cases) await t.test(family, async () => {
    const harness = captureApp(); register(harness);
    await assert.rejects(harness.routes.get(key)({
      identity:actor([]), params:{ company:'company-a' }, ...extra,
    }), denied);
  });

  await t.test('finance', async () => {
    const { app, routes } = captureApp();
    const db = { transaction:fn => fn({ query:async sql => {
      if (/pg_advisory_xact_lock|auth_session/.test(sql)) return { rowCount:1, rows:[{id:'session-a'}] };
      return noQuery.query();
    } }) };
    registerDocuments(app, { db, authorize:async()=>{}, audit:async()=>{} });
    await assert.rejects(routes.get('GET /api/companies/:company/documents')({
      identity:actor([]), params:{company:'company-a'}, authLevel:'password', authSessionId:'session-a',
    }), denied);
  });

  await t.test('settings', async () => {
    const { app, routes } = captureApp();
    const db = { transaction:fn => fn({ query:async sql => {
      if (/pg_advisory_xact_lock|auth_session/.test(sql)) return { rowCount:1, rows:[{id:'session-a'}] };
      return noQuery.query();
    } }) };
    registerDocuments(app, { db, authorize:async()=>{}, audit:async()=>{} });
    await assert.rejects(routes.get('POST /api/companies/:company/templates')({
      identity:actor([]), params:{company:'company-a'}, authLevel:'password', authSessionId:'session-a', body:{},
    }), denied);
  });

  await t.test('access', async () => {
    const { app, routes } = captureApp();
    const db = { transaction:fn => fn({ query:async sql => {
      if (/pg_advisory_xact_lock|auth_session/.test(sql)) return { rowCount:1, rows:[{id:'session-a'}] };
      return noQuery.query();
    } }) };
    registerWorkspaces(app, { db, authOptions:{pos:{codeSecret:'x',sessionSecret:'y'}},
      authorize:async()=>{}, audit:async()=>{}, validateFileRefs:async()=>{} });
    await assert.rejects(routes.get('POST /api/companies/:company/users/:user/pos-code')({
      identity:actor([]), params:{company:'company-a',user:'operator-a'}, authLevel:'password',
      authSessionId:'session-a', body:{},
    }), denied);
  });
});

test('finance can read published document templates without gaining Settings write access', () => {
  const financeOnly = actor(['finance']);
  // Route guard assertions live in the domain permission object used by every API requireCapability call.
  return import('../../src/domain/permissions.js').then(({permissionsFor}) => {
    assert.equal(permissionsFor(financeOnly).templatesRead, true);
    assert.equal(permissionsFor(financeOnly).templatesWrite, false);
  });
});

test('workspace company listing limits a company member to assigned companies and a public projection', async () => {
  const { app, routes } = captureApp(), calls=[];
  const client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.includes('pg_advisory_xact_lock'))return {rowCount:1,rows:[{}]};
    if(sql.includes('FROM myfin.auth_session'))return {rowCount:1,rows:[{id:'session-a'}]};
    if(sql.includes('FROM myfin.app_identities WHERE id=$1 AND is_super'))return {rowCount:0,rows:[]};
    if(sql.includes('FROM myfin.workspace_memberships WHERE workspace_id=$1'))return {rowCount:0,rows:[]};
    if(sql.startsWith('SELECT 1 FROM myfin.companies co JOIN myfin.memberships'))return {rowCount:1,rows:[{}]};
    if(sql.includes('LEFT JOIN myfin.membership_module_grants'))return {rowCount:1,rows:[{
      id:'company-a',workspace_id:'workspace-a',name:'Company A',slug:'company-a',hostname:'company-a.test',
      suspended_at:null,membership_role:'manager',membership_modules:['workspace'],
      data:{name:'Company A',registration:'REG-1',integrationSecret:'must-not-leak',preferences:{currency:'RM',privateKey:'hidden'}},
    }]};
    assert.fail(`unexpected query: ${sql}`);
  }};
  registerWorkspaces(app,{db:{transaction:fn=>fn(client)},authOptions:{},authorize:async()=>{},audit:async()=>{},validateFileRefs:async()=>{}});
  const rows=await routes.get('GET /api/workspaces/:workspace/companies')({
    identity:{id:'manager-a',role:'manager',company_id:'company-a',module_grants:['workspace']},
    authLevel:'password',authSessionId:'session-a',params:{workspace:'workspace-a'},
  });
  assert.deepEqual(rows,[{id:'company-a',name:'Company A',registration:'REG-1',preferences:{currency:'RM'},
    slug:'company-a',workspace_id:'workspace-a',hostname:'company-a.test',suspended:false}]);
  const list=calls.find(call=>call.sql.includes('LEFT JOIN myfin.membership_module_grants'));
  assert.match(list.sql,/\(\$2 OR m\.identity_id IS NOT NULL\)/);
  assert.deepEqual(list.params,['workspace-a',false,'manager-a']);
});

test('an Access-only manager cannot issue a POS code for an operator with broader modules', async () => {
  const { app, routes }=captureApp();let targetRead=false;
  const client={query:async sql=>{
    if(sql.includes('pg_advisory_xact_lock'))return {rowCount:1,rows:[{}]};
    if(sql.includes('FROM myfin.auth_session'))return {rowCount:1,rows:[{id:'session-a'}]};
    if(sql.includes('LEFT JOIN myfin.membership_module_grants')){
      targetRead=true;return {rowCount:1,rows:[{role:'operator',module_ids:['finance']}]};
    }
    assert.fail(`authorization must reject before POS code persistence: ${sql}`);
  }};
  registerWorkspaces(app,{db:{transaction:fn=>fn(client)},authOptions:{pos:{codeSecret:'test'}},
    authorize:async()=>{},audit:async()=>{},validateFileRefs:async()=>{}});
  await assert.rejects(routes.get('POST /api/companies/:company/users/:user/pos-code')({
    identity:{id:'manager-a',role:'manager',company_id:'company-a',module_grants:['access']},
    authLevel:'password',authSessionId:'session-a',params:{company:'company-a',user:'operator-a'},body:{},
  }),error=>error.statusCode===403&&error.message==='module_delegation_denied');
  assert.equal(targetRead,true);
});

test('receipt approval uses the finance reviewer capability while direct POS posting still requires workspace checkout', async () => {
  const company = { id:'company-a', name:'Company A', preferences:{ currency:'RM', taxRate:0 } };
  const product = { id:'product-a', name:'Item', price:10, stock:0, trackStock:false };
  const saleFor = (id, identity) => createSale({
    id,
    items:[cartItem(product)],
    company,
    user:{ uid:identity.id, username:identity.username },
    method:'Cash',
    received:10,
  });
  const reachedPosting = Error('reached posting after capability check');
  const client = { query:async () => { throw reachedPosting; } };
  const financeReviewer = { id:'finance-manager', username:'Finance manager', role:'manager', module_grants:['finance'] };
  const cashier = { id:'cashier-a', username:'Cashier', role:'operator', module_grants:[] };
  const reviewedSale = saleFor('reviewed-sale', cashier);

  await assert.rejects(
    checkout(client, cashier, company.id, reviewedSale,
      { who:financeReviewer, reason:'Verified the recorded payment' }, { serverNow:reviewedSale.date }),
    error => error === reachedPosting,
    'review posting must authorize the finance reviewer rather than require checkout from the original cashier',
  );

  const workspaceOperator = { id:'workspace-operator', username:'Operator', role:'operator', module_grants:['workspace'] };
  const liveSale = saleFor('live-sale', workspaceOperator);
  await assert.rejects(
    checkout(client, workspaceOperator, company.id, liveSale, null, { serverNow:liveSale.date }),
    error => error === reachedPosting,
    'ordinary workspace checkout must continue into posting',
  );

  const financeSale = saleFor('finance-pos-sale', financeReviewer);
  await assert.rejects(
    checkout(client, financeReviewer, company.id, financeSale, null, { serverNow:financeSale.date }),
    denied,
    'finance access alone must not grant direct POS posting',
  );
  await assert.rejects(
    checkout(client, cashier, company.id, reviewedSale,
      { who:{ ...financeReviewer, module_grants:['workspace'] }, reason:'Invalid reviewer scope' },
      { serverNow:reviewedSale.date }),
    denied,
    'workspace access alone must not grant receipt-review resolution',
  );
});

test('consolidation derives access per company instead of the session first company', async () => {
  const { app, routes } = captureApp(), calls=[];
  const client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.includes('FROM myfin.companies co JOIN myfin.workspaces'))return {rowCount:1,rows:[{
      id:'company-b',name:'Company B',workspace_id:'workspace-b',workspace_name:'Workspace B',currency:'RM',
    }]};
    return {rowCount:0,rows:[]};
  }};
  registerReporting(app,{db:{transaction:fn=>fn(client)},managed:(_req,fn)=>fn(client,
    {id:'manager-a',role:'manager',company_id:'company-a',module_grants:[]}),authorize:async()=>{},managementSession:async()=>{}});
  const result=await routes.get('GET /api/reports/consolidation')({query:{
    from:'2026-10-01',to:'2026-10-01',workspaceId:'workspace-b',
  },identity:{id:'manager-a',role:'manager',company_id:'company-a',module_grants:[]}});
  assert.equal(result.companies[0].id,'company-b');
  assert.match(calls[0].sql,/membership_module_grants/);
  assert.match(calls[0].sql,/'analytics'=ANY\(g\.module_ids\)/);
  assert.deepEqual(calls[0].params,['manager-a',false,'']);
});
