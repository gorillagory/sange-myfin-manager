import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

function roleConnectionLimit(source, role) {
  const match = source.match(new RegExp(
    `CREATE ROLE ${role}[^;]*CONNECTION LIMIT ([0-9]+);`, 'i',
  ));
  assert.ok(match, `missing bounded connection limit for ${role}`);
  return Number(match[1]);
}

function environmentPoolSize(source, name) {
  const match = source.match(new RegExp(`^${name}=([0-9]+)$`, 'm'));
  assert.ok(match, `missing explicit ${name}`);
  return Number(match[1]);
}

test('runtime role limits cover all concurrently configured process pools', async () => {
  const [compose, development, production, developmentEnv, productionEnv] = await Promise.all([
    read('deploy/compose.yml'),
    read('db/provision-development.sql'),
    read('db/provision-production.sql'),
    read('deploy/development.env.example'),
    read('deploy/production.env.example'),
  ]);
  const poolDefaults = Object.fromEntries([...compose.matchAll(
    /PGPOOL_MAX: \$\{(MYFIN_(?:DB|REPORT_DB|RECEIPT_EMAIL_DB)_POOL_MAX):-([0-9]+)\}/g,
  )].map(match => [match[1], Number(match[2])]));
  assert.deepEqual(poolDefaults, {
    MYFIN_DB_POOL_MAX: 5,
    MYFIN_REPORT_DB_POOL_MAX: 2,
    MYFIN_RECEIPT_EMAIL_DB_POOL_MAX: 2,
  });
  const required = Object.values(poolDefaults).reduce((total, size) => total + size, 0);
  assert.equal(required, 9);
  assert.equal(roleConnectionLimit(development, 'myfin_dev_runtime'), required);
  assert.equal(roleConnectionLimit(production, 'myfin_prod_runtime'), required);
  for (const source of [developmentEnv, productionEnv]) {
    assert.equal(environmentPoolSize(source, 'MYFIN_DB_POOL_MAX')
      + environmentPoolSize(source, 'MYFIN_REPORT_DB_POOL_MAX')
      + environmentPoolSize(source, 'MYFIN_RECEIPT_EMAIL_DB_POOL_MAX'), required);
  }
});

test('rollout checks the live role limit before starting database clients', async () => {
  const [capacityCheck, developmentUp, productionUp] = await Promise.all([
    read('scripts/deploy/check-runtime-capacity.sh'),
    read('scripts/deploy/up.sh'),
    read('scripts/deploy/production-up.sh'),
  ]);
  assert.match(capacityCheck, /myfin_dev_runtime\|myfin_prod_runtime/);
  assert.match(capacityCheck, /SELECT rolconnlimit FROM pg_catalog\.pg_roles/);
  assert.match(capacityCheck, /required_connections=\$\(\(api_pool \+ report_pool\)\)/);
  assert.match(capacityCheck, /required_connections=\$\(\(required_connections \+ receipt_pool\)\)/);
  assert.match(capacityCheck, /\[ "\$role_limit" -ge "\$required_connections" \]/);
  assert.doesNotMatch(capacityCheck, /ALTER\s+ROLE/i);
  for (const source of [developmentUp, productionUp]) {
    const check = source.indexOf('check-runtime-capacity.sh');
    const firstStart = source.indexOf('compose up -d');
    assert.ok(check >= 0 && firstStart > check,
      'capacity preflight must run before the first long-lived container starts');
  }
});
