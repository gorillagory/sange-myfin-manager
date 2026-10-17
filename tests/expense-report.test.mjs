import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExpenseReport, cashbookExpensePayment, effectiveReportExpenseStatus, expenseReportFilename } from '../src/domain/expenseReport.js';
import { createExpenseReportPdf } from '../src/services/expenseReportPdf.js';

const company={id:'company-1',name:'BA | LI Coffee',registration:'SYNTHETIC-001',preferences:{currency:'RM'}};
const base={company,workspace:{id:'workspace-1',name:'Bayam Food Services'},actor:{id:'owner-1',username:'Test Owner'},generatedAt:'2026-10-17T04:00:00.000Z'};
const content=pdf=>pdf.internal.pages.slice(1).map(page=>page.join('\n')).join('\n');

test('expense report status projection accepts legacy and immutable payment states',()=>{
  assert.equal(effectiveReportExpenseStatus({status:'pending',creditDueDate:'2026-10-18'},'2026-10-17'),'pending_payment');
  assert.equal(effectiveReportExpenseStatus({status:'pending_payment',creditDueDate:'2026-10-16'},'2026-10-17'),'overdue');
  assert.equal(effectiveReportExpenseStatus({status:'pending_payment'},'2026-10-17'),'pending_payment');
  assert.equal(effectiveReportExpenseStatus({status:'partially_paid',creditDueDate:'2026-10-18'},'2026-10-17'),'partially_paid');
  assert.equal(effectiveReportExpenseStatus({status:'partially_paid',creditDueDate:'2026-10-16'},'2026-10-17'),'overdue');
  assert.equal(effectiveReportExpenseStatus({status:'paid'},'2026-10-17'),'paid');
  assert.equal(effectiveReportExpenseStatus({status:'paid',voidedAt:'2026-10-17T01:00:00Z'},'2026-10-17'),'voided');
});

test('expense report filters and totals paid and outstanding amounts in integer sen',()=>{
  const report=buildExpenseReport({...base,filters:{from:'2026-10-01',to:'2026-10-31'},expenses:[
    {id:'a',date:'2026-10-02',description:'Coffee beans',category:'Inventory',amountSen:10001,amount:100.01,status:'paid',paidAmountSen:10001,outstandingAmountSen:0,paidByType:'app_user',paidByUserName:'Owner',receiptUrl:'https://example.test/a'},
    {id:'b',date:'2026-10-05',description:'Repair',category:'Operations',amountSen:8099,amount:80.99,status:'partially_paid',paidAmountSen:3000,outstandingAmountSen:5099,paidByType:'unassigned',paymentSources:[{sourceType:'petty_cash',pettyCashFundName:'Counter float',amountSen:2000},{sourceType:'card',amountSen:1000}]},
    {id:'old',date:'2026-09-30',description:'Outside',amount:20,status:'paid'},
  ]});
  assert.equal(report.totals.count,2);assert.equal(report.totals.totalSen,18100);assert.equal(report.totals.paidSen,13001);assert.equal(report.totals.outstandingSen,5099);assert.equal(report.totals.evidenceCount,1);
  assert.deepEqual(report.byStatus.map(row=>[row.label,row.amountSen]),[['Paid',10001],['Partially paid',8099]]);
  assert.deepEqual(report.byPaymentSource.map(row=>[row.label,row.amountSen]),[['Owner',10001],['Outstanding / not settled',5099],['Reserved petty cash - Counter float',2000],['Card',1000]]);
  assert.equal(expenseReportFilename(report),'ba-li-coffee-expense-report-2026-10-01-to-2026-10-31.pdf');
});

test('unpaid expenses are reported as outstanding rather than attributed to a payment source',()=>{
  const report=buildExpenseReport({...base,expenses:[{id:'unpaid',date:'2026-10-17',description:'Awaiting claim',amount:50,
    status:'pending_payment',paidAmountSen:0,outstandingAmountSen:5000,paidByType:'unassigned'}]});
  assert.deepEqual(report.byPaymentSource.map(row=>[row.label,row.amountSen]),[['Outstanding / not settled',5000]]);
});

test('cash book presents a payment reversal as restored cash in with a positive display amount',()=>{
  assert.deepEqual(cashbookExpensePayment({id:'reverse-1',amount:-25.5,cashDate:'2026-10-17',kind:'Expense payment reversal',expenseId:'expense-1'}),{
    id:'reverse-1',amount:25.5,cashDate:'2026-10-17',date:'2026-10-17',kind:'Expense payment reversal',expenseId:'expense-1',
    direction:'in',label:'Expense payment reversal',description:'expense-1',
  });
});

test('petty cash reconciliation derives the period opening balance, signed movements, count and variance',()=>{
  const report=buildExpenseReport({...base,filters:{from:'2026-10-02',to:'2026-10-04'},pettyCash:{scope:'selected_fund',funds:[{id:'fund-1',name:'Counter float',openingBalanceSen:10000,balanceSen:10000}],entries:[
    {id:'1',fundId:'fund-1',type:'opening_balance',direction:'in',amountSen:10000,signedAmountSen:10000,balanceAfterSen:10000,occurredAt:'2026-10-01T01:00:00Z'},
    {id:'2',fundId:'fund-1',type:'expense_disbursement',direction:'out',amountSen:2500,signedAmountSen:-2500,balanceAfterSen:7500,occurredAt:'2026-10-02T01:00:00Z'},
    {id:'3',fundId:'fund-1',type:'replenishment',direction:'in',amountSen:3000,signedAmountSen:3000,balanceAfterSen:10500,occurredAt:'2026-10-03T01:00:00Z'},
    {id:'4',fundId:'fund-1',type:'reconciliation',direction:'out',amountSen:500,signedAmountSen:-500,balanceAfterSen:10000,countedBalanceSen:10000,occurredAt:'2026-10-04T01:00:00Z'},
  ]}});
  assert.equal(report.pettyCash.summary.openingBalanceSen,10000);assert.equal(report.pettyCash.summary.disbursementsSen,2500);assert.equal(report.pettyCash.summary.replenishmentsSen,3000);
  assert.equal(report.pettyCash.summary.expectedBalanceSen,10500);assert.equal(report.pettyCash.summary.countedBalanceSen,10000);assert.equal(report.pettyCash.summary.varianceSen,-500);
});

