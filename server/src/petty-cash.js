import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { businessDate, canonical, cents } from '../../src/domain/pos.js';
import { effectiveExpenseStatus } from '../../src/domain/expenseLifecycle.js';
import { operator, requireCapability } from './access.js';
import { expenseLifecycleSnapshot, recordExpenseEvent } from './expense-lifecycle.js';
import * as v from './validation.js';

const idempotencyKey = z.string().trim().min(8).max(128);
const reason = z.string().trim().min(3).max(1000);
const money = z.number().finite().min(0).max(1_000_000_000)
  .refine(value => cents(value) / 100 === value, 'Use no more than two decimal places.');
const positiveMoney = money.refine(value => value > 0, 'Amount must be greater than zero.');
const occurredAt = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),z.string().datetime({ offset:true }),
]).optional();
const fundCreateSchema = z.strictObject({
  name:z.string().trim().min(1).max(120),
  currency:z.union([z.literal('MYR'),z.literal('RM')]).default('MYR').transform(()=> 'MYR'),
  isDefault:z.boolean().default(false), openingBalance:money.default(0),
  lowBalanceThreshold:money.default(0), reason:reason.default('Opening petty cash fund'),
  idempotencyKey,
});
const fundPatchSchema = z.strictObject({
  version:z.number().int().positive(), name:z.string().trim().min(1).max(120).optional(),
  isDefault:z.boolean().optional(), lowBalanceThreshold:money.optional(),
}).refine(input => input.name !== undefined || input.isDefault !== undefined || input.lowBalanceThreshold !== undefined,
  'Choose a fund setting to update.');
const standardEntrySchema = z.strictObject({
  type:z.enum(['replenishment','adjustment_in','adjustment_out']), amount:positiveMoney,
  reason,idempotencyKey,occurredAt,reference:z.string().trim().max(500).default(''),
});
const reconciliationEntrySchema = z.strictObject({
  type:z.literal('reconciliation'), countedBalance:money, reason,idempotencyKey,occurredAt,
  reference:z.string().trim().max(500).default(''),
});
const reversalEntrySchema = z.strictObject({
  type:z.literal('reversal'), reversesEntryId:v.id, reason,idempotencyKey,occurredAt,
  reference:z.string().trim().max(500).default(''),
});
const closeEntrySchema = z.strictObject({
  type:z.literal('close'), reason,idempotencyKey,occurredAt,
  reference:z.string().trim().max(500).default(''),
});
const entrySchema = z.discriminatedUnion('type',[
  standardEntrySchema,reconciliationEntrySchema,reversalEntrySchema,closeEntrySchema,
]);
const paymentSchema = z.strictObject({
  amount:positiveMoney,
  sourceType:z.enum(['app_user','non_user','petty_cash','other','bank','card']),
  pettyCashFundId:z.union([v.id,z.literal('')]).default(''),
  paidByUserId:z.union([v.id,z.literal('')]).default(''),
  paidByName:z.string().trim().max(500).default(''),
  paidOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference:z.string().trim().max(500).default(''), reason,idempotencyKey,
  expectedVersion:z.number().int().positive(),
});
const paymentReversalSchema = z.strictObject({ reason,idempotencyKey,expectedVersion:z.number().int().positive() });

const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const numeric = value => Number(value || 0);
const iso = value => value instanceof Date ? value.toISOString() : String(value || '');
const dateText = value => value instanceof Date ? value.toISOString().slice(0,10) : String(value || '').slice(0,10);
export function expensePaymentReversalTiming(now = new Date()) {
  const occurredAt=now instanceof Date?now.toISOString():new Date(now).toISOString();
  return {occurredAt,occurredOn:businessDate(occurredAt)};
}
export function pettyCashOccurrence(value, now = new Date()) {
  const current=now instanceof Date?now:new Date(now),dateOnly=typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
  if(!Number.isFinite(current.getTime()))v.fail(400,'invalid_petty_cash_occurred_at');
  if(dateOnly&&value>businessDate(current))v.fail(400,'invalid_petty_cash_occurred_at');
  const occurred=value?new Date(dateOnly?`${value}T12:00:00.000+08:00`:value):current;
  if(!Number.isFinite(occurred.getTime())||(!dateOnly&&occurred.getTime()>current.getTime()+300000))
    v.fail(400,'invalid_petty_cash_occurred_at');
  return {occurred,effectiveDay:businessDate(occurred)};
}

