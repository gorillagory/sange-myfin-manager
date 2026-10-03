import test from 'node:test';
import assert from 'node:assert/strict';
import { companyReport, companyRows, reportDateBounds } from '../src/reporting.js';

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
  assert.deepEqual(calls[1].params, [['company-a'], '2026-09-29', '2026-10-01']);
  assert.deepEqual(calls[2].params, [['company-a'], '2026-09-30', '2026-10-01']);
  const transactions = calls[0].sql.split(' UNION ALL ');
  assert.equal(transactions.length, 4);
  assert.match(transactions[0], /businessDate' BETWEEN \$2 AND \$3/);
  assert.match(transactions[1], /issued_at >=/);
  assert.match(transactions[2], /date',10\).*BETWEEN \$4 AND \$5/);
  assert.match(transactions[3], /issued_at IS NULL.*!~/);
  assert.equal(calls[1].sql.split(' UNION ALL ').length, 2);
  assert.match(calls[2].sql, /paid_at >=.*paid_at </s);
});

test('malformed historical date strings cannot enter a valid daily report', () => {
  const rows = { transactions: [{ id: 'invalid', company_id: 'co', source: 'pos', document_state: 'issued', total: 5,
    data: { businessDate: '2026-02-30', date: '2026-02-30', tax: 0 } }] };
  assert.equal(companyReport(rows, '2026-02-01', '2026-03-01').totals.sales, 0);
});
