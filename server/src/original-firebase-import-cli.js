import pg from 'pg';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import {
  OriginalFirebaseImportError,
  applyOriginalFirebaseImport,
  createOriginalFirebaseImportPlan,
  dryRunOriginalFirebaseImport,
  generateOriginalFirebaseManifest,
  loadOriginalFirebaseExport,
} from './original-firebase-import.js';

const SOURCE_PROJECT = 'myfinmanager-1d2da';
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const REHEARSAL_DATABASE = /^myfin_prod_import_rehearsal_[0-9]{14}$/;

export class OriginalFirebaseImportCliError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new OriginalFirebaseImportCliError(code); };

export function parseOriginalFirebaseImportArgs(argv) {
  const [mode, ...rest] = argv;
  if (!['plan','dry-run','apply'].includes(mode) || rest.length !== 4) fail('import_usage');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1];
    if (!['--export','--manifest'].includes(flag) || options[flag] || !value) fail('import_usage');
    options[flag] = resolve(value);
  }
  if (!options['--export'] || !options['--manifest']) fail('import_usage');
  return { mode, exportDirectory:options['--export'], manifestPath:options['--manifest'] };
}

export function originalFirebaseImportScope(env, database) {
  const rehearsal = REHEARSAL_DATABASE.test(database);
  if (database !== 'myfin_prod' && !rehearsal) fail('import_scope_required');
  if (env.PGUSER !== 'myfin_prod_migrator' || env.MYFIN_IMPORT_OWNER !== 'myfin_prod_owner' ||
      env.MYFIN_ALLOW_ORIGINAL_FIREBASE_IMPORT !== database || !ROLE.test(env.MYFIN_IMPORT_OWNER || ''))
    fail('import_scope_required');
  return { database, owner:env.MYFIN_IMPORT_OWNER, rehearsal };
}

async function readPrivateManifest(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size < 2 || info.size > 1024 * 1024) fail('invalid_manifest_file');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) fail('manifest_permissions_not_private');
  try { return JSON.parse(await readFile(path,'utf8')); }
  catch { fail('invalid_manifest_file'); }
}

async function writePrivateManifest(path, manifest) {
  try { await writeFile(path,`${JSON.stringify(manifest,null,2)}\n`,{encoding:'utf8',mode:0o600,flag:'wx'}); }
  catch { fail('manifest_create_failed'); }
}

function summary(mode, result) {
  return {
    mode,
    runId:result.runId,
    approved:result.approved,
    alreadyApplied:result.alreadyApplied,
    conflicts:result.conflicts,
    counts:result.counts,
  };
}

export async function runOriginalFirebaseImportCli(argv = process.argv.slice(2), env = process.env) {
  const input = parseOriginalFirebaseImportArgs(argv);
  const bundle = await loadOriginalFirebaseExport(input.exportDirectory);
  if (bundle.source.projectId !== SOURCE_PROJECT) fail('source_project_not_allowed');
  if (input.mode === 'plan') {
    const manifest = generateOriginalFirebaseManifest(bundle);
    const plan = createOriginalFirebaseImportPlan(bundle,manifest);
    await writePrivateManifest(input.manifestPath,manifest);
    return summary('plan',{runId:plan.runId,approved:false,counts:plan.counts});
  }

  const manifest = await readPrivateManifest(input.manifestPath);
  const reviewedPlan = createOriginalFirebaseImportPlan(bundle,manifest,{requireApproval:input.mode==='apply'});
  if (env.MYFIN_APPROVED_IMPORT_MANIFEST_SHA256 !== reviewedPlan.manifestDigest) fail('manifest_digest_approval_required');
  const config = loadConfig(env);
  const scope = originalFirebaseImportScope(env,config.database.database);
  let client;
  try {
    client = new pg.Client({...config.database,application_name:`myfin-original-firebase-${input.mode}`});
    client.on('error',()=>{});
    await client.connect();
    await client.query(`SET ROLE "${scope.owner}"`);
    const context = (await client.query('SELECT current_database() AS database,current_user AS role')).rows[0];
    if (context?.database !== scope.database || context?.role !== scope.owner) fail('import_database_context_invalid');
    if (input.mode === 'dry-run') return summary('dry-run',await dryRunOriginalFirebaseImport(client,bundle,manifest));
    const database = {
      transaction: async fn => {
        await client.query('BEGIN');
        try { const result = await fn(client); await client.query('COMMIT'); return result; }
        catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
      },
    };
    const result = await applyOriginalFirebaseImport(database,bundle,manifest);
    return summary('apply',{...result,approved:true,conflicts:[]});
  } finally {
    if (client) await client.end().catch(()=>{});
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.stdout.write(`${JSON.stringify(await runOriginalFirebaseImportCli())}\n`); }
  catch (error) {
    const code = error instanceof OriginalFirebaseImportError || error instanceof OriginalFirebaseImportCliError
      ? error.code : 'original_firebase_import_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
