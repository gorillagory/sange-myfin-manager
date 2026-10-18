import { z } from 'zod';
import * as v from './validation.js';
import { requireCapability } from './access.js';

const MAX_SALES_ROWS = 2000;
const MAX_PRICING_LINES = 20000;
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
const SNAPSHOT_EVIDENCE = Symbol('analyticsPricingSnapshotEvidence');

function exactInteger(value) {
  const text = String(value ?? '').trim();
  return /^[+-]?\d+$/.test(text) ? BigInt(text) : null;
}

function percentageOfSen(amount, percentage) {
  const rate = decimal(percentage);
  if (!rate || rate.digits < 0n) return null;
  return roundRatio(amount * rate.digits, 100n * power10(rate.scale));
}

function allocate(total, weights) {
  const signedSum = weights.reduce((value, weight) => value + weight, 0n);
  if (signedSum === total) return [...weights];
  if (signedSum && ((signedSum > 0n && total >= 0n) || (signedSum < 0n && total <= 0n))) {
    const denominator=signedSum < 0n ? -signedSum : signedSum;
    const parts=weights.map((weight,index) => {
      const scaled=total*weight*(signedSum < 0n ? -1n : 1n);
      let value=scaled/denominator,remainder=scaled%denominator;
      if (remainder<0n) { value-=1n; remainder+=denominator; }
      return { index,value,remainder };
    });
    let remainder=total-parts.reduce((value,part) => value+part.value,0n);
    for (const part of [...parts].sort((left,right) => left.remainder===right.remainder
      ? left.index-right.index : left.remainder>right.remainder ? -1 : 1)) {
      if (!remainder) break;
      part.value+=1n; remainder-=1n;
    }
    return parts.sort((left,right) => left.index-right.index).map(part => part.value);
  }
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
  const evidence = item[SNAPSHOT_EVIDENCE];
  return {
    productId: safeText(item.productId ?? item.product_id, 128),
    sku: safeText(item.sku, 120), description: safeText(item.desc ?? item.description, 160) || 'Unlabelled item',
    category:evidence ? safeText(evidence.category,120) || 'Uncategorized'
      : safeText(item.category,120) || 'Uncategorized',
    subcategory:evidence ? safeText(evidence.subcategory,120) : safeText(item.subcategory,120),
    quantityMilli, grossSen, snapshotNetSen:evidence ? evidence.netSen : null,
    allocationWeightSen:evidence?.netSen ?? grossSen,
    costSen,
  };
}

function signedChangeBasisPoints(current, previous) {
  const baseline = previous < 0n ? -previous : previous;
  if (!baseline) return null;
  const change = roundRatio((current - previous) * 10000n, baseline);
  if (change === null) return null;
  const limit = 1000000000n;
  return Number(change > limit ? limit : change < -limit ? -limit : change);
}

