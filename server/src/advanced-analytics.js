import { z } from 'zod';
import * as v from './validation.js';
import { requireCapability } from './access.js';

const MAX_SALES_ROWS = 2000;
export const STUDENT_COHORT_THRESHOLD = 5;
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.strictObject({ from: isoDay, to: isoDay });

const validDay = value => Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString().slice(0, 10) === value;

export function advancedAnalyticsRange(query) {
  const value = v.parse(querySchema, query);
  const span = (Date.parse(value.to) - Date.parse(value.from)) / 86400000;
  // Inclusive ranges are capped at 366 calendar days.
  if (!validDay(value.from) || !validDay(value.to) || !Number.isInteger(span) || span < 0 || span > 365)
    v.fail(400, 'invalid_analytics_range');
  const toExclusive = new Date(Date.parse(value.to) + 86400000).toISOString().slice(0, 10);
  return { ...value, toExclusive };
}

function decimal(value) {
  const match = String(value ?? '').trim().match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const digits = BigInt(`${match[2]}${match[3] || ''}`) * (match[1] === '-' ? -1n : 1n);
  return { digits, scale: (match[3] || '').length };
}

function power10(value) { return 10n ** BigInt(value); }
function roundRatio(numerator, denominator) {
  if (denominator <= 0n) return null;
  const sign = numerator < 0n ? -1n : 1n, absolute = numerator < 0n ? -numerator : numerator;
  const quotient = absolute / denominator, remainder = absolute % denominator;
  return sign * (quotient + (remainder * 2n >= denominator ? 1n : 0n));
}

export function decimalToSen(value) {
  const parsed = decimal(value);
  return parsed ? roundRatio(parsed.digits * 100n, power10(parsed.scale)) : null;
}

export function lineAmountSen(money, quantity) {
  const price = decimal(money), units = decimal(quantity);
  if (!price || !units) return null;
  return roundRatio(price.digits * units.digits * 100n, power10(price.scale + units.scale));
}

const safeInt = value => {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
};
const safeText = (value, length = 160) => String(value || '').trim().slice(0, length);
const itemsFor = row => Array.isArray(row.items) ? row.items : [];

function percentageOfSen(amount, percentage) {
  const rate = decimal(percentage);
  if (!rate || rate.digits < 0n) return null;
  return roundRatio(amount * rate.digits, 100n * power10(rate.scale));
}

function allocate(total, weights) {
  const sign = total < 0n ? -1n : 1n, amount = total < 0n ? -total : total;
  const magnitudes = weights.map(weight => weight < 0n ? -weight : weight);
  const sum = magnitudes.reduce((value, weight) => value + weight, 0n);
  if (!sum) return weights.map(() => 0n);
  const parts = magnitudes.map((weight, index) => {
    const numerator = amount * weight;
    return { index, value: numerator / sum, remainder: numerator % sum };
  });
  let remainder = amount - parts.reduce((value, part) => value + part.value, 0n);
  for (const part of [...parts].sort((left, right) => left.remainder === right.remainder
    ? left.index - right.index : left.remainder > right.remainder ? -1 : 1)) {
    if (!remainder) break;
    part.value += 1n; remainder -= 1n;
  }
  return parts.sort((left, right) => left.index - right.index).map(part => part.value * sign);
}

function normalizedLine(item = {}) {
  const quantity = decimal(item.qty ?? item.quantity);
  const price = decimal(item.price ?? item.unitPrice ?? item.unit_price);
  if (!quantity || quantity.digits === 0n || !price || price.digits < 0n) return null;
  const quantityMilli = roundRatio(quantity.digits * 1000n, power10(quantity.scale));
  const grossSen = lineAmountSen(item.price ?? item.unitPrice ?? item.unit_price, item.qty ?? item.quantity);
  if (quantityMilli === null || quantityMilli === 0n || grossSen === null) return null;
  const hasCost = Object.prototype.hasOwnProperty.call(item, 'cost')
    || Object.prototype.hasOwnProperty.call(item, 'unitCost')
    || Object.prototype.hasOwnProperty.call(item, 'unit_cost');
  const rawCost = item.cost ?? item.unitCost ?? item.unit_cost;
  const unitCost = hasCost ? decimal(rawCost) : null;
  const costSen = unitCost && unitCost.digits >= 0n
    ? lineAmountSen(rawCost, item.qty ?? item.quantity) : null;
  return {
    productId: safeText(item.productId ?? item.product_id, 128),
    sku: safeText(item.sku, 120), description: safeText(item.desc ?? item.description, 160) || 'Unlabelled item',
    quantityMilli, grossSen,
    costSen,
  };
}

