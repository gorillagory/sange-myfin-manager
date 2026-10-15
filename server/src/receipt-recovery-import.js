import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import * as v from './validation.js';
import { businessDate, canonical, cents, saleTotalsFor } from '../../src/domain/pos.js';
import { safePaidSale } from '../../src/domain/offlinePolicy.js';

const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
const CAPTURE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const CAPTURE_AGE_LIMIT_MS = 72 * 60 * 60 * 1000;
const DELAYED_RECEIPT_MS = 5 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/;

export class ReceiptRecoveryImportError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ReceiptRecoveryImportError(code); };

const exactMoneyCents = (value, code) => {
  const amount = Number(value), amountCents = cents(amount);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(amountCents) ||
      Math.abs(amount * 100 - amountCents) >= 1e-6) fail(code);
  return amountCents;
};

export function parseReceiptRecoveryArgs(argv) {
  const options = { apply:false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--apply') {
      if (options.apply) fail('receipt_recovery_usage');
      options.apply = true;
      continue;
    }
    if (!['--input','--expected-sha256','--expected-count','--expected-total'].includes(flag) ||
        options[flag] !== undefined || index + 1 >= argv.length) fail('receipt_recovery_usage');
    options[flag] = argv[++index];
  }
  if (!options['--input'] || !SHA256.test(options['--expected-sha256'] || '') ||
      !/^\d{1,4}$/.test(options['--expected-count'] || '') ||
      !/^\d{1,9}\.\d{2}$/.test(options['--expected-total'] || '')) fail('receipt_recovery_usage');
  const expectedCount = Number(options['--expected-count']);
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 1000)
    fail('receipt_recovery_usage');
  return {
    inputPath: options['--input'],
    expectedSha256: options['--expected-sha256'],
    expectedCount,
    expectedTotalCents: exactMoneyCents(options['--expected-total'],'receipt_recovery_usage'),
    apply: options.apply,
  };
}

export function receiptRecoveryScope(env, database, inputSha256, apply) {
  if (env.MYFIN_ALLOW_RECEIPT_RECOVERY_IMPORT !== database ||
      !/^myfin_(?:dev|prod)$/.test(database) ||
      env.PGUSER !== `${database}_runtime`) fail('receipt_recovery_scope_required');
  if (apply && env.MYFIN_APPROVED_RECEIPT_RECOVERY_SHA256 !== inputSha256)
    fail('receipt_recovery_digest_approval_required');
  return { database, apply };
}

export async function loadReceiptRecoveryExport(path, expectedSha256) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size < 2 || info.size > MAX_EXPORT_BYTES)
    fail('invalid_receipt_recovery_file');
  const bytes = await readFile(path), sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha256) fail('receipt_recovery_digest_mismatch');
  let rows;
  try { rows = JSON.parse(bytes.toString('utf8')); }
  catch { fail('invalid_receipt_recovery_json'); }
  if (!Array.isArray(rows)) fail('invalid_receipt_recovery_json');
  return { rows, sha256, bytes:info.size };
}

function checkoutPayload(input) {
  const { syncError, syncStatus, cachePolicyVersion, templateSnapshot, companySnapshot, ...body } = safePaidSale(input);
  return body;
}

function recoveryReason(sale, serverNow) {
  const capturedAt = new Date(sale.date), serverAt = new Date(serverNow);
  if (!Number.isFinite(capturedAt.getTime()) || !Number.isFinite(serverAt.getTime()))
    fail('invalid_receipt_recovery_time');
  const ageMs=serverAt.getTime()-capturedAt.getTime();
  if (ageMs < -CAPTURE_FUTURE_TOLERANCE_MS || ageMs > CAPTURE_AGE_LIMIT_MS)
    return 'receipt_review_required_offline_time';
  if (sale.offline === true) return 'receipt_review_required_offline_sync';
  if (Math.abs(serverAt.getTime() - capturedAt.getTime()) <= DELAYED_RECEIPT_MS)
    fail('receipt_recovery_not_historical');
  return 'receipt_review_required_delayed_sync';
}

