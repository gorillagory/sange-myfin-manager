const prefix='myfin-expense-create-v1:';
const validId=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value||''));
const key=companyId=>prefix+String(companyId||'');

// Keep only an opaque request UUID in this tab's session. Amounts,
// descriptions, receipt paths, and other financial data never enter storage.
export function loadOrCreateExpenseIntent(companyId, {
  storage=globalThis.sessionStorage,
  randomUUID=()=>globalThis.crypto.randomUUID(),
  committedIds=[],
}={}) {
  const storageKey=key(companyId);
  let current='';
  try { current=storage?.getItem(storageKey)||''; } catch { /* storage can be unavailable */ }
  if(validId(current)&&!committedIds.includes(current))return current;
  if(current)try { storage?.removeItem(storageKey); } catch { /* no-op */ }
  const id=randomUUID();
  if(!validId(id))throw new Error('A secure expense request identity could not be generated.');
  try { storage?.setItem(storageKey,id); } catch { /* the open form still retains the id */ }
  return id;
}

export function clearExpenseIntent(companyId,id,{storage=globalThis.sessionStorage}={}) {
  const storageKey=key(companyId);
  try { if(!id||storage?.getItem(storageKey)===id)storage?.removeItem(storageKey); } catch { /* no-op */ }
}
