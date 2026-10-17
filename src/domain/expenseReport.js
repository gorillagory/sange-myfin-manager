import { businessDate, cents } from './pos.js';
import {
  EXPENSE_PAID_BY_LABELS,
  EXPENSE_STATUS_LABELS,
  effectiveExpenseStatus,
  expenseHasCashImpact,
} from './expenseLifecycle.js';

const clean = value => String(value ?? '').trim();
const exactSen = value => {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : 0;
};
const amountSen = value => Number.isSafeInteger(Number(value?.amountSen))
  ? exactSen(value.amountSen)
  : cents(value?.amount ?? value?.total ?? 0);
const lexical = (left, right) => String(left).localeCompare(String(right), 'en');
const byAmountThenLabel = (left, right) => right.amountSen - left.amountSen || lexical(left.label, right.label);
const labelForStatus = status => EXPENSE_STATUS_LABELS[status]
  || ({ draft: 'Draft', pending_payment: 'Pending payment', partially_paid: 'Partially paid', voided: 'Voided' })[status]
  || status.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
const paymentLabel = type => ({ ...EXPENSE_PAID_BY_LABELS, bank: 'Bank', card: 'Card' })[type]
  || clean(type).replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());

export function effectiveReportExpenseStatus(expense = {}, today = businessDate()) {
  if (expense.voidedAt || expense.voided_at || clean(expense.status).toLowerCase() === 'voided') return 'voided';
  const raw = clean(expense.effectiveStatus || expense.status).toLowerCase();
  const dueDate = clean(expense.creditDueDate || expense.dueDate);
  if (raw === 'pending') return effectiveExpenseStatus(expense, today) === 'overdue' ? 'overdue' : 'pending_payment';
  if (raw === 'unpaid') return dueDate && dueDate < today ? 'overdue' : 'pending_payment';
  if (['pending_payment','partially_paid'].includes(raw) && dueDate && dueDate < today) return 'overdue';
  if (['draft', 'pending_payment', 'partially_paid', 'paid', 'overdue'].includes(raw)) return raw;
  return effectiveExpenseStatus(expense, today);
}

export function expenseReportLine(expense = {}, options = {}) {
  const today = options.today || businessDate();
  const status = effectiveReportExpenseStatus(expense, today);
  const totalSen = amountSen(expense);
  const paidValue = expense.paidAmountSen ?? expense.amountPaidSen;
  const outstandingValue = expense.outstandingAmountSen ?? expense.outstandingSen;
  const paidSen = Number.isSafeInteger(Number(paidValue))
    ? Math.max(0, Math.min(totalSen, exactSen(paidValue)))
    : status === 'paid' && expenseHasCashImpact(expense) ? totalSen : 0;
  const outstandingSen = Number.isSafeInteger(Number(outstandingValue))
    ? Math.max(0, exactSen(outstandingValue))
    : Math.max(0, totalSen - paidSen);
  const paidByType = clean(expense.paidByType || expense.paid_by_type || 'legacy_unspecified');
  const paymentSources = (Array.isArray(expense.paymentSources) ? expense.paymentSources : []).map(item => {
    const type = clean(item.sourceType || item.type);
    const fundName = clean(item.pettyCashFundName);
    return { type, label: `${paymentLabel(type)}${type === 'petty_cash' && fundName ? ` - ${fundName}` : ''}`, amountSen: Math.max(0, exactSen(item.amountSen)) };
  }).filter(item => item.type && item.amountSen > 0);
  const sourceLabel = paymentSources.length ? [...new Set(paymentSources.map(item => item.label))].join(', ')
    : paidSen > 0 && ['unassigned',''].includes(paidByType) ? 'Payment events - see history'
    : status === 'partially_paid' && !clean(expense.paymentSourceLabel) ? 'Payment events - see history'
    : clean(expense.paymentSourceLabel || expense.paidByUserName || expense.paidByName)
      || paymentLabel(paidByType) || 'Legacy / unspecified';
  return {
    id: clean(expense.id),
    reference: clean(expense.number || expense.reference || expense.id) || '-',
    date: businessDate(expense.date || expense.occurredAt || expense.createdAt),
    description: clean(expense.description || expense.payee || expense.type) || 'Expense',
    category: clean(expense.category) || 'General',
    payee: clean(expense.supplierName || expense.payee) || '-',
    status,
    statusLabel: labelForStatus(status),
    paidByType,
    paymentSources,
    paymentSource: sourceLabel,
    dueDate: clean(expense.creditDueDate || expense.dueDate),
    paidOn: clean(expense.paidOn),
    totalSen,
    paidSen,
    outstandingSen,
    evidence: expense.receiptUrl || expense.receiptPath ? 'Attached' : 'Missing',
    links: (Array.isArray(expense.links) ? expense.links : []).map(link => clean(link.label || link.id)).filter(Boolean),
  };
}