export function analyzeSalesRows(rows = []) {
  let salesSen = 0n, taxSen = 0n, netSalesSen = 0n, coveredRevenueSen = 0n, recognizedCogsSen = 0n;
  let coverageRevenueSen = 0n, coveredRevenueMagnitudeSen = 0n;
  let salesLineCount = 0, costedSalesLineCount = 0, fullyCostedSalesCount = 0, salesWithoutUsableLines = 0;
  let unitsSoldMilli = 0n;
  const products = new Map(), categories = new Map(), days = new Map();
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
    const deliveryFee=decimalToSen(row.delivery_fee) ?? 0n;
    const rounding=decimalToSen(row.rounding) ?? 0n;
    const receiptProductNet=net-deliveryFee-rounding;
    salesSen += total; taxSen += tax; netSalesSen += net;
    const businessDate = safeText(row.business_date,10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      const day = days.get(businessDate) || { date:businessDate,salesSen:0n,netSalesSen:0n,salesCount:0 };
      day.salesSen += total; day.netSalesSen += net; day.salesCount += 1; days.set(businessDate,day);
    }
    const snapshotNetAvailable=lines.length>0&&lines.every(line=>line.snapshotNetSen!==null);
    const attributableNet=snapshotNetAvailable
      ? lines.reduce((value,line)=>value+line.snapshotNetSen,0n) : receiptProductNet;
    coverageRevenueSen += attributableNet < 0n ? -attributableNet : attributableNet;
    if (!lines.length) { if (net) salesWithoutUsableLines += 1; continue; }
    const allocation = snapshotNetAvailable
      ? lines.map(line=>line.snapshotNetSen)
      : allocate(receiptProductNet, lines.map(line => line.allocationWeightSen));
    let fullyCosted = true;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]; salesLineCount += 1;
      unitsSoldMilli += line.quantityMilli;
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
        description:line.description, category:line.category, subcategory:line.subcategory,
        quantityMilli:0n, grossLineSalesSen:0n, netLineSalesSen:0n, saleIds:new Set() };
      current.quantityMilli += line.quantityMilli; current.grossLineSalesSen += line.grossSen;
      current.netLineSalesSen += allocation[index];
      current.saleIds.add(String(row.id || '')); products.set(key, current);
      const categoryKey = `${line.category.toLocaleLowerCase('en-US')}\u0000${line.subcategory.toLocaleLowerCase('en-US')}`;
      const category = categories.get(categoryKey) || { category:line.category,subcategory:line.subcategory,
        quantityMilli:0n,grossLineSalesSen:0n,netLineSalesSen:0n,saleIds:new Set() };
      category.quantityMilli += line.quantityMilli; category.grossLineSalesSen += line.grossSen;
      category.netLineSalesSen += allocation[index]; category.saleIds.add(String(row.id || ''));
      categories.set(categoryKey,category);
    }
    if (fullyCosted) fullyCostedSalesCount += 1;
  }
  const missingCostLineCount = salesLineCount - costedSalesLineCount;
  const complete = missingCostLineCount === 0 && salesWithoutUsableLines === 0;
  const coverageBasisPoints = coverageRevenueSen > 0n
    ? Number((coveredRevenueMagnitudeSen * 10000n + coverageRevenueSen / 2n) / coverageRevenueSen)
    : salesLineCount ? Math.round(costedSalesLineCount * 10000 / salesLineCount) : 0;
  const positiveProductNet = [...products.values()].reduce((sum,row) =>
    sum + (row.netLineSalesSen > 0n ? row.netLineSalesSen : 0n),0n);
  const performanceRow = ({ saleIds, quantityMilli, grossLineSalesSen, netLineSalesSen, ...row }, index) => ({
    ...row, rank:index+1, quantityMilli:quantityMilli.toString(),
    grossLineSalesSen:grossLineSalesSen.toString(), netLineSalesSen:netLineSalesSen.toString(),
    contributionType:netLineSalesSen < 0n ? 'return' : netLineSalesSen > 0n ? 'sale' : 'neutral',
    shareBasisPoints:positiveProductNet && netLineSalesSen > 0n
      ? Number((netLineSalesSen * 10000n + positiveProductNet / 2n) / positiveProductNet)
      : 0,
    saleCount:saleIds.size,
  });
  const productPerformance = [...products.values()]
    .sort((left, right) => left.netLineSalesSen === right.netLineSalesSen
      ? left.description.localeCompare(right.description, 'en')
      : left.netLineSalesSen > right.netLineSalesSen ? -1 : 1)
    .slice(0, 20).map(performanceRow);
  const categoryPerformance = [...categories.values()]
    .sort((left,right) => left.netLineSalesSen === right.netLineSalesSen
      ? `${left.category}/${left.subcategory}`.localeCompare(`${right.category}/${right.subcategory}`,'en')
      : left.netLineSalesSen > right.netLineSalesSen ? -1 : 1)
    .slice(0,20).map(({ saleIds,quantityMilli,grossLineSalesSen,netLineSalesSen,...row }) => ({
      ...row,quantityMilli:quantityMilli.toString(),grossLineSalesSen:grossLineSalesSen.toString(),
      netLineSalesSen:netLineSalesSen.toString(),saleCount:saleIds.size,
    }));
  const dailyPerformance = [...days.values()].sort((left,right)=>left.date.localeCompare(right.date)).map(day => ({
    date:day.date,salesSen:day.salesSen.toString(),netSalesSen:day.netSalesSen.toString(),salesCount:day.salesCount,
  }));
  return {
    salesSen:salesSen.toString(), taxSen:taxSen.toString(), netSalesSen:netSalesSen.toString(),
    coveredRevenueSen:coveredRevenueSen.toString(), recognizedCogsSen:recognizedCogsSen.toString(),
    recognizedGrossMarginSen:(coveredRevenueSen-recognizedCogsSen).toString(),
    salesCount:rows.length,averageSaleSen:rows.length ? roundRatio(salesSen,BigInt(rows.length)).toString() : '0',
    unitsSoldMilli:unitsSoldMilli.toString(),distinctProductCount:products.size,
    fullyCostedSalesCount, salesLineCount, costedSalesLineCount,
    missingCostLineCount, salesWithoutUsableLines, coverageBasisPoints, complete, productPerformance,
    categoryPerformance,dailyPerformance,
  };
}

