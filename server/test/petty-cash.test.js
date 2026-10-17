import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeExpenseLifecycle } from '../../src/domain/expenseLifecycle.js';
import {
  entryOutput,expensePaymentReversalTiming,fundOutput,pettyCashInternals,pettyCashOccurrence,recordExpensePayment,
  registerPettyCash,reverseExpensePayment,
} from '../src/petty-cash.js';

const manager={id:'manager-1',role:'manager'};

test('expense authoring canonicalizes unpaid states and requires a concrete petty-cash fund', () => {
  const base={date:'2026-10-17',paidByUserId:'',paidByName:'',creditTermsDays:null,
    creditDueDate:'',paidOn:'',links:[]};
  assert.deepEqual(normalizeExpenseLifecycle({...base,status:'pending',paidByType:'unassigned'}),{
    status:'pending_payment',paidByType:'unassigned',paidByUserId:'',paidByName:'',creditTermsDays:null,
    creditDueDate:'',paidOn:'',pettyCashFundId:'',links:[],
  });
  assert.throws(()=>normalizeExpenseLifecycle({...base,status:'paid',paidByType:'petty_cash',paidOn:'2026-10-17'}),
    /petty cash fund/i);
  assert.equal(normalizeExpenseLifecycle({...base,status:'paid',paidByType:'petty_cash',
    pettyCashFundId:'counter-1',paidOn:'2026-10-17'}).pettyCashFundId,'counter-1');
  assert.throws(()=>normalizeExpenseLifecycle({...base,status:'paid',paidByType:'credit',
    creditTermsDays:30,paidOn:'2026-10-17'}),/pending/);
});

test('fund and entry projections expose sen-exact balances and audit references', () => {
  assert.deepEqual(fundOutput({id:'fund-1',name:'Front counter',currency_code:'MYR',status:'open',
    is_default:true,balance_sen:'5050',opening_balance_sen:'10000',low_balance_threshold_sen:'6000',
    version:'4',created_by:'owner-1',created_by_name:'Owner'}),{
    id:'fund-1',name:'Front counter',currency:'MYR',status:'open',isDefault:true,
    openingBalanceSen:10000,openingBalance:100,balanceSen:5050,balance:50.5,
    lowBalanceThresholdSen:6000,lowBalanceThreshold:60,lowBalance:true,version:4,
    createdBy:'owner-1',createdByName:'Owner',openedAt:undefined,closedAt:undefined,
    closedBy:'',updatedAt:undefined,
  });
  const entry=entryOutput({id:'entry-1',fund_id:'fund-1',entry_type:'reconciliation',
    signed_amount_sen:'-250',amount_sen:'250',balance_after_sen:'5050',counted_balance_sen:'5050',
    reason:'Physical count',reference:'COUNT-1',occurred_at:'2026-10-17T04:00:00Z',
    created_at:'2026-10-17T04:01:00Z',actor_id:'manager-1',actor_name:'Manager'});
  assert.deepEqual({direction:entry.direction,signed:entry.signedAmountSen,balance:entry.balanceAfterSen,
    counted:entry.countedBalanceSen,reason:entry.reason},
  {direction:'out',signed:-250,balance:5050,counted:5050,reason:'Physical count'});
});

test('fund and ledger contracts normalize display currency and accept a Malaysia business date', () => {
  const fund=pettyCashInternals.fundCreateSchema.parse({name:'Front counter',currency:'RM',isDefault:true,
    openingBalance:100,lowBalanceThreshold:20,reason:'Opening counter float',idempotencyKey:'fund-create-001'});
  assert.equal(fund.currency,'MYR');
  const entry=pettyCashInternals.entrySchema.parse({type:'replenishment',amount:50,
    reason:'Weekly counter float',idempotencyKey:'fund-entry-001',occurredAt:'2026-10-17',reference:''});
  assert.equal(entry.occurredAt,'2026-10-17');
});