export function cashbookExpensePayment(row = {}) {
  const amount=Number(row.amount||0);
  return {...row,date:row.cashDate||row.date,direction:amount<0?'in':'out',amount:Math.abs(amount),
    label:row.kind,description:row.description||row.expenseId||row.id};
}

function grouped(lines, key, label = value => value) {
  const groups = new Map();
  for (const line of lines) {
    const value = key(line) || 'Unspecified', current = groups.get(value) || { label: label(value), count: 0, amountSen: 0 };
    current.count += 1; current.amountSen += line.totalSen; groups.set(value, current);
  }
  return [...groups.values()].sort(byAmountThenLabel);
}

function groupedPaymentSources(lines) {
  const groups = new Map();
  const add = (label, amount) => {
    const current = groups.get(label) || { label, count: 0, amountSen: 0 };
    current.count += 1; current.amountSen += amount; groups.set(label, current);
  };
  for (const line of lines) {
    if (!line.paymentSources.length) {
      if (line.paidSen > 0) add(line.paymentSource, line.paidSen);
      if (line.outstandingSen > 0) add('Outstanding / not settled', line.outstandingSen);
      continue;
    }
    let allocatedSen = 0;
    for (const source of line.paymentSources) {
      const appliedSen=Math.min(source.amountSen,Math.max(0,line.paidSen-allocatedSen));
      if(appliedSen>0)add(source.label,appliedSen);
      allocatedSen+=appliedSen;
    }
    if(line.paidSen>allocatedSen)add(line.paymentSource||'Payment events - see history',line.paidSen-allocatedSen);
    if(line.outstandingSen>0)add('Outstanding / not settled',line.outstandingSen);
  }
  return [...groups.values()].sort(byAmountThenLabel);
}

