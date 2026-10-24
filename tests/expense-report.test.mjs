import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildExpenseClaimReport, buildExpenseReport, cashbookExpensePayment, effectiveReportExpenseStatus,
  expenseClaimReportFilename, expenseReportFilename,
} from '../src/domain/expenseReport.js';
import { createExpenseClaimPdf, createExpenseReportPdf } from '../src/services/expenseReportPdf.js';

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

test('server-projected claims retain as-of payment, evidence and paid-date fields',()=>{
  const report=buildExpenseReport({...base,expenses:[{id:'server-claim',reference:'CLM-900',date:'2026-06-01',
    description:'Server projection',category:'Operations',amountSen:12500,paidSen:4500,outstandingSen:8000,
    status:'partially_paid',paidDate:'2026-06-03',evidence:'Attached',claimantId:'staff-1',claimantName:'Staff Alice',
    paymentSources:[{type:'bank',label:'Bank transfer',amountSen:4500}],links:[{label:'Purchase PO-1'}]}]});
  assert.equal(report.lines[0].paidSen,4500);assert.equal(report.lines[0].outstandingSen,8000);
  assert.equal(report.lines[0].totalSen,report.lines[0].paidSen+report.lines[0].outstandingSen);
  assert.equal(report.lines[0].paidOn,'2026-06-03');assert.equal(report.lines[0].evidence,'Attached');
  assert.equal(report.lines[0].paymentSource,'Bank transfer');
});

test('historical server projections keep status as of the applied report end date',()=>{
  const report=buildExpenseReport({...base,generatedAt:'2026-10-24T04:00:00.000Z',filters:{from:'2026-06-01',to:'2026-06-30'},
    analytics:{from:'2026-06-01',to:'2026-06-30',summary:{claimCount:1,totalSen:5000,outstandingSen:5000}},
    expenses:[{id:'historical',date:'2026-06-15',description:'Future due at report end',amountSen:5000,paidSen:0,
      outstandingSen:5000,status:'pending_payment',dueDate:'2026-07-15'}]});
  assert.equal(report.lines[0].status,'pending_payment');
});

test('drafts remain visible but excluded from posted financial totals',()=>{
  const report=buildExpenseReport({...base,expenses:[
    {id:'posted',date:'2026-10-01',description:'Posted',amountSen:4000,status:'pending_payment',outstandingSen:4000},
    {id:'draft',date:'2026-10-02',description:'Draft',amountSen:2500,status:'draft'},
  ]});
  assert.equal(report.totals.count,2);assert.equal(report.totals.draftCount,1);assert.equal(report.totals.draftSen,2500);
  assert.equal(report.totals.totalSen,4000);assert.equal(report.totals.outstandingSen,4000);
  assert.equal(report.lines.find(row=>row.id==='draft').statusLabel,'Draft (not posted)');
  assert.match(content(createExpenseReportPdf(report)),/DRAFTS \/ NOT POSTED/);
});

test('client report aggregation rejects totals beyond safe integer sen',()=>{
  assert.throws(()=>buildExpenseReport({...base,expenses:[
    {id:'large-1',date:'2026-10-01',description:'Large one',amountSen:Number.MAX_SAFE_INTEGER,status:'pending_payment'},
    {id:'large-2',date:'2026-10-02',description:'Large two',amountSen:Number.MAX_SAFE_INTEGER,status:'pending_payment'},
  ]}),/totals exceed the supported amount/);
});

test('attachment paths count as supporting evidence without exposing their value',()=>{
  const report=buildExpenseReport({...base,expenses:[{id:'attachment-claim',date:'2026-10-10',description:'Attached claim',
    amountSen:1000,status:'pending_payment',outstandingAmountSen:1000,attachmentPath:'private/company/receipt.jpg'}]});
  assert.equal(report.totals.evidenceCount,1);assert.equal(report.lines[0].evidence,'Attached');
  assert.doesNotMatch(JSON.stringify(report),/private\/company\/receipt\.jpg/);
});