export function dailyPerformanceForRange(dailyPerformance = [], from, to) {
  const start = Date.parse(from), end = Date.parse(to);
  if (!validDay(from) || !validDay(to) || end < start || end-start > 365*86400000)
    throw new TypeError('invalid_analytics_range');
  const recorded = new Map((Array.isArray(dailyPerformance) ? dailyPerformance : [])
    .filter(day => validDay(day?.date)).map(day => [day.date,day]));
  const complete = [];
  for (let stamp = start; stamp <= end; stamp += 86400000) {
    const date = new Date(stamp).toISOString().slice(0,10), day = recorded.get(date);
    complete.push(day || { date,salesSen:'0',netSalesSen:'0',salesCount:0 });
  }
  return complete;
}

export function compareSalesPerformance(currentRows = [], previousRows = [], range = null) {
  let current = analyzeSalesRows(currentRows);
  const previous = analyzeSalesRows(previousRows);
  if (range?.from && range?.to) current = { ...current,
    dailyPerformance:dailyPerformanceForRange(current.dailyPerformance,range.from,range.to) };
  const currentSales = BigInt(current.salesSen), previousSales = BigInt(previous.salesSen);
  const currentCount = BigInt(current.salesCount), previousCount = BigInt(previous.salesCount);
  const currentUnits = BigInt(current.unitsSoldMilli), previousUnits = BigInt(previous.unitsSoldMilli);
  return {
    current:{ salesSen:current.salesSen,netSalesSen:current.netSalesSen,salesCount:current.salesCount,
      averageSaleSen:current.averageSaleSen,unitsSoldMilli:current.unitsSoldMilli,
      distinctProductCount:current.distinctProductCount,dailyPerformance:current.dailyPerformance },
    previous:{ salesSen:previous.salesSen,netSalesSen:previous.netSalesSen,salesCount:previous.salesCount,
      averageSaleSen:previous.averageSaleSen,unitsSoldMilli:previous.unitsSoldMilli },
    change:{ salesBasisPoints:signedChangeBasisPoints(currentSales,previousSales),
      transactionBasisPoints:signedChangeBasisPoints(currentCount,previousCount),
      unitsBasisPoints:signedChangeBasisPoints(currentUnits,previousUnits) },
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
const salesRelevant = `(source IN ('pos','manual_sale') OR (document_state='issued' AND data->>'type'='Invoice') OR
  (document_state='legacy' AND data->>'type'='Invoice' AND data->>'status' IN ('Pending','Paid','Cleared','Partially paid')))`;
const SALES_SQL = `SELECT id,total,source,document_state,pricing_snapshot_id,${salesDate} AS business_date,
    coalesce(issued_snapshot->>'tax',data->>'tax') AS tax,
    data->>'taxRate' AS tax_rate,data->>'subtotal' AS subtotal,
    data->>'discountAmount' AS discount_amount,data->>'discount' AS discount,
    coalesce(issued_snapshot->>'deliveryFee',data->>'deliveryFee') AS delivery_fee,
    coalesce(issued_snapshot->>'rounding',data->>'rounding') AS rounding,
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

async function attachPricingSnapshotEvidence(c, companyId, rows) {
  const snapshotIds=[...new Set(rows.map(row => safeText(row.pricing_snapshot_id,128)).filter(Boolean))].sort();
  if (!snapshotIds.length) return rows;
  const result=await c.query(`SELECT l.snapshot_id,l.line_no,l.product_id,l.variant_id,
      l.category,l.subcategory,l.quantity_milli,l.gross_sen,l.net_sen
    FROM myfin.pricing_snapshot_lines l
    JOIN myfin.pricing_snapshots s ON s.workspace_id=l.workspace_id
      AND s.company_id=l.company_id AND s.id=l.snapshot_id
    WHERE s.company_id=$1 AND s.id=ANY($2::text[])
    ORDER BY l.snapshot_id,l.line_no LIMIT $3`,[companyId,snapshotIds,MAX_PRICING_LINES+1]);
  if (result.rowCount>MAX_PRICING_LINES) v.fail(409,'analytics_range_too_dense');
  const bySnapshot=new Map();
  for (const line of result.rows) {
    const id=String(line.snapshot_id), group=bySnapshot.get(id) || [];
    group.push(line); bySnapshot.set(id,group);
  }
  return rows.map(row => {
    const snapshotId=safeText(row.pricing_snapshot_id,128), items=itemsFor(row);
    if (!snapshotId) return row;
    const lines=bySnapshot.get(snapshotId);
    const usable=lines?.length===items.length && lines.every((line,index) => {
      const item=items[index],normalized=normalizedLine(item);
      return Number(line.line_no)===index+1
        && safeText(line.product_id,128)===safeText(item.productId ?? item.product_id,128)
        && safeText(line.variant_id,128)===safeText(item.variantId ?? item.variant_id,128)
        && exactInteger(line.quantity_milli)===normalized?.quantityMilli
        && exactInteger(line.gross_sen)===normalized?.grossSen
        && exactInteger(line.net_sen)!==null;
    });
    if (!usable) v.fail(409,'analytics_pricing_snapshot_mismatch');
    return { ...row,items:items.map((item,index) => ({ ...item,
      [SNAPSHOT_EVIDENCE]:{ category:lines[index].category,subcategory:lines[index].subcategory,
        netSen:exactInteger(lines[index].net_sen) },
    })) };
  });
}

async function classifySalesRows(c, companyId, rows) {
  const withSnapshots=await attachPricingSnapshotEvidence(c,companyId,rows);
  const ids=[...new Set(withSnapshots.filter(row => row.document_state==='legacy').flatMap(row => itemsFor(row)
    .filter(item => !item[SNAPSHOT_EVIDENCE])
    .map(item => safeText(item.productId ?? item.product_id,128)).filter(Boolean)))].sort();
  if (!ids.length) return withSnapshots;
  if (ids.length>5000) v.fail(409,'analytics_product_range_too_dense');
  const result=await c.query(`SELECT id,data->>'category' AS category,data->>'subcategory' AS subcategory
    FROM myfin.products WHERE company_id=$1 AND id=ANY($2::text[])`,[companyId,ids]);
  const classifications=new Map(result.rows.map(row => [String(row.id),{
    category:safeText(row.category,120)||'Uncategorized',subcategory:safeText(row.subcategory,120),
  }]));
  return withSnapshots.map(row => ({ ...row,items:itemsFor(row).map(item => {
    if (item[SNAPSHOT_EVIDENCE] || row.document_state!=='legacy') return item;
    const classification=classifications.get(safeText(item.productId ?? item.product_id,128));
    if (!classification) return item;
    return { ...item,
      category:safeText(item.category,120) ? item.category : classification.category,
      subcategory:safeText(item.subcategory,120) ? item.subcategory : classification.subcategory,
    };
  }) }));
}

function priorRange(from, to) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const previousTo = new Date(Date.parse(from) - 86400000);
  const previousFrom = new Date(previousTo.getTime() - (days - 1) * 86400000);
  return { from:previousFrom.toISOString().slice(0,10),to:previousTo.toISOString().slice(0,10) };
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
    SELECT l.item_id,l.kind,abs(l.delta) AS quantity,
      coalesce(nullif(l.base_unit_at_time,''),i.base_unit) AS base_unit
      FROM myfin.stock_ledger l JOIN myfin.stock_items i
        ON i.company_id=l.company_id AND i.id=l.item_id
     WHERE l.company_id=$1 AND l.created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
       AND l.created_at < ($3::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
  ), top_waste AS (
    SELECT l.item_id,i.name,l.base_unit,sum(l.quantity) AS quantity,count(*)::integer AS movements
      FROM period_ledger l JOIN myfin.stock_items i ON i.company_id=$1 AND i.id=l.item_id
     WHERE l.kind='waste' GROUP BY l.item_id,i.name,l.base_unit ORDER BY sum(l.quantity) DESC,l.item_id,l.base_unit LIMIT 20
  ), top_receipts AS (
    SELECT l.item_id,i.name,l.base_unit,sum(l.quantity) AS quantity,count(*)::integer AS movements
      FROM period_ledger l JOIN myfin.stock_items i ON i.company_id=$1 AND i.id=l.item_id
     WHERE l.kind='receive' GROUP BY l.item_id,i.name,l.base_unit ORDER BY sum(l.quantity) DESC,l.item_id,l.base_unit LIMIT 20
  ), top_consumption AS (
    SELECT l.item_id,i.name,l.base_unit,sum(l.quantity) AS quantity,count(*)::integer AS movements
      FROM period_ledger l JOIN myfin.stock_items i ON i.company_id=$1 AND i.id=l.item_id
     WHERE l.kind='consume' GROUP BY l.item_id,i.name,l.base_unit ORDER BY sum(l.quantity) DESC,l.item_id,l.base_unit LIMIT 20
  ), stock_health AS (
    SELECT count(*)::integer AS tracked_items,
      count(*) FILTER(WHERE active)::integer AS active_items,
      count(*) FILTER(WHERE active AND on_hand=0)::integer AS out_of_stock_items,
      count(*) FILTER(WHERE active AND reorder_level>0 AND on_hand<=reorder_level)::integer AS below_reorder_items,
      count(*) FILTER(WHERE active AND NOT EXISTS(
        SELECT 1 FROM period_ledger pl WHERE pl.item_id=s.id))::integer AS no_movement_items
      FROM myfin.stock_items s WHERE company_id=$1
  ), attention_items AS (
    SELECT id AS item_id,name,base_unit,on_hand,reorder_level,category
      FROM myfin.stock_items
     WHERE company_id=$1 AND active AND reorder_level>0 AND on_hand<=reorder_level
     ORDER BY CASE WHEN reorder_level=0 THEN 0 ELSE on_hand/reorder_level END,id LIMIT 20
  ), category_health AS (
    SELECT category,count(*) FILTER(WHERE active)::integer AS active_items,
      count(*) FILTER(WHERE active AND on_hand=0)::integer AS out_of_stock_items,
      count(*) FILTER(WHERE active AND reorder_level>0 AND on_hand<=reorder_level)::integer AS below_reorder_items
      FROM myfin.stock_items WHERE company_id=$1 GROUP BY category ORDER BY count(*) FILTER(WHERE active) DESC,category LIMIT 20
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
    (SELECT tracked_items FROM stock_health) AS tracked_items,
    (SELECT active_items FROM stock_health) AS active_items,
    (SELECT out_of_stock_items FROM stock_health) AS out_of_stock_items,
    (SELECT below_reorder_items FROM stock_health) AS below_reorder_items,
    (SELECT no_movement_items FROM stock_health) AS no_movement_items,
    coalesce((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.quantity DESC,w.item_id) FROM top_waste w),'[]') AS waste_items,
    coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.quantity DESC,r.item_id) FROM top_receipts r),'[]') AS received_items,
    coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.quantity DESC,c.item_id) FROM top_consumption c),'[]') AS consumed_items,
    coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY CASE WHEN a.reorder_level=0 THEN 0 ELSE a.on_hand/a.reorder_level END,a.item_id) FROM attention_items a),'[]') AS attention_items,
    coalesce((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.active_items DESC,h.category) FROM category_health h),'[]') AS category_health
  FROM period_ledger`;

const INVENTORY_VALUE_SQL = `SELECT count(*) FILTER(WHERE i.active)::integer AS active_items,
    count(*) FILTER(WHERE i.active AND w.stock_item_id IS NOT NULL)::integer AS costed_items,
    coalesce(sum(round(i.on_hand*w.average_cost_sen)) FILTER(WHERE i.active),0)::bigint AS inventory_value_sen
  FROM myfin.stock_items i LEFT JOIN myfin.inventory_weighted_costs w
    ON w.company_id=i.company_id AND w.stock_item_id=i.id
  WHERE i.company_id=$1`;

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
    SELECT amount_sen FROM myfin.expenses
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

function stockAttention(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0,20).map(row => ({
    itemId:safeText(row.item_id,128),name:safeText(row.name,120),category:safeText(row.category,120),
    baseUnit:safeText(row.base_unit,32),onHand:String(row.on_hand || '0'),
    reorderLevel:String(row.reorder_level || '0'),
  }));
}

function categoryHealth(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0,20).map(row => ({
    category:safeText(row.category,120) || 'General',activeItems:safeInt(row.active_items),
    outOfStockItems:safeInt(row.out_of_stock_items),belowReorderItems:safeInt(row.below_reorder_items),
  }));
}

