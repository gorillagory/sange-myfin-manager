import { createHash } from 'node:crypto';
import { canonical } from '../../src/domain/pos.js';
import * as v from './validation.js';

export const expenseCreateRequestDigest = (companyId, actorId, expense) =>
  createHash('sha256').update(JSON.stringify(canonical({
    actorId,
    companyId,
    expense,
  }))).digest('hex');

// A transaction-scoped advisory lock closes the missing-row race: concurrent
// retries for one client-generated expense id cannot both pass the existence
// check and post a payment or petty-cash withdrawal twice.
export async function inspectExpenseCreate(c, companyId, actorId, expense) {
  const requestDigest = expenseCreateRequestDigest(companyId, actorId, expense);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,24))',
    [`${companyId}:expense-create:${expense.id}`]);
  const existing = (await c.query(
    'SELECT * FROM myfin.expenses WHERE company_id=$1 AND id=$2',
    [companyId, expense.id],
  )).rows[0] || null;
  if (existing && (existing.created_by !== actorId
      || existing.create_request_digest !== requestDigest))
    v.fail(409, 'expense_create_payload_changed');
  return { existing, requestDigest };
}
