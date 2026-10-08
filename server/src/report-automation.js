import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { owner, requireCapability } from './access.js';
import * as v from './validation.js';

export const REPORT_TIMEZONE = 'Asia/Kuala_Lumpur';
const MALAYSIA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DIMENSIONS = ['channel', 'paymentMethod', 'category', 'subcategory'];
const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const filterValue = z.string().trim().min(1).max(120).optional();
const filtersSchema = z.strictObject({
  channel: z.enum(['pos', 'invoice']).optional(),
  paymentMethod: filterValue,
  category: filterValue,
  subcategory: filterValue,
}).default({});
const definitionShape = {
  name: z.string().trim().min(1).max(160),
  cadence: z.enum(['daily', 'weekly', 'monthly']),
  localTime: localTimeSchema,
  weekday: z.number().int().min(1).max(7).nullable().optional(),
  monthDay: z.number().int().min(1).max(28).nullable().optional(),
  dimensions: z.array(z.enum(DIMENSIONS)).min(1).max(DIMENSIONS.length)
    .refine(values => new Set(values).size === values.length, 'duplicate_dimensions'),
  filters: filtersSchema,
  historyDays: z.number().int().min(28).max(366).default(84),
  forecastHorizon: z.number().int().min(1).max(31).default(14),
  enabled: z.boolean().default(false),
};
const definitionSchema = z.strictObject(definitionShape).superRefine((value, context) => {
  const weekday = value.weekday ?? null, monthDay = value.monthDay ?? null;
  if ((value.cadence === 'weekly') !== (weekday !== null))
    context.addIssue({ code:'custom', path:['weekday'], message:'weekday_required_for_weekly' });
  if ((value.cadence === 'monthly') !== (monthDay !== null))
    context.addIssue({ code:'custom', path:['monthDay'], message:'month_day_required_for_monthly' });
});
const updateSchema = z.strictObject({ version:z.number().int().positive(), ...definitionShape })
  .superRefine((value, context) => {
    const weekday = value.weekday ?? null, monthDay = value.monthDay ?? null;
    if ((value.cadence === 'weekly') !== (weekday !== null))
      context.addIssue({ code:'custom', path:['weekday'], message:'weekday_required_for_weekly' });
    if ((value.cadence === 'monthly') !== (monthDay !== null))
      context.addIssue({ code:'custom', path:['monthDay'], message:'month_day_required_for_monthly' });
  });
const runsQuerySchema = z.strictObject({
  scheduleId: v.id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function validDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid_instant');
  return date;
}

function localParts(value) {
  const shifted = new Date(validDate(value).getTime() + MALAYSIA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay() || 7,
  };
}

function localInstant({ year, month, day, hour = 0, minute = 0 }) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - MALAYSIA_OFFSET_MS);
}

function parseLocalTime(value) {
  const text = String(value || '').slice(0, 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new TypeError('invalid_local_time');
  return { hour:Number(text.slice(0, 2)), minute:Number(text.slice(3, 5)) };
}

function addLocalDays(parts, count) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + count));
  return { year:date.getUTCFullYear(), month:date.getUTCMonth() + 1, day:date.getUTCDate() };
}

function isoDate(parts) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function nextScheduledAt(definition, after = new Date()) {
  const current = validDate(after), parts = localParts(current), time = parseLocalTime(definition.localTime ?? definition.local_time);
  const cadence = definition.cadence;
  let target;
  if (cadence === 'daily') {
    target = localInstant({ ...parts, ...time });
    if (target <= current) target = localInstant({ ...addLocalDays(parts, 1), ...time });
  } else if (cadence === 'weekly') {
    const weekday = Number(definition.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new TypeError('invalid_weekday');
    const candidate = addLocalDays(parts, (weekday - parts.weekday + 7) % 7);
    target = localInstant({ ...candidate, ...time });
    if (target <= current) target = localInstant({ ...addLocalDays(candidate, 7), ...time });
  } else if (cadence === 'monthly') {
    const monthDay = Number(definition.monthDay ?? definition.month_day);
    if (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 28) throw new TypeError('invalid_month_day');
    target = localInstant({ year:parts.year, month:parts.month, day:monthDay, ...time });
    if (target <= current) target = localInstant({
      year:parts.month === 12 ? parts.year + 1 : parts.year,
      month:parts.month === 12 ? 1 : parts.month + 1,
      day:monthDay, ...time,
    });
  } else throw new TypeError('invalid_cadence');
  return target;
}

export function reportWindowForRun(scheduledFor, cadence) {
  const runDay = localParts(scheduledFor);
  if (cadence === 'monthly') {
    const currentMonth = new Date(Date.UTC(runDay.year, runDay.month - 1, 1));
    const fromDate = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() - 1, 1));
    const toDate = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth(), 0));
    return {
      from:fromDate.toISOString().slice(0, 10),
      to:toDate.toISOString().slice(0, 10),
    };
  }
  const end = addLocalDays(runDay, -1);
  const start = cadence === 'weekly' ? addLocalDays(end, -6) : cadence === 'daily' ? end : null;
  if (!start) throw new TypeError('invalid_cadence');
  return { from:isoDate(start), to:isoDate(end) };
}

