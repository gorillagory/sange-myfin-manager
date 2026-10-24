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
const safeDate = value => {
  const text = clean(value);
  if (!text) return '';
  const date = businessDate(text);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
};
const maximumSafeSen=BigInt(Number.MAX_SAFE_INTEGER);
function addReportSen(...values) {
  let total=0n;
  for(const value of values){
    const numeric=Number(value??0);
    if(!Number.isSafeInteger(numeric))throw new Error('Expense report totals exceed the supported amount. Narrow the report range.');
    total+=BigInt(numeric);
    if(total>maximumSafeSen||total<-maximumSafeSen)throw new Error('Expense report totals exceed the supported amount. Narrow the report range.');
  }
  return Number(total);
}
const safeTimestamp = value => {
  const text = clean(value), stamp = Date.parse(text);
  return text && Number.isFinite(stamp) ? new Date(stamp).toISOString() : '';
};
const slug = (value, fallback) => clean(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;
const firstInteger = (source, keys, fallback = 0) => {
  for (const key of keys) if (source?.[key] !== undefined && Number.isSafeInteger(Number(source[key]))) return exactSen(source[key]);
  return fallback;
};
const firstText = (source, keys, fallback = '') => {
  for (const key of keys) {
    const value = clean(source?.[key]);
    if (value) return value;
  }
  return fallback;
};

function normalizeScope(scope = {}, actor = {}) {
  const type = clean(scope.type || scope.mode || scope.scope || scope.kind || 'visible_records');
  const actorId = clean(scope.actorId || scope.identityId || scope.claimantId);
  const actorName = clean(scope.actorName || scope.claimantName || scope.name);
  const label = clean(scope.label) || ({ self: 'My claims', own: 'My claims', company: 'Company claims', workspace: 'Workspace claims' })[type]
    || 'Records visible to this user';
  return {
    type,mode:type,
    label,
    companyId:clean(scope.companyId),
    claimantFilterAllowed:Boolean(scope.claimantFilterAllowed),
    actorId,
    actorName,
    requestedBy: clean(actor.id || actor.uid),
    complete: scope.complete !== false,
    limited: Boolean(scope.limited),
  };
}

function normalizeInsights(source = {}, fallback = {}) {
  const summarySource = source.summary && typeof source.summary === 'object' ? source.summary : {};
  const summary = {
    count: Math.max(0, firstInteger(summarySource, ['count','claimCount'], fallback.count)),
    draftCount: Math.max(0, firstInteger(summarySource, ['draftCount'], fallback.draftCount)),
    draftSen: firstInteger(summarySource, ['draftSen'], fallback.draftSen),
    totalSen: firstInteger(summarySource, ['totalSen','recordedSen'], fallback.totalSen),
    paidSen: firstInteger(summarySource, ['paidSen'], fallback.paidSen),
    outstandingSen: firstInteger(summarySource, ['outstandingSen'], fallback.outstandingSen),
    cashOutSen: firstInteger(summarySource, ['cashOutSen']),
    overdueCount: Math.max(0, firstInteger(summarySource, ['overdueCount'])),
    overdueSen: firstInteger(summarySource, ['overdueSen']),
    evidenceCount: Math.max(0, firstInteger(summarySource, ['evidenceCount'], fallback.evidenceCount)),
    pettyCashSen: firstInteger(summarySource, ['pettyCashSen']),
  };
  const periods = normalizeAnalyticsRows(source.periods, {
    labelKeys:['label','key','period'], amountKeys:['cashOutSen','amountSen','totalSen'], countKeys:['claimCount','count'],
  })?.map(row => ({ ...row,
    key:firstText(row,['key','period','id']), from:safeDate(row.from), to:safeDate(row.to),
    draftCount:Math.max(0,firstInteger(row,['draftCount'])),draftSen:firstInteger(row,['draftSen']),
    totalSen:firstInteger(row,['totalSen']),paidSen:firstInteger(row,['paidSen']),
    outstandingSen:firstInteger(row,['outstandingSen']),cashOutSen:firstInteger(row,['cashOutSen','amountSen']),
  })) || [];
  const ageing = normalizeAnalyticsRows(source.ageing, {
    labelKeys:['label','key'],amountKeys:['outstandingSen','amountSen'],countKeys:['claimCount','count'],
  })?.map(row => ({...row,key:firstText(row,['key','id']),outstandingSen:firstInteger(row,['outstandingSen','amountSen'])})) || [];
  const categories = normalizeAnalyticsRows(source.categories, {
    labelKeys:['label','key'],amountKeys:['totalSen','amountSen'],countKeys:['claimCount','count'],
  })?.map(row => ({...row,key:firstText(row,['key','id']),draftCount:Math.max(0,firstInteger(row,['draftCount'])),
    draftSen:firstInteger(row,['draftSen']),totalSen:firstInteger(row,['totalSen','amountSen']),
    paidSen:firstInteger(row,['paidSen']),outstandingSen:firstInteger(row,['outstandingSen'])})) || null;
  const claimants = normalizeAnalyticsRows(source.claimants, {
    labelKeys:['name','label','id'],amountKeys:['totalSen','amountSen'],countKeys:['claimCount','count'],
  })?.map(row => ({...row,name:firstText(row,['name','label'],row.id),attribution:firstText(row,['attribution']),
    draftCount:Math.max(0,firstInteger(row,['draftCount'])),draftSen:firstInteger(row,['draftSen']),
    totalSen:firstInteger(row,['totalSen','amountSen']),paidSen:firstInteger(row,['paidSen']),
    outstandingSen:firstInteger(row,['outstandingSen'])})) || null;
  const paymentSources = normalizeAnalyticsRows(source.paymentSources, {
    labelKeys:['label','key'],amountKeys:['netSen','amountSen'],countKeys:['paymentCount','count'],
  })?.map(row => ({...row,key:firstText(row,['key','id']),paymentCount:firstInteger(row,['paymentCount','count']),
    netSen:firstInteger(row,['netSen','amountSen'])})) || null;
  const pettySource=source.pettyCash && typeof source.pettyCash === 'object' ? source.pettyCash : null;
  const hasPettyInsights=Boolean(pettySource && ('restricted' in pettySource || 'claimDisbursementSen' in pettySource
    || (Array.isArray(pettySource.funds) && pettySource.funds.some(fund => ['replenishmentSen','disbursementSen','adjustmentSen','countSen','reversalSen'].some(key => key in fund)))));
  const petty = hasPettyInsights ? {
    restricted:Boolean(pettySource.restricted),
    claimDisbursementSen:firstInteger(pettySource,['claimDisbursementSen','disbursementSen']),
    funds:(Array.isArray(pettySource.funds) ? pettySource.funds : []).map(fund => ({
      id:clean(fund.id),name:clean(fund.name)||'Petty cash',balanceSen:firstInteger(fund,['balanceSen']),
      replenishmentSen:firstInteger(fund,['replenishmentSen']),disbursementSen:firstInteger(fund,['disbursementSen']),
      adjustmentSen:firstInteger(fund,['adjustmentSen']),countSen:firstInteger(fund,['countSen']),
      reversalSen:firstInteger(fund,['reversalSen']),
    })),
  } : null;
  const oldestOutstanding = (Array.isArray(source.oldestOutstanding) ? source.oldestOutstanding : []).map(row => ({
    expenseId:clean(row.expenseId || row.id),reference:clean(row.reference || row.expenseId || row.id) || '-',
    date:safeDate(row.date),dueDate:safeDate(row.dueDate),claimantId:clean(row.claimantId),
    claimantName:clean(row.claimantName)||'Legacy / imported',category:clean(row.category)||'General',
    totalSen:firstInteger(row,['totalSen']),paidSen:firstInteger(row,['paidSen']),
    outstandingSen:firstInteger(row,['outstandingSen']),ageDays:Math.max(0,firstInteger(row,['ageDays'])),
    ageingKey:clean(row.ageingKey),recordType:clean(row.recordType),claimReportAvailable:row.claimReportAvailable!==false,
  }));
  return { summary, periods, ageing, categories, claimants, paymentSources, pettyCash:petty, oldestOutstanding,
    from:safeDate(source.from),to:safeDate(source.to),grain:clean(source.grain) };
}

function normalizeAnalyticsRows(rows, { labelKeys = ['label','name'], amountKeys = ['amountSen','totalSen'], countKeys = ['count'] } = {}) {
  if (!Array.isArray(rows)) return null;
  return rows.map((row, index) => ({
    ...row,
    id: firstText(row, ['id','key','value','period'], String(index)),
    label: firstText(row, labelKeys, 'Unspecified'),
    count: Math.max(0, firstInteger(row, countKeys)),
    amountSen: firstInteger(row, amountKeys),
  }));
}

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
  const paidValue = expense.paidAmountSen ?? expense.amountPaidSen ?? expense.paidSen;
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
    const suppliedLabel=clean(item.label);
    return { type, label:suppliedLabel || `${paymentLabel(type)}${type === 'petty_cash' && fundName ? ` - ${fundName}` : ''}`,
      amountSen: Math.max(0, exactSen(item.amountSen)) };
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
    statusLabel: status === 'draft' ? 'Draft (not posted)' : labelForStatus(status),
    paidByType,
    paymentSources,
    paymentSource: sourceLabel,
    dueDate: clean(expense.creditDueDate || expense.dueDate),
    paidOn: clean(expense.paidOn || expense.paidDate),
    submittedById: clean(expense.createdBy || expense.created_by || expense.claimantId),
    submittedByName: clean(expense.createdByName || expense.claimantName || expense.submittedByName)
      || clean(expense.createdBy || expense.created_by || expense.claimantId) || 'Legacy / imported',
    submittedAt: safeTimestamp(expense.createdAt || expense.created_at),
    totalSen,
    paidSen,
    outstandingSen,
    evidence: expense.evidenceAttached === true || expense.hasEvidence === true || clean(expense.evidence).toLocaleLowerCase() === 'attached'
      || expense.receiptUrl || expense.receiptPath || expense.attachmentUrl || expense.attachmentPath ? 'Attached' : 'Missing',
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
    current.count += 1; current.amountSen=addReportSen(current.amountSen,line.totalSen); groups.set(value, current);
  }
  return [...groups.values()].sort(byAmountThenLabel);
}

