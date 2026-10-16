import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  clearReceiptEmailIntent, loadOrCreateReceiptEmailIntent, loadReceiptEmailIntent, receiptEmailIntentKey,
} from '../src/services/receiptEmailIntent.js';

function memoryStorage(){const data=new Map();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key),data};}

test('lost receipt-email response reuses the same durable request after a component reload',async()=>{
  const storage=memoryStorage(),ids=['26fd6e24-a245-4cc0-b2b4-8c3affed322a','b8af7c49-a2bc-4e2e-87a2-e71945bd4509'];
  const options={storage,randomUUID:()=>ids.shift(),subtle:globalThis.crypto.subtle};
  const first=await loadOrCreateReceiptEmailIntent('company','sale',' Customer@Example.test ',options);
  // A reload constructs new component state. The simulated lost POST response
  // has not cleared local storage, so the exact request identity is recovered.
  const afterReload=await loadOrCreateReceiptEmailIntent('company','sale','customer@example.test',options);
  assert.deepEqual(afterReload,first);assert.equal(ids.length,1);
  const stored=storage.getItem(receiptEmailIntentKey('company','sale'));
  assert.doesNotMatch(stored,/customer|example\.test/i,'local idempotency state must not persist the address');
  clearReceiptEmailIntent('company','sale',afterReload,{storage});
  const afterAcknowledgement=await loadOrCreateReceiptEmailIntent('company','sale','customer@example.test',options);
  assert.notEqual(afterAcknowledgement.id,first.id);
});

test('status reconciliation clears only the exact durable request, not an older delivery',async()=>{
  const storage=memoryStorage(),id='26fd6e24-a245-4cc0-b2b4-8c3affed322a';
  const options={storage,randomUUID:()=>id,subtle:globalThis.crypto.subtle};
  const pending=await loadOrCreateReceiptEmailIntent('company','sale','customer@example.test',options);
  const recovered=await loadReceiptEmailIntent('company','sale','customer@example.test',options);
  assert.deepEqual(recovered,pending);
  const olderRow={idempotencyKey:'b8af7c49-a2bc-4e2e-87a2-e71945bd4509'};
  if(olderRow.idempotencyKey===recovered.id)clearReceiptEmailIntent('company','sale',recovered,{storage});
  assert.deepEqual(await loadReceiptEmailIntent('company','sale','customer@example.test',options),pending);
  const matchingRow={idempotencyKey:pending.id};
  if(matchingRow.idempotencyKey===pending.id)clearReceiptEmailIntent('company','sale',pending,{storage});
  assert.equal(await loadReceiptEmailIntent('company','sale','customer@example.test',options),null);
});

test('a different recipient cannot inherit an ambiguous request identity',async()=>{
  const storage=memoryStorage(),ids=['26fd6e24-a245-4cc0-b2b4-8c3affed322a','b8af7c49-a2bc-4e2e-87a2-e71945bd4509'];
  const options={storage,randomUUID:()=>ids.shift(),subtle:globalThis.crypto.subtle};
  const first=await loadOrCreateReceiptEmailIntent('company','sale','first@example.test',options);
  const second=await loadOrCreateReceiptEmailIntent('company','sale','second@example.test',options);
  assert.notEqual(second.id,first.id);
});

test('pending receipt guidance takes precedence over disabled direct delivery',async()=>{
  const component=await readFile(new URL('../src/components/dashboard/pos/ReceiptEmailPanel.vue',import.meta.url),'utf8');
  const blocked=component.indexOf('<p v-if="blocked" class="ed-muted">Sync and approve this paid receipt before sending it from MyFin.</p>');
  const disabled=component.indexOf('<p v-else-if="!enabled&&!loading" class="ed-muted">Direct receipt delivery is not connected. The email draft and PDF options remain available.</p>');
  assert.ok(blocked>=0&&disabled>blocked,'blocked receipts must show sync guidance before SMTP availability');
});
