import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { createDatabase } from './database.js';
import { runCustomerOrderMaintenance } from './customer-order-maintenance.js';
import { createPaymentGatewayRuntime } from './payment-gateways.js';
import { runOnlinePaymentReconciliation } from './payment-gateway-maintenance.js';
import { companyReport, companyRows } from './reporting.js';
import {
  nextScheduledAt, reportAutomationInternals, reportRetryDelayMs, reportRunKey, reportWindowForRun,
} from './report-automation.js';

const { definitionSnapshot } = reportAutomationInternals;
const DAY_MS = 86400000;

function dateAdd(value, amount) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new TypeError('invalid_report_date');
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

export function processWorkerIdentity(base = 'report-worker', nonce = randomUUID()) {
  const prefix = String(base || '');
  if (!/^[A-Za-z0-9._:-]{1,91}$/.test(prefix) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(nonce || '')))
    throw new TypeError('invalid_worker_id');
  return `${prefix}:${nonce}`;
}

function leaseGeneration(run) {
  const generation = Number(run?.attempt_count);
  if (!Number.isInteger(generation) || generation < 1 || generation > 10)
    throw new TypeError('invalid_report_run_lease_generation');
  return generation;
}

function insufficientForecast({ asOf, horizon, sampleSize, reason, dataFrom = null, dataThrough = null }) {
  return {
    status:'insufficient_history', advisory:true, method:'weekday_seasonal_mean',
    asOf, dataFrom, dataThrough, sampleSize, minimumSampleSize:28, horizon,
    reason, points:[], metrics:null,
    confidence:{ level:'unavailable', basis:'history_length_and_walk_forward_error' },
    uncertainty:{ method:'historical_absolute_error_p80', value:null },
    actions:{ automaticOrdering:false },
  };
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(percentileValue * ordered.length) - 1)];
}

function weekday(date) {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function baseline(values, dates, targetDate, beforeIndex = values.length) {
  const targetWeekday = weekday(targetDate), candidates = [];
  for (let index = 0; index < beforeIndex; index++)
    if (weekday(dates[index]) === targetWeekday) candidates.push(values[index]);
  return candidates.length >= 2 ? { value:mean(candidates.slice(-8)), samples:Math.min(8, candidates.length) } : null;
}

/**
 * Transparent advisory baseline: the next value is the mean of up to eight
 * earlier values for the same weekday. Accuracy is measured by walk-forward
 * backtesting; no future observation is used to predict an earlier day.
 */
export function weekdaySeasonalForecast(daily, {
  metric = 'sales', asOf = new Date().toISOString(), horizon = 14, precision = 2,
} = {}) {
  const asOfInstant = new Date(asOf);
  if (!Number.isFinite(asOfInstant.getTime())) throw new TypeError('invalid_forecast_as_of');
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 31) throw new TypeError('invalid_forecast_horizon');
  if (!Number.isInteger(precision) || precision < 0 || precision > 4) throw new TypeError('invalid_forecast_precision');
  const rows = [...(daily || [])].sort((left, right) => String(left.date).localeCompare(String(right.date)));
  const dates = [], values = [];
  for (const row of rows) {
    const date = String(row.date || ''), value = Number(row[metric]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date)
      return insufficientForecast({ asOf:asOfInstant.toISOString(), horizon, sampleSize:dates.length, reason:'invalid_history_date' });
    if (dates.at(-1) === date || !Number.isFinite(value) || value < 0)
      return insufficientForecast({ asOf:asOfInstant.toISOString(), horizon, sampleSize:dates.length, reason:'invalid_history_value' });
    dates.push(date); values.push(value);
  }
  const boundaries = { dataFrom:dates[0] || null, dataThrough:dates.at(-1) || null };
  if (dates.length < 28)
    return insufficientForecast({ asOf:asOfInstant.toISOString(), horizon, sampleSize:dates.length,
      reason:'minimum_28_contiguous_days_required', ...boundaries });
  for (let index = 1; index < dates.length; index++) {
    const expected = dateAdd(dates[index - 1], 1);
    if (dates[index] !== expected)
      return insufficientForecast({ asOf:asOfInstant.toISOString(), horizon, sampleSize:dates.length,
        reason:'contiguous_daily_history_required', ...boundaries });
  }

  const absoluteErrors = [], absoluteActuals = [];
  for (let index = 14; index < dates.length; index++) {
    const predicted = baseline(values, dates, dates[index], index);
    if (!predicted) continue;
    absoluteErrors.push(Math.abs(values[index] - predicted.value));
    absoluteActuals.push(Math.abs(values[index]));
  }
  if (absoluteErrors.length < 14)
    return insufficientForecast({ asOf:asOfInstant.toISOString(), horizon, sampleSize:dates.length,
      reason:'minimum_walk_forward_sample_required', ...boundaries });

  const mae = mean(absoluteErrors), actualTotal = absoluteActuals.reduce((sum, value) => sum + value, 0);
  const wape = actualTotal ? absoluteErrors.reduce((sum, value) => sum + value, 0) / actualTotal * 100 : null;
  const uncertainty = percentile(absoluteErrors, 0.8) || 0;
  const confidenceLevel = dates.length >= 84 && wape !== null && wape <= 20 ? 'high'
    : dates.length >= 56 && wape !== null && wape <= 40 ? 'medium' : 'low';
  const points = [];
  for (let offset = 1; offset <= horizon; offset++) {
    const date = dateAdd(dates.at(-1), offset), predicted = baseline(values, dates, date);
    if (!predicted) throw new Error('forecast_baseline_unavailable');
    points.push({
      date, value:round(predicted.value, precision),
      lower:round(Math.max(0, predicted.value - uncertainty), precision),
      upper:round(predicted.value + uncertainty, precision),
      weekdaySamples:predicted.samples,
    });
  }
  return {
    status:'ready', advisory:true, method:'weekday_seasonal_mean', asOf:asOfInstant.toISOString(),
    dataFrom:dates[0], dataThrough:dates.at(-1), sampleSize:dates.length,
    minimumSampleSize:28, horizon, points,
    metrics:{ backtestSamples:absoluteErrors.length, mae:round(mae, 2), wape:wape === null ? null : round(wape, 2) },
    confidence:{ level:confidenceLevel, basis:'history_length_and_walk_forward_wape' },
    uncertainty:{ method:'historical_absolute_error_p80', value:round(uncertainty, precision) },
    assumptions:[
      'Recent same-weekday history is representative of the forecast horizon.',
      'Known promotions, closures, stock-outs and external events are not modeled.',
    ],
    actions:{ automaticOrdering:false },
  };
}

