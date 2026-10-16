import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  cleanupExpiredStorefrontPricingSnapshots, customerOrderMaintenanceInternals,
  expireStaleCustomerOrders, maintainCustomerOrders,
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
    if (sql.includes('pg_advisory_xact_lock')) return { rowCount:1,rows:[{}] };
    if (sql.includes('customer_order_online_payment_state')) return { rowCount:0,rows:[] };
    if (sql.includes("SET status='expired'")) return { rowCount:1,rows:[{ id:params[1] }] };
    if (sql.includes('UPDATE myfin.customer_order_reservations')) return { rowCount:1,rows:[] };
    if (sql.includes('UPDATE myfin.customer_order_recipe_reservations')) return { rowCount:1,rows:[] };
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
  const recipeReleases = calls.filter(call => call.sql.includes('UPDATE myfin.customer_order_recipe_reservations'));
  assert.deepEqual(recipeReleases.map(call => call.params), [
    ['company-a','ready-a','expired'],['company-b','accepted-b','expired'],
  ]);
  assert.ok(calls.indexOf(recipeReleases[0]) > calls.indexOf(releases[0]));
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

test('scheduled expiry keeps reservations when a hosted checkout is pending', async () => {
  const calls = [], order = { company_id:'company-a',id:'ready-a',status:'ready',version:4 };
  const client = { async query(sql, params) {
    calls.push({ sql,params });
    if (sql.includes('SELECT o.company_id,o.id,o.status,o.version')) return { rowCount:1,rows:[order] };
    if (sql.includes('pg_advisory_xact_lock')) return { rowCount:1,rows:[{}] };
    if (sql.includes('customer_order_online_payment_state'))
      return { rowCount:1,rows:[{ state:'pending' }] };
    throw new Error(`Unexpected mutation: ${sql}`);
  } };
  assert.deepEqual(await expireStaleCustomerOrders(client, { now:at,limit:10 }),
    { selected:1,expired:0,capped:false });
  assert.equal(calls.some(call => /UPDATE myfin\.customer_order_requests/.test(call.sql)), false);
  assert.equal(calls.some(call => /release_order_promotion_reservations/.test(call.sql)), false);
  assert.deepEqual(calls.filter(call => call.sql.includes('pg_advisory_xact_lock'))[0].params,
    ['online-payment-order:company-a:ready-a']);
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

test('expired storefront quote cleanup is bounded and accepts only a sane database result', async () => {
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql,params });
    return { rowCount:1,rows:[{ selected_count:'10',deleted_count:'8' }] };
  } };
  assert.deepEqual(await cleanupExpiredStorefrontPricingSnapshots(client, { limit:10 }), {
    selected:10,deleted:8,capped:true,
  });
  assert.match(calls[0].sql, /cleanup_expired_unbound_storefront_pricing_snapshots\(\$1\)/);
  assert.deepEqual(calls[0].params, [10]);
  await assert.rejects(cleanupExpiredStorefrontPricingSnapshots({ query:async () => ({
    rows:[{ selected_count:2,deleted_count:3 }],
  }) }), /invalid_pricing_snapshot_cleanup_result/);
  await assert.rejects(cleanupExpiredStorefrontPricingSnapshots({ query:async () => ({
    rows:[],
  }) }), /invalid_pricing_snapshot_cleanup_result/);
  await assert.rejects(cleanupExpiredStorefrontPricingSnapshots({ query:async () => ({
    rows:[{ selected_count:null,deleted_count:null }],
  }) }), /invalid_pricing_snapshot_cleanup_result/);
});

test('maintenance leaves in-retention and active contact data untouched when no tenant is eligible', async () => {
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql,params });
    if (sql.includes('SELECT o.company_id,o.id,o.status,o.version')) return { rowCount:0,rows:[] };
    if (sql.includes('min(o.updated_at) AS oldest')) return { rowCount:0,rows:[] };
    if (sql.includes('cleanup_expired_unbound_storefront_pricing_snapshots'))
      return { rowCount:1,rows:[{ selected_count:0,deleted_count:0 }] };
    throw new Error(`Unexpected mutation: ${sql}`);
  } };
  assert.deepEqual(await maintainCustomerOrders(client, { now:at,limit:10 }), {
    selected:0,expired:0,redacted:0,companies:0,
    storefrontPricingSnapshotsSelected:0,storefrontPricingSnapshotsDeleted:0,hasMore:false,
  });
  assert.equal(calls.some(call => /^\s*(?:UPDATE|INSERT)\b/.test(call.sql)), false);
});