function groupedPaymentSources(lines) {
  const groups = new Map();
  const add = (label, amount) => {
    const current = groups.get(label) || { label, count: 0, amountSen: 0 };
    current.count += 1; current.amountSen=addReportSen(current.amountSen,amount); groups.set(label, current);
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
      allocatedSen=addReportSen(allocatedSen,appliedSen);
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
    const sumTypes = types => movements.filter(row => types.includes(row.type.replaceAll(' ', '_')))
      .reduce((sum, row) => addReportSen(sum,Math.abs(row.amountSen)), 0);
    const openedAfterPeriod = Boolean(filters.to && fund.openedAt && businessDate(fund.openedAt) > filters.to);
    // Effective dates can be entered after later ledger rows. Derive the period
    // opening from signed evidence rather than insertion-order balance_after.
    const openingBalanceSen = openedAfterPeriod ? 0 : completeLedger
      .filter(row => filters.from && row.date < filters.from)
      .reduce((sum, row) => addReportSen(sum,row.signedAmountSen), 0);
    const replenishmentsSen = sumTypes(['replenishment']);
    const disbursementsSen = sumTypes(['expense', 'disbursement', 'expense_disbursement']);
    const adjustmentInSen = sumTypes(['adjustment_in']);
    const adjustmentOutSen = sumTypes(['adjustment_out']);
    const ledgerBalanceSen = addReportSen(openingBalanceSen,movements.reduce((sum, row) => addReportSen(sum,row.signedAmountSen), 0));
    const latestCount = [...movements].reverse().find(row => row.type === 'reconciliation' && row.countedBalanceSen != null);
    const currentCount = latestCount && movements.at(-1)?.id === latestCount.id ? latestCount : null;
    const reversals=movements.filter(row=>row.type==='reversal');
    const priorCounts=movements.filter(row=>row.type==='reconciliation'&&row.id!==currentCount?.id);
    const signedTotals=rows=>({
      inSen:rows.reduce((sum,row)=>addReportSen(sum,Math.max(0,row.signedAmountSen)),0),
      outSen:rows.reduce((sum,row)=>addReportSen(sum,Math.max(0,-row.signedAmountSen)),0),
    });
    const reversal=signedTotals(reversals),priorCount=signedTotals(priorCounts);
    const expectedBalanceSen = currentCount ? addReportSen(currentCount.countedBalanceSen,-currentCount.signedAmountSen) : ledgerBalanceSen;
    const countedBalanceSen = currentCount?.countedBalanceSen ?? null;
    return { fund, movements, summary: { openingBalanceSen, replenishmentsSen, disbursementsSen, adjustmentInSen, adjustmentOutSen,
      reversalInSen:reversal.inSen,reversalOutSen:reversal.outSen,priorCountInSen:priorCount.inSen,priorCountOutSen:priorCount.outSen,
      expectedBalanceSen, countedBalanceSen, varianceSen: countedBalanceSen == null ? null : currentCount.signedAmountSen } };
  });
  const movements = fundReports.flatMap(report => report.movements)
    .sort((left, right) => left.createdAtMs-right.createdAtMs || lexical(left.id, right.id));
  const sum = key => fundReports.reduce((total, report) => addReportSen(total,report.summary[key]), 0);
  const allCounted = fundReports.length > 0 && fundReports.every(report => report.summary.countedBalanceSen != null);
  const summary = {
    openingBalanceSen: sum('openingBalanceSen'), replenishmentsSen: sum('replenishmentsSen'), disbursementsSen: sum('disbursementsSen'),
    adjustmentInSen: sum('adjustmentInSen'), adjustmentOutSen: sum('adjustmentOutSen'),
    reversalInSen:sum('reversalInSen'),reversalOutSen:sum('reversalOutSen'),
    priorCountInSen:sum('priorCountInSen'),priorCountOutSen:sum('priorCountOutSen'),expectedBalanceSen: sum('expectedBalanceSen'),
    countedBalanceSen: allCounted ? sum('countedBalanceSen') : null, varianceSen: allCounted ? sum('varianceSen') : null,
    fundBalanceSen:funds.reduce((total,fund)=>addReportSen(total,fund.balanceSen),0),
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
  expenses = [], company = {}, workspace = {}, actor = {}, filters = {}, pettyCash = {},
  analytics = null, serverAnalytics = null, scope = null, summary = null, periods = null, ageing = null,
  categories = null, claimants = null, paymentSources = null, oldestOutstanding = null,
  detailsAvailable = true, detailOmission = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const stamp = new Date(generatedAt);
  if (!Number.isFinite(stamp.getTime())) throw new Error('A valid generated timestamp is required.');
  const asOf = businessDate(stamp);
  const from = clean(filters.from), to = clean(filters.to);
  if (from && to && from > to) throw new Error('The report start date must be on or before the end date.');
  const requestedStatuses = new Set((Array.isArray(filters.statuses) ? filters.statuses : filters.status ? [filters.status] : []).filter(Boolean));
  const requestedSources = new Set((Array.isArray(filters.paymentSources) ? filters.paymentSources : filters.paidBy ? [filters.paidBy] : []).filter(Boolean));
  const query = clean(filters.query).toLocaleLowerCase();
  const suppliedStatusDay=safeDate(analytics?.to || serverAnalytics?.to || to)||asOf;
  const lines = expenses.map(expense => expenseReportLine(expense, { today:suppliedStatusDay })).filter(line =>
    (!from || line.date >= from) && (!to || line.date <= to)
    && (!requestedStatuses.size || requestedStatuses.has(line.status))
    && (!requestedSources.size || requestedSources.has(line.paidByType) || line.paymentSources.some(source => requestedSources.has(source.type)))
    && (!query || [line.reference, line.description, line.category, line.payee, line.paymentSource, ...line.links].join(' ').toLocaleLowerCase().includes(query))
  ).sort((left, right) => lexical(right.date, left.date) || lexical(left.reference, right.reference));
  const postedLines=lines.filter(line=>line.status!=='draft'),draftLines=lines.filter(line=>line.status==='draft');
  const totalSen = postedLines.reduce((sum, line) => addReportSen(sum,line.totalSen), 0);
  const paidSen = postedLines.reduce((sum, line) => addReportSen(sum,line.paidSen), 0);
  const outstandingSen = postedLines.reduce((sum, line) => addReportSen(sum,line.outstandingSen), 0);
  const localTotals = { count: lines.length, draftCount:draftLines.length,
    draftSen:draftLines.reduce((sum,line)=>addReportSen(sum,line.totalSen),0),totalSen, paidSen, outstandingSen,
    evidenceCount: lines.filter(line => line.evidence === 'Attached').length };
  const supplied = analytics || serverAnalytics || (scope || summary || periods || ageing || categories || claimants || paymentSources || oldestOutstanding
    ? {scope,summary,periods,ageing,categories,claimants,paymentSources,pettyCash,oldestOutstanding} : null);
  const insights = normalizeInsights(supplied || {}, localTotals);
  const localCategories = grouped(lines, line => line.category);
  const localClaimants = grouped(lines, line => line.submittedById || line.submittedByName,
    value => lines.find(line => (line.submittedById || line.submittedByName) === value)?.submittedByName || value);
  const localPaymentSources = groupedPaymentSources(lines);
  const normalizedPetty = normalizePettyCash(supplied?.pettyCash?.entries || supplied?.pettyCash?.movements
    ? supplied.pettyCash : pettyCash, { from, to });
  if(insights.pettyCash){normalizedPetty.insights=insights.pettyCash;normalizedPetty.restricted=insights.pettyCash.restricted;}
  return {
    title: 'Expense and Claim Report',
    generatedAt: stamp.toISOString(),
    asOf,
    company: { id: clean(company.id), name: clean(company.name) || 'Company', registration: clean(company.registration), address: clean(company.address) },
    workspace: { id: clean(workspace.id), name: clean(workspace.name) || clean(company.workspaceName) || 'Workspace' },
    actor: { id: clean(actor.id || actor.uid), name: clean(actor.username || actor.name || actor.email) || 'Authorized user' },
    currency: clean(company.preferences?.currency || company.currency) || 'RM',
    filters: { from:insights.from||from, to:insights.to||to, statuses: [...requestedStatuses], paymentSources: [...requestedSources], query,
      grain:insights.grain },
    scope:normalizeScope(supplied?.scope || scope || {},actor),
    lines,
    detailsAvailable:Boolean(detailsAvailable),
    detailOmission:detailsAvailable?null:{reason:clean(detailOmission?.reason)||'projection_unavailable',
      totalCount:Math.max(0,Number(detailOmission?.totalCount||0)),returnedCount:Math.max(0,Number(detailOmission?.returnedCount||0)),
      limit:Math.max(0,Number(detailOmission?.limit||0))},
    totals: insights.summary,
    byStatus: grouped(lines, line => line.status, status => status==='draft'?'Draft (not posted)':labelForStatus(status)),
    byCategory: insights.categories || localCategories,
    byClaimant: insights.claimants || localClaimants,
    byPaymentSource: insights.paymentSources || localPaymentSources,
    periods:insights.periods,
    ageing:insights.ageing,
    oldestOutstanding:insights.oldestOutstanding,
    pettyCash:normalizedPetty,
    analyticsProvided:Boolean(supplied),
  };
}

