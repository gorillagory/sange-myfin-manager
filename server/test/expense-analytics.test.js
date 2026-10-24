import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { expenseInsightsRange,registerExpenseAnalytics } from '../src/expense-analytics.js';
import { permissionsFor } from '../../src/domain/permissions.js';

function fixture(role='manager',query=async()=>({rows:[],rowCount:0})) {
  const routes=new Map(),calls=[],scopes=[],client={async query(sql,params=[]){calls.push({sql,params});return query(sql,params);}};
  const app={get(path,handler){routes.set(path,handler);}};
  registerExpenseAnalytics(app,{scoped:(req,fn,admin,options)=>{scopes.push({admin,options});return fn(client,req.params.company);}});
  return {routes,calls,scopes,request:{params:{company:'company-a'},query:{from:'2026-10-01',to:'2026-10-31',grain:'month'},
    identity:{id:'actor-a',role}}};
}

test('expense insight ranges are strict calendar ranges bounded to a ten-year comparison window',()=>{
  assert.deepEqual(expenseInsightsRange({from:'2026-01-01',to:'2026-12-31',grain:'quarter'}),
    {from:'2026-01-01',to:'2026-12-31',toExclusive:'2027-01-01',grain:'quarter'});
  assert.deepEqual(expenseInsightsRange({from:'2016-01-01',to:'2026-01-01',grain:'year'}),
    {from:'2016-01-01',to:'2026-01-01',toExclusive:'2026-01-02',grain:'year'});
  assert.throws(()=>expenseInsightsRange({from:'2026-02-30',to:'2026-03-01'}),
    error=>error.statusCode===400&&error.message==='invalid_expense_insights_range');
  assert.throws(()=>expenseInsightsRange({from:'2015-12-31',to:'2026-01-01'}),
    error=>error.statusCode===400&&error.message==='invalid_expense_insights_range');
});

test('manager insights reconcile accrual, cash, ageing, claimant and petty-cash evidence in exact sen',async()=>{
  const fx=fixture('manager',async sql=>{
    if(sql.includes('FROM myfin.expenses e LEFT JOIN myfin.app_identities'))return {rows:[
      {id:'claim-a',company_id:'company-a',data:{date:'2026-10-01',description:'Supplies',category:'Operations',receiptPath:'receipt-a'},
        amount_sen:'1000',paid_as_of_sen:'400',credit_due_date:'2026-10-10',created_by:'staff-a',created_by_name:'Staff A',
        expense_date:'2026-10-01',imported_unattributed:false,create_request_digest:'a'.repeat(64)},
      {id:'claim-b',company_id:'company-a',data:{date:'2026-10-02',description:'Legacy rent',category:'Rent'},
        amount_sen:'500',paid_as_of_sen:'500',credit_due_date:null,created_by:'import-actor',created_by_name:'Import actor',
        expense_date:'2026-10-02',imported_unattributed:true,create_request_digest:null},
    ],rowCount:2};
    if(sql.includes('FROM myfin.transactions t'))return {rows:[],rowCount:0};
    if(sql.includes('GROUP BY p.occurred_on,p.source_type'))return {rows:[
      {occurred_on:'2026-10-05',source_type:'petty_cash',payment_count:1,net_sen:'400'},
      {occurred_on:'2026-10-06',source_type:'bank',payment_count:1,net_sen:'500'},
    ],rowCount:2};
    if(sql.includes('GROUP BY p.expense_id,p.source_type'))return {rows:[
      {expense_id:'claim-a',source_type:'petty_cash',net_sen:'400'},
      {expense_id:'claim-b',source_type:'bank',net_sen:'500'},
    ],rowCount:2};
    if(sql.includes(') visible_link WHERE position<=10'))return {rows:[],rowCount:0};
    if(sql.includes('FROM myfin.petty_cash_funds')){assert.match(sql,/e\.occurred_at[\s\S]*<=\$3::date/);
      assert.match(sql,/f\.opened_at[\s\S]*<=\$3::date/);return {rows:[{id:'fund-a',name:'Till',status:'open',currency_code:'MYR',
        balance_sen:'10000',opening_balance_sen:'8000',replenishment_sen:'4000',disbursement_sen:'2000',
        adjustment_sen:'0',count_sen:'0',reversal_sen:'0'}],rowCount:1};}
    throw Error(`Unexpected SQL: ${sql}`);
  });
  const result=await fx.routes.get('/api/companies/:company/expense-insights')(fx.request);
  assert.deepEqual(result.summary,{claimCount:2,draftCount:0,draftSen:0,totalSen:1500,paidSen:900,outstandingSen:600,cashOutSen:900,
    overdueCount:1,overdueSen:600,evidenceCount:1,pettyCashSen:400});
  assert.equal(result.periods[0].cashOutSen,900);
  assert.deepEqual(result.ageing.find(row=>row.key==='15_30'),{key:'15_30',label:'15–30 days',claimCount:1,outstandingSen:600});
  assert.equal(result.claimants.find(row=>row.attribution==='imported_unattributed').name,'Imported / unattributed');
  assert.equal(result.oldestOutstanding[0].expenseId,'claim-a');
  assert.deepEqual(result.claims.map(row=>({id:row.id,status:row.status,paymentSources:row.paymentSources})),[
    {id:'claim-a',status:'overdue',paymentSources:[{type:'petty_cash',label:'Petty cash',amountSen:400}]},
    {id:'claim-b',status:'paid',paymentSources:[{type:'bank',label:'Bank',amountSen:500}]},
  ]);
  assert.equal(result.pettyCash.restricted,false);
  assert.equal(result.pettyCash.funds[0].balanceSen,10000);
  assert.deepEqual(fx.scopes,[{admin:false,options:{isolation:'repeatable_read'}}]);
});

