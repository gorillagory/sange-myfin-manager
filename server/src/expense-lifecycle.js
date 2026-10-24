import { randomUUID } from 'node:crypto';
import { businessDate, cents } from '../../src/domain/pos.js';
import { effectiveExpenseStatus, normalizeExpenseLifecycle } from '../../src/domain/expenseLifecycle.js';
import { permissionsFor } from '../../src/domain/permissions.js';
import { operator } from './access.js';
import * as v from './validation.js';

export async function activeExpenseSettlementDate(c,companyId,expenseId){
  const row=(await c.query(`SELECT to_char(max(p.occurred_on),'YYYY-MM-DD') AS paid_on
    FROM myfin.expense_payment_events p
    WHERE p.company_id=$1 AND p.expense_id=$2 AND p.event_type='payment'
      AND NOT EXISTS(SELECT 1 FROM myfin.expense_payment_events r
        WHERE r.company_id=p.company_id AND r.reverses_event_id=p.id)`,[companyId,expenseId])).rows[0];
  return row?.paid_on||'';
}

const linkColumn = Object.freeze({
  stock_item: 'stock_item_id',
  stock_movement: 'stock_ledger_id',
  purchase_order: 'purchase_order_id',
  goods_receipt: 'goods_receipt_id',
});

const outputDate = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
const lifecycleField=(record,column,key)=>record?.[column]??record?.[key]??record?.data?.[key]??'';
const auditDate=value=>outputDate(value)||'—';

// Once an expense has payment events, these fields describe immutable evidence.
// Edits may still change ordinary expense details, but changing how a payment was
// sourced must go through the payment/reversal workflow so the evidence balances.
export function lockRecordedPaymentLifecycle(input = {}, record = {}) {
  const column=(name,key,fallback='')=>Object.prototype.hasOwnProperty.call(record,name)
    ? record[name] : record?.[key]??record?.data?.[key]??fallback;
  const locked={
    status:String(column('status','status','paid')||'paid').toLowerCase()==='pending'
      ? 'pending_payment' : String(column('status','status','paid')||'paid').toLowerCase(),
    paidByType:String(column('paid_by_type','paidByType','legacy_unspecified')||'legacy_unspecified'),
    paidByUserId:String(column('paid_by_identity_id','paidByUserId','')||''),
    paidByName:String(column('paid_by_name','paidByName','')||''),
    pettyCashFundId:String(column('petty_cash_fund_id','pettyCashFundId','')||''),
    creditTermsDays:column('credit_terms_days','creditTermsDays',null)==null
      ? null : Number(column('credit_terms_days','creditTermsDays',null)),
    creditDueDate:outputDate(column('credit_due_date','creditDueDate','')),
    paidOn:outputDate(column('paid_on','paidOn','')),
  };
  const requested={
    status:String(input.status||'paid').toLowerCase()==='pending'?'pending_payment':String(input.status||'paid').toLowerCase(),
    paidByType:String(input.paidByType||'other'),
    paidByUserId:String(input.paidByUserId||''),
    paidByName:String(input.paidByName||''),
    pettyCashFundId:String(input.pettyCashFundId||''),
    creditTermsDays:input.creditTermsDays==null||input.creditTermsDays===''?null:Number(input.creditTermsDays),
    creditDueDate:outputDate(input.creditDueDate),
    paidOn:outputDate(input.paidOn),
  };
  return {
    input:{...input,...locked},
    locked,
    changedFields:Object.keys(locked).filter(key=>requested[key]!==locked[key]),
  };
}

export function expenseAuditDetail(id, previous, next, { voided = false } = {}) {
  const priorStatus=previous?(previous.voided_at?'voided':lifecycleField(previous,'status','status')||'paid'):'created';
  const nextStatus=voided?'voided':lifecycleField(next,'status','status')||priorStatus;
  const priorPayer=previous?lifecycleField(previous,'paid_by_type','paidByType')||'legacy_unspecified':'—';
  const nextPayer=lifecycleField(next,'paid_by_type','paidByType')||priorPayer;
  const priorDue=previous?auditDate(lifecycleField(previous,'credit_due_date','creditDueDate')):'—';
  const nextDue=auditDate(lifecycleField(next,'credit_due_date','creditDueDate'));
  const priorPaid=previous?auditDate(lifecycleField(previous,'paid_on','paidOn')):'—';
  const nextPaid=auditDate(lifecycleField(next,'paid_on','paidOn'));
  return `${id} · status ${priorStatus} → ${nextStatus} · payer ${priorPayer} → ${nextPayer} · due ${priorDue} → ${nextDue} · paid ${priorPaid} → ${nextPaid}`;
}