function inventoryOutput(row = {}) {
  return {
    trackedItems:safeInt(row.tracked_items),activeItems:safeInt(row.active_items),
    outOfStockItems:safeInt(row.out_of_stock_items),belowReorderItems:safeInt(row.below_reorder_items),
    noMovementItems:safeInt(row.no_movement_items),
    movementCount:safeInt(row.movement_count), movementsByKind:{ receive:safeInt(row.receive_count),
      count:safeInt(row.count_count), adjust:safeInt(row.adjust_count), consume:safeInt(row.consume_count),
      waste:safeInt(row.waste_count) },
    procurementReceipts:safeInt(row.receipt_documents), reversedProcurementReceipts:safeInt(row.reversed_receipts),
    lowStock:{ open:safeInt(row.open_low_stock), acknowledged:safeInt(row.acknowledged_low_stock) },
    wasteItems:stockItems(row.waste_items), receivedItems:stockItems(row.received_items),
    consumedItems:stockItems(row.consumed_items),attentionItems:stockAttention(row.attention_items),
    categoryHealth:categoryHealth(row.category_health),
    basis:'Movement quantities stay grouped by the unit recorded at the time. Current stock health uses each item’s current unit and reorder level. Reversed procurement receipts remain visible as audit evidence.',
  };
}

