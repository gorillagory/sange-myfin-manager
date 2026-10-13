import test from 'node:test';
import assert from 'node:assert/strict';
import { companyReport, companyRows, reportDateBounds, reportQuerySchema } from '../src/reporting.js';
import { cents } from '../../src/domain/pos.js';

test('detail totals follow the approved sales, receipt and expense dates', () => {
  const rows = {
    transactions: [
      { id: 'pos-1', company_id: 'co', source: 'pos', document_state: 'issued', total: 10.6, data: { date: '2026-09-30T01:00:00Z', businessDate: '2026-09-30', number: 'R-1', tax: .6, cost: 999 } },
      { id: 'invoice-1', company_id: 'co', source: 'document', document_state: 'issued', total: 21.2, issued_at: new Date('2026-09-30T03:00:00Z'), issued_snapshot: { tax: 1.2 }, data: { type: 'Invoice', number: 'I-1', customerName: 'Customer' } },
      { id: 'legacy-expense', company_id: 'co', source: 'legacy', document_state: 'legacy', total: 3, data: { type: 'Expense', date: '2026-09-30', amount: 3, description: 'Historical expense' } },
    ],
    expenses: [{ id: 'exp-1', company_id: 'co', data: { id: 'exp-1', amount: 2.25, date: '2026-09-30', description: 'Milk', category: 'Ingredients', payee: 'Supplier', cost: 999 } }],
    payments: [{ id: 'pay-1', company_id: 'co', amount: 5, paid_at: new Date('2026-09-30T07:00:00Z'), number: 'I-1' }],
  };
  const report = companyReport(rows, '2026-09-30', '2026-09-30');
  assert.deepEqual(report.totals, { sales: 31.8, tax: 1.8, expenses: 5.25, cashIn: 15.6, cashOut: 5.25, cashFlow: 10.35, quoted: 0, convertedQuoted: 0 });
  assert.equal(report.sales.length, 2);
  assert.equal(report.expenses.length, 2);
  assert.equal(report.receipts.length, 2);
  assert.doesNotMatch(JSON.stringify(report), /"cost"|"margin"|"profit"/i);
  assert.deepEqual(companyReport(rows, '2026-10-01', '2026-10-01').totals, { sales: 0, tax: 0, expenses: 0, cashIn: 0, cashOut: 0, cashFlow: 0, quoted: 0, convertedQuoted: 0 });
});

test('delivery POS reporting recognizes the collected total including the snapshotted fee', () => {
  const rows = { transactions: [{ id:'delivery-sale', company_id:'co', source:'pos', document_state:'issued', total:22.45,
    data:{ businessDate:'2026-10-09', number:'POS-DELIVERY', paymentMethod:'Cash', customerName:'Delivery customer',
      subtotal:19.91, tax:0, deliveryFee:2.53, totalBeforeRounding:22.44, rounding:.01, total:22.45,
      items:[{ productId:'latte', desc:'Latte', qty:1, price:19.91 }] } }] };
  const report = companyReport(rows,'2026-10-09','2026-10-09');
  assert.equal(report.totals.sales,22.45);assert.equal(report.totals.cashIn,22.45);assert.equal(report.totals.cashFlow,22.45);
  assert.equal(report.sales[0].total,22.45);assert.equal(report.receipts[0].amount,22.45);
});

