import pg from 'pg';
import { loadConfig } from './config.js';
import { readMigrations, runMigrations, MigrationError } from './migrations.js';

let client;
try {
  const owner = process.env.MIGRATION_OWNER;
  if (!owner || !/^[a-z_][a-z0-9_]{0,62}$/.test(owner) ||
      !process.env.PGUSER || process.env.PGUSER.endsWith('_runtime')) {
    throw new MigrationError('migration_credentials_required');
  }
  const config = loadConfig();
  const migrations = await readMigrations();
  client = new pg.Client({ ...config.database, application_name: 'myfin-migrations' });
  // Prevent unhandled connection-loss events; query promises report failures below.
  client.on('error', () => {});
  await client.connect();
  await client.query(`SET ROLE "${owner}"`);
  const applied = await runMigrations(client, migrations);
  process.stdout.write(`Migrations complete: ${applied.length} applied.\n`);
} catch (error) {
  const code = error instanceof MigrationError ? error.code : 'migration_failed_check_configuration_or_database';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => { process.exitCode = 1; });
}