export async function enqueueDueReportRuns(c, { now = new Date(), limit = 25 } = {}) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new TypeError('invalid_worker_time');
  const due = await c.query(`SELECT s.* FROM myfin.report_schedules s
    JOIN myfin.companies co ON co.id=s.company_id
    JOIN myfin.workspaces w ON w.id=co.workspace_id
    WHERE s.enabled AND s.next_run_at <= $1
      AND co.archived_at IS NULL AND co.suspended_at IS NULL
      AND w.archived_at IS NULL AND w.suspended_at IS NULL
    ORDER BY s.next_run_at,s.company_id,s.id
    FOR UPDATE OF s SKIP LOCKED LIMIT $2`, [instant,limit]);
  let enqueued = 0;
  for (const schedule of due.rows) {
    const scheduledFor = new Date(schedule.next_run_at), period = reportWindowForRun(scheduledFor, schedule.cadence);
    const inserted = await c.query(`INSERT INTO myfin.report_runs(
      company_id,id,schedule_id,run_key,scheduled_for,status,next_attempt_at,period_from,period_to,
      definition_snapshot,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'pending',$5,$6,$7,$8,$9,$9)
      ON CONFLICT(company_id,run_key) DO NOTHING`, [
      schedule.company_id,randomUUID(),schedule.id,reportRunKey(schedule.company_id,schedule.id,scheduledFor),
      scheduledFor,period.from,period.to,definitionSnapshot(schedule),instant,
    ]);
    enqueued += inserted.rowCount || 0;
    await c.query(`UPDATE myfin.report_schedules SET next_run_at=$3,updated_at=$4
      WHERE company_id=$1 AND id=$2`, [
      schedule.company_id,schedule.id,nextScheduledAt(schedule, scheduledFor),instant,
    ]);
  }
  return { due:due.rowCount, enqueued };
}

