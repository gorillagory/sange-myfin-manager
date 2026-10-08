export const reportDimensions = Object.freeze([
  { value:'channel', label:'Sales channel' },
  { value:'paymentMethod', label:'Payment method' },
  { value:'category', label:'Product category' },
  { value:'subcategory', label:'Product subcategory' },
]);

const labels = Object.freeze({ daily:'Daily', weekly:'Weekly', monthly:'Monthly' });
const weekdayLabels = Object.freeze(['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']);
const clean = value => String(value || '').trim();

export function newReportSchedule() {
  return {
    name:'Daily business summary', cadence:'daily', localTime:'08:00',
    weekday:null, monthDay:null, dimensions:['channel','paymentMethod'], filters:{},
    historyDays:84, forecastHorizon:14, enabled:false,
  };
}

export function reportSchedulePayload(value = {}) {
  const cadence = ['daily','weekly','monthly'].includes(value.cadence) ? value.cadence : 'daily';
  const dimensions = [...new Set((value.dimensions || []).filter(dimension =>
    reportDimensions.some(option => option.value === dimension)))];
  const filters = Object.fromEntries(['channel','paymentMethod','category','subcategory']
    .map(key => [key,clean(value.filters?.[key])]).filter(([,entry]) => entry));
  return {
    ...(Number(value.version) > 0 ? { version:Number(value.version) } : {}),
    name:clean(value.name), cadence, localTime:clean(value.localTime),
    weekday:cadence === 'weekly' ? Number(value.weekday) : null,
    monthDay:cadence === 'monthly' ? Number(value.monthDay) : null,
    dimensions, filters,
    historyDays:Number(value.historyDays), forecastHorizon:Number(value.forecastHorizon),
    enabled:Boolean(value.enabled),
  };
}

export function reportScheduleDescription(schedule = {}) {
  const time = clean(schedule.localTime) || '00:00';
  if (schedule.cadence === 'weekly')
    return `${labels.weekly} on ${weekdayLabels[Number(schedule.weekday) - 1] || 'selected day'} at ${time} MYT`;
  if (schedule.cadence === 'monthly')
    return `${labels.monthly} on day ${Number(schedule.monthDay) || 1} at ${time} MYT`;
  return `${labels.daily} at ${time} MYT`;
}

export function reportRunLabel(run = {}) {
  const status = clean(run.status).replaceAll('_', ' ');
  const period = run.period || {};
  return `${status ? status[0].toUpperCase() + status.slice(1) : 'Pending'} · ${period.from || '—'} to ${period.to || '—'}`;
}

export function forecastPresentation(forecast = {}) {
  if (forecast.status !== 'ready') return {
    ready:false,
    title:'More history needed',
    detail:`${Number(forecast.sampleSize || 0)} of ${Number(forecast.minimumSampleSize || 28)} daily observations available.`,
    points:[],
  };
  const wape = forecast.metrics?.wape;
  return {
    ready:true,
    title:`${clean(forecast.confidence?.level) || 'Low'} confidence forecast`,
    detail:`Weekday baseline · MAE ${Number(forecast.metrics?.mae || 0).toFixed(2)}${wape === null || wape === undefined ? '' : ` · WAPE ${Number(wape).toFixed(2)}%`}`,
    points:forecast.points || [],
  };
}
