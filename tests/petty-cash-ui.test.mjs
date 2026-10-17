import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import {
  createPettyCashFund, listExpensePayments, listPettyCashEntries, listPettyCashFunds,
  postExpensePayment, postPettyCashEntry, reverseExpensePayment, updatePettyCashFund,
} from '../src/services/pettyCash.js';

const store={state:{selectedCompany:{id:'company-1'}}};

test('petty cash client uses company-scoped immutable ledger and payment routes',async()=>{
  const original=global.fetch,calls=[];
  global.fetch=async(url,options={})=>{calls.push({url,options});return {ok:true,json:async()=>({rows:[]})};};
  try{
    await listPettyCashFunds(store);
    await createPettyCashFund(store,{name:'Counter',openingBalance:100,lowBalanceThreshold:20,reason:'Open fund',isDefault:true,idempotencyKey:'fund-key-1'});
    await updatePettyCashFund(store,'fund-1',{version:1,lowBalanceThreshold:25});
    await listPettyCashEntries(store,'fund-1',{after:'entry-1',limit:50});
    await postPettyCashEntry(store,'fund-1',{type:'reconciliation',countedBalance:90,reason:'End shift count',idempotencyKey:'count-key-1'});
    await listExpensePayments(store,'expense-1');
    await postExpensePayment(store,'expense-1',{amount:10,sourceType:'petty_cash',pettyCashFundId:'fund-1',paidOn:'2026-10-17',reason:'Settlement',idempotencyKey:'payment-key-1',expectedVersion:1});
    await reverseExpensePayment(store,'expense-1','payment-1',{reason:'Entry error',idempotencyKey:'reverse-key-1',expectedVersion:2});
  }finally{global.fetch=original;}
  assert.deepEqual(calls.map(call=>[call.options.method||'GET',call.url]),[
    ['GET','/api/companies/company-1/petty-cash/funds'],
    ['POST','/api/companies/company-1/petty-cash/funds'],
    ['PATCH','/api/companies/company-1/petty-cash/funds/fund-1'],
    ['GET','/api/companies/company-1/petty-cash/funds/fund-1/entries?limit=50&after=entry-1'],
    ['POST','/api/companies/company-1/petty-cash/funds/fund-1/entries'],
    ['GET','/api/companies/company-1/expenses/expense-1/payments'],
    ['POST','/api/companies/company-1/expenses/expense-1/payments'],
    ['POST','/api/companies/company-1/expenses/expense-1/payments/payment-1/reverse'],
  ]);
  assert.equal(JSON.parse(calls[4].options.body).type,'reconciliation');
  assert.equal(JSON.parse(calls[6].options.body).pettyCashFundId,'fund-1');
});

test('expense and petty cash components compile with reconciliation and settlement controls',async()=>{
  for(const relative of ['../src/components/dashboard/EditionExpenses.vue','../src/components/dashboard/expenses/PettyCashPanel.vue']){
    const filename=new URL(relative,import.meta.url),source=await readFile(filename,'utf8'),parsed=parse(source,{filename:filename.pathname});
    assert.equal(parsed.errors.length,0);compileScript(parsed.descriptor,{id:relative});
    const template=compileTemplate({source:parsed.descriptor.template.content,filename:filename.pathname,id:relative,compilerOptions:{bindingMetadata:{}}});
    assert.deepEqual(template.errors,[]);
  }
  const expense=await readFile(new URL('../src/components/dashboard/EditionExpenses.vue',import.meta.url),'utf8');
  const petty=await readFile(new URL('../src/components/dashboard/expenses/PettyCashPanel.vue',import.meta.url),'utf8');
  assert.match(expense,/Finance PDF/);assert.match(expense,/Pay \/ settle/);assert.match(expense,/pettyCashFundId/);
  assert.match(expense,/canViewPayments=.*paidAmountSen/);
  assert.match(expense,/v-if="canViewPayments\(expense\)"/);
  assert.match(expense,/fully settled[\s\S]*immutable payment history[\s\S]*Reverse/);
  assert.match(petty,/Count & reconcile/);assert.match(petty,/Replenish/);assert.match(petty,/Low-balance alert/);assert.match(petty,/Reverse/);
  assert.match(petty,/reopen:'Reopened for correction'/);
});
