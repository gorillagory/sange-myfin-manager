import { z } from 'zod';
import { businessDate } from '../../src/domain/pos.js';
import { permissionsFor } from '../../src/domain/permissions.js';
import { operator, requireCapability } from './access.js';
import { expenseOutput } from './expense-lifecycle.js';
import * as v from './validation.js';

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const maximumRows = 50000;
const maximumClaimRows = 2000;
const maximumSpanDays = 3653;
const maxSafeSen = BigInt(Number.MAX_SAFE_INTEGER);
const minSafeSen = -maxSafeSen;
const paymentSources = ['legacy_unspecified','app_user','non_user','petty_cash','other','bank','card','credit'];
const statuses = ['draft','pending_payment','partially_paid','paid','overdue'];
const paymentSourceLabels = {legacy_unspecified:'Legacy / unspecified',app_user:'App user',non_user:'Non-user',
  petty_cash:'Petty cash',other:'Other',bank:'Bank',card:'Card',credit:'Credit'};
const legacyOpenStatuses = ['draft','pending','pending payment','pending_payment','unpaid','not paid','not_paid',
  'overdue','outstanding','due','partially paid','partially_paid'];

const querySchema = z.strictObject({
  from:z.string().regex(dayPattern).optional(),
  to:z.string().regex(dayPattern).optional(),
  grain:z.enum(['month','quarter','year']).default('month'),
  claimantId:v.id.optional(),
  category:z.string().trim().min(1).max(120).optional(),
  status:z.enum(statuses).optional(),
  paymentSource:z.enum(paymentSources).optional(),
});

const dateOnly = value => value instanceof Date ? value.toISOString().slice(0,10) : String(value || '').slice(0,10);
const utcDay = value => new Date(`${value}T00:00:00.000Z`);
const validDay = value => dayPattern.test(value) && Number.isFinite(utcDay(value).getTime())
  && utcDay(value).toISOString().slice(0,10) === value;
const addDays = (value, count) => new Date(utcDay(value).getTime()+count*86400000).toISOString().slice(0,10);
const dayDistance = (from, to) => Math.round((utcDay(to)-utcDay(from))/86400000);

export function expenseInsightsRange(raw = {}, now = new Date()) {
  const to=raw.to || businessDate(now), from=raw.from || addDays(to,-365), grain=raw.grain || 'month';
  const span=validDay(from)&&validDay(to)?dayDistance(from,to):NaN;
  if(!Number.isInteger(span)||span<0||span>maximumSpanDays)v.fail(400,'invalid_expense_insights_range');
  return {from,to,toExclusive:addDays(to,1),grain};
}

function safeSen(value) {
  let amount;
  try { amount=BigInt(value ?? 0); } catch { v.fail(500,'invalid_financial_total'); }
  if(amount>maxSafeSen||amount<minSafeSen)v.fail(422,'financial_total_too_large');
  return Number(amount);
}

function addSen(...values) {
  let total=0n;
  try { for(const value of values)total+=BigInt(value ?? 0); }
  catch { v.fail(500,'invalid_financial_total'); }
  if(total>maxSafeSen||total<minSafeSen)v.fail(422,'financial_total_too_large');
  return Number(total);
}

const scopeFor = (who, companyId) => ({
  mode:operator(who)?'self':'company',companyId,claimantFilterAllowed:!operator(who),
});

const paidAsOfSql = (alias, cutoff='$3') => `coalesce((SELECT sum(CASE
  WHEN as_of_payment.event_type='payment' THEN as_of_payment.amount_sen ELSE -as_of_payment.amount_sen END)
  FROM myfin.expense_payment_events as_of_payment
  WHERE as_of_payment.company_id=${alias}.company_id AND as_of_payment.expense_id=${alias}.id
    AND as_of_payment.occurred_on<=${cutoff}::date),0)`;

function statusSql(status, alias, asOf='$3') {
  if(!status)return '';
  const due=`${alias}.credit_due_date`;
  const paid=paidAsOfSql(alias,asOf),derived=`CASE
    WHEN ${alias}.status='draft' THEN 'draft'
    WHEN ${paid}>=${alias}.amount_sen THEN 'paid'
    WHEN ${paid}>0 THEN 'partially_paid'
    ELSE 'pending_payment' END`;
  if(status==='overdue')return `(${derived}) IN ('pending_payment','partially_paid') AND ${due}<${asOf}::date`;
  if(['pending_payment','partially_paid'].includes(status))
    return `(${derived})='${status}' AND (${due} IS NULL OR ${due}>=${asOf}::date)`;
  return `(${derived})='${status}'`;
}

