import { cents } from './pos.js';

export function reportRange(from, to, maxDays = 366) {
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(from) || !valid(to)) return 'Choose valid start and end dates.';
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days < 0) return 'The end date must be on or after the start date.';
  if (days > maxDays) return `Choose a range of ${maxDays + 1} days or less.`;
  return '';
}

export function reportBuckets(daily = [], cadence = 'day') {
  if (!['day', 'week', 'month'].includes(cadence)) throw new Error('Unknown report interval');
  const buckets = new Map();
  for (const day of daily) {
    const date = String(day.date);
    let key = date;
    if (cadence === 'month') key = date.slice(0, 7);
    if (cadence === 'week') {
      const utc = new Date(`${date}T00:00:00Z`);
      utc.setUTCDate(utc.getUTCDate() - ((utc.getUTCDay() + 6) % 7));
      key = utc.toISOString().slice(0, 10);
    }
    if (!buckets.has(key)) buckets.set(key, { key, from: date, to: date, sales: 0, tax: 0, expenses: 0, cashFlow: 0 });
    const bucket = buckets.get(key);
    bucket.to = date;
    for (const name of ['sales', 'tax', 'expenses', 'cashFlow']) bucket[name] += cents(day[name]);
  }
  return [...buckets.values()].map(bucket => ({ ...bucket, sales: bucket.sales / 100, tax: bucket.tax / 100, expenses: bucket.expenses / 100, cashFlow: bucket.cashFlow / 100 }));
}

export function reportBucketLabel(bucket, cadence) {
  if (cadence === 'month') return new Intl.DateTimeFormat('en-MY', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${bucket.key}-01T00:00:00Z`));
  if (cadence === 'week') return `Week of ${bucket.key}`;
  return bucket.key;
}
