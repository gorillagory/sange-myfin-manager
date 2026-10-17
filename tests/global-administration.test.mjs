import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) || null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key),
};

const vite = await createServer({
  server: { middlewareMode: true, hmr: { port: 0 } },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
const { Store } = await vite.ssrLoadModule('/src/store/editionStore.js');
const { localPos } = await vite.ssrLoadModule('/src/services/posLocal.js');

const superAdmin = { uid: 'super-admin', id: 'super-admin', role: 'super_admin' };
const hostCompany = { id: 'host-company', name: 'Host company' };
const response = (value,status=200) => ({ ok: status < 400, status, json: async () => value });

try {
  await test('directory refresh after enrollment keeps an explicit SuperAdmin global view', async () => {
    Store.clearSession();
    Store.state.currentUser = { ...superAdmin };
    Store.state.companies = [hostCompany];
    Store.state.selectedCompany = hostCompany;
    Store.state.tenantContext = { company: hostCompany };
    Store.state.online = true;

    Store.selectCompany(null, { hydrate: false });
    assert.equal(Store.state.globalAdministration, true);

    globalThis.fetch = async path => {
      if (path === '/api/me') return response({ ...superAdmin });
      if (path === '/api/companies') return response([hostCompany]);
      if (path === '/api/users') return response([]);
      throw new Error('unexpected request: ' + path);
    };

    await Store.startListeners({ hydrate: false });

    assert.equal(Store.state.selectedCompany, null);
    assert.equal(Store.state.globalAdministration, true);
  });

  await test('SuperAdmin can explicitly leave global administration for a workspace', async () => {
    Store.state.currentUser = { ...superAdmin };
    Store.state.companies = [hostCompany];
    Store.state.online = true;

    Store.selectCompany(hostCompany, { hydrate: false });

    assert.equal(Store.state.selectedCompany.id, hostCompany.id);
    assert.equal(Store.state.globalAdministration, false);
  });

  await test('secondary-company refresh keeps the selection and scopes actor and user directory requests', async () => {
    const companies=[
      {id:'company-a',name:'A',workspace_id:'workspace-a'},
      {id:'company-b',name:'B',workspace_id:'workspace-a'},
    ];
    const selectedActor={uid:'manager',id:'manager',role:'manager',company_id:'company-b',workspace_id:'workspace-a',
      module_grants:['access'],workspaceMemberships:[],companyMemberships:[
        {company_id:'company-a',workspace_id:'workspace-a',role:'manager',module_ids:['workspace']},
        {company_id:'company-b',workspace_id:'workspace-a',role:'manager',module_ids:['access']},
      ]};
    Store.clearSession();
    Store.state.currentUser={...selectedActor};
    Store.state.companies=companies;
    Store.state.selectedCompany=companies[1];
    Store.state.tenantContext={};
    Store.state.online=true;
    const requested=[];
    globalThis.fetch=async path=>{
      requested.push(path);
      if(path==='/api/me?company=company-b')return response({...selectedActor});
      if(path==='/api/companies')return response(companies);
      if(path==='/api/users?company=company-b')return response([]);
      throw new Error('unexpected request: '+path);
    };

    await Store.startListeners({hydrate:false});

    assert.equal(Store.state.selectedCompany.id,'company-b');
    assert.equal(Store.state.currentUser.company_id,'company-b');
    assert.deepEqual(Store.state.currentUser.module_grants,['access']);
    assert.ok(requested.includes('/api/me?company=company-b'));
    assert.ok(requested.includes('/api/users?company=company-b'));
    assert.ok(!requested.includes('/api/me'));
    assert.ok(!requested.includes('/api/users'));
  });

  await test('revoked selected-company access clears confidential UI state without deleting the paid device queue', async () => {
    const company={id:'revoked-company',name:'Revoked',workspace_id:'workspace-a'};
    const user={uid:'manager',id:'manager',role:'manager',company_id:company.id,workspace_id:'workspace-a',
      module_grants:['inventory','finance','access'],companyMemberships:[{company_id:company.id,role:'manager'}]};
    Store.clearSession();
    Store.state.currentUser={...user};
    Store.state.companies=[company];
    Store.state.selectedCompany=company;
    Store.state.online=true;
    Store.state.products=[{id:'private-product',cost:999}];
    Store.state.transactions=[{id:'private-sale'}];
    Store.state.expenses=[{id:'private-expense'}];
    Store.state.clients=[{id:'private-supplier',type:'Supplier'}];
    Store.state.activities=[{id:'private-event'}];
    Store.state.users=[{id:'private-user'}];
    await localPos.putSale({id:'retain-revoked-paid',cashierId:user.id,company_id:company.id,total:10});
    globalThis.fetch=async path=>{
      assert.equal(path,'/api/me?company=revoked-company');
      return response({error:'access_denied'},403);
    };

    await assert.rejects(Store.refreshActor(),error=>error.status===403);

    assert.equal(Store.state.selectedCompany,null);
    assert.deepEqual(Store.state.companies,[]);
    for(const key of ['products','transactions','expenses','clients','activities','users'])
      assert.deepEqual(Store.state[key],[],`${key} must be cleared`);
    assert.equal(Store.state.currentUser.role,'');
    assert.equal(Store.state.sessionVerified,false);
    assert.ok((await localPos.sales(user.id,company.id)).some(sale=>sale.id==='retain-revoked-paid'));
    await localPos.removeSale('retain-revoked-paid');
  });
} finally {
  Store.clearSession();
  await vite.close();
}
