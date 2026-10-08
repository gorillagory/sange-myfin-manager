import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsFilterLabels, analyticsReportQuery, analyticsSubcategoryOptions } from '../src/domain/analyticsFilters.js';

const options = {
  channels: [{ value: 'pos', label: 'POS' }, { value: 'invoice', label: 'Invoice' }],
  paymentMethods: [{ value: 'QR Pay', label: 'QR Pay' }],
  categories: [{ value: 'Beverages', label: 'Beverages' }, { value: 'Pastry', label: 'Pastry' }],
  subcategories: [
    { value: 'Coffee', label: 'Coffee', category: 'Beverages' },
    { value: 'Baked', label: 'Baked', category: 'Pastry' },
  ],
};

test('analytics query includes only selected bounded dimensions', () => {
  const query = analyticsReportQuery('2026-10-01', '2026-10-09', {
    channel: 'pos', paymentMethod: 'QR Pay', category: '', subcategory: 'Coffee', ignored: 'private',
  });
  assert.equal(query.toString(), 'from=2026-10-01&to=2026-10-09&channel=pos&paymentMethod=QR+Pay&subcategory=Coffee');
});

test('analytics category choices and applied labels use server metadata', () => {
  assert.deepEqual(analyticsSubcategoryOptions(options, 'beverages').map(option => option.value), ['Coffee']);
  assert.equal(analyticsSubcategoryOptions(options).length, 2);
  assert.deepEqual(analyticsFilterLabels({ channel: 'pos', paymentMethod: 'qr pay', category: 'beverages' }, options),
    ['Channel: POS', 'Payment: QR Pay', 'Category: Beverages']);
});