test('payment reversal uses one instant for its Malaysia business date and petty-cash evidence',()=>{
  const timing=expensePaymentReversalTiming(new Date('2026-10-17T16:30:00.000Z'));
  assert.deepEqual(timing,{occurredAt:'2026-10-17T16:30:00.000Z',occurredOn:'2026-10-18'});
});

test('date-only petty cash entries use the Malaysia business day without a false future-time rejection',()=>{
  const earlyMorning=new Date('2026-10-17T00:00:00.000Z');
  const timing=pettyCashOccurrence('2026-10-17',earlyMorning);
  assert.equal(timing.effectiveDay,'2026-10-17');
  assert.equal(timing.occurred.toISOString(),'2026-10-17T04:00:00.000Z');
  assert.throws(()=>pettyCashOccurrence('2026-10-18',earlyMorning),
    error=>error.statusCode===400&&error.message==='invalid_petty_cash_occurred_at');
});

test('same-day petty cash expense settlement succeeds before noon in Malaysia',async()=>{
  const now=new Date('2026-10-17T00:00:00.000Z'),entries=new Map();let fundBalance=2000,paymentInserted=false;
  const expense=()=>({id:'expense-1',company_id:'company-1',amount_sen:'1000',paid_amount_sen:paymentInserted?'1000':'0',
    status:paymentInserted?'paid':'pending_payment',paid_on:paymentInserted?'2026-10-17':null,
    credit_due_date:null,voided_at:null,version:paymentInserted?'2':'1',data:{date:'2026-10-17'}});
  const client={async query(sql,params=[]){
    if(sql.includes('FROM myfin.expenses')&&sql.includes('FOR UPDATE'))return {rowCount:1,rows:[expense()]};
    if(sql.includes('FROM myfin.expense_payment_events')&&sql.includes('idempotency_key=$2'))return {rowCount:0,rows:[]};
    if(sql.includes('INSERT INTO myfin.expense_payment_events')){paymentInserted=true;return {rowCount:1,rows:[]};}
    if(sql.includes('SELECT f.*'))return {rowCount:1,rows:[{id:'fund-1',name:'Counter',currency_code:'MYR',status:'open',
      is_default:true,balance_sen:String(fundBalance),opening_balance_sen:'2000',low_balance_threshold_sen:'0',
      version:'1',created_by:'manager-1',opened_at:'2026-10-16T18:00:00.000Z'}]};
    if(sql.includes('WHERE company_id=$1 AND fund_id=$2 AND idempotency_key=$3'))return {rowCount:0,rows:[]};
    if(sql.includes('INSERT INTO myfin.petty_cash_entries')){
      const row={id:params[1],fund_id:params[2],entry_type:params[3],signed_amount_sen:String(params[4]),
        amount_sen:String(params[5]),balance_after_sen:String(params[6]),counted_balance_sen:params[7],
        expense_id:params[8],expense_payment_event_id:params[9],reverses_entry_id:params[10],reference:params[11],
        reason:params[12],actor_id:params[15],occurred_at:params[16],created_at:now};
      entries.set(row.id,row);fundBalance+=Number(params[4]);return {rowCount:1,rows:[]};
    }
    if(sql.includes('UPDATE myfin.petty_cash_funds SET version=version+1'))return {rowCount:1,rows:[]};
    if(sql.includes('FROM myfin.petty_cash_entries e LEFT JOIN')&&sql.includes('WHERE e.company_id=$1 AND e.id=$2'))
      return {rowCount:1,rows:[entries.get(params[1])]};
    if(sql.includes('SELECT * FROM myfin.expenses WHERE company_id=$1 AND id=$2'))return {rowCount:1,rows:[expense()]};
    if(sql.includes('INSERT INTO myfin.expense_events'))return {rowCount:1,rows:[]};
    if(sql.includes('FROM myfin.expense_payment_events p'))return {rowCount:1,rows:[{id:'payment-1',
      expense_id:'expense-1',event_type:'payment',amount_sen:'1000',source_type:'petty_cash',
      petty_cash_fund_id:'fund-1',reason:'Counter supplies',occurred_on:'2026-10-17',created_at:now}]};
    assert.fail(`unexpected query: ${sql}`);
  }};
  const result=await recordExpensePayment(client,manager,'company-1','expense-1',{
    amount:10,sourceType:'petty_cash',pettyCashFundId:'fund-1',paidByUserId:'',paidByName:'',
    paidOn:'2026-10-17',reference:'PV-1',reason:'Counter supplies',idempotencyKey:'same-day-pay-001',expectedVersion:1,
  },async()=>{},{now});
  assert.equal(result.expense.status,'paid');assert.equal(fundBalance,1000);
  assert.equal([...entries.values()][0].occurred_at.toISOString(),'2026-10-17T04:00:00.000Z');
});

