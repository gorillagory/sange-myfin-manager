import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advancedAnalyticsRange, analyzeSalesRows, dailyPerformanceForRange, financialPerformance, lineAmountSen,
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

test('refund lines preserve signed quantity, revenue, cost and exact-cent allocation', () => {
  const result = financialPerformance([{
    id:'refund', total:'-10.01', tax:'-0.71', items:[
      { productId:'latte',desc:'Latte',price:'6.00',qty:'-1',cost:'2.50' },
      { productId:'tart',desc:'Tart',price:'4.00',qty:'-1',cost:'1.25' },
    ],
  }],'0');
  assert.deepEqual({ sales:result.salesSen,tax:result.taxSen,net:result.netSalesSen,
    covered:result.coveredRevenueSen,cogs:result.recognizedCogsSen,
    recognizedMargin:result.recognizedGrossMarginSen,grossMargin:result.grossMarginSen }, {
    sales:'-1001',tax:'-71',net:'-930',covered:'-930',cogs:'-375',
    recognizedMargin:'-555',grossMargin:'-555',
  });
  assert.equal(result.coverageBasisPoints,10000);
  assert.equal(result.complete,true);
  assert.deepEqual(result.productPerformance.map(row => [row.productId,row.quantityMilli,row.grossLineSalesSen]),
    [['tart','-1000','-400'],['latte','-1000','-600']]);
  assert.deepEqual(result.productPerformance.map(row => [row.contributionType,row.shareBasisPoints]),
    [['return',0],['return',0]]);
});

test('product share uses positive net revenue and zero-sale days remain visible', () => {
  const result=analyzeSalesRows([
    { id:'sale',business_date:'2026-10-01',total:'100',tax:'0',
      items:[{ productId:'sale',desc:'Sale',price:'100',qty:'1' }] },
    { id:'return',business_date:'2026-10-03',total:'-90',tax:'0',
      items:[{ productId:'return',desc:'Return',price:'90',qty:'-1' }] },
  ]);
  assert.deepEqual(result.productPerformance.map(row =>
    [row.productId,row.netLineSalesSen,row.contributionType,row.shareBasisPoints]),[
    ['sale','10000','sale',10000],['return','-9000','return',0],
  ]);
  const filled=dailyPerformanceForRange(result.dailyPerformance,'2026-10-01','2026-10-03');
  assert.deepEqual(filled,[
    { date:'2026-10-01',salesSen:'10000',netSalesSen:'10000',salesCount:1 },
    { date:'2026-10-02',salesSen:'0',netSalesSen:'0',salesCount:0 },
    { date:'2026-10-03',salesSen:'-9000',netSalesSen:'-9000',salesCount:1 },
  ]);
  assert.equal(filled.reduce((sum,day) => sum+BigInt(day.salesSen),0n),BigInt(result.salesSen));
  assert.deepEqual(dailyPerformanceForRange([],'2024-02-28','2024-03-01').map(day => day.date),
    ['2024-02-28','2024-02-29','2024-03-01']);
});

test('positive net share reflects same-product refunds without treating returns as demand', () => {
  const result=analyzeSalesRows([
    { id:'sale-a',total:'100',tax:'0',items:[{ productId:'a',desc:'A',price:'100',qty:'1' }] },
    { id:'refund-a',total:'-40',tax:'0',items:[{ productId:'a',desc:'A',price:'40',qty:'-1' }] },
    { id:'sale-b',total:'40',tax:'0',items:[{ productId:'b',desc:'B',price:'40',qty:'1' }] },
  ]);
  assert.deepEqual(result.productPerformance.map(row =>
    [row.productId,row.netLineSalesSen,row.contributionType,row.shareBasisPoints]),[
    ['a','6000','sale',6000],['b','4000','sale',4000],
  ]);
  const exchange=analyzeSalesRows([{ id:'exchange',total:'60',tax:'0',items:[
    { productId:'new',desc:'New item',price:'100',qty:'1' },
    { productId:'returned',desc:'Returned item',price:'40',qty:'-1' },
  ] }]);
  assert.deepEqual(exchange.productPerformance.map(row =>
    [row.productId,row.netLineSalesSen,row.contributionType,row.shareBasisPoints]),[
    ['new','10000','sale',10000],['returned','-4000','return',0],
  ]);
});