export function expenseReportFilename(report) {
  const companySlug = slug(report?.company?.name, 'company');
  const range = [report?.filters?.from || 'all', report?.filters?.to || report?.asOf || 'current'].join('-to-');
  return `${companySlug}-expense-report-${range}.pdf`;
}

function claimPayment(row = {}) {
  const eventType=clean(row.eventType || row.event_type || row.type || 'payment').toLowerCase();
  const sourceType=clean(row.sourceType || row.source_type || 'legacy_unspecified');
  const amount=firstInteger(row,['amountSen','amount_sen']);
  const signedAmountSen=Number.isSafeInteger(Number(row.signedAmountSen)) ? exactSen(row.signedAmountSen)
    : eventType==='reversal' ? -Math.abs(amount) : Math.abs(amount);
  const fundName=clean(row.pettyCashFundName || row.fundName);
  const paidBy=clean(row.paidByUserName || row.paidByName || row.paid_by_name);
  return {
    id:clean(row.id),eventType,label:eventType==='reversal'?'Payment reversal':'Payment',
    amountSen:Math.abs(amount),signedAmountSen,sourceType,
    sourceLabel:`${paymentLabel(sourceType)}${sourceType==='petty_cash'&&fundName?` - ${fundName}`:''}`,
    paidBy:paidBy||'-',reference:clean(row.reference)||'-',reason:clean(row.reason)||'-',
    paidOn:safeDate(row.paidOn || row.occurredOn || row.occurred_on || row.date),
    createdAt:safeTimestamp(row.createdAt || row.created_at),
    actorName:clean(row.actorName || row.actor_name || row.actorId || row.actor_id)||'System',
    reversesEventId:clean(row.reversesEventId || row.reverses_event_id || row.reversesPaymentId || row.reverses_payment_id),
  };
}

