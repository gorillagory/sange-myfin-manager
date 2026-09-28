import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
// Simulate an existing v1 database, including a paid receipt, before upgrading.
const old = await new Promise((resolve, reject) => {
  const r = indexedDB.open("myfin-pos", 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore("drafts");
    r.result.createObjectStore("outbox", { keyPath: "id" });
  };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
await new Promise((resolve, reject) => {
  const tx = old.transaction("outbox", "readwrite");
  tx.objectStore("outbox").put({
    id: "legacy-paid",
    cashierId: "old-uid",
    company_id: "a",
    total: 10,
  });
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
});
old.close();
const { localPos } = await import("../src/services/posLocal.js");
await test("version upgrade preserves paid receipts without merging historical identities", async () => {
  assert.equal((await localPos.sales("old-uid", "a")).length, 1);
  assert.equal((await localPos.sales("new-uid", "a")).length, 0);
});
await test("catalog, drafts and paid outbox remain partitioned through reload", async () => {
  await localPos.putCatalog("u1", "a", {
    products: [{ id: "a" }],
    clients: [],
  });
  await localPos.putCatalog("u1", "b", { products: [{ id: "b" }] });
  await localPos.putCatalog("u2", "a", { products: [{ id: "other" }] });
  await localPos.saveDraft("u1:a:till", {
    cart: [{ productId: "a" }],
    held: [{ id: "hold" }],
  });
  await localPos.acceptSale(
    { id: "paid-a", cashierId: "u1", company_id: "a", items: [], total: 10 },
    "u1:a:till",
    { cart: [], held: [{ id: "hold" }] },
  );
  const reloaded = (await import("../src/services/posLocal.js?reload"))
    .localPos;
  assert.equal((await reloaded.getCatalog("u1", "a")).products[0].id, "a");
  assert.equal((await reloaded.getCatalog("u1", "b")).products[0].id, "b");
  assert.equal((await reloaded.getCatalog("u2", "a")).products[0].id, "other");
  assert.equal((await reloaded.getDraft("u1:a:till")).cart.length, 0);
  assert.equal((await reloaded.getDraft("u1:a:till")).held.length, 1);
  assert.equal((await reloaded.sales("u1", "a")).length, 1);
  assert.equal((await reloaded.sales("u1", "b")).length, 0);
  await reloaded.putSale({
    ...(await reloaded.sales("u1", "a"))[0],
    syncError: "session_required",
  });
  assert.equal((await localPos.sales("u1", "a")).length, 1);
  await reloaded.removeSale("paid-a");
  assert.equal((await localPos.sales("u1", "a")).length, 0);
});
await test("failed atomic acceptance never clears a cart without its paid outbox entry", async () => {
  await localPos.saveDraft("u1:a:failed", { cart: [{ productId: "keep" }] });
  await assert.rejects(
    localPos.acceptSale({ cashierId: "u1", company_id: "a" }, "u1:a:failed", {
      cart: [],
    }),
  );
  assert.equal((await localPos.getDraft("u1:a:failed")).cart.length, 1);
});
