import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../../src/domain/pos.js';
import {
  lineTotalSen, normalizeStockIdentifier, prepareReceiptLines,
  purchaseOrderStatus, reverseWeightedAverageCost, weightedAverageCost,
} from '../../src/domain/procurement.js';
import { owner, requireCapability } from './access.js';
import * as v from './validation.js';

const quantity = z.number().finite().positive().max(1_000_000)
  .refine(value => Math.abs(value * 1e6 - Math.round(value * 1e6)) < 1e-5);
const short = z.string().trim().min(1).max(128);
const optionalDate = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal('')]).default('');
const isoDateTime = z.string().max(40).refine(value => Number.isFinite(Date.parse(value)) && /T/.test(value));
const identifierSchema = z.strictObject({
  stockItemId: v.id,
  type: z.enum(['gtin','ean','upc','manufacturer_barcode','supplier_barcode','internal_sku','qr']),
  value: z.string().trim().min(1).max(256),
  supplierId: z.union([v.id,z.literal('')]).default(''),
  packagingId: z.union([v.id,z.literal('')]).default(''),
});
const orderLineSchema = z.strictObject({
  id: v.id.optional(), stockItemId: v.id,
  supplierItemReference: z.string().trim().max(128).default(''),
  description: z.string().trim().min(1).max(500), purchaseUnit: z.string().trim().min(1).max(32),
  orderedQuantity: quantity, quantityInBase: quantity,
  unitPriceSen: z.number().int().min(0).max(1_000_000_000),
});
const orderSchema = z.strictObject({
  id: v.id.optional(), number: z.string().trim().min(1).max(64), supplierId: v.id,
  currencyCode: z.literal('MYR').default('MYR'), expectedDate: optionalDate,
  notes: z.string().trim().max(10000).default(''), idempotencyKey: z.string().min(8).max(128),
  lines: z.array(orderLineSchema).min(1).max(500),
});
const versionSchema = z.strictObject({version:z.number().int().positive()});
const cancelSchema = z.strictObject({
  version:z.number().int().positive(), reason:z.string().trim().min(3).max(1000),
});
const receiptLineSchema = z.strictObject({
  purchaseOrderLineId:v.id, quantity,
  batchCode:z.string().trim().max(128).default(''), lotCode:z.string().trim().max(128).default(''),
  expiryDate:optionalDate,
});
const receiptSchema = z.strictObject({
  reference:z.string().trim().max(128).default(''), receivedAt:isoDateTime,
  idempotencyKey:z.string().min(8).max(128), lines:z.array(receiptLineSchema).min(1).max(500),
});
const reversalSchema = z.strictObject({
  reason:z.string().trim().min(3).max(1000), idempotencyKey:z.string().min(8).max(128),
});

const number = value => Number(value);
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const moneyText = value => BigInt(value).toString();
const movementKey = (companyId, receiptId, lineId, effect) =>
  `proc:${createHash('sha256').update(`${companyId}\u0000${receiptId}\u0000${lineId}\u0000${effect}`).digest('hex')}`;
export const orderStatusAfterReceiptReversal = (currentStatus, derivedStatus) =>
  currentStatus === 'cancelled' ? 'cancelled' : derivedStatus;

async function assertSupplier(c, companyId, supplierId) {
  const row = (await c.query('SELECT id,data FROM myfin.clients WHERE company_id=$1 AND id=$2 FOR KEY SHARE',
    [companyId,supplierId])).rows[0];
  if (!row || row.data?.type !== 'Supplier') v.fail(409,'supplier_not_found');
  return row;
}

const identifierOutput = row => ({
  id:row.id, stockItemId:row.stock_item_id, type:row.identifier_type, value:row.raw_value,
  normalizedValue:row.normalized_value, supplierId:row.supplier_id||'', packagingId:row.packaging_id||'',
  active:row.active, version:Number(row.version), createdAt:row.created_at, archivedAt:row.archived_at,
});

const receiptLineOutput = (row, includeCosts) => ({
  id:row.id, purchaseOrderLineId:row.purchase_order_line_id, stockItemId:row.stock_item_id,
  quantity:number(row.received_purchase_quantity), baseQuantity:number(row.base_quantity),
  batchCode:row.batch_code, lotCode:row.lot_code, expiryDate:row.expiry_date||'',
  ...(includeCosts?{costSen:moneyText(row.cost_sen)}:{}),
});