export function fundOutput(row) {
  const balanceSen=numeric(row.balance_sen), thresholdSen=numeric(row.low_balance_threshold_sen);
  return {
    id:row.id,name:row.name,currency:row.currency_code,status:row.status,isDefault:Boolean(row.is_default),
    openingBalanceSen:numeric(row.opening_balance_sen),openingBalance:numeric(row.opening_balance_sen)/100,
    balanceSen,balance:balanceSen/100,lowBalanceThresholdSen:thresholdSen,
    lowBalanceThreshold:thresholdSen/100,lowBalance:row.status==='open'&&balanceSen<=thresholdSen,
    version:numeric(row.version),createdBy:row.created_by,createdByName:row.created_by_name||'',
    openedAt:row.opened_at,closedAt:row.closed_at,closedBy:row.closed_by||'',updatedAt:row.updated_at,
  };
}

export function entryOutput(row) {
  const signed=numeric(row.signed_amount_sen), amount=numeric(row.amount_sen), balance=numeric(row.balance_after_sen);
  return {
    id:row.id,fundId:row.fund_id,type:row.entry_type,
    direction:signed>0?'in':signed<0?'out':'neutral',amountSen:amount,amount:amount/100,
    signedAmountSen:signed,balanceAfterSen:balance,balanceAfter:balance/100,
    countedBalanceSen:row.counted_balance_sen==null?null:numeric(row.counted_balance_sen),
    expenseId:row.expense_id||'',expensePaymentId:row.expense_payment_event_id||'',
    reversesEntryId:row.reverses_entry_id||'',reference:row.reference||'',reason:row.reason,
    occurredAt:row.occurred_at,createdAt:row.created_at,actorId:row.actor_id,actorName:row.actor_name||'',
  };
}

export function paymentOutput(row) {
  const amount=numeric(row.amount_sen), signed=row.event_type==='reversal'?-amount:amount;
  return {
    id:row.id,expenseId:row.expense_id,eventType:row.event_type,amountSen:amount,amount:amount/100,
    signedAmountSen:signed,sourceType:row.source_type,paidByUserId:row.paid_by_identity_id||'',
    paidByName:row.paid_by_name||'',pettyCashFundId:row.petty_cash_fund_id||'',
    pettyCashFundName:row.petty_cash_fund_name||'',pettyCashEntryId:row.petty_cash_entry_id||'',
    reference:row.reference||'',reason:row.reason,reversesPaymentId:row.reverses_event_id||'',
    paidOn:dateText(row.occurred_on),createdAt:row.created_at,actorId:row.actor_id||'',
    actorName:row.actor_name||'',
  };
}

function expenseState(row) {
  const amountSen=numeric(row.amount_sen), paidAmountSen=numeric(row.paid_amount_sen);
  const creditDueDate=dateText(row.credit_due_date), status=row.status;
  return {
    id:row.id,status,effectiveStatus:row.voided_at?'voided':effectiveExpenseStatus({status,creditDueDate}),
    amountSen,amount:amountSen/100,paidAmountSen,paidAmount:paidAmountSen/100,
    outstandingAmountSen:amountSen-paidAmountSen,outstandingAmount:(amountSen-paidAmountSen)/100,
    paidOn:dateText(row.paid_on),creditDueDate,version:numeric(row.version),
  };
}

async function fundRow(c, companyId, fundId, { lock=false } = {}) {
  const row=(await c.query(`SELECT f.*,i.display_name AS created_by_name,
      coalesce((SELECT sum(e.signed_amount_sen) FROM myfin.petty_cash_entries e
        WHERE e.company_id=f.company_id AND e.fund_id=f.id),0)::bigint AS balance_sen,
      coalesce((SELECT max(e.amount_sen) FROM myfin.petty_cash_entries e
        WHERE e.company_id=f.company_id AND e.fund_id=f.id AND e.entry_type='opening_balance'),0)::bigint AS opening_balance_sen
    FROM myfin.petty_cash_funds f
    LEFT JOIN myfin.app_identities i ON i.id=f.created_by
    WHERE f.company_id=$1 AND f.id=$2${lock?' FOR UPDATE OF f':''}`,[companyId,fundId])).rows[0];
  if(!row)v.fail(404,'petty_cash_fund_not_found');
  return row;
}

