// Characterization audit: REPRODUCED means a defect is present, not that the POS is safe.
// Runs source logic against in-memory doubles. Never imports Firebase or contacts a database.
// Usage: node scripts/audit-pos-readiness.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const observations = [];
const computed = get => ({ get value() { return get(); } });
const ref = value => ({ value });
const clone = value => JSON.parse(JSON.stringify(value));
const posFile = 'src/components/dashboard/PosTab.vue';
const inertConsole = { log() {}, warn() {}, error() {} };

function load(file, bindings, exports) {
  const source = read(file);
  const body = file.endsWith('.vue') ? source.match(/<script setup>([\s\S]*?)<\/script>/)[1] : source;
  const code = body.replace(/^import\s[\s\S]*?\bfrom\s+['"][^'"]+['"];?[^\r\n]*/gm, '').replace(/\bexport\s+(?=const|function)/g, '');
  const context = vm.createContext({ ref, computed, reactive: v => v, console: inertConsole, ...bindings });
  return vm.runInContext(`${code}\n;({${exports.join(',')}})`, context, { filename: file, timeout: 1000 });
}

function database({ reject = false, hold = false } = {}) {
  const records = new Map();
  const calls = [];
  const pending = [];
  const persist = async (operation, target, data) => {
    calls.push({ operation, target, data: clone(data) });
    if (reject) throw new Error('simulated permission-denied');
    if (hold) await new Promise(resolve => pending.push(resolve));
    records.set(target, clone(data));
  };
  return {
    records, calls, pending,
    bindings: {
      db: {}, collection: (_, name) => name, doc: (_, name, id) => `${name}/${id}`,
      setDoc: (target, data) => persist('set', target, data),
      addDoc: (target, data) => persist('add', `${target}/auto-${calls.length}`, data),
      updateDoc: (target, data) => persist('update', target, data),
      deleteDoc: async target => { calls.push({ operation: 'delete', target }); records.delete(target); },
      writeBatch: () => { throw new Error('Unexpected batch in sale path'); }
    }
  };
}

function setup(db = database(), clock) {
  const notifications = [];
  const state = {
    selectedCompany: { id: 'shop-a', preferences: {} }, currentUser: { id: 'cashier-a', username: 'Cashier' },
    products: [], transactions: [], expenses: [], clients: [], activities: [], preferences: { theme: 'light' }
  };
  const Store = { state, notify: (...args) => notifications.push(args), logActivity() {}, canDelete: () => true };
  const { financeModule } = load('src/store/finance.js', db.bindings, ['financeModule']);
  Store.financeModule = financeModule;
  Store.addTransaction = tx => financeModule.addTransaction(Store, tx);
  Store.updateTransaction = tx => financeModule.updateTransaction(Store, tx);
  Store.deleteTransaction = id => financeModule.deleteTransaction(Store, id);
  const pos = load(posFile, { Store, ...(clock ? { Date: clock } : {}) }, [
    'cart', 'heldCarts', 'showPayment', 'showSuccess', 'totals', 'recentSales',
    'handleAddToCart', 'addItem', 'addVariant', 'confirmHoldCart', 'handleCompleteSale', 'printReceipt'
  ]);
  return { db, Store, pos, notifications };
}

const product = (overrides = {}) => ({ id: 'product-a', company_id: 'shop-a', name: 'Example', price: 10, stock: 5, unit: 'pcs', trackStock: true, ...overrides });
const cash = { method: 'Cash', received: 20, change: 10 };
async function check(id, title, run) {
  try {
    const evidence = await run();
    observations.push({ id, title, result: 'REPRODUCED', evidence });
  } catch (error) {
    observations.push({ id, title, result: 'NOT_REPRODUCED_OR_HARNESS_ERROR', error: error.message });
    process.exitCode = 1;
  }
}

await check('POS-01', 'Rejected save still clears cart and shows success', async () => {
  const s = setup(database({ reject: true }));
  s.pos.addItem(product());
  await s.pos.handleCompleteSale(cash);
  assert.equal(s.db.records.size, 0);
  assert.equal(s.pos.cart.value.length, 0);
  assert.equal(s.pos.showSuccess.value, true);
  return { records: 0, cartItems: 0, successShown: true, notifications: s.notifications };
});

await check('POS-02', 'Sale writes no inventory and drops item identity and tender details', async () => {
  const s = setup();
  s.pos.addItem(product());
  await s.pos.handleCompleteSale(cash);
  assert.equal(s.db.calls.length, 1);
  const tx = s.db.calls[0].data;
  assert.ok(s.db.calls.every(c => c.target.startsWith('transactions/')));
  assert.equal(tx.items[0].productId, undefined);
  assert.equal(tx.cashReceived, undefined);
  assert.equal(tx.items[0].unit, 'Unit');
  return { writeTargets: s.db.calls.map(c => c.target), itemFields: Object.keys(tx.items[0]), transactionFields: Object.keys(tx) };
});

