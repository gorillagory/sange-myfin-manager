import assert from 'node:assert/strict';
import test from 'node:test';
import {
  originalFirebaseImportScope,
  parseOriginalFirebaseImportArgs,
} from '../src/original-firebase-import-cli.js';

test('import CLI requires an explicit export and manifest for a known mode', () => {
  const parsed = parseOriginalFirebaseImportArgs(['dry-run','--export','source','--manifest','decision.json']);
  assert.equal(parsed.mode,'dry-run');
  assert.match(parsed.exportDirectory,/source$/);
  assert.match(parsed.manifestPath,/decision\.json$/);
  for (const argv of [[],['apply'],['unknown','--export','a','--manifest','b'],
    ['apply','--export','a','--export','b'],['apply','--export','a','--manifest','b','extra']])
    assert.throws(()=>parseOriginalFirebaseImportArgs(argv),{code:'import_usage'});
});

test('database scope accepts only production or a timestamped production rehearsal clone', () => {
  const production = {PGUSER:'myfin_prod_migrator',MYFIN_IMPORT_OWNER:'myfin_prod_owner',MYFIN_ALLOW_ORIGINAL_FIREBASE_IMPORT:'myfin_prod'};
  assert.deepEqual(originalFirebaseImportScope(production,'myfin_prod'),{database:'myfin_prod',owner:'myfin_prod_owner',rehearsal:false});
  const rehearsalName='myfin_prod_import_rehearsal_20261002120000';
  assert.deepEqual(originalFirebaseImportScope({...production,MYFIN_ALLOW_ORIGINAL_FIREBASE_IMPORT:rehearsalName},rehearsalName),
    {database:rehearsalName,owner:'myfin_prod_owner',rehearsal:true});
  for (const [environment,database] of [
    [production,'myfin_dev'],
    [{...production,PGUSER:'myfin_prod_runtime'},'myfin_prod'],
    [{...production,MYFIN_IMPORT_OWNER:'platform'},'myfin_prod'],
    [{...production,MYFIN_ALLOW_ORIGINAL_FIREBASE_IMPORT:'other'},'myfin_prod'],
    [{...production,MYFIN_ALLOW_ORIGINAL_FIREBASE_IMPORT:'myfin_prod_import_rehearsal_latest'},'myfin_prod_import_rehearsal_latest'],
  ]) assert.throws(()=>originalFirebaseImportScope(environment,database),{code:'import_scope_required'});
});
