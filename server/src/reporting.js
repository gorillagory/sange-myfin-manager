import { z } from 'zod';
import * as v from './validation.js';
import { requireCapability } from './access.js';
import { businessDate, cents, expenseRecords } from '../../src/domain/pos.js';
import { expenseHasCashImpact } from '../../src/domain/expenseLifecycle.js';

const dateShape = {
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
};
const filterText = z.string().trim().min(1).max(120).optional();
export const reportFilterShape = Object.freeze({
  channel: z.enum(['pos', 'manual', 'invoice']).optional(),
  paymentMethod: filterText,
  category: filterText,
  subcategory: filterText,
});
export const reportQuerySchema = z.strictObject({ ...dateShape, ...reportFilterShape });
const consolidationQuerySchema = z.strictObject({ ...dateShape, workspaceId: v.id.optional() });

function range(query, schema = reportQuerySchema) {
  const value = v.parse(schema, query);
  const fromMs = Date.parse(value.from), toMs = Date.parse(value.to);
  const span = (toMs - fromMs) / 86400000;
  if (!Number.isInteger(span) || span < 0 || span > 366 || !Number.isFinite(fromMs) || !Number.isFinite(toMs)
    || new Date(fromMs).toISOString().slice(0, 10) !== value.from
    || new Date(toMs).toISOString().slice(0, 10) !== value.to) v.fail(400, 'invalid_report_range');
  return value;
}

const dateOnly = value => value instanceof Date
  ? value.toISOString().slice(0, 10)
  : String(value || '').slice(0, 10);
const asRecord = row => ({ ...row.data, id: row.id, company_id: row.company_id,
  ...(row.status ? { status:row.status } : {}),
  ...(row.credit_due_date ? { creditDueDate:dateOnly(row.credit_due_date) } : {}),
  ...(row.paid_on ? { paidOn:dateOnly(row.paid_on) } : {}),
  ...(row.paid_by_type ? { paidByType:row.paid_by_type } : {}),
  ...(row.amount_sen != null ? { amount:Number(row.amount_sen)/100 } : {}),
});
const inRange = (date, from, to) => /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date
  && date >= from && date <= to;
const sum = (rows, key) => rows.reduce((amount, row) => amount + cents(row[key]), 0) / 100;
const safeText = value => String(value || '').slice(0, 160);
const safeDimension = (value, fallback) => String(value ?? '').trim().slice(0, 120) || fallback;
const LEGACY_INVOICE_STATUSES = new Set(['Pending', 'Paid', 'Cleared', 'Partially paid']);
const CASH_STATUSES = new Set(['Paid', 'Cleared']);
const LEGACY_QUOTE_SOURCE = /^(?:Generated|Converted) from Quote (QT-[A-Z0-9]+(?:-[A-Z0-9]+)*)\.?$/i;
const CATEGORY_FALLBACK = 'Uncategorized';
const SUBCATEGORY_FALLBACK = 'No subcategory';
const PAYMENT_FALLBACK = 'Unspecified';
const INVOICE_PAYMENT = 'On account';
const CHANNEL_LABELS = Object.freeze({ pos: 'POS', manual: 'Recorded later', invoice: 'Invoice' });

