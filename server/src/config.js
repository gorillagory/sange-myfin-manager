import { readFileSync } from 'node:fs';

export class ConfigurationError extends Error {
  constructor(key) {
    super(`Invalid configuration: ${key}`);
    this.name = 'ConfigurationError';
  }
}

export function loadConfig(env = process.env, readFile = readFileSync) {
  const fail = key => { throw new ConfigurationError(key); };
  const integer = (key, fallback, min, max) => {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw)) fail(key);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) fail(key);
    return value;
  };
  const name = (key, fallback) => {
    const value = env[key] ?? fallback;
    if (typeof value !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value)) fail(key);
    return value;
  };
  const mode = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(mode)) fail('NODE_ENV');
  const host = env.PGHOST ?? 'nexus-shared-postgres';
  if (!/^[a-zA-Z0-9.:-]+$/.test(host)) fail('PGHOST');
  const bind = env.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0', '::1', '::'].includes(bind)) fail('HOST');
  // Disallow ambiguous URL/driver settings; TLS policy is explicit below.
  if (env.DATABASE_URL || env.PGSSLMODE || env.PGOPTIONS) fail('unsupported database setting');
  if (env.PGPASSWORD && env.PGPASSWORD_FILE) fail('PGPASSWORD/PGPASSWORD_FILE');
  let password = env.PGPASSWORD;
  if (env.PGPASSWORD_FILE) {
    try { password = readFile(env.PGPASSWORD_FILE, 'utf8').replace(/\r?\n$/, ''); }
    catch { fail('PGPASSWORD_FILE'); }
  }
  if (typeof password !== 'string' || !password.length || /[\r\n\0]/.test(password)) fail('PGPASSWORD');
  const tls = env.PG_TLS ?? 'disable';
  if (!['disable', 'verify-full'].includes(tls)) fail('PG_TLS');
  let ssl = false;
  if (tls === 'verify-full') {
    let ca;
    if (env.PG_CA_FILE) {
      try { ca = readFile(env.PG_CA_FILE, 'utf8'); } catch { fail('PG_CA_FILE'); }
      if (!ca.includes('-----BEGIN CERTIFICATE-----')) fail('PG_CA_FILE');
    }
    ssl = { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
  } else if (env.PG_CA_FILE) fail('PG_CA_FILE');
  const statementTimeout = integer('PG_STATEMENT_TIMEOUT_MS', 3000, 100, 60000);
  const queryTimeout = integer('PG_QUERY_TIMEOUT_MS', 4000, 100, 65000);
  if (queryTimeout <= statementTimeout) fail('PG_QUERY_TIMEOUT_MS');
  return Object.freeze({
    host: bind,
    port: integer('PORT', 8080, 1, 65535),
    shutdownTimeoutMs: integer('SHUTDOWN_TIMEOUT_MS', 10000, 1000, 30000),
    database: Object.freeze({
      host, port: integer('PGPORT', 5432, 1, 65535),
      database: name('PGDATABASE', 'myfin_dev'), user: name('PGUSER', 'myfin_dev_runtime'),
      password, ssl,
      max: integer('PGPOOL_MAX', 5, 1, 20),
      connectionTimeoutMillis: integer('PG_CONNECT_TIMEOUT_MS', 2000, 100, 10000),
      idleTimeoutMillis: integer('PG_IDLE_TIMEOUT_MS', 10000, 1000, 60000),
      statement_timeout: statementTimeout, query_timeout: queryTimeout,
      idle_in_transaction_session_timeout: 10000,
      application_name: 'myfin-api',
      options: '-c search_path=myfin,pg_catalog'
    })
  });
}
