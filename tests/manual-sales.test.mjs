import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { documentCollectedAmount, documentOutstandingAmount } from '../src/domain/documents.js';
import { businessDateTimeInput, manualSaleEarliestInput, manualSaleOccurredAt } from '../src/domain/manualSales.js';

const modalFilename = new URL('../src/components/dashboard/finance/ManualSaleModal.vue', import.meta.url);
const salesFilename = new URL('../src/components/dashboard/finance/FinanceSales.vue', import.meta.url);
const analyticsFilename = new URL('../src/components/dashboard/AnalyticsTab.vue', import.meta.url);
const modalSource = await readFile(modalFilename, 'utf8');
const salesSource = await readFile(salesFilename, 'utf8');
const analyticsSource = await readFile(analyticsFilename, 'utf8');

test('manual sale entry compiles and exposes fixed occurrence, payment and inventory facts', () => {
  const parsed = parse(modalSource, { filename: modalFilename.pathname });
  assert.deepEqual(parsed.errors, []);
  const script = compileScript(parsed.descriptor, { id: 'manual-sale-entry-test' });
  const template = compileTemplate({ source: parsed.descriptor.template.content,
    filename: modalFilename.pathname, id: 'manual-sale-entry-test',
    compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  assert.match(modalSource, /inventoryPolicy: 'deduct_current_stock_and_recipe'/);
  assert.match(modalSource, /Current catalog prices and tax are review defaults/);
  assert.match(modalSource, /Actual unit price/);
  assert.match(modalSource, /Actual tax rate/);
  assert.match(modalSource, /pricingOverrideReason/);
  assert.match(modalSource, /taxRate: currentTaxRate\.value/);
  assert.match(modalSource, /line\.unitPrice = .*catalogPrice\(line\)/);
  assert.match(modalSource, /pricingChanged\.value \|\| form\.pricingOverrideReason\.trim\(\)\.length >= 8/);
  assert.match(modalSource, /unitPrice: Number\(line\.unitPrice\)/);
  assert.match(modalSource, /Saving posts an immutable financial and inventory record/);
  assert.match(modalSource, /Current product stock and the current active recipe are deducted/);
  assert.match(modalSource, /paymentStatus: 'Paid'/);
  assert.match(modalSource, /The sale must already be paid/);
  assert.match(modalSource, /Use Quotes &amp; Invoices for unpaid or on-account sales/);
  assert.doesNotMatch(modalSource, /<option>Credit<\/option>/);
  assert.match(modalSource, /manualSaleOccurredAt\(form\.occurredAt\)/);
  assert.match(modalSource, /Malaysia time\. This date drives sales and tax reporting/);
  assert.match(modalSource, /:min="minOccurred"/);
  assert.match(modalSource, /filter\(product => product\.active !== false\)/);
  assert.match(modalSource, /product_inactive: 'This product is inactive/);
});

test('manual sale calendar input is interpreted in the business timezone', () => {
  assert.equal(manualSaleOccurredAt('2026-10-13T01:30'), '2026-10-12T17:30:00.000Z');
  assert.equal(businessDateTimeInput('2026-10-12T17:30:00.000Z'), '2026-10-13T01:30');
  assert.equal(manualSaleEarliestInput('2026-10-13T04:00:00.000Z'), '2026-10-06T00:00');
  assert.throws(() => manualSaleOccurredAt('2026-02-30T12:00'), /valid Malaysia sale date/);
});

test('analytics labels recorded-later sales and receipts as their own channel', () => {
  assert.match(analyticsSource, /item\.channel === 'manual' \? 'Recorded later'/);
  assert.equal((analyticsSource.match(/\{\{ channelLabel\(item\) \}\}/g) || []).length, 2);
  assert.doesNotMatch(analyticsSource, /item\.channel==='pos'\?'POS':'Invoice'/);
});

test('sales view clearly distinguishes recorded-later sales from checkout receipts', () => {
  assert.match(salesSource, /\['pos', 'manual_sale'\]\.includes\(row\.source\)/);
  assert.match(salesSource, /row\.source === 'manual_sale' \? 'Recorded later'/);
  assert.match(salesSource, /Store\.can\('manualSalesCreate'\)/);
});

test('paid recorded sales are fully collected', () => {
  const paid = { source: 'manual_sale', type: 'Invoice', status: 'Paid', paymentStatus: 'Paid', total: 19.95 };
  assert.equal(documentCollectedAmount(paid), 19.95);
  assert.equal(documentOutstandingAmount(paid), 0);
});