const finiteNumber = value => {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function legacyInvoiceTax(data, total) {
  const explicit = finiteNumber(data.tax);
  if (explicit !== null) return cents(explicit) / 100;
  const rate = finiteNumber(data.taxRate ?? data.tax_rate);
  if (rate === null || rate <= 0 || rate > 100) return 0;

  let subtotalCents = finiteNumber(data.subtotal);
  subtotalCents = subtotalCents === null ? null : cents(subtotalCents);
  if (subtotalCents === null && Array.isArray(data.items) && data.items.length) {
    let valid = true;
    subtotalCents = data.items.reduce((amount, item) => {
      const price = finiteNumber(item?.price), quantity = finiteNumber(item?.qty ?? item?.quantity);
      if (price === null || quantity === null) { valid = false; return amount; }
      return amount + Math.round(cents(price) * quantity);
    }, 0);
    if (!valid) subtotalCents = null;
  }

  if (subtotalCents !== null) {
    const explicitDiscount = finiteNumber(data.discountAmount ?? data.discount_amount);
    const discountRate = finiteNumber(data.discount);
    const discountCents = explicitDiscount !== null ? cents(explicitDiscount)
      : discountRate !== null && discountRate >= 0 && discountRate <= 100 ? Math.round(subtotalCents * discountRate / 100) : 0;
    const taxableCents = subtotalCents - discountCents;
    if (taxableCents >= 0) {
      const calculated = Math.round(taxableCents * rate / 100);
      const gross = finiteNumber(total ?? data.total);
      if (gross !== null) {
        const reconciled = cents(gross) - taxableCents;
        if (reconciled >= 0 && Math.abs(reconciled - calculated) <= 1) return reconciled / 100;
      }
      return calculated / 100;
    }
  }

  const gross = finiteNumber(total ?? data.total);
  return gross !== null && gross >= 0 ? Math.round(cents(gross) * rate / (100 + rate)) / 100 : 0;
}

function legacyQuoteNumber(data) {
  const evidence = [
    ...(Array.isArray(data.history) ? data.history.map(entry => entry?.action) : []),
    data.notes,
  ];
  for (const value of evidence) {
    if (typeof value !== 'string' || value.length > 200) continue;
    const match = value.trim().match(LEGACY_QUOTE_SOURCE);
    if (match) return match[1].toUpperCase();
  }
  return '';
}

const dimensionKey = value => String(value || '').trim().toLocaleLowerCase('en-US');
const sameDimension = (left, right) => dimensionKey(left) === dimensionKey(right);
const productKey = (companyId, productId) => `${companyId}\u0000${productId}`;

export function normalizeReportFilters(value = {}) {
  return {
    channel: ['pos', 'manual', 'invoice'].includes(value.channel) ? value.channel : '',
    paymentMethod: String(value.paymentMethod || '').trim().slice(0, 120),
    category: String(value.category || '').trim().slice(0, 120),
    subcategory: String(value.subcategory || '').trim().slice(0, 120),
  };
}

const hasFilters = filters => Object.values(filters).some(Boolean);

function reportProductMap(products = []) {
  return new Map(products.map(row => [productKey(row.company_id, row.id), {
    category: safeDimension(row.category ?? row.data?.category, CATEGORY_FALLBACK),
    subcategory: safeDimension(row.subcategory ?? row.data?.subcategory, SUBCATEGORY_FALLBACK),
  }]));
}

function rowItems(row, data = row.data || {}) {
  if (Array.isArray(row.issued_snapshot?.items)) return row.issued_snapshot.items;
  return Array.isArray(data.items) ? data.items : [];
}

function classificationGroups(companyId, items, products) {
  const groups = new Map();
  for (const item of items) {
    const product = products.get(productKey(companyId, item?.productId ?? item?.product_id)) || {};
    const category = safeDimension(item?.category || product.category, CATEGORY_FALLBACK);
    const subcategory = safeDimension(item?.subcategory || product.subcategory, SUBCATEGORY_FALLBACK);
    const explicit = finiteNumber(item?.lineTotal ?? item?.line_total);
    const price = finiteNumber(item?.price ?? item?.unitPrice ?? item?.unit_price);
    const quantity = finiteNumber(item?.qty ?? item?.quantity);
    const weight = Math.abs(explicit === null
      ? price === null || quantity === null ? 0 : Math.round(cents(price) * quantity)
      : cents(explicit));
    const key = `${dimensionKey(category)}\u0000${dimensionKey(subcategory)}`;
    const current = groups.get(key);
    if (current) current.weight += weight;
    else groups.set(key, { category, subcategory, weight });
  }
  if (!groups.size) return [{ category: CATEGORY_FALLBACK, subcategory: SUBCATEGORY_FALLBACK, weight: 1 }];
  const values = [...groups.values()];
  if (!values.some(group => group.weight > 0)) for (const group of values) group.weight = 1;
  return values;
}

function allocateCents(total, groups) {
  const signedAmount = Math.round(Number(total) || 0), sign = Math.sign(signedAmount) || 1;
  const amount = Math.abs(signedAmount);
  const weight = groups.reduce((value, group) => value + BigInt(Math.max(0, Math.round(group.weight))), 0n);
  if (!amount || !weight) return groups.map(() => 0);
  const totalValue = BigInt(amount);
  const allocated = groups.map((group, index) => {
    const numerator = totalValue * BigInt(Math.max(0, Math.round(group.weight)));
    return { index, value: numerator / weight, remainder: numerator % weight };
  });
  let remaining = totalValue - allocated.reduce((value, item) => value + item.value, 0n);
  for (const item of [...allocated].sort((left, right) => left.remainder === right.remainder
    ? left.index - right.index : left.remainder > right.remainder ? -1 : 1)) {
    if (!remaining) break;
    item.value += 1n;
    remaining -= 1n;
  }
  return allocated.sort((left, right) => left.index - right.index).map(item => Number(item.value) * sign);
}

function classifiedSegments(groups, amounts) {
  const allocation = Object.fromEntries(Object.entries(amounts)
    .map(([key, value]) => [key, allocateCents(cents(value), groups)]));
  return groups.map((group, index) => ({
    category: group.category,
    subcategory: group.subcategory,
    ...Object.fromEntries(Object.entries(allocation).map(([key, values]) => [key, values[index] / 100])),
  }));
}

function filteredRecord(row, filters, amountFields) {
  if (filters.channel && row.channel !== filters.channel) return null;
  if (filters.paymentMethod && !sameDimension(row.paymentMethod, filters.paymentMethod)) return null;
  const dimensionFilter = filters.category || filters.subcategory;
  const segments = row._segments.filter(segment =>
    (!filters.category || sameDimension(segment.category, filters.category))
    && (!filters.subcategory || sameDimension(segment.subcategory, filters.subcategory)));
  if (dimensionFilter && !segments.length) return null;
  if (!dimensionFilter) return { ...row, _segments: segments };
  const selected = { ...row, _segments: segments };
  for (const field of amountFields) selected[field] = sum(segments, field);
  if (amountFields.includes('total')) selected.documentTotal = row.total;
  if (amountFields.includes('tax')) selected.documentTax = row.tax;
  if (amountFields.includes('amount')) selected.documentAmount = row.amount;
  return selected;
}

function publicReportRow(row) {
  const { _segments, ...output } = row;
  return {
    ...output,
    categories: [...new Set(_segments.map(segment => segment.category))],
    subcategories: [...new Set(_segments.map(segment => segment.subcategory))],
  };
}

function filterOptions(sales, receipts, quotes) {
  const channels = new Map(), payments = new Map(), categories = new Map(), subcategories = new Map();
  for (const row of [...sales, ...receipts, ...quotes]) {
    if (row.channel) channels.set(row.channel, CHANNEL_LABELS[row.channel] || row.channel);
    if (row.paymentMethod) payments.set(dimensionKey(row.paymentMethod), row.paymentMethod);
    for (const segment of row._segments) {
      categories.set(dimensionKey(segment.category), segment.category);
      subcategories.set(`${dimensionKey(segment.category)}\u0000${dimensionKey(segment.subcategory)}`, {
        value: segment.subcategory, label: segment.subcategory, category: segment.category,
      });
    }
  }
  const options = values => [...values].sort((left, right) => left.label.localeCompare(right.label, 'en'));
  return {
    channels: ['pos', 'manual', 'invoice'].filter(value => channels.has(value))
      .map(value => ({ value, label: channels.get(value) })),
    paymentMethods: options([...payments.values()].map(value => ({ value, label: value }))),
    categories: options([...categories.values()].map(value => ({ value, label: value }))),
    subcategories: options(subcategories.values()),
  };
}

function simpleBreakdown(sales, receipts, field, labels = {}) {
  const values = new Map();
  const entry = raw => {
    const value = String(raw || '');
    const key = dimensionKey(value);
    if (!values.has(key)) values.set(key, { value, label: labels[value] || value, sales: 0, tax: 0,
      cashIn: 0, salesCount: 0, receiptCount: 0 });
    return values.get(key);
  };
  for (const sale of sales) {
    const row = entry(sale[field]);
    row.sales += cents(sale.total); row.tax += cents(sale.tax); row.salesCount += 1;
  }
  for (const receipt of receipts) {
    const row = entry(receipt[field]);
    row.cashIn += cents(receipt.amount); row.receiptCount += 1;
  }
  return [...values.values()].map(row => ({ ...row, sales: row.sales / 100, tax: row.tax / 100,
    cashIn: row.cashIn / 100 })).sort((left, right) => cents(right.sales) - cents(left.sales)
      || cents(right.cashIn) - cents(left.cashIn) || left.label.localeCompare(right.label, 'en'));
}

function classificationBreakdown(sales, receipts, field) {
  const values = new Map();
  const ensure = segment => {
    const category = segment.category, value = segment[field];
    const key = field === 'category' ? dimensionKey(value)
      : `${dimensionKey(category)}\u0000${dimensionKey(value)}`;
    if (!values.has(key)) values.set(key, { value, label: value, ...(field === 'subcategory' ? { category } : {}),
      sales: 0, tax: 0, cashIn: 0, saleIds: new Set(), receiptIds: new Set() });
    return values.get(key);
  };
  for (const sale of sales) for (const segment of sale._segments) {
    const row = ensure(segment);
    row.sales += cents(segment.total); row.tax += cents(segment.tax); row.saleIds.add(sale.id);
  }
  for (const receipt of receipts) for (const segment of receipt._segments) {
    const row = ensure(segment);
    row.cashIn += cents(segment.amount); row.receiptIds.add(receipt.id);
  }
  return [...values.values()].map(({ saleIds, receiptIds, ...row }) => ({ ...row,
    sales: row.sales / 100, tax: row.tax / 100, cashIn: row.cashIn / 100,
    salesCount: saleIds.size, receiptCount: receiptIds.size,
  })).sort((left, right) => cents(right.sales) - cents(left.sales)
    || cents(right.cashIn) - cents(left.cashIn) || left.label.localeCompare(right.label, 'en'));
}

const reportBasis = 'Sales and tax use POS business dates, the occurrence date of manager-recorded sales, or issued invoice dates. Open quotes remain pipeline; converted quote value is reported separately and only its issued invoice becomes sales. Cash in uses paid POS and recorded-sale receipts plus invoice payments. Every active expense is recognized on its expense date; cash out uses its paid or settlement date. Paid payment vouchers use their voucher date.';

// Keep this classification aligned with /reports/summary in business.js. The
// detail endpoint uses the same dates and amount rules as the approved report.
export function companyReport({ transactions = [], expenses = [], payments = [], products = [] }, from, to, requestedFilters = {}) {
  const filters = normalizeReportFilters(requestedFilters), productsById = reportProductMap(products);
  const sales = [], expenseLines = [], receipts = [], quotes = [];
  for (const row of transactions) {
    const data = row.data || {};
    const date = data.businessDate || businessDate(row.issued_at || data.date);
    if (!inRange(date, from, to)) continue;
    const groups = classificationGroups(row.company_id, rowItems(row, data), productsById);
    if (row.source === 'pos' || row.source === 'manual_sale') {
      const paymentMethod = safeDimension(data.paymentMethod, PAYMENT_FALLBACK);
      const manuallyRecorded = row.source === 'manual_sale', channel = manuallyRecorded ? 'manual' : 'pos';
      sales.push({ id: row.id, date, kind: manuallyRecorded ? 'Recorded sale' : 'POS receipt', channel, paymentMethod,
        number: safeText(data.number), customer: safeText(data.customerName || 'Walk-in customer'),
        total: Number(row.total), tax: Number(data.tax || 0), fromQuote: false,
        _segments: classifiedSegments(groups, { total: Number(row.total), tax: Number(data.tax || 0) }) });
      if (!manuallyRecorded || data.paymentStatus === 'Paid')
        receipts.push({ id: row.id, date, kind: manuallyRecorded ? 'Recorded sale payment' : 'POS receipt', channel, paymentMethod,
          number: safeText(data.number), amount: Number(row.total),
          _segments: classifiedSegments(groups, { amount: Number(row.total) }) });
    } else if (row.document_state === 'issued' && data.type === 'Invoice') {
      const fromQuote = Boolean(row.quote_id || data.quoteId);
      const tax = Number(row.issued_snapshot?.tax ?? data.tax ?? 0);
      sales.push({ id: row.id, date, kind: fromQuote ? 'Invoice from quote' : 'Invoice', channel: 'invoice',
        paymentMethod: INVOICE_PAYMENT, number: safeText(data.number),
        customer: safeText(row.issued_snapshot?.clientSnapshot?.name || data.customerName),
        total: Number(row.total), tax, fromQuote, _segments: classifiedSegments(groups, { total: Number(row.total), tax }) });
    } else if (row.document_state === 'legacy' && data.type === 'Invoice' && LEGACY_INVOICE_STATUSES.has(data.status)) {
      const sourceQuoteNumber = legacyQuoteNumber(data), fromQuote = Boolean(sourceQuoteNumber);
      const tax = legacyInvoiceTax(data, row.total);
      sales.push({ id: row.id, date, kind: fromQuote ? 'Historical invoice from quote' : 'Historical invoice',
        channel: 'invoice', paymentMethod: INVOICE_PAYMENT, number: safeText(data.number),
        customer: safeText(data.customerName), total: Number(row.total), tax, fromQuote,
        ...(fromQuote ? { sourceQuoteNumber } : {}), status: safeText(data.status),
        _segments: classifiedSegments(groups, { total: Number(row.total), tax }) });
      if (CASH_STATUSES.has(data.status)) receipts.push({ id: row.id, date, kind: 'Historical paid invoice',
        channel: 'invoice', paymentMethod: safeDimension(data.paymentMethod || data.method, PAYMENT_FALLBACK),
        number: safeText(data.number), amount: Number(row.total),
        _segments: classifiedSegments(groups, { amount: Number(row.total) }) });
    } else if ((row.document_state === 'issued' || row.document_state === 'legacy') && data.type === 'Quote' && !['Voided', 'Cancelled', 'Canceled'].includes(data.status)) {
      const converted = Boolean(row.converted_to || data.convertedTo || String(data.status || '').toLowerCase() === 'converted');
      quotes.push({ id: row.id, date, kind: row.document_state === 'legacy' ? 'Historical quote' : 'Quote',
        channel: 'invoice', paymentMethod: '', number: safeText(data.number),
        customer: safeText(row.issued_snapshot?.clientSnapshot?.name || data.customerName),
        status: safeText(converted ? 'Converted' : data.status || 'Issued'), total: Number(row.total), converted,
        _segments: classifiedSegments(groups, { total: Number(row.total) }) });
    }
  }
  const legacyExpenses = transactions.filter(row => row.document_state === 'legacy').map(asRecord);
  const allExpenses = expenseRecords({ expenses: expenses.map(asRecord), transactions: legacyExpenses });
  for (const expense of allExpenses) {
    const date = businessDate(expense.date);
    const voucher = expense.type === 'Payment Voucher';
    const cashDate = voucher ? date : businessDate(expense.paidOn || expense.date);
    const accrualImpact = inRange(date, from, to);
    const cashImpact = (voucher ? CASH_STATUSES.has(expense.status) : expenseHasCashImpact(expense))
      && inRange(cashDate, from, to);
    if (accrualImpact || cashImpact) expenseLines.push({ id: expense.id, date, cashDate,
      description: safeText(expense.description), category: safeText(expense.category || 'Uncategorized'),
      payee: safeText(expense.payee), number: safeText(expense.number), kind: voucher ? 'Payment voucher' : 'Expense',
      status: safeText(expense.status || 'paid'), amount: Number(expense.amount || 0), accrualImpact, cashImpact });
  }
  for (const payment of payments) {
    const date = businessDate(payment.paid_at);
    if (inRange(date, from, to)) {
      const data = payment.data || {};
      const groups = classificationGroups(payment.company_id, rowItems(payment, data), productsById);
      receipts.push({ id: payment.id, date, kind: 'Invoice payment', channel: 'invoice',
        paymentMethod: safeDimension(payment.method, PAYMENT_FALLBACK), number: safeText(payment.number),
        amount: Number(payment.amount), _segments: classifiedSegments(groups, { amount: Number(payment.amount) }) });
    }
  }
  const options = filterOptions(sales, receipts, quotes);
  const selectedSales = sales.map(row => filteredRecord(row, filters, ['total', 'tax'])).filter(Boolean);
  const selectedReceipts = receipts.map(row => filteredRecord(row, filters, ['amount'])).filter(Boolean);
  const selectedQuotes = quotes.map(row => filteredRecord(row, filters, ['total'])).filter(Boolean);
  const byDate = (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id);
  selectedSales.sort(byDate); expenseLines.sort(byDate); selectedReceipts.sort(byDate); selectedQuotes.sort(byDate);
  const accruedExpenses = expenseLines.filter(row => row.accrualImpact);
  const cashExpenses = expenseLines.filter(row => row.cashImpact);
  const totals = { sales: sum(selectedSales, 'total'), tax: sum(selectedSales, 'tax'), expenses: sum(accruedExpenses, 'amount'), cashIn: sum(selectedReceipts, 'amount'), cashOut: sum(cashExpenses, 'amount'), cashFlow: (selectedReceipts.reduce((amount, row) => amount + cents(row.amount), 0) - cashExpenses.reduce((amount, row) => amount + cents(row.amount), 0)) / 100, quoted: sum(selectedQuotes.filter(row => !row.converted), 'total'), convertedQuoted: sum(selectedQuotes.filter(row => row.converted), 'total') };
  const days = new Map();
  for (let stamp = Date.parse(from); stamp <= Date.parse(to); stamp += 86400000) {
    const date = new Date(stamp).toISOString().slice(0, 10);
    days.set(date, { date, sales: 0, tax: 0, expenses: 0, cashIn: 0, cashOut: 0, cashFlow: 0 });
  }
  const add = (date, key, amount) => { if (days.has(date)) days.get(date)[key] += cents(amount); };
  for (const row of selectedSales) { add(row.date, 'sales', row.total); add(row.date, 'tax', row.tax); }
  for (const row of accruedExpenses) add(row.date, 'expenses', row.amount);
  for (const row of selectedReceipts) add(row.date, 'cashIn', row.amount);
  for (const row of cashExpenses) add(row.cashDate, 'cashOut', row.amount);
  const daily = [...days.values()].map(row => ({ date: row.date, sales: row.sales / 100, tax: row.tax / 100, expenses: row.expenses / 100, cashIn: row.cashIn / 100, cashOut: row.cashOut / 100, cashFlow: (row.cashIn - row.cashOut) / 100 }));
  return { totals, daily, sales: selectedSales.map(publicReportRow), expenses: expenseLines,
    receipts: selectedReceipts.map(publicReportRow), quotes: selectedQuotes.map(publicReportRow), basis: reportBasis,
    filters, filterOptions: options, filterActive: hasFilters(filters),
    filterScope: hasFilters(filters)
      ? 'Sales dimensions filter issued sales, tax and attributable cash receipts. Channel and product filters also filter quote pipeline. Expenses and cash out remain company-wide because current expense records are not reliably attributable to sales dimensions.'
      : '',
    breakdowns: {
      channel: simpleBreakdown(selectedSales, selectedReceipts, 'channel', CHANNEL_LABELS),
      paymentMethod: simpleBreakdown(selectedSales, selectedReceipts, 'paymentMethod'),
      category: classificationBreakdown(selectedSales, selectedReceipts, 'category'),
      subcategory: classificationBreakdown(selectedSales, selectedReceipts, 'subcategory'),
    } };
}

export function reportDateBounds(from, to) {
  const date = (value, offset) => {
    const result = new Date(Date.parse(value) + offset * 86400000);
    return `${String(result.getUTCFullYear()).padStart(4, '0')}-${String(result.getUTCMonth() + 1).padStart(2, '0')}-${String(result.getUTCDate()).padStart(2, '0')}`;
  };
  return { fromPad: date(from, -1), toPad: date(to, 1), toExclusive: date(to, 1) };
}

export async function companyRows(c, companyIds, from, to) {
  // A timestamp with an offset can land on an adjacent Kuala Lumpur day. The
  // JSON date-prefix branches therefore fetch one extra day on each side,
  // then companyReport applies the exact businessDate() rule in JavaScript.
  // Missing/non-ISO legacy dates remain a small fallback so old records are
  // never silently dropped. Indexed branches bound ordinary report traffic.
  const { fromPad, toPad, toExclusive } = reportDateBounds(from, to);
  const args = [companyIds, from, to, fromPad, toPad, toExclusive];
  const transactionColumns = 'company_id,id,data,total,source,document_state,issued_at,issued_snapshot,quote_id,converted_to';
  const transactionsTable = 'myfin.transactions';
  const relevant = `(source IN ('pos','manual_sale') OR (document_state='issued' AND data->>'type' IN ('Invoice','Quote'))
    OR (document_state='legacy' AND data->>'type' IN ('Invoice','Quote','Expense','Payment Voucher')))`;
  const missingBusinessDate = `(coalesce(data->>'businessDate','')='' OR data->'businessDate' IN ('0'::jsonb,'false'::jsonb))`;
  const datePrefix = `left(data->>'date',10)`;
  const standardPrefix = `${datePrefix} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;
  const transactionBranch = condition => `SELECT ${transactionColumns} FROM ${transactionsTable}
    WHERE company_id=ANY($1::text[]) AND ${relevant} AND ${condition}`;
  const transactionQuery = [
    transactionBranch(`data->>'businessDate' BETWEEN $2 AND $3`),
    transactionBranch(`${missingBusinessDate} AND issued_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
      AND issued_at < ($6::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')`),
    transactionBranch(`${missingBusinessDate} AND issued_at IS NULL AND ${standardPrefix} AND ${datePrefix} BETWEEN $4 AND $5`),
    transactionBranch(`${missingBusinessDate} AND issued_at IS NULL AND (data->>'date' IS NULL OR ${datePrefix} !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')`),
  ].join(' UNION ALL ');
  const expenseBranch = condition => `SELECT company_id,id,data,amount_sen,status,paid_by_type,
      credit_due_date::text AS credit_due_date,paid_on::text AS paid_on FROM myfin.expenses
    WHERE company_id=ANY($1::text[]) AND voided_at IS NULL AND (${condition})`;
  const expenseQuery = [
    expenseBranch(`${standardPrefix} AND ${datePrefix} BETWEEN $2 AND $3`),
    expenseBranch(`data->>'date' IS NULL OR ${datePrefix} !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
    expenseBranch(`status='paid' AND paid_on BETWEEN $4 AND $5 AND ${standardPrefix} AND ${datePrefix} NOT BETWEEN $2 AND $3`),
  ].join(' UNION ALL ');
  const transactions = await c.query(transactionQuery, args);
  const expenses = await c.query(expenseQuery, [companyIds, fromPad, toPad, from, to]);
  const payments = await c.query(`SELECT p.company_id,p.id,p.document_id,p.amount,p.method,p.paid_at,
      t.data->>'number' AS number,t.data,t.source,t.document_state,t.issued_snapshot
      FROM myfin.document_payments p LEFT JOIN myfin.transactions t ON t.company_id=p.company_id AND t.id=p.document_id
      WHERE p.company_id=ANY($1::text[])
      AND p.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
        AND p.paid_at < ($3::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')`, [companyIds, from, toExclusive]);
  const productIds = new Set();
  const collectProducts = row => {
    for (const item of rowItems(row, row.data || {})) {
      const id = String(item?.productId ?? item?.product_id ?? '').trim();
      if (id) productIds.add(id);
    }
  };
  for (const row of transactions.rows) collectProducts(row);
  for (const row of payments.rows) collectProducts(row);
  const products = productIds.size ? await c.query(
    `SELECT company_id,id,data->>'category' AS category,data->>'subcategory' AS subcategory
       FROM myfin.products WHERE company_id=ANY($1::text[]) AND id=ANY($2::text[])`,
    [companyIds, [...productIds]],
  ) : { rows: [] };
  return { transactions: transactions.rows, expenses: expenses.rows, payments: payments.rows, products: products.rows };
}

export function registerReporting(app, { db, managed, authorize, managementSession }) {
  app.get('/api/companies/:company/reports/details', req => db.transaction(async c => {
    await managementSession(c, req);
    const companyId = v.parse(v.id, req.params.company);
    await authorize(c, req.identity, companyId);
    requireCapability(req.identity, 'financialReports');
    const query = range(req.query), { from, to } = query;
    const rows = await companyRows(c, [companyId], from, to);
    const result = companyReport(rows, from, to, query);
    const limit = 250;
    return { from, to, totals: result.totals, daily: result.daily, basis: result.basis,
      filters: result.filters, filterOptions: result.filterOptions, filterActive: result.filterActive,
      filterScope: result.filterScope, breakdowns: result.breakdowns,
      counts: { sales: result.sales.length, expenses: result.expenses.length, receipts: result.receipts.length, quotes: result.quotes.length },
      sales: result.sales.slice(0, limit), expenses: result.expenses.slice(0, limit), receipts: result.receipts.slice(0, limit), quotes: result.quotes.slice(0, limit),
      limited: [result.sales.length, result.expenses.length, result.receipts.length, result.quotes.length].some(count => count > limit) };
  }));

  app.get('/api/reports/consolidation', req => managed(req, async(c, who) => {
    requireCapability(who, 'financialReports');
    const { from, to, workspaceId } = range(req.query, consolidationQuerySchema);
    const permitted = await c.query(`SELECT co.id,co.name,co.workspace_id,w.name AS workspace_name,
      coalesce(nullif(co.data->'preferences'->>'currency',''),'RM') AS currency
      FROM myfin.companies co JOIN myfin.workspaces w ON w.id=co.workspace_id
      WHERE co.archived_at IS NULL AND co.suspended_at IS NULL AND w.archived_at IS NULL AND w.suspended_at IS NULL
        AND ($3::text='' OR co.id=$3)
        AND ($2 OR EXISTS(SELECT 1 FROM myfin.workspace_memberships wm WHERE wm.workspace_id=co.workspace_id AND wm.identity_id=$1 AND wm.suspended_at IS NULL)
          OR EXISTS(SELECT 1 FROM myfin.memberships m WHERE m.company_id=co.id AND m.identity_id=$1 AND m.role IN ('manager','company_admin')))
      ORDER BY w.name,co.name LIMIT 1001`, [who.id, who.role === 'super_admin', req.identity.host_company_id || '']);
    if (permitted.rowCount > 1000) v.fail(409, 'company_limit_exceeded');
    const workspaces = [...new Map(permitted.rows.map(row => [row.workspace_id, { id: row.workspace_id, name: row.workspace_name }])).values()];
    const selected = workspaceId || workspaces[0]?.id || '';
    if (selected && !workspaces.some(workspace => workspace.id === selected)) v.fail(403, 'access_denied');
    const companies = permitted.rows.filter(row => row.workspace_id === selected);
    const rows = companies.length ? await companyRows(c, companies.map(row => row.id), from, to) : { transactions: [], expenses: [], payments: [] };
    const byCompany = collection => {
      const grouped = new Map();
      for (const row of collection) {
        if (!grouped.has(row.company_id)) grouped.set(row.company_id, []);
        grouped.get(row.company_id).push(row);
      }
      return grouped;
    };
    const transactions = byCompany(rows.transactions), expenses = byCompany(rows.expenses), payments = byCompany(rows.payments);
    const reports = companies.map(company => ({ id: company.id, name: company.name, currency: company.currency,
      ...companyReport({ transactions: transactions.get(company.id), expenses: expenses.get(company.id), payments: payments.get(company.id) }, from, to).totals }));
    return { from, to, workspaceId: selected, workspaces, companies: reports };
  }));
}