test('snapshotless product attribution excludes explicit delivery fees and cash rounding', () => {
  const result=analyzeSalesRows([{
    id:'legacy-delivery',total:'15.00',tax:'0',delivery_fee:'5.00',rounding:'0.01',
    items:[{ productId:'meal',desc:'Meal',price:'9.99',qty:'1',cost:'4.00' }],
  }]);
  assert.equal(result.salesSen,'1500');
  assert.equal(result.netSalesSen,'1500');
  assert.equal(result.productPerformance[0].netLineSalesSen,'999');
  assert.equal(result.coveredRevenueSen,'999');
  assert.equal(result.coverageBasisPoints,10000);
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
      registered_customers:4,repeat_customers:1,submitted_demand_value_sen:'12345',
      submitted_average_order_sen:'1543',paid_order_value_sen:'4567',paid_average_order_sen:'2284',
      average_acceptance_minutes:7 }],rowCount:1 };
    if (sql.includes('WITH period_ledger')) return { rows:[{ movement_count:4,receive_count:1,
      count_count:0,adjust_count:1,consume_count:1,waste_count:1,receipt_documents:1,reversed_receipts:0,
      open_low_stock:2,acknowledged_low_stock:1,waste_items:[{ item_id:'milk',name:'Milk',base_unit:'ml',quantity:'250',movements:1 }],
      received_items:[{ item_id:'cups',name:'Cups',base_unit:'pcs',quantity:'100',movements:1 }] }],rowCount:1 };
    if (sql.includes('WITH company_scope')) return { rows:[{ eligible_customer_count:4,
      active_customer_count:2,priced_order_count:2,subtotal_sen:'2000',discount_sen:'200',
      redemption_count:2,promotion_rows:[] }],rowCount:1 };
    if (sql.includes("data->>'category' AS category")) return { rows:[{
      id:'coffee',category:'Beverage',subcategory:'Coffee',
    }],rowCount:1 };
    if (sql.includes('FROM myfin.transactions')) return { rows:[{ id:'sale-a',document_state:'legacy',total:'10',tax:'0',
      items:[{ productId:'coffee',desc:'Coffee',price:10,qty:1,cost:4 }] }],rowCount:1 };
    throw Error(`Unexpected SQL: ${sql}`);
  });
  const result = await fx.routes.get('/api/companies/:company/analytics/operations')(fx.request);
  assert.equal(result.orders.total,8);
  assert.equal(result.orders.submittedDemandValueSen,'12345');
  assert.equal(result.orders.submittedAverageOrderSen,'1543');
  assert.equal(result.orders.paidOrderValueSen,'4567');
  assert.equal(result.orders.paidAverageOrderSen,'2284');
  assert.equal(result.orders.orderValueSen,'4567');
  assert.equal(result.customers.repeatRateBasisPoints,2500);
  assert.equal(result.inventory.wasteItems[0].baseUnit,'ml');
  assert.equal(result.productPerformance[0].grossLineSalesSen,'1000');
  assert.equal(result.productPerformance[0].category,'Beverage');
  assert.equal(result.categoryPerformance[0].subcategory,'Coffee');
  assert.equal(result.salesPerformance.current.salesSen,'1000');
  assert.equal(result.salesPerformance.change.salesBasisPoints,0);
  assert.equal(result.student.activity.suppressed,true);
  assert.doesNotMatch(JSON.stringify(result),/"(?:cost|margin|profit|cogs|email|phone|displayName)"/i);
  assert.ok(fx.calls.every(call => call.params[0] === 'company-a'));
  const datedCalls=fx.calls.filter(call=>call.params.length>=3);
  assert.ok(datedCalls.some(call=>call.params.includes('2026-10-01')&&call.params.includes('2026-10-09')));
  assert.ok(datedCalls.some(call=>call.params.includes('2026-09-22')&&call.params.includes('2026-09-30')));
  const sql = fx.calls.map(call => call.sql).join('\n');
  assert.doesNotMatch(sql,/primary_email|guest_email|guest_phone|display_name/);
  assert.match(sql,/LIMIT \$4/);
  assert.match(sql,/sum\(total\) FILTER\(WHERE payment_state='paid'\)/);
  assert.match(result.coverage.orders,/Submitted demand includes later cancellations and expiries/);
  assert.doesNotMatch(sql,/FROM myfin\.pricing_snapshot_lines/);
});