function expensePredicates(args, who, filters, alias='e', {includePaymentSource=true,voided='current'}={}) {
  const predicates=[`${alias}.company_id=$1`];
  if(voided==='current')predicates.push(`${alias}.voided_at IS NULL`);
  if(voided==='as_of')predicates.push(`(${alias}.voided_at IS NULL
    OR (${alias}.voided_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date>$3::date)`);
  if(operator(who)){args.push(who.id);predicates.push(`${alias}.created_by=$${args.length}`);}
  if(filters.claimantId){
    if(operator(who)&&filters.claimantId!==who.id)v.fail(403,'expense_claimant_scope_denied');
    args.push(filters.claimantId);predicates.push(`${alias}.created_by=$${args.length}`);
  }
  if(filters.category){args.push(filters.category);predicates.push(`lower(coalesce(nullif(btrim(${alias}.data->>'category'),''),'General'))=lower($${args.length})`);}
  const status=statusSql(filters.status,alias);
  if(status)predicates.push(status);
  if(includePaymentSource&&filters.paymentSource){args.push(filters.paymentSource);predicates.push(`EXISTS(SELECT 1 FROM myfin.expense_payment_events source_event
    WHERE source_event.company_id=${alias}.company_id AND source_event.expense_id=${alias}.id
      AND source_event.source_type=$${args.length} AND source_event.occurred_on<=$3::date
    GROUP BY source_event.company_id,source_event.expense_id,source_event.source_type
    HAVING sum(CASE WHEN source_event.event_type='payment' THEN source_event.amount_sen ELSE -source_event.amount_sen END)>0)`);}
  return predicates;
}

function periodKey(day, grain) {
  const year=day.slice(0,4),month=Number(day.slice(5,7));
  if(grain==='year')return year;
  if(grain==='quarter')return `${year}-Q${Math.floor((month-1)/3)+1}`;
  return day.slice(0,7);
}

function periodBounds(key, grain, from, to) {
  let start,end;
  if(grain==='year'){start=`${key}-01-01`;end=`${key}-12-31`;}
  else if(grain==='quarter'){
    const [year,q]=key.split('-Q'),month=(Number(q)-1)*3+1;
    start=`${year}-${String(month).padStart(2,'0')}-01`;
    const nextMonth=month+3,next=nextMonth>12?`${Number(year)+1}-${String(nextMonth-12).padStart(2,'0')}-01`
      :`${year}-${String(nextMonth).padStart(2,'0')}-01`;
    end=addDays(next,-1);
  } else {
    start=`${key}-01`;const [year,month]=key.split('-').map(Number);
    const next=month===12?`${year+1}-01-01`:`${year}-${String(month+1).padStart(2,'0')}-01`;
    end=addDays(next,-1);
  }
  return {from:start<from?from:start,to:end>to?to:end};
}

function emptyPeriods(from,to,grain) {
  const rows=[],seen=new Set();
  for(let day=from;day<=to;day=addDays(day,1)){
    const key=periodKey(day,grain);if(seen.has(key))continue;seen.add(key);
    rows.push({key,label:key,...periodBounds(key,grain,from,to),claimCount:0,draftCount:0,draftSen:0,
      totalSen:0,paidSen:0,outstandingSen:0,cashOutSen:0});
  }
  return rows;
}

function claimantFor(row) {
  const imported=Boolean(row.imported_unattributed)||!row.created_by;
  return {id:imported?'':row.created_by,name:imported?'Imported / unattributed':(row.created_by_name||'Unattributed'),
    attribution:imported?'imported_unattributed':'recorded_user'};
}

function ageFor(day, asOf) { return Math.max(0,dayDistance(day,asOf)); }
function ageingKey(age, dueDate, asOf) {
  if(dueDate&&dueDate>asOf)return 'not_due';
  if(age<=7)return '0_7';if(age<=14)return '8_14';if(age<=30)return '15_30';if(age<=60)return '31_60';return '61_plus';
}
const ageingLabels={not_due:'Not due','0_7':'0–7 days','8_14':'8–14 days','15_30':'15–30 days','31_60':'31–60 days','61_plus':'61+ days'};
const descendingSen = (a,b) => a===b?0:a>b?-1:1;

function addGroup(map,key,base,totalSen,paidSen,outstandingSen,draft=false) {
  const row=map.get(key)||{...base,claimCount:0,draftCount:0,draftSen:0,totalSen:0,paidSen:0,outstandingSen:0};
  if(draft){row.draftCount+=1;row.draftSen=addSen(row.draftSen,totalSen);}
  else {
    row.claimCount+=1;
    row.totalSen=addSen(row.totalSen,totalSen);row.paidSen=addSen(row.paidSen,paidSen);
    row.outstandingSen=addSen(row.outstandingSen,outstandingSen);
  }
  map.set(key,row);
}

