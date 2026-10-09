import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  customerOrderMaintenanceInternals, expireStaleCustomerOrders, maintainCustomerOrders,
  redactRetainedCustomerOrderContacts, runCustomerOrderMaintenance,
} from '../src/customer-order-maintenance.js';
import { runReportWorkerCycle, startReportWorker } from '../src/report-worker.js';

const at = new Date('2026-10-09T02:00:00.000Z');

test('scheduled expiry is bounded, concurrent-safe and tenant-keyed for every active state including ready', async () => {
  const calls = [], orders = [
    { company_id:'company-a',id:'ready-a',status:'ready',version:4 },
    { company_id:'company-b',id:'accepted-b',status:'accepted',version:2 },
  ];
  const client = { async query(sql, params) {
    calls.push({ sql,params });
    if (sql.includes('SELECT o.company_id,o.id,o.status,o.version')) return { rowCount:2,rows:orders };
    if (sql.includes("SET status='expired'")) return { rowCount:1,rows:[{ id:params[1] }] };
    if (sql.includes('UPDATE myfin.customer_order_reservations')) return { rowCount:1,rows:[] };
    if (sql.includes('release_order_promotion_reservations')) return { rowCount:1,rows:[{ count:1 }] };
    if (sql.includes('INSERT INTO myfin.customer_order_events')) return { rowCount:1,rows:[] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };

  assert.deepEqual(await expireStaleCustomerOrders(client, { now:at,limit:2 }),
    { selected:2,expired:2,capped:true });
  const selected = calls[0];
  assert.deepEqual(selected.params, [
    ['awaiting_acceptance','accepted','preparing','ready'],at,2,
  ]);
  assert.match(selected.sql, /expires_at<=\$2/);
  assert.match(selected.sql, /LIMIT \$3\s+FOR UPDATE OF o SKIP LOCKED/);
  const updates = calls.filter(call => call.sql.includes("SET status='expired'"));
  assert.deepEqual(updates.map(call => call.params.slice(0, 3)), [
    ['company-a','ready-a','ready'],['company-b','accepted-b','accepted'],
  ]);
  assert.ok(updates.every(call => /company_id=\$1 AND id=\$2/.test(call.sql)));
  const releases = calls.filter(call => call.sql.includes('UPDATE myfin.customer_order_reservations'));
  assert.deepEqual(releases.map(call => call.params), [
    ['company-a','ready-a','expired'],['company-b','accepted-b','expired'],
  ]);
  const promotionReleases = calls.filter(call => call.sql.includes('release_order_promotion_reservations'));
  assert.deepEqual(promotionReleases.map(call => call.params), [
    ['company-a','ready-a','expired'],['company-b','accepted-b','expired'],
  ]);
  assert.ok(calls.indexOf(promotionReleases[0]) > calls.indexOf(releases[0]));
  const events = calls.filter(call => call.sql.includes('INSERT INTO myfin.customer_order_events'));
  assert.deepEqual(events.map(call => [call.params[0],call.params[2],call.params[6]]), [
    ['company-a','ready-a','ready'],['company-b','accepted-b','accepted'],
  ]);
  assert.ok(events.every(call => call.params[4].length <= 128 && call.params[5].length === 64));
  assert.equal(customerOrderMaintenanceInternals.expiryRequestId(orders[0]),
    customerOrderMaintenanceInternals.expiryRequestId(orders[0]));
});

test('tenant-wide redaction reuses the retention mutation and never exceeds the row budget', async () => {
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql,params });
    if (sql.includes('min(o.updated_at) AS oldest')) return { rowCount:3,rows:[
      { company_id:'company-a' },{ company_id:'company-b' },{ company_id:'company-c' },
    ] };
    if (sql.includes('WITH candidates AS')) return { rowCount:1,rows:[{ id:`redacted-${params[0]}` }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };

  assert.deepEqual(await redactRetainedCustomerOrderContacts(client, { limit:2 }),
    { companies:2,redacted:2,capped:true });
  const discovery = calls[0];
  assert.deepEqual(discovery.params, [['cancelled','expired','paid'],3]);
  assert.match(discovery.sql, /JOIN myfin\.storefront_settings s ON s\.company_id=o\.company_id/);
  assert.match(discovery.sql, /updated_at<now\(\)-make_interval\(days=>s\.guest_data_retention_days\)/);
  assert.doesNotMatch(discovery.sql, /published/);
  const mutations = calls.filter(call => call.sql.includes('WITH candidates AS'));
  assert.deepEqual(mutations.map(call => call.params), [['company-a',2],['company-b',1]]);
  assert.ok(mutations.every(call => /o\.company_id=\$1/.test(call.sql)));
  assert.ok(mutations.every(call => /status IN \('cancelled','expired','paid'\)/.test(call.sql)));
  assert.ok(mutations.every(call => !/status IN \([^)]*ready/.test(call.sql)));
  assert.ok(mutations.every(call => /delivery_address_snapshot=.*'\{\}'::jsonb/s.test(call.sql)));
});

test('maintenance leaves in-retention and active contact data untouched when no tenant is eligible', async () => {
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql,params });
    if (sql.includes('SELECT o.company_id,o.id,o.status,o.version')) return { rowCount:0,rows:[] };
    if (sql.includes('min(o.updated_at) AS oldest')) return { rowCount:0,rows:[] };
    throw new Error(`Unexpected mutation: ${sql}`);
  } };
  assert.deepEqual(await maintainCustomerOrders(client, { now:at,limit:10 }), {
    selected:0,expired:0,redacted:0,companies:0,hasMore:false,
  });
  assert.equal(calls.some(call => /^\s*(?:UPDATE|INSERT)\b/.test(call.sql)), false);
});

