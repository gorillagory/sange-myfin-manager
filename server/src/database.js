import pg from 'pg';
import { REQUIRED_RUNTIME_MIGRATION, runtimePrivilegeCheck } from './runtime-privileges.js';

const runtimeAcl = runtimePrivilegeCheck(2);

export function createDatabase(config, { Pool = pg.Pool, onError = () => {} } = {}) {
  const pool = new Pool(config);
  // pg emits idle-client errors outside request promises. Never log the raw error.
  pool.on('error', () => onError('database_pool_error'));
  let closing;
  return {
    pool,
    query: (...args) => pool.query(...args),
    async transaction(fn) {
      const client = await pool.connect();
      try { await client.query("BEGIN"); const result = await fn(client); await client.query("COMMIT"); return result; }
      catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async ready() {
      try {
        const result = await pool.query(`SELECT
          EXISTS (SELECT 1 FROM myfin.schema_migrations WHERE version = $1)
          AND ${runtimeAcl.predicate} AS ready,
          (SELECT id FROM myfin.companies LIMIT 0),
          (SELECT id FROM myfin.app_identities LIMIT 0),
          (SELECT subject FROM myfin.identity_mappings LIMIT 0),
          (SELECT company_id FROM myfin.memberships LIMIT 0)`,
        [REQUIRED_RUNTIME_MIGRATION, ...runtimeAcl.parameters]);
        return result.rows[0]?.ready === true;
      } catch {
        return false;
      }
    },
    close() { return closing ??= pool.end(); }
  };
}
