import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

test('shutdown drains an in-flight readiness query before closing the database', async t => {
  let finishQuery, startedQuery;
  const started = new Promise(resolve => { startedQuery = resolve; });
  const order = [];
  const app = buildApp({ database:{
    ready:async () => {
      startedQuery();
      await new Promise(resolve => { finishQuery = resolve; });
      order.push('query_done');
      return true;
    },
    close:async () => { order.push('database_closed'); }
  } });
  const address = await app.listen({ host:'127.0.0.1', port:0 });
  t.after(async () => { finishQuery?.(); await app.close(); });
  const response = fetch(`${address}/api/health/ready`);
  await started;
  const closing = app.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, []);
  finishQuery();
  assert.equal((await response).status, 200);
  await closing;
  assert.deepEqual(order, ['query_done', 'database_closed']);
});