function expenseState(row, asOf) {
  const amountSen=safeSen(row.amount_sen),draft=row.status==='draft',
    paidSen=draft?0:Math.max(0,Math.min(amountSen,safeSen(row.paid_as_of_sen))),
    outstandingSen=draft?0:amountSen-paidSen,dueDate=dateOnly(row.credit_due_date);
  const baseStatus=draft?'draft':outstandingSen===0?'paid':paidSen>0?'partially_paid':'pending_payment';
  const status=!draft&&outstandingSen>0&&dueDate&&dueDate<asOf?'overdue':baseStatus;
  return {amountSen,draft,paidSen,outstandingSen,dueDate,status};
}

const legacyDateSql = alias => `left(${alias}.data->>'date',10)`;
const legacyValidDateSql = alias => `myfin.valid_expense_date(${legacyDateSql(alias)})`;
const legacyAmountSql = alias => `round(${alias}.total*100)::bigint`;
const legacyDueSql = alias => `myfin.valid_expense_date(left(${alias}.data->>'creditDueDate',10))`;
const legacyPaidDateSql = alias => `coalesce(myfin.valid_expense_date(left(${alias}.data->>'paidOn',10)),
  ${legacyValidDateSql(alias)})`;
const legacySourceSql = alias => `CASE
  WHEN lower(coalesce(${alias}.data->>'paidByType','')) IN ('legacy_unspecified','app_user','non_user','petty_cash','other','bank','card','credit')
    THEN lower(${alias}.data->>'paidByType')
  WHEN lower(coalesce(${alias}.data->>'paymentMethod','')) LIKE '%bank%' THEN 'bank'
  WHEN lower(coalesce(${alias}.data->>'paymentMethod','')) LIKE '%card%' THEN 'card'
  WHEN lower(coalesce(${alias}.data->>'paymentMethod','')) LIKE '%credit%' THEN 'credit'
  WHEN nullif(btrim(coalesce(${alias}.data->>'paymentMethod','')),'') IS NOT NULL THEN 'other'
  ELSE 'legacy_unspecified' END`;
const legacyPaidSql = (alias, asOf='$3') => `CASE
  WHEN lower(coalesce(${alias}.data->>'status','')) IN (${legacyOpenStatuses.map(value=>`'${value}'`).join(',')}) THEN 0::bigint
  WHEN ${legacyPaidDateSql(alias)}>${asOf}::date THEN 0::bigint
  WHEN coalesce(${alias}.data->>'paidAmountSen','') ~ '^[0-9]+$' THEN least(${legacyAmountSql(alias)},(${alias}.data->>'paidAmountSen')::numeric)::bigint
  ELSE ${legacyAmountSql(alias)} END`;
const legacyStatusSql = (alias, asOf='$3') => `CASE
  WHEN lower(coalesce(${alias}.data->>'status',''))='draft' THEN 'draft'
  WHEN ${legacyPaidSql(alias,asOf)}>=${legacyAmountSql(alias)} THEN 'paid'
  WHEN ${legacyPaidSql(alias,asOf)}>0 THEN 'partially_paid'
  ELSE 'pending_payment' END`;

function legacyStatusPredicate(status, alias='t') {
  if(!status)return '';
  const derived=legacyStatusSql(alias),due=legacyDueSql(alias);
  if(status==='overdue')return `(${derived}) IN ('pending_payment','partially_paid') AND ${due}<$3::date`;
  if(['pending_payment','partially_paid'].includes(status))
    return `(${derived})='${status}' AND (${due} IS NULL OR ${due}>=$3::date)`;
  return `(${derived})='${status}'`;
}

async function expenseRows(c, companyId, who, filters) {
  const args=[companyId,filters.from,filters.to],predicates=expensePredicates(args,who,filters,'e',{voided:'as_of'});
  predicates.push(`myfin.valid_expense_date(e.data->>'date') BETWEEN $2::date AND $3::date`);
  const rows=(await c.query(`SELECT e.*,i.display_name AS created_by_name,
      myfin.valid_expense_date(e.data->>'date') AS expense_date,
      (e.create_request_digest IS NULL OR e.created_by IS NULL) AS imported_unattributed,
      coalesce((SELECT sum(CASE WHEN p.event_type='payment' THEN p.amount_sen ELSE -p.amount_sen END)
        FROM myfin.expense_payment_events p WHERE p.company_id=e.company_id AND p.expense_id=e.id
          AND p.occurred_on<=$3::date),0)::bigint AS paid_as_of_sen
      ,(SELECT max(active_payment.occurred_on) FROM myfin.expense_payment_events active_payment
        WHERE active_payment.company_id=e.company_id AND active_payment.expense_id=e.id
          AND active_payment.event_type='payment' AND active_payment.occurred_on<=$3::date
          AND NOT EXISTS(SELECT 1 FROM myfin.expense_payment_events reversal
            WHERE reversal.company_id=active_payment.company_id
              AND reversal.reverses_event_id=active_payment.id AND reversal.occurred_on<=$3::date)) AS paid_as_of_on
    FROM myfin.expenses e LEFT JOIN myfin.app_identities i ON i.id=e.created_by
    WHERE ${predicates.join(' AND ')}
    ORDER BY expense_date,e.id LIMIT ${maximumRows+1}`,args)).rows;
  if(rows.length>maximumRows)v.fail(413,'expense_insights_too_large');
  return rows;
}

