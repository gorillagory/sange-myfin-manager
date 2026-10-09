import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimQueuedReportRuns, completeReportRun, failReportRun, processWorkerIdentity,
} from '../src/report-worker.js';

const now = new Date('2026-10-09T02:00:00.000Z');
const later = new Date('2026-10-09T02:02:00.000Z');

test('each process derives a distinct bounded lease owner from the configured replica label', () => {
  const first = processWorkerIdentity('myfin-prod-report-worker-1',
    '11111111-1111-4111-8111-111111111111');
  const second = processWorkerIdentity('myfin-prod-report-worker-1',
    '22222222-2222-4222-8222-222222222222');
  assert.notEqual(first, second);
  assert.match(first, /^myfin-prod-report-worker-1:/);
  assert.ok(first.length <= 128);
  assert.equal(processWorkerIdentity('x'.repeat(91),
    '11111111-1111-4111-8111-111111111111').length, 128);
  assert.throws(() => processWorkerIdentity('x'.repeat(92),
    '11111111-1111-4111-8111-111111111111'), /invalid_worker_id/);
  assert.throws(() => processWorkerIdentity('worker', 'shared'), /invalid_worker_id/);
});

test('claiming a reclaimed run increments and returns the lease generation', async () => {
  const calls = [], client = { async query(sql, params) {
    calls.push({ sql,params });
    return { rowCount:1,rows:[{
      company_id:'company-a',id:'run-a',status:'running',attempt_count:2,
      lease_owner:'worker-new',lease_expires_at:later,
    }] };
  } };
  const rows = await claimQueuedReportRuns(client, {
    workerId:'worker-new',now,limit:1,leaseMs:120000,
  });
  assert.equal(rows[0].attempt_count, 2);
  assert.equal(rows[0].lease_owner, 'worker-new');
  assert.match(calls[0].sql, /attempt_count=r\.attempt_count\+1/);
  assert.match(calls[0].sql, /lease_owner=\$3/);
  assert.match(calls[0].sql, /RETURNING r\.\*/);
});

function fencedDatabase(state) {
  const calls = [];
  return {
    calls,
    async transaction(fn) {
      return fn({ query:async (sql, params) => {
        calls.push({ sql,params });
        const completion = sql.includes("status='completed'");
        const owner = completion ? params[2] : params[5];
        const generation = completion ? params[5] : params[6];
        const instant = completion ? params[3] : params[2];
        const matches = state.status === 'running' && owner === state.leaseOwner &&
          generation === state.generation && state.leaseExpiresAt > instant;
        if (matches) state.status = completion ? 'completed' : 'failed';
        return { rowCount:matches ? 1 : 0,rows:matches ? [{ id:'run-a' }] : [] };
      } });
    },
  };
}

const run = (lease_owner, attempt_count) => ({
  company_id:'company-a',id:'run-a',lease_owner,attempt_count,
});

test('a stale generation cannot complete a lease reclaimed under the same owner label', async () => {
  const state = { status:'running',leaseOwner:'shared-label',generation:2,leaseExpiresAt:later };
  const database = fencedDatabase(state);
  await assert.rejects(
    completeReportRun(database, run('shared-label', 1), { totals:{} }, now),
    error => error.code === 'report_run_lease_lost',
  );
  assert.equal(state.status, 'running');
  await assert.rejects(
    completeReportRun(database, run('stale-process', 2), { totals:{} }, now),
    error => error.code === 'report_run_lease_lost',
  );
  assert.equal(state.status, 'running');
  assert.equal(await completeReportRun(database, run('shared-label', 2), { totals:{} }, now), true);
  assert.equal(state.status, 'completed');
  assert.ok(database.calls.every(call => /lease_owner=\$3/.test(call.sql)));
  assert.ok(database.calls.every(call => /attempt_count=\$6/.test(call.sql)));
});

test('failure is fenced by owner, generation and an unexpired lease', async () => {
  const state = { status:'running',leaseOwner:'worker-new',generation:3,leaseExpiresAt:later };
  const database = fencedDatabase(state);
  assert.equal(await failReportRun(database, run('worker-new', 2), Error('generation'), now), false);
  assert.equal(await failReportRun(database, run('worker-old', 3), Error('owner'), now), false);
  const expiredAt = new Date('2026-10-09T02:03:00.000Z');
  state.leaseExpiresAt = new Date('2026-10-09T02:02:30.000Z');
  assert.equal(await failReportRun(database, run('worker-new', 3), Error('late'), expiredAt), false);
  state.leaseExpiresAt = new Date('2026-10-09T02:04:00.000Z');
  assert.equal(await failReportRun(database, run('worker-new', 3), Error('retry'), expiredAt), true);
  assert.equal(state.status, 'failed');
  assert.ok(database.calls.every(call => /attempt_count=\$7/.test(call.sql)));
  assert.ok(database.calls.every(call => /lease_expires_at>\$3/.test(call.sql)));
});
