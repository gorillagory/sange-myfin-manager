export const EXPENSE_STATUSES = Object.freeze(['draft', 'pending_payment', 'partially_paid', 'paid']);
export const EXPENSE_PAID_BY_TYPES = Object.freeze(['unassigned', 'legacy_unspecified', 'app_user', 'non_user', 'petty_cash', 'other', 'credit']);
export const EXPENSE_LINK_TYPES = Object.freeze(['stock_item', 'stock_movement', 'purchase_order', 'goods_receipt']);

export const EXPENSE_STATUS_LABELS = Object.freeze({
  draft: 'Draft',
  pending: 'Pending payment',
  pending_payment: 'Pending payment',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  overdue: 'Overdue',
  voided: 'Voided',
});

export const EXPENSE_PAID_BY_LABELS = Object.freeze({
  unassigned: 'Not assigned',
  legacy_unspecified: 'Legacy / unspecified',
  app_user: 'App user',
  non_user: 'Named non-user',
  petty_cash: 'Reserved petty cash',
  other: 'Other',
  credit: 'Credit / pay later',
});

export const EXPENSE_LINK_LABELS = Object.freeze({
  stock_item: 'Stock item',
  stock_movement: 'Stock movement',
  purchase_order: 'Purchase order',
  goods_receipt: 'Goods receipt',
});

const clean = value => String(value ?? '').trim();
const realDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86400000).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000);

export function normalizeExpenseLinks(links = []) {
  if (!Array.isArray(links) || links.length > 100) throw new Error('Use at most 100 expense links.');
  const seen = new Set();
  return links.map(link => {
    const type = clean(link?.type), id = clean(link?.id);
    if (!EXPENSE_LINK_TYPES.includes(type)) throw new Error('Choose a valid expense link type.');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Choose a valid linked record.');
    const key = `${type}\u0000${id}`;
    if (seen.has(key)) throw new Error('Remove the duplicate expense link.');
    seen.add(key);
    return { type, id };
  });
}