export function analyzeSalesRows(rows = []) {
  let salesSen = 0n, taxSen = 0n, netSalesSen = 0n, coveredRevenueSen = 0n, recognizedCogsSen = 0n;
  let coverageRevenueSen = 0n, coveredRevenueMagnitudeSen = 0n;
  let salesLineCount = 0, costedSalesLineCount = 0, fullyCostedSalesCount = 0, salesWithoutUsableLines = 0;
  const products = new Map();
  for (const row of rows) {
    const total = decimalToSen(row.total) ?? 0n;
    const lines = itemsFor(row).map(normalizedLine).filter(Boolean);
    let tax = decimalToSen(row.tax);
    // Match the legacy reporting rule for migrated invoices that carry a rate
    // but no explicit tax field. Current receipts always snapshot tax.
    if (tax === null && row.document_state === 'legacy') {
      const gross = lines.reduce((value,line)=>value+line.grossSen,0n);
      const explicitSubtotal = decimalToSen(row.subtotal), subtotal = explicitSubtotal ?? gross;
      const explicitDiscount = decimalToSen(row.discount_amount);
      const percentageDiscount = explicitDiscount === null ? percentageOfSen(subtotal,row.discount) : null;
      const discount = explicitDiscount ?? percentageDiscount ?? 0n, taxable = subtotal > discount ? subtotal-discount : 0n;
      const calculated = percentageOfSen(taxable,row.tax_rate);
      if (calculated !== null) {
        const reconciled = total-taxable;
        tax = reconciled >= 0n && (reconciled-calculated <= 1n && calculated-reconciled <= 1n)
          ? reconciled : calculated;
      }
    }
    tax ??= 0n;
    const net = total - tax;
    salesSen += total; taxSen += tax; netSalesSen += net;
    coverageRevenueSen += net < 0n ? -net : net;
    if (!lines.length) { if (net) salesWithoutUsableLines += 1; continue; }
    const allocation = allocate(net, lines.map(line => line.grossSen));
    let fullyCosted = true;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]; salesLineCount += 1;
      if (line.costSen === null) fullyCosted = false;
      else {
        costedSalesLineCount += 1;
        coveredRevenueSen += allocation[index];
        coveredRevenueMagnitudeSen += allocation[index] < 0n ? -allocation[index] : allocation[index];
        recognizedCogsSen += line.costSen;
      }
      const key = line.productId ? `product:${line.productId}`
        : line.sku ? `sku:${line.sku.toLocaleLowerCase('en-US')}`
          : `description:${line.description.toLocaleLowerCase('en-US')}`;
      const current = products.get(key) || { productId:line.productId, sku:line.sku,
        description:line.description, quantityMilli:0n, grossLineSalesSen:0n, saleIds:new Set() };
      current.quantityMilli += line.quantityMilli; current.grossLineSalesSen += line.grossSen;
      current.saleIds.add(String(row.id || '')); products.set(key, current);
    }
    if (fullyCosted) fullyCostedSalesCount += 1;
  }
  const missingCostLineCount = salesLineCount - costedSalesLineCount;
  const complete = missingCostLineCount === 0 && salesWithoutUsableLines === 0;
  const coverageBasisPoints = coverageRevenueSen > 0n
    ? Number((coveredRevenueMagnitudeSen * 10000n + coverageRevenueSen / 2n) / coverageRevenueSen)
    : salesLineCount ? Math.round(costedSalesLineCount * 10000 / salesLineCount) : 0;
  const productPerformance = [...products.values()]
    .sort((left, right) => left.grossLineSalesSen === right.grossLineSalesSen
      ? left.description.localeCompare(right.description, 'en')
      : left.grossLineSalesSen > right.grossLineSalesSen ? -1 : 1)
    .slice(0, 20).map(({ saleIds, quantityMilli, grossLineSalesSen, ...row }) => ({
      ...row, quantityMilli:quantityMilli.toString(), grossLineSalesSen:grossLineSalesSen.toString(),
      saleCount:saleIds.size,
    }));
  return {
    salesSen:salesSen.toString(), taxSen:taxSen.toString(), netSalesSen:netSalesSen.toString(),
    coveredRevenueSen:coveredRevenueSen.toString(), recognizedCogsSen:recognizedCogsSen.toString(),
    recognizedGrossMarginSen:(coveredRevenueSen-recognizedCogsSen).toString(),
    salesCount:rows.length, fullyCostedSalesCount, salesLineCount, costedSalesLineCount,
    missingCostLineCount, salesWithoutUsableLines, coverageBasisPoints, complete, productPerformance,
  };
}