export function expenseLifecycleSnapshot(record = {}) {
  const amountSen=record.amount_sen??record.amountSen??cents(record.amount??record.data?.amount??0);
  const paidAmountSen=record.paid_amount_sen??record.paidAmountSen??record.data?.paidAmountSen??
    ((record.status??record.data?.status)==='paid'?amountSen:0);
  const status=record.voided_at?'voided':lifecycleField(record,'status','status')||'paid';
  return {
    status,
    effectiveStatus:record.voided_at?'voided':effectiveExpenseStatus({status,
      creditDueDate:lifecycleField(record,'credit_due_date','creditDueDate')}),
    paidByType:lifecycleField(record,'paid_by_type','paidByType')||'legacy_unspecified',
    paidByUserId:lifecycleField(record,'paid_by_identity_id','paidByUserId')||'',
    paidByName:lifecycleField(record,'paid_by_name','paidByName')||'',
    amountSen:Number(amountSen),paidAmountSen:Number(paidAmountSen),
    outstandingAmountSen:Number(amountSen)-Number(paidAmountSen),expenseDate:outputDate(record.data?.date??record.date),
    creditTermsDays:Number(lifecycleField(record,'credit_terms_days','creditTermsDays')||0)||null,
    creditDueDate:outputDate(lifecycleField(record,'credit_due_date','creditDueDate')),
    paidOn:outputDate(lifecycleField(record,'paid_on','paidOn')),
    pettyCashFundId:lifecycleField(record,'petty_cash_fund_id','pettyCashFundId')||'',
    voided:Boolean(record.voided_at),
  };
}