export function createReceiptRecoveryPlan(rows, {
  sha256,
  expectedCount,
  expectedTotalCents,
  serverNow,
} = {}) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 1000)
    fail('invalid_receipt_recovery_count');
  if (rows.length !== expectedCount) fail('receipt_recovery_count_mismatch');
  const ids = new Set(), companies = new Set(), cashiers = new Set(), reasons = {}, receipts = [];
  let totalCents = 0;
  for (const raw of rows) {
    let sale;
    try { sale = v.parse(v.sale, checkoutPayload(raw)); }
    catch { fail('invalid_receipt_recovery_sale'); }
    if (ids.has(sale.id)) fail('duplicate_receipt_recovery_id');
    ids.add(sale.id); companies.add(sale.company_id); cashiers.add(sale.cashierId);
    let totals;
    try { totals = saleTotalsFor(sale); }
    catch { fail('invalid_receipt_recovery_totals'); }
    if (sale.number !== `POS-${sale.id.toUpperCase()}` ||
        sale.businessDate !== businessDate(sale.date) || totals.total <= 0 ||
        Object.entries(totals).some(([key,value]) => sale[key] !== value) ||
        exactMoneyCents(sale.received,'invalid_receipt_recovery_tender') < exactMoneyCents(sale.total,'invalid_receipt_recovery_total') ||
        exactMoneyCents(sale.change,'invalid_receipt_recovery_change') !== cents(sale.received) - cents(sale.total))
      fail('invalid_receipt_recovery_paid_intent');
    const reasonCode = recoveryReason(sale,serverNow);
    const requestDigest = createHash('sha256').update(JSON.stringify(canonical(sale))).digest('hex');
    totalCents += cents(sale.total);
    if (!Number.isSafeInteger(totalCents)) fail('invalid_receipt_recovery_total');
    reasons[reasonCode] = (reasons[reasonCode] || 0) + 1;
    receipts.push({ id:sale.id, sale, requestDigest, reasonCode });
  }
  if (companies.size !== 1) fail('receipt_recovery_multiple_companies');
  if (cashiers.size !== 1) fail('receipt_recovery_multiple_cashiers');
  if (totalCents !== expectedTotalCents) fail('receipt_recovery_total_mismatch');
  return {
    sha256,
    companyId:[...companies][0],
    cashierId:[...cashiers][0],
    count:receipts.length,
    totalCents,
    reasons,
    receipts:receipts.sort((a,b) => a.id.localeCompare(b.id)),
  };
}

async function validateDatabaseScope(client, plan) {
  const migration = await client.query("SELECT 1 FROM myfin.schema_migrations WHERE version='0034_receipt_sync_recovery.sql'");
  if (!migration.rowCount) fail('receipt_recovery_migration_required');
  const context = (await client.query('SELECT current_database() AS database,current_user AS role')).rows[0];
  const company = (await client.query(
    `SELECT c.id,c.workspace_id FROM myfin.companies c JOIN myfin.workspaces w ON w.id=c.workspace_id
      WHERE c.id=$1 AND c.archived_at IS NULL AND c.suspended_at IS NULL
        AND w.archived_at IS NULL AND w.suspended_at IS NULL FOR SHARE OF c,w`,[plan.companyId])).rows[0];
  if (!company) fail('receipt_recovery_company_unavailable');
  const cashier = (await client.query(
    `SELECT i.id,i.display_name FROM myfin.app_identities i
      WHERE i.id=$1 AND i.disabled_at IS NULL AND (
        EXISTS (SELECT 1 FROM myfin.workspace_memberships wm WHERE wm.identity_id=i.id AND wm.workspace_id=$2 AND wm.suspended_at IS NULL)
        OR EXISTS (SELECT 1 FROM myfin.memberships m WHERE m.identity_id=i.id AND m.company_id=$3))
      FOR SHARE`,[plan.cashierId,company.workspace_id,plan.companyId])).rows[0];
  if (!cashier) fail('receipt_recovery_cashier_unavailable');
  return { context, cashier };
}

export async function applyReceiptRecoveryPlan(client, plan, { apply = false } = {}) {
  const { context, cashier } = await validateDatabaseScope(client,plan);
  for (const receipt of plan.receipts)
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7))",[plan.companyId+':sale:'+receipt.id]);
  const ids = plan.receipts.map(receipt => receipt.id);
  const posted = await client.query(
    'SELECT id FROM myfin.transactions WHERE company_id=$1 AND id=ANY($2::text[]) FOR SHARE',[plan.companyId,ids]);
  if (posted.rowCount) fail('receipt_recovery_transaction_exists');
  const existing = await client.query(
    `SELECT id,actor_id,request_digest FROM myfin.receipt_reviews
      WHERE company_id=$1 AND id=ANY($2::text[])${apply?' FOR UPDATE':' FOR SHARE'}`,[plan.companyId,ids]);
  const byId = new Map(existing.rows.map(row => [row.id,row]));
  let alreadyPresent = 0;
  for (const receipt of plan.receipts) {
    const row = byId.get(receipt.id);
    if (!row) continue;
    if (row.actor_id !== plan.cashierId || row.request_digest !== receipt.requestDigest)
      fail('receipt_recovery_review_conflict');
    alreadyPresent++;
  }
  const pending = plan.receipts.filter(receipt => !byId.has(receipt.id));
  if (apply) for (const receipt of pending) {
    await client.query(
      `INSERT INTO myfin.receipt_reviews(company_id,id,actor_id,payload,request_digest,reason_code)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [plan.companyId,receipt.id,plan.cashierId,receipt.sale,receipt.requestDigest,receipt.reasonCode]);
    await client.query(
      'INSERT INTO myfin.activities(company_id,id,actor_id,data) VALUES($1,$2,$3,$4)',
      [plan.companyId,randomUUID(),plan.cashierId,{action:'Import paid receipt recovery',details:receipt.id,
        user:cashier.display_name,actorId:plan.cashierId,date:new Date().toISOString()}]);
  }
  return {
    database:context.database,
    role:context.role,
    mode:apply?'apply':'dry-run',
    sha256:plan.sha256,
    count:plan.count,
    total:(plan.totalCents/100).toFixed(2),
    inserted:apply?pending.length:0,
    wouldInsert:apply?0:pending.length,
    alreadyPresent,
    reasons:plan.reasons,
  };
}
