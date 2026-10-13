import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { companyReport } from '../src/reporting.js';
import { manualSaleId, manualSaleInput, recordManualSale } from '../src/manual-sales.js';
import { parse } from '../src/validation.js';

const manager = { id: 'manager-a', uid: 'manager-a', username: 'Manager', role: 'manager' };
const company = { id: 'shop-a', name: 'Shop', data: {
  address: 'Address', phone: '123', registration: 'REG', preferences: { currency: 'RM', taxRate: 6 },
} };
const productRow = { id: 'coffee', company_id: company.id, version: 1, data: {
  id: 'coffee', name: 'Coffee', sku: 'COF-1', price: 10, cost: 4,
  stock: 5, trackStock: true, variants: [], unit: 'cup',
} };
const input = {
  idempotencyKey: 'manual-test-request-1', occurredAt: '2026-10-12T17:15:00.000Z',
  paymentStatus: 'Paid', paymentMethod: 'Cash', paymentReference: '',
  customerId: '', discount: 0, recordingReason: 'Busy counter batch entry',
  taxRate: 6, pricingOverrideReason: '',
  inventoryPolicy: 'deduct_current_stock_and_recipe',
  items: [{ productId: 'coffee', variantId: '', quantity: 2, unitPrice: 10 }],
};

test('manual sale contract accepts operational facts and rejects caller supplied prices or totals', () => {
  assert.equal(parse(manualSaleInput, input).items[0].quantity, 2);
  assert.throws(() => parse(manualSaleInput, { ...input, total: 1 }), /invalid_input/);
  assert.throws(() => parse(manualSaleInput, { ...input,
    items: [{ productId: 'coffee', variantId: '', quantity: 2, unitPrice: 1, price: 1 }] }), /invalid_input/);
  assert.throws(() => parse(manualSaleInput, { ...input,
    paymentStatus: 'Credit', paymentMethod: 'Credit' }), /invalid_input/);
  assert.equal(manualSaleId('shop-a', 'manual-test-request-1'),
    manualSaleId('shop-a', 'manual-test-request-1'));
  assert.notEqual(manualSaleId('shop-a', 'manual-test-request-1'),
    manualSaleId('shop-b', 'manual-test-request-1'));
});

test('only managers and owners can record a sale after the fact', async () => {
  await assert.rejects(recordManualSale({ query: async () => { throw Error('database should not run'); } },
    { ...manager, role: 'operator' }, company.id, input, async () => {}),
  error => error.statusCode === 403 && error.message === 'access_denied');
});

test('late sale uses reviewed historical pricing while snapshotting catalog facts and preserving stock evidence', async () => {
  const calls = [], effects = [];
  const client = { query: async (sql, args = []) => {
    calls.push({ sql, args });
    if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
    if (sql.includes('FROM myfin.transactions')) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM myfin.products')) return { rowCount: 1, rows: [structuredClone(productRow)] };
    if (sql.includes('FROM myfin.companies')) return { rowCount: 1, rows: [company] };
    return { rowCount: 1, rows: [] };
  } };
  const options = {
    serverNow: '2026-10-13T04:00:00.000Z',
    assertUnreservedSaleStock: async (_c, co, rows, items) => effects.push(['reservations', co, rows.length, items.length]),
    assertOrderCreated: async (_c, co, id) => effects.push(['order', co, id]),
    consumeRecipeStock: async (_c, value) => effects.push(['recipe', value.saleId, value.capturedAt]),
  };
  const reviewedInput = { ...input, taxRate: 5, pricingOverrideReason: 'Original happy-hour receipt',
    items: [{ ...input.items[0], unitPrice: 8.5 }] };
  const saved = await recordManualSale(client, manager, company.id, reviewedInput,
    async (_c, who, co, action, details, id) => effects.push(['audit', who.id, co, action, details, id]), options);
  assert.equal(saved.source, 'manual_sale');
  assert.equal(saved.recordingMode, 'manual_backdated');
  assert.equal(saved.date, reviewedInput.occurredAt);
  assert.equal(saved.businessDate, '2026-10-13');
  assert.equal(saved.recordedAt, options.serverNow);
  assert.equal(saved.recordedById, manager.id);
  assert.equal(saved.subtotal, 17);
  assert.equal(saved.taxRate, 5);
  assert.equal(saved.tax, .85);
  assert.equal(saved.totalBeforeRounding, 17.85);
  assert.equal(saved.total, 17.85);
  assert.equal(saved.currentTaxRateAtRecording, 6);
  assert.equal(saved.pricingOverridden, true);
  assert.equal(saved.pricingOverrideReason, reviewedInput.pricingOverrideReason);
  assert.equal(saved.pricingPolicy, 'reviewed_historical_price_with_catalog_snapshot');
  assert.equal(saved.paymentStatus, 'Paid');
  assert.equal(saved.inventoryPolicy, 'deduct_current_stock_and_recipe');
  assert.equal(saved.recipePolicy, 'current_recipe_at_recording');
  const insert = calls.find(call => call.sql.includes('INSERT INTO myfin.transactions'));
  assert.equal(insert.args[3], 17.85);
  assert.equal(insert.args[5].items[0].price, 8.5);
  assert.equal(insert.args[5].items[0].catalogPrice, 10);
  assert.equal(insert.args[5].items[0].cost, 4);
  assert.match(insert.args[4], /^[a-f0-9]{64}$/);
  const stockUpdate = calls.find(call => call.sql.includes('UPDATE myfin.products'));
  assert.equal(stockUpdate.args[3], 3);
  assert.ok(effects.some(effect => effect[0] === 'order'));
  assert.ok(effects.some(effect => effect[0] === 'recipe' && effect[2] === reviewedInput.occurredAt));
  assert.ok(effects.some(effect => effect[0] === 'audit' && effect[3] === 'Record backdated sale'
    && effect[4].includes(reviewedInput.pricingOverrideReason)));
  const report = companyReport({ transactions: [{ id: saved.id, company_id: company.id,
    source: 'manual_sale', total: saved.total, document_state: 'legacy', data: saved }],
    expenses: [], payments: [], products: [] }, saved.businessDate, saved.businessDate);
  assert.equal(report.totals.sales, 17.85);
  assert.equal(report.totals.tax, .85);

  await assert.rejects(recordManualSale(client, manager, company.id, {
    ...input, idempotencyKey: 'manual-test-request-2',
    items: [{ ...input.items[0], unitPrice: 8.5 }], pricingOverrideReason: '',
  }, async () => {}, options),
  error => error.statusCode === 400 && error.message === 'manual_sale_pricing_reason_required');
  await assert.rejects(recordManualSale(client, manager, company.id, {
    ...input, idempotencyKey: 'manual-test-request-3', taxRate: 5, pricingOverrideReason: '',
  }, async () => {}, options),
  error => error.statusCode === 400 && error.message === 'manual_sale_pricing_reason_required');
});

