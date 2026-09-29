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
  assert.deepEqual(report.totals, { sales: 31.8, tax: 1.8, expenses: 5.25, cashFlow: 10.35 });
  assert.equal(report.sales.length, 2);
  assert.equal(report.expenses.length, 2);
  assert.equal(report.receipts.length, 2);
  assert.doesNotMatch(JSON.stringify(report), /"cost"|"margin"|"profit"/i);
  assert.deepEqual(companyReport(rows, '2026-10-01', '2026-10-01').totals, { sales: 0, tax: 0, expenses: 0, cashFlow: 0 });
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