test('current catalogue classification is limited to snapshot-less legacy rows', async () => {
  const fx=fixture('manager',async (sql,params) => {
    if (sql.includes('WITH period_orders') || sql.includes('WITH period_ledger') || sql.includes('WITH company_scope'))
      return { rows:[{}],rowCount:1 };
    if (sql.includes('FROM myfin.transactions')) {
      if (params[1]!=='2026-10-01') return { rows:[],rowCount:0 };
      return { rows:[
        { id:'legacy',document_state:'legacy',business_date:'2026-10-01',total:'10',tax:'0',
          items:[{ productId:'legacy-product',desc:'Legacy',price:'10',qty:'1' }] },
        { id:'issued',document_state:'issued',business_date:'2026-10-02',total:'20',tax:'0',
          items:[{ productId:'issued-product',desc:'Issued',price:'20',qty:'1' }] },
      ],rowCount:2 };
    }
    if (sql.includes("data->>'category' AS category")) {
      assert.deepEqual(params,['company-a',['legacy-product']]);
      return { rows:[{ id:'legacy-product',category:'Current legacy category',subcategory:'Fallback' }],rowCount:1 };
    }
    throw Error(`Unexpected SQL: ${sql}`);
  });
  const result=await fx.routes.get('/api/companies/:company/analytics/operations')(fx.request);
  const products=new Map(result.productPerformance.map(row => [row.productId,row]));
  assert.equal(products.get('legacy-product').category,'Current legacy category');
  assert.equal(products.get('legacy-product').subcategory,'Fallback');
  assert.equal(products.get('issued-product').category,'Uncategorized');
});

test('immutable pricing lines drive historical category and discounted net attribution', async () => {
  const fx=fixture('manager',async (sql,params) => {
    if (sql.includes('WITH period_orders') || sql.includes('WITH period_ledger') || sql.includes('WITH company_scope'))
      return { rows:[{}],rowCount:1 };
    if (sql.includes('FROM myfin.transactions')) {
      if (params[1]!=='2026-10-01') return { rows:[],rowCount:0 };
      return { rows:[{ id:'priced-sale',pricing_snapshot_id:'pricing-a',business_date:'2026-10-03',
        total:'100',tax:'0',items:[
          { productId:'promo',desc:'Promoted item',price:'100',qty:'1',category:'Current offers',subcategory:'Current' },
          { productId:'regular',desc:'Regular item',price:'100',qty:'1',category:'Current drinks',subcategory:'Tea' },
        ] }],rowCount:1 };
    }
    if (sql.includes('FROM myfin.pricing_snapshot_lines')) return { rows:[
      { snapshot_id:'pricing-a',line_no:1,product_id:'promo',variant_id:null,
        category:'Historic offers',subcategory:'Reward',quantity_milli:'1000',gross_sen:'10000',net_sen:'0' },
      { snapshot_id:'pricing-a',line_no:2,product_id:'regular',variant_id:null,
        category:'Historic drinks',subcategory:'Coffee',quantity_milli:'1000',gross_sen:'10000',net_sen:'10000' },
    ],rowCount:2 };
    if (sql.includes("data->>'category' AS category")) throw Error('Snapshot lines must not use current catalogue categories');
    throw Error(`Unexpected SQL: ${sql}`);
  });
  const result=await fx.routes.get('/api/companies/:company/analytics/operations')(fx.request);
  const products=new Map(result.productPerformance.map(row => [row.productId,row]));
  assert.deepEqual({ category:products.get('promo').category,net:products.get('promo').netLineSalesSen,
    subcategory:products.get('promo').subcategory,share:products.get('promo').shareBasisPoints },
  { category:'Historic offers',net:'0',subcategory:'Reward',share:0 });
  assert.deepEqual({ category:products.get('regular').category,net:products.get('regular').netLineSalesSen,
    subcategory:products.get('regular').subcategory,share:products.get('regular').shareBasisPoints },
  { category:'Historic drinks',net:'10000',subcategory:'Coffee',share:10000 });
  assert.deepEqual(result.categoryPerformance.map(row =>
    [row.category,row.subcategory,row.netLineSalesSen]),[
    ['Historic drinks','Coffee','10000'],['Historic offers','Reward','0'],
  ]);
  assert.equal(result.salesPerformance.current.dailyPerformance.length,9);
  assert.deepEqual(result.salesPerformance.current.dailyPerformance[0],
    { date:'2026-10-01',salesSen:'0',netSalesSen:'0',salesCount:0 });
  assert.equal(result.salesPerformance.current.dailyPerformance[2].salesSen,'10000');
  const snapshotCall=fx.calls.find(call => call.sql.includes('FROM myfin.pricing_snapshot_lines'));
  assert.deepEqual(snapshotCall.params,['company-a',['pricing-a'],20001]);
  assert.match(snapshotCall.sql,/s\.workspace_id=l\.workspace_id/);
});