test('imported invoices and expenses post without recognizing legacy quotes as revenue', () => {
  const rows = {
    transactions: [
      { id: 'legacy-invoice-pending', company_id: 'co', source: 'manual', document_state: 'legacy', total: 108,
        data: { type: 'Invoice', status: 'Pending', date: '2026-01-03', number: 'INV-PENDING', tax: 8 } },
      { id: 'legacy-invoice-paid', company_id: 'co', source: 'manual', document_state: 'legacy', total: 54,
        data: { type: 'Invoice', status: 'Paid', date: '2026-01-04', number: 'INV-PAID', tax: 4 } },
      { id: 'legacy-quote-converted', company_id: 'co', source: 'manual', document_state: 'legacy', total: 999,
        data: { type: 'Quote', status: 'Converted', date: '2026-01-03', number: 'QUO-CONVERTED', tax: 74 } },
      { id: 'legacy-quote-open', company_id: 'co', source: 'manual', document_state: 'legacy', total: 79,
        data: { type: 'Quote', status: 'Pending', date: '2026-01-04', number: 'QUO-OPEN', tax: 0 } },
      { id: 'legacy-payment-voucher', company_id: 'co', source: 'manual', document_state: 'legacy', total: 12,
        data: { type: 'Payment Voucher', status: 'Paid', date: '2026-01-04', number: 'PV-PAID', total: 12 } },
      { id: 'legacy-payment-voucher-pending', company_id: 'co', source: 'manual', document_state: 'legacy', total: 7,
        data: { type: 'Payment Voucher', status: 'Pending', date: '2026-01-04', number: 'PV-PENDING', total: 7 } },
      { id: 'legacy-expense', company_id: 'co', source: 'manual', document_state: 'legacy', total: 3,
        data: { type: 'Expense', status: 'Paid', date: '2026-01-04', description: 'Historical expense', total: 3 } },
      { id: 'invoice-from-quote', company_id: 'co', source: 'document', document_state: 'issued', total: 216,
        issued_at: new Date('2026-01-05T01:00:00Z'), issued_snapshot: { tax: 16 }, quote_id: 'legacy-quote-converted',
        data: { type: 'Invoice', status: 'Pending', number: 'INV-FROM-QUOTE' } },
      { id: 'draft-from-quote', company_id: 'co', source: 'document', document_state: 'draft', total: 216,
        quote_id: 'legacy-quote-converted', data: { type: 'Invoice', status: 'Draft', date: '2026-01-05', tax: 16 } },
    ],
    expenses: [{ id: 'expense-row', company_id: 'co', data: { amount: 5, date: '2026-01-05', description: 'Imported expense' } }],
    payments: [{ id: 'invoice-payment', company_id: 'co', amount: 216, paid_at: new Date('2026-01-05T02:00:00Z'), number: 'INV-FROM-QUOTE' }],
  };

  const report = companyReport(rows, '2026-01-03', '2026-01-05');
  assert.deepEqual(report.totals, { sales: 378, tax: 28, expenses: 27, cashIn: 270, cashOut: 20, cashFlow: 250, quoted: 79, convertedQuoted: 999 });
  assert.deepEqual(report.sales.map(row => row.id).sort(), ['invoice-from-quote', 'legacy-invoice-paid', 'legacy-invoice-pending']);
  assert.deepEqual(report.expenses.map(row => row.id).sort(), ['expense-row', 'legacy-expense', 'legacy-payment-voucher', 'legacy-payment-voucher-pending']);
  assert.deepEqual(report.receipts.map(row => row.id).sort(), ['invoice-payment', 'legacy-invoice-paid']);
  assert.deepEqual(report.quotes.map(row => row.id), ['legacy-quote-open', 'legacy-quote-converted']);
  assert.deepEqual(report.quotes.map(row => [row.id, row.converted]), [['legacy-quote-open', false], ['legacy-quote-converted', true]]);
  assert.equal(report.expenses.find(row => row.id === 'legacy-payment-voucher-pending').cashImpact, false);
  assert.doesNotMatch(JSON.stringify(report.sales), /legacy-quote-converted|draft-from-quote/);
});

test('a recent imported pending invoice appears as accrued sales but not cash', () => {
  const report = companyReport({ transactions: [{
    id: 'legacy-current-window', company_id: 'co', source: 'manual', document_state: 'legacy', total: 21.6,
    data: { type: 'Invoice', status: 'Pending', date: '2026-10-02', number: 'INV-CURRENT', tax: 1.6 },
  }] }, '2026-09-27', '2026-10-03');
  assert.deepEqual(report.totals, { sales: 21.6, tax: 1.6, expenses: 0, cashIn: 0, cashOut: 0, cashFlow: 0, quoted: 0, convertedQuoted: 0 });
  assert.deepEqual(report.sales.map(row => row.id), ['legacy-current-window']);
  assert.deepEqual(report.receipts, []);
});