export function financialPerformance(rows, expenseSen = '0') {
  const sales = analyzeSalesRows(rows), expenses = BigInt(String(expenseSen || '0'));
  const completeGrossMargin = sales.complete
    ? BigInt(sales.netSalesSen) - BigInt(sales.recognizedCogsSen) : null;
  return {
    ...sales, operatingExpensesSen:expenses.toString(),
    grossMarginSen:completeGrossMargin === null ? null : completeGrossMargin.toString(),
    operatingContributionSen:completeGrossMargin === null ? null : (completeGrossMargin-expenses).toString(),
    accountingBasis:'Recorded sales less recorded tax, item cost snapshots and recorded expenses.',
    limitation:sales.complete
      ? 'All usable sales lines in this range have a cost snapshot. This operating contribution is not statutory profit and excludes unrecorded liabilities, payroll, depreciation and tax adjustments.'
      : 'Some sales lack item cost snapshots. Recognized COGS and gross margin cover only costed lines; complete gross margin and operating contribution are withheld to avoid overstating profit.',
  };
}

export function studentAggregate(row = {}) {
  const eligible = safeInt(row.eligible_customer_count), active = safeInt(row.active_customer_count);
  const suppress = (cohort, values) => cohort < STUDENT_COHORT_THRESHOLD
    ? { suppressed:true, cohortThreshold:STUDENT_COHORT_THRESHOLD }
    : { suppressed:false, cohortThreshold:STUDENT_COHORT_THRESHOLD, cohortSize:cohort, ...values };
  const promotionRows = Array.isArray(row.promotion_rows) ? row.promotion_rows : [];
  return {
    enrollment:suppress(eligible, { verifiedCustomers:eligible }),
    activity:suppress(active, {
      participatingCustomers:active, pricedOrderCount:safeInt(row.priced_order_count),
      subtotalSen:String(row.subtotal_sen || '0'), discountSen:String(row.discount_sen || '0'),
      redemptionCount:safeInt(row.redemption_count),
    }),
    promotions:promotionRows.map(item => {
      const cohort = safeInt(item.customerCount ?? item.customer_count);
      return cohort < STUDENT_COHORT_THRESHOLD
        ? { promotionId:safeText(item.promotionId ?? item.promotion_id,128),
          name:safeText(item.name,160), suppressed:true, cohortThreshold:STUDENT_COHORT_THRESHOLD }
        : { promotionId:safeText(item.promotionId ?? item.promotion_id,128), name:safeText(item.name,160),
          suppressed:false, cohortThreshold:STUDENT_COHORT_THRESHOLD, participatingCustomers:cohort,
          redemptions:safeInt(item.redemptions), discountSen:String(item.discountSen ?? item.discount_sen ?? '0') };
    }),
    basis:'Student metrics use verified company-linked customers and immutable student pricing/redemption evidence in the selected range.',
  };
}

const salesDate = `(CASE
  WHEN data->>'businessDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN data->>'businessDate'
  WHEN issued_at IS NOT NULL THEN to_char(issued_at AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY-MM-DD')
  WHEN left(data->>'date',10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN left(data->>'date',10)
  ELSE NULL END)`;
const salesRelevant = `(source='pos' OR (document_state='issued' AND data->>'type'='Invoice') OR
  (document_state='legacy' AND data->>'type'='Invoice' AND data->>'status' IN ('Pending','Paid','Cleared','Partially paid')))`;
const SALES_SQL = `SELECT id,total,source,document_state,
    coalesce(issued_snapshot->>'tax',data->>'tax') AS tax,
    data->>'taxRate' AS tax_rate,data->>'subtotal' AS subtotal,
    data->>'discountAmount' AS discount_amount,data->>'discount' AS discount,
    CASE WHEN jsonb_typeof(issued_snapshot->'items')='array' THEN issued_snapshot->'items'
         WHEN jsonb_typeof(data->'items')='array' THEN data->'items' ELSE '[]'::jsonb END AS items
  FROM myfin.transactions WHERE company_id=$1 AND ${salesRelevant}
    AND ${salesDate} BETWEEN $2 AND $3
  ORDER BY ${salesDate},id LIMIT $4`;

