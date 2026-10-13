import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export class MigrationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Migration identity is based on SQL text, independent of the checkout's
// platform line endings. This keeps a release built from a Windows Git archive
// compatible with the same migrations previously applied from Linux, while
// still rejecting every substantive edit through the checksum ledger.
const canonicalMigrationSql = value => value.replace(/\r\n?/g, '\n');

export async function readMigrations(directory = new URL('../../db/migrations/', import.meta.url)) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  if (!names.length || names.some(name => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) ||
      new Set(names.map(name => name.slice(0, 4))).size !== names.length) {
    throw new MigrationError('invalid_migration_names');
  }
  return Promise.all(names.map(async version => {
    const sql = canonicalMigrationSql(await readFile(new URL(version, directory), 'utf8'));
    if (!sql.trim()) throw new MigrationError('empty_migration');
    return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

// One dedicated client and one atomic transaction for this small foundation batch.
// Migration SQL must not contain transaction control or nontransactional operations.
export async function runMigrations(client, migrations) {
  let transaction = false;
  try {
    await client.query('BEGIN');
    transaction = true;
    const lock = await client.query('SELECT pg_try_advisory_xact_lock(1297697102, 1) AS locked');
    if (lock.rows[0]?.locked !== true) throw new MigrationError('migration_locked');
    await client.query(`CREATE TABLE IF NOT EXISTS myfin.schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL CHECK (length(checksum) = 64),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT version, checksum FROM myfin.schema_migrations ORDER BY version');
    // Applied history must be an exact prefix: reject removed, edited, renamed or backfilled files.
    for (let i = 0; i < rows.length; i++) {
      if (!migrations[i] || migrations[i].version !== rows[i].version) throw new MigrationError('migration_history_mismatch');
      if (migrations[i].checksum !== rows[i].checksum) throw new MigrationError('migration_checksum_mismatch');
    }
    const applied = [];
    for (const migration of migrations.slice(rows.length)) {
      await client.query(migration.sql);
      await client.query('INSERT INTO myfin.schema_migrations (version, checksum) VALUES ($1, $2)', [migration.version, migration.checksum]);
      applied.push(migration.version);
    }
    await client.query('COMMIT');
    transaction = false;
    return applied;
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