test('credit expenses remain accrued while only paid expenses reduce cash', () => {
  const rows = { expenses: [
    { id: 'paid', company_id: 'co', amount_sen: 1250, status: 'paid', paid_by_type: 'petty_cash',
      data: { amount: 12.5, date: '2026-10-02', description: 'Paid supplies' } },
    { id: 'pending', company_id: 'co', amount_sen: 2075, status: 'pending', paid_by_type: 'credit', credit_due_date: '2026-11-01',
      data: { amount: 20.75, date: '2026-10-02', description: 'Supplier credit' } },
    { id: 'overdue', company_id: 'co', amount_sen: 725, status: 'pending', paid_by_type: 'credit', credit_due_date: '2026-10-01',
      data: { amount: 7.25, date: '2026-10-02', description: 'Overdue supplier credit' } },
  ] };
  const report = companyReport(rows, '2026-10-02', '2026-10-02');
  assert.deepEqual(report.totals, { sales: 0, tax: 0, expenses: 40.5, cashIn: 0, cashOut: 12.5,
    cashFlow: -12.5, quoted: 0, convertedQuoted: 0 });
  assert.deepEqual(report.expenses.map(row => [row.id, row.status, row.cashImpact]), [
    ['overdue', 'pending', false], ['paid', 'paid', true], ['pending', 'pending', false],
  ]);
  assert.deepEqual(report.daily[0], { date: '2026-10-02', sales: 0, tax: 0, expenses: 40.5,
    cashIn: 0, cashOut: 12.5, cashFlow: -12.5 });
});

test('credit settlement posts cash out in its own period without repeating accrual', () => {
  const rows = { expenses: [{ id: 'settled-credit', company_id: 'co', amount_sen: 4205, status: 'paid',
    paid_by_type: 'credit', credit_due_date: '2026-10-30', paid_on: '2026-10-02',
    data: { amount: 42.05, date: '2026-09-29', description: 'September stock on credit' } }] };
  const accrual = companyReport(rows, '2026-09-29', '2026-09-29');
  assert.deepEqual(accrual.totals, { sales: 0, tax: 0, expenses: 42.05, cashIn: 0, cashOut: 0,
    cashFlow: 0, quoted: 0, convertedQuoted: 0 });
  assert.deepEqual(accrual.expenses.map(row => [row.date, row.cashDate, row.accrualImpact, row.cashImpact]),
    [['2026-09-29', '2026-10-02', true, false]]);

  const settlement = companyReport(rows, '2026-10-02', '2026-10-02');
  assert.deepEqual(settlement.totals, { sales: 0, tax: 0, expenses: 0, cashIn: 0, cashOut: 42.05,
    cashFlow: -42.05, quoted: 0, convertedQuoted: 0 });
  assert.deepEqual(settlement.expenses.map(row => [row.date, row.cashDate, row.accrualImpact, row.cashImpact]),
    [['2026-09-29', '2026-10-02', false, true]]);
  assert.deepEqual(settlement.daily[0], { date: '2026-10-02', sales: 0, tax: 0, expenses: 0,
    cashIn: 0, cashOut: 42.05, cashFlow: -42.05 });
});