export async function reapExpiredReportRuns(c, { now = new Date() } = {}) {
  const instant = new Date(now);
  const cancelled = await c.query(`UPDATE myfin.report_runs r
    SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,
      completed_at=$1,updated_at=$1
    FROM myfin.report_schedules s
    WHERE s.company_id=r.company_id AND s.id=r.schedule_id AND NOT s.enabled
      AND (r.status IN ('pending','failed')
        OR (r.status='running' AND r.lease_expires_at <= $1))`, [instant]);
  const exhausted = await c.query(`UPDATE myfin.report_runs
    SET status='failed',lease_owner=NULL,lease_expires_at=NULL,error_code='retry_limit_reached',
      next_attempt_at=$1,updated_at=$1
    WHERE status='running' AND lease_expires_at <= $1 AND attempt_count >= max_attempts`, [instant]);
  return { cancelled:cancelled.rowCount || 0, exhausted:exhausted.rowCount || 0 };
}

export async function claimQueuedReportRuns(c, {
  workerId, now = new Date(), limit = 5, leaseMs = 120000,
} = {}) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(workerId || ''))) throw new TypeError('invalid_worker_id');
  const instant = new Date(now), leaseExpiresAt = new Date(instant.getTime() + leaseMs);
  if (!Number.isFinite(instant.getTime()) || !Number.isInteger(leaseMs) || leaseMs < 30000 || leaseMs > 900000)
    throw new TypeError('invalid_worker_lease');
  // attempt_count doubles as the lease generation. The value returned by this
  // atomic claim must match before a worker may complete or fail the run.
  const result = await c.query(`WITH candidates AS (
      SELECT r.company_id,r.id FROM myfin.report_runs r
      JOIN myfin.report_schedules s ON s.company_id=r.company_id AND s.id=r.schedule_id
      JOIN myfin.companies co ON co.id=r.company_id
      JOIN myfin.workspaces w ON w.id=co.workspace_id
      WHERE s.enabled AND co.archived_at IS NULL AND co.suspended_at IS NULL
        AND w.archived_at IS NULL AND w.suspended_at IS NULL
        AND r.attempt_count < r.max_attempts AND (
        (r.status IN ('pending','failed') AND r.next_attempt_at <= $1)
        OR (r.status='running' AND r.lease_expires_at <= $1)
      )
      ORDER BY r.next_attempt_at,r.scheduled_for,r.company_id,r.id
      FOR UPDATE OF r SKIP LOCKED LIMIT $2
    )
    UPDATE myfin.report_runs r SET status='running',attempt_count=r.attempt_count+1,
      lease_owner=$3,lease_expires_at=$4,started_at=$1,error_code=NULL,updated_at=$1
    FROM candidates c WHERE r.company_id=c.company_id AND r.id=c.id
    RETURNING r.*`, [instant,limit,workerId,leaseExpiresAt]);
  return result.rows;
}

export async function claimDueReportRuns(database, options = {}) {
  return database.transaction(async c => {
    const reaped = await reapExpiredReportRuns(c, options);
    const queue = await enqueueDueReportRuns(c, options);
    const runs = await claimQueuedReportRuns(c, options);
    return { ...reaped, ...queue, runs };
  });
}

function transactionCounts(report) {
  const counts = new Map(report.daily.map(row => [row.date, 0]));
  for (const sale of report.sales) counts.set(sale.date, (counts.get(sale.date) || 0) + 1);
  return report.daily.map(row => ({ date:row.date, transactions:counts.get(row.date) || 0 }));
}

function minDate(...values) { return [...values].sort()[0]; }
function maxDate(...values) { return [...values].sort().at(-1); }