function inventoryValueOutput(row = {}) {
  const activeItems=safeInt(row.active_items),costedItems=safeInt(row.costed_items);
  return { inventoryValueSen:String(row.inventory_value_sen || '0'),activeItems,costedItems,
    coverageBasisPoints:activeItems ? Math.round(costedItems*10000/activeItems) : 0,
    complete:activeItems===costedItems,
    basis:'Current on-hand quantities valued using recorded weighted receipt cost. Items without procurement cost evidence are excluded from the value.',
  };
}

export function registerAdvancedAnalytics(app, { scoped }) {
  app.get('/api/companies/:company/analytics/operations', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'analyticsRead');
    const { from, to, toExclusive } = advancedAnalyticsRange(req.query);
    const previous=priorRange(from,to);
    // Scoped routes use one checked-out pg client. Keep its queries sequential so
    // behavior remains supported when pg removes concurrent client.query calls.
    const orders=await c.query(ORDER_SQL,[companyId,from,toExclusive]);
    const inventory=await c.query(INVENTORY_SQL,[companyId,from,toExclusive]);
    const student=await c.query(STUDENT_SQL,[companyId,from,toExclusive]);
    const rawSales=await salesRows(c,companyId,from,to);
    const sales=await classifySalesRows(c,companyId,rawSales);
    const previousSales=await salesRows(c,companyId,previous.from,previous.to);
    const order = orders.rows[0] || {}, saleMetrics = analyzeSalesRows(sales);
    return { from,to,orders:orderOutput(order),customers:customerOutput(order),
      productPerformance:saleMetrics.productPerformance,student:studentAggregate(student.rows[0]),
      categoryPerformance:saleMetrics.categoryPerformance,
      salesPerformance:{ ...compareSalesPerformance(sales,previousSales,{ from,to }),previousRange:previous },
      inventory:inventoryOutput(inventory.rows[0]),
      coverage:{
        orders:'Online order requests created in the selected range. Submitted demand includes later cancellations and expiries; paid value includes only paid requests. POS walk-ins and manually issued invoices are outside customer/order aggregates.',
        products:'Issued POS and invoice lines with valid business or issue dates. Immutable pricing snapshots supply historical categories and exact discounted product revenue when available; tax, delivery fees and cash rounding remain in receipt totals but are not attributed to products. Snapshot-less legacy lines use stored sale classification and fall back to the current catalogue only when it is missing. Returns reduce signed net revenue, while share measures positive net revenue only.',
        students:'Student activity appears only when immutable student pricing or redemption evidence exists. Small cohorts are suppressed.',
      } };
  }));

  app.get('/api/companies/:company/analytics/cost-performance', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'analyticsRead');
    requireCapability(req.identity, 'costsRead');
    const { from, to } = advancedAnalyticsRange(req.query);
    const rawSales=await salesRows(c,companyId,from,to);
    const sales=await attachPricingSnapshotEvidence(c,companyId,rawSales);
    const expenses=await c.query(EXPENSE_SQL,[companyId,from,to]);
    const inventoryValue=await c.query(INVENTORY_VALUE_SQL,[companyId]);
    return { from,to,...financialPerformance(sales,expenses.rows[0]?.amount_sen || '0'),
      inventoryValue:inventoryValueOutput(inventoryValue.rows[0]) };
  }));
}