async function goodsReceiptOutput(c, companyId, receiptId, includeCosts) {
  const receipt=(await c.query(`SELECT gr.*,rv.id AS reversal_id,rv.reason AS reversal_reason,rv.created_at AS reversed_at
    FROM myfin.goods_receipts gr LEFT JOIN myfin.goods_receipt_reversals rv
      ON rv.company_id=gr.company_id AND rv.goods_receipt_id=gr.id
    WHERE gr.company_id=$1 AND gr.id=$2`,[companyId,receiptId])).rows[0];
  if(!receipt)v.fail(404,'goods_receipt_not_found');
  const lines=(await c.query(`SELECT * FROM myfin.goods_receipt_lines
    WHERE company_id=$1 AND goods_receipt_id=$2 ORDER BY id`,[companyId,receiptId])).rows;
  return {id:receipt.id,purchaseOrderId:receipt.purchase_order_id,reference:receipt.reference,
    receivedAt:receipt.received_at,reversed:!!receipt.reversal_id,
    ...(receipt.reversal_id?{reversal:{id:receipt.reversal_id,reason:receipt.reversal_reason,createdAt:receipt.reversed_at}}:{}),
    lines:lines.map(row=>receiptLineOutput(row,includeCosts))};
}

async function receivedByLine(c, companyId, orderId) {
  const rows=(await c.query(`SELECT gl.purchase_order_line_id,
      coalesce(sum(gl.received_purchase_quantity) FILTER (WHERE rv.id IS NULL),0) AS received
    FROM myfin.goods_receipt_lines gl
    JOIN myfin.goods_receipts gr ON gr.company_id=gl.company_id AND gr.id=gl.goods_receipt_id
    LEFT JOIN myfin.goods_receipt_reversals rv
      ON rv.company_id=gr.company_id AND rv.goods_receipt_id=gr.id
    WHERE gl.company_id=$1 AND gl.purchase_order_id=$2
    GROUP BY gl.purchase_order_line_id`,[companyId,orderId])).rows;
  return new Map(rows.map(row=>[row.purchase_order_line_id,number(row.received)]));
}

async function purchaseOrderOutput(c, companyId, orderId, {includeCosts=true}={}) {
  const row=(await c.query(`SELECT po.*,cl.data->>'name' AS supplier_name
    FROM myfin.purchase_orders po JOIN myfin.clients cl
      ON cl.company_id=po.company_id AND cl.id=po.supplier_id
    WHERE po.company_id=$1 AND po.id=$2`,[companyId,orderId])).rows[0];
  if(!row)v.fail(404,'purchase_order_not_found');
  const lines=(await c.query(`SELECT pol.*,si.name AS stock_item_name,si.base_unit
    FROM myfin.purchase_order_lines pol JOIN myfin.stock_items si
      ON si.company_id=pol.company_id AND si.id=pol.stock_item_id
    WHERE pol.company_id=$1 AND pol.purchase_order_id=$2 ORDER BY pol.position`,[companyId,orderId])).rows;
  const received=await receivedByLine(c,companyId,orderId);
  return {id:row.id,number:row.number,supplierId:row.supplier_id,supplierName:row.supplier_name||'',status:row.status,
    currencyCode:row.currency_code,expectedDate:row.expected_date||'',notes:row.notes,version:Number(row.version),
    createdAt:row.created_at,submittedAt:row.submitted_at,cancelledAt:row.cancelled_at,
    ...(includeCosts?{totalSen:moneyText(row.total_sen)}:{}),
    lines:lines.map(line=>({id:line.id,stockItemId:line.stock_item_id,stockItemName:line.stock_item_name,
      baseUnit:line.base_unit,supplierItemReference:line.supplier_item_reference,description:line.description,
      purchaseUnit:line.purchase_unit,orderedQuantity:number(line.ordered_purchase_quantity),
      quantityInBase:number(line.quantity_in_base),receivedQuantity:received.get(line.id)||0,
      ...(includeCosts?{unitPriceSen:moneyText(line.unit_price_sen),lineTotalSen:moneyText(line.line_total_sen)}:{}),
    }))};
}