async function entryRow(c, companyId, entryId) {
  return (await c.query(`SELECT e.*,i.display_name AS actor_name
    FROM myfin.petty_cash_entries e LEFT JOIN myfin.app_identities i ON i.id=e.actor_id
    WHERE e.company_id=$1 AND e.id=$2`,[companyId,entryId])).rows[0];
}

async function paymentRow(c, companyId, paymentId) {
  return (await c.query(`SELECT p.*,i.display_name AS actor_name,f.name AS petty_cash_fund_name,
      pe.id AS petty_cash_entry_id
    FROM myfin.expense_payment_events p
    LEFT JOIN myfin.app_identities i ON i.id=p.actor_id
    LEFT JOIN myfin.petty_cash_funds f
      ON f.company_id=p.company_id AND f.id=p.petty_cash_fund_id
    LEFT JOIN myfin.petty_cash_entries pe
      ON pe.company_id=p.company_id AND pe.expense_payment_event_id=p.id
    WHERE p.company_id=$1 AND p.id=$2`,[companyId,paymentId])).rows[0];
}

async function insertEntry(c, who, companyId, fundId, raw, {
  internal=false, expenseId='', expensePaymentId='', allowExpenseReversal=false, bumpFund=true,now=new Date(),
}={}) {
  const input=internal?raw:v.parse(entrySchema,raw), digest=hash({companyId,fundId,...input,expenseId,expensePaymentId});
  const fund=await fundRow(c,companyId,fundId,{lock:true});
  const replay=(await c.query(`SELECT id,request_digest FROM myfin.petty_cash_entries
    WHERE company_id=$1 AND fund_id=$2 AND idempotency_key=$3`,[companyId,fundId,input.idempotencyKey])).rows[0];
  if(replay){
    if(replay.request_digest!==digest)v.fail(409,'petty_cash_idempotency_key_reused');
    return {fund:fundOutput(fund),entry:entryOutput(await entryRow(c,companyId,replay.id)),replayed:true};
  }
  if(fund.status!=='open')v.fail(409,'petty_cash_fund_closed');
  const current=numeric(fund.balance_sen);
  let type=input.type,signed=0,counted=null,reverses='',reference=input.reference||'';
  if(type==='replenishment'||type==='adjustment_in')signed=cents(input.amount);
  else if(type==='adjustment_out')signed=-cents(input.amount);
  else if(type==='reconciliation'){
    counted=cents(input.countedBalance);signed=counted-current;
  }else if(type==='close'){
    if(current!==0)v.fail(409,'petty_cash_balance_not_zero');
  }else if(type==='reopen'){
    signed=0;
  }else if(type==='reversal'){
    const original=(await c.query(`SELECT * FROM myfin.petty_cash_entries
      WHERE company_id=$1 AND fund_id=$2 AND id=$3 FOR UPDATE`,[companyId,fundId,input.reversesEntryId])).rows[0];
    if(!original)v.fail(404,'petty_cash_entry_not_found');
    if(['opening_balance','close','reversal'].includes(original.entry_type)
      ||(original.entry_type==='expense_disbursement'&&!allowExpenseReversal)
      ||numeric(original.signed_amount_sen)===0)v.fail(409,'petty_cash_entry_not_reversible');
    const prior=(await c.query(`SELECT id FROM myfin.petty_cash_entries
      WHERE company_id=$1 AND reverses_entry_id=$2`,[companyId,original.id])).rows[0];
    if(prior)v.fail(409,'petty_cash_entry_already_reversed');
    signed=-numeric(original.signed_amount_sen);reverses=original.id;
  }else if(type==='opening_balance')signed=cents(input.amount);
  else if(type==='expense_disbursement')signed=-cents(input.amount);
  else v.fail(400,'invalid_petty_cash_entry_type');
  const after=current+signed;
  if(after<0)v.fail(409,'petty_cash_insufficient_balance');
  const id=randomUUID(),{occurred,effectiveDay}=pettyCashOccurrence(input.occurredAt,now);
  const openedAt=new Date(fund.opened_at);
  if(Number.isFinite(openedAt.getTime())&&effectiveDay<businessDate(openedAt.toISOString()))
    v.fail(409,'petty_cash_entry_before_fund_opened');
  await c.query(`INSERT INTO myfin.petty_cash_entries(company_id,id,fund_id,entry_type,
      signed_amount_sen,amount_sen,balance_after_sen,counted_balance_sen,expense_id,
      expense_payment_event_id,reverses_entry_id,reference,reason,idempotency_key,
      request_digest,actor_id,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
  [companyId,id,fundId,type,signed,Math.abs(signed),after,counted,expenseId||null,
    expensePaymentId||null,reverses||null,reference,input.reason,input.idempotencyKey,digest,who.id,occurred]);
  if(type==='close')await c.query(`UPDATE myfin.petty_cash_funds SET status='closed',is_default=false,
    closed_at=now(),closed_by=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2`,
  [companyId,fundId,who.id]);
  else if(bumpFund)await c.query(`UPDATE myfin.petty_cash_funds SET version=version+1,updated_at=now()
    WHERE company_id=$1 AND id=$2`,[companyId,fundId]);
  return {fund:fundOutput(await fundRow(c,companyId,fundId)),entry:entryOutput(await entryRow(c,companyId,id)),replayed:false};
}

export async function createPettyCashFund(c, who, companyId, raw, audit=async()=>{}) {
  requireCapability(who,'pettyCashManage');
  const input=v.parse(fundCreateSchema,raw),digest=hash({companyId,...input});
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,43))',[`${companyId}:petty-cash-funds`]);
  const duplicate=(await c.query(`SELECT id,request_digest FROM myfin.petty_cash_funds
    WHERE company_id=$1 AND idempotency_key=$2`,[companyId,input.idempotencyKey])).rows[0];
  if(duplicate){
    if(duplicate.request_digest!==digest)v.fail(409,'petty_cash_idempotency_key_reused');
    const opening=(await c.query(`SELECT e.*,i.display_name AS actor_name FROM myfin.petty_cash_entries e
      LEFT JOIN myfin.app_identities i ON i.id=e.actor_id
      WHERE e.company_id=$1 AND e.fund_id=$2 AND e.entry_type='opening_balance'`,[companyId,duplicate.id])).rows[0];
    return {fund:fundOutput(await fundRow(c,companyId,duplicate.id)),
      entry:opening?entryOutput(opening):null,replayed:true};
  }
  const hasOpen=Boolean((await c.query(`SELECT 1 FROM myfin.petty_cash_funds
    WHERE company_id=$1 AND status='open' LIMIT 1`,[companyId])).rowCount),isDefault=input.isDefault||!hasOpen;
  if(isDefault)await c.query(`UPDATE myfin.petty_cash_funds SET is_default=false,version=version+1,updated_at=now()
    WHERE company_id=$1 AND is_default AND status='open'`,[companyId]);
  const id=randomUUID();
  await c.query(`INSERT INTO myfin.petty_cash_funds(company_id,id,name,currency_code,is_default,
      low_balance_threshold_sen,idempotency_key,request_digest,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[companyId,id,input.name,input.currency,isDefault,
    cents(input.lowBalanceThreshold),input.idempotencyKey,digest,who.id]);
  const result=await insertEntry(c,who,companyId,id,{type:'opening_balance',amount:input.openingBalance,
    reason:input.reason,idempotencyKey:`opening-${hash({companyId,id})}`,occurredAt:new Date().toISOString(),reference:''},
  {internal:true,bumpFund:false});
  await audit(c,who,companyId,'Open petty cash fund',`${input.name} · RM ${input.openingBalance.toFixed(2)}`);
  return result;
}

export async function updatePettyCashFund(c, who, companyId, fundId, raw, audit=async()=>{}) {
  requireCapability(who,'pettyCashManage');
  const input=v.parse(fundPatchSchema,raw);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,43))',[`${companyId}:petty-cash-funds`]);
  const fund=await fundRow(c,companyId,fundId,{lock:true});
  if(numeric(fund.version)!==input.version)v.fail(409,'petty_cash_fund_changed');
  if(input.isDefault===true&&fund.status!=='open')v.fail(409,'petty_cash_fund_closed');
  if(input.isDefault===true)await c.query(`UPDATE myfin.petty_cash_funds SET is_default=false,
    version=version+1,updated_at=now() WHERE company_id=$1 AND id<>$2 AND is_default AND status='open'`,
  [companyId,fundId]);
  await c.query(`UPDATE myfin.petty_cash_funds SET name=coalesce($3,name),
      is_default=coalesce($4,is_default),low_balance_threshold_sen=coalesce($5,low_balance_threshold_sen),
      version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2`,
  [companyId,fundId,input.name??null,input.isDefault??null,
    input.lowBalanceThreshold===undefined?null:cents(input.lowBalanceThreshold)]);
  const updated=fundOutput(await fundRow(c,companyId,fundId));
  await audit(c,who,companyId,'Update petty cash fund',`${updated.name} · version ${updated.version}`);
  return updated;
}

