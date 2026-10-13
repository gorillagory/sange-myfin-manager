import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expenseAuditDetail,expenseOutput,prepareExpense,recordExpenseEvent } from '../src/expense-lifecycle.js';
import { ledgerOutput } from '../src/stock.js';

const expenseRow = {
  id: 'expense-1', company_id: 'company-1', amount: 42.05, amount_sen: 4205,
  status: 'paid', paid_by_type: 'app_user', paid_by_identity_id: 'payer-1', paid_by_name: null,
  credit_terms_days: null, credit_due_date: null, paid_on: '2026-10-02', version: 3,
  data: { date: '2026-10-02', description: 'Beans', amount: 42.05 },
};

const linkedRows = [
  { expense_id: 'expense-1', link_type: 'stock_item', stock_item_id: 'stock-1', stock_item_name: 'Coffee beans', source: 'manual' },
  { expense_id: 'expense-1', link_type: 'stock_movement', stock_ledger_id: 'movement-1', movement_item_name: 'Coffee beans', movement_kind: 'receive', source: 'stock_ledger' },
  { expense_id: 'expense-1', link_type: 'purchase_order', purchase_order_id: 'po-1', purchase_order_number: 'PO-001', source: 'manual' },
  { expense_id: 'expense-1', link_type: 'goods_receipt', goods_receipt_id: 'receipt-1', goods_receipt_reference: 'GR-001', receipt_order_number: 'PO-001', source: 'manual' },
];