export async function createPurchaseOrder(c, who, companyId, input, audit=async()=>{}) {
  const data=v.parse(orderSchema,input),requestDigest=hash(data);
  requireCapability(who,'costsWrite');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,31))',
    [`${companyId}:purchase-order:${data.idempotencyKey}`]);
  const duplicate=(await c.query(`SELECT id,request_digest FROM myfin.purchase_orders
    WHERE company_id=$1 AND idempotency_key=$2`,[companyId,data.idempotencyKey])).rows[0];
  if(duplicate){
    if(duplicate.request_digest!==requestDigest)v.fail(409,'purchase_order_payload_changed');
    return {duplicate:true,order:await purchaseOrderOutput(c,companyId,duplicate.id)};
  }
  await assertSupplier(c,companyId,data.supplierId);
  const stockIds=[...new Set(data.lines.map(line=>line.stockItemId))].sort();
  const stock=(await c.query(`SELECT id,active FROM myfin.stock_items
    WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR KEY SHARE`,[companyId,stockIds])).rows;
  if(stock.length!==stockIds.length)v.fail(404,'stock_item_not_found');
  if(stock.some(row=>!row.active))v.fail(409,'stock_item_archived');
  const lineIds=new Set(),prepared=data.lines.map((line,index)=>{
    const id=line.id||randomUUID();
    if(lineIds.has(id))v.fail(400,'duplicate_purchase_order_line');
    lineIds.add(id);
    return {...line,id,position:index,lineTotalSen:lineTotalSen(line.orderedQuantity,line.unitPriceSen)};
  });
  const total=prepared.reduce((sum,line)=>sum+line.lineTotalSen,0n),id=data.id||randomUUID();
  await c.query(`INSERT INTO myfin.purchase_orders(company_id,id,number,supplier_id,currency_code,total_sen,
    expected_date,notes,idempotency_key,request_digest,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[companyId,id,data.number,data.supplierId,data.currencyCode,
    total.toString(),data.expectedDate||null,data.notes,data.idempotencyKey,requestDigest,who.id]);
  for(const line of prepared)await c.query(`INSERT INTO myfin.purchase_order_lines(company_id,purchase_order_id,id,
    position,stock_item_id,supplier_item_reference,description,purchase_unit,ordered_purchase_quantity,
    quantity_in_base,unit_price_sen,line_total_sen) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [companyId,id,line.id,line.position,line.stockItemId,line.supplierItemReference,line.description,line.purchaseUnit,
    line.orderedQuantity,line.quantityInBase,line.unitPriceSen,line.lineTotalSen.toString()]);
  await c.query(`INSERT INTO myfin.purchase_order_events(company_id,id,purchase_order_id,actor_id,event_type,details)
    VALUES($1,$2,$3,$4,'created',$5)`,[companyId,randomUUID(),id,who.id,{lineCount:prepared.length,totalSen:total.toString()}]);
  await audit(c,who,companyId,'Create purchase order',`${data.number} · ${prepared.length} lines`);
  return {duplicate:false,order:await purchaseOrderOutput(c,companyId,id)};
}

async function updateOrderState(c, who, companyId, orderId, version, state, details, audit) {
  requireCapability(who,'costsWrite');
  const row=(await c.query(`SELECT * FROM myfin.purchase_orders
    WHERE company_id=$1 AND id=$2 FOR UPDATE`,[companyId,orderId])).rows[0];
  if(!row)v.fail(404,'purchase_order_not_found');
  if(Number(row.version)!==version)v.fail(409,'purchase_order_changed');
  if(state==='submitted'&&row.status!=='draft')v.fail(409,'purchase_order_not_draft');
  if(state==='cancelled'&&!['draft','submitted','partially_received'].includes(row.status))v.fail(409,'purchase_order_cannot_cancel');
  const result=(await c.query(`UPDATE myfin.purchase_orders SET status=$3,version=version+1,updated_at=now(),
    submitted_at=CASE WHEN $3='submitted' THEN now() ELSE submitted_at END,
    submitted_by=CASE WHEN $3='submitted' THEN $4 ELSE submitted_by END,
    cancelled_at=CASE WHEN $3='cancelled' THEN now() ELSE cancelled_at END,
    cancelled_by=CASE WHEN $3='cancelled' THEN $4 ELSE cancelled_by END
    WHERE company_id=$1 AND id=$2 RETURNING id`,[companyId,orderId,state,who.id])).rows[0];
  await c.query(`INSERT INTO myfin.purchase_order_events(company_id,id,purchase_order_id,actor_id,event_type,details)
    VALUES($1,$2,$3,$4,$5,$6)`,[companyId,randomUUID(),orderId,who.id,state,details]);
  await audit(c,who,companyId,state==='submitted'?'Submit purchase order':'Cancel purchase order',
    `${row.number}${details.reason?` · ${details.reason}`:''}`);
  return purchaseOrderOutput(c,companyId,result.id);
}

function groupReceiptCosts(lines) {
  const groups=new Map();
  for(const line of lines){
    const group=groups.get(line.stockItemId)||{stockItemId:line.stockItemId,quantity:0,valueSen:0n};
    group.quantity=Math.round((group.quantity+line.baseQuantity)*1e6)/1e6;
    group.valueSen+=line.costSen;groups.set(line.stockItemId,group);
  }
  return [...groups.values()].sort((a,b)=>a.stockItemId.localeCompare(b.stockItemId));
}