const legacyVisible = (who, filters) => !operator(who)&&!filters.claimantId;

async function legacyExpenseRows(c, companyId, who, filters) {
  if(!legacyVisible(who,filters))return [];
  const args=[companyId,filters.from,filters.to],predicates=[
    `t.company_id=$1`,`t.document_state='legacy'`,`t.data->>'type' IN ('Expense','Payment Voucher')`,
    `coalesce(t.data->>'status','')<>'Voided'`,
    `${legacyDateSql('t')} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
    `${legacyValidDateSql('t')} IS NOT NULL`,
    `${legacyDateSql('t')} BETWEEN $2 AND $3`,
  ];
  if(filters.category){args.push(filters.category);predicates.push(
    `lower(coalesce(nullif(btrim(t.data->>'category'),''),'General'))=lower($${args.length})`);}
  const status=legacyStatusPredicate(filters.status);if(status)predicates.push(status);
  if(filters.paymentSource){args.push(filters.paymentSource);predicates.push(`${legacySourceSql('t')}=$${args.length}`);}
  const rows=(await c.query(`SELECT t.id,t.data,${legacyValidDateSql('t')} AS expense_date,
      ${legacyAmountSql('t')} AS amount_sen,${legacyPaidSql('t')} AS paid_as_of_sen,
      ${legacyPaidDateSql('t')} AS paid_as_of_on,${legacyDueSql('t')} AS credit_due_date,
      ${legacyStatusSql('t')} AS status,${legacySourceSql('t')} AS source_type
    FROM myfin.transactions t WHERE ${predicates.join(' AND ')}
    ORDER BY expense_date,t.id LIMIT ${maximumRows+1}`,args)).rows;
  if(rows.length>maximumRows)v.fail(413,'expense_insights_too_large');
  return rows.map(row=>{
    const amountSen=safeSen(row.amount_sen),paidSen=Math.max(0,Math.min(amountSen,safeSen(row.paid_as_of_sen)));
    const source=row.source_type||'legacy_unspecified';
    return {...row,id:`legacy:${row.id}`,source_id:row.id,legacy_transaction:true,created_by:null,
      created_by_name:null,imported_unattributed:true,report_links:[],
      report_payment_sources:paidSen>0?[{type:source,label:paymentSourceLabels[source]||source,amountSen:paidSen}]:[]};
  });
}

const linkLabel = row => {
  if(row.link_type==='stock_item')return row.stock_item_name||row.stock_item_id;
  if(row.link_type==='stock_movement')return row.movement_item_name
    ? `${row.movement_item_name}${row.movement_kind?` · ${row.movement_kind}`:''}` : row.stock_ledger_id;
  if(row.link_type==='purchase_order')return row.purchase_order_number||row.purchase_order_id;
  const reference=row.goods_receipt_reference||row.goods_receipt_id;
  return row.receipt_order_number?`${reference} · ${row.receipt_order_number}`:reference;
};

async function reportDetails(c, companyId, rows, who, asOf) {
  if(!rows.length)return rows;
  const expenseIds=rows.map(row=>row.id),sources=new Map(expenseIds.map(id=>[id,[]]));
  const sourceRows=(await c.query(`SELECT p.expense_id,p.source_type,
      sum(CASE WHEN p.event_type='payment' THEN p.amount_sen ELSE -p.amount_sen END)::bigint AS net_sen
    FROM myfin.expense_payment_events p
    WHERE p.company_id=$1 AND p.expense_id=ANY($2::text[]) AND p.occurred_on<=$3::date
    GROUP BY p.expense_id,p.source_type
    HAVING sum(CASE WHEN p.event_type='payment' THEN p.amount_sen ELSE -p.amount_sen END)>0
    ORDER BY p.expense_id,p.source_type`,[companyId,expenseIds,asOf])).rows;
  for(const row of sourceRows)sources.get(row.expense_id)?.push({type:row.source_type,
    label:paymentSourceLabels[row.source_type]||row.source_type,amountSen:safeSen(row.net_sen)});

  const permissions=permissionsFor(who),visibleTypes=['stock_item'];
  if(permissions.stockHistoryRead)visibleTypes.push('stock_movement');
  if(permissions.costsRead)visibleTypes.push('purchase_order','goods_receipt');
  const links=new Map(expenseIds.map(id=>[id,[]]));
  const linkRows=(await c.query(`SELECT * FROM (SELECT el.expense_id,el.link_type,el.stock_item_id,el.stock_ledger_id,
        el.purchase_order_id,el.goods_receipt_id,si.name AS stock_item_name,sl.kind AS movement_kind,
        msi.name AS movement_item_name,po.number AS purchase_order_number,gr.reference AS goods_receipt_reference,
        rpo.number AS receipt_order_number,
        row_number() OVER(PARTITION BY el.expense_id ORDER BY el.link_type,el.created_at,el.id) AS position
      FROM myfin.expense_links el
      LEFT JOIN myfin.stock_items si ON si.company_id=el.company_id AND si.id=el.stock_item_id
      LEFT JOIN myfin.stock_ledger sl ON sl.company_id=el.company_id AND sl.id=el.stock_ledger_id
      LEFT JOIN myfin.stock_items msi ON msi.company_id=sl.company_id AND msi.id=sl.item_id
      LEFT JOIN myfin.purchase_orders po ON po.company_id=el.company_id AND po.id=el.purchase_order_id
      LEFT JOIN myfin.goods_receipts gr ON gr.company_id=el.company_id AND gr.id=el.goods_receipt_id
      LEFT JOIN myfin.purchase_orders rpo ON rpo.company_id=gr.company_id AND rpo.id=gr.purchase_order_id
      WHERE el.company_id=$1 AND el.expense_id=ANY($2::text[]) AND el.link_type=ANY($3::text[])
    ) visible_link WHERE position<=10 ORDER BY expense_id,position`,[companyId,expenseIds,visibleTypes])).rows;
  for(const row of linkRows)links.get(row.expense_id)?.push({type:row.link_type,label:linkLabel(row)||'Linked record'});
  return rows.map(row=>({...row,report_payment_sources:sources.get(row.id)||[],report_links:links.get(row.id)||[]}));
}

const byExpenseDate = (a,b) => dateOnly(a.expense_date).localeCompare(dateOnly(b.expense_date))
  || String(a.id).localeCompare(String(b.id));

async function reportExpenseRows(c, companyId, who, filters) {
  const canonical=await expenseRows(c,companyId,who,filters),legacy=await legacyExpenseRows(c,companyId,who,filters);
  const rows=[...canonical,...legacy].sort(byExpenseDate);
  if(rows.length>maximumRows)v.fail(413,'expense_insights_too_large');
  const claimCanonical=rows.slice(0,maximumClaimRows).filter(row=>!row.legacy_transaction);
  const detailed=await reportDetails(c,companyId,claimCanonical,who,filters.to);
  const detailsById=new Map(detailed.map(row=>[row.id,row]));
  return rows.map(row=>detailsById.get(row.id)||row);
}

async function cashRows(c, companyId, who, filters) {
  const args=[companyId,filters.from,filters.to],predicates=expensePredicates(args,who,filters,'e',{
    includePaymentSource:false,voided:'include'});
  predicates.push(`p.occurred_on BETWEEN $2::date AND $3::date`);
  if(filters.paymentSource){
    args.push(filters.paymentSource);predicates.push(`p.source_type=$${args.length}`);
  }
  const canonical=(await c.query(`SELECT p.occurred_on,p.source_type,
      count(*) FILTER(WHERE p.event_type='payment')::int AS payment_count,
      sum(CASE WHEN p.event_type='payment' THEN p.amount_sen ELSE -p.amount_sen END)::bigint AS net_sen
    FROM myfin.expense_payment_events p JOIN myfin.expenses e
      ON e.company_id=p.company_id AND e.id=p.expense_id
    WHERE ${predicates.join(' AND ')}
    GROUP BY p.occurred_on,p.source_type ORDER BY p.occurred_on,p.source_type`,args)).rows;
  if(!legacyVisible(who,filters))return canonical;
  const legacyArgs=[companyId,filters.from,filters.to],legacyPredicates=[
    `t.company_id=$1`,`t.document_state='legacy'`,`t.data->>'type' IN ('Expense','Payment Voucher')`,
    `coalesce(t.data->>'status','')<>'Voided'`,
    `${legacyDateSql('t')} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
    `${legacyValidDateSql('t')} IS NOT NULL`,
    `${legacyPaidSql('t')}>0`,`${legacyPaidDateSql('t')} BETWEEN $2::date AND $3::date`,
  ];
  if(filters.category){legacyArgs.push(filters.category);legacyPredicates.push(
    `lower(coalesce(nullif(btrim(t.data->>'category'),''),'General'))=lower($${legacyArgs.length})`);}
  const legacyStatus=legacyStatusPredicate(filters.status);if(legacyStatus)legacyPredicates.push(legacyStatus);
  if(filters.paymentSource){legacyArgs.push(filters.paymentSource);
    legacyPredicates.push(`${legacySourceSql('t')}=$${legacyArgs.length}`);}
  const legacy=(await c.query(`SELECT ${legacyPaidDateSql('t')} AS occurred_on,${legacySourceSql('t')} AS source_type,
      count(*)::int AS payment_count,sum(${legacyPaidSql('t')})::bigint AS net_sen
    FROM myfin.transactions t WHERE ${legacyPredicates.join(' AND ')}
    GROUP BY ${legacyPaidDateSql('t')},${legacySourceSql('t')}
    ORDER BY occurred_on,source_type`,legacyArgs)).rows;
  return [...canonical,...legacy];
}

