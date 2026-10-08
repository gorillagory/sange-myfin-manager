import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  nextScheduledAt, registerReportAutomation, reportRetryDelayMs, reportRunKey, reportWindowForRun,
} from '../src/report-automation.js';
import {
  buildScheduledReportSnapshot, enqueueDueReportRuns, reapExpiredReportRuns, weekdaySeasonalForecast,
} from '../src/report-worker.js';

function iso(value) { return value.toISOString(); }

test('Malaysia schedules advance strictly after the reference instant and use completed report windows', () => {
  assert.equal(iso(nextScheduledAt({ cadence:'daily',localTime:'08:00' }, '2026-10-09T00:30:00.000Z')),
    '2026-10-10T00:00:00.000Z');
  assert.equal(iso(nextScheduledAt({ cadence:'weekly',weekday:1,localTime:'09:00' }, '2026-10-09T00:30:00.000Z')),
    '2026-10-12T01:00:00.000Z');
  assert.equal(iso(nextScheduledAt({ cadence:'monthly',monthDay:1,localTime:'08:00' }, '2026-10-09T00:30:00.000Z')),
    '2026-11-01T00:00:00.000Z');
  assert.deepEqual(reportWindowForRun('2026-10-09T00:00:00.000Z', 'daily'),
    { from:'2026-10-08',to:'2026-10-08' });
  assert.deepEqual(reportWindowForRun('2026-10-12T01:00:00.000Z', 'weekly'),
    { from:'2026-10-05',to:'2026-10-11' });
  assert.deepEqual(reportWindowForRun('2026-10-15T00:00:00.000Z', 'monthly'),
    { from:'2026-09-01',to:'2026-09-30' });
});

test('run keys are stable per due instant and retry delay is bounded exponential backoff', () => {
  const first = reportRunKey('company','schedule','2026-10-09T00:00:00.000Z');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, reportRunKey('company','schedule','2026-10-09T00:00:00.000Z'));
  assert.notEqual(first, reportRunKey('company','schedule','2026-10-10T00:00:00.000Z'));
  assert.deepEqual([1,2,3,4,9].map(reportRetryDelayMs), [60000,300000,1500000,7500000,21600000]);
});

test('due schedules enqueue one immutable-definition run and advance under the schedule lock', async () => {
  const calls = [], schedule = {
    company_id:'company-a',id:'schedule-a',name:'Daily report',cadence:'daily',timezone:'Asia/Kuala_Lumpur',
    local_time:'08:00:00',weekday:null,month_day:null,dimensions:['channel'],filters:{ channel:'pos' },
    history_days:84,forecast_horizon:14,version:2,next_run_at:'2026-10-09T00:00:00.000Z',
  };
  const client = { async query(sql, params) {
    calls.push({ sql,params });
    if (sql.includes('SELECT s.* FROM myfin.report_schedules')) return { rows:[schedule],rowCount:1 };
    if (sql.includes('INSERT INTO myfin.report_runs')) return { rows:[],rowCount:1 };
    if (sql.includes('UPDATE myfin.report_schedules')) return { rows:[],rowCount:1 };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  assert.deepEqual(await enqueueDueReportRuns(client, {
    now:new Date('2026-10-09T00:01:00.000Z'),limit:5,
  }), { due:1,enqueued:1 });
  const inserted = calls.find(call => call.sql.includes('INSERT INTO myfin.report_runs'));
  assert.equal(inserted.params[5], '2026-10-08');
  assert.equal(inserted.params[6], '2026-10-08');
  assert.equal(inserted.params[7].scheduleVersion, 2);
  assert.equal(inserted.params[7].deliveryChannel, 'in_app');
  assert.match(inserted.params[3], /^[0-9a-f]{64}$/);
  const advanced = calls.find(call => call.sql.includes('UPDATE myfin.report_schedules'));
  assert.equal(advanced.params[2].toISOString(), '2026-10-10T00:00:00.000Z');
});

test('lease reaper cancels disabled work and terminates an exhausted crashed attempt', async () => {
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql,params });
    return { rowCount:sql.includes('FROM myfin.report_schedules s') ? 2 : 1,rows:[] };
  } };
  assert.deepEqual(await reapExpiredReportRuns(client, { now:'2026-10-09T01:00:00.000Z' }),
    { cancelled:2,exhausted:1 });
  assert.match(calls[0].sql, /NOT s\.enabled/);
  assert.match(calls[1].sql, /attempt_count >= max_attempts/);
  assert.equal(calls[1].params[0].toISOString(), '2026-10-09T01:00:00.000Z');
});