function lifecycleSnapshot(value = {}) {
  return {
    status:clean(value.status || value.effectiveStatus),
    effectiveStatus:clean(value.effectiveStatus),
    amountSen:firstInteger(value,['amountSen','amount_sen']),paidAmountSen:firstInteger(value,['paidAmountSen','paid_amount_sen']),
    outstandingAmountSen:firstInteger(value,['outstandingAmountSen','outstanding_amount_sen']),
    paidByType:clean(value.paidByType || value.paid_by_type),dueDate:safeDate(value.creditDueDate || value.dueDate),
    paidOn:safeDate(value.paidOn || value.paid_on),voided:Boolean(value.voided || value.voidedAt || value.voided_at),
  };
}

function claimEvent(row = {}) {
  return {
    id:clean(row.id),version:firstInteger(row,['expenseVersion','expense_version','version']),
    action:clean(row.action).replaceAll('_',' ') || 'updated',reason:clean(row.reason)||'-',
    actorName:clean(row.actorName || row.actor_name || row.actorId || row.actor_id)||'System',
    createdAt:safeTimestamp(row.createdAt || row.created_at),
    from:lifecycleSnapshot(row.from || row.fromLifecycle || row.from_lifecycle),
    to:lifecycleSnapshot(row.to || row.toLifecycle || row.to_lifecycle),
  };
}