async function salesRows(c, companyId, from, to) {
  const result = await c.query(SALES_SQL, [companyId, from, to, MAX_SALES_ROWS + 1]);
  if (result.rowCount > MAX_SALES_ROWS) v.fail(409, 'analytics_range_too_dense');
  return result.rows;
}

const ORDER_SQL = `WITH period_orders AS (
    SELECT status,payment_state,customer_id,total,created_at,accepted_at
      FROM myfin.customer_order_requests
     WHERE company_id=$1 AND created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
       AND created_at < ($3::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
  ), repeat_customers AS (
    SELECT customer_id FROM period_orders WHERE customer_id IS NOT NULL GROUP BY customer_id HAVING count(*)>1
  ) SELECT count(*)::integer AS total_orders,
    count(*) FILTER(WHERE status='awaiting_acceptance')::integer AS awaiting_acceptance,
    count(*) FILTER(WHERE status='accepted')::integer AS accepted,
    count(*) FILTER(WHERE status='preparing')::integer AS preparing,
    count(*) FILTER(WHERE status='ready')::integer AS ready,
    count(*) FILTER(WHERE status='cancelled')::integer AS cancelled,
    count(*) FILTER(WHERE status='expired')::integer AS expired,
    count(*) FILTER(WHERE status='paid')::integer AS paid,
    count(*) FILTER(WHERE customer_id IS NULL)::integer AS guest_orders,
    count(*) FILTER(WHERE customer_id IS NOT NULL)::integer AS account_orders,
    count(DISTINCT customer_id)::integer AS registered_customers,
    (SELECT count(*)::integer FROM repeat_customers) AS repeat_customers,
    coalesce(round(sum(total)*100),0)::bigint AS submitted_demand_value_sen,
    coalesce(round(avg(total)*100),0)::bigint AS submitted_average_order_sen,
    coalesce(round(sum(total) FILTER(WHERE payment_state='paid')*100),0)::bigint AS paid_order_value_sen,
    coalesce(round(avg(total) FILTER(WHERE payment_state='paid')*100),0)::bigint AS paid_average_order_sen,
    round(avg(extract(epoch FROM (accepted_at-created_at))/60)
      FILTER(WHERE accepted_at IS NOT NULL))::integer AS average_acceptance_minutes
  FROM period_orders`;

const INVENTORY_SQL = `WITH period_ledger AS (
    SELECT item_id,kind,abs(delta) AS quantity FROM myfin.stock_ledger
     WHERE company_id=$1 AND created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
       AND created_at < ($3::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
  ), top_waste AS (
    SELECT l.item_id,i.name,i.base_unit,sum(l.quantity) AS quantity,count(*)::integer AS movements
      FROM period_ledger l JOIN myfin.stock_items i ON i.company_id=$1 AND i.id=l.item_id
     WHERE l.kind='waste' GROUP BY l.item_id,i.name,i.base_unit ORDER BY sum(l.quantity) DESC,l.item_id LIMIT 20
  ), top_receipts AS (
    SELECT l.item_id,i.name,i.base_unit,sum(l.quantity) AS quantity,count(*)::integer AS movements
      FROM period_ledger l JOIN myfin.stock_items i ON i.company_id=$1 AND i.id=l.item_id
     WHERE l.kind='receive' GROUP BY l.item_id,i.name,i.base_unit ORDER BY sum(l.quantity) DESC,l.item_id LIMIT 20
  ) SELECT count(*)::integer AS movement_count,
    count(*) FILTER(WHERE kind='receive')::integer AS receive_count,
    count(*) FILTER(WHERE kind='count')::integer AS count_count,
    count(*) FILTER(WHERE kind='adjust')::integer AS adjust_count,
    count(*) FILTER(WHERE kind='consume')::integer AS consume_count,
    count(*) FILTER(WHERE kind='waste')::integer AS waste_count,
    (SELECT count(*)::integer FROM myfin.goods_receipts gr WHERE gr.company_id=$1
      AND gr.received_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
      AND gr.received_at < ($3::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')) AS receipt_documents,
    (SELECT count(*)::integer FROM myfin.goods_receipts gr JOIN myfin.goods_receipt_reversals rv
      ON rv.company_id=gr.company_id AND rv.goods_receipt_id=gr.id WHERE gr.company_id=$1
      AND gr.received_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
      AND gr.received_at < ($3::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')) AS reversed_receipts,
    (SELECT count(*)::integer FROM myfin.low_stock_alerts WHERE company_id=$1 AND status='open') AS open_low_stock,
    (SELECT count(*)::integer FROM myfin.low_stock_alerts WHERE company_id=$1 AND status='acknowledged') AS acknowledged_low_stock,
    coalesce((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.quantity DESC,w.item_id) FROM top_waste w),'[]') AS waste_items,
    coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.quantity DESC,r.item_id) FROM top_receipts r),'[]') AS received_items
  FROM period_ledger`;

