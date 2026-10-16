import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/database.js';
import { REQUIRED_RUNTIME_MIGRATION, runtimePrivilegeCheck } from '../src/runtime-privileges.js';
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
  app.get('/test-gateway-unavailable', async () => {
    const error = Error('online_payment_unavailable'); error.statusCode = 503; throw error;
  });
  assert.deepEqual((await app.inject('/api/health/ready')).json(), { status:'ready' });
  assert.equal((await app.inject('/api/companies')).statusCode, 404);
  const error = await app.inject('/test-error');
  assert.equal(error.statusCode, 500);
  assert.deepEqual(error.json(), { error:'internal_error' });
  const gateway = await app.inject('/test-gateway-unavailable');
  assert.equal(gateway.statusCode, 503);
  assert.deepEqual(gateway.json(), { error:'online_payment_unavailable' });
  await app.close();
  await app.close();
  assert.equal(closes, 1);
});
test('500 responses expose a request id and log only safe diagnostic metadata', async t => {
  const logs = [];
  const app = buildApp({ logger:{ level:'error', base:null, timestamp:false,
    stream:{ write:line => logs.push(JSON.parse(line)) } } });
  t.after(() => app.close());
  class DatabaseError extends Error {}
  app.post('/test-errors/:recordId', async request => {
    const error = new DatabaseError(`private detail ${request.body.password}`);
    error.code = request.params.recordId === 'valid' ? '42P01' : 'unsafe-secret-code';
    error.detail = request.body;
    throw error;
  });
  const valid = await app.inject({ method:'POST', url:'/test-errors/valid?token=query-secret',
    payload:{ password:'payload-secret' } });
  assert.equal(valid.statusCode, 500);
  assert.deepEqual(valid.json(), { error:'internal_error' });
  assert.equal(valid.headers['x-request-id'], logs[0].reqId);
  assert.deepEqual(logs[0], { level:50, reqId:logs[0].reqId, method:'POST',
    route:'/test-errors/:recordId', errorClass:'DatabaseError', sqlstate:'42P01' });
  const invalid = await app.inject({ method:'POST', url:'/test-errors/invalid',
    payload:{ password:'another-payload-secret' } });
  assert.equal(invalid.statusCode, 500);
  assert.deepEqual(invalid.json(), { error:'internal_error' });
  assert.equal(invalid.headers['x-request-id'], logs[1].reqId);
  assert.deepEqual(logs[1], { level:50, reqId:logs[1].reqId, method:'POST',
    route:'/test-errors/:recordId', errorClass:'DatabaseError', sqlstate:null });
  assert.doesNotMatch(JSON.stringify(logs), /private detail|payload-secret|query-secret|unsafe-secret-code|password/);
});
test('the complete authenticated route graph registers without duplicate endpoints', async t => {
  const database={ready:async()=>true,close:async()=>{},transaction:async fn=>fn({query:async()=>({rows:[],rowCount:0})})};
  const auth={handler:async()=>new Response(null,{status:401})};
  const authOptions={origin:'https://dev-pos.example.test',protocol:'https:',allowedHosts:['dev-pos.example.test'],
    controlHosts:[],rootDomain:'',publicProxyAddresses:[],enforceTenantHosts:false,secure:true,pos:null,voucherHmacSecret:null};
  const app=buildApp({database,auth,authOptions});
  t.after(()=>app.close());
  await app.ready();
  assert.equal(app.hasRoute({method:'GET',url:'/api/companies/:company/inventory-recipes'}),true);
});
test('pool options are passed through, idle errors are sanitized, close is idempotent', async () => {
  let pool, closes = 0;
  const events = [];
  class FakePool extends EventEmitter {
    constructor(options) { super(); this.options = options; pool = this; }
    async query(sql, parameters) {
      const runtimeAcl = runtimePrivilegeCheck(2);
      assert.match(sql, /version = \$1/);
      assert.match(sql, /has_schema_privilege\(current_user, \$2, \$3\)/);
      assert.match(sql, /has_table_privilege\(current_user, \$\d+, \$\d+\)/);
      assert.match(sql, /has_sequence_privilege\(current_user, \$\d+, \$\d+\)/);
      assert.match(sql, /has_function_privilege\(current_user, \$\d+, \$\d+\)/);
      assert.deepEqual(parameters, [REQUIRED_RUNTIME_MIGRATION, ...runtimeAcl.parameters]);
      return { rows:[{ ready:true }] };
    }
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
test('database readiness fails closed when migrations or any runtime ACL check fails', async () => {
  for (const ready of [false, null, undefined, 'throw']) {
    class FakePool extends EventEmitter {
      on() {}
      async query() {
        if (ready === 'throw') throw Error('sensitive_database_detail');
        return { rows:ready === undefined ? [] : [{ ready }] };
      }
      async end() {}
    }
    const db = createDatabase({}, { Pool:FakePool });
    assert.equal(await db.ready(), false);
    await db.close();
  }
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