async function pettyCashSummary(c, companyId, who, filters, cash) {
  const claimDisbursementSen=cash.filter(row=>row.source_type==='petty_cash').reduce((sum,row)=>addSen(sum,row.net_sen),0);
  if(operator(who))return {restricted:true,claimDisbursementSen};
  const rows=(await c.query(`SELECT f.id,f.name,f.status,f.currency_code,
      coalesce(sum(e.signed_amount_sen),0)::bigint AS balance_sen,
      coalesce(sum(e.signed_amount_sen) FILTER(WHERE e.entry_type='opening_balance'),0)::bigint AS opening_balance_sen,
      coalesce(sum(abs(e.signed_amount_sen)) FILTER(WHERE e.entry_type='replenishment'
        AND (e.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date BETWEEN $2::date AND $3::date),0)::bigint AS replenishment_sen,
      coalesce(sum(abs(e.signed_amount_sen)) FILTER(WHERE e.entry_type='expense_disbursement'
        AND (e.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date BETWEEN $2::date AND $3::date),0)::bigint AS disbursement_sen,
      coalesce(sum(e.signed_amount_sen) FILTER(WHERE e.entry_type IN ('adjustment_in','adjustment_out')
        AND (e.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date BETWEEN $2::date AND $3::date),0)::bigint AS adjustment_sen,
      coalesce(sum(e.signed_amount_sen) FILTER(WHERE e.entry_type='reconciliation'
        AND (e.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date BETWEEN $2::date AND $3::date),0)::bigint AS count_sen,
      coalesce(sum(e.signed_amount_sen) FILTER(WHERE e.entry_type='reversal'
        AND (e.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date BETWEEN $2::date AND $3::date),0)::bigint AS reversal_sen
    FROM myfin.petty_cash_funds f LEFT JOIN myfin.petty_cash_entries e
      ON e.company_id=f.company_id AND e.fund_id=f.id
        AND (e.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date<=$3::date
    WHERE f.company_id=$1
      AND (f.opened_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date<=$3::date
    GROUP BY f.id,f.name,f.status,f.currency_code ORDER BY f.name,f.id LIMIT 101`,
  [companyId,filters.from,filters.to])).rows;
  if(rows.length>100)v.fail(413,'expense_petty_cash_funds_too_large');
  return {restricted:false,claimDisbursementSen,funds:rows.map(row=>({
    id:row.id,name:row.name,status:row.status,currency:row.currency_code,
    balanceSen:safeSen(row.balance_sen),openingBalanceSen:safeSen(row.opening_balance_sen),
    replenishmentSen:safeSen(row.replenishment_sen),disbursementSen:safeSen(row.disbursement_sen),
    adjustmentSen:safeSen(row.adjustment_sen),countSen:safeSen(row.count_sen),reversalSen:safeSen(row.reversal_sen),
  }))};
}