export async function recordExpenseEvent(c, companyId, who, {
  expenseId, expenseVersion, action, from = null, to, reason = '',
}) {
  await c.query(`INSERT INTO myfin.expense_events(company_id,id,expense_id,expense_version,action,
    from_lifecycle,to_lifecycle,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [companyId,randomUUID(),expenseId,expenseVersion,action,from?expenseLifecycleSnapshot(from):{},
    expenseLifecycleSnapshot(to),String(reason||'').trim().slice(0,1000),who.id]);
}

async function assertPayer(c, companyId, who, payerId) {
  if (!payerId) return;
  if (operator(who) && payerId !== who.id) v.fail(403, 'expense_payer_restricted');
  const result = await c.query(`SELECT i.id FROM myfin.app_identities i
    JOIN myfin.companies co ON co.id=$1
    WHERE i.id=$2 AND i.disabled_at IS NULL AND (
      i.is_super
      OR EXISTS(SELECT 1 FROM myfin.memberships m
        WHERE m.company_id=co.id AND m.identity_id=i.id)
      OR EXISTS(SELECT 1 FROM myfin.workspace_memberships wm
        WHERE wm.workspace_id=co.workspace_id AND wm.identity_id=i.id AND wm.suspended_at IS NULL)
    ) FOR KEY SHARE OF i`, [companyId, payerId]);
  if (!result.rowCount) v.fail(409, 'expense_payer_not_found');
}

async function assertLinkTargets(c, companyId, who, expenseId, links) {
  const permissions=permissionsFor(who),existing=new Set();
  if(expenseId){
    const rows=(await c.query(`SELECT link_type,coalesce(stock_item_id,stock_ledger_id,purchase_order_id,goods_receipt_id) AS target_id
      FROM myfin.expense_links WHERE company_id=$1 AND expense_id=$2`,[companyId,expenseId])).rows;
    for(const row of rows)existing.add(`${row.link_type}\u0000${row.target_id}`);
  }
  for(const link of links){
    const preserved=existing.has(`${link.type}\u0000${link.id}`);
    if(link.type==='stock_movement'&&!permissions.stockHistoryRead&&!preserved)v.fail(403,'expense_stock_movement_restricted');
    if(['purchase_order','goods_receipt'].includes(link.type)&&!permissions.costsRead&&!preserved)v.fail(403,'expense_procurement_link_restricted');
  }
  const specs = {
    stock_item: ['myfin.stock_items', 'id'],
    stock_movement: ['myfin.stock_ledger', 'id'],
    purchase_order: ['myfin.purchase_orders', 'id'],
    goods_receipt: ['myfin.goods_receipts', 'id'],
  };
  for (const [type, [table, column]] of Object.entries(specs)) {
    const ids = links.filter(link => link.type === type).map(link => link.id);
    if (!ids.length) continue;
    const result = await c.query(`SELECT ${column} FROM ${table}
      WHERE company_id=$1 AND ${column}=ANY($2::text[])`, [companyId, ids]);
    if (result.rowCount !== ids.length) v.fail(409, `expense_${type}_not_found`);
  }
}

export async function prepareExpense(c, companyId, who, parsed, {
  allowLegacy = false, allowRecordedPaymentState = false, defaultPaidOn = '', existingPettyCashFundId = '',
} = {}) {
  let lifecycle;
  const candidate=(parsed.status||'paid')==='paid'&&!parsed.paidOn&&defaultPaidOn?{...parsed,paidOn:defaultPaidOn}:parsed;
  try { lifecycle = normalizeExpenseLifecycle(candidate, {
    actorId:who.id, allowLegacy, allowRecordedPaymentState, today:businessDate(),
  }); }
  catch (error) { v.fail(400, error.message); }
  const amountSen = cents(parsed.amount);
  if (amountSen <= 0 || amountSen / 100 !== parsed.amount) v.fail(400, 'invalid_expense_amount');
  await assertPayer(c, companyId, who, lifecycle.paidByUserId);
  if(lifecycle.pettyCashFundId){
    const fund=await c.query(`SELECT id,status FROM myfin.petty_cash_funds
      WHERE company_id=$1 AND id=$2 FOR KEY SHARE`,[companyId,lifecycle.pettyCashFundId]);
    if(!fund.rowCount)v.fail(409,'petty_cash_fund_not_found');
    if(fund.rows[0].status!=='open'&&lifecycle.pettyCashFundId!==existingPettyCashFundId)
      v.fail(409,'petty_cash_fund_closed');
  }
  await assertLinkTargets(c, companyId, who, parsed.id, lifecycle.links);
  const { links, version, paidByUserName, ...source } = parsed;
  const data = { ...source, ...lifecycle };
  delete data.links;
  return { data, links:lifecycle.links, version, amountSen, ...lifecycle };
}

export async function replaceExpenseLinks(c, companyId, expenseId, links, who) {
  const permissions=permissionsFor(who);
  await c.query(`DELETE FROM myfin.expense_links
    WHERE company_id=$1 AND expense_id=$2 AND source='manual'
      AND ($3 OR link_type IN ('stock_item','stock_movement'))`, [companyId, expenseId, permissions.costsRead]);
  for (const link of links) {
    const column = linkColumn[link.type];
    await c.query(`INSERT INTO myfin.expense_links(company_id,id,expense_id,link_type,${column},created_by)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [companyId, randomUUID(), expenseId, link.type, link.id, who.id]);
  }
}

const linkId = row => row.stock_item_id || row.stock_ledger_id || row.purchase_order_id || row.goods_receipt_id;
const linkLabel = row => {
  if (row.link_type === 'stock_item') return row.stock_item_name || row.stock_item_id;
  if (row.link_type === 'stock_movement') {
    const item = row.movement_item_name || row.movement_item_id || 'Stock';
    return `${item} · ${String(row.movement_kind || 'movement').replaceAll('_', ' ')}`;
  }
  if (row.link_type === 'purchase_order') return row.purchase_order_number || row.purchase_order_id;
  const reference = row.goods_receipt_reference || row.goods_receipt_id;
  return row.receipt_order_number ? `${reference} · ${row.receipt_order_number}` : reference;
};

