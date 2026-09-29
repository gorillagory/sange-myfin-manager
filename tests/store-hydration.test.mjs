import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) || null,
  setItem: (k, v) => storage.set(k, v),
  removeItem: (k) => storage.delete(k),
};
const vite = await createServer({
  server: { middlewareMode: true, hmr:{port:0} },
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});
const { Store } = await vite.ssrLoadModule("/src/store/editionStore.js");
const { hydrationCollections } = await vite.ssrLoadModule("/src/domain/viewAccess.js");
const respond = (rows) => ({
  ok: true,
  status: 200,
  json: async () => ({ rows, next: null }),
});
try {
  await test("tenant switch clears all business state before asynchronous hydration and discards stale results", async () => {
    Store.state.currentUser = {
      uid: "operator",
      id: "operator",
      role: "super",
    };
    Store.state.companies = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ];
    Store.state.selectedCompany = { id: "a" };
    Store.state.products = [{ id: "secret-a" }];
    Store.state.transactions = [{ id: "sale-a" }];
    const pending = [];
    globalThis.fetch = async (path) => {
      if(path === "/api/me")return {ok:true,status:200,json:async()=>Store.state.currentUser};
      if(path.endsWith("/receipt-reviews"))return {ok:true,status:200,json:async()=>[]};
      if (path.includes("/companies/a/"))
        return new Promise((resolve) =>
          pending.push(() => resolve(respond([{ id: "stale-a" }]))),
        );
      return respond([]);
    };
    const first = Store.refreshData();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(pending.length, hydrationCollections(Store.state.currentUser).length);
    Store.selectCompany(Store.state.companies[1]);
    assert.equal(Store.state.products.length, 0);
    assert.equal(Store.state.transactions.length, 0);
    for (const resolve of pending) resolve();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(Store.state.selectedCompany.id, "b");
    assert.equal(Store.state.products.length, 0);
  });
  await test("older requests cannot overwrite a newer refresh within the same company", async () => {
    const pending = [];
    globalThis.fetch = async () =>
      new Promise((resolve) =>
        pending.push(() => resolve(respond([{ id: "older" }]))),
      );
    const older = Store.refreshData();
    await new Promise((resolve) => setTimeout(resolve, 10));
    globalThis.fetch = async () => respond([{ id: "newer", variants: [] }]);
    await Store.refreshData();
    for (const resolve of pending) resolve();
    await older;
    assert.equal(Store.state.products[0].id, "newer");
  });
  await test("logout clears visible tenant data but never deletes a paid receipt", async () => {
    const { localPos } = await vite.ssrLoadModule("/src/services/posLocal.js");
    await localPos.putSale({
      id: "retain-paid",
      cashierId: "operator",
      company_id: "b",
    });
    Store.state.pendingSales = await localPos.sales("operator", "b");
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });
    await Store.logout();
    assert.equal(Store.state.currentUser, null);
    assert.equal(Store.state.products.length, 0);
    assert.equal((await localPos.sales("operator", "b")).length, 1);
  });
} finally {
  await vite.close();
}
