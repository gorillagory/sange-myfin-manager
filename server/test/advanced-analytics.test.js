import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advancedAnalyticsRange, analyzeSalesRows, financialPerformance, lineAmountSen,
  registerAdvancedAnalytics, studentAggregate,
} from '../src/advanced-analytics.js';

function fixture(role = 'manager', query = async () => ({ rows: [], rowCount:0 })) {
  const routes = new Map(), calls = [];
  const client = { async query(sql, params = []) {
    calls.push({ sql, params }); return query(sql, params);
  } };
  const app = { get(path, handler) { routes.set(path, handler); } };
  registerAdvancedAnalytics(app, { scoped:(req, fn) => fn(client, req.params.company) });
  const request = { params:{ company:'company-a' }, query:{ from:'2026-10-01',to:'2026-10-09' },
    identity:{ id:'staff-a',role } };
  return { routes,calls,request };
}

test('analytics range is a valid inclusive range of no more than 366 days', () => {
  assert.deepEqual(advancedAnalyticsRange({ from:'2024-01-01',to:'2024-12-31' }),
    { from:'2024-01-01',to:'2024-12-31',toExclusive:'2025-01-01' });
  assert.throws(() => advancedAnalyticsRange({ from:'2024-01-01',to:'2025-01-01' }),
    error => error.statusCode === 400 && error.message === 'invalid_analytics_range');
  assert.throws(() => advancedAnalyticsRange({ from:'2026-10-09',to:'2026-10-01' }),
    error => error.statusCode === 400 && error.message === 'invalid_analytics_range');
});

test('integer-sen calculations recognize only snapshotted line costs and withhold incomplete profit', () => {
  assert.equal(lineAmountSen('8.50','2.5'),2125n);
  const rows = [
    { id:'sale-a',total:'10.60',tax:'0.60',items:[
      { productId:'latte',desc:'Latte',price:5,qty:1,cost:2 },
      { productId:'cake',desc:'Cake',price:5,qty:1 },
    ] },
    { id:'sale-b',total:'5.00',tax:'0',items:[
      { productId:'latte',desc:'Latte',price:5,qty:1,cost:3 },
    ] },
  ];
  const result = financialPerformance(rows,'300');
  assert.deepEqual({ sales:result.salesSen,tax:result.taxSen,net:result.netSalesSen,
    covered:result.coveredRevenueSen,cogs:result.recognizedCogsSen,margin:result.recognizedGrossMarginSen },
  { sales:'1560',tax:'60',net:'1500',covered:'1000',cogs:'500',margin:'500' });
  assert.equal(result.coverageBasisPoints,6667);
  assert.equal(result.missingCostLineCount,1);
  assert.equal(result.complete,false);
  assert.equal(result.grossMarginSen,null);
  assert.equal(result.operatingContributionSen,null);
  assert.match(result.limitation,/withheld/);
  assert.deepEqual(result.productPerformance.map(row => [row.productId,row.quantityMilli,row.grossLineSalesSen]),
    [['latte','2000','1000'],['cake','1000','500']]);
});

test('complete cost coverage returns gross margin and operating contribution in exact sen', () => {
  const result = financialPerformance([
    { id:'sale',total:'21.20',tax:'1.20',items:[{ productId:'meal',desc:'Meal',price:'20',qty:'1',cost:'8.125' }] },
  ],'350');
  assert.equal(result.recognizedCogsSen,'813');
  assert.equal(result.complete,true);
  assert.equal(result.grossMarginSen,'1187');
  assert.equal(result.operatingContributionSen,'837');
});

test('student aggregates suppress enrollment, activity and per-promotion cohorts below five', () => {
  const result = studentAggregate({ eligible_customer_count:4,active_customer_count:3,
    priced_order_count:12,subtotal_sen:'9000',discount_sen:'900',redemption_count:7,
    promotion_rows:[{ promotion_id:'student-ten',name:'Student 10%',customer_count:2,
      redemptions:7,discount_sen:'900' }] });
  assert.deepEqual(result.enrollment,{ suppressed:true,cohortThreshold:5 });
  assert.deepEqual(result.activity,{ suppressed:true,cohortThreshold:5 });
  assert.deepEqual(result.promotions[0],{
    promotionId:'student-ten',name:'Student 10%',suppressed:true,cohortThreshold:5,
  });
  assert.doesNotMatch(JSON.stringify(result),/9000|900|customer_id/);
});

