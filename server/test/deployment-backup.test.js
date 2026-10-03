import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const shellLine = source => source.replace(/\\\r?\n/g, ' ').replace(/\s+/g, ' ');

test('database backups use the scoped migrator as database owner without widening runtime grants', async () => {
  const [development, production, developmentGrants, productionGrants] = await Promise.all([
    read('scripts/deploy/backup.sh'),
    read('scripts/deploy/production-backup.sh'),
    read('db/grant-development-runtime.sql'),
    read('db/grant-production-runtime.sql'),
  ]);

  for (const [environment, source] of [['dev', development], ['prod', production]]) {
    const command = shellLine(source).match(/docker run .*?pg_dump .*?(?:myfin_dev\.dump|database\.dump)'/)?.[0] || '';
    assert.match(source, /MYFIN_MIGRATOR_PASSWORD_FILE:\?protected/);
    assert.match(command, new RegExp(`-U myfin_${environment}_migrator\\b`));
    assert.match(command, new RegExp(`--role=myfin_${environment}_owner\\b`));
    assert.doesNotMatch(command, /myfin_(?:dev|prod)_runtime/);
    assert.match(command, /src=\$MYFIN_MIGRATOR_PASSWORD_FILE,dst=\/run\/password,readonly/);
  }

  assert.doesNotMatch(developmentGrants, /original_firebase_/);
  assert.doesNotMatch(productionGrants, /original_firebase_/);
});