export function reportRunKey(companyId, scheduleId, scheduledFor) {
  const instant = validDate(scheduledFor).toISOString();
  return createHash('sha256').update(`scheduled-report\0${companyId}\0${scheduleId}\0${instant}`).digest('hex');
}

export function reportRetryDelayMs(attemptCount) {
  const attempt = Math.max(1, Math.min(10, Number(attemptCount) || 1));
  return Math.min(6 * 60 * 60 * 1000, 60 * 1000 * (5 ** (attempt - 1)));
}

function definitionSnapshot(row) {
  return {
    schemaVersion:1,
    reportType:'financial_summary',
    name:row.name,
    cadence:row.cadence,
    timezone:REPORT_TIMEZONE,
    localTime:String(row.local_time ?? row.localTime).slice(0, 5),
    weekday:row.weekday === null || row.weekday === undefined ? null : Number(row.weekday),
    monthDay:row.month_day === null || row.month_day === undefined ? null : Number(row.month_day),
    dimensions:[...(row.dimensions || [])],
    filters:{ ...(row.filters || {}) },
    historyDays:Number(row.history_days ?? row.historyDays),
    forecastHorizon:Number(row.forecast_horizon ?? row.forecastHorizon),
    deliveryChannel:'in_app',
    scheduleVersion:Number(row.version),
  };
}

function scheduleOutput(row) {
  return {
    id:row.id, companyId:row.company_id, name:row.name, reportType:row.report_type,
    cadence:row.cadence, timezone:row.timezone,
    localTime:String(row.local_time).slice(0, 5),
    weekday:row.weekday === null ? null : Number(row.weekday),
    monthDay:row.month_day === null ? null : Number(row.month_day),
    dimensions:row.dimensions || [], filters:row.filters || {},
    historyDays:Number(row.history_days), forecastHorizon:Number(row.forecast_horizon),
    deliveryChannel:row.delivery_channel, enabled:row.enabled, version:Number(row.version),
    nextRunAt:row.next_run_at, createdAt:row.created_at, updatedAt:row.updated_at,
  };
}

function runOutput(row, includeResult = false) {
  return {
    id:row.id, companyId:row.company_id, scheduleId:row.schedule_id,
    scheduledFor:row.scheduled_for, status:row.status,
    attemptCount:Number(row.attempt_count), maxAttempts:Number(row.max_attempts),
    nextAttemptAt:row.next_attempt_at, period:{ from:String(row.period_from), to:String(row.period_to) },
    definition:row.definition_snapshot, errorCode:row.error_code || '',
    startedAt:row.started_at, completedAt:row.completed_at, createdAt:row.created_at,
    ...(includeResult ? { result:row.result_snapshot || null } : {}),
  };
}

function valuesFrom(body) {
  return [
    body.name, body.cadence, REPORT_TIMEZONE, body.localTime,
    body.weekday ?? null, body.monthDay ?? null, JSON.stringify(body.dimensions), JSON.stringify(body.filters),
    body.historyDays, body.forecastHorizon, body.enabled,
  ];
}