function projectionClient() {
  return { async query(sql) {
    if (sql.includes('FROM myfin.expense_links')) return { rows: linkedRows };
    if (sql.includes('FROM myfin.app_identities')) return { rows: [{ id: 'payer-1', display_name: 'Paying user' }] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
}

test('expense link projections respect stock-history and procurement permissions', async () => {
  const operator = (await expenseOutput(projectionClient(), 'company-1', [expenseRow], { id: 'operator-1', role: 'operator' }))[0];
  assert.deepEqual(operator.links.map(link => link.type), ['stock_item']);
  assert.equal(operator.paidByUserName, 'Paying user');
  assert.doesNotMatch(JSON.stringify(operator), /movement-1|PO-001|receipt-1/);

  const manager = (await expenseOutput(projectionClient(), 'company-1', [expenseRow], { id: 'manager-1', role: 'manager' }))[0];
  assert.deepEqual(manager.links.map(link => link.type), ['stock_item', 'stock_movement']);
  assert.doesNotMatch(JSON.stringify(manager), /PO-001|receipt-1/);

  const owner = (await expenseOutput(projectionClient(), 'company-1', [expenseRow], { id: 'owner-1', role: 'workspace_owner' }))[0];
  assert.deepEqual(owner.links.map(link => link.type), ['stock_item', 'stock_movement', 'purchase_order', 'goods_receipt']);
});

test('operators can record only themselves as an app-user payer', async () => {
  const base = { id: 'expense-1', company_id: 'company-1', date: '2026-10-02', description: 'Milk', amount: 4.25,
    status: 'paid', paidOn: '2026-10-02', paidByType: 'app_user', links: [] };
  await assert.rejects(
    prepareExpense({ query() { throw new Error('must reject before querying'); } }, 'company-1', { id: 'operator-1', role: 'operator' },
      { ...base, paidByUserId: 'operator-2' }),
    error => error.statusCode === 403 && error.message === 'expense_payer_restricted',
  );

  const queries = [];
  const client = { async query(sql) {
    queries.push(sql);
    if (sql.includes('FROM myfin.app_identities')) return { rowCount: 1, rows: [{ id: 'operator-1' }] };
    if (sql.includes('FROM myfin.expense_links')) return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const prepared = await prepareExpense(client, 'company-1', { id: 'operator-1', role: 'operator' },
    { ...base, paidByUserId: '' });
  assert.equal(prepared.paidByUserId, 'operator-1');
  assert.equal(prepared.amountSen, 425);
  assert.equal(queries.length, 2);
});

test('payer and fixed link targets must exist inside the selected tenant', async () => {
  const base = { id: 'expense-1', company_id: 'company-1', date: '2026-10-02', description: 'Milk', amount: 4.25,
    status: 'paid', paidOn: '2026-10-02', paidByType: 'other', paidByName: 'Business account', links: [{ type: 'stock_item', id: 'foreign-stock' }] };
  const client = { async query(sql) {
    if (sql.includes('FROM myfin.expense_links')) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM myfin.stock_items')) return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  await assert.rejects(
    prepareExpense(client, 'company-1', { id: 'manager-1', role: 'manager' }, base),
    error => error.statusCode === 409 && error.message === 'expense_stock_item_not_found',
  );
});

test('legacy payer values are preservation-only and future settlements are rejected', async () => {
  const client = { async query(sql) {
    if (sql.includes('FROM myfin.expense_links')) return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const base = { id: 'expense-1', company_id: 'company-1', date: '2026-10-02', description: 'Historical rent',
    amount: 10, status: 'paid', paidOn: '2026-10-02', paidByType: 'legacy_unspecified', links: [] };
  await assert.rejects(prepareExpense(client, 'company-1', { id: 'owner-1', role: 'workspace_owner' }, base),
    error => error.statusCode === 400 && error.message === 'Choose who paid this expense.');
  assert.equal((await prepareExpense(client, 'company-1', { id: 'owner-1', role: 'workspace_owner' }, base,
    { allowLegacy: true })).paidByType, 'legacy_unspecified');
  await assert.rejects(prepareExpense(client, 'company-1', { id: 'owner-1', role: 'workspace_owner' },
    { ...base, paidByType: 'other', paidByName: 'Business account', paidOn: '2099-01-01' }), /future/);
  await assert.rejects(prepareExpense(client, 'company-1', { id: 'owner-1', role: 'workspace_owner' },
    { ...base, paidByType: 'other', paidByName: '' }, { allowLegacy: true }), /Describe who paid/);
});

test('stock ledger projection carries linked expense lifecycle and void evidence', () => {
  const raw={ id:'movement-1', company_id:'company-1', item_id:'stock-1', actor_id:'owner-1',
    kind:'receive', input_quantity:'1', delta:'1', quantity_after:'2', expense_id:'expense-1',
    expense_description:'Coffee beans', expense_status:'pending', expense_due_date:'2020-01-01', expense_paid_on:null,
    expense_voided_at:null, reason:'Supplier delivery', created_at:'2026-10-02T00:00:00Z' };
  const projected = ledgerOutput(raw);
  assert.deepEqual({status:projected.expenseStatus,effective:projected.expenseEffectiveStatus,due:projected.expenseDueDate,
    paidOn:projected.expensePaidOn,voided:projected.expenseVoided},
  {status:'pending',effective:'overdue',due:'2020-01-01',paidOn:'',voided:false});
  assert.equal(ledgerOutput({...raw,expense_voided_at:'2026-10-03T00:00:00Z'}).expenseEffectiveStatus,'voided');
});

test('expense activity detail records status, payer, due and settlement transitions', () => {
  assert.equal(expenseAuditDetail('expense-1',
    {status:'pending',paid_by_type:'credit',credit_due_date:'2026-10-30',paid_on:null},
    {status:'paid',paidByType:'credit',creditDueDate:'2026-10-30',paidOn:'2026-10-13'}),
  'expense-1 · status pending → paid · payer credit → credit · due 2026-10-30 → 2026-10-30 · paid — → 2026-10-13');
});

test('immutable expense events store complete lifecycle snapshots', async () => {
  const calls=[];
  await recordExpenseEvent({async query(sql,params){calls.push({sql,params});return {rowCount:1,rows:[]};}},
    'company-1',{id:'manager-1'},{expenseId:'expense-1',expenseVersion:2,action:'settled',
      from:{status:'pending',paid_by_type:'credit',amount_sen:4205,data:{date:'2026-09-29'}},
      to:{status:'paid',paid_by_type:'credit',amount_sen:4205,paid_on:'2026-10-13',data:{date:'2026-09-29'}},
      reason:'Paid supplier'});
  assert.equal(calls.length,1);assert.match(calls[0].sql,/INSERT INTO myfin\.expense_events/);
  assert.deepEqual(calls[0].params.slice(2,5),['expense-1',2,'settled']);
  assert.deepEqual(calls[0].params[5],{status:'pending',paidByType:'credit',paidByUserId:'',paidByName:'',
    amountSen:4205,expenseDate:'2026-09-29',creditTermsDays:null,creditDueDate:'',paidOn:'',voided:false});
  assert.equal(calls[0].params[6].paidOn,'2026-10-13');assert.equal(calls[0].params[7],'Paid supplier');
});

test('expense migration preserves legacy cash behavior and enforces typed tenant links', async () => {
  const sql = await readFile(new URL('../../db/migrations/0032_expense_lifecycle.sql', import.meta.url), 'utf8');
  assert.match(sql, /status text NOT NULL DEFAULT 'paid'/);
  assert.match(sql, /paid_by_type text NOT NULL DEFAULT 'legacy_unspecified'/);
  assert.match(sql, /amount_sen bigint/);
  assert.match(sql, /paid_on date/);
  assert.match(sql, /valid_expense_date\(data->>'date'\)/);
  assert.match(sql, /NEW\.status='paid' AND NEW\.paid_on IS NULL[\s\S]*NEW\.paid_on:=myfin\.valid_expense_date/);
  assert.match(sql, /sync_expense_lifecycle\(\) RETURNS trigger\s+LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin/);
  assert.match(sql, /link_stock_ledger_expense\(\) RETURNS trigger\s+LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,myfin/);
  assert.match(sql, /CHECK\(status='paid' OR paid_by_type='credit'\)/);
  assert.match(sql, /status='pending' AND paid_on IS NULL/);
  assert.match(sql, /FOREIGN KEY\(company_id,expense_id\)[\s\S]*REFERENCES myfin\.expenses\(company_id,id\)/);
  for (const table of ['stock_items', 'stock_ledger', 'purchase_orders', 'goods_receipts']) {
    assert.match(sql, new RegExp(`REFERENCES myfin\\.${table}\\(company_id,id\\)`));
  }
  assert.match(sql, /expense_link_evidence_immutable/);
  assert.match(sql, /CREATE TABLE myfin\.expense_events/);
  assert.match(sql, /UNIQUE\(company_id,expense_id,expense_version\)/);
  assert.match(sql, /action IN \('created','updated','settled','voided','imported'\)/);
  assert.match(sql, /expense_event_immutable/);
  assert.doesNotMatch(sql, /\\000/);
});

test('expense updates require an optimistic version check before writing', async () => {
  const source = await readFile(new URL('../src/business.js', import.meta.url), 'utf8');
  const required = source.indexOf('expense_version_required');
  const changed = source.indexOf('expense_changed', required);
  const update = source.indexOf('UPDATE myfin.expenses', changed);
  assert.ok(required > 0 && changed > required && update > changed);
  assert.match(source.slice(required - 100, update), /prepared\.version!==Number\(old\.rows\[0\]\.version\)/);
  assert.match(source, /reason:z\.string\(\)\.trim\(\)\.min\(3\)\.max\(1000\)/);
  assert.match(source, /prior version \$\{old\.rows\[0\]\.version\} · reason \$\{approval\.reason\}/);
});