async function updateWeightedCosts(c, companyId, actorId, sourceType, sourceId, groups) {
  if(!groups.length)return;
  const ids=groups.map(group=>group.stockItemId);
  const current=(await c.query(`SELECT * FROM myfin.inventory_weighted_costs
    WHERE company_id=$1 AND stock_item_id=ANY($2::text[]) ORDER BY stock_item_id FOR UPDATE`,[companyId,ids])).rows;
  const byId=new Map(current.map(row=>[row.stock_item_id,row]));
  for(const group of groups){
    const prior=byId.get(group.stockItemId),before={quantity:number(prior?.cumulative_received_quantity||0),
      valueSen:prior?.cumulative_value_sen||0};
    const next=sourceType==='goods_receipt'
      ?weightedAverageCost(before,{quantity:group.quantity,valueSen:group.valueSen})
      :reverseWeightedAverageCost(before,{quantity:group.quantity,valueSen:group.valueSen});
    const average=next.averageCostSen.toFixed(8);
    await c.query(`INSERT INTO myfin.inventory_weighted_costs(company_id,stock_item_id,cumulative_received_quantity,
      cumulative_value_sen,average_cost_sen) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(company_id,stock_item_id) DO UPDATE SET
        cumulative_received_quantity=EXCLUDED.cumulative_received_quantity,
        cumulative_value_sen=EXCLUDED.cumulative_value_sen,average_cost_sen=EXCLUDED.average_cost_sen,
        version=inventory_weighted_costs.version+1,updated_at=now()`,
    [companyId,group.stockItemId,next.quantity,next.valueSen.toString(),average]);
    const sign=sourceType==='goods_receipt'?1:-1;
    await c.query(`INSERT INTO myfin.inventory_valuation_events(company_id,id,stock_item_id,source_type,source_id,
      quantity_delta,value_delta_sen,cumulative_received_quantity,cumulative_value_sen,average_cost_sen,actor_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[companyId,randomUUID(),group.stockItemId,sourceType,sourceId,
      sign*group.quantity,(BigInt(sign)*group.valueSen).toString(),next.quantity,next.valueSen.toString(),average,actorId]);
  }
}

export async function receivePurchaseOrder(c, who, companyId, orderId, input, audit=async()=>{}) {
  requireCapability(who,'inventoryTransact');
  const data=v.parse(receiptSchema,input),requestDigest=hash({orderId,...data});
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,32))',
    [`${companyId}:goods-receipt:${data.idempotencyKey}`]);
  const duplicate=(await c.query(`SELECT id,request_digest FROM myfin.goods_receipts
    WHERE company_id=$1 AND idempotency_key=$2`,[companyId,data.idempotencyKey])).rows[0];
  if(duplicate){
    if(duplicate.request_digest!==requestDigest)v.fail(409,'goods_receipt_payload_changed');
    return {duplicate:true,receipt:await goodsReceiptOutput(c,companyId,duplicate.id,owner(who))};
  }
  const order=(await c.query(`SELECT * FROM myfin.purchase_orders
    WHERE company_id=$1 AND id=$2 FOR UPDATE`,[companyId,orderId])).rows[0];
  if(!order)v.fail(404,'purchase_order_not_found');
  if(!['submitted','partially_received'].includes(order.status))v.fail(409,'purchase_order_not_receivable');
  const orderLines=(await c.query(`SELECT * FROM myfin.purchase_order_lines
    WHERE company_id=$1 AND purchase_order_id=$2 ORDER BY id FOR UPDATE`,[companyId,orderId])).rows;
  const already=await receivedByLine(c,companyId,orderId);
  let prepared;
  try{prepared=prepareReceiptLines(orderLines,already,data.lines);}catch(error){v.fail(409,error.message);}
  prepared.sort((a,b)=>a.stockItemId.localeCompare(b.stockItemId)||a.purchaseOrderLineId.localeCompare(b.purchaseOrderLineId));
  const stockIds=[...new Set(prepared.map(line=>line.stockItemId))].sort();
  const stock=(await c.query(`SELECT * FROM myfin.stock_items WHERE company_id=$1 AND id=ANY($2::text[])
    ORDER BY id FOR UPDATE`,[companyId,stockIds])).rows;
  if(stock.length!==stockIds.length||stock.some(row=>!row.active))v.fail(409,'stock_item_unavailable');
  const stockById=new Map(stock.map(row=>[row.id,row]));
  for(const line of prepared){
    const stockRow=stockById.get(line.stockItemId);
    if(stockRow.tracking_mode==='count'&&!Number.isInteger(line.baseQuantity))v.fail(409,'counted_stock_requires_whole_units');
  }
  const receiptId=randomUUID();
  await c.query(`INSERT INTO myfin.goods_receipts(company_id,id,purchase_order_id,reference,received_at,
    idempotency_key,request_digest,received_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
  [companyId,receiptId,orderId,data.reference,data.receivedAt,data.idempotencyKey,requestDigest,who.id]);
  const running=new Map(stock.map(row=>[row.id,number(row.on_hand)]));
  for(const line of prepared){
    const lineId=randomUUID(),after=Math.round((running.get(line.stockItemId)+line.baseQuantity)*1e6)/1e6;
    running.set(line.stockItemId,after);
    await c.query(`INSERT INTO myfin.goods_receipt_lines(company_id,goods_receipt_id,id,purchase_order_id,
      purchase_order_line_id,stock_item_id,received_purchase_quantity,base_quantity,cost_sen,batch_code,lot_code,expiry_date)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[companyId,receiptId,lineId,orderId,
      line.purchaseOrderLineId,line.stockItemId,line.quantity,line.baseQuantity,line.costSen.toString(),line.batchCode,line.lotCode,line.expiryDate||null]);
    await c.query(`UPDATE myfin.stock_items SET on_hand=$3,version=version+1,updated_at=now()
      WHERE company_id=$1 AND id=$2`,[companyId,line.stockItemId,after]);
    const key=movementKey(companyId,receiptId,lineId,'receive'),movementDigest=hash({receiptId,lineId,
      stockItemId:line.stockItemId,quantity:line.baseQuantity,effect:'receive'});
    await c.query(`INSERT INTO myfin.stock_ledger(company_id,id,item_id,actor_id,kind,input_quantity,delta,
      quantity_after,supplier_id,reason,idempotency_key,request_digest,source_details,
      procurement_receipt_id,procurement_receipt_line_id,procurement_effect)
      VALUES($1,$2,$3,$4,'receive',$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,'receive')`,
    [companyId,randomUUID(),line.stockItemId,who.id,line.baseQuantity,after,order.supplier_id,
      `Purchase receipt ${order.number}`,key,movementDigest,{purchaseOrderId:orderId},receiptId,lineId]);
    if(line.batchCode||line.lotCode||line.expiryDate)await c.query(`INSERT INTO myfin.stock_batches(company_id,id,
      stock_item_id,goods_receipt_id,goods_receipt_line_id,batch_code,lot_code,expiry_date,received_quantity)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[companyId,randomUUID(),line.stockItemId,receiptId,lineId,
      line.batchCode,line.lotCode,line.expiryDate||null,line.baseQuantity]);
  }
  await updateWeightedCosts(c,companyId,who.id,'goods_receipt',receiptId,groupReceiptCosts(prepared));
  const nowReceived=new Map(already);
  for(const line of prepared)nowReceived.set(line.purchaseOrderLineId,
    Math.round(((nowReceived.get(line.purchaseOrderLineId)||0)+line.quantity)*1e6)/1e6);
  const state=purchaseOrderStatus(orderLines,nowReceived);
  await c.query(`UPDATE myfin.purchase_orders SET status=$3,version=version+1,updated_at=now()
    WHERE company_id=$1 AND id=$2`,[companyId,orderId,state]);
  await c.query(`INSERT INTO myfin.purchase_order_events(company_id,id,purchase_order_id,actor_id,event_type,details)
    VALUES($1,$2,$3,$4,$5,$6)`,[companyId,randomUUID(),orderId,who.id,state,
    {goodsReceiptId:receiptId,lineCount:prepared.length}]);
  await audit(c,who,companyId,'Receive purchase order',`${order.number} · ${prepared.length} lines`);
  return {duplicate:false,receipt:await goodsReceiptOutput(c,companyId,receiptId,owner(who))};
}

export async function reverseGoodsReceipt(c, who, companyId, receiptId, input, audit=async()=>{}) {
  requireCapability(who,'costsWrite');
  const data=v.parse(reversalSchema,input),requestDigest=hash({receiptId,...data});
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,33))',
    [`${companyId}:goods-receipt-reversal:${data.idempotencyKey}`]);
  const duplicate=(await c.query(`SELECT id,goods_receipt_id,request_digest FROM myfin.goods_receipt_reversals
    WHERE company_id=$1 AND idempotency_key=$2`,[companyId,data.idempotencyKey])).rows[0];
  if(duplicate){
    if(duplicate.goods_receipt_id!==receiptId||duplicate.request_digest!==requestDigest)v.fail(409,'receipt_reversal_payload_changed');
    return {duplicate:true,receipt:await goodsReceiptOutput(c,companyId,receiptId,true)};
  }
  const receipt=(await c.query(`SELECT gr.*,po.number AS order_number,po.supplier_id,po.status AS order_status
    FROM myfin.goods_receipts gr JOIN myfin.purchase_orders po
      ON po.company_id=gr.company_id AND po.id=gr.purchase_order_id
    WHERE gr.company_id=$1 AND gr.id=$2 FOR UPDATE OF gr,po`,[companyId,receiptId])).rows[0];
  if(!receipt)v.fail(404,'goods_receipt_not_found');
  const existing=await c.query(`SELECT id FROM myfin.goods_receipt_reversals
    WHERE company_id=$1 AND goods_receipt_id=$2`,[companyId,receiptId]);
  if(existing.rowCount)v.fail(409,'goods_receipt_already_reversed');
  const lines=(await c.query(`SELECT * FROM myfin.goods_receipt_lines
    WHERE company_id=$1 AND goods_receipt_id=$2 ORDER BY stock_item_id,id FOR SHARE`,[companyId,receiptId])).rows;
  const groups=groupReceiptCosts(lines.map(row=>({stockItemId:row.stock_item_id,
    baseQuantity:number(row.base_quantity),costSen:BigInt(row.cost_sen)})));
  const stockIds=groups.map(group=>group.stockItemId);
  const stock=(await c.query(`SELECT * FROM myfin.stock_items WHERE company_id=$1 AND id=ANY($2::text[])
    ORDER BY id FOR UPDATE`,[companyId,stockIds])).rows;
  const stockById=new Map(stock.map(row=>[row.id,row]));
  for(const group of groups)if(!stockById.has(group.stockItemId)||number(stockById.get(group.stockItemId).on_hand)+1e-9<group.quantity)
    v.fail(409,'receipt_stock_already_consumed');
  const reversalId=randomUUID();
  await c.query(`INSERT INTO myfin.goods_receipt_reversals(company_id,id,goods_receipt_id,reason,idempotency_key,
    request_digest,reversed_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
  [companyId,reversalId,receiptId,data.reason,data.idempotencyKey,requestDigest,who.id]);
  const running=new Map(stock.map(row=>[row.id,number(row.on_hand)]));
  for(const line of lines){
    const amount=number(line.base_quantity),after=Math.round((running.get(line.stock_item_id)-amount)*1e6)/1e6;
    running.set(line.stock_item_id,after);
    await c.query(`UPDATE myfin.stock_items SET on_hand=$3,version=version+1,updated_at=now()
      WHERE company_id=$1 AND id=$2`,[companyId,line.stock_item_id,after]);
    const key=movementKey(companyId,receiptId,line.id,'reversal'),movementDigest=hash({receiptId,lineId:line.id,
      stockItemId:line.stock_item_id,quantity:amount,effect:'reversal'});
    await c.query(`INSERT INTO myfin.stock_ledger(company_id,id,item_id,actor_id,kind,input_quantity,delta,
      quantity_after,supplier_id,reason,idempotency_key,request_digest,source_details,
      procurement_receipt_id,procurement_receipt_line_id,procurement_effect)
      VALUES($1,$2,$3,$4,'adjust',$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,'reversal')`,
    [companyId,randomUUID(),line.stock_item_id,who.id,-amount,after,receipt.supplier_id,
      `Reverse purchase receipt ${receipt.order_number}: ${data.reason}`,key,movementDigest,
      {purchaseOrderId:receipt.purchase_order_id,reversalId},receiptId,line.id]);
  }
  await updateWeightedCosts(c,companyId,who.id,'goods_receipt_reversal',reversalId,groups);
  const orderLines=(await c.query(`SELECT * FROM myfin.purchase_order_lines WHERE company_id=$1
    AND purchase_order_id=$2 ORDER BY id FOR UPDATE`,[companyId,receipt.purchase_order_id])).rows;
  const received=await receivedByLine(c,companyId,receipt.purchase_order_id),derivedState=purchaseOrderStatus(orderLines,received),
    state=orderStatusAfterReceiptReversal(receipt.order_status,derivedState);
  await c.query(`UPDATE myfin.purchase_orders SET status=$3,version=version+1,updated_at=now()
    WHERE company_id=$1 AND id=$2`,[companyId,receipt.purchase_order_id,state]);
  await c.query(`INSERT INTO myfin.purchase_order_events(company_id,id,purchase_order_id,actor_id,event_type,details)
    VALUES($1,$2,$3,$4,'receipt_reversed',$5)`,[companyId,randomUUID(),receipt.purchase_order_id,who.id,
    {goodsReceiptId:receiptId,reversalId,status:state,derivedReceiptStatus:derivedState,reason:data.reason}]);
  await audit(c,who,companyId,'Reverse goods receipt',`${receipt.order_number} · ${data.reason}`);
  return {duplicate:false,receipt:await goodsReceiptOutput(c,companyId,receiptId,true)};
}

export function registerProcurement(app,{scoped,audit}) {
  app.get('/api/companies/:company/stock-identifiers',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'inventoryRead');
    const query=v.parse(z.strictObject({code:z.string().trim().max(256).optional(),stockItemId:v.id.optional(),
      includeArchived:z.enum(['true']).optional()}),req.query);
    const normalized=query.code?String(query.code).normalize('NFKC').trim().toLocaleUpperCase('en-US'):'';
    const result=await c.query(`SELECT * FROM myfin.stock_identifiers WHERE company_id=$1
      AND ($2='' OR normalized_value=$2) AND ($3='' OR stock_item_id=$3)
      AND ($4 OR active) ORDER BY stock_item_id,identifier_type,id LIMIT 501`,
    [companyId,normalized,query.stockItemId||'',query.includeArchived==='true']);
    return {rows:result.rows.slice(0,500).map(identifierOutput),truncated:result.rowCount>500};
  }));
  app.get('/api/companies/:company/stock-identifiers/resolve/:code',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'inventoryRead');
    const raw=v.parse(z.string().trim().min(1).max(256),req.params.code),normalized=raw.normalize('NFKC').toLocaleUpperCase('en-US');
    const result=await c.query(`SELECT i.*,s.name,s.base_unit,s.on_hand,s.active AS stock_active
      FROM myfin.stock_identifiers i JOIN myfin.stock_items s
        ON s.company_id=i.company_id AND s.id=i.stock_item_id
      WHERE i.company_id=$1 AND i.normalized_value=$2 AND i.active`,[companyId,normalized]);
    if(!result.rowCount){
      const internal=(await c.query(`SELECT id,name,base_unit,on_hand,active,internal_code FROM myfin.stock_items
        WHERE company_id=$1 AND upper(internal_code)=$2`,[companyId,normalized])).rows[0];
      if(!internal)v.fail(404,'stock_identifier_not_found');
      return {identifier:{id:`internal:${internal.id}`,stockItemId:internal.id,type:'internal_sku',value:internal.internal_code,
        normalizedValue:internal.internal_code,supplierId:'',packagingId:'',active:internal.active,version:1},
      stockItem:{id:internal.id,name:internal.name,baseUnit:internal.base_unit,onHand:number(internal.on_hand),active:internal.active}};
    }
    const row=result.rows[0];
    return {identifier:identifierOutput(row),stockItem:{id:row.stock_item_id,name:row.name,baseUnit:row.base_unit,
      onHand:number(row.on_hand),active:row.stock_active}};
  }));
  app.post('/api/companies/:company/stock-identifiers',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'inventoryWrite');const data=v.parse(identifierSchema,req.body);
    let normalized;try{normalized=normalizeStockIdentifier(data.type,data.value);}catch(error){v.fail(400,error.message);}
    const stock=(await c.query(`SELECT id FROM myfin.stock_items WHERE company_id=$1 AND id=$2 AND active FOR KEY SHARE`,
      [companyId,data.stockItemId])).rows[0];if(!stock)v.fail(404,'stock_item_not_found');
    if(data.supplierId)await assertSupplier(c,companyId,data.supplierId);
    if(data.type==='supplier_barcode'&&!data.supplierId)v.fail(400,'supplier_required');
    if(data.packagingId){const pack=await c.query(`SELECT id FROM myfin.stock_packagings
      WHERE company_id=$1 AND item_id=$2 AND id=$3 FOR KEY SHARE`,[companyId,data.stockItemId,data.packagingId]);
      if(!pack.rowCount)v.fail(404,'stock_packaging_not_found');}
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,34))',[`${companyId}:identifier:${normalized.normalized}`]);
    const legacy=await c.query(`SELECT id FROM myfin.stock_items WHERE company_id=$1 AND
        (upper(btrim(barcode))=$2 OR upper(internal_code)=$2)
      UNION ALL SELECT item_id FROM myfin.stock_packagings WHERE company_id=$1 AND upper(btrim(barcode))=$2 LIMIT 1`,
    [companyId,normalized.normalized]);if(legacy.rowCount)v.fail(409,'identifier_conflicts_with_legacy_barcode');
    const id=randomUUID(),inserted=(await c.query(`INSERT INTO myfin.stock_identifiers(company_id,id,stock_item_id,
      identifier_type,raw_value,normalized_value,supplier_id,packaging_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[companyId,id,data.stockItemId,data.type,
      normalized.raw,normalized.normalized,data.supplierId||null,data.packagingId||null,req.identity.id])).rows[0];
    await audit(c,req.identity,companyId,'Add stock identifier',`${data.type} · ${data.stockItemId}`);
    return identifierOutput(inserted);
  }));
  app.post('/api/companies/:company/stock-identifiers/:id/archive',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'inventoryWrite');const id=v.parse(v.id,req.params.id),data=v.parse(versionSchema,req.body);
    const result=await c.query(`UPDATE myfin.stock_identifiers SET active=false,archived_at=now(),archived_by=$4,
      version=version+1 WHERE company_id=$1 AND id=$2 AND active AND version=$3 RETURNING *`,
    [companyId,id,data.version,req.identity.id]);if(!result.rowCount)v.fail(409,'stock_identifier_changed');
    await audit(c,req.identity,companyId,'Archive stock identifier',id);return identifierOutput(result.rows[0]);
  }));

  app.get('/api/companies/:company/purchase-orders',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'costsRead');
    const rows=(await c.query(`SELECT id FROM myfin.purchase_orders WHERE company_id=$1
      ORDER BY created_at DESC,id DESC LIMIT 200`,[companyId])).rows;
    return {rows:await Promise.all(rows.map(row=>purchaseOrderOutput(c,companyId,row.id)))};
  }));
  app.get('/api/companies/:company/receiving-queue',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'inventoryTransact');
    const rows=(await c.query(`SELECT id FROM myfin.purchase_orders WHERE company_id=$1
      AND status IN ('submitted','partially_received') ORDER BY expected_date NULLS LAST,created_at,id LIMIT 200`,[companyId])).rows;
    return {rows:await Promise.all(rows.map(row=>purchaseOrderOutput(c,companyId,row.id,{includeCosts:false})))};
  }));
  app.post('/api/companies/:company/purchase-orders',req=>scoped(req,(c,companyId)=>
    createPurchaseOrder(c,req.identity,companyId,req.body,audit)));
  app.post('/api/companies/:company/purchase-orders/:id/submit',req=>scoped(req,(c,companyId)=>
    updateOrderState(c,req.identity,companyId,v.parse(v.id,req.params.id),v.parse(versionSchema,req.body).version,
      'submitted',{},audit)));
  app.post('/api/companies/:company/purchase-orders/:id/cancel',req=>scoped(req,(c,companyId)=>{
    const data=v.parse(cancelSchema,req.body);return updateOrderState(c,req.identity,companyId,v.parse(v.id,req.params.id),
      data.version,'cancelled',{reason:data.reason},audit);
  }));
  app.post('/api/companies/:company/purchase-orders/:id/receipts',req=>scoped(req,(c,companyId)=>
    receivePurchaseOrder(c,req.identity,companyId,v.parse(v.id,req.params.id),req.body,audit)));
  app.post('/api/companies/:company/goods-receipts/:id/reverse',req=>scoped(req,(c,companyId)=>
    reverseGoodsReceipt(c,req.identity,companyId,v.parse(v.id,req.params.id),req.body,audit)));

  app.get('/api/companies/:company/low-stock-alerts',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'inventoryRead');
    const query=v.parse(z.strictObject({status:z.enum(['open','acknowledged','resolved']).optional()}),req.query);
    const rows=(await c.query(`SELECT a.*,s.name,s.base_unit FROM myfin.low_stock_alerts a
      JOIN myfin.stock_items s ON s.company_id=a.company_id AND s.id=a.stock_item_id
      WHERE a.company_id=$1 AND ($2='' OR a.status=$2) ORDER BY
        CASE a.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,a.opened_at DESC LIMIT 500`,
    [companyId,query.status||''])).rows;
    return {rows:rows.map(row=>({id:row.id,stockItemId:row.stock_item_id,stockItemName:row.name,
      baseUnit:row.base_unit,status:row.status,observedQuantity:number(row.observed_quantity),
      reorderThreshold:number(row.reorder_threshold),openedAt:row.opened_at,acknowledgedAt:row.acknowledged_at,
      resolvedAt:row.resolved_at,version:Number(row.version)}))};
  }));
  app.post('/api/companies/:company/low-stock-alerts/:id/acknowledge',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'inventoryWrite');const id=v.parse(v.id,req.params.id),data=v.parse(versionSchema,req.body);
    const result=await c.query(`UPDATE myfin.low_stock_alerts SET status='acknowledged',acknowledged_at=now(),
      acknowledged_by=$4,version=version+1 WHERE company_id=$1 AND id=$2 AND status='open' AND version=$3 RETURNING *`,
    [companyId,id,data.version,req.identity.id]);if(!result.rowCount)v.fail(409,'low_stock_alert_changed');
    await c.query(`INSERT INTO myfin.low_stock_alert_events(company_id,id,alert_id,event_type,actor_id,details)
      VALUES($1,$2,$3,'acknowledged',$4,'{}')`,[companyId,randomUUID(),id,req.identity.id]);
    await audit(c,req.identity,companyId,'Acknowledge low-stock alert',id);return {ok:true,version:Number(result.rows[0].version)};
  }));
  app.get('/api/companies/:company/inventory-valuation',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'costsRead');
    const rows=(await c.query(`SELECT s.id,s.name,s.base_unit,s.on_hand,c.cumulative_received_quantity,
      c.cumulative_value_sen,c.average_cost_sen,c.version,
      round(s.on_hand*c.average_cost_sen)::bigint AS inventory_value_sen
      FROM myfin.inventory_weighted_costs c JOIN myfin.stock_items s
        ON s.company_id=c.company_id AND s.id=c.stock_item_id
      WHERE c.company_id=$1 ORDER BY s.name,s.id`,[companyId])).rows;
    return {basis:'weighted-average purchase receipts; existing uncosted opening stock is excluded from the average',
      rows:rows.map(row=>({stockItemId:row.id,name:row.name,baseUnit:row.base_unit,onHand:number(row.on_hand),
        cumulativeReceivedQuantity:number(row.cumulative_received_quantity),cumulativeValueSen:moneyText(row.cumulative_value_sen),
        averageCostSen:String(row.average_cost_sen),inventoryValueSen:moneyText(row.inventory_value_sen),version:Number(row.version)}))};
  }));
}