function insightsOutput(expenses,cash,filters,scope,pettyCash) {
  const periods=emptyPeriods(filters.from,filters.to,filters.grain),periodMap=new Map(periods.map(row=>[row.key,row]));
  const categories=new Map(),claimants=new Map();
  const ageing=new Map(Object.entries(ageingLabels).map(([key,label])=>[key,{key,label,claimCount:0,outstandingSen:0}]));
  const oldest=[];let totalSen=0,paidSen=0,outstandingSen=0,draftCount=0,draftSen=0,
    overdueCount=0,overdueSen=0,evidenceCount=0;
  const claims=[];
  for(const row of expenses){
    const {amountSen:amount,draft,paidSen:paid,outstandingSen:outstanding,dueDate:due,status}=expenseState(row,filters.to);
    const day=dateOnly(row.expense_date),claimant=claimantFor(row),category=String(row.data?.category||'General').trim()||'General';
    if(draft){draftCount+=1;draftSen=addSen(draftSen,amount);}
    else {totalSen=addSen(totalSen,amount);paidSen=addSen(paidSen,paid);outstandingSen=addSen(outstandingSen,outstanding);}
    if(!draft&&(row.data?.receiptPath||row.data?.receiptUrl||row.data?.attachmentPath||row.data?.attachmentUrl))evidenceCount+=1;
    const period=periodMap.get(periodKey(day,filters.grain));
    if(period){if(draft){period.draftCount+=1;period.draftSen=addSen(period.draftSen,amount);}
      else {period.claimCount+=1;period.totalSen=addSen(period.totalSen,amount);period.paidSen=addSen(period.paidSen,paid);
        period.outstandingSen=addSen(period.outstandingSen,outstanding);}}
    addGroup(categories,category,{key:category,label:category},amount,paid,outstanding,draft);
    addGroup(claimants,`${claimant.attribution}:${claimant.id}`,claimant,amount,paid,outstanding,draft);
    const evidence=Boolean(row.data?.receiptPath||row.data?.receiptUrl||row.data?.attachmentPath||row.data?.attachmentUrl);
    const claimReportAvailable=!row.legacy_transaction&&!row.voided_at;
    if(claims.length<maximumClaimRows)claims.push({id:row.id,sourceId:row.source_id||row.id,
      recordType:row.legacy_transaction?'legacy_transaction':'expense',claimReportAvailable,
      reference:row.data?.number||row.data?.reference||row.source_id||row.id,date:day,
      description:String(row.data?.description||row.data?.payee||'Expense'),category,
      payee:String(row.data?.supplierName||row.data?.payee||''),draft,status,amountSen:amount,paidSen:paid,
      outstandingSen:outstanding,dueDate:due,paidDate:dateOnly(row.paid_as_of_on),
      evidence:evidence?'Attached':'Missing',claimantId:claimant.id,claimantName:claimant.name,
      claimantAttribution:claimant.attribution,paymentSources:row.report_payment_sources||[],links:row.report_links||[]});
    if(!draft&&outstanding>0){
      const basis=due||day,age=ageFor(basis,filters.to),key=ageingKey(age,due,filters.to),bucket=ageing.get(key);
      bucket.claimCount+=1;bucket.outstandingSen=addSen(bucket.outstandingSen,outstanding);
      const overdue=Boolean(due&&due<filters.to);if(overdue){overdueCount+=1;overdueSen=addSen(overdueSen,outstanding);}
      oldest.push({expenseId:row.id,reference:row.data?.number||row.data?.reference||row.id,date:day,dueDate:due,
        recordType:row.legacy_transaction?'legacy_transaction':'expense',claimReportAvailable,
        claimantId:claimant.id,claimantName:claimant.name,category,totalSen:amount,paidSen:paid,
        outstandingSen:outstanding,ageDays:age,ageingKey:key});
    }
  }
  const sources=new Map();let cashOutSen=0;
  for(const row of cash){
    const net=safeSen(row.net_sen),key=row.source_type||'legacy_unspecified';cashOutSen=addSen(cashOutSen,net);
    const source=sources.get(key)||{key,label:paymentSourceLabels[key]||key.replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase()),paymentCount:0,netSen:0};
    source.paymentCount+=Number(row.payment_count||0);source.netSen=addSen(source.netSen,net);sources.set(key,source);
    const period=periodMap.get(periodKey(dateOnly(row.occurred_on),filters.grain));if(period)period.cashOutSen=addSen(period.cashOutSen,net);
  }
  const pettyCashSen=[...sources.values()].find(row=>row.key==='petty_cash')?.netSen||0;
  return {from:filters.from,to:filters.to,grain:filters.grain,scope,
    summary:{claimCount:expenses.length-draftCount,draftCount,draftSen,totalSen,paidSen,outstandingSen,cashOutSen,
      overdueCount,overdueSen,evidenceCount,pettyCashSen},
    periods,ageing:[...ageing.values()],categories:[...categories.values()].sort((a,b)=>descendingSen(a.totalSen,b.totalSen)||a.label.localeCompare(b.label)),
    claimants:[...claimants.values()].sort((a,b)=>descendingSen(a.totalSen,b.totalSen)||a.name.localeCompare(b.name)),
    paymentSources:[...sources.values()].sort((a,b)=>descendingSen(a.netSen,b.netSen)||a.label.localeCompare(b.label)),pettyCash,
    claims,claimsLimited:expenses.length>maximumClaimRows,claimsReturned:claims.length,claimLimit:maximumClaimRows,
    oldestOutstanding:oldest.sort((a,b)=>b.ageDays-a.ageDays||descendingSen(a.outstandingSen,b.outstandingSen)
      ||a.expenseId.localeCompare(b.expenseId)).slice(0,20)};
}