export function registerReportAutomation(app, { scoped, audit = async () => {}, clock = () => new Date() }) {
  app.get('/api/companies/:company/report-schedules', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'financialReports');
    const result = await c.query(`SELECT * FROM myfin.report_schedules
      WHERE company_id=$1 ORDER BY name,id`, [companyId]);
    return { schedules:result.rows.map(scheduleOutput), deliveryPolicy:{ channels:['in_app'], outbound:false } };
  }));

  app.post('/api/companies/:company/report-schedules', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'financialReports');
    if (!owner(req.identity)) v.fail(403, 'owner_required');
    const body = v.parse(definitionSchema, req.body), now = validDate(clock());
    const id = randomUUID(), nextRunAt = nextScheduledAt(body, now);
    const result = await c.query(`INSERT INTO myfin.report_schedules(
      company_id,id,name,cadence,timezone,local_time,weekday,month_day,dimensions,filters,
      history_days,forecast_horizon,enabled,next_run_at,created_by,updated_by,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$16) RETURNING *`,
    [companyId,id,...valuesFrom(body),nextRunAt,req.identity.id,now]);
    await audit(c, req.identity, companyId, 'Report schedule created', `${body.name} · ${body.cadence}`);
    return scheduleOutput(result.rows[0]);
  }));

  app.put('/api/companies/:company/report-schedules/:id', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'financialReports');
    if (!owner(req.identity)) v.fail(403, 'owner_required');
    const id = v.parse(v.id, req.params.id), body = v.parse(updateSchema, req.body), now = validDate(clock());
    const current = await c.query(`SELECT version,enabled FROM myfin.report_schedules
      WHERE company_id=$1 AND id=$2 FOR UPDATE`, [companyId,id]);
    if (!current.rowCount) v.fail(404, 'report_schedule_not_found');
    if (Number(current.rows[0].version) !== body.version) v.fail(409, 'report_schedule_changed');
    const nextRunAt = nextScheduledAt(body, now);
    const result = await c.query(`UPDATE myfin.report_schedules SET
      name=$3,cadence=$4,timezone=$5,local_time=$6,weekday=$7,month_day=$8,dimensions=$9,
      filters=$10,history_days=$11,forecast_horizon=$12,enabled=$13,next_run_at=$14,
      updated_by=$15,updated_at=$16,version=version+1
      WHERE company_id=$1 AND id=$2 AND version=$17 RETURNING *`,
    [companyId,id,...valuesFrom(body),nextRunAt,req.identity.id,now,body.version]);
    if (!result.rowCount) v.fail(409, 'report_schedule_changed');
    if (current.rows[0].enabled && !body.enabled) await c.query(`UPDATE myfin.report_runs
      SET status='cancelled',completed_at=$3,updated_at=$3
      WHERE company_id=$1 AND schedule_id=$2 AND status IN ('pending','failed')`, [companyId,id,now]);
    await audit(c, req.identity, companyId, 'Report schedule updated',
      `${body.name} · ${body.cadence} · ${body.enabled ? 'enabled' : 'disabled'}`);
    return scheduleOutput(result.rows[0]);
  }));

  app.get('/api/companies/:company/report-runs', req => scoped(req, async (c, companyId) => {
    requireCapability(req.identity, 'financialReports');
    const query = v.parse(runsQuerySchema, req.query);
    const result = await c.query(`SELECT * FROM myfin.report_runs
      WHERE company_id=$1 AND ($2::text IS NULL OR schedule_id=$2)
      ORDER BY scheduled_for DESC,id DESC LIMIT $3`, [companyId,query.scheduleId || null,query.limit]);
    return { runs:result.rows.map(row => runOutput(row, false)) };
  }));

  app.get('/api/companies/:company/report-runs/:id', req => scoped(req, async (c, companyId) => {
    // Authorization is deliberately checked on every read. A cached creator id
    // never grants access after a membership or financial-report capability is revoked.
    requireCapability(req.identity, 'financialReports');
    const id = v.parse(v.id, req.params.id);
    const result = await c.query('SELECT * FROM myfin.report_runs WHERE company_id=$1 AND id=$2', [companyId,id]);
    if (!result.rowCount) v.fail(404, 'report_run_not_found');
    return runOutput(result.rows[0], true);
  }));
}

export const reportAutomationInternals = Object.freeze({
  definitionSchema, updateSchema, definitionSnapshot, scheduleOutput, runOutput,
});