test('petty reconciliation keeps exact same-day order and exposes reversals and prior count variances',()=>{
  const report=buildExpenseReport({...base,filters:{from:'2026-10-02',to:'2026-10-02'},pettyCash:{funds:[{id:'fund-1',name:'Counter'}],entries:[
    {id:'open',fundId:'fund-1',type:'opening_balance',signedAmountSen:10000,amountSen:10000,occurredAt:'2026-10-01T01:00:00Z'},
    {id:'b-adjust',fundId:'fund-1',type:'adjustment_out',signedAmountSen:-100,amountSen:100,occurredAt:'2026-10-02T01:00:00Z'},
    {id:'z-earlier-count',fundId:'fund-1',type:'reconciliation',signedAmountSen:-100,amountSen:100,countedBalanceSen:9800,occurredAt:'2026-10-02T02:00:00Z'},
    {id:'m-reversal',fundId:'fund-1',type:'reversal',signedAmountSen:100,amountSen:100,occurredAt:'2026-10-02T03:00:00Z'},
    {id:'a-latest-count',fundId:'fund-1',type:'reconciliation',signedAmountSen:-50,amountSen:50,countedBalanceSen:9850,occurredAt:'2026-10-02T04:00:00Z'},
  ]}});
  const summary=report.pettyCash.summary;
  assert.equal(summary.openingBalanceSen,10000);assert.equal(summary.adjustmentOutSen,100);
  assert.equal(summary.reversalInSen,100);assert.equal(summary.priorCountOutSen,100);
  assert.equal(summary.expectedBalanceSen,9900);assert.equal(summary.countedBalanceSen,9850);assert.equal(summary.varianceSen,-50);
  assert.equal(report.pettyCash.movements.at(-1).id,'a-latest-count');
});

test('petty cash detail follows immutable posting order when a later post has an earlier effective date',()=>{
  const report=buildExpenseReport({...base,pettyCash:{funds:[{id:'fund-1',name:'Counter'}],entries:[
    {id:'open',fundId:'fund-1',type:'opening_balance',signedAmountSen:10000,amountSen:10000,balanceAfterSen:10000,
      occurredAt:'2026-10-01T01:00:00Z',createdAt:'2026-10-01T01:00:00Z'},
    {id:'spend',fundId:'fund-1',type:'expense_disbursement',signedAmountSen:-1000,amountSen:1000,balanceAfterSen:9000,
      occurredAt:'2026-10-03T01:00:00Z',createdAt:'2026-10-03T01:00:00Z'},
    {id:'backdated-topup',fundId:'fund-1',type:'replenishment',signedAmountSen:2000,amountSen:2000,balanceAfterSen:11000,
      occurredAt:'2026-10-02T01:00:00Z',createdAt:'2026-10-04T01:00:00Z'},
  ]}});
  assert.deepEqual(report.pettyCash.movements.map(row=>row.id),['open','spend','backdated-topup']);
  assert.deepEqual(report.pettyCash.movements.map(row=>row.balanceAfterSen),[10000,9000,11000]);
  assert.equal(report.pettyCash.movements.at(-1).date,'2026-10-02','the effective date remains visible');
});

test('expense PDF is selectable, paginated and includes report controls and petty cash detail',()=>{
  const expenses=Array.from({length:75},(_,index)=>({id:`expense-${index}`,number:`EXP-${String(index+1).padStart(4,'0')}`,date:`2026-10-${String(index%17+1).padStart(2,'0')}`,description:`Expense ${index+1} with finance detail`,category:index%2?'Inventory':'Operations',amount:10+index/100,status:index%3?'paid':'pending_payment',paidAmountSen:index%3?1000+index:0,outstandingAmountSen:index%3?0:1000+index,paidByType:'other',paidByName:'Business account',receiptUrl:index%2?'https://example.test/receipt':''}));
  const report=buildExpenseReport({...base,expenses,pettyCash:{funds:[{id:'fund-1',name:'Counter float',openingBalanceSen:5000,balanceSen:4500}],entries:[{id:'entry-1',fundId:'fund-1',type:'expense_disbursement',direction:'out',amountSen:500,signedAmountSen:-500,balanceAfterSen:4500,occurredAt:'2026-10-01T01:00:00Z',reason:'Supplies'}]}});
  const pdf=createExpenseReportPdf(report),text=content(pdf);
  assert(pdf.getNumberOfPages()>2);assert.match(text,/Expense and Claim Report/);assert.match(text,/Expense details/);assert.match(text,/Petty cash reconciliation/);assert.match(text,/CONTROL NOTE/);
  for(let page=1;page<=pdf.getNumberOfPages();page++)assert.match(pdf.internal.pages[page].join('\n'),new RegExp(`Page ${page} of ${pdf.getNumberOfPages()}`));
});