export async function buildScheduledReportSnapshot(c, run, {
  loadRows = companyRows, compileReport = companyReport, clock = () => new Date(), loadCompany = async (client, companyId) => {
    const result = await client.query(`SELECT co.name,coalesce(nullif(co.data->'preferences'->>'currency',''),'RM') AS currency
      FROM myfin.companies co JOIN myfin.workspaces w ON w.id=co.workspace_id
      WHERE co.id=$1 AND co.archived_at IS NULL AND co.suspended_at IS NULL
        AND w.archived_at IS NULL AND w.suspended_at IS NULL`, [companyId]);
    if (!result.rowCount) throw Object.assign(new Error('company_unavailable'), { code:'company_unavailable' });
    return result.rows[0];
  },
} = {}) {
  const definition = run.definition_snapshot, period = {
    from:String(run.period_from).slice(0, 10), to:String(run.period_to).slice(0, 10),
  };
  const historyTo = reportWindowForRun(run.scheduled_for, 'daily').to;
  const historyFrom = dateAdd(historyTo, -(Number(definition.historyDays) - 1));
  const fetchFrom = minDate(period.from, historyFrom), fetchTo = maxDate(period.to, historyTo);
  const [company, rows] = await Promise.all([
    loadCompany(c, run.company_id), loadRows(c, [run.company_id], fetchFrom, fetchTo),
  ]);
  const report = compileReport(rows, period.from, period.to, definition.filters || {});
  const history = compileReport(rows, historyFrom, historyTo, definition.filters || {});
  const asOf = new Date(run.scheduled_for).toISOString(), horizon = Number(definition.forecastHorizon);
  const breakdowns = Object.fromEntries((definition.dimensions || [])
    .filter(dimension => report.breakdowns[dimension])
    .map(dimension => [dimension,report.breakdowns[dimension]]));
  return {
    schemaVersion:1, kind:'scheduled_financial_summary', generatedAt:new Date(clock()).toISOString(),
    scheduledFor:asOf, company:{ id:run.company_id, name:company.name, currency:company.currency },
    period, definition, totals:report.totals, daily:report.daily, breakdowns,
    filters:report.filters, filterScope:report.filterScope, basis:report.basis,
    counts:{ sales:report.sales.length, expenses:report.expenses.length,
      receipts:report.receipts.length, quotes:report.quotes.length },
    forecast:{
      advisory:true,
      sales:weekdaySeasonalForecast(history.daily, { metric:'sales', asOf, horizon, precision:2 }),
      transactionVolume:weekdaySeasonalForecast(transactionCounts(history), {
        metric:'transactions', asOf, horizon, precision:2,
      }),
      actions:{ automaticOrdering:false },
    },
    delivery:{ channel:'in_app', outbound:false },
  };
}

export async function completeReportRun(database, run, result, now = new Date()) {
  const generation = leaseGeneration(run);
  return database.transaction(async c => {
    const saved = await c.query(`UPDATE myfin.report_runs SET status='completed',result_snapshot=$5,
      lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,completed_at=$4,updated_at=$4
      WHERE company_id=$1 AND id=$2 AND status='running' AND lease_owner=$3
        AND attempt_count=$6 AND lease_expires_at > $4 RETURNING id`,
    [run.company_id,run.id,run.lease_owner,new Date(now),result,generation]);
    if (!saved.rowCount) throw Object.assign(new Error('report_run_lease_lost'), { code:'report_run_lease_lost' });
    return true;
  });
}

function safeWorkerError(error) {
  return ['company_unavailable','report_run_lease_lost'].includes(error?.code) ? error.code : 'report_generation_failed';
}

export async function failReportRun(database, run, error, now = new Date()) {
  const generation = leaseGeneration(run);
  const instant = new Date(now), retryAt = new Date(instant.getTime() + reportRetryDelayMs(generation));
  return database.transaction(async c => {
    const failed = await c.query(`UPDATE myfin.report_runs SET status='failed',next_attempt_at=$5,
      lease_owner=NULL,lease_expires_at=NULL,error_code=$4,updated_at=$3
      WHERE company_id=$1 AND id=$2 AND status='running' AND lease_owner=$6
        AND attempt_count=$7 AND lease_expires_at>$3 RETURNING id`,
    [run.company_id,run.id,instant,safeWorkerError(error),retryAt,run.lease_owner,generation]);
    return failed.rowCount === 1;
  });
}

