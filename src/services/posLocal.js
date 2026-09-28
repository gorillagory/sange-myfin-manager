import { CACHE_POLICY_VERSION, safeCatalog, safeDraft, safePaidSale, safeProfile } from '../domain/offlinePolicy.js';
// Only operational data is cached, including for owners. Paid intents never get
// deleted by an upgrade, logout, permission refresh or failed server submission.
let database;
function open() {
  if (!database) database = new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open('myfin-pos', CACHE_POLICY_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result, tx = request.transaction;
      for (const name of ['drafts','catalog','profiles'])
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath:'id' });
      const policies = { drafts:safeDraft, catalog:safeCatalog, profiles:safeProfile, outbox:safePaidSale };
      for (const [name, sanitize] of Object.entries(policies)) {
        const cursor = tx.objectStore(name).openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (row) { row.update(sanitize(row.value)); row.continue(); }
        };
      }
    };
    request.onblocked = () => {
      blocked = true;
      database = null;
      reject(new Error('Close other MyFin tabs, then reload to update protected device storage. Paid receipts are retained.'));
    };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => { request.result.close(); database = null; };
      resolve(request.result);
    };
    request.onerror = () => { database = null; reject(request.error); };
  });
  return database;
}
async function operation(store, method, ...args) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, ['get','getAll'].includes(method) ? 'readonly' : 'readwrite');
    const request = tx.objectStore(store)[method](...args);
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(tx.error || request.error || new Error('Unable to save on this device.'));
  });
}
export const localPos = {
  ready: () => open().then(() => true),
  getCatalog: async (uid,co) => {
    const value = await operation('catalog','get',uid+':'+co);
    return value ? safeCatalog(value) : null;
  },
  putCatalog: (uid,co,data) => operation('catalog','put',safeCatalog(data),uid+':'+co),
  getProfile: async uid => {
    const value = await operation('profiles','get',uid);
    return value ? safeProfile(value) : null;
  },
  putProfile: (uid,data) => operation('profiles','put',safeProfile(data),uid),
  acceptSale: async (sale,draftKey,nextDraft) => {
    const db = await open();
    return new Promise((resolve,reject) => {
      const tx = db.transaction(['drafts','outbox'],'readwrite');
      tx.objectStore('outbox').put(safePaidSale(sale));
      tx.objectStore('drafts').put(safeDraft(nextDraft),draftKey);
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Unable to save the payment on this device.'));
    });
  },
  getDraft: async key => safeDraft(await operation('drafts','get',key)),
  saveDraft: (key,value) => operation('drafts','put',safeDraft(value),key),
  putSale: value => operation('outbox','put',safePaidSale(value)),
  removeSale: id => operation('outbox','delete',id),
  sales: async (uid,companyId) => (await operation('outbox','getAll'))
    .filter(s => s.cashierId === uid && s.company_id === companyId).map(safePaidSale),
};