test('staff reports are forcibly claimant-scoped and never expose fund-wide petty cash',async()=>{
  const fx=fixture('operator',async sql=>{
    if(sql.includes('FROM myfin.expenses e LEFT JOIN myfin.app_identities'))return {rows:[],rowCount:0};
    if(sql.includes('GROUP BY p.occurred_on,p.source_type'))return {rows:[],rowCount:0};
    throw Error(`Unexpected SQL: ${sql}`);
  });
  const result=await fx.routes.get('/api/companies/:company/expense-insights')(fx.request);
  assert.deepEqual(result.scope,{mode:'self',companyId:'company-a',claimantFilterAllowed:false});
  assert.deepEqual(result.pettyCash,{restricted:true,claimDisbursementSen:0});
  assert.equal(fx.calls.length,2);
  for(const call of fx.calls){assert.match(call.sql,/e\.created_by=\$4/);assert.equal(call.params[3],'actor-a');}
  fx.request.query.claimantId='other-actor';
  await assert.rejects(()=>fx.routes.get('/api/companies/:company/expense-insights')(fx.request),
    error=>error.statusCode===403&&error.message==='expense_claimant_scope_denied');
});

test('the individual claim report keeps staff ownership checks and immutable payment/event evidence',async()=>{
  const fx=fixture('operator',async(sql,params)=>{
    if(sql.startsWith('SELECT e.* FROM myfin.expenses'))return {rows:[{id:'claim-a',company_id:'company-a',created_by:'actor-a',
      amount:10,amount_sen:'1000',paid_amount_sen:'400',status:'partially_paid',create_request_digest:'a'.repeat(64),
      data:{date:'2026-10-01',description:'Supplies',category:'Operations'}}],rowCount:1};
    if(sql.includes('FROM myfin.expense_links'))return {rows:[],rowCount:0};
    if(sql.includes('FROM myfin.app_identities WHERE'))return {rows:[{id:'actor-a',display_name:'Staff A'}],rowCount:1};
    if(sql.includes('GROUP BY p.expense_id'))return {rows:[{expense_id:'claim-a',source_type:'petty_cash',petty_cash_fund_id:'fund-a',
      petty_cash_fund_name:'Till',amount_sen:'400'}],rowCount:1};
    if(sql.includes('SELECT p.*,actor.display_name'))return {rows:[{id:'pay-a',event_type:'payment',amount_sen:'400',source_type:'app_user',
      paid_by_identity_id:'payer-a',paid_by_display_name:'Paying Manager',actor_id:'actor-a',actor_name:'Staff A',
      reason:'Paid by manager',occurred_on:'2026-10-05'}],rowCount:1};
    if(sql.includes('FROM myfin.expense_events ev'))return {rows:[{id:'event-a',expense_version:'1',action:'created',from_lifecycle:{},
      to_lifecycle:{status:'pending_payment'},reason:'',actor_id:'actor-a',actor_name:'Staff A',created_at:'2026-10-01T00:00:00Z'}],rowCount:1};
    if(sql.includes('FROM myfin.companies c JOIN myfin.workspaces'))return {rows:[{company_id:'company-a',company_name:'Cafe',company_data:{},workspace_id:'workspace-a',workspace_name:'Workspace'}],rowCount:1};
    throw Error(`Unexpected SQL (${params.join(',')}): ${sql}`);
  });
  fx.request.params.id='claim-a';
  const result=await fx.routes.get('/api/companies/:company/expenses/:id/claim-report')(fx.request);
  assert.equal(result.expense.claimantName,'Staff A');
  assert.equal(result.payments[0].signedAmountSen,400);
  assert.equal(result.payments[0].paidByName,'Paying Manager');
  assert.equal(result.payments[0].actorName,'Staff A');
  assert.equal(result.events[0].action,'created');
  assert.equal(result.scope.mode,'self');
  assert.match(fx.calls[0].sql,/e\.created_by=\$3/);
});