test('aggregate reports prefer authoritative role-scoped analytics while retaining visible detail rows',()=>{
  const analytics={from:'2026-01-01',to:'2026-12-31',grain:'quarter',scope:{mode:'self',companyId:'company-1',claimantFilterAllowed:false},
    summary:{claimCount:4,totalSen:42005,paidSen:30005,outstandingSen:12000,cashOutSen:28005,overdueCount:1,overdueSen:7000,evidenceCount:3,pettyCashSen:9005},
    periods:[{key:'2026-Q1',label:'Q1 2026',from:'2026-01-01',to:'2026-03-31',claimCount:4,totalSen:42005,paidSen:30005,outstandingSen:12000,cashOutSen:28005}],
    ageing:[{key:'8_14',label:'8–14 days',claimCount:1,outstandingSen:7000}],
    categories:[{key:'travel',label:'Travel',claimCount:2,totalSen:22005,paidSen:15005,outstandingSen:7000}],
    claimants:[{id:'staff-1',name:'Staff Alice',attribution:'recorded_user',claimCount:4,totalSen:42005,paidSen:30005,outstandingSen:12000}],
    paymentSources:[{key:'petty_cash',label:'Petty cash',paymentCount:2,netSen:9005}],
    pettyCash:{restricted:true,claimDisbursementSen:9005,funds:[{id:'hidden',name:'Private fund',balanceSen:999999}]},
    oldestOutstanding:[{expenseId:'claim-1',reference:'CLM-001',date:'2026-01-03',dueDate:'2026-01-10',claimantId:'staff-1',claimantName:'Staff Alice',category:'Travel',totalSen:10000,paidSen:3000,outstandingSen:7000,ageDays:10,ageingKey:'8_14'}]};
  const report=buildExpenseReport({...base,expenses:[{id:'visible',date:'2026-01-03',description:'Visible claim',amountSen:100,status:'paid',paidAmountSen:100}],analytics});
  assert.equal(report.scope.type,'self');assert.equal(report.scope.label,'My claims');
  assert.deepEqual(report.totals,{count:4,draftCount:0,draftSen:0,totalSen:42005,paidSen:30005,outstandingSen:12000,cashOutSen:28005,overdueCount:1,overdueSen:7000,evidenceCount:3,pettyCashSen:9005});
  assert.deepEqual(report.periods.map(row=>[row.key,row.count,row.cashOutSen]),[['2026-Q1',4,28005]]);
  assert.deepEqual(report.ageing.map(row=>[row.label,row.count,row.outstandingSen]),[['8–14 days',1,7000]]);
  assert.deepEqual(report.byCategory.map(row=>[row.label,row.count,row.totalSen]),[['Travel',2,22005]]);
  assert.deepEqual(report.byClaimant.map(row=>[row.name,row.count,row.outstandingSen]),[['Staff Alice',4,12000]]);
  assert.deepEqual(report.byPaymentSource.map(row=>[row.label,row.count,row.amountSen]),[['Petty cash',2,9005]]);
  assert.equal(report.pettyCash.insights.restricted,true);assert.equal(report.lines.length,1);
  const text=content(createExpenseReportPdf(report));
  assert.match(text,/Cash expense by quarter/);assert.match(text,/8-14 days/);assert.match(text,/Staff Alice/);assert.match(text,/My claims/);
  assert.doesNotMatch(text,/Private fund|9,999\.99/);
});

test('aggregate PDF explains when bounded server detail is intentionally omitted',()=>{
  const report=buildExpenseReport({...base,expenses:[],detailsAvailable:false,analytics:{from:'2026-01-01',to:'2026-01-31',
    grain:'month',scope:{mode:'company'},summary:{claimCount:2500,totalSen:3000,paidSen:1000,outstandingSen:2000}},
    detailOmission:{reason:'report_limit',totalCount:2500,returnedCount:2000,limit:2000}});
  const text=content(createExpenseReportPdf(report));
  assert.equal(report.detailsAvailable,false);assert.doesNotMatch(text,/Expense details/);
  assert.doesNotMatch(text,/No matching expenses/);assert.match(text,/Line-level status breakdown omitted/);
  assert.match(text,/DETAIL ROWS OMITTED/);assert.match(text,/detail limit is 2000 records/);
});

test('legacy outstanding rows retain that individual claim PDFs are unavailable',()=>{
  const report=buildExpenseReport({...base,expenses:[],detailsAvailable:false,analytics:{from:'2026-01-01',to:'2026-01-31',
    summary:{claimCount:1,totalSen:1000,outstandingSen:1000},oldestOutstanding:[{expenseId:'legacy:old-1',reference:'OLD-1',
      date:'2026-01-01',outstandingSen:1000,recordType:'legacy_transaction',claimReportAvailable:false}]}});
  assert.equal(report.oldestOutstanding[0].claimReportAvailable,false);
});