const paymentOutput = row => ({
  id:row.id,eventType:row.event_type,amountSen:safeSen(row.amount_sen),
  signedAmountSen:row.event_type==='reversal'?-safeSen(row.amount_sen):safeSen(row.amount_sen),
  sourceType:row.source_type,paidByUserId:row.paid_by_identity_id||'',
  paidByName:row.paid_by_name||row.paid_by_display_name||'',
  pettyCashFundId:row.petty_cash_fund_id||'',pettyCashFundName:row.petty_cash_fund_name||'',
  reference:row.reference||'',reason:row.reason||'',reversesPaymentId:row.reverses_event_id||'',
  paidOn:dateOnly(row.occurred_on),createdAt:row.created_at,actorId:row.actor_id||'',actorName:row.actor_name||'',
});

export function registerExpenseAnalytics(app,{scoped}) {
  app.get('/api/companies/:company/expense-insights',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'expenseReportsRead');
    const parsed=v.parse(querySchema,req.query),range=expenseInsightsRange(parsed),filters={...parsed,...range};
    if(operator(req.identity)&&filters.claimantId&&filters.claimantId!==req.identity.id)v.fail(403,'expense_claimant_scope_denied');
    const expenses=await reportExpenseRows(c,companyId,req.identity,filters);
    const cash=await cashRows(c,companyId,req.identity,filters);
    const pettyCash=await pettyCashSummary(c,companyId,req.identity,filters,cash);
    return insightsOutput(expenses,cash,filters,scopeFor(req.identity,companyId),pettyCash);
  },false,{isolation:'repeatable_read'}));

  app.get('/api/companies/:company/expenses/:id/claim-report',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'expenseReportsRead');
    const id=v.parse(v.id,req.params.id),args=[companyId,id],predicates=['e.company_id=$1','e.id=$2','e.voided_at IS NULL'];
    if(operator(req.identity)){args.push(req.identity.id);predicates.push(`e.created_by=$${args.length}`);}
    const row=(await c.query(`SELECT e.* FROM myfin.expenses e WHERE ${predicates.join(' AND ')}`,args)).rows[0];
    if(!row)v.fail(404,'not_found');
    const expense=(await expenseOutput(c,companyId,[row],req.identity))[0];
    const payments=(await c.query(`SELECT p.*,actor.display_name AS actor_name,payer.display_name AS paid_by_display_name,
        f.name AS petty_cash_fund_name
      FROM myfin.expense_payment_events p
      LEFT JOIN myfin.app_identities actor ON actor.id=p.actor_id
      LEFT JOIN myfin.app_identities payer ON payer.id=p.paid_by_identity_id
      LEFT JOIN myfin.petty_cash_funds f ON f.company_id=p.company_id AND f.id=p.petty_cash_fund_id
      WHERE p.company_id=$1 AND p.expense_id=$2 ORDER BY p.occurred_on,p.created_at,p.id`,[companyId,id])).rows.map(paymentOutput);
    const events=(await c.query(`SELECT ev.*,actor.display_name AS actor_name FROM myfin.expense_events ev
      LEFT JOIN myfin.app_identities actor ON actor.id=ev.actor_id
      WHERE ev.company_id=$1 AND ev.expense_id=$2 ORDER BY ev.expense_version,ev.created_at,ev.id`,[companyId,id])).rows.map(event=>({
        id:event.id,expenseVersion:Number(event.expense_version),action:event.action,from:event.from_lifecycle,to:event.to_lifecycle,
        reason:event.reason||'',actorId:event.actor_id,actorName:event.actor_name||'',createdAt:event.created_at,
      }));
    const context=(await c.query(`SELECT c.id AS company_id,c.name AS company_name,c.data AS company_data,
        w.id AS workspace_id,w.name AS workspace_name
      FROM myfin.companies c JOIN myfin.workspaces w ON w.id=c.workspace_id WHERE c.id=$1`,[companyId])).rows[0]||{};
    const companyData=context.company_data||{};
    return {expense,payments,events,scope:scopeFor(req.identity,companyId),generatedAt:new Date().toISOString(),
      company:{id:companyId,name:context.company_name||companyData.name||'Company',registration:companyData.registration||'',
        address:companyData.address||'',currency:companyData.preferences?.currency||companyData.currency||'RM'},
      workspace:{id:context.workspace_id||'',name:context.workspace_name||'Workspace'}};
  },false,{isolation:'repeatable_read'}));
}