export function buildExpenseClaimReport({
  expense = null, payments = [], events = [], scope = {}, company = {}, workspace = {}, actor = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!expense || typeof expense !== 'object' || !clean(expense.id || expense.reference || expense.number))
    throw new Error('A valid expense claim is required.');
  const stamp=new Date(generatedAt);
  if(!Number.isFinite(stamp.getTime()))throw new Error('A valid generated timestamp is required.');
  const baseClaim=expenseReportLine(expense,{today:businessDate(stamp)});
  const normalizedPayments=(Array.isArray(payments)?payments:[]).map(claimPayment)
    .sort((left,right)=>lexical(left.createdAt,right.createdAt)||lexical(left.id,right.id));
  const normalizedEvents=(Array.isArray(events)?events:[]).map(claimEvent)
    .sort((left,right)=>left.version-right.version||lexical(left.createdAt,right.createdAt)||lexical(left.id,right.id));
  const timestampedEvents=normalizedEvents.filter(event=>event.createdAt)
    .sort((left,right)=>lexical(left.createdAt,right.createdAt)||lexical(left.id,right.id));
  const originEvent=timestampedEvents.find(event=>['created','imported'].includes(event.action.toLocaleLowerCase()))||timestampedEvents[0];
  const claim={...baseClaim,submittedAt:baseClaim.submittedAt||originEvent?.createdAt||''};
  return {
    kind:'expense_claim',title:'Expense Claim Report',generatedAt:stamp.toISOString(),asOf:businessDate(stamp),
    company:{id:clean(company.id),name:clean(company.name)||'Company',registration:clean(company.registration),address:clean(company.address)},
    workspace:{id:clean(workspace.id),name:clean(workspace.name)||clean(company.workspaceName)||'Workspace'},
    actor:{id:clean(actor.id||actor.uid),name:clean(actor.username||actor.name||actor.email)||'Authorized user'},
    currency:clean(company.preferences?.currency||company.currency)||'RM',scope:normalizeScope(scope,actor),
    claim,payments:normalizedPayments,events:normalizedEvents,
    totals:{totalSen:claim.totalSen,paidSen:claim.paidSen,outstandingSen:claim.outstandingSen,
      paymentNetSen:normalizedPayments.reduce((sum,row)=>addReportSen(sum,row.signedAmountSen),0)},
  };
}

export function expenseClaimReportFilename(report) {
  const companySlug=slug(report?.company?.name,'company'),reference=slug(report?.claim?.reference||report?.claim?.id,'claim');
  return `${companySlug}-expense-claim-${reference}.pdf`;
}