export function normalizeExpenseLifecycle(input = {}, {
  actorId = '', allowLegacy = false, allowRecordedPaymentState = false,
  today = new Date().toISOString().slice(0, 10),
} = {}) {
  const date = clean(input.date);
  if (!realDate(date)) throw new Error('Choose a valid expense date.');
  const rawStatus = clean(input.status || 'paid').toLowerCase();
  const status = rawStatus === 'pending' ? 'pending_payment' : rawStatus;
  const paidByType = clean(input.paidByType || 'other').toLowerCase();
  if (!EXPENSE_STATUSES.includes(status)) throw new Error('Choose a valid expense status.');
  if (!EXPENSE_PAID_BY_TYPES.includes(paidByType)) throw new Error('Choose who paid this expense.');
  if (paidByType === 'legacy_unspecified' && !allowLegacy) throw new Error('Choose who paid this expense.');

  let paidByUserId = clean(input.paidByUserId);
  let paidByName = clean(input.paidByName);
  let creditTermsDays = input.creditTermsDays === '' || input.creditTermsDays == null
    ? null : Number(input.creditTermsDays);
  let creditDueDate = clean(input.creditDueDate);
  let paidOn = clean(input.paidOn);
  let pettyCashFundId = clean(input.pettyCashFundId);

  if (paidByType === 'unassigned') {
    if (['partially_paid', 'paid'].includes(status) && !allowRecordedPaymentState) {
      throw new Error('Choose who paid this expense.');
    }
    paidByUserId = '';
    paidByName = '';
    pettyCashFundId = '';
  } else if (paidByType === 'app_user') {
    paidByUserId ||= clean(actorId);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(paidByUserId)) throw new Error('Choose the app user who paid.');
    paidByName = '';
  } else {
    paidByUserId = '';
  }
  if (paidByType === 'non_user' && !paidByName) throw new Error('Enter the non-user who paid.');
  if (paidByType === 'other' && !paidByName) throw new Error('Describe who paid or the payment source.');
  if (paidByType === 'petty_cash') {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(pettyCashFundId)) throw new Error('Choose a petty cash fund.');
    paidByName = '';
  } else {
    pettyCashFundId = '';
  }

  if (paidByType === 'credit') {
    if (['partially_paid', 'paid'].includes(status) && !allowRecordedPaymentState) {
      throw new Error('Record the credit expense as pending, then record its settlement.');
    }
    if (creditTermsDays != null && (!Number.isInteger(creditTermsDays) || creditTermsDays < 1 || creditTermsDays > 3650)) {
      throw new Error('Credit duration must be between 1 and 3,650 days.');
    }
    if (creditDueDate && !realDate(creditDueDate)) throw new Error('Choose a valid credit due date.');
    if (!creditDueDate && creditTermsDays == null) throw new Error('Enter credit duration or a due date.');
    if (!creditDueDate) creditDueDate = addDays(date, creditTermsDays);
    const derivedDays = daysBetween(date, creditDueDate);
    if (derivedDays < 1 || derivedDays > 3650) throw new Error('Credit must be due 1 to 3,650 days after the expense date.');
    if (creditTermsDays == null) creditTermsDays = derivedDays;
    if (creditDueDate !== addDays(date, creditTermsDays)) throw new Error('Credit duration and due date do not match.');
  } else {
    creditTermsDays = null;
    creditDueDate = '';
    if (paidByType === 'petty_cash') paidByName = '';
  }

  if (status !== 'paid') {
    if (paidOn) throw new Error('An unpaid expense cannot have a settlement date.');
    paidOn = '';
  } else if (!realDate(paidOn)) {
    throw new Error('Choose a valid paid / settlement date.');
  } else if (realDate(today) && paidOn > today) {
    throw new Error('The paid / settlement date cannot be in the future.');
  }

  return {
    status,
    paidByType,
    paidByUserId,
    paidByName,
    creditTermsDays,
    creditDueDate,
    paidOn,
    pettyCashFundId,
    links: normalizeExpenseLinks(input.links || []),
  };
}

export function effectiveExpenseStatus(expense = {}, today = new Date().toISOString().slice(0, 10)) {
  const rawStatus = clean(expense.status).toLowerCase();
  const status = rawStatus === 'pending' ? 'pending_payment'
    : EXPENSE_STATUSES.includes(rawStatus) ? rawStatus : 'paid';
  return ['pending_payment','partially_paid'].includes(status)
    && realDate(clean(expense.creditDueDate)) && expense.creditDueDate < today ? 'overdue' : status;
}

export function expenseHasCashImpact(expense = {}) {
  const rawStatus = clean(expense.status).toLowerCase();
  // Historical payment vouchers use title-cased document statuses. Match the
  // reporting contract: only a Paid or Cleared voucher has moved cash.
  if (expense.type === 'Payment Voucher') return ['paid', 'cleared'].includes(rawStatus);
  if (expense.paidAmountSen !== undefined || expense.paid_amount_sen !== undefined)
    return Number(expense.paidAmountSen ?? expense.paid_amount_sen) > 0;
  if (['draft','pending','pending_payment'].includes(rawStatus)) return false;
  // Historical expense records without an explicit lifecycle status were
  // treated as paid before typed expense lifecycles were introduced.
  return true;
}

export function expenseSaveFailureDisposition(error = {}) {
  if (error?.mutationCommitted) return 'committed';
  if (error?.network) return 'ambiguous';
  return 'rejected';
}

export function expenseCommittedRefreshError(refreshResult, mutationResult) {
  if (refreshResult?.status !== 'failed') return null;
  const error = new Error(refreshResult.error || 'Expense saved, but live data could not be refreshed.');
  return Object.assign(error, { mutationCommitted: true, mutationResult, refreshResult });
}
