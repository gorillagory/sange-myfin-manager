const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function localDate(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function defaultPaymentOperationsRange(now = new Date()) {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const from = new Date(to.getFullYear(), to.getMonth(), 1);
  return { from:localDate(from), to:localDate(to) };
}

export function paymentOperationsQuery({ from, to, provider = '', status = 'all' }) {
  if (!datePattern.test(from || '') || !datePattern.test(to || '')) throw new Error('valid_date_range_required');
  const query = new URLSearchParams({ from, to, status });
  if (provider) query.set('provider', provider);
  else query.set('provider', '');
  return query.toString();
}

export function formatSen(value, currency = 'MYR') {
  let amount;
  try { amount = BigInt(value || 0); } catch { amount = 0n; }
  const negative = amount < 0n;
  if (negative) amount = -amount;
  const code = String(currency || 'MYR').toUpperCase();
  const symbol = code === 'MYR' ? 'RM' : code;
  return `${negative ? '−' : ''}${symbol} ${(amount / 100n).toString()}.${(amount % 100n).toString().padStart(2, '0')}`;
}

export function paymentStatusLabel(value) {
  return ({
    pending:'Pending', matched:'Matched', mismatch:'Mismatch', unavailable:'Unavailable',
  })[value] || 'Unknown';
}

export function paymentReasonLabel(value) {
  if (!value) return 'No reason supplied';
  if (value === 'details_withheld') return 'Provider detail withheld; review the source system';
  return String(value).replace(/[_:-]+/g, ' ').replace(/^./, letter => letter.toUpperCase());
}