async function assertPayer(c, companyId, payerId) {
  const row=(await c.query(`SELECT i.id FROM myfin.app_identities i JOIN myfin.companies co ON co.id=$1
    WHERE i.id=$2 AND i.disabled_at IS NULL AND (i.is_super OR EXISTS(
      SELECT 1 FROM myfin.memberships m WHERE m.company_id=co.id AND m.identity_id=i.id) OR EXISTS(
      SELECT 1 FROM myfin.workspace_memberships wm WHERE wm.workspace_id=co.workspace_id
        AND wm.identity_id=i.id AND wm.suspended_at IS NULL)) FOR KEY SHARE OF i`,[companyId,payerId])).rows[0];
  if(!row)v.fail(409,'expense_payer_not_found');
}

function normalizePayer(input, who) {
  const payer={sourceType:input.sourceType,paidByUserId:input.paidByUserId,paidByName:input.paidByName,
    pettyCashFundId:input.pettyCashFundId};
  if(payer.sourceType==='app_user'){
    payer.paidByUserId||=who.id;payer.paidByName='';
  }else payer.paidByUserId='';
  if(['non_user','other'].includes(payer.sourceType)&&!payer.paidByName)
    v.fail(400,'expense_payment_payer_required');
  if(payer.sourceType==='petty_cash'){
    if(!payer.pettyCashFundId)v.fail(400,'petty_cash_fund_required');
    payer.paidByName='';
  }else payer.pettyCashFundId='';
  return payer;
}

