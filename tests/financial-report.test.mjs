import test from 'node:test';
import assert from 'node:assert/strict';
import { reportRange, reportBuckets, reportBucketLabel } from '../src/domain/financialReport.js';
import { documentCollectedAmount, documentOutstandingAmount } from '../src/domain/documents.js';

test('report intervals retain cent-exact totals across day, ISO week and month', () => {
  const daily = [
    { date: '2026-08-31', sales: 10.01, tax: 0.6, expenses: 1.11, cashIn: 10.01, cashOut: 1.11, cashFlow: 8.9 },
    { date: '2026-09-01', sales: 20.02, tax: 1.2, expenses: 2.22, cashIn: 20.02, cashOut: 2.22, cashFlow: 17.8 },
    { date: '2026-09-07', sales: 30.03, tax: 1.8, expenses: 3.33, cashIn: 30.03, cashOut: 3.33, cashFlow: 26.7 },
  ];
  const day = reportBuckets(daily, 'day');
  const week = reportBuckets(daily, 'week');
  const month = reportBuckets(daily, 'month');
  assert.equal(day.length, 3);
  assert.deepEqual(week.map(row => [row.key, row.from, row.to, row.sales]), [
    ['2026-08-31', '2026-08-31', '2026-09-01', 30.03],
    ['2026-09-07', '2026-09-07', '2026-09-07', 30.03],
  ]);
  assert.deepEqual(month.map(row => [row.key, row.sales]), [['2026-08', 10.01], ['2026-09', 50.05]]);
  assert.deepEqual(month.map(row => [row.key, row.cashIn, row.cashOut]), [['2026-08', 10.01, 1.11], ['2026-09', 50.05, 5.55]]);
  assert.equal(reportBucketLabel(week[0], 'week'), 'Week of 2026-08-31');
});

test('report range rejects reversed, invalid and excessive dates', () => {
  assert.equal(reportRange('2026-09-01', '2026-09-30'), '');
  assert.match(reportRange('2026-02-30', '2026-03-01'), /valid/);
  assert.match(reportRange('2026-09-30', '2026-09-01'), /end date/);
  assert.match(reportRange('2025-01-01', '2026-09-01'), /range/);
});

test('document collections and balances include migrated paid, pending and partial invoices', () => {
  const paid = { type: 'Invoice', documentState: 'legacy', status: 'Paid', total: 19.95 };
  const pending = { ...paid, status: 'Pending' };
  const partial = { ...paid, status: 'Partially paid', paidAmount: 5 };
  assert.deepEqual([documentCollectedAmount(paid), documentOutstandingAmount(paid)], [19.95, 0]);
  assert.deepEqual([documentCollectedAmount(pending), documentOutstandingAmount(pending)], [0, 19.95]);
  assert.deepEqual([documentCollectedAmount(partial), documentOutstandingAmount(partial)], [5, 14.95]);
});