export async function runReportWorkerCycle(database, {
  workerId = `report-worker-${randomUUID()}`, now = new Date(), limit = 5, leaseMs = 120000,
  clock = () => new Date(), maintenanceLimit = 100,
  maintainOrders = runCustomerOrderMaintenance, claimRuns = claimDueReportRuns,
  paymentGateway = null, reconcilePayments = runOnlinePaymentReconciliation,
} = {}) {
  let maintenance;
  try {
    maintenance = { ...await maintainOrders(database, { now,limit:maintenanceLimit }), failed:false,retry:false };
  } catch {
    // The next poll retries the same database-derived work. Do not include raw
    // errors because driver messages can contain connection or schema details.
    maintenance = { selected:0,expired:0,redacted:0,companies:0,
      storefrontPricingSnapshotsSelected:0,storefrontPricingSnapshotsDeleted:0,
      hasMore:true,failed:true,retry:true };
  }
  let paymentMaintenance;
  try {
    paymentMaintenance = { ...await reconcilePayments(database,paymentGateway,{
      now,limit:Math.min(maintenanceLimit,5),workerId,
    }),failed:false,retry:false };
  } catch {
    // Provider and database details stay out of worker logs. Persisted jobs and
    // immutable observations make the next cycle safe to retry.
    paymentMaintenance = { enabled:Boolean(paymentGateway?.enabled),seeded:0,closed:0,claimed:0,
      observed:0,pending:0,terminalUnpaid:0,expiredOrders:0,retrying:0,escalated:0,
      openEscalations:0,hasMore:true,failed:true,retry:true };
  }
  const claimed = await claimRuns(database, { workerId,now,limit,leaseMs });
  let completed = 0, failed = 0;
  for (const run of claimed.runs) {
    try {
      const snapshot = await database.transaction(c => buildScheduledReportSnapshot(c, run, { clock }));
      await completeReportRun(database, run, snapshot, clock());
      completed++;
    } catch (error) {
      if (error?.code !== 'report_run_lease_lost') await failReportRun(database, run, error, clock());
      failed++;
    }
  }
  return { maintenance,paymentMaintenance,cancelled:claimed.cancelled, exhausted:claimed.exhausted,
    due:claimed.due, enqueued:claimed.enqueued, claimed:claimed.runs.length, completed, failed };
}

export async function startReportWorker(database, {
  workerId = `report-worker-${randomUUID()}`, pollMs = 30000, limit = 5, leaseMs = 120000,
  maintenanceLimit = 100, signals = process, onEvent = () => {}, runCycle = runReportWorkerCycle,
  paymentGateway = null,
} = {}) {
  if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 300000) throw new TypeError('invalid_worker_poll');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(workerId || ''))) throw new TypeError('invalid_worker_id');
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new TypeError('invalid_worker_limit');
  if (!Number.isInteger(leaseMs) || leaseMs < 30000 || leaseMs > 900000) throw new TypeError('invalid_worker_lease');
  if (!Number.isInteger(maintenanceLimit) || maintenanceLimit < 1 || maintenanceLimit > 500)
    throw new TypeError('invalid_customer_order_maintenance_limit');
  let stopping = false, wake;
  const stop = () => { stopping = true; wake?.(); };
  signals.on('SIGTERM', stop); signals.on('SIGINT', stop);
  try {
    while (!stopping) {
      try {
        const result = await runCycle(database, {
          workerId,limit,leaseMs,maintenanceLimit,paymentGateway,
        });
        if (result.maintenance?.failed) onEvent('customer_order_maintenance_failed', { retry:true });
        if (result.paymentMaintenance?.failed)
          onEvent('payment_reconciliation_maintenance_failed', { retry:true });
        if (result.paymentMaintenance?.openEscalations)
          onEvent('payment_reconciliation_operator_escalations', {
            count:result.paymentMaintenance.openEscalations,
          });
        onEvent('report_worker_cycle', result);
      }
      catch { onEvent('report_worker_cycle_failed'); }
      if (!stopping) await new Promise(resolve => {
        const timer = setTimeout(resolve, pollMs);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  } finally {
    signals.removeListener('SIGTERM', stop); signals.removeListener('SIGINT', stop);
    await database.close();
  }
}

async function main() {
  try {
    const config = loadConfig(), database = createDatabase({ ...config.database, application_name:'myfin-report-worker' }, {
      onError:event => process.stderr.write(`${event}\n`),
    });
    // REPORT_WORKER_ID is a human-readable replica label. A fresh nonce makes
    // the actual lease owner unique across scale-out, restart and stale overlap.
    const workerId = processWorkerIdentity(process.env.REPORT_WORKER_ID || 'report-worker');
    const pollMs = Number(process.env.REPORT_WORKER_POLL_MS || 30000);
    const maintenanceLimit = Number(process.env.CUSTOMER_ORDER_MAINTENANCE_BATCH_LIMIT || 100);
    const paymentGateway = createPaymentGatewayRuntime(process.env);
    await startReportWorker(database, { workerId,pollMs,maintenanceLimit,paymentGateway,
      onEvent:event => {
        if (['report_worker_cycle_failed','customer_order_maintenance_failed',
          'payment_reconciliation_maintenance_failed',
          'payment_reconciliation_operator_escalations'].includes(event))
          process.stderr.write(`${event}\n`);
      },
    });
  } catch {
    process.stderr.write('Report worker startup failed: check configuration and database availability.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export const reportWorkerInternals = Object.freeze({ dateAdd, safeWorkerError, transactionCounts, leaseGeneration });