function dailySeries(length, start = '2026-07-01') {
  const origin = Date.parse(`${start}T00:00:00.000Z`);
  return Array.from({ length }, (_, index) => {
    const date = new Date(origin + index * 86400000).toISOString().slice(0, 10);
    return { date, sales:(new Date(`${date}T00:00:00Z`).getUTCDay() + 1) * 10 };
  });
}

test('weekday forecast is advisory, walk-forward measured and transparent about uncertainty', () => {
  const history = dailySeries(84), forecast = weekdaySeasonalForecast(history, {
    metric:'sales', asOf:'2026-09-23T00:00:00.000Z', horizon:7,
  });
  assert.equal(forecast.status, 'ready');
  assert.equal(forecast.sampleSize, 84);
  assert.equal(forecast.points.length, 7);
  assert.equal(forecast.metrics.mae, 0);
  assert.equal(forecast.metrics.wape, 0);
  assert.equal(forecast.confidence.level, 'high');
  assert.equal(forecast.uncertainty.method, 'historical_absolute_error_p80');
  assert.equal(forecast.actions.automaticOrdering, false);
  assert.ok(forecast.points.every(point => point.value === point.lower && point.lower === point.upper));
});

test('forecast reports insufficient history instead of manufacturing predictions', () => {
  const forecast = weekdaySeasonalForecast(dailySeries(27), {
    metric:'sales', asOf:'2026-07-28T00:00:00.000Z', horizon:7,
  });
  assert.equal(forecast.status, 'insufficient_history');
  assert.equal(forecast.reason, 'minimum_28_contiguous_days_required');
  assert.deepEqual(forecast.points, []);
  assert.equal(forecast.metrics, null);
  assert.equal(forecast.actions.automaticOrdering, false);
});

test('snapshot generation uses existing companyRows/companyReport-compatible contracts and stores aggregates only', async () => {
  const history = dailySeries(28, '2026-09-11'), calls = [];
  const run = {
    company_id:'company-a', id:'run-a', scheduled_for:'2026-10-09T00:00:00.000Z',
    period_from:'2026-10-08', period_to:'2026-10-08',
    definition_snapshot:{ name:'Daily',cadence:'daily',timezone:'Asia/Kuala_Lumpur',localTime:'08:00',
      dimensions:['channel'],filters:{ channel:'pos' },historyDays:28,forecastHorizon:7,scheduleVersion:1 },
  };
  const compileReport = (_rows, from, to, filters) => {
    calls.push({ from,to,filters });
    const daily = from === '2026-09-11' ? history : [{ date:'2026-10-08',sales:70,tax:4.2,expenses:5,cashIn:70,cashOut:5,cashFlow:65 }];
    return { totals:{ sales:70,tax:4.2,expenses:5,cashIn:70,cashOut:5,cashFlow:65,quoted:0,convertedQuoted:0 },
      daily, sales:daily.flatMap(day => day.sales ? [{ id:`sale-${day.date}`,date:day.date }] : []),
      expenses:[],receipts:[],quotes:[],basis:'Approved accounting basis',filters,
      filterScope:'POS only',breakdowns:{ channel:[{ value:'pos',sales:70 }],paymentMethod:[],category:[],subcategory:[] } };
  };
  const result = await buildScheduledReportSnapshot({}, run, {
    loadCompany:async () => ({ name:'Bayam',currency:'RM' }),
    loadRows:async (_c, companies, from, to) => { assert.deepEqual(companies,['company-a']); return { from,to }; },
    compileReport, clock:() => new Date('2026-10-09T00:01:00.000Z'),
  });
  assert.deepEqual(calls.map(call => [call.from,call.to]), [
    ['2026-10-08','2026-10-08'],['2026-09-11','2026-10-08'],
  ]);
  assert.deepEqual(Object.keys(result.breakdowns), ['channel']);
  assert.equal(result.delivery.channel, 'in_app');
  assert.equal(result.delivery.outbound, false);
  assert.equal(result.forecast.actions.automaticOrdering, false);
  assert.equal(result.forecast.sales.status, 'ready');
  assert.doesNotMatch(JSON.stringify(result), /customerEmail|guestPhone|lineItems/);
});

