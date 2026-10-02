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

const superAdmin = { uid: 'super-admin', id: 'super-admin', role: 'super_admin' };
const hostCompany = { id: 'host-company', name: 'Host company' };
const response = value => ({ ok: true, status: 200, json: async () => value });

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
} finally {
  Store.clearSession();
  await vite.close();
}
