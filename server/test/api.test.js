import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/database.js';
import { installShutdown } from '../src/shutdown.js';

const env = { PGPASSWORD: 'synthetic-secret' };
test('config has bounded development defaults and strict numeric validation', () => {
  const c = loadConfig(env);
  assert.equal(c.database.max, 5);
  assert.equal(c.database.database, 'myfin_dev');
  assert.equal(c.database.user, 'myfin_dev_runtime');
  assert.equal(c.database.connectionTimeoutMillis, 2000);
  assert.equal(c.database.statement_timeout, 3000);
  assert.equal(c.database.query_timeout, 4000);
  for (const [key, value] of Object.entries({ PORT:'0', PGPOOL_MAX:'21', PGPORT:'5432x', PG_CONNECT_TIMEOUT_MS:'0', PG_IDLE_TIMEOUT_MS:'NaN', PG_STATEMENT_TIMEOUT_MS:'-1', PG_QUERY_TIMEOUT_MS:'3000', HOST:'bad', PGHOST:'host/path', PGDATABASE:'other-db', NODE_ENV:'unknown', PG_TLS:'prefer', SHUTDOWN_TIMEOUT_MS:'0', DATABASE_URL:'postgres://secret' })) {
    assert.throws(() => loadConfig({ ...env, [key]: value }), { name:'ConfigurationError' });
  }
});
test('missing, conflicting or unreadable secrets fail without reflecting input', () => {
  for (const input of [{}, { ...env, PGPASSWORD_FILE:'/secret/file' }, { PGPASSWORD_FILE:'/secret/file' }, { PGPASSWORD:'secret\nvalue' }]) {
    assert.throws(() => loadConfig(input, () => { throw Error('credential/path leak'); }), error => !/synthetic-secret|credential\/path|secret\/file/.test(error.message));
  }
  assert.equal(loadConfig({ PGPASSWORD_FILE:'/fake' }, () => 'value\n').database.password, 'value');
  assert.equal(loadConfig({ ...env, PG_TLS:'verify-full' }).database.ssl.rejectUnauthorized, true);
  assert.throws(() => loadConfig({ ...env, PG_TLS:'verify-full', PG_CA_FILE:'/fake' }, () => 'bad'));
});
test('liveness works independently; missing configuration and DB failures are 503', async t => {
  for (const database of [null, { ready:async () => false, close:async () => {} }, { ready:async () => { throw Error('postgres://user:password@internal/db'); }, close:async () => {} }]) {
    const app = buildApp({ database });
    t.after(() => app.close());
    assert.deepEqual((await app.inject('/api/health/live')).json(), { status:'ok' });
    const response = await app.inject('/api/health/ready');
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.doesNotMatch(response.body, /password|internal|postgres/);
    assert.equal(response.json().reason, database ? 'database_unavailable' : 'configuration_unavailable');
  }
});
test('ready response, unknown business routes, and handler errors are minimal', async t => {
  let closes = 0;
  const app = buildApp({ database:{ ready:async () => true, close:async () => { closes++; } } });
  t.after(() => app.close());
  app.get('/test-error', async () => { throw Error('secret internal detail'); });
  assert.deepEqual((await app.inject('/api/health/ready')).json(), { status:'ready' });
  assert.equal((await app.inject('/api/companies')).statusCode, 404);
  const error = await app.inject('/test-error');
  assert.equal(error.statusCode, 500);
  assert.deepEqual(error.json(), { error:'internal_error' });
  await app.close();
  await app.close();
  assert.equal(closes, 1);
});
test('pool options are passed through, idle errors are sanitized, close is idempotent', async () => {
  let pool, closes = 0;
  const events = [];
  class FakePool extends EventEmitter {
    constructor(options) { super(); this.options = options; pool = this; }
    async query(sql) { assert.match(sql, /myfin.schema_migrations/); return { rows:[{ ready:true }] }; }
    async end() { closes++; }
  }
  const config = loadConfig(env).database;
  const db = createDatabase(config, { Pool:FakePool, onError:event => events.push(event) });
  assert.equal(pool.options, config);
  assert.equal(await db.ready(), true);
  pool.emit('error', Error('credentials'));
  assert.deepEqual(events, ['database_pool_error']);
  await Promise.all([db.close(), db.close()]);
  assert.equal(closes, 1);
});
test('signals drain once and remove listeners; failed/overdue shutdown exits nonzero', async () => {
  const signals = new EventEmitter();
  let closes = 0, callback, cleared = 0;
  const exits = [];
  const options = { signals, exit:code => exits.push(code), setTimer:fn => { callback = fn; return {}; }, clearTimer:() => { cleared++; } };
  const shutdown = installShutdown({ close:async () => { closes++; } }, options);
  signals.emit('SIGTERM'); signals.emit('SIGINT');
  await shutdown.stop();
  assert.equal(closes, 1); assert.equal(cleared, 1);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.deepEqual(exits, []);
  const failed = installShutdown({ close:async () => { throw Error('secret'); } }, options);
  await failed.stop();
  assert.deepEqual(exits, [1]);
  const hung = installShutdown({ close:() => new Promise(() => {}) }, options);
  hung.stop(); callback(); hung.remove();
  assert.deepEqual(exits, [1, 1]);
});
test('real startup rejects missing configuration with a redacted nonzero exit', () => {
  const result = spawnSync(process.execPath, ['src/index.js'], { cwd:new URL('../', import.meta.url), env:{ PATH:process.env.PATH }, encoding:'utf8', timeout:3000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /API startup failed/);
  assert.doesNotMatch(result.stderr, /Error:|node_modules|postgres:\/\//);
});