test('migrated invoices derive tax and expose only strict quote provenance', () => {
  const report = companyReport({ transactions: [
    { id: 'legacy-from-quote', company_id: 'co', source: 'manual', document_state: 'legacy', total: 3686.04,
      data: { type: 'Invoice', status: 'Pending', date: '2026-01-03', number: 'INV-00428', taxRate: 8,
        items: [{ desc: 'Service', qty: 1, price: 3013 }, { desc: 'Supplies', qty: 1, price: 400 }],
        history: [{ action: 'Generated from Quote QT-778487' }], notes: 'Private account 1234567890' } },
    { id: 'legacy-not-from-quote', company_id: 'co', source: 'manual', document_state: 'legacy', total: 108,
      data: { type: 'Invoice', status: 'Pending', date: '2026-01-03', number: 'INV-OTHER', subtotal: 100, tax_rate: 8,
        notes: 'Ask about Quote QT-PRIVATE before paying.' } },
    { id: 'legacy-note-provenance', company_id: 'co', source: 'manual', document_state: 'legacy', total: 25,
      data: { type: 'Invoice', status: 'Pending', date: '2026-01-03', number: 'INV-NOTE', taxRate: 0,
        notes: 'Converted from Quote QT-112233.' } },
  ] }, '2026-01-03', '2026-01-03');

  assert.equal(report.totals.tax, 281.04);
  const linked = report.sales.find(row => row.id === 'legacy-from-quote');
  assert.equal(linked.tax, 273.04);
  assert.equal(linked.kind, 'Historical invoice from quote');
  assert.equal(linked.fromQuote, true);
  assert.equal(linked.sourceQuoteNumber, 'QT-778487');
  const unrelated = report.sales.find(row => row.id === 'legacy-not-from-quote');
  assert.equal(unrelated.tax, 8);
  assert.equal(unrelated.fromQuote, false);
  assert.equal(unrelated.sourceQuoteNumber, undefined);
  const linkedByNote = report.sales.find(row => row.id === 'legacy-note-provenance');
  assert.equal(linkedByNote.fromQuote, true);
  assert.equal(linkedByNote.sourceQuoteNumber, 'QT-112233');
  assert.doesNotMatch(JSON.stringify(report), /Private account|1234567890|QT-PRIVATE/);
});

test('report queries bound each ordinary date source before materializing records', async () => {
  assert.deepEqual(reportDateBounds('2026-09-30', '2026-09-30'), { fromPad: '2026-09-29', toPad: '2026-10-01', toExclusive: '2026-10-01' });
  const calls = [];
  const client = { async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } };
  await companyRows(client, ['company-a'], '2026-09-30', '2026-09-30');
  assert.equal(calls.length, 3);
  const allParams = [['company-a'], '2026-09-30', '2026-09-30', '2026-09-29', '2026-10-01', '2026-10-01'];
  assert.deepEqual(calls[0].params, allParams);
  assert.deepEqual(calls[1].params, [['company-a'], '2026-09-29', '2026-10-01', '2026-09-30', '2026-09-30']);
  assert.deepEqual(calls[2].params, [['company-a'], '2026-09-30', '2026-10-01']);
  const transactions = calls[0].sql.split(' UNION ALL ');
  assert.equal(transactions.length, 4);
  assert.match(transactions[0], /businessDate' BETWEEN \$2 AND \$3/);
  assert.match(transactions[1], /issued_at >=/);
  assert.match(transactions[2], /date',10\).*BETWEEN \$4 AND \$5/);
  assert.match(transactions[3], /issued_at IS NULL.*!~/);
  const expenseBranches = calls[1].sql.split(' UNION ALL ');
  assert.equal(expenseBranches.length, 3);
  for (const branch of expenseBranches) {
    assert.match(branch, /WHERE company_id=ANY\(\$1::text\[\]\) AND voided_at IS NULL AND \([\s\S]+\)$/);
  }
  assert.match(expenseBranches[2], /paid_on BETWEEN \$4 AND \$5/);
  assert.match(calls[2].sql, /paid_at >=.*paid_at </s);
});

test('report queries fetch only classification metadata for referenced products', async () => {
  const calls = [];
  const responses = [
    { rows: [{ company_id: 'company-a', id: 'sale', data: { items: [{ productId: 'latte' }] } }] },
    { rows: [] },
    { rows: [{ company_id: 'company-a', id: 'payment', data: { items: [{ productId: 'service' }] } }] },
    { rows: [{ company_id: 'company-a', id: 'latte', category: 'Beverages', subcategory: 'Coffee' }] },
  ];
  const client = { async query(sql, params) { calls.push({ sql, params }); return responses[calls.length - 1]; } };
  const result = await companyRows(client, ['company-a'], '2026-10-01', '2026-10-01');
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[3].params, [['company-a'], ['latte', 'service']]);
  assert.match(calls[3].sql, /category.*subcategory/s);
  assert.doesNotMatch(calls[3].sql, /cost|price/i);
  assert.deepEqual(result.products, responses[3].rows);
});