export async function expenseOutput(c, companyId, rows, who) {
  if (!rows.length) return [];
  const permissions=permissionsFor(who);
  const expenseIds = rows.map(row => row.id), identityIds = [...new Set(rows.flatMap(row =>
    [row.paid_by_identity_id,row.created_by]).filter(Boolean))];
  const linkResult = await c.query(`SELECT el.*,si.name AS stock_item_name,sl.item_id AS movement_item_id,
        sl.kind AS movement_kind,msi.name AS movement_item_name,po.number AS purchase_order_number,
        gr.reference AS goods_receipt_reference,rpo.number AS receipt_order_number
      FROM myfin.expense_links el
      LEFT JOIN myfin.stock_items si ON si.company_id=el.company_id AND si.id=el.stock_item_id
      LEFT JOIN myfin.stock_ledger sl ON sl.company_id=el.company_id AND sl.id=el.stock_ledger_id
      LEFT JOIN myfin.stock_items msi ON msi.company_id=sl.company_id AND msi.id=sl.item_id
      LEFT JOIN myfin.purchase_orders po ON po.company_id=el.company_id AND po.id=el.purchase_order_id
      LEFT JOIN myfin.goods_receipts gr ON gr.company_id=el.company_id AND gr.id=el.goods_receipt_id
      LEFT JOIN myfin.purchase_orders rpo ON rpo.company_id=gr.company_id AND rpo.id=gr.purchase_order_id
      WHERE el.company_id=$1 AND el.expense_id=ANY($2::text[])
      ORDER BY el.expense_id,el.link_type,el.created_at,el.id`, [companyId, expenseIds]);
  const identityResult = identityIds.length
    ? await c.query('SELECT id,display_name FROM myfin.app_identities WHERE id=ANY($1::text[])', [identityIds])
    : { rows:[] };
  const paymentResult = await c.query(`SELECT p.expense_id,p.source_type,p.paid_by_identity_id,p.paid_by_name,
        p.petty_cash_fund_id,f.name AS petty_cash_fund_name,
        sum(CASE WHEN p.event_type='payment' THEN p.amount_sen ELSE -p.amount_sen END)::bigint AS amount_sen
      FROM myfin.expense_payment_events p
      LEFT JOIN myfin.petty_cash_funds f ON f.company_id=p.company_id AND f.id=p.petty_cash_fund_id
      WHERE p.company_id=$1 AND p.expense_id=ANY($2::text[])
      GROUP BY p.expense_id,p.source_type,p.paid_by_identity_id,p.paid_by_name,
        p.petty_cash_fund_id,f.name
      HAVING sum(CASE WHEN p.event_type='payment' THEN p.amount_sen ELSE -p.amount_sen END)>0
      ORDER BY p.expense_id,p.source_type,p.paid_by_name,p.petty_cash_fund_id`, [companyId, expenseIds]);
  const identities = new Map(identityResult.rows.map(row => [row.id, row.display_name || row.id]));
  const links = new Map(expenseIds.map(id => [id, []]));
  for (const row of linkResult.rows) {
    const visible=row.link_type==='stock_item'
      ||(row.link_type==='stock_movement'&&permissions.stockHistoryRead)
      ||(['purchase_order','goods_receipt'].includes(row.link_type)&&permissions.costsRead);
    if(visible)links.get(row.expense_id)?.push({type:row.link_type,id:linkId(row),label:linkLabel(row),source:row.source});
  }
  const paymentSources = new Map(expenseIds.map(id => [id, []]));
  for (const row of paymentResult.rows) paymentSources.get(row.expense_id)?.push({
    sourceType:row.source_type,
    amountSen:Number(row.amount_sen),
    paidByUserId:row.paid_by_identity_id||'',
    paidByName:row.paid_by_name||'',
    pettyCashFundId:row.petty_cash_fund_id||'',
    pettyCashFundName:row.petty_cash_fund_name||'',
  });
  return rows.map(row => {
    // Pre-request-digest rows include the original Firebase import, whose
    // importer identity is not evidence of the historical claimant.
    const importedUnattributed=Boolean(row.imported_unattributed)||!row.created_by||row.create_request_digest==null;
    const outputAmountSen=Number(row.amount_sen == null ? cents(row.amount) : row.amount_sen);
    const outputPaidSen=Number(row.paid_amount_sen == null
      ? ((row.status || row.data?.status || 'paid')==='paid'?outputAmountSen:0)
      : row.paid_amount_sen);
    return ({
    ...row.data,
    id:row.id,
    company_id:row.company_id,
    amount:Number(row.amount_sen == null ? row.amount : Number(row.amount_sen) / 100),
    amountSen:outputAmountSen,
    status:row.status || row.data?.status || 'paid',
    effectiveStatus:row.voided_at?'voided':effectiveExpenseStatus({status:row.status || row.data?.status || 'paid',
      creditDueDate:outputDate(row.credit_due_date)}),
    paidByType:row.paid_by_type || row.data?.paidByType || 'other',
    paidByUserId:row.paid_by_identity_id || row.data?.paidByUserId || '',
    paidByUserName:identities.get(row.paid_by_identity_id) || '',
    paidByName:row.paid_by_name || row.data?.paidByName || '',
    pettyCashFundId:row.petty_cash_fund_id || row.data?.pettyCashFundId || '',
    paidAmountSen:outputPaidSen,paidAmount:outputPaidSen/100,
    outstandingAmountSen:Math.max(0,outputAmountSen-outputPaidSen),
    outstandingAmount:Math.max(0,outputAmountSen-outputPaidSen)/100,
    creditTermsDays:row.credit_terms_days == null ? null : Number(row.credit_terms_days),
    creditDueDate:outputDate(row.credit_due_date),
    paidOn:outputDate(row.paid_on || row.data?.paidOn || ((row.status || row.data?.status || 'paid') === 'paid' ? row.data?.date : '')),
    version:Number(row.version || 1),
    createdBy:importedUnattributed?'':row.created_by||'',
    claimantName:importedUnattributed?'Imported / unattributed':(identities.get(row.created_by)||'Unattributed'),
    claimantAttribution:importedUnattributed?'imported_unattributed':'recorded_user',
    links:links.get(row.id) || [],
    paymentSources:paymentSources.get(row.id) || [],
  });});
}

