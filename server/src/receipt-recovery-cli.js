import pg from 'pg';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import {
  ReceiptRecoveryImportError,
  applyReceiptRecoveryPlan,
  createReceiptRecoveryPlan,
  loadReceiptRecoveryExport,
  parseReceiptRecoveryArgs,
  receiptRecoveryScope,
} from './receipt-recovery-import.js';

export async function runReceiptRecoveryCli(argv = process.argv.slice(2), env = process.env) {
  const input = parseReceiptRecoveryArgs(argv);
  const bundle = await loadReceiptRecoveryExport(input.inputPath,input.expectedSha256);
  const config = loadConfig(env);
  receiptRecoveryScope(env,config.database.database,bundle.sha256,input.apply);
  let client;
  try {
    client = new pg.Client({...config.database,application_name:'myfin-receipt-recovery'});
    client.on('error',()=>{});
    await client.connect();
    await client.query('BEGIN');
    try {
      const serverNow = (await client.query('SELECT now() AS server_now')).rows[0]?.server_now;
      const plan = createReceiptRecoveryPlan(bundle.rows,{sha256:bundle.sha256,
        expectedCount:input.expectedCount,expectedTotalCents:input.expectedTotalCents,serverNow});
      const result = await applyReceiptRecoveryPlan(client,plan,{apply:input.apply});
      if (input.apply) await client.query('COMMIT');
      else await client.query('ROLLBACK');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(()=>{});
      throw error;
    }
  } finally {
    if (client) await client.end().catch(()=>{});
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.stdout.write(`${JSON.stringify(await runReceiptRecoveryCli())}\n`); }
  catch (error) {
    const code = error instanceof ReceiptRecoveryImportError ? error.code : 'receipt_recovery_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