test('database maintenance is one rollback-safe unit and validates its bound before mutation', async () => {
  let transactions = 0;
  const client = { async query(sql) {
    if (sql.includes('SELECT o.company_id,o.id,o.status,o.version')) return { rowCount:0,rows:[] };
    if (sql.includes('min(o.updated_at) AS oldest')) return { rowCount:0,rows:[] };
    if (sql.includes('cleanup_expired_unbound_storefront_pricing_snapshots'))
      return { rowCount:1,rows:[{ selected_count:0,deleted_count:0 }] };
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
    return { selected:1,expired:1,redacted:1,companies:1,
      storefrontPricingSnapshotsSelected:2,storefrontPricingSnapshotsDeleted:2,hasMore:false };
  };
  const first = await runReportWorkerCycle({}, { now:at,maintainOrders,claimRuns:emptyClaim });
  assert.deepEqual(first.maintenance, {
    selected:0,expired:0,redacted:0,companies:0,
    storefrontPricingSnapshotsSelected:0,storefrontPricingSnapshotsDeleted:0,
    hasMore:true,failed:true,retry:true,
  });
  assert.doesNotMatch(JSON.stringify(first), /secret|postgresql/);
  const retry = await runReportWorkerCycle({}, { now:at,maintainOrders,claimRuns:emptyClaim });
  assert.deepEqual(retry.maintenance, {
    selected:1,expired:1,redacted:1,companies:1,
    storefrontPricingSnapshotsSelected:2,storefrontPricingSnapshotsDeleted:2,
    hasMore:false,failed:false,retry:false,
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

test('storefront quote cleanup is referentially guarded, immutable by default and least privilege', async () => {
  const [migration,development,production] = await Promise.all([
    readFile(new URL('../../db/migrations/0037_pos_pricing.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../db/grant-development-runtime.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../db/grant-production-runtime.sql', import.meta.url), 'utf8'),
  ]);
  const start = migration.indexOf(
    'CREATE FUNCTION myfin.cleanup_expired_unbound_storefront_pricing_snapshots',
  );
  assert.ok(start >= 0, 'cleanup function must be present in the pricing migration');
  const cleanup = migration.slice(start);
  assert.match(cleanup, /SECURITY DEFINER SET search_path=pg_catalog,myfin/);
  assert.match(cleanup, /channel='storefront'/);
  assert.doesNotMatch(cleanup, /channel\s+IN\s*\([^)]*'pos'/i,
    'device-only paid receipts make POS snapshot expiry unsafe without a tender-start binder');
  assert.match(cleanup, /expires_at<=statement_timestamp\(\)-interval '24 hours'/);
  assert.match(cleanup, /LIMIT requested_limit[\s\S]*FOR UPDATE OF snapshot SKIP LOCKED/);
  for (const reference of [
    'customer_order_requests', 'transactions', 'promotion_redemptions',
    'promotion_reservations', 'pos_pricing_recovery_exceptions', 'receipt_reviews',
  ]) assert.match(cleanup, new RegExp(`NOT EXISTS\\([\\s\\S]*?myfin\\.${reference}`));
  assert.match(migration,
    /ADD COLUMN pricing_snapshot_id text[\s\S]*?GENERATED ALWAYS AS \(nullif\(payload->>'pricingSnapshotId',''\)\) STORED/);
  assert.match(migration,
    /receipt_reviews_pricing_snapshot_fkey[\s\S]*?FOREIGN KEY\(company_id,pricing_snapshot_id\)[\s\S]*?REFERENCES myfin\.pricing_snapshots\(company_id,id\) ON DELETE RESTRICT/);
  assert.match(migration,
    /receipt_reviews_pricing_snapshot_idx[\s\S]*?WHERE pricing_snapshot_id IS NOT NULL/);
  const deletions = [
    'pricing_snapshot_discount_lines', 'pricing_snapshot_discounts',
    'pricing_snapshot_lines', 'pricing_snapshots',
  ].map(table => cleanup.indexOf(`DELETE FROM myfin.${table}`));
  assert.ok(deletions.every(index => index >= 0));
  assert.deepEqual(deletions, [...deletions].sort((left, right) => left - right),
    'pricing evidence must be removed child-first');
  assert.match(cleanup, /REVOKE ALL ON FUNCTION myfin\.cleanup_expired_unbound_storefront_pricing_snapshots\(integer\) FROM PUBLIC/);
  assert.match(migration, /current_setting\('myfin\.expired_pricing_snapshot_cleanup',true\)='on'/);
  assert.match(migration, /RAISE EXCEPTION 'promotion_history_immutable'/);
  for (const [source,role] of [[development,'myfin_dev_runtime'],[production,'myfin_prod_runtime']]) {
    assert.match(source, new RegExp(
      `cleanup_expired_unbound_storefront_pricing_snapshots\\(integer\\)[\\s\\S]*?TO ${role}`,
    ));
    assert.doesNotMatch(source,
      new RegExp(`GRANT[^;]*DELETE[^;]*pricing_snapshots[^;]*TO ${role}`, 'i'));
  }
});