test('database maintenance is one rollback-safe unit and validates its bound before mutation', async () => {
  let transactions = 0;
  const client = { async query(sql) {
    if (sql.includes('SELECT o.company_id,o.id,o.status,o.version')) return { rowCount:0,rows:[] };
    if (sql.includes('min(o.updated_at) AS oldest')) return { rowCount:0,rows:[] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const database = { async transaction(fn) { transactions++; return fn(client); } };
  assert.equal((await runCustomerOrderMaintenance(database, { now:at,limit:25 })).hasMore, false);
  assert.equal(transactions, 1);
  await assert.rejects(runCustomerOrderMaintenance(database, { now:at,limit:0 }),
    /invalid_customer_order_maintenance_limit/);
});

const emptyClaim = async () => ({ cancelled:0,exhausted:0,due:0,enqueued:0,runs:[] });

test('report cycles expose a safe maintenance failure and retry it on the next poll', async () => {
  let attempts = 0;
  const maintainOrders = async () => {
    attempts++;
    if (attempts === 1) throw new Error('postgresql://secret@host/private');
    return { selected:1,expired:1,redacted:1,companies:1,hasMore:false };
  };
  const first = await runReportWorkerCycle({}, { now:at,maintainOrders,claimRuns:emptyClaim });
  assert.deepEqual(first.maintenance, {
    selected:0,expired:0,redacted:0,companies:0,hasMore:true,failed:true,retry:true,
  });
  assert.doesNotMatch(JSON.stringify(first), /secret|postgresql/);
  const retry = await runReportWorkerCycle({}, { now:at,maintainOrders,claimRuns:emptyClaim });
  assert.deepEqual(retry.maintenance, {
    selected:1,expired:1,redacted:1,companies:1,hasMore:false,failed:false,retry:false,
  });
  assert.equal(attempts, 2);
});

test('worker emits an observable redacted maintenance failure and still closes cleanly', async () => {
  const signals = new EventEmitter(), events = [];
  let closed = 0;
  const database = { async close() { closed++; } };
  await startReportWorker(database, {
    workerId:'worker-a',pollMs:1000,signals,
    runCycle:async () => ({ maintenance:{ failed:true,retry:true } }),
    onEvent:(event, detail) => {
      events.push({ event,detail });
      if (event === 'report_worker_cycle') signals.emit('SIGTERM');
    },
  });
  assert.deepEqual(events.map(item => item.event), [
    'customer_order_maintenance_failed','report_worker_cycle',
  ]);
  assert.deepEqual(events[0].detail, { retry:true });
  assert.equal(closed, 1);
});
