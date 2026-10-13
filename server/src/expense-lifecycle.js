import { randomUUID } from 'node:crypto';
import { businessDate, cents } from '../../src/domain/pos.js';
import { normalizeExpenseLifecycle } from '../../src/domain/expenseLifecycle.js';
import { permissionsFor } from '../../src/domain/permissions.js';
import { operator } from './access.js';
import * as v from './validation.js';

const linkColumn = Object.freeze({
  stock_item: 'stock_item_id',
  stock_movement: 'stock_ledger_id',
  purchase_order: 'purchase_order_id',
  goods_receipt: 'goods_receipt_id',
});

const outputDate = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
const lifecycleField=(record,column,key)=>record?.[column]??record?.[key]??record?.data?.[key]??'';
const auditDate=value=>outputDate(value)||'—';
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
  return {
    status:record.voided_at?'voided':lifecycleField(record,'status','status')||'paid',
    paidByType:lifecycleField(record,'paid_by_type','paidByType')||'legacy_unspecified',
    paidByUserId:lifecycleField(record,'paid_by_identity_id','paidByUserId')||'',
    paidByName:lifecycleField(record,'paid_by_name','paidByName')||'',
    amountSen:Number(amountSen),expenseDate:outputDate(record.data?.date??record.date),
    creditTermsDays:Number(lifecycleField(record,'credit_terms_days','creditTermsDays')||0)||null,
    creditDueDate:outputDate(lifecycleField(record,'credit_due_date','creditDueDate')),
    paidOn:outputDate(lifecycleField(record,'paid_on','paidOn')),voided:Boolean(record.voided_at),
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

export async function prepareExpense(c, companyId, who, parsed, { allowLegacy = false, defaultPaidOn = '' } = {}) {
  let lifecycle;
  const candidate=parsed.status!=='pending'&&!parsed.paidOn&&defaultPaidOn?{...parsed,paidOn:defaultPaidOn}:parsed;
  try { lifecycle = normalizeExpenseLifecycle(candidate, { actorId:who.id, allowLegacy, today:businessDate() }); }
  catch (error) { v.fail(400, error.message); }
  const amountSen = cents(parsed.amount);
  if (amountSen <= 0 || amountSen / 100 !== parsed.amount) v.fail(400, 'invalid_expense_amount');
  await assertPayer(c, companyId, who, lifecycle.paidByUserId);
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
  const expenseIds = rows.map(row => row.id), payerIds = [...new Set(rows.map(row => row.paid_by_identity_id).filter(Boolean))];
  const [linkResult, payerResult] = await Promise.all([
    c.query(`SELECT el.*,si.name AS stock_item_name,sl.item_id AS movement_item_id,
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
      ORDER BY el.expense_id,el.link_type,el.created_at,el.id`, [companyId, expenseIds]),
    payerIds.length
      ? c.query('SELECT id,display_name FROM myfin.app_identities WHERE id=ANY($1::text[])', [payerIds])
      : Promise.resolve({ rows:[] }),
  ]);
  const payers = new Map(payerResult.rows.map(row => [row.id, row.display_name || row.id]));
  const links = new Map(expenseIds.map(id => [id, []]));
  for (const row of linkResult.rows) {
    const visible=row.link_type==='stock_item'
      ||(row.link_type==='stock_movement'&&permissions.stockHistoryRead)
      ||(['purchase_order','goods_receipt'].includes(row.link_type)&&permissions.costsRead);
    if(visible)links.get(row.expense_id)?.push({type:row.link_type,id:linkId(row),label:linkLabel(row),source:row.source});
  }
  return rows.map(row => ({
    ...row.data,
    id:row.id,
    company_id:row.company_id,
    amount:Number(row.amount_sen == null ? row.amount : Number(row.amount_sen) / 100),
    amountSen:Number(row.amount_sen == null ? cents(row.amount) : row.amount_sen),
    status:row.status || row.data?.status || 'paid',
    paidByType:row.paid_by_type || row.data?.paidByType || 'other',
    paidByUserId:row.paid_by_identity_id || row.data?.paidByUserId || '',
    paidByUserName:payers.get(row.paid_by_identity_id) || '',
    paidByName:row.paid_by_name || row.data?.paidByName || '',
    creditTermsDays:row.credit_terms_days == null ? null : Number(row.credit_terms_days),
    creditDueDate:outputDate(row.credit_due_date),
    paidOn:outputDate(row.paid_on || row.data?.paidOn || ((row.status || row.data?.status || 'paid') === 'paid' ? row.data?.date : '')),
    version:Number(row.version || 1),
    links:links.get(row.id) || [],
  }));
}

export async function expenseLinkOptions(c, companyId, who) {
  const permissions = permissionsFor(who);
  const [stock, movements, orders, receipts] = await Promise.all([
    c.query(`SELECT id,name,internal_code FROM myfin.stock_items
      WHERE company_id=$1 ORDER BY active DESC,name,id LIMIT 500`, [companyId]),
    permissions.stockHistoryRead
      ? c.query(`SELECT sl.id,sl.item_id,sl.kind,sl.created_at,si.name
          FROM myfin.stock_ledger sl JOIN myfin.stock_items si
            ON si.company_id=sl.company_id AND si.id=sl.item_id
          WHERE sl.company_id=$1 ORDER BY sl.created_at DESC,sl.id DESC LIMIT 500`, [companyId])
      : Promise.resolve({ rows:[] }),
    permissions.costsRead
      ? c.query(`SELECT id,number,status FROM myfin.purchase_orders
          WHERE company_id=$1 ORDER BY created_at DESC,id DESC LIMIT 500`, [companyId])
      : Promise.resolve({ rows:[] }),
    permissions.costsRead
      ? c.query(`SELECT gr.id,gr.reference,gr.received_at,po.number
          FROM myfin.goods_receipts gr JOIN myfin.purchase_orders po
            ON po.company_id=gr.company_id AND po.id=gr.purchase_order_id
          WHERE gr.company_id=$1 ORDER BY gr.received_at DESC,gr.id DESC LIMIT 500`, [companyId])
      : Promise.resolve({ rows:[] }),
  ]);
  return {
    stockItems:stock.rows.map(row => ({ id:row.id, label:`${row.name} · ${row.internal_code}` })),
    stockMovements:movements.rows.map(row => ({ id:row.id, label:`${row.name} · ${row.kind} · ${String(row.created_at).slice(0, 10)}` })),
    purchaseOrders:orders.rows.map(row => ({ id:row.id, label:`${row.number} · ${row.status.replaceAll('_', ' ')}` })),
    goodsReceipts:receipts.rows.map(row => ({ id:row.id, label:`${row.reference || row.id} · ${row.number}` })),
  };
}