await check('POS-03', 'Success receipt handler throws without a transaction', () => {
  const s = setup();
  assert.match(read('src/components/dashboard/pos/PosSuccessModal.vue'), /\$emit\('print'\)/);
  assert.throws(() => s.pos.printReceipt(), /number/);
  return 'The success modal emits no payload; printReceipt reads tx.number.';
});

await check('POS-04', 'Analytics excludes a completed POS sale', async () => {
  const s = setup();
  s.pos.addItem(product());
  await s.pos.handleCompleteSale(cash);
  s.Store.state.transactions = [...s.db.records.values()];
  const analytics = load('src/components/dashboard/AnalyticsTab.vue', { Store: s.Store }, ['getDailyStats']);
  const result = analytics.getDailyStats(new Date());
  assert.equal(result.revenue, 0);
  assert.equal(result.count, 0);
  return { savedStatus: s.Store.state.transactions[0].status, savedTotal: 10, reportedRevenue: result.revenue };
});

await check('POS-05', 'Two terminals in the same millisecond overwrite one sale', async () => {
  class FixedDate extends Date { static now() { return 1800000000123; } }
  const db = database();
  const first = setup(db, FixedDate);
  const second = setup(db, FixedDate);
  first.pos.addItem(product({ price: 10 }));
  second.pos.addItem(product({ price: 25 }));
  await Promise.all([first.pos.handleCompleteSale(cash), second.pos.handleCompleteSale(cash)]);
  assert.equal(db.calls.length, 2);
  assert.equal(db.records.size, 1);
  return { attemptedSales: 2, savedDocuments: 1, writeTargets: db.calls.map(c => c.target) };
});

await check('POS-06', 'Receipt number can repeat after 16 minutes 40 seconds', async () => {
  let stamp = 1800000000123;
  class FixedDate extends Date { static now() { return stamp; } }
  const s = setup(database(), FixedDate);
  s.pos.addItem(product());
  await s.pos.handleCompleteSale(cash);
  stamp += 1000000;
  s.pos.addItem(product());
  await s.pos.handleCompleteSale(cash);
  const numbers = [...s.db.records.values()].map(tx => tx.number);
  assert.equal(numbers.length, 2);
  assert.equal(numbers[0], numbers[1]);
  return { elapsedSeconds: 1000, receiptNumbers: numbers };
});

await check('POS-07', 'Repeated completion while saving creates duplicate sales', async () => {
  let stamp = 1800000000000;
  class TickingDate extends Date { static now() { return stamp++; } }
  const s = setup(database({ hold: true }), TickingDate);
  s.pos.addItem(product());
  const first = s.pos.handleCompleteSale(cash);
  const second = s.pos.handleCompleteSale(cash);
  assert.equal(s.db.calls.length, 2);
  s.db.pending.forEach(resolve => resolve());
  await Promise.all([first, second]);
  assert.equal(s.db.records.size, 2);
  return { cartSubmissions: 2, savedDocuments: 2 };
});

await check('POS-08', 'Distinct product IDs merge when name and price match', () => {
  const s = setup();
  s.pos.addItem(product());
  s.pos.addItem(product({ id: 'product-b' }));
  assert.equal(s.pos.cart.value.length, 1);
  assert.equal(s.pos.cart.value[0].qty, 2);
  return { inputProductIds: ['product-a', 'product-b'], cartLines: 1, retainedId: s.pos.cart.value[0].id };
});

await check('POS-09', 'Cash matching the displayed rounded total can be rejected', () => {
  const s = setup();
  s.Store.state.selectedCompany.preferences.taxRate = 6;
  s.pos.addItem(product({ price: 0.05 }));
  const alerts = [];
  const emitted = [];
  const payment = load('src/components/dashboard/pos/PosPaymentModal.vue', {
    defineProps: () => ({ total: s.pos.totals.value.total, company: {} }),
    defineEmits: () => (...args) => emitted.push(args), alert: message => alerts.push(message)
  }, ['cashReceived', 'process']);
  payment.cashReceived.value = Number(s.pos.totals.value.total.toFixed(2));
  payment.process();
  assert.equal(emitted.length, 0);
  assert.equal(alerts[0], 'Insufficient Cash');
  return { displayedTotal: s.pos.totals.value.total.toFixed(2), comparedTotal: s.pos.totals.value.total, cashReceived: payment.cashReceived.value };
});

await check('POS-10', 'Catalog SKU cannot be found by the POS code search', () => {
  const p = product({ sku: 'RET-1234' });
  const grid = load('src/components/dashboard/pos/PosProductGrid.vue', {
    defineProps: () => ({ products: [p], categories: ['All'] }), defineEmits: () => () => {}
  }, ['searchQuery', 'filteredProducts']);
  grid.searchQuery.value = p.sku;
  assert.equal(grid.filteredProducts.value.length, 0);
  return { sku: p.sku, searchMatches: 0 };
});