test('individual claim report normalizes immutable evidence without retaining private receipt URLs',()=>{
  const report=buildExpenseClaimReport({...base,scope:{mode:'self'},expense:{
    id:'claim-17',reference:'CLM/017',date:'2026-10-01',createdAt:'2026-10-01T02:30:00Z',description:'Counter supplies',
    category:'Operations',payee:'Local vendor',amountSen:12345,status:'partially_paid',paidAmountSen:8000,
    outstandingAmountSen:4345,paidByType:'petty_cash',createdBy:'staff-1',createdByName:'Staff Alice',
    receiptUrl:'https://private.example/receipt.pdf?token=secret-token',links:[{label:'Stock receipt GR-17'}],
  },payments:[
    {id:'pay-1',eventType:'payment',amountSen:8000,sourceType:'petty_cash',pettyCashFundName:'Counter float',paidOn:'2026-10-02',reason:'Approved claim',actorName:'Manager One'},
    {id:'pay-2',eventType:'reversal',amountSen:500,sourceType:'petty_cash',pettyCashFundName:'Counter float',paidOn:'2026-10-03',reason:'Correct amount',actorName:'Manager One',reversesPaymentId:'pay-1'},
  ],events:[
    {id:'event-1',expenseVersion:1,action:'created',to:{status:'pending_payment',amountSen:12345,paidAmountSen:0,outstandingAmountSen:12345},reason:'Submitted',actorName:'Staff Alice',createdAt:'2026-10-01T02:30:00Z'},
    {id:'event-2',expenseVersion:2,action:'payment_recorded',from:{status:'pending_payment',amountSen:12345,outstandingAmountSen:12345},to:{status:'partially_paid',amountSen:12345,paidAmountSen:8000,outstandingAmountSen:4345},reason:'Approved claim',actorName:'Manager One',createdAt:'2026-10-02T03:00:00Z'},
  ]});
  assert.equal(report.claim.submittedByName,'Staff Alice');assert.equal(report.claim.evidence,'Attached');
  assert.equal(report.totals.paymentNetSen,7500);assert.equal(report.payments[1].signedAmountSen,-500);
  assert.equal(report.payments[1].reversesEventId,'pay-1');
  assert.equal(expenseClaimReportFilename(report),'ba-li-coffee-expense-claim-clm-017.pdf');
  assert.doesNotMatch(JSON.stringify(report),/private\.example|secret-token|balanceSen/);
  const pdf=createExpenseClaimPdf(report),text=content(pdf);
  assert.match(text,/Expense Claim Report/);assert.match(text,/Staff Alice/);assert.match(text,/Counter supplies/);
  assert.match(text,/Payment history/);assert.match(text,/Payment reversal/);assert.match(text,/Lifecycle history/);assert.match(text,/payment recorded/);
  assert.match(text,/Stock receipt GR-17/);assert.match(text,/Supporting evidence/);assert.match(text,/Attached/);
  assert.doesNotMatch(text,/private\.example|secret-token|Available cash|Fund balance/);
  for(let page=1;page<=pdf.getNumberOfPages();page++)assert.match(pdf.internal.pages[page].join('\n'),new RegExp(`Page ${page} of ${pdf.getNumberOfPages()}`));
});

test('individual claim reports reject missing claims and invalid generation timestamps',()=>{
  assert.throws(()=>buildExpenseClaimReport({...base,expense:null}),/valid expense claim/);
  assert.throws(()=>buildExpenseClaimReport({...base,expense:{id:'claim-1'},generatedAt:'not-a-date'}),/valid generated timestamp/);
  assert.throws(()=>createExpenseClaimPdf({kind:'expense_claim'}),/incomplete/);
});

test('claim submission timestamp falls back to the immutable creation event',()=>{
  const report=buildExpenseClaimReport({...base,expense:{id:'claim-no-created-at',date:'2026-10-01',description:'Imported claim',
    amountSen:5000,status:'pending_payment',outstandingAmountSen:5000},events:[
    {id:'event-2',expenseVersion:2,action:'updated',createdAt:'2026-10-02T04:00:00Z'},
    {id:'event-1',expenseVersion:1,action:'imported',createdAt:'2026-10-01T03:00:00Z'},
  ]});
  assert.equal(report.claim.submittedAt,'2026-10-01T03:00:00.000Z');
});

test('Unicode report font embeds for multilingual expense claims',async()=>{
  const fontBase64=(await readFile(new URL('../src/assets/fonts/DroidSansFallbackFull.ttf',import.meta.url))).toString('base64');
  const report=buildExpenseClaimReport({...base,company:{...company,name:'山海咖啡'},expense:{id:'claim-unicode',reference:'申請-2026-000000000001',
    date:'2026-10-01',description:'Bekalan 李小姐',amountSen:5000,status:'pending_payment',outstandingAmountSen:5000}});
  const pdf=createExpenseClaimPdf(report,{fontBase64,fontFamily:'DroidSansFallbackFull',fontFilename:'DroidSansFallbackFull.ttf'});
  assert.equal(pdf.__myfinExpenseFont,'DroidSansFallbackFull');assert(pdf.getNumberOfPages()>=1);
  assert(Buffer.from(pdf.output('arraybuffer')).byteLength>10000);
});