test('malformed historical date strings cannot enter a valid daily report', () => {
  const rows = { transactions: [{ id: 'invalid', company_id: 'co', source: 'pos', document_state: 'issued', total: 5,
    data: { businessDate: '2026-02-30', date: '2026-02-30', tax: 0 } }] };
  assert.equal(companyReport(rows, '2026-02-01', '2026-03-01').totals.sales, 0);
});

test('sales dimensions filter accrual sales and attributable receipts without changing default accounting totals', () => {
  const invoiceSnapshot = { tax: 2, items: [{ productId: 'service', desc: 'Service', qty: 1, price: 30 }] };
  const rows = {
    transactions: [
      { id: 'pos-mixed', company_id: 'co', source: 'pos', document_state: 'issued', total: 15,
        data: { businessDate: '2026-10-01', number: 'POS-1', paymentMethod: 'Cash', tax: 1,
          items: [{ productId: 'latte', qty: 1, price: 10 }, { productId: 'tart', qty: 1, price: 5 }] } },
      { id: 'pos-qr', company_id: 'co', source: 'pos', document_state: 'issued', total: 20,
        data: { businessDate: '2026-10-01', number: 'POS-2', paymentMethod: 'QR Pay', tax: 1.2,
          items: [{ productId: 'tea', qty: 2, price: 10 }] } },
      { id: 'invoice', company_id: 'co', source: 'document', document_state: 'issued', total: 30,
        issued_at: new Date('2026-10-01T02:00:00Z'), issued_snapshot: invoiceSnapshot,
        data: { type: 'Invoice', number: 'INV-1' } },
      { id: 'quote', company_id: 'co', source: 'document', document_state: 'issued', total: 50,
        issued_at: new Date('2026-10-01T03:00:00Z'), issued_snapshot: { items: invoiceSnapshot.items },
        data: { type: 'Quote', number: 'QT-1', status: 'Issued' } },
    ],
    expenses: [{ id: 'expense', company_id: 'co', data: { amount: 5, date: '2026-10-01', description: 'Rent' } }],
    payments: [{ id: 'invoice-payment', document_id: 'invoice', company_id: 'co', amount: 12,
      method: 'Bank transfer', paid_at: new Date('2026-10-01T04:00:00Z'), number: 'INV-1',
      data: { type: 'Invoice', number: 'INV-1' }, issued_snapshot: invoiceSnapshot }],
    products: [
      { company_id: 'co', id: 'latte', category: 'Beverages', subcategory: 'Coffee' },
      { company_id: 'co', id: 'tart', category: 'Pastry', subcategory: 'Baked' },
      { company_id: 'co', id: 'tea', category: 'Beverages', subcategory: 'Tea' },
      { company_id: 'co', id: 'service', category: 'Services', subcategory: 'Consulting', cost: 999 },
    ],
  };
  const unfiltered = companyReport(rows, '2026-10-01', '2026-10-01');
  assert.deepEqual(unfiltered.totals, { sales: 65, tax: 4.2, expenses: 5, cashIn: 47,
    cashOut: 5, cashFlow: 42, quoted: 50, convertedQuoted: 0 });
  assert.equal(unfiltered.filterActive, false);
  assert.deepEqual(unfiltered.breakdowns.channel.map(row => [row.value, row.sales, row.cashIn]),
    [['pos', 35, 35], ['invoice', 30, 12]]);
  assert.equal(unfiltered.breakdowns.paymentMethod.reduce((total, row) => total + Math.round(row.sales * 100), 0), 6500);
  assert.equal(unfiltered.breakdowns.paymentMethod.reduce((total, row) => total + Math.round(row.cashIn * 100), 0), 4700);
  assert.deepEqual(unfiltered.breakdowns.category.map(row => [row.value, row.sales, row.tax, row.cashIn]), [
    ['Beverages', 30, 1.87, 30], ['Services', 30, 2, 12], ['Pastry', 5, .33, 5],
  ]);
  assert.deepEqual(unfiltered.filterOptions.categories.map(option => option.value), ['Beverages', 'Pastry', 'Services']);
  assert.deepEqual(unfiltered.filterOptions.paymentMethods.map(option => option.value),
    ['Bank transfer', 'Cash', 'On account', 'QR Pay']);
  assert.doesNotMatch(JSON.stringify(unfiltered), /"cost"|999/);

  const beverages = companyReport(rows, '2026-10-01', '2026-10-01', { category: 'beverages' });
  assert.deepEqual(beverages.totals, { sales: 30, tax: 1.87, expenses: 5, cashIn: 30,
    cashOut: 5, cashFlow: 25, quoted: 0, convertedQuoted: 0 });
  assert.equal(beverages.sales.find(row => row.id === 'pos-mixed').total, 10);
  assert.equal(beverages.sales.find(row => row.id === 'pos-mixed').documentTotal, 15);
  assert.deepEqual(beverages.sales.flatMap(row => row.categories), ['Beverages', 'Beverages']);
  assert.match(beverages.filterScope, /Expenses and cash out remain company-wide/);

  const invoice = companyReport(rows, '2026-10-01', '2026-10-01', { channel: 'invoice' });
  assert.deepEqual(invoice.totals, { sales: 30, tax: 2, expenses: 5, cashIn: 12,
    cashOut: 5, cashFlow: 7, quoted: 50, convertedQuoted: 0 });
  const transfer = companyReport(rows, '2026-10-01', '2026-10-01', { paymentMethod: 'bank TRANSFER' });
  assert.deepEqual(transfer.totals, { sales: 0, tax: 0, expenses: 5, cashIn: 12,
    cashOut: 5, cashFlow: 7, quoted: 0, convertedQuoted: 0 });
  const coffee = companyReport(rows, '2026-10-01', '2026-10-01', { subcategory: 'Coffee' });
  assert.equal(coffee.totals.sales, 10);
  assert.equal(coffee.totals.tax, .67);
});