function normalizePettyCash(pettyCash = {}, filters = {}) {
  const funds = (pettyCash.funds || pettyCash.accounts || []).map(fund => ({
    id: clean(fund.id),
    name: clean(fund.name) || 'Petty cash',
    currency: clean(fund.currency),
    status: clean(fund.status) || 'open',
    isDefault: Boolean(fund.isDefault),
    balanceSen: Number.isSafeInteger(Number(fund.balanceSen)) ? exactSen(fund.balanceSen) : cents(fund.balance || 0),
    openingBalanceSen: Number.isSafeInteger(Number(fund.openingBalanceSen)) ? exactSen(fund.openingBalanceSen) : null,
    openedAt: clean(fund.openedAt),
  }));
  const allMovements = (pettyCash.movements || pettyCash.entries || []).map(entry => {
    const occurredAt=clean(entry.occurredAt || entry.createdAt || entry.date);
    const occurredAtMs=Date.parse(occurredAt);
    const createdAt=clean(entry.createdAt || entry.occurredAt || entry.date);
    const createdAtMs=Date.parse(createdAt);
    return ({
    id: clean(entry.id), occurredAt, occurredAtMs:Number.isFinite(occurredAtMs)?occurredAtMs:0,
    createdAt,createdAtMs:Number.isFinite(createdAtMs)?createdAtMs:0,
    fundId: clean(entry.fundId || entry.fund_id),
    date: businessDate(occurredAt),
    type: clean(entry.type).replaceAll('_', ' ') || 'movement',
    reference: clean(entry.reference || entry.expenseId || entry.id) || '-',
    reason: clean(entry.reason || entry.description) || '-',
    amountSen: Number.isSafeInteger(Number(entry.amountSen)) ? exactSen(entry.amountSen) : cents(entry.amount || 0),
    signedAmountSen: Number.isSafeInteger(Number(entry.signedAmountSen)) ? exactSen(entry.signedAmountSen)
      : entry.direction === 'out' ? -Math.abs(amountSen(entry)) : entry.direction === 'neutral' ? 0 : Math.abs(amountSen(entry)),
    balanceAfterSen: Number.isSafeInteger(Number(entry.balanceAfterSen)) ? exactSen(entry.balanceAfterSen) : null,
    countedBalanceSen: Number.isSafeInteger(Number(entry.countedBalanceSen)) ? exactSen(entry.countedBalanceSen) : null,
  });}).sort((left, right) => left.createdAtMs-right.createdAtMs || lexical(left.id, right.id));
  const inRange = row => (!filters.from || row.date >= filters.from) && (!filters.to || row.date <= filters.to);
  const fundReports = funds.map(fund => {
    const completeLedger = allMovements.filter(row => row.fundId === fund.id);
    const movements = completeLedger.filter(inRange);
    const sumTypes = types => movements.filter(row => types.includes(row.type.replaceAll(' ', '_'))).reduce((sum, row) => sum + Math.abs(row.amountSen), 0);
    const openedAfterPeriod = Boolean(filters.to && fund.openedAt && businessDate(fund.openedAt) > filters.to);
    // Effective dates can be entered after later ledger rows. Derive the period
    // opening from signed evidence rather than insertion-order balance_after.
    const openingBalanceSen = openedAfterPeriod ? 0 : completeLedger
      .filter(row => filters.from && row.date < filters.from)
      .reduce((sum, row) => sum + row.signedAmountSen, 0);
    const replenishmentsSen = sumTypes(['replenishment']);
    const disbursementsSen = sumTypes(['expense', 'disbursement', 'expense_disbursement']);
    const adjustmentInSen = sumTypes(['adjustment_in']);
    const adjustmentOutSen = sumTypes(['adjustment_out']);
    const ledgerBalanceSen = openingBalanceSen + movements.reduce((sum, row) => sum + row.signedAmountSen, 0);
    const latestCount = [...movements].reverse().find(row => row.type === 'reconciliation' && row.countedBalanceSen != null);
    const currentCount = latestCount && movements.at(-1)?.id === latestCount.id ? latestCount : null;
    const reversals=movements.filter(row=>row.type==='reversal');
    const priorCounts=movements.filter(row=>row.type==='reconciliation'&&row.id!==currentCount?.id);
    const signedTotals=rows=>({
      inSen:rows.reduce((sum,row)=>sum+Math.max(0,row.signedAmountSen),0),
      outSen:rows.reduce((sum,row)=>sum+Math.max(0,-row.signedAmountSen),0),
    });
    const reversal=signedTotals(reversals),priorCount=signedTotals(priorCounts);
    const expectedBalanceSen = currentCount ? currentCount.countedBalanceSen - currentCount.signedAmountSen : ledgerBalanceSen;
    const countedBalanceSen = currentCount?.countedBalanceSen ?? null;
    return { fund, movements, summary: { openingBalanceSen, replenishmentsSen, disbursementsSen, adjustmentInSen, adjustmentOutSen,
      reversalInSen:reversal.inSen,reversalOutSen:reversal.outSen,priorCountInSen:priorCount.inSen,priorCountOutSen:priorCount.outSen,
      expectedBalanceSen, countedBalanceSen, varianceSen: countedBalanceSen == null ? null : currentCount.signedAmountSen } };
  });
  const movements = fundReports.flatMap(report => report.movements)
    .sort((left, right) => left.createdAtMs-right.createdAtMs || lexical(left.id, right.id));
  const sum = key => fundReports.reduce((total, report) => total + report.summary[key], 0);
  const allCounted = fundReports.length > 0 && fundReports.every(report => report.summary.countedBalanceSen != null);
  const summary = {
    openingBalanceSen: sum('openingBalanceSen'), replenishmentsSen: sum('replenishmentsSen'), disbursementsSen: sum('disbursementsSen'),
    adjustmentInSen: sum('adjustmentInSen'), adjustmentOutSen: sum('adjustmentOutSen'),
    reversalInSen:sum('reversalInSen'),reversalOutSen:sum('reversalOutSen'),
    priorCountInSen:sum('priorCountInSen'),priorCountOutSen:sum('priorCountOutSen'),expectedBalanceSen: sum('expectedBalanceSen'),
    countedBalanceSen: allCounted ? sum('countedBalanceSen') : null, varianceSen: allCounted ? sum('varianceSen') : null,
  };
  return {
    funds,
    movements,
    summary,
    fundReports,
    complete: pettyCash.complete !== false,
    scope: clean(pettyCash.scope),
  };
}