await check('POS-11', 'Expense UI saves to a different collection from its list', async () => {
  const s = setup();
  const expense = load('src/components/dashboard/ExpensesTab.vue', {
    Store: s.Store, useStorage: () => ({ uploadFile() {}, removeFile() {} })
  }, ['form', 'saveExpense', 'expenses']);
  expense.form.value = { description: 'Example expense', amount: 12, date: '2026-09-10' };
  await expense.saveExpense();
  assert.ok(s.db.calls[0].target.startsWith('transactions/'));
  assert.equal(expense.expenses.value.length, 0);
  return { writtenCollection: 'transactions', listedCollection: 'expenses', savedAmount: s.db.calls[0].data.amount, savedTotal: s.db.calls[0].data.total ?? null };
});

await check('POS-12', 'Company switches retain old listeners and allow stale data to win', () => {
  const callbacks = [];
  let unsubscribed = 0;
  const s = setup();
  const store = load('src/store/index.js', {
    ...s.db.bindings, state: s.Store.state, auth: {}, financeModule: {}, inventoryModule: {}, companiesModule: {}, authModule: {},
    query: (collection, filter) => ({ collection, filter }), where: (...parts) => parts,
    onSnapshot: (query, callback) => { callbacks.push({ query, callback }); return () => unsubscribed++; }
  }, ['Store']).Store;
  store.selectCompany({ id: 'shop-a' });
  store.selectCompany({ id: 'shop-b' });
  callbacks[0].callback({ docs: [{ id: 'product-a', data: () => product() }] });
  assert.equal(callbacks.length, 8);
  assert.equal(unsubscribed, 0);
  assert.equal(store.state.selectedCompany.id, 'shop-b');
  assert.equal(store.state.products[0].company_id, 'shop-a');
  return { listeners: callbacks.length, unsubscribed, selectedCompany: 'shop-b', latestProductsCompany: 'shop-a' };
});

await check('POS-13', 'Saving appearance can replace the entire company preferences map', async () => {
  const s = setup();
  s.Store.state.selectedCompany.preferences = { taxRate: 6, currency: 'RM', baseTheme: 'modern' };
  const companies = load('src/store/companies.js', s.db.bindings, ['companiesModule']).companiesModule;
  companies.updatePreferences(s.Store, { theme: 'dark' });
  assert.deepEqual(s.db.calls[0].data, { preferences: { theme: 'dark' } });
  return { previousKeys: ['taxRate', 'currency', 'baseTheme'], replacementKeys: Object.keys(s.db.calls[0].data.preferences) };
});

await check('POS-14', 'Out-of-stock items can be sold', async () => {
  const s = setup();
  s.pos.handleAddToCart(product({ stock: 0 }));
  await s.pos.handleCompleteSale(cash);
  assert.equal(s.db.records.size, 1);
  return { initialStock: 0, savedSales: 1 };
});

await check('POS-15', 'Tax on an existing POS sale is lost when resaved through Sales', async () => {
  const s = setup();
  s.Store.state.selectedCompany.preferences.taxRate = 6;
  s.pos.addItem(product());
  await s.pos.handleCompleteSale(cash);
  const original = { ...s.db.calls[0].data, id: s.db.calls[0].target.split('/')[1] };
  const sales = load('src/components/dashboard/finance/SalesTab.vue', {
    Store: s.Store, usePdfGenerator: () => ({ generatePdf() {} })
  }, ['handleEdit', 'saveTx']);
  sales.handleEdit(original);
  sales.saveTx();
  assert.equal(original.total, 10.6);
  assert.equal(s.db.calls[1].data.total, 10);
  return { originalTotal: original.total, resavedTotal: s.db.calls[1].data.total, originalTaxRateField: original.taxRate ?? null };
});

const report = {
  generatedAt: new Date().toISOString(),
  scope: 'Source-level characterization using in-memory Vue and Firestore doubles; no live writes, browser or emulator.',
  meaning: 'REPRODUCED confirms the reported defect. This is not a POS acceptance test suite.',
  sourceFiles: [posFile, 'src/store/finance.js', 'src/store/index.js', 'src/store/companies.js',
    'src/components/dashboard/AnalyticsTab.vue', 'src/components/dashboard/ExpensesTab.vue',
    'src/components/dashboard/finance/SalesTab.vue', 'src/components/dashboard/pos/PosPaymentModal.vue',
    'src/components/dashboard/pos/PosProductGrid.vue', 'src/components/dashboard/pos/PosSuccessModal.vue'],
  observations
};
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/pos-readiness-evidence.json'), JSON.stringify(report, null, 2) + '\n');
for (const item of observations) console.log(`${item.result} ${item.id}: ${item.title}${item.error ? ' -- ' + item.error : ''}`);
console.log(`${observations.filter(o => o.result === 'REPRODUCED').length}/${observations.length} reported defects reproduced.`);