test('snapshot evidence preserves snapshotless legacy sales in a mixed range', async () => {
  const fx=fixture('manager',async (sql,params) => {
    if (sql.includes('WITH period_orders') || sql.includes('WITH period_ledger') || sql.includes('WITH company_scope'))
      return { rows:[{}],rowCount:1 };
    if (sql.includes('FROM myfin.transactions')) {
      if (params[1]!=='2026-10-01') return { rows:[],rowCount:0 };
      return { rows:[
        { id:'priced-sale',pricing_snapshot_id:'pricing-a',document_state:'issued',business_date:'2026-10-03',
          total:'10',tax:'0',items:[{ productId:'priced',desc:'Priced',price:'10',qty:'1' }] },
        { id:'legacy-sale',document_state:'legacy',business_date:'2026-10-04',total:'5',tax:'0',
          items:[{ productId:'legacy',desc:'Legacy',price:'5',qty:'1',category:'Stored legacy' }] },
      ],rowCount:2 };
    }
    if (sql.includes('FROM myfin.pricing_snapshot_lines')) {
      assert.deepEqual(params,['company-a',['pricing-a'],20001]);
      return { rows:[{ snapshot_id:'pricing-a',line_no:1,product_id:'priced',variant_id:null,
        category:'Historic priced',subcategory:'Coffee',quantity_milli:'1000',gross_sen:'1000',net_sen:'1000' }],rowCount:1 };
    }
    if (sql.includes("data->>'category' AS category")) {
      assert.deepEqual(params,['company-a',['legacy']]);
      return { rows:[{ id:'legacy',category:'Current legacy',subcategory:'Fallback' }],rowCount:1 };
    }
    throw Error(`Unexpected SQL: ${sql}`);
  });
  const result=await fx.routes.get('/api/companies/:company/analytics/operations')(fx.request);
  const products=new Map(result.productPerformance.map(row => [row.productId,row]));
  assert.deepEqual({ category:products.get('priced').category,net:products.get('priced').netLineSalesSen },
    { category:'Historic priced',net:'1000' });
  assert.deepEqual({ category:products.get('legacy').category,net:products.get('legacy').netLineSalesSen },
    { category:'Stored legacy',net:'500' });
  assert.equal(result.salesPerformance.current.salesSen,'1500');
});

test('a referenced pricing snapshot fails closed when its immutable lines do not match the sale', async () => {
  const fx=fixture('manager',async (sql,params) => {
    if (sql.includes('WITH period_orders') || sql.includes('WITH period_ledger') || sql.includes('WITH company_scope'))
      return { rows:[{}],rowCount:1 };
    if (sql.includes('FROM myfin.transactions')) return { rows:[{ id:'sale',pricing_snapshot_id:'pricing-a',
      total:'10',tax:'0',items:[{ productId:'expected',desc:'Expected',price:'10',qty:'1' }] }],rowCount:1 };
    if (sql.includes('FROM myfin.pricing_snapshot_lines')) return { rows:[{
      snapshot_id:'pricing-a',line_no:1,product_id:'different',variant_id:null,
      category:'Historic',subcategory:'Mismatch',net_sen:'1000',
    }],rowCount:1 };
    if (sql.includes("data->>'category' AS category")) throw Error('Mismatched snapshots must not use mutable catalogue data');
    throw Error(`Unexpected SQL: ${sql} ${params}`);
  });
  await assert.rejects(
    fx.routes.get('/api/companies/:company/analytics/operations')(fx.request),
    error => error.statusCode===409 && error.message==='analytics_pricing_snapshot_mismatch',
  );
  assert.ok(!fx.calls.some(call => call.sql.includes("data->>'category' AS category")));
});

