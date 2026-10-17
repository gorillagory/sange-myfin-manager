import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expenseCreateRequestDigest,inspectExpenseCreate } from '../src/expense-create.js';
import * as v from '../src/validation.js';

const companyId='company-1',actorId='manager-1';
const expense={
  id:'129b13ee-0e91-4f0e-bef5-57ac1aa65fa4',company_id:companyId,
  amount:12.5,date:'2026-10-17',description:'Counter supplies',status:'paid',
  paidByType:'petty_cash',paidByUserId:'',paidByName:'',pettyCashFundId:'fund-1',
  creditDueDate:'',paidOn:'2026-10-17',links:[],
};

test('expense create digest is canonical, actor-bound and payload-sensitive',()=>{
  const digest=expenseCreateRequestDigest(companyId,actorId,expense);
  assert.match(digest,/^[0-9a-f]{64}$/);
  assert.equal(digest,expenseCreateRequestDigest(companyId,actorId,
    Object.fromEntries(Object.entries(expense).reverse())));
  assert.notEqual(digest,expenseCreateRequestDigest(companyId,actorId,{...expense,amount:12.51}));
  assert.notEqual(digest,expenseCreateRequestDigest(companyId,'manager-2',expense));
});

test('expense create inspection serializes retries and replays only the exact actor payload',async()=>{
  const requestDigest=expenseCreateRequestDigest(companyId,actorId,expense),calls=[];
  const exact={...expense,created_by:actorId,create_request_digest:requestDigest};
  const client={async query(sql,params){calls.push({sql,params});
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[{}]};
    if(sql.includes('FROM myfin.expenses'))return {rows:[exact]};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const result=await inspectExpenseCreate(client,companyId,actorId,expense);
  assert.equal(result.existing,exact);assert.equal(result.requestDigest,requestDigest);
  assert.match(calls[0].sql,/pg_advisory_xact_lock/);
  assert.deepEqual(calls[1].params,[companyId,expense.id]);

  await assert.rejects(inspectExpenseCreate(client,companyId,actorId,{...expense,amount:20}),
    error=>error.statusCode===409&&error.message==='expense_create_payload_changed');
  await assert.rejects(inspectExpenseCreate(client,companyId,'manager-2',expense),
    error=>error.statusCode===409&&error.message==='expense_create_payload_changed');
});

test('expense API requires a client request id and migration preserves its digest immutably',async()=>{
  const parsed=v.parse(v.expenseCreate,expense);
  assert.equal(parsed.id,expense.id);
  assert.throws(()=>v.parse(v.expenseCreate,Object.fromEntries(
    Object.entries(expense).filter(([key])=>key!=='id'))));
  const sql=await readFile(new URL('../../db/migrations/0043_petty_cash.sql',import.meta.url),'utf8');
  assert.match(sql,/ADD COLUMN create_request_digest text/);
  assert.match(sql,/create_request_digest ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql,/protect_expense_create_identity/);
  assert.match(sql,/REVOKE ALL ON FUNCTION myfin\.protect_expense_create_identity\(\) FROM PUBLIC/);
  assert.match(sql,/NEW\.created_by IS DISTINCT FROM OLD\.created_by[\s\S]*NEW\.create_request_digest IS DISTINCT FROM OLD\.create_request_digest/);
});

test('paid expense creation stores the request digest and derives one stable initial payment key',async()=>{
  const source=await readFile(new URL('../src/business.js',import.meta.url),'utf8');
  assert.match(source,/inspectExpenseCreate\(c,co,req\.identity\.id,data\)/);
  assert.match(source,/return \{\.\.\.replay,idempotentReplay:true\}/);
  assert.match(source,/paid_on,\s*create_request_digest\)/);
  assert.match(source,/initial-\$\{createHash\('sha256'\)\.update\(`\$\{co\}\\u0000\$\{id\}`\)/);
});
