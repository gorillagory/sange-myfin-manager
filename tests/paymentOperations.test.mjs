import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  defaultPaymentOperationsRange, formatSen, paymentOperationsQuery, paymentReasonLabel,
} from '../src/domain/paymentOperations.js';

test('payment operations formatting preserves exact integer sen beyond Number precision', () => {
  assert.equal(formatSen('9007199254741000', 'MYR'), 'RM 90071992547410.00');
  assert.equal(formatSen('-5', 'MYR'), '−RM 0.05');
  assert.equal(formatSen('1991', 'USD'), 'USD 19.91');
  assert.equal(paymentReasonLabel('provider_total_mismatch'), 'Provider total mismatch');
  assert.equal(paymentReasonLabel('details_withheld'), 'Provider detail withheld; review the source system');
});

test('payment operations range and query use explicit local calendar dates', () => {
  assert.deepEqual(defaultPaymentOperationsRange(new Date(2026, 9, 9, 23, 58)), {
    from:'2026-10-01', to:'2026-10-09',
  });
  const query = new URLSearchParams(paymentOperationsQuery({
    from:'2026-10-01', to:'2026-10-09', provider:'gokoo', status:'mismatch',
  }));
  assert.equal(query.get('from'), '2026-10-01');
  assert.equal(query.get('to'), '2026-10-09');
  assert.equal(query.get('provider'), 'gokoo');
  assert.equal(query.get('status'), 'mismatch');
  assert.throws(() => paymentOperationsQuery({ from:'09/10/2026', to:'2026-10-09' }), /valid_date_range/);
});

test('payment operations screen is manager-oriented, read-only and explicit about evidence boundaries', async () => {
  const component = await readFile(new URL('../src/components/dashboard/PaymentOperationsTab.vue', import.meta.url), 'utf8');
  assert.match(component, /Store\.can\('financialReports'\)/);
  assert.match(component, /Imported provider transactions/);
  assert.match(component, /Reconciliation/);
  assert.match(component, /Collection methods/);
  assert.match(component, /Gokoo stays disabled/);
  assert.match(component, /Secrets remain outside MyFin/);
  assert.doesNotMatch(component, /method:\s*['"](?:POST|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(component, /credentialRef|externalAccountId|rawPayload/);
});