test('manual sales are limited to the recent business-date correction window', async () => {
  await assert.rejects(recordManualSale({ query: async () => { throw Error('database should not run'); } },
    manager, company.id, { ...input, occurredAt: '2026-10-05T04:00:00.000Z' }, async () => {},
    { serverNow: '2026-10-13T04:00:00.000Z' }),
  error => error.statusCode === 400 && error.message === 'manual_sale_backdate_limit');
});

test('the idempotency key replays the same immutable sale and rejects changed intent', async () => {
  let row;
  const firstClient = { query: async (sql, args = []) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
    if (sql.includes('FROM myfin.transactions')) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM myfin.products')) return { rowCount: 1, rows: [structuredClone(productRow)] };
    if (sql.includes('FROM myfin.companies')) return { rowCount: 1, rows: [company] };
    if (sql.includes('INSERT INTO myfin.transactions')) row = { company_id: args[0], id: args[1], actor_id: args[2],
      source: 'manual_sale', total: args[3], fingerprint: args[4], data: args[5], document_state: 'legacy' };
    return { rowCount: 1, rows: [] };
  } };
  const dependencies = { serverNow: '2026-10-13T04:00:00.000Z',
    assertUnreservedSaleStock: async () => {}, assertOrderCreated: async () => {}, consumeRecipeStock: async () => {} };
  await recordManualSale(firstClient, manager, company.id, input, async () => {}, dependencies);
  let afterLookup = 0;
  const replayClient = { query: async sql => {
    if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
    if (sql.includes('FROM myfin.transactions')) return { rowCount: 1, rows: [row] };
    afterLookup++; throw Error(`unexpected query: ${sql}`);
  } };
  const replayed = await recordManualSale(replayClient, manager, company.id, input, async () => {}, dependencies);
  assert.equal(replayed.id, row.id);
  assert.equal(afterLookup, 0);
  await assert.rejects(recordManualSale(replayClient, manager, company.id,
    { ...input, recordingReason: 'A different explanation' }, async () => {}, dependencies),
  error => error.statusCode === 409 && error.message === 'manual_sale_idempotency_key_reused');
});

test('paid manual sales count as sales and cash on their occurrence date', () => {
  const row = { id: 'manual-paid', company_id: 'shop-a', source: 'manual_sale', total: 10.6,
    document_state: 'legacy', data: { source: 'manual_sale', type: 'Invoice', status: 'Paid',
      paymentStatus: 'Paid', paymentMethod: 'Cash', number: 'MAN-1', customerName: 'Walk-in customer',
      businessDate: '2026-10-12', date: '2026-10-12T03:00:00.000Z', total: 10.6, tax: .6,
      items: [{ productId: 'coffee', qty: 1, price: 10 }] } };
  const report = companyReport({ transactions: [row], expenses: [], payments: [], products: [] },
    '2026-10-12', '2026-10-12');
  assert.equal(report.totals.sales, 10.6);
  assert.equal(report.totals.tax, .6);
  assert.equal(report.totals.cashIn, 10.6);
  assert.equal(report.sales[0].kind, 'Recorded sale');
  assert.equal(report.sales[0].channel, 'manual');
});

test('manual-sale migration protects facts and creates completed order history', async () => {
  const sql = await readFile(new URL('../../db/migrations/0033_manual_sales.sql', import.meta.url), 'utf8');
  assert.match(sql, /source IN \('manual','pos','manual_sale'\)/);
  assert.match(sql, /fingerprint IS NOT NULL AND fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /IF OLD\.source='manual_sale' THEN\s+RAISE EXCEPTION 'posted_sale_immutable'/);
  assert.match(sql, /NEW\.source NOT IN \('pos','manual_sale'\)/);
  assert.match(sql, /WHEN NEW\.source='manual_sale' THEN 'completed'/);
  assert.match(sql, /Sale was recorded after fulfillment/);
});