test('manager operational analytics are aggregated, tenant bounded and contain no customer PII or costs', async () => {
  const fx = fixture('manager', async sql => {
    if (sql.includes('WITH period_orders')) return { rows:[{ total_orders:8,awaiting_acceptance:1,
      accepted:1,preparing:1,ready:1,cancelled:1,expired:1,paid:2,guest_orders:3,account_orders:5,
      registered_customers:4,repeat_customers:1,order_value_sen:'12345',average_order_sen:'1543',
      average_acceptance_minutes:7 }],rowCount:1 };
    if (sql.includes('WITH period_ledger')) return { rows:[{ movement_count:4,receive_count:1,
      count_count:0,adjust_count:1,consume_count:1,waste_count:1,receipt_documents:1,reversed_receipts:0,
      open_low_stock:2,acknowledged_low_stock:1,waste_items:[{ item_id:'milk',name:'Milk',base_unit:'ml',quantity:'250',movements:1 }],
      received_items:[{ item_id:'cups',name:'Cups',base_unit:'pcs',quantity:'100',movements:1 }] }],rowCount:1 };
    if (sql.includes('WITH company_scope')) return { rows:[{ eligible_customer_count:4,
      active_customer_count:2,priced_order_count:2,subtotal_sen:'2000',discount_sen:'200',
      redemption_count:2,promotion_rows:[] }],rowCount:1 };
    if (sql.includes('FROM myfin.transactions')) return { rows:[{ id:'sale-a',total:'10',tax:'0',
      items:[{ productId:'coffee',desc:'Coffee',price:10,qty:1,cost:4 }] }],rowCount:1 };
    throw Error(`Unexpected SQL: ${sql}`);
  });
  const result = await fx.routes.get('/api/companies/:company/analytics/operations')(fx.request);
  assert.equal(result.orders.total,8);
  assert.equal(result.customers.repeatRateBasisPoints,2500);
  assert.equal(result.inventory.wasteItems[0].baseUnit,'ml');
  assert.equal(result.productPerformance[0].grossLineSalesSen,'1000');
  assert.equal(result.student.activity.suppressed,true);
  assert.doesNotMatch(JSON.stringify(result),/"(?:cost|margin|profit|cogs|email|phone|displayName)"/i);
  assert.ok(fx.calls.every(call => call.params[0] === 'company-a'));
  assert.ok(fx.calls.every(call => call.params.includes('2026-10-01')));
  const sql = fx.calls.map(call => call.sql).join('\n');
  assert.doesNotMatch(sql,/primary_email|guest_email|guest_phone|display_name/);
  assert.match(sql,/LIMIT \$4/);
});

test('operators are denied all advanced analytics before any database query', async () => {
  const fx = fixture('operator');
  await assert.rejects(
    fx.routes.get('/api/companies/:company/analytics/operations')(fx.request),
    error => error.statusCode === 403 && error.message === 'access_denied',
  );
  assert.equal(fx.calls.length,0);
});

test('cost endpoint is owner-only and a manager is rejected before cost queries', async () => {
  const manager = fixture('manager');
  await assert.rejects(
    manager.routes.get('/api/companies/:company/analytics/cost-performance')(manager.request),
    error => error.statusCode === 403 && error.message === 'access_denied',
  );
  assert.equal(manager.calls.length,0);

  const owner = fixture('workspace_owner', async sql => sql.includes('SELECT coalesce(sum(amount_sen)')
    ? { rows:[{ amount_sen:'250' }],rowCount:1 }
    : { rows:[{ id:'sale',total:'10',tax:'0',items:[{ productId:'p',desc:'P',price:10,qty:1,cost:4 }] }],rowCount:1 });
  const result = await owner.routes.get('/api/companies/:company/analytics/cost-performance')(owner.request);
  assert.equal(result.recognizedCogsSen,'400');
  assert.equal(result.grossMarginSen,'600');
  assert.equal(result.operatingContributionSen,'350');
});

test('sales analytics fail closed rather than return a partial dense range', async () => {
  const fx = fixture('manager', async sql => {
    if (sql.includes('WITH period_orders') || sql.includes('WITH period_ledger') || sql.includes('WITH company_scope'))
      return { rows:[{}],rowCount:1 };
    if (sql.includes('FROM myfin.transactions')) return { rows:Array.from({length:2001},(_,index)=>({ id:String(index),total:'0',tax:'0',items:[] })),rowCount:2001 };
    throw Error('Unexpected SQL');
  });
  await assert.rejects(
    fx.routes.get('/api/companies/:company/analytics/operations')(fx.request),
    error => error.statusCode === 409 && error.message === 'analytics_range_too_dense',
  );
});

test('product performance never adopts current catalog cost when a sale snapshot omitted cost', () => {
  const result = analyzeSalesRows([{ id:'legacy',total:'10',tax:'0',items:[{
    productId:'p',desc:'Historical product',price:10,qty:1,
  }] }]);
  assert.equal(result.recognizedCogsSen,'0');
  assert.equal(result.complete,false);
  assert.equal(result.productPerformance[0].grossLineSalesSen,'1000');
});

test('migrated legacy invoices participate and infer recorded tax using reporting semantics', () => {
  const result = analyzeSalesRows([{ id:'legacy-invoice',document_state:'legacy',total:'106.00',
    tax:null,tax_rate:'6',subtotal:'100',discount:'0',discount_amount:null,
    items:[{ productId:'service',desc:'Migrated service',price:'100',qty:'1',cost:'20' }] }]);
  assert.equal(result.salesSen,'10600');
  assert.equal(result.taxSen,'600');
  assert.equal(result.netSalesSen,'10000');
  assert.equal(result.recognizedCogsSen,'2000');
  assert.equal(result.recognizedGrossMarginSen,'8000');
});
