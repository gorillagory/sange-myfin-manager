import test from 'node:test';
import assert from 'node:assert/strict';
import { createSale, cartItem } from '../../src/domain/pos.js';
import {
  ReceiptRecoveryImportError,
  createReceiptRecoveryPlan,
  parseReceiptRecoveryArgs,
  receiptRecoveryScope,
} from '../src/receipt-recovery-import.js';

const sha = 'a'.repeat(64), serverNow = '2026-10-14T12:00:00.000Z';
const company = {id:'company-a',name:'Recovery shop',preferences:{currency:'RM',taxRate:0}};
function receipt(id,{offline=false,date='2026-10-13T08:00:00.000Z'}={}) {
  const sale=createSale({id,items:[cartItem({id:'product-a',name:'Item',price:10,stock:3})],company,
    user:{uid:'cashier-a',username:'Cashier'},method:'QR Pay',received:10,confirmed:true,offline});
  return {...sale,date,businessDate:date.slice(0,10),syncError:'internal_error',syncStatus:'pending',
    companySnapshot:{private:'presentation-only'}};
}
const plan = rows => createReceiptRecoveryPlan(rows,{sha256:sha,expectedCount:rows.length,
  expectedTotalCents:rows.length*1000,serverNow});

test('recovery arguments require exact immutable evidence and apply is explicit',()=>{
  assert.deepEqual(parseReceiptRecoveryArgs(['--input','/private/export.json','--expected-sha256',sha,
    '--expected-count','40','--expected-total','333.90']),{
    inputPath:'/private/export.json',expectedSha256:sha,expectedCount:40,expectedTotalCents:33390,apply:false,
  });
  assert.equal(parseReceiptRecoveryArgs(['--apply','--input','x','--expected-sha256',sha,
    '--expected-count','1','--expected-total','10.00']).apply,true);
  assert.throws(()=>parseReceiptRecoveryArgs(['--input','x','--expected-sha256',sha,'--expected-count','1']),
    error=>error instanceof ReceiptRecoveryImportError&&error.code==='receipt_recovery_usage');
});

test('recovery plan strips device-only fields, validates paid facts and assigns review reasons',()=>{
  const delayed=receipt('delayed-a'),offline=receipt('offline-a',{offline:true});
  const result=plan([delayed,offline]);
  assert.equal(result.count,2);assert.equal(result.totalCents,2000);
  assert.deepEqual(result.reasons,{receipt_review_required_delayed_sync:1,receipt_review_required_offline_sync:1});
  assert.equal(result.receipts[0].sale.syncError,undefined);
  assert.equal(result.receipts[0].sale.companySnapshot,undefined);
  const old=receipt('offline-old',{offline:true,date:'2026-10-10T08:00:00.000Z'});
  assert.deepEqual(plan([old]).reasons,{receipt_review_required_offline_time:1});
});

test('recovery plan fails closed on changed totals, duplicate IDs and mixed scope',()=>{
  const changed={...receipt('changed-a'),total:9};
  assert.throws(()=>plan([changed]),error=>error.code==='invalid_receipt_recovery_paid_intent');
  const duplicate=receipt('same-a');
  assert.throws(()=>createReceiptRecoveryPlan([duplicate,duplicate],{sha256:sha,expectedCount:2,
    expectedTotalCents:2000,serverNow}),error=>error.code==='duplicate_receipt_recovery_id');
  const other={...receipt('other-a'),company_id:'company-b'};
  assert.throws(()=>createReceiptRecoveryPlan([receipt('scope-a'),other],{sha256:sha,expectedCount:2,
    expectedTotalCents:2000,serverNow}),error=>error.code==='receipt_recovery_multiple_companies');
});

test('production application requires the runtime role and a second digest approval',()=>{
  const env={PGUSER:'myfin_prod_runtime',MYFIN_ALLOW_RECEIPT_RECOVERY_IMPORT:'myfin_prod',
    MYFIN_APPROVED_RECEIPT_RECOVERY_SHA256:sha};
  assert.deepEqual(receiptRecoveryScope(env,'myfin_prod',sha,true),{database:'myfin_prod',apply:true});
  assert.throws(()=>receiptRecoveryScope({...env,MYFIN_APPROVED_RECEIPT_RECOVERY_SHA256:'b'.repeat(64)},
    'myfin_prod',sha,true),error=>error.code==='receipt_recovery_digest_approval_required');
  assert.throws(()=>receiptRecoveryScope({...env,PGUSER:'myfin_prod_owner'},'myfin_prod',sha,false),
    error=>error.code==='receipt_recovery_scope_required');
});