export function buildExpenseReport({
  expenses = [], company = {}, workspace = {}, actor = {}, filters = {}, pettyCash = {}, generatedAt = new Date().toISOString(),
} = {}) {
  const stamp = new Date(generatedAt);
  if (!Number.isFinite(stamp.getTime())) throw new Error('A valid generated timestamp is required.');
  const asOf = businessDate(stamp);
  const from = clean(filters.from), to = clean(filters.to);
  if (from && to && from > to) throw new Error('The report start date must be on or before the end date.');
  const requestedStatuses = new Set((Array.isArray(filters.statuses) ? filters.statuses : filters.status ? [filters.status] : []).filter(Boolean));
  const requestedSources = new Set((Array.isArray(filters.paymentSources) ? filters.paymentSources : filters.paidBy ? [filters.paidBy] : []).filter(Boolean));
  const query = clean(filters.query).toLocaleLowerCase();
  const lines = expenses.map(expense => expenseReportLine(expense, { today: asOf })).filter(line =>
    (!from || line.date >= from) && (!to || line.date <= to)
    && (!requestedStatuses.size || requestedStatuses.has(line.status))
    && (!requestedSources.size || requestedSources.has(line.paidByType) || line.paymentSources.some(source => requestedSources.has(source.type)))
    && (!query || [line.reference, line.description, line.category, line.payee, line.paymentSource, ...line.links].join(' ').toLocaleLowerCase().includes(query))
  ).sort((left, right) => lexical(right.date, left.date) || lexical(left.reference, right.reference));
  const totalSen = lines.reduce((sum, line) => sum + line.totalSen, 0);
  const paidSen = lines.reduce((sum, line) => sum + line.paidSen, 0);
  const outstandingSen = lines.reduce((sum, line) => sum + line.outstandingSen, 0);
  return {
    title: 'Expense and Claim Report',
    generatedAt: stamp.toISOString(),
    asOf,
    company: { id: clean(company.id), name: clean(company.name) || 'Company', registration: clean(company.registration), address: clean(company.address) },
    workspace: { id: clean(workspace.id), name: clean(workspace.name) || clean(company.workspaceName) || 'Workspace' },
    actor: { id: clean(actor.id || actor.uid), name: clean(actor.username || actor.name || actor.email) || 'Authorized user' },
    currency: clean(company.preferences?.currency || company.currency) || 'RM',
    filters: { from, to, statuses: [...requestedStatuses], paymentSources: [...requestedSources], query },
    lines,
    totals: { count: lines.length, totalSen, paidSen, outstandingSen, evidenceCount: lines.filter(line => line.evidence === 'Attached').length },
    byStatus: grouped(lines, line => line.status, labelForStatus),
    byCategory: grouped(lines, line => line.category),
    byPaymentSource: groupedPaymentSources(lines),
    pettyCash: normalizePettyCash(pettyCash, { from, to }),
  };
}

export function expenseReportFilename(report) {
  const slug = clean(report?.company?.name).toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company';
  const range = [report?.filters?.from || 'all', report?.filters?.to || report?.asOf || 'current'].join('-to-');
  return `${slug}-expense-report-${range}.pdf`;
}
