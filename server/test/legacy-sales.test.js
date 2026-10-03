import test from 'node:test';
import assert from 'node:assert/strict';
import { recordVisible, recordOutput } from '../src/access.js';

test('legacy issued invoices remain visible to managers but never operators', () => {
  const row = { id: 'legacy-sale', company_id: 'company', source: 'legacy', document_state: 'legacy', total: 19.95, data: { type: 'Invoice', status: 'Paid', total: 19.95, customerName: 'Customer' } };
  const manager = { id: 'manager', role: 'manager', company_id: 'company' };
  const operator = { id: 'operator', role: 'operator', company_id: 'company' };
  assert.equal(recordVisible(row, manager), true);
  assert.equal(recordVisible(row, operator), false);
  assert.equal(recordOutput(row, manager).total, 19.95);
  assert.equal(recordOutput(row, manager).paidAmount, 19.95);
  assert.equal(recordOutput(row, manager).outstandingAmount, 0);
  const pending = { ...row, data: { ...row.data, status: 'Pending' } };
  assert.equal(recordVisible(pending, manager), true);
  assert.equal(recordOutput(pending, manager).paidAmount, 0);
  assert.equal(recordOutput(pending, manager).outstandingAmount, 19.95);
  const partial = { ...row, data: { ...row.data, status: 'Partially paid', paidAmount: 5 } };
  assert.equal(recordOutput(partial, manager).paidAmount, 5);
  assert.equal(recordOutput(partial, manager).outstandingAmount, 14.95);
  assert.equal(recordVisible({ ...row, data: { ...row.data, type: 'Expense' } }, manager), false);
});