test('expense report permission and reporting indexes cover staff claims and occurrence scans',async()=>{
  assert.equal(permissionsFor({role:'operator'}).expenseReportsRead,true);
  assert.equal(permissionsFor({role:'operator',module_grants:[]}).expenseReportsRead,false);
  const sql=await readFile(new URL('../../db/migrations/0053_expense_reporting_indexes.sql',import.meta.url),'utf8');
  assert.match(sql,/expenses\(company_id,created_by,myfin\.valid_expense_date/);
  assert.match(sql,/expenses\(company_id,myfin\.valid_expense_date/);
  assert.match(sql,/transactions\(company_id,\(left\(data->>'date',10\)\),id\)/);
  assert.match(sql,/transactions\(company_id,[\s\S]*coalesce\(myfin\.valid_expense_date\(left\(data->>'paidOn',10\)\)/);
  assert.match(sql,/expense_payment_events\(company_id,occurred_on,id\)/);
  assert.match(sql,/petty_cash_entries\(company_id,occurred_at,id\)/);
});

test('drafts stay outside payable totals, ageing and evidence while remaining separate in bounded claim detail',async()=>{
  const fx=fixture('manager',async sql=>{
    if(sql.includes('FROM myfin.expenses e LEFT JOIN myfin.app_identities'))return {rows:[
      {id:'draft-a',data:{date:'2026-10-02',description:'Unsubmitted',category:'Drafts',attachmentUrl:'private-ref'},
        amount_sen:'300',paid_as_of_sen:'0',status:'draft',expense_date:'2026-10-02',created_by:'staff-a',created_by_name:'Staff A'},
      {id:'claim-a',data:{date:'2026-10-03',description:'Due',category:'Operations'},amount_sen:'1000',
        paid_as_of_sen:'0',status:'pending_payment',credit_due_date:'2026-10-10',expense_date:'2026-10-03',
        created_by:'staff-a',created_by_name:'Staff A'},
    ]};
    if(sql.includes('FROM myfin.transactions t'))return {rows:[]};
    if(sql.includes('GROUP BY p.expense_id,p.source_type')||sql.includes(') visible_link WHERE position<=10'))return {rows:[]};
    if(sql.includes('GROUP BY p.occurred_on,p.source_type')||sql.includes('FROM myfin.petty_cash_funds'))return {rows:[]};
    throw Error(`Unexpected SQL: ${sql}`);
  });
  const result=await fx.routes.get('/api/companies/:company/expense-insights')(fx.request);
  assert.deepEqual(result.summary,{claimCount:1,draftCount:1,draftSen:300,totalSen:1000,paidSen:0,
    outstandingSen:1000,cashOutSen:0,overdueCount:1,overdueSen:1000,evidenceCount:0,pettyCashSen:0});
  assert.equal(result.periods[0].claimCount,1);assert.equal(result.periods[0].draftCount,1);
  assert.deepEqual(result.claims.map(row=>[row.id,row.status,row.paidSen,row.outstandingSen]),[
    ['draft-a','draft',0,0],['claim-a','overdue',0,1000],
  ]);
  assert.deepEqual(result.oldestOutstanding.map(row=>row.expenseId),['claim-a']);
  assert.deepEqual(result.categories.find(row=>row.key==='Drafts'),{key:'Drafts',label:'Drafts',claimCount:0,
    draftCount:1,draftSen:300,totalSen:0,paidSen:0,outstandingSen:0});
});

test('historical cash survives a later void and report-end filters use net payments with real due dates',async()=>{
  const fx=fixture('manager',async sql=>{
    if(sql.includes('FROM myfin.expenses e LEFT JOIN myfin.app_identities')){
      assert.match(sql,/voided_at IS NULL[\s\S]*voided_at AT TIME ZONE[\s\S]*>\$3::date/);
      assert.match(sql,/source_event\.occurred_on<=\$3::date/);assert.match(sql,/HAVING sum\([\s\S]*\)>0/);
      assert.doesNotMatch(sql,/coalesce\(e\.credit_due_date/);
      return {rows:[{id:'claim-a',data:{date:'2026-10-01',category:'Operations'},amount_sen:'1000',
        paid_as_of_sen:'400',status:'partially_paid',credit_due_date:'2026-10-10',expense_date:'2026-10-01',
        created_by:'staff-a',created_by_name:'Staff A',voided_at:'2026-11-01T01:00:00Z'}]};
    }
    if(sql.includes('FROM myfin.transactions t'))return {rows:[]};
    if(sql.includes('GROUP BY p.expense_id,p.source_type'))return {rows:[{expense_id:'claim-a',source_type:'bank',net_sen:'400'}]};
    if(sql.includes(') visible_link WHERE position<=10'))return {rows:[]};
    if(sql.includes('GROUP BY p.occurred_on,p.source_type')){
      assert.doesNotMatch(sql,/voided_at IS NULL/);
      return {rows:[{occurred_on:'2026-10-05',source_type:'bank',payment_count:1,net_sen:'400'}]};
    }
    if(sql.includes('FROM myfin.petty_cash_funds'))return {rows:[]};
    throw Error(`Unexpected SQL: ${sql}`);
  });
  fx.request.query.status='overdue';fx.request.query.paymentSource='bank';
  const result=await fx.routes.get('/api/companies/:company/expense-insights')(fx.request);
  assert.equal(result.summary.totalSen,1000);assert.equal(result.summary.outstandingSen,600);
  assert.equal(result.summary.cashOutSen,400);assert.equal(result.summary.overdueCount,1);
  assert.equal(result.claims[0].claimReportAvailable,false,'a later-voided claim has no current claim-report route');
  assert.equal(result.oldestOutstanding[0].claimReportAvailable,false);
});

test('petty cash reporting fails closed above the bounded fund count',async()=>{
  const fx=fixture('manager',async sql=>{
    if(sql.includes('FROM myfin.expenses e LEFT JOIN myfin.app_identities')||sql.includes('FROM myfin.transactions t')
      ||sql.includes('GROUP BY p.occurred_on,p.source_type'))return {rows:[]};
    if(sql.includes('FROM myfin.petty_cash_funds'))return {rows:Array.from({length:101},(_,index)=>({
      id:`fund-${index}`,name:`Fund ${index}`,status:'open',currency_code:'MYR',balance_sen:'0',opening_balance_sen:'0',
      replenishment_sen:'0',disbursement_sen:'0',adjustment_sen:'0',count_sen:'0',reversal_sen:'0'}))};
    throw Error(`Unexpected SQL: ${sql}`);
  });
  await assert.rejects(()=>fx.routes.get('/api/companies/:company/expense-insights')(fx.request),
    error=>error.statusCode===413&&error.message==='expense_petty_cash_funds_too_large');
});

test('checked sen accumulation rejects totals that exceed JavaScript exact integer range',async()=>{
  const rows=Array.from({length:91},(_,index)=>({id:`claim-${index}`,data:{date:'2026-10-01',category:'Operations'},
    amount_sen:'100000000000000',paid_as_of_sen:'0',status:'pending_payment',expense_date:'2026-10-01',
    created_by:'staff-a',created_by_name:'Staff A'}));
  const fx=fixture('manager',async(sql,params)=>{
    if(sql.includes('FROM myfin.expenses e LEFT JOIN myfin.app_identities'))return {rows};
    if(sql.includes('FROM myfin.transactions t')||sql.includes('GROUP BY p.expense_id,p.source_type')
      ||sql.includes(') visible_link WHERE position<=10')||sql.includes('GROUP BY p.occurred_on,p.source_type')
      ||sql.includes('FROM myfin.petty_cash_funds'))return {rows:[]};
    throw Error(`Unexpected SQL (${params.length}): ${sql}`);
  });
  await assert.rejects(()=>fx.routes.get('/api/companies/:company/expense-insights')(fx.request),
    error=>error.statusCode===422&&error.message==='financial_total_too_large');
});

test('legacy expense documents reconcile with financial analytics as imported claims and historical cash',async()=>{
  const fx=fixture('manager',async sql=>{
    if(sql.includes('FROM myfin.expenses e LEFT JOIN myfin.app_identities'))return {rows:[]};
    if(sql.includes('FROM myfin.transactions t')&&sql.includes('ORDER BY expense_date')){
      assert.match(sql,/document_state='legacy'/);assert.match(sql,/data->>'type' IN \('Expense','Payment Voucher'\)/);
      assert.match(sql,/coalesce\(t\.data->>'status',''\)<>'Voided'/);
      assert.match(sql,/myfin\.valid_expense_date\(left\(t\.data->>'date',10\)\) BETWEEN \$2::date AND \$3::date/);
      assert.doesNotMatch(sql,/left\(t\.data->>'date',10\) BETWEEN \$2 AND \$3/);
      assert.match(sql,/paidOn[\s\S]*>\$3::date THEN 0::bigint/);
      return {rows:[
        {id:'old-paid',data:{date:'2026-10-02',type:'Expense',description:'Legacy rent',category:'Rent',
          status:'Paid',attachmentPath:'legacy-receipt'},expense_date:'2026-10-02',amount_sen:'1234',paid_as_of_sen:'1234',
          paid_as_of_on:'2026-10-02',credit_due_date:null,status:'paid',source_type:'bank'},
        {id:'old-pending',data:{date:'2026-10-03',type:'Payment Voucher',description:'Pending voucher',category:'Other',
          status:'Pending'},expense_date:'2026-10-03',amount_sen:'500',paid_as_of_sen:'0',paid_as_of_on:'2026-10-03',
          credit_due_date:null,status:'pending_payment',source_type:'legacy_unspecified'},
        {id:'old-future',data:{date:'2026-10-04',type:'Expense',description:'Settled later',category:'Other',
          status:'Paid',paidAmountSen:700,paidOn:'2026-11-01'},expense_date:'2026-10-04',amount_sen:'700',
          paid_as_of_sen:'0',paid_as_of_on:'2026-11-01',credit_due_date:null,status:'pending_payment',source_type:'bank'},
      ]};
    }
    if(sql.includes('GROUP BY p.occurred_on,p.source_type'))return {rows:[]};
    if(sql.includes('FROM myfin.transactions t')&&sql.includes('GROUP BY'))return {rows:[
      {occurred_on:'2026-10-02',source_type:'bank',payment_count:1,net_sen:'1234'},
    ]};
    if(sql.includes('FROM myfin.petty_cash_funds'))return {rows:[]};
    throw Error(`Unexpected SQL: ${sql}`);
  });
  const result=await fx.routes.get('/api/companies/:company/expense-insights')(fx.request);
  assert.deepEqual(result.summary,{claimCount:3,draftCount:0,draftSen:0,totalSen:2434,paidSen:1234,
    outstandingSen:1200,cashOutSen:1234,overdueCount:0,overdueSen:0,evidenceCount:1,pettyCashSen:0});
  const paid=result.claims.find(row=>row.id==='legacy:old-paid');
  assert.equal(paid.recordType,'legacy_transaction');assert.equal(paid.claimReportAvailable,false);
  assert.equal(paid.claimantAttribution,'imported_unattributed');assert.equal(paid.evidence,'Attached');
  assert.deepEqual(paid.paymentSources,[{type:'bank',label:'Bank',amountSen:1234}]);
  assert.equal(result.claims.find(row=>row.id==='legacy:old-pending').status,'pending_payment');
  assert.equal(result.claims.find(row=>row.id==='legacy:old-future').paidSen,0);
  assert.equal(result.oldestOutstanding.find(row=>row.expenseId==='legacy:old-pending').claimReportAvailable,false);
});

test('claim detail is practically capped while complete aggregate totals remain available',async()=>{
  const run=async count=>{
    const rows=Array.from({length:count},(_,index)=>({id:`claim-${String(index).padStart(4,'0')}`,
      data:{date:'2026-10-01',category:'Operations'},amount_sen:'1',paid_as_of_sen:'1',status:'paid',
      expense_date:'2026-10-01',created_by:'staff-a',created_by_name:'Staff A'}));
    const fx=fixture('manager',async(sql,params)=>{
      if(sql.includes('FROM myfin.expenses e LEFT JOIN myfin.app_identities'))return {rows};
      if(sql.includes('FROM myfin.transactions t'))return {rows:[]};
      if(sql.includes('GROUP BY p.expense_id,p.source_type')||sql.includes(') visible_link WHERE position<=10')){
        assert.equal(params[1].length,Math.min(count,2000));return {rows:[]};
      }
      if(sql.includes('GROUP BY p.occurred_on,p.source_type')||sql.includes('FROM myfin.petty_cash_funds'))return {rows:[]};
      throw Error(`Unexpected SQL: ${sql}`);
    });
    return fx.routes.get('/api/companies/:company/expense-insights')(fx.request);
  };
  const boundary=await run(2000);assert.equal(boundary.claimsLimited,false);assert.equal(boundary.claims.length,2000);
  const over=await run(2001);assert.equal(over.summary.claimCount,2001);assert.equal(over.summary.totalSen,2001);
  assert.equal(over.claimsLimited,true);assert.equal(over.claimsReturned,2000);assert.equal(over.claimLimit,2000);
});
