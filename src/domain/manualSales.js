import { businessDate } from './pos.js';

// The app's accounting calendar is currently fixed to Malaysia time. Keep the
// datetime-local conversion here so a manager's browser timezone cannot move a
// recorded sale onto a different business day.
export const BUSINESS_TIME_ZONE = 'Asia/Kuala_Lumpur';
export const MANUAL_SALE_BACKDATE_DAYS = 7;
const BUSINESS_UTC_OFFSET = '+08:00';

export function businessDateTimeInput(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function manualSaleOccurredAt(value) {
  const localValue = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localValue))
    throw new Error('Choose when the sale occurred.');
  const instant = new Date(`${localValue}:00${BUSINESS_UTC_OFFSET}`);
  if (!Number.isFinite(instant.getTime()) ||
      businessDate(instant, BUSINESS_TIME_ZONE) !== localValue.slice(0, 10) ||
      businessDateTimeInput(instant) !== localValue)
    throw new Error('Choose a valid Malaysia sale date and time.');
  return instant.toISOString();
}

export function manualSaleEarliestInput(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${businessDate(new Date(date.getTime() - MANUAL_SALE_BACKDATE_DAYS * 86400000), BUSINESS_TIME_ZONE)}T00:00`;
}
