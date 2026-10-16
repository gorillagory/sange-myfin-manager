const prefix='myfin.receipt-email-intent.v1:';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const normalize=value=>String(value||'').trim().toLowerCase();
export const receiptEmailIntentKey=(companyId,saleId)=>`${prefix}${encodeURIComponent(companyId)}:${encodeURIComponent(saleId)}`;
async function digest(value,subtle=globalThis.crypto?.subtle){
  if(!subtle)throw new Error('secure_digest_unavailable');
  const bytes=await subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

export async function loadReceiptEmailIntent(companyId,saleId,recipient,{storage=globalThis.localStorage,subtle=globalThis.crypto?.subtle}={}){
  const key=receiptEmailIntentKey(companyId,saleId),normalized=normalize(recipient);
  let recipientDigest;
  try{recipientDigest=await digest(normalized,subtle);}catch{return null;}
  try{
    const saved=JSON.parse(storage?.getItem(key)||'null');
    return saved?.recipientDigest===recipientDigest&&uuid.test(String(saved?.id||''))
      ? {id:saved.id,recipient:normalized} : null;
  }catch{return null;}
}

export async function loadOrCreateReceiptEmailIntent(companyId,saleId,recipient,{storage=globalThis.localStorage,randomUUID=()=>globalThis.crypto.randomUUID(),subtle=globalThis.crypto?.subtle}={}){
  const key=receiptEmailIntentKey(companyId,saleId),normalized=normalize(recipient);
  let recipientDigest;
  try{recipientDigest=await digest(normalized,subtle);}catch{return {id:randomUUID(),recipient:normalized};}
  const saved=await loadReceiptEmailIntent(companyId,saleId,normalized,{storage,subtle});
  if(saved)return saved;
  const intent={id:randomUUID(),recipient:normalized};
  try{storage?.setItem(key,JSON.stringify({id:intent.id,recipientDigest}));}catch{/* The component retains this intent for its current lifetime. */}
  return intent;
}

export function clearReceiptEmailIntent(companyId,saleId,intent,{storage=globalThis.localStorage}={}){
  const key=receiptEmailIntentKey(companyId,saleId);
  try{
    const saved=JSON.parse(storage?.getItem(key)||'null');
    if(!intent||saved?.id===intent.id)storage?.removeItem(key);
  }catch{try{storage?.removeItem(key);}catch{/* Ignore inaccessible optional storage. */}}
}

export const receiptEmailRecipient=value=>normalize(value);