test('pricing evidence is capped before product catalogue aggregation', async () => {
  const fx=fixture('manager',async sql => {
    if (sql.includes('WITH period_orders') || sql.includes('WITH period_ledger') || sql.includes('WITH company_scope'))
      return { rows:[{}],rowCount:1 };
    if (sql.includes('FROM myfin.transactions')) return { rows:[{ id:'sale',pricing_snapshot_id:'pricing-a',
      total:'10',tax:'0',items:[{ productId:'p',desc:'P',price:'10',qty:'1' }] }],rowCount:1 };
    if (sql.includes('FROM myfin.pricing_snapshot_lines')) return { rows:[],rowCount:20001 };
    throw Error(`Unexpected SQL: ${sql}`);
  });
  await assert.rejects(
    fx.routes.get('/api/companies/:company/analytics/operations')(fx.request),
    error => error.statusCode===409 && error.message==='analytics_range_too_dense',
  );
  assert.ok(!fx.calls.some(call => call.sql.includes("data->>'category' AS category")));
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

test('owner cost coverage uses immutable discounted line net instead of gross proportions', async () => {
  const owner=fixture('workspace_owner',async sql => {
    if (sql.includes('FROM myfin.transactions')) return { rows:[{
      id:'priced-sale',pricing_snapshot_id:'pricing-a',total:'100',tax:'0',items:[
        { productId:'reward',desc:'Reward',price:'100',qty:'1' },
        { productId:'regular',desc:'Regular',price:'100',qty:'1',cost:'40' },
      ],
    }],rowCount:1 };
    if (sql.includes('FROM myfin.pricing_snapshot_lines')) return { rows:[
      { snapshot_id:'pricing-a',line_no:1,product_id:'reward',variant_id:null,
        category:'Offers',subcategory:'Reward',quantity_milli:'1000',gross_sen:'10000',net_sen:'0' },
      { snapshot_id:'pricing-a',line_no:2,product_id:'regular',variant_id:null,
        category:'Drinks',subcategory:'Coffee',quantity_milli:'1000',gross_sen:'10000',net_sen:'10000' },
    ],rowCount:2 };
    if (sql.includes('SELECT coalesce(sum(amount_sen)')) return { rows:[{ amount_sen:'0' }],rowCount:1 };
    if (sql.includes('SELECT count(*) FILTER')) return { rows:[{
      active_items:0,costed_items:0,inventory_value_sen:'0',
    }],rowCount:1 };
    throw Error(`Unexpected SQL: ${sql}`);
  });
  const result=await owner.routes.get('/api/companies/:company/analytics/cost-performance')(owner.request);
  assert.equal(result.coveredRevenueSen,'10000');
  assert.equal(result.recognizedCogsSen,'4000');
  assert.equal(result.recognizedGrossMarginSen,'6000');
  assert.equal(result.coverageBasisPoints,10000);
  assert.equal(result.complete,false);
});

test('snapshot product attribution excludes delivery and rounding while receipt totals and cost coverage stay exact', async () => {
  const owner=fixture('workspace_owner',async (sql,params) => {
    if (sql.includes('WITH period_orders') || sql.includes('WITH period_ledger') || sql.includes('WITH company_scope'))
      return { rows:[{}],rowCount:1 };
    if (sql.includes('FROM myfin.transactions')) {
      if (params[1]!=='2026-10-01') return { rows:[],rowCount:0 };
      return { rows:[{ id:'delivery-sale',pricing_snapshot_id:'pricing-delivery',document_state:'issued',
        business_date:'2026-10-03',total:'15',tax:'0',items:[
          { productId:'coffee',desc:'Coffee',price:'10',qty:'1',cost:'4' },
        ] }],rowCount:1 };
    }
    if (sql.includes('FROM myfin.pricing_snapshot_lines')) return { rows:[{
      snapshot_id:'pricing-delivery',line_no:1,product_id:'coffee',variant_id:null,
      category:'Drinks',subcategory:'Coffee',quantity_milli:'1000',gross_sen:'1000',net_sen:'1000',
    }],rowCount:1 };
    if (sql.includes('SELECT coalesce(sum(amount_sen)')) return { rows:[{ amount_sen:'0' }],rowCount:1 };
    if (sql.includes('SELECT count(*) FILTER')) return { rows:[{
      active_items:1,costed_items:1,inventory_value_sen:'400',
    }],rowCount:1 };
    throw Error(`Unexpected SQL: ${sql}`);
  });
  const operations=await owner.routes.get('/api/companies/:company/analytics/operations')(owner.request);
  assert.equal(operations.productPerformance[0].netLineSalesSen,'1000');
  assert.equal(operations.salesPerformance.current.netSalesSen,'1500');
  assert.equal(operations.salesPerformance.current.dailyPerformance[2].netSalesSen,'1500');
  const costs=await owner.routes.get('/api/companies/:company/analytics/cost-performance')(owner.request);
  assert.equal(costs.productPerformance[0].netLineSalesSen,'1000');
  assert.equal(costs.netSalesSen,'1500');
  assert.equal(costs.coveredRevenueSen,'1000');
  assert.equal(costs.coverageBasisPoints,10000);
  assert.equal(costs.complete,true);
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
