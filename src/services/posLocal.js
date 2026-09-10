// Durable records are partitioned by authenticated user and company.
let database;
function open() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('myfin-pos', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('drafts'); request.result.createObjectStore('outbox', { keyPath: 'id' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = null; reject(request.error); };
  });
  return database;
}
async function operation(store, method, ...args) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, ['get', 'getAll'].includes(method) ? 'readonly' : 'readwrite');
    const request = tx.objectStore(store)[method](...args);
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(tx.error || request.error || new Error('Unable to save on this device.'));
  });
}
export const localPos = {
  acceptSale: async (sale, draftKey, nextDraft) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['drafts', 'outbox'], 'readwrite');
      tx.objectStore('outbox').put(JSON.parse(JSON.stringify(sale)));
      tx.objectStore('drafts').put(JSON.parse(JSON.stringify(nextDraft)), draftKey);
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Unable to save the payment on this device.'));
    });
  },
  getDraft: key => operation('drafts', 'get', key),
  saveDraft: (key, value) => operation('drafts', 'put', JSON.parse(JSON.stringify(value)), key),
  putSale: value => operation('outbox', 'put', JSON.parse(JSON.stringify(value))),
  removeSale: id => operation('outbox', 'delete', id),
  sales: async (uid, companyId) => (await operation('outbox', 'getAll')).filter(s => s.cashierId === uid && s.company_id === companyId)
};