export async function recordExpensePayment(c, who, companyId, expenseId, raw, audit=async()=>{}, {
  requireWrite=true,now=new Date(),
}={}) {
  if(requireWrite)requireCapability(who,'expensePaymentsWrite');
  const input=v.parse(paymentSchema,raw),payer=normalizePayer(input,who);
  if(payer.sourceType==='petty_cash')requireCapability(who,'pettyCashManage');
  if(input.paidOn>businessDate(now))v.fail(400,'expense_payment_date_in_future');
  const requestDigest=hash({companyId,expenseId,...input,...payer});
  const expense=(await c.query(`SELECT * FROM myfin.expenses
    WHERE company_id=$1 AND id=$2 FOR UPDATE`,[companyId,expenseId])).rows[0];
  if(!expense)v.fail(404,'not_found');
  const replay=(await c.query(`SELECT id,request_digest,expense_id FROM myfin.expense_payment_events
    WHERE company_id=$1 AND idempotency_key=$2`,[companyId,input.idempotencyKey])).rows[0];
  if(replay){
    if(replay.request_digest!==requestDigest||replay.expense_id!==expenseId)v.fail(409,'expense_payment_idempotency_key_reused');
    return {payment:paymentOutput(await paymentRow(c,companyId,replay.id)),expense:expenseState(expense),replayed:true};
  }
  if(expense.voided_at)v.fail(409,'expense_voided');
  if(numeric(expense.version)!==input.expectedVersion)v.fail(409,'expense_changed');
  const amountSen=cents(input.amount),outstanding=numeric(expense.amount_sen)-numeric(expense.paid_amount_sen);
  if(amountSen>outstanding)v.fail(409,'expense_payment_exceeds_outstanding');
  if(payer.paidByUserId)await assertPayer(c,companyId,payer.paidByUserId);
  const id=randomUUID();
  await c.query(`INSERT INTO myfin.expense_payment_events(company_id,id,expense_id,event_type,amount_sen,
      source_type,paid_by_identity_id,paid_by_name,petty_cash_fund_id,reference,reason,
      idempotency_key,request_digest,actor_id,occurred_on)
    VALUES($1,$2,$3,'payment',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [companyId,id,expenseId,amountSen,payer.sourceType,payer.paidByUserId||null,payer.paidByName,
    payer.pettyCashFundId||null,input.reference,input.reason,input.idempotencyKey,requestDigest,who.id,input.paidOn]);
  if(payer.sourceType==='petty_cash')await insertEntry(c,who,companyId,payer.pettyCashFundId,{
    type:'expense_disbursement',amount:input.amount,reason:input.reason,
    idempotencyKey:`expense-${id}`,occurredAt:input.paidOn,reference:input.reference,
  },{internal:true,expenseId,expensePaymentId:id,now});
  const updated=(await c.query('SELECT * FROM myfin.expenses WHERE company_id=$1 AND id=$2',[companyId,expenseId])).rows[0];
  await recordExpenseEvent(c,companyId,who,{expenseId,expenseVersion:numeric(updated.version),
    action:'payment_recorded',from:expense,to:updated,reason:input.reason});
  await audit(c,who,companyId,'Record expense payment',`${expenseId} · RM ${input.amount.toFixed(2)} · ${payer.sourceType}`);
  return {payment:paymentOutput(await paymentRow(c,companyId,id)),expense:expenseState(updated),replayed:false};
}

export async function reverseExpensePayment(c, who, companyId, expenseId, paymentId, raw, audit=async()=>{}) {
  requireCapability(who,'expensePaymentsWrite');
  const input=v.parse(paymentReversalSchema,raw),requestDigest=hash({companyId,expenseId,paymentId,...input});
  const expense=(await c.query(`SELECT * FROM myfin.expenses
    WHERE company_id=$1 AND id=$2 FOR UPDATE`,[companyId,expenseId])).rows[0];
  if(!expense)v.fail(404,'not_found');
  const replay=(await c.query(`SELECT id,request_digest,expense_id FROM myfin.expense_payment_events
    WHERE company_id=$1 AND idempotency_key=$2`,[companyId,input.idempotencyKey])).rows[0];
  if(replay){
    if(replay.request_digest!==requestDigest||replay.expense_id!==expenseId)v.fail(409,'expense_payment_idempotency_key_reused');
    return {payment:paymentOutput(await paymentRow(c,companyId,replay.id)),expense:expenseState(expense),replayed:true};
  }
  if(expense.voided_at)v.fail(409,'expense_voided');
  if(numeric(expense.version)!==input.expectedVersion)v.fail(409,'expense_changed');
  const original=(await c.query(`SELECT * FROM myfin.expense_payment_events
    WHERE company_id=$1 AND expense_id=$2 AND id=$3 FOR UPDATE`,[companyId,expenseId,paymentId])).rows[0];
  if(!original)v.fail(404,'expense_payment_not_found');
  if(original.event_type!=='payment')v.fail(409,'expense_payment_not_reversible');
  if((await c.query(`SELECT 1 FROM myfin.expense_payment_events
    WHERE company_id=$1 AND reverses_event_id=$2`,[companyId,paymentId])).rowCount)
    v.fail(409,'expense_payment_already_reversed');
  const id=randomUUID(),reversalTiming=expensePaymentReversalTiming();
  await c.query(`INSERT INTO myfin.expense_payment_events(company_id,id,expense_id,event_type,amount_sen,
      source_type,paid_by_identity_id,paid_by_name,petty_cash_fund_id,reference,reason,
      reverses_event_id,idempotency_key,request_digest,actor_id,occurred_on)
    VALUES($1,$2,$3,'reversal',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
  [companyId,id,expenseId,original.amount_sen,original.source_type,original.paid_by_identity_id,
    original.paid_by_name,original.petty_cash_fund_id,original.reference,input.reason,paymentId,
    input.idempotencyKey,requestDigest,who.id,reversalTiming.occurredOn]);
  if(original.source_type==='petty_cash'){
    const ledger=(await c.query(`SELECT id FROM myfin.petty_cash_entries
      WHERE company_id=$1 AND expense_payment_event_id=$2`,[companyId,paymentId])).rows[0];
    if(!ledger)v.fail(409,'petty_cash_payment_entry_missing');
    const fund=await fundRow(c,companyId,original.petty_cash_fund_id,{lock:true});
    let fundReopened=false;
    if(fund.status==='closed'){
      await c.query(`UPDATE myfin.petty_cash_funds SET status='open',is_default=false,
        closed_at=NULL,closed_by=NULL,version=version+1,updated_at=now()
        WHERE company_id=$1 AND id=$2`,[companyId,original.petty_cash_fund_id]);
      await insertEntry(c,who,companyId,original.petty_cash_fund_id,{type:'reopen',
        reason:input.reason,idempotencyKey:`expense-reopen-${id}`,
        occurredAt:reversalTiming.occurredAt,reference:original.reference},
      {internal:true,bumpFund:false});
      fundReopened=true;
    }
    await insertEntry(c,who,companyId,original.petty_cash_fund_id,{type:'reversal',
      reversesEntryId:ledger.id,reason:input.reason,idempotencyKey:`expense-reversal-${id}`,
      occurredAt:reversalTiming.occurredAt,reference:original.reference},
    {internal:true,expenseId,expensePaymentId:id,allowExpenseReversal:true});
    if(fundReopened)await audit(c,who,companyId,'Reopen petty cash fund',
      `${original.petty_cash_fund_id} · expense payment correction ${paymentId}`);
  }
  const updated=(await c.query('SELECT * FROM myfin.expenses WHERE company_id=$1 AND id=$2',[companyId,expenseId])).rows[0];
  await recordExpenseEvent(c,companyId,who,{expenseId,expenseVersion:numeric(updated.version),
    action:'payment_reversed',from:expense,to:updated,reason:input.reason});
  await audit(c,who,companyId,'Reverse expense payment',`${expenseId} · ${paymentId} · ${input.reason}`);
  return {payment:paymentOutput(await paymentRow(c,companyId,id)),expense:expenseState(updated),replayed:false};
}

export function registerPettyCash(app,{scoped,audit}) {
  app.get('/api/companies/:company/petty-cash/options',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'expensesCreate');
    const rows=(await c.query(`SELECT f.id,f.name,f.is_default,f.low_balance_threshold_sen,
        coalesce(sum(e.signed_amount_sen),0)::bigint AS balance_sen
      FROM myfin.petty_cash_funds f LEFT JOIN myfin.petty_cash_entries e
        ON e.company_id=f.company_id AND e.fund_id=f.id
      WHERE f.company_id=$1 AND f.status='open'
      GROUP BY f.company_id,f.id ORDER BY f.is_default DESC,f.name,f.id`,[companyId])).rows;
    return {rows:rows.map(row=>({id:row.id,name:row.name,isDefault:Boolean(row.is_default),
      lowBalance:numeric(row.balance_sen)<=numeric(row.low_balance_threshold_sen)}))};
  }));
  app.get('/api/companies/:company/petty-cash/funds',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'pettyCashRead');
    const rows=(await c.query(`SELECT f.*,i.display_name AS created_by_name,
        coalesce(sum(e.signed_amount_sen),0)::bigint AS balance_sen,
        coalesce(max(e.amount_sen) FILTER (WHERE e.entry_type='opening_balance'),0)::bigint AS opening_balance_sen
      FROM myfin.petty_cash_funds f
      LEFT JOIN myfin.app_identities i ON i.id=f.created_by
      LEFT JOIN myfin.petty_cash_entries e ON e.company_id=f.company_id AND e.fund_id=f.id
      WHERE f.company_id=$1 GROUP BY f.company_id,f.id,i.display_name
      ORDER BY f.status,f.is_default DESC,f.name,f.id`,[companyId])).rows;
    return {rows:rows.map(fundOutput)};
  }));
  app.post('/api/companies/:company/petty-cash/funds',req=>scoped(req,(c,companyId)=>
    createPettyCashFund(c,req.identity,companyId,req.body,audit)));
  app.patch('/api/companies/:company/petty-cash/funds/:fundId',req=>scoped(req,(c,companyId)=>
    updatePettyCashFund(c,req.identity,companyId,v.parse(v.id,req.params.fundId),req.body,audit)));
  app.get('/api/companies/:company/petty-cash/funds/:fundId/entries',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'pettyCashRead');
    const fundId=v.parse(v.id,req.params.fundId),query=v.parse(z.strictObject({
      after:v.id.optional(),limit:z.coerce.number().int().min(1).max(500).default(200),
    }),req.query||{});
    const fund=await fundRow(c,companyId,fundId),params=[companyId,fundId],where=['e.company_id=$1','e.fund_id=$2'];
    if(query.after){params.push(query.after);where.push(`(e.created_at,e.id)<(
      SELECT cursor.created_at,cursor.id FROM myfin.petty_cash_entries cursor
      WHERE cursor.company_id=e.company_id AND cursor.fund_id=e.fund_id AND cursor.id=$${params.length}
    )`);}
    params.push(query.limit+1);
    const rows=(await c.query(`SELECT e.*,i.display_name AS actor_name FROM myfin.petty_cash_entries e
      LEFT JOIN myfin.app_identities i ON i.id=e.actor_id WHERE ${where.join(' AND ')}
      ORDER BY e.created_at DESC,e.id DESC LIMIT $${params.length}`,params)).rows;
    return {fund:fundOutput(fund),rows:rows.slice(0,query.limit).map(entryOutput),
      next:rows.length>query.limit?rows[query.limit-1].id:null};
  }));
  app.post('/api/companies/:company/petty-cash/funds/:fundId/entries',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'pettyCashManage');
    const result=await insertEntry(c,req.identity,companyId,v.parse(v.id,req.params.fundId),req.body);
    if(!result.replayed)await audit(c,req.identity,companyId,`Petty cash ${result.entry.type.replaceAll('_',' ')}`,
      `${result.fund.name} · ${result.entry.signedAmountSen} sen · ${result.entry.reason}`);
    return result;
  }));
  app.get('/api/companies/:company/expenses/:id/payments',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'expensesRead');
    const expenseId=v.parse(v.id,req.params.id),expense=(await c.query(`SELECT * FROM myfin.expenses
      WHERE company_id=$1 AND id=$2`,[companyId,expenseId])).rows[0];
    if(!expense)v.fail(404,'not_found');
    if(operator(req.identity)&&expense.created_by!==req.identity.id)v.fail(404,'not_found');
    const rows=(await c.query(`SELECT p.*,i.display_name AS actor_name,f.name AS petty_cash_fund_name,
        pe.id AS petty_cash_entry_id FROM myfin.expense_payment_events p
      LEFT JOIN myfin.app_identities i ON i.id=p.actor_id
      LEFT JOIN myfin.petty_cash_funds f ON f.company_id=p.company_id AND f.id=p.petty_cash_fund_id
      LEFT JOIN myfin.petty_cash_entries pe ON pe.company_id=p.company_id AND pe.expense_payment_event_id=p.id
      WHERE p.company_id=$1 AND p.expense_id=$2 ORDER BY p.created_at,p.id`,[companyId,expenseId])).rows;
    return {expense:expenseState(expense),rows:rows.map(paymentOutput)};
  }));
  app.post('/api/companies/:company/expenses/:id/payments',req=>scoped(req,(c,companyId)=>
    recordExpensePayment(c,req.identity,companyId,v.parse(v.id,req.params.id),req.body,audit)));
  app.post('/api/companies/:company/expenses/:id/payments/:paymentId/reverse',req=>scoped(req,(c,companyId)=>
    reverseExpensePayment(c,req.identity,companyId,v.parse(v.id,req.params.id),
      v.parse(v.id,req.params.paymentId),req.body,audit)));
}

export const pettyCashInternals=Object.freeze({
  hash,entrySchema,fundCreateSchema,fundPatchSchema,paymentSchema,paymentReversalSchema,
  insertEntry,expenseState,normalizePayer,pettyCashOccurrence,
});
