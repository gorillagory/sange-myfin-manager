import { z } from 'zod';
import * as v from './validation.js';
import { requireCapability } from './access.js';
import { businessDate, cents, expenseRecords } from '../../src/domain/pos.js';

const querySchema = z.strictObject({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const consolidationQuerySchema = querySchema.extend({ workspaceId: v.id.optional() });

function range(query, schema = querySchema) {
  const value = v.parse(schema, query);
  const fromMs = Date.parse(value.from), toMs = Date.parse(value.to);
  const span = (toMs - fromMs) / 86400000;
  if (!Number.isInteger(span) || span < 0 || span > 366 || !Number.isFinite(fromMs) || !Number.isFinite(toMs)
    || new Date(fromMs).toISOString().slice(0, 10) !== value.from
    || new Date(toMs).toISOString().slice(0, 10) !== value.to) v.fail(400, 'invalid_report_range');
  return value;
}

const asRecord = row => ({ ...row.data, id: row.id, company_id: row.company_id });
const inRange = (date, from, to) => /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date
  && date >= from && date <= to;
const sum = (rows, key) => rows.reduce((amount, row) => amount + cents(row[key]), 0) / 100;
const safeText = value => String(value || '').slice(0, 160);

// Keep this classification aligned with /reports/summary in business.js. The
// detail endpoint uses the same dates and amount rules as the approved report.
export function companyReport({ transactions = [], expenses = [], payments = [] }, from, to) {
  const sales = [], expenseLines = [], receipts = [];
  for (const row of transactions) {
    const data = row.data || {};
    const date = data.businessDate || businessDate(row.issued_at || data.date);
    if (!inRange(date, from, to)) continue;
    if (row.source === 'pos') {
      sales.push({ id: row.id, date, kind: 'POS receipt', number: safeText(data.number), customer: safeText(data.customerName || 'Walk-in customer'), total: Number(row.total), tax: Number(data.tax || 0) });
      receipts.push({ id: row.id, date, kind: 'POS receipt', number: safeText(data.number), amount: Number(row.total) });
    } else if (row.document_state === 'issued' && data.type === 'Invoice') {
      sales.push({ id: row.id, date, kind: 'Invoice', number: safeText(data.number), customer: safeText(row.issued_snapshot?.clientSnapshot?.name || data.customerName), total: Number(row.total), tax: Number(row.issued_snapshot?.tax ?? data.tax ?? 0) });
    } else if (row.document_state === 'legacy' && data.type === 'Invoice' && ['Paid', 'Cleared'].includes(data.status)) {
      sales.push({ id: row.id, date, kind: 'Historical invoice', number: safeText(data.number), customer: safeText(data.customerName), total: Number(row.total), tax: Number(data.tax || 0) });
      receipts.push({ id: row.id, date, kind: 'Historical paid invoice', number: safeText(data.number), amount: Number(row.total) });
    }
  }
  const legacyExpenses = transactions.filter(row => row.document_state === 'legacy').map(asRecord);
  const allExpenses = expenseRecords({ expenses: expenses.map(asRecord), transactions: legacyExpenses });
  for (const expense of allExpenses) {
    const date = businessDate(expense.date);
    if (inRange(date, from, to)) expenseLines.push({ id: expense.id, date, description: safeText(expense.description), category: safeText(expense.category || 'Uncategorized'), payee: safeText(expense.payee), amount: Number(expense.amount || 0) });
  }
  for (const payment of payments) {
    const date = businessDate(payment.paid_at);
    if (inRange(date, from, to)) receipts.push({ id: payment.id, date, kind: 'Invoice payment', number: safeText(payment.number), amount: Number(payment.amount) });
  }
  const byDate = (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id);
  sales.sort(byDate); expenseLines.sort(byDate); receipts.sort(byDate);
  const totals = { sales: sum(sales, 'total'), tax: sum(sales, 'tax'), expenses: sum(expenseLines, 'amount'), cashFlow: (receipts.reduce((amount, row) => amount + cents(row.amount), 0) - expenseLines.reduce((amount, row) => amount + cents(row.amount), 0)) / 100 };
  return { totals, sales, expenses: expenseLines, receipts };
}

export function reportDateBounds(from, to) {
  const date = (value, offset) => {
    const result = new Date(Date.parse(value) + offset * 86400000);
    return `${String(result.getUTCFullYear()).padStart(4, '0')}-${String(result.getUTCMonth() + 1).padStart(2, '0')}-${String(result.getUTCDate()).padStart(2, '0')}`;
  };
  return { fromPad: date(from, -1), toPad: date(to, 1), toExclusive: date(to, 1) };
}

export async function companyRows(c, companyIds, from, to) {
  // A timestamp with an offset can land on an adjacent Kuala Lumpur day. The
  // JSON date-prefix branches therefore fetch one extra day on each side,
  // then companyReport applies the exact businessDate() rule in JavaScript.
  // Missing/non-ISO legacy dates remain a small fallback so old records are
  // never silently dropped. Indexed branches bound ordinary report traffic.
  const { fromPad, toPad, toExclusive } = reportDateBounds(from, to);
  const args = [companyIds, from, to, fromPad, toPad, toExclusive];
  const transactionColumns = 'company_id,id,data,total,source,document_state,issued_at,issued_snapshot';
  const transactionsTable = 'myfin.transactions';
  const relevant = `(source='pos' OR (document_state='issued' AND data->>'type'='Invoice')
    OR (document_state='legacy' AND data->>'type' IN ('Invoice','Expense','Payment Voucher')))`;
  const missingBusinessDate = `(coalesce(data->>'businessDate','')='' OR data->'businessDate' IN ('0'::jsonb,'false'::jsonb))`;
  const datePrefix = `left(data->>'date',10)`;
  const standardPrefix = `${datePrefix} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;
  const transactionBranch = condition => `SELECT ${transactionColumns} FROM ${transactionsTable}
    WHERE company_id=ANY($1::text[]) AND ${relevant} AND ${condition}`;
  const transactionQuery = [
    transactionBranch(`data->>'businessDate' BETWEEN $2 AND $3`),
    transactionBranch(`${missingBusinessDate} AND issued_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
      AND issued_at < ($6::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')`),
    transactionBranch(`${missingBusinessDate} AND issued_at IS NULL AND ${standardPrefix} AND ${datePrefix} BETWEEN $4 AND $5`),
    transactionBranch(`${missingBusinessDate} AND issued_at IS NULL AND (data->>'date' IS NULL OR ${datePrefix} !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')`),
  ].join(' UNION ALL ');
  const expenseBranch = condition => `SELECT company_id,id,data FROM myfin.expenses
    WHERE company_id=ANY($1::text[]) AND voided_at IS NULL AND ${condition}`;
  const expenseQuery = [
    expenseBranch(`${standardPrefix} AND ${datePrefix} BETWEEN $2 AND $3`),
    expenseBranch(`data->>'date' IS NULL OR ${datePrefix} !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
  ].join(' UNION ALL ');
  const [transactions, expenses, payments] = await Promise.all([
    c.query(transactionQuery, args),
    c.query(expenseQuery, [companyIds, fromPad, toPad]),
    c.query(`SELECT p.company_id,p.id,p.amount,p.paid_at,t.data->>'number' AS number
      FROM myfin.document_payments p LEFT JOIN myfin.transactions t ON t.company_id=p.company_id AND t.id=p.document_id
      WHERE p.company_id=ANY($1::text[])
      AND p.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
        AND p.paid_at < ($3::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')`, [companyIds, from, toExclusive]),
  ]);
  return { transactions: transactions.rows, expenses: expenses.rows, payments: payments.rows };
}

export function registerReporting(app, { db, managed, authorize, managementSession }) {
  app.get('/api/companies/:company/reports/details', req => db.transaction(async c => {
    await managementSession(c, req);
    const companyId = v.parse(v.id, req.params.company);
    await authorize(c, req.identity, companyId);
    requireCapability(req.identity, 'financialReports');
    const { from, to } = range(req.query);
    const rows = await companyRows(c, [companyId], from, to);
    const result = companyReport(rows, from, to);
    const limit = 250;
    return { from, to, totals: result.totals,
      counts: { sales: result.sales.length, expenses: result.expenses.length, receipts: result.receipts.length },
      sales: result.sales.slice(0, limit), expenses: result.expenses.slice(0, limit), receipts: result.receipts.slice(0, limit),
      limited: [result.sales.length, result.expenses.length, result.receipts.length].some(count => count > limit) };
  }));

  app.get('/api/reports/consolidation', req => managed(req, async(c, who) => {
    requireCapability(who, 'financialReports');
    const { from, to, workspaceId } = range(req.query, consolidationQuerySchema);
    const permitted = await c.query(`SELECT co.id,co.name,co.workspace_id,w.name AS workspace_name,
      coalesce(nullif(co.data->'preferences'->>'currency',''),'RM') AS currency
      FROM myfin.companies co JOIN myfin.workspaces w ON w.id=co.workspace_id
      WHERE co.archived_at IS NULL AND co.suspended_at IS NULL AND w.archived_at IS NULL AND w.suspended_at IS NULL
        AND ($3::text='' OR co.id=$3)
        AND ($2 OR EXISTS(SELECT 1 FROM myfin.workspace_memberships wm WHERE wm.workspace_id=co.workspace_id AND wm.identity_id=$1 AND wm.suspended_at IS NULL)
          OR EXISTS(SELECT 1 FROM myfin.memberships m WHERE m.company_id=co.id AND m.identity_id=$1 AND m.role IN ('manager','company_admin')))
      ORDER BY w.name,co.name LIMIT 1001`, [who.id, who.role === 'super_admin', req.identity.host_company_id || '']);
    if (permitted.rowCount > 1000) v.fail(409, 'company_limit_exceeded');
    const workspaces = [...new Map(permitted.rows.map(row => [row.workspace_id, { id: row.workspace_id, name: row.workspace_name }])).values()];
    const selected = workspaceId || workspaces[0]?.id || '';
    if (selected && !workspaces.some(workspace => workspace.id === selected)) v.fail(403, 'access_denied');
    const companies = permitted.rows.filter(row => row.workspace_id === selected);
    const rows = companies.length ? await companyRows(c, companies.map(row => row.id), from, to) : { transactions: [], expenses: [], payments: [] };
    const byCompany = collection => {
      const grouped = new Map();
      for (const row of collection) {
        if (!grouped.has(row.company_id)) grouped.set(row.company_id, []);
        grouped.get(row.company_id).push(row);
      }
      return grouped;
    };
    const transactions = byCompany(rows.transactions), expenses = byCompany(rows.expenses), payments = byCompany(rows.payments);
    const reports = companies.map(company => ({ id: company.id, name: company.name, currency: company.currency,
      ...companyReport({ transactions: transactions.get(company.id), expenses: expenses.get(company.id), payments: payments.get(company.id) }, from, to).totals }));
    return { from, to, workspaceId: selected, workspaces, companies: reports };
  }));
}