function routeHarness(role = 'workspace_owner') {
  const routes = new Map(), calls = [];
  const now = new Date('2026-10-09T00:30:00.000Z');
  const client = { async query(sql, params) {
    calls.push({ sql,params });
    if (sql.includes('INSERT INTO myfin.report_schedules')) return { rowCount:1,rows:[{
      company_id:'company-a',id:'schedule-a',name:params[2],report_type:'financial_summary',cadence:params[3],
      timezone:params[4],local_time:params[5],weekday:params[6],month_day:params[7],dimensions:JSON.parse(params[8]),filters:JSON.parse(params[9]),
      history_days:params[10],forecast_horizon:params[11],delivery_channel:'in_app',enabled:params[12],version:1,
      next_run_at:params[13],created_at:now,updated_at:now,
    }] };
    if (sql.includes('FROM myfin.report_schedules')) return { rowCount:0,rows:[] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const app = {
    get(path, handler) { routes.set(`GET ${path}`,handler); },
    post(path, handler) { routes.set(`POST ${path}`,handler); },
    put(path, handler) { routes.set(`PUT ${path}`,handler); },
  };
  registerReportAutomation(app, { scoped:(req, fn) => fn(client,'company-a'),clock:() => now });
  const request = body => ({ params:{ company:'company-a' },query:{},body,identity:{ id:'actor-a',role } });
  return { routes,calls,request };
}

test('report schedule API requires current financial-report capability and creates in-app-only definitions', async () => {
  const operator = routeHarness('operator');
  await assert.rejects(operator.routes.get('GET /api/companies/:company/report-schedules')(operator.request()),
    error => error.statusCode === 403 && error.message === 'access_denied');
  assert.equal(operator.calls.length, 0);
  const manager = routeHarness('manager');
  assert.deepEqual(await manager.routes.get('GET /api/companies/:company/report-schedules')(manager.request()),
    { schedules:[],deliveryPolicy:{ channels:['in_app'],outbound:false } });
  await assert.rejects(manager.routes.get('POST /api/companies/:company/report-schedules')(manager.request({
    name:'Daily report',cadence:'daily',localTime:'08:00',weekday:null,monthDay:null,
    dimensions:['channel'],filters:{},historyDays:84,forecastHorizon:14,enabled:true,
  })), error => error.statusCode === 403 && error.message === 'owner_required');
  const owner = routeHarness();
  const created = await owner.routes.get('POST /api/companies/:company/report-schedules')(owner.request({
    name:'Daily report',cadence:'daily',localTime:'08:00',weekday:null,monthDay:null,
    dimensions:['channel','paymentMethod'],filters:{ channel:'pos' },historyDays:84,forecastHorizon:14,enabled:true,
  }));
  assert.equal(created.deliveryChannel, 'in_app');
  assert.equal(created.nextRunAt.toISOString(), '2026-10-10T00:00:00.000Z');
  const insert = owner.calls.find(call => call.sql.includes('INSERT INTO myfin.report_schedules'));
  assert.equal(insert.params[8], '["channel","paymentMethod"]');
  assert.equal(insert.params[9], '{"channel":"pos"}');
  assert.equal(owner.calls.some(call => JSON.stringify(call.params).includes('email')), false);
});

test('migration has tenant keys, SKIP-LOCKED-compatible queues, exact run keys and immutable completed snapshots', async () => {
  const migration = await readFile(new URL('../../db/migrations/0024_reporting_automation.sql', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../src/report-worker.js', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE myfin\.report_schedules/);
  assert.match(migration, /CREATE TABLE myfin\.report_runs/);
  assert.match(migration, /UNIQUE\(company_id,run_key\)/);
  assert.match(migration, /delivery_channel='in_app'/);
  assert.match(migration, /immutable_completed_report_run/);
  assert.match(worker, /FOR UPDATE OF r SKIP LOCKED/);
  assert.match(worker, /attempt_count=r\.attempt_count\+1/);
  assert.match(worker, /automaticOrdering:false/);
  const schemaWithoutComments = migration.replace(/^--.*$/gm, '');
  assert.doesNotMatch(schemaWithoutComments, /\b(?:email|smtp)\b/i);
});