test('a petty-cash payment reversal atomically reopens a closed zero-balance fund for correction',async()=>{
  let fundStatus='closed',fundBalance=0,reversed=false;const entries=new Map(),audits=[];
  entries.set('ledger-1',{id:'ledger-1',company_id:'company-1',fund_id:'fund-1',entry_type:'expense_disbursement',
    signed_amount_sen:'-1000',amount_sen:'1000',balance_after_sen:'0',counted_balance_sen:null,
    expense_id:'expense-1',expense_payment_event_id:'payment-1',reverses_entry_id:null,reference:'PV-1',
    reason:'Counter payment',actor_id:'manager-1',occurred_at:'2026-10-17T04:00:00Z',created_at:'2026-10-17T04:00:00Z'});
  const expense=()=>({id:'expense-1',company_id:'company-1',amount_sen:'1000',paid_amount_sen:reversed?'0':'1000',
    status:reversed?'pending_payment':'paid',paid_on:reversed?null:'2026-10-17',credit_due_date:null,
    voided_at:null,version:reversed?'3':'2',data:{date:'2026-10-17'}});
  const fund=()=>({id:'fund-1',name:'Closed till',currency_code:'MYR',status:fundStatus,is_default:false,
    balance_sen:String(fundBalance),opening_balance_sen:'1000',low_balance_threshold_sen:'0',version:'3',
    created_by:'manager-1',created_by_name:'Manager'});
  const client={async query(sql,params=[]){
    if(sql.includes('FROM myfin.expenses')&&sql.includes('FOR UPDATE'))return {rowCount:1,rows:[expense()]};
    if(sql.includes('FROM myfin.expense_payment_events')&&sql.includes('idempotency_key=$2'))return {rowCount:0,rows:[]};
    if(sql.includes('FROM myfin.expense_payment_events')&&sql.includes('expense_id=$2 AND id=$3 FOR UPDATE'))return {rowCount:1,rows:[{
      id:'payment-1',expense_id:'expense-1',event_type:'payment',amount_sen:'1000',source_type:'petty_cash',
      paid_by_identity_id:null,paid_by_name:'',petty_cash_fund_id:'fund-1',reference:'PV-1',
    }]};
    if(sql.includes('SELECT 1 FROM myfin.expense_payment_events')&&sql.includes('reverses_event_id=$2'))return {rowCount:0,rows:[]};
    if(sql.includes('INSERT INTO myfin.expense_payment_events')){reversed=true;return {rowCount:1,rows:[]};}
    if(sql.includes('SELECT id FROM myfin.petty_cash_entries')&&sql.includes('expense_payment_event_id=$2'))return {rowCount:1,rows:[{id:'ledger-1'}]};
    if(sql.includes('SELECT f.*'))return {rowCount:1,rows:[fund()]};
    if(sql.includes("UPDATE myfin.petty_cash_funds SET status='open'")){fundStatus='open';return {rowCount:1,rows:[]};}
    if(sql.includes('WHERE company_id=$1 AND fund_id=$2 AND idempotency_key=$3'))return {rowCount:0,rows:[]};
    if(sql.includes('SELECT * FROM myfin.petty_cash_entries')&&sql.includes('id=$3 FOR UPDATE'))return {rowCount:1,rows:[entries.get(params[2])]};
    if(sql.includes('SELECT id FROM myfin.petty_cash_entries')&&sql.includes('reverses_entry_id=$2'))return {rowCount:0,rows:[]};
    if(sql.includes('INSERT INTO myfin.petty_cash_entries')){
      const row={id:params[1],company_id:params[0],fund_id:params[2],entry_type:params[3],
        signed_amount_sen:String(params[4]),amount_sen:String(params[5]),balance_after_sen:String(params[6]),
        counted_balance_sen:params[7],expense_id:params[8],expense_payment_event_id:params[9],
        reverses_entry_id:params[10],reference:params[11],reason:params[12],actor_id:params[15],
        occurred_at:params[16],created_at:params[16]};
      entries.set(row.id,row);fundBalance+=Number(params[4]);return {rowCount:1,rows:[]};
    }
    if(sql.includes('UPDATE myfin.petty_cash_funds SET version=version+1'))return {rowCount:1,rows:[]};
    if(sql.includes('FROM myfin.petty_cash_entries e LEFT JOIN')&&sql.includes('WHERE e.company_id=$1 AND e.id=$2'))return {rowCount:1,rows:[entries.get(params[1])]};
    if(sql.includes('SELECT * FROM myfin.expenses WHERE company_id=$1 AND id=$2'))return {rowCount:1,rows:[expense()]};
    if(sql.includes('INSERT INTO myfin.expense_events'))return {rowCount:1,rows:[]};
    if(sql.includes('FROM myfin.expense_payment_events p'))return {rowCount:1,rows:[{id:'reversal-1',expense_id:'expense-1',
      event_type:'reversal',amount_sen:'1000',source_type:'petty_cash',petty_cash_fund_id:'fund-1',
      reference:'PV-1',reason:'Wrong payment',reverses_event_id:'payment-1',occurred_on:'2026-10-18'}]};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const result=await reverseExpensePayment(client,manager,'company-1','expense-1','payment-1',{
    reason:'Wrong payment',idempotencyKey:'reverse-payment-001',expectedVersion:2,
  },async(...args)=>audits.push(args));
  assert.equal(result.expense.status,'pending_payment');
  assert.equal(fundStatus,'open');assert.equal(fundBalance,1000);
  assert.deepEqual([...entries.values()].slice(1).map(row=>row.entry_type),['reopen','reversal']);
  assert.equal(audits.some(call=>call[3]==='Reopen petty cash fund'),true);
});

test('ledger mutation rejects a debit that would make a fund negative before inserting evidence', async () => {
  const calls=[];
  const client={async query(sql,params){
    calls.push({sql,params});
    if(sql.includes('SELECT f.*'))return {rows:[{id:'fund-1',name:'Counter',currency_code:'MYR',status:'open',
      is_default:true,balance_sen:'1000',opening_balance_sen:'1000',low_balance_threshold_sen:'0',version:'1',created_by:'manager-1'}]};
    if(sql.includes('WHERE company_id=$1 AND fund_id=$2 AND idempotency_key=$3'))return {rows:[]};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  await assert.rejects(pettyCashInternals.insertEntry(client,manager,'company-1','fund-1',{
    type:'adjustment_out',amount:10.01,reason:'Correct till variance',idempotencyKey:'adjust-out-001',reference:'',
  }),error=>error.statusCode===409&&error.message==='petty_cash_insufficient_balance');
  assert.equal(calls.some(call=>call.sql.includes('INSERT INTO myfin.petty_cash_entries')),false);
});

test('ledger mutation rejects an effective date before the fund opened', async () => {
  const calls=[];
  const client={async query(sql,params){
    calls.push({sql,params});
    if(sql.includes('SELECT f.*'))return {rowCount:1,rows:[{id:'fund-1',name:'Counter',currency_code:'MYR',status:'open',
      is_default:true,balance_sen:'1000',opening_balance_sen:'1000',low_balance_threshold_sen:'0',version:'1',
      created_by:'manager-1',opened_at:'2026-10-17T01:00:00.000Z'}]};
    if(sql.includes('WHERE company_id=$1 AND fund_id=$2 AND idempotency_key=$3'))return {rowCount:0,rows:[]};
    assert.fail(`unexpected query: ${sql}`);
  }};
  await assert.rejects(pettyCashInternals.insertEntry(client,manager,'company-1','fund-1',{
    type:'replenishment',amount:10,reason:'Backdated before opening',idempotencyKey:'replenish-old-001',
    reference:'',occurredAt:'2026-10-16',
  }),error=>error.statusCode===409&&error.message==='petty_cash_entry_before_fund_opened');
  assert.equal(calls.some(call=>call.sql.includes('INSERT INTO myfin.petty_cash_entries')),false);
});

test('petty-cash expense spending keeps the manager-owner capability boundary even for atomic creation', async () => {
  let queried=false;
  await assert.rejects(recordExpensePayment({query(){queried=true;throw new Error('must not query');}},
    {id:'operator-1',role:'operator'},'company-1','expense-1',{
      amount:5,sourceType:'petty_cash',pettyCashFundId:'fund-1',paidByUserId:'',paidByName:'',
      paidOn:'2026-10-17',reference:'',reason:'Paid from counter fund',idempotencyKey:'expense-pay-001',expectedVersion:1,
    },async()=>{},{requireWrite:false}),error=>error.statusCode===403&&error.message==='access_denied');
  assert.equal(queried,false);
});

test('an operator cannot read another operator expense payment history by guessing its id', async () => {
  const routes=new Map(),app={
    get(path,handler){routes.set(`GET ${path}`,handler);},
    post(path,handler){routes.set(`POST ${path}`,handler);},
    patch(path,handler){routes.set(`PATCH ${path}`,handler);},
  };
  registerPettyCash(app,{scoped:(req,fn)=>fn({async query(sql){
    assert.match(sql,/FROM myfin\.expenses/);
    return {rowCount:1,rows:[{id:'expense-1',company_id:'company-1',created_by:'operator-2'}]};
  }},'company-1'),audit:async()=>{}});
  await assert.rejects(routes.get('GET /api/companies/:company/expenses/:id/payments')({
    identity:{id:'operator-1',role:'operator'},params:{id:'expense-1'},query:{},
  }),error=>error.statusCode===404&&error.message==='not_found');
});

test('migration creates tenant-bound immutable ledgers, idempotency and deferred payment-state integrity', async () => {
  const sql=await readFile(new URL('../../db/migrations/0043_petty_cash.sql',import.meta.url),'utf8');
  for(const table of ['petty_cash_funds','petty_cash_entries','expense_payment_events'])
    assert.match(sql,new RegExp(`CREATE TABLE myfin\\.${table}`));
  assert.match(sql,/UNIQUE\(company_id,idempotency_key\)/);
  assert.match(sql,/UNIQUE\(company_id,fund_id,idempotency_key\)/);
  assert.match(sql,/petty_cash_entry_immutable/);
  assert.match(sql,/expense_payment_event_immutable/);
  assert.match(sql,/sync_expense_payment_state_after_insert/);
  assert.match(sql,/expense_payment_state_consistent[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql,/petty_cash_insufficient_balance|balance_after_sen bigint NOT NULL CHECK\(balance_after_sen/);
  assert.match(sql,/entry_type='expense_disbursement'.*expense_payment_event_id IS NOT NULL/s);
  assert.match(sql,/'reconciliation','reversal','reopen','close'/);
  assert.match(sql,/petty_cash_entry_before_fund_opened/);
  assert.doesNotMatch(sql,/ON DELETE CASCADE/);
});

test('business and import paths record paid expenses through immutable payment events', async () => {
  const [business,expenseImport]=await Promise.all([
    readFile(new URL('../src/business.js',import.meta.url),'utf8'),
    readFile(new URL('../src/expense-import.js',import.meta.url),'utf8'),
  ]);
  assert.match(business,/recordExpensePayment\(c,req\.identity,co,id/);
  assert.match(business,/expense_payments_must_be_reversed/);
  assert.match(expenseImport,/recordExpensePayment\(c,req\.identity,companyId,id/);
});