test('report filter query accepts bounded dimensions and rejects unknown or oversized input', () => {
  const valid = reportQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-02', channel: 'pos',
    paymentMethod: 'Cash', category: 'Beverages', subcategory: 'Coffee' });
  assert.equal(valid.success, true);
  assert.equal(reportQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-02', channel: 'delivery' }).success, false);
  assert.equal(reportQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-02', category: 'x'.repeat(121) }).success, false);
  assert.equal(reportQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-02', surprise: 'value' }).success, false);
});

test('product allocation preserves reversing-entry cents', () => {
  const rows = {
    transactions: [{ id: 'refund', company_id: 'co', source: 'pos', document_state: 'issued', total: -10.01,
      data: { businessDate: '2026-10-01', number: 'REFUND-1', paymentMethod: 'Cash', tax: -.71,
        items: [{ productId: 'latte', qty: -1, price: 6 }, { productId: 'tart', qty: -1, price: 4 }] } }],
    products: [
      { company_id: 'co', id: 'latte', category: 'Beverages', subcategory: 'Coffee' },
      { company_id: 'co', id: 'tart', category: 'Pastry', subcategory: 'Baked' },
    ],
  };
  const report = companyReport(rows, '2026-10-01', '2026-10-01');
  assert.equal(report.breakdowns.category.reduce((total, row) => total + cents(row.sales), 0), -1001);
  assert.equal(report.breakdowns.category.reduce((total, row) => total + cents(row.tax), 0), -71);
  assert.equal(companyReport(rows, '2026-10-01', '2026-10-01', { category: 'Beverages' }).totals.sales, -6.01);
});
