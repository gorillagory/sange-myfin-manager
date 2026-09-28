import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readMigrations, runMigrations } from '../src/migrations.js';

const migration = { version:'0001_one.sql', sql:'CREATE TABLE example (id text)', checksum:'a'.repeat(64) };
function fake({ rows = [], locked = true, failSql = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === failSql) throw Error('SQL failure with secret');
      if (sql.includes('pg_try_advisory')) return { rows:[{ locked }] };
      if (sql.startsWith('SELECT version')) return { rows };
      return { rows:[] };
    }
  };
}
test('first run locks before ledger, executes SQL and parameterized history in one transaction', async () => {
  const client = fake();
  assert.deepEqual(await runMigrations(client, [migration]), [migration.version]);
  assert.equal(client.calls[0].sql, 'BEGIN');
  assert.match(client.calls[1].sql, /pg_try_advisory_xact_lock/);
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
  const insert = client.calls.find(call => call.sql.startsWith('INSERT'));
  assert.deepEqual(insert.params, [migration.version, migration.checksum]);
  assert.ok(client.calls.findIndex(call => call.sql === migration.sql) < client.calls.indexOf(insert));
});
test('repeat run is a no-op, with no SQL or ledger inserts', async () => {
  const client = fake({ rows:[migration] });
  assert.deepEqual(await runMigrations(client, [migration]), []);
  assert.equal(client.calls.some(call => call.sql === migration.sql || call.sql.startsWith('INSERT')), false);
});
test('changed, removed, renamed, and backfilled applied history fail closed', async () => {
  for (const [rows, migrations, code] of [
    [[{ ...migration, checksum:'b'.repeat(64) }], [migration], 'migration_checksum_mismatch'],
    [[migration], [], 'migration_history_mismatch'],
    [[{ ...migration, version:'0001_renamed.sql' }], [migration], 'migration_history_mismatch'],
    [[{ ...migration, version:'0002_two.sql' }], [migration, { ...migration, version:'0002_two.sql' }], 'migration_history_mismatch']
  ]) {
    const client = fake({ rows });
    await assert.rejects(runMigrations(client, migrations), { code });
    assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(client.calls.some(call => call.sql === migration.sql), false);
  }
});
test('concurrent lock loser rolls back without modifying history', async () => {
  const client = fake({ locked:false });
  await assert.rejects(runMigrations(client, [migration]), { code:'migration_locked' });
  assert.equal(client.calls.length, 3);
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
});
test('SQL, history-insert and commit failures roll back; rollback failure keeps original error', async () => {
  for (const failSql of [migration.sql, 'INSERT INTO myfin.schema_migrations (version, checksum) VALUES ($1, $2)', 'COMMIT']) {
    const client = fake({ failSql });
    await assert.rejects(runMigrations(client, [migration]), /SQL failure/);
    assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
  }
  const client = { query:async sql => {
    if (sql === 'BEGIN') return {};
    throw Error(sql === 'ROLLBACK' ? 'secondary' : 'original');
  } };
  await assert.rejects(runMigrations(client, [migration]), /original/);
});
test('migration files have deterministic byte-sensitive checksums and reject ambiguous versions', async t => {
  const dir = await mkdtemp(`${tmpdir()}/myfin-migrations-`);
  t.after(() => rm(dir, { recursive:true, force:true }));
  const url = pathToFileURL(`${dir}/`);
  await writeFile(new URL('0001_one.sql', url), 'SELECT 1;\n');
  const first = await readMigrations(url);
  assert.equal(first[0].checksum.length, 64);
  await writeFile(new URL('0001_one.sql', url), 'SELECT 1;\r\n');
  assert.notEqual((await readMigrations(url))[0].checksum, first[0].checksum);
  await writeFile(new URL('0001_other.sql', url), 'SELECT 2;');
  await assert.rejects(readMigrations(url), { code:'invalid_migration_names' });
});
test('repository migration is discoverable without any database connection', async () => {
  const migrations = await readMigrations();
  assert.equal(migrations[0].version, '0001_foundation.sql');
  assert.match(migrations[0].sql, /PRIMARY KEY \(company_id, identity_id\)/);
});