const STUDENT_SQL = `WITH company_scope AS (
    SELECT workspace_id FROM myfin.companies WHERE id=$1
  ), eligible AS (
    SELECT count(*)::integer AS customer_count FROM myfin.student_eligibilities e
      JOIN company_scope scope ON scope.workspace_id=e.workspace_id
      JOIN myfin.customer_company_links link ON link.company_id=$1 AND link.customer_id=e.customer_id
     WHERE e.status='verified' AND e.valid_from<=now() AND e.valid_until>now()
  ), activity AS (
    SELECT ps.customer_id,ps.subtotal_sen,ps.discount_sen FROM myfin.pricing_snapshots ps
     WHERE ps.company_id=$1 AND ps.student_eligibility_version IS NOT NULL AND ps.customer_id IS NOT NULL
       AND priced_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
       AND priced_at < ($3::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
       AND (EXISTS(SELECT 1 FROM myfin.transactions t WHERE t.company_id=ps.company_id
              AND t.pricing_snapshot_id=ps.id AND (t.source='pos' OR
                (t.document_state IN ('issued','legacy') AND t.data->>'type'='Invoice'))) OR
            EXISTS(SELECT 1 FROM myfin.customer_order_requests o WHERE o.company_id=ps.company_id
              AND o.pricing_snapshot_id=ps.id AND o.status='paid'))
  ), redemptions AS (
    SELECT count(*)::integer AS redemption_count FROM myfin.promotion_redemptions r
      JOIN myfin.promotion_versions pv ON pv.workspace_id=r.workspace_id AND pv.company_id=r.company_id
       AND pv.promotion_id=r.promotion_id AND pv.version=r.promotion_version
     WHERE r.company_id=$1 AND pv.requires_student
       AND r.occurred_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
       AND r.occurred_at < ($3::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
  ), promotion_groups AS (
    SELECT r.promotion_id,pv.name,count(DISTINCT r.customer_id)::integer AS customer_count,
      count(*)::integer AS redemptions,sum(r.discount_sen)::bigint AS discount_sen
      FROM myfin.promotion_redemptions r JOIN myfin.promotion_versions pv
        ON pv.workspace_id=r.workspace_id AND pv.company_id=r.company_id
       AND pv.promotion_id=r.promotion_id AND pv.version=r.promotion_version
     WHERE r.company_id=$1 AND pv.requires_student
       AND r.occurred_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
       AND r.occurred_at < ($3::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
     GROUP BY r.promotion_id,pv.name ORDER BY sum(r.discount_sen) DESC,r.promotion_id LIMIT 20
  ) SELECT (SELECT customer_count FROM eligible) AS eligible_customer_count,
    count(DISTINCT customer_id)::integer AS active_customer_count,count(*)::integer AS priced_order_count,
    coalesce(sum(subtotal_sen),0)::bigint AS subtotal_sen,
    coalesce(sum(discount_sen),0)::bigint AS discount_sen,
    (SELECT redemption_count FROM redemptions) AS redemption_count,
    coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.discount_sen DESC,p.promotion_id) FROM promotion_groups p),'[]') AS promotion_rows
  FROM activity`;

const EXPENSE_SQL = `SELECT coalesce(sum(amount_sen),0)::bigint AS amount_sen FROM (
    SELECT round(amount*100)::bigint AS amount_sen FROM myfin.expenses
     WHERE company_id=$1 AND voided_at IS NULL
       AND left(data->>'date',10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       AND left(data->>'date',10) BETWEEN $2 AND $3
    UNION ALL
    SELECT round(total*100)::bigint FROM myfin.transactions
     WHERE company_id=$1 AND document_state='legacy' AND data->>'type' IN ('Expense','Payment Voucher')
       AND coalesce(data->>'status','')<>'Voided'
       AND left(data->>'date',10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       AND left(data->>'date',10) BETWEEN $2 AND $3
  ) expenses`;