export async function expenseLinkOptions(c, companyId, who) {
  const permissions = permissionsFor(who);
  const stock = await c.query(`SELECT id,name,internal_code FROM myfin.stock_items
      WHERE company_id=$1 ORDER BY active DESC,name,id LIMIT 500`, [companyId]);
  const movements = permissions.stockHistoryRead
    ? await c.query(`SELECT sl.id,sl.item_id,sl.kind,sl.created_at,si.name
          FROM myfin.stock_ledger sl JOIN myfin.stock_items si
            ON si.company_id=sl.company_id AND si.id=sl.item_id
          WHERE sl.company_id=$1 ORDER BY sl.created_at DESC,sl.id DESC LIMIT 500`, [companyId])
    : { rows:[] };
  const orders = permissions.costsRead
    ? await c.query(`SELECT id,number,status FROM myfin.purchase_orders
          WHERE company_id=$1 ORDER BY created_at DESC,id DESC LIMIT 500`, [companyId])
    : { rows:[] };
  const receipts = permissions.costsRead
    ? await c.query(`SELECT gr.id,gr.reference,gr.received_at,po.number
          FROM myfin.goods_receipts gr JOIN myfin.purchase_orders po
            ON po.company_id=gr.company_id AND po.id=gr.purchase_order_id
          WHERE gr.company_id=$1 ORDER BY gr.received_at DESC,gr.id DESC LIMIT 500`, [companyId])
    : { rows:[] };
  return {
    stockItems:stock.rows.map(row => ({ id:row.id, label:`${row.name} · ${row.internal_code}` })),
    stockMovements:movements.rows.map(row => ({ id:row.id, label:`${row.name} · ${row.kind} · ${String(row.created_at).slice(0, 10)}` })),
    purchaseOrders:orders.rows.map(row => ({ id:row.id, label:`${row.number} · ${row.status.replaceAll('_', ' ')}` })),
    goodsReceipts:receipts.rows.map(row => ({ id:row.id, label:`${row.reference || row.id} · ${row.number}` })),
  };
}