function orderOutput(row = {}) {
  const total = safeInt(row.total_orders);
  const paidOrderValueSen = String(row.paid_order_value_sen || '0');
  const paidAverageOrderSen = String(row.paid_average_order_sen || '0');
  return {
    total, statuses:{ submitted:safeInt(row.awaiting_acceptance), accepted:safeInt(row.accepted),
      preparing:safeInt(row.preparing), ready:safeInt(row.ready), cancelled:safeInt(row.cancelled),
      expired:safeInt(row.expired), paid:safeInt(row.paid) },
    submittedDemandValueSen:String(row.submitted_demand_value_sen || '0'),
    submittedAverageOrderSen:String(row.submitted_average_order_sen || '0'),
    paidOrderValueSen, paidAverageOrderSen,
    // Compatibility aliases keep an older UI accurate during a rolling deployment.
    orderValueSen:paidOrderValueSen, averageOrderSen:paidAverageOrderSen,
    averageAcceptanceMinutes:row.average_acceptance_minutes === null || row.average_acceptance_minutes === undefined
      ? null : Number(row.average_acceptance_minutes),
  };
}

function customerOutput(row = {}) {
  const accountOrders = safeInt(row.account_orders), registeredCustomers = safeInt(row.registered_customers);
  return { guestOrders:safeInt(row.guest_orders), accountOrders, registeredCustomers,
    repeatCustomers:safeInt(row.repeat_customers),
    repeatRateBasisPoints:registeredCustomers
      ? Math.round(safeInt(row.repeat_customers) * 10000 / registeredCustomers) : 0 };
}

function stockItems(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 20).map(row => ({
    itemId:safeText(row.item_id,128), name:safeText(row.name,120), baseUnit:safeText(row.base_unit,32),
    quantity:String(row.quantity || '0'), movements:safeInt(row.movements),
  }));
}

function inventoryOutput(row = {}) {
  return {
    movementCount:safeInt(row.movement_count), movementsByKind:{ receive:safeInt(row.receive_count),
      count:safeInt(row.count_count), adjust:safeInt(row.adjust_count), consume:safeInt(row.consume_count),
      waste:safeInt(row.waste_count) },
    procurementReceipts:safeInt(row.receipt_documents), reversedProcurementReceipts:safeInt(row.reversed_receipts),
    lowStock:{ open:safeInt(row.open_low_stock), acknowledged:safeInt(row.acknowledged_low_stock) },
    wasteItems:stockItems(row.waste_items), receivedItems:stockItems(row.received_items),
    basis:'Quantities stay grouped by stock item and base unit. Receipt counts include procurement receipt documents; reversed receipts remain visible as audit evidence.',
  };
}

export function registerAdvancedAnalytics(app, { scoped }) {
  app.get('/api/companies/:company/analytics/operations', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'financialReports');
    const { from, to, toExclusive } = advancedAnalyticsRange(req.query);
    const [orders, inventory, student, sales] = await Promise.all([
      c.query(ORDER_SQL,[companyId,from,toExclusive]),
      c.query(INVENTORY_SQL,[companyId,from,toExclusive]),
      c.query(STUDENT_SQL,[companyId,from,toExclusive]),
      salesRows(c,companyId,from,to),
    ]);
    const order = orders.rows[0] || {}, saleMetrics = analyzeSalesRows(sales);
    return { from,to,orders:orderOutput(order),customers:customerOutput(order),
      productPerformance:saleMetrics.productPerformance,student:studentAggregate(student.rows[0]),
      inventory:inventoryOutput(inventory.rows[0]),
      coverage:{
        orders:'Online order requests created in the selected range. Submitted demand includes later cancellations and expiries; paid value includes only paid requests. POS walk-ins and manually issued invoices are outside customer/order aggregates.',
        products:'Issued POS and invoice lines with valid business or issue dates. Values are gross line sales before transaction-level discount, tax and rounding.',
        students:'Student activity appears only when immutable student pricing or redemption evidence exists. Small cohorts are suppressed.',
      } };
  }));

  app.get('/api/companies/:company/analytics/cost-performance', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'financialReports');
    requireCapability(req.identity, 'costsRead');
    const { from, to } = advancedAnalyticsRange(req.query);
    const [sales,expenses] = await Promise.all([
      salesRows(c,companyId,from,to), c.query(EXPENSE_SQL,[companyId,from,to]),
    ]);
    return { from,to,...financialPerformance(sales,expenses.rows[0]?.amount_sen || '0') };
  }));
}
