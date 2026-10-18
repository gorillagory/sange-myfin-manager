import { randomUUID,createHash } from 'node:crypto';
import { z } from 'zod';
import * as v from './validation.js';
import { owner,requireCapability } from './access.js';
import { stockMovement } from '../../src/domain/stock.js';
import { businessDate,canonical } from '../../src/domain/pos.js';
import { effectiveExpenseStatus } from '../../src/domain/expenseLifecycle.js';
import { registerInventoryRecipes } from './inventory-recipes.js';

const quantity=z.number().finite().min(-1e12).max(1e12).refine(value=>Math.abs(value*1e6-Math.round(value*1e6))<1e-5);
const packaging=z.strictObject({id:v.id.optional(),label:z.string().trim().min(1).max(120),barcode:z.string().trim().max(128).default(''),quantityInBase:quantity.positive()});
const unitCorrection=z.strictObject({strategy:z.enum(['relabel','convert']),conversionFactor:z.number().finite().positive().max(1e9)
  .refine(value=>Math.abs(value*1e9-Math.round(value*1e9))<1e-4),reason:z.string().trim().min(8).max(1000)});
const item=z.strictObject({
  id:v.id.optional(),company_id:v.id.optional(),version:z.number().int().positive().optional(),unitVersion:z.number().int().positive().optional(),
  internalCode:z.string().trim().max(64).optional(),
  name:z.string().trim().min(1).max(120),category:z.string().trim().max(120).default('General'),
  trackingMode:z.enum(['count','weight','volume']),baseUnit:z.string().trim().min(1).max(32),
  barcode:z.string().trim().max(128).default(''),onHand:quantity.nonnegative().default(0),reorderLevel:quantity.nonnegative().default(0),
  preferredSupplierId:z.union([v.id,z.literal('')]).optional(),active:z.boolean().default(true),notes:z.string().trim().max(10000).default(''),
  packagings:z.array(packaging).max(50).default([]),unitCorrection:unitCorrection.optional(),
});
const movement=z.strictObject({kind:z.enum(['receive','count','adjust','consume','waste']),quantity,unitVersion:z.number().int().positive(),packagingId:z.union([v.id,z.literal('')]).optional(),supplierId:z.union([v.id,z.literal('')]).optional(),expenseId:z.union([v.id,z.literal('')]).optional(),reason:z.string().trim().min(3).max(1000),idempotencyKey:z.string().min(8).max(128)});
const baselineItem=z.strictObject({stockItemId:v.id,expectedVersion:z.number().int().positive(),
  unitVersion:z.number().int().positive(),quantity:quantity.nonnegative()});
const baseline=z.strictObject({reason:z.string().trim().min(8).max(1000),idempotencyKey:z.string().min(8).max(128),
  items:z.array(baselineItem).min(1).max(500)});
const key=value=>String(value||'').trim().toLocaleUpperCase();
const number=value=>Number(value);
export const countedQuantitiesValid=values=>values.every(value=>Number.isInteger(number(value)));
const dateOnly=value=>value instanceof Date?value.toISOString().slice(0,10):String(value||'').slice(0,10);

async function supplier(c,companyId,id){
  if(!id)return null;
  const row=(await c.query("SELECT id,data FROM myfin.clients WHERE company_id=$1 AND id=$2 FOR KEY SHARE",[companyId,id])).rows[0];
  if(!row||row.data.type!=='Supplier')v.fail(409,'supplier_not_found');
  return row.data;
}
async function expense(c,companyId,id){
  if(!id)return;
  const row=await c.query('SELECT id FROM myfin.expenses WHERE company_id=$1 AND id=$2 AND voided_at IS NULL FOR KEY SHARE',[companyId,id]);
  if(!row.rowCount)v.fail(409,'expense_not_found');
}
async function packagings(c,companyId,itemIds){
  if(!itemIds.length)return new Map();
  const rows=(await c.query('SELECT * FROM myfin.stock_packagings WHERE company_id=$1 AND item_id=ANY($2::text[]) ORDER BY label,id',[companyId,itemIds])).rows;
  const map=new Map(itemIds.map(id=>[id,[]]));
  for(const row of rows)map.get(row.item_id)?.push({id:row.id,label:row.label,barcode:row.barcode,quantityInBase:number(row.quantity_in_base)});
  return map;
}
const output=(row,packs=[])=>({id:row.id,company_id:row.company_id,internalCode:row.internal_code,name:row.name,category:row.category,trackingMode:row.tracking_mode,baseUnit:row.base_unit,unitVersion:Number(row.unit_version||1),barcode:row.barcode,onHand:number(row.on_hand),reorderLevel:number(row.reorder_level),preferredSupplierId:row.preferred_supplier_id||'',active:row.active,notes:row.notes,version:Number(row.version),packagings:packs});
export const ledgerOutput=row=>({id:row.id,company_id:row.company_id,itemId:row.item_id,actorId:row.actor_id,kind:row.kind,inputQuantity:number(row.input_quantity),delta:number(row.delta),quantityAfter:number(row.quantity_after),packagingId:row.packaging_id||'',supplierId:row.supplier_id||'',expenseId:row.expense_id||'',
  trackingModeAtTime:row.tracking_mode_at_time||'',baseUnitAtTime:row.base_unit_at_time||'',unitVersionAtTime:Number(row.unit_version_at_time||0),packagingLabelAtTime:row.packaging_label_at_time||'',packagingQuantityAtTime:row.packaging_quantity_at_time===null||row.packaging_quantity_at_time===undefined?null:number(row.packaging_quantity_at_time),
  ...(row.expense_id?{expenseDescription:row.expense_description||'',expenseStatus:row.expense_status||'',
    expenseDueDate:dateOnly(row.expense_due_date),expensePaidOn:dateOnly(row.expense_paid_on),
    expenseVoided:Boolean(row.expense_voided_at),expenseEffectiveStatus:row.expense_voided_at?'voided':effectiveExpenseStatus({
      status:row.expense_status,creditDueDate:dateOnly(row.expense_due_date)},businessDate())}:{}),
  reason:row.reason,sourceType:row.source_type||'',sourceId:row.source_id||'',sourceDetails:row.source_details||{},
  baselineId:row.baseline_id||'',createdAt:row.created_at});

const baselineOutput=row=>({id:row.id,company_id:row.company_id,reason:row.reason,itemCount:Number(row.item_count),
  createdBy:row.created_by,createdAt:row.created_at});
const baselineItemOutput=row=>({stockItemId:row.stock_item_id,unitVersion:Number(row.stock_unit_version),
  quantityBefore:number(row.quantity_before),quantityAfter:number(row.quantity_after),movementId:row.ledger_id});

async function ensureCodes(c,companyId,itemId,codes){
  const normalized=codes.filter(Boolean).map(key);
  if(new Set(normalized).size!==normalized.length)v.fail(409,'duplicate_stock_barcode');
  if(!normalized.length)return;
  const conflicts=await c.query(`SELECT barcode AS code FROM myfin.stock_items WHERE company_id=$1 AND id<>$2 AND upper(barcode)=ANY($3::text[])
    UNION ALL SELECT internal_code FROM myfin.stock_items WHERE company_id=$1 AND id<>$2 AND upper(internal_code)=ANY($3::text[])
    UNION ALL SELECT barcode FROM myfin.stock_packagings WHERE company_id=$1 AND item_id<>$2 AND upper(barcode)=ANY($3::text[])
    UNION ALL SELECT normalized_value FROM myfin.stock_identifiers
      WHERE company_id=$1 AND active AND normalized_value=ANY($3::text[])`,[companyId,itemId,normalized]);
  if(conflicts.rowCount)v.fail(409,'duplicate_stock_barcode');
}
export async function nextInternalCode(c,companyId){
  for(let attempt=0;attempt<1000;attempt++){
    const result=await c.query(`INSERT INTO myfin.stock_internal_code_counters(company_id,last_value)
      VALUES($1,1) ON CONFLICT(company_id) DO UPDATE
      SET last_value=myfin.stock_internal_code_counters.last_value+1 RETURNING last_value`,[companyId]);
    const value=BigInt(result.rows[0]?.last_value||1);
    const candidate=`STK-${value.toString().padStart(6,'0')}`;
    const conflict=await c.query(`SELECT 1 FROM myfin.stock_items
        WHERE company_id=$1 AND (upper(barcode)=$2 OR upper(internal_code)=$2)
      UNION ALL SELECT 1 FROM myfin.stock_packagings WHERE company_id=$1 AND upper(barcode)=$2
      UNION ALL SELECT 1 FROM myfin.stock_identifiers
        WHERE company_id=$1 AND active AND normalized_value=$2 LIMIT 1`,[companyId,candidate]);
    if(!conflict.rowCount)return candidate;
  }
  v.fail(409,'stock_internal_code_exhausted');
}
async function reconcilePackagings(c,companyId,itemId,requested,{allowQuantityCorrection=false}={}){
  const prior=(await c.query('SELECT * FROM myfin.stock_packagings WHERE company_id=$1 AND item_id=$2 ORDER BY id FOR UPDATE',[companyId,itemId])).rows;
  const oldById=new Map(prior.map(row=>[row.id,row]));
  const wantedIds=requested.map(pack=>pack.id).filter(Boolean);
  if(new Set(wantedIds).size!==wantedIds.length)v.fail(400,'duplicate_packaging_id');
  if(wantedIds.some(id=>!oldById.has(id)))v.fail(409,'stock_packaging_changed');
  const usedIds=new Set((await c.query('SELECT DISTINCT packaging_id FROM myfin.stock_ledger WHERE company_id=$1 AND item_id=$2 AND packaging_id IS NOT NULL',[companyId,itemId])).rows.map(row=>row.packaging_id));
  for(const old of prior){
    const next=requested.find(pack=>pack.id===old.id);
    if(usedIds.has(old.id)&&(!next||next.label!==old.label||next.barcode!==old.barcode||(!allowQuantityCorrection&&next.quantityInBase!==number(old.quantity_in_base))))v.fail(409,'used_packaging_immutable');
    if(!next)await c.query('DELETE FROM myfin.stock_packagings WHERE company_id=$1 AND item_id=$2 AND id=$3',[companyId,itemId,old.id]);
  }
  for(const old of prior){
    const next=requested.find(pack=>pack.id===old.id);
    if(next&&next.barcode!==old.barcode)await c.query("UPDATE myfin.stock_packagings SET barcode='' WHERE company_id=$1 AND item_id=$2 AND id=$3",[companyId,itemId,old.id]);
  }
  for(const pack of requested){
    if(pack.id&&oldById.has(pack.id)){
      await c.query('UPDATE myfin.stock_packagings SET label=$4,barcode=$5,quantity_in_base=$6 WHERE company_id=$1 AND item_id=$2 AND id=$3',[companyId,itemId,pack.id,pack.label,pack.barcode,pack.quantityInBase]);
    }else await c.query('INSERT INTO myfin.stock_packagings(company_id,item_id,id,label,barcode,quantity_in_base) VALUES($1,$2,$3,$4,$5,$6)',[companyId,itemId,pack.id||randomUUID(),pack.label,pack.barcode,pack.quantityInBase]);
  }
}

const dependencyKeys=['ledger','baselines','recipes','identifiers','purchaseOrders','receipts','batches','weightedCosts','valuationEvents','alerts','reservations','expenses','corrections'];
async function stockDependencies(c,companyId,itemId){
  const row=(await c.query(`SELECT
    (SELECT count(*)::integer FROM myfin.stock_ledger WHERE company_id=$1 AND item_id=$2) AS ledger,
    (SELECT count(*)::integer FROM myfin.stock_baseline_items WHERE company_id=$1 AND stock_item_id=$2) AS baselines,
    (SELECT count(*)::integer FROM myfin.inventory_recipe_components WHERE company_id=$1 AND stock_item_id=$2) AS recipes,
    (SELECT count(*)::integer FROM myfin.stock_identifiers WHERE company_id=$1 AND stock_item_id=$2) AS identifiers,
    (SELECT count(*)::integer FROM myfin.purchase_order_lines WHERE company_id=$1 AND stock_item_id=$2) AS purchase_orders,
    (SELECT count(*)::integer FROM myfin.goods_receipt_lines WHERE company_id=$1 AND stock_item_id=$2) AS receipts,
    (SELECT count(*)::integer FROM myfin.stock_batches WHERE company_id=$1 AND stock_item_id=$2) AS batches,
    (SELECT count(*)::integer FROM myfin.inventory_weighted_costs WHERE company_id=$1 AND stock_item_id=$2) AS weighted_costs,
    (SELECT count(*)::integer FROM myfin.inventory_valuation_events WHERE company_id=$1 AND stock_item_id=$2) AS valuation_events,
    (SELECT count(*)::integer FROM myfin.low_stock_alerts WHERE company_id=$1 AND stock_item_id=$2) AS alerts,
    (SELECT count(*)::integer FROM myfin.customer_order_recipe_reservations WHERE company_id=$1 AND stock_item_id=$2) AS reservations,
    (SELECT count(*)::integer FROM myfin.expense_links WHERE company_id=$1 AND stock_item_id=$2) AS expenses,
    (SELECT count(*)::integer FROM myfin.stock_unit_corrections WHERE company_id=$1 AND stock_item_id=$2) AS corrections`,[companyId,itemId])).rows[0]||{};
  return Object.fromEntries(dependencyKeys.map(key=>[key,Number(row[key.replace(/[A-Z]/g,letter=>`_${letter.toLowerCase()}`)]||0)]));
}
const quantitativeDependencies=dependencies=>['recipes','purchaseOrders','receipts','batches','weightedCosts','valuationEvents','alerts','reservations']
  .filter(key=>dependencies[key]>0);

export function registerStock(app,{scoped,audit}){
  registerInventoryRecipes(app,{scoped,audit});
  app.get('/api/companies/:company/stock_items',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'inventoryRead');
    const query=v.parse(z.strictObject({after:v.id.optional(),limit:z.coerce.number().int().min(1).max(500).default(500)}),req.query);
    const result=await c.query('SELECT * FROM myfin.stock_items WHERE company_id=$1 AND id>$2 ORDER BY id LIMIT $3',[companyId,query.after||'',query.limit+1]);
    const visible=result.rows.slice(0,query.limit),packs=await packagings(c,companyId,visible.map(row=>row.id));
    return {rows:visible.map(row=>output(row,packs.get(row.id))),next:result.rowCount>query.limit?visible.at(-1).id:null};
  }));
  app.get('/api/companies/:company/stock_ledger',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'stockHistoryRead');
    const query=v.parse(z.strictObject({after:v.id.optional(),limit:z.coerce.number().int().min(1).max(500).default(500)}),req.query);
    const result=await c.query(`SELECT sl.*,e.data->>'description' AS expense_description,e.status AS expense_status,
      e.credit_due_date::text AS expense_due_date,e.paid_on::text AS expense_paid_on,e.voided_at AS expense_voided_at
      FROM myfin.stock_ledger sl LEFT JOIN myfin.expenses e
        ON e.company_id=sl.company_id AND e.id=sl.expense_id
      WHERE sl.company_id=$1 AND sl.id>$2 ORDER BY sl.id LIMIT $3`,[companyId,query.after||'',query.limit+1]);
    const visible=result.rows.slice(0,query.limit);
    return {rows:visible.map(ledgerOutput),next:result.rowCount>query.limit?visible.at(-1).id:null};
  }));
  app.get('/api/companies/:company/stock-baselines',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'stockHistoryRead');
    const query=v.parse(z.strictObject({limit:z.coerce.number().int().min(1).max(100).default(25)}),req.query);
    const rows=(await c.query(`SELECT * FROM myfin.stock_baselines
      WHERE company_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`,[companyId,query.limit])).rows;
    return {rows:rows.map(baselineOutput)};
  }));
  app.post('/api/companies/:company/stock-baselines',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'inventoryWrite');
    const data=v.parse(baseline,req.body),ids=data.items.map(row=>row.stockItemId);
    if(new Set(ids).size!==ids.length)v.fail(400,'duplicate_stock_baseline_item');
    const ordered=[...data.items].sort((a,b)=>a.stockItemId.localeCompare(b.stockItemId));
    const requestDigest=createHash('sha256').update(JSON.stringify(canonical({companyId,actorId:req.identity.id,
      reason:data.reason,items:ordered}))).digest('hex');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,23))',[`${companyId}:stock-baseline:${data.idempotencyKey}`]);
    const prior=(await c.query(`SELECT * FROM myfin.stock_baselines
      WHERE company_id=$1 AND idempotency_key=$2`,[companyId,data.idempotencyKey])).rows[0];
    if(prior){
      if(prior.request_digest!==requestDigest)v.fail(409,'stock_baseline_payload_changed');
      const items=(await c.query(`SELECT * FROM myfin.stock_baseline_items
        WHERE company_id=$1 AND baseline_id=$2 ORDER BY stock_item_id`,[companyId,prior.id])).rows;
      return {duplicate:true,baseline:baselineOutput(prior),items:items.map(baselineItemOutput)};
    }
    const stock=(await c.query(`SELECT * FROM myfin.stock_items
      WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE`,[companyId,ordered.map(row=>row.stockItemId)])).rows;
    if(stock.length!==ordered.length||stock.some(row=>!row.active))v.fail(409,'stock_baseline_item_unavailable');
    const requested=new Map(ordered.map(row=>[row.stockItemId,row]));
    for(const row of stock){
      const target=requested.get(row.id);
      if(target.expectedVersion!==Number(row.version))v.fail(409,'stock_item_changed_reload');
      if(target.unitVersion!==Number(row.unit_version))v.fail(409,'stock_unit_changed_reload');
      if(row.tracking_mode==='count'&&!Number.isInteger(target.quantity))v.fail(400,'counted_stock_requires_whole_units');
    }
    const id=randomUUID();
    await c.query(`INSERT INTO myfin.stock_baselines(company_id,id,idempotency_key,request_digest,reason,item_count,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[companyId,id,data.idempotencyKey,requestDigest,data.reason,stock.length,req.identity.id]);
    const items=[];
    for(const row of stock){
      const target=requested.get(row.id),quantityBefore=number(row.on_hand),
        calculated=stockMovement({kind:'count',quantity:target.quantity},quantityBefore);
      const ledgerId=randomUUID(),movementKey=`baseline:${createHash('sha256').update(`${companyId}\u0000${id}\u0000${row.id}`).digest('hex')}`;
      await c.query(`UPDATE myfin.stock_items SET on_hand=$3,version=version+1,updated_at=now()
        WHERE company_id=$1 AND id=$2`,[companyId,row.id,calculated.quantityAfter]);
      await c.query(`INSERT INTO myfin.stock_ledger(company_id,id,item_id,actor_id,kind,input_quantity,delta,quantity_after,
          reason,idempotency_key,request_digest,baseline_id)
        VALUES($1,$2,$3,$4,'count',$5,$6,$7,$8,$9,$10,$11)`,[companyId,ledgerId,row.id,req.identity.id,
        calculated.inputQuantity,calculated.delta,calculated.quantityAfter,data.reason,movementKey,requestDigest,id]);
      await c.query(`INSERT INTO myfin.stock_baseline_items(company_id,baseline_id,stock_item_id,stock_unit_version,
          quantity_before,quantity_after,ledger_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[companyId,id,row.id,target.unitVersion,quantityBefore,calculated.quantityAfter,ledgerId]);
      items.push({stock_item_id:row.id,stock_unit_version:target.unitVersion,quantity_before:quantityBefore,
        quantity_after:calculated.quantityAfter,ledger_id:ledgerId});
    }
    await audit(c,req.identity,companyId,'Record stock baseline',`${id} · ${stock.length} items · ${data.reason}`);
    const created=(await c.query('SELECT * FROM myfin.stock_baselines WHERE company_id=$1 AND id=$2',[companyId,id])).rows[0];
    return {duplicate:false,baseline:baselineOutput(created),items:items.map(baselineItemOutput)};
  }));
  const save=(req,update)=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'inventoryWrite');
    const data=v.parse(item,req.body),id=update?v.parse(v.id,req.params.id):data.id||randomUUID();
    if((data.id&&data.id!==id)||(data.company_id&&data.company_id!==companyId))v.fail(403,'invalid_tenant_or_id');
    if(!update&&data.unitCorrection)v.fail(400,'stock_unit_correction_not_needed');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,9))',[companyId]);
    const current=update?(await c.query('SELECT * FROM myfin.stock_items WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,id])).rows[0]:null;
    if(update&&!current)v.fail(404,'not_found');
    if(update&&data.version!==Number(current.version))v.fail(409,'stock_item_changed');
    if(update&&data.unitVersion!==Number(current.unit_version))v.fail(409,'stock_unit_changed_reload');
    if(update&&data.internalCode&&key(data.internalCode)!==key(current.internal_code))v.fail(409,'stock_internal_code_immutable');
    if(update&&data.onHand!==number(current.on_hand))v.fail(409,'use_stock_movement');
    const unitChanged=Boolean(update&&(data.trackingMode!==current.tracking_mode||data.baseUnit!==current.base_unit));
    if(unitChanged&&!data.unitCorrection)v.fail(409,'stock_unit_correction_required');
    if(!unitChanged&&data.unitCorrection)v.fail(400,'stock_unit_correction_not_needed');
    let unitChange=null;
    if(unitChanged){
      const correction=data.unitCorrection,factor=correction.strategy==='convert'?correction.conversionFactor:1;
      const factorText=factor.toFixed(9);
      if(correction.strategy==='relabel'&&correction.conversionFactor!==1)v.fail(400,'stock_unit_relabel_factor_must_be_one');
      if(data.reorderLevel!==number(current.reorder_level))v.fail(409,'save_unit_correction_separately_from_reorder_change');
      if(data.name!==current.name||data.category!==current.category||data.barcode!==current.barcode||
        (data.preferredSupplierId||null)!==(current.preferred_supplier_id||null)||data.active!==current.active||data.notes!==current.notes)
        v.fail(409,'save_unit_correction_separately_from_item_changes');
      const priorPacks=(await c.query('SELECT * FROM myfin.stock_packagings WHERE company_id=$1 AND item_id=$2 ORDER BY id FOR UPDATE',[companyId,id])).rows;
      const requestedById=new Map(data.packagings.filter(pack=>pack.id).map(pack=>[pack.id,pack]));
      if(requestedById.size!==priorPacks.length||priorPacks.some(pack=>{
        const requested=requestedById.get(pack.id);
        return !requested||requested.label!==pack.label||requested.barcode!==pack.barcode||requested.quantityInBase!==number(pack.quantity_in_base);
      }))v.fail(409,'save_unit_correction_separately_from_packaging_changes');
      const dependencies=await stockDependencies(c,companyId,id);
      if(data.trackingMode!==current.tracking_mode){
        const blocked=quantitativeDependencies(dependencies);
        if(blocked.length)v.fail(409,`stock_tracking_mode_correction_blocked_${blocked.join('_')}`);
      }
      if(correction.strategy==='convert'){
        const blocked=quantitativeDependencies(dependencies);
        if(blocked.length)v.fail(409,`stock_unit_conversion_blocked_${blocked.join('_')}`);
      }
      const calculated=(await c.query(`SELECT on_hand::text AS on_hand_before,reorder_level::text AS reorder_before,
        round(on_hand*$3::numeric,6)::text AS on_hand_after,
        round(reorder_level*$3::numeric,6)::text AS reorder_after,
        round(on_hand*$3::numeric,6)=trunc(round(on_hand*$3::numeric,6)) AS on_hand_whole,
        round(reorder_level*$3::numeric,6)=trunc(round(reorder_level*$3::numeric,6)) AS reorder_whole,
        round(on_hand*$3::numeric,6) BETWEEN 0 AND 999999999999.999999::numeric
          AND round(reorder_level*$3::numeric,6) BETWEEN 0 AND 999999999999.999999::numeric AS valid
        FROM myfin.stock_items WHERE company_id=$1 AND id=$2`,[companyId,id,factorText])).rows[0];
      const convertedPacks=(await c.query(`SELECT id,label,barcode,quantity_in_base::text AS quantity_before,
        round(quantity_in_base*$3::numeric,6)::text AS quantity_after,
        round(quantity_in_base*$3::numeric,6)=trunc(round(quantity_in_base*$3::numeric,6)) AS quantity_whole,
        round(quantity_in_base*$3::numeric,6)>0
          AND round(quantity_in_base*$3::numeric,6)<=999999999999.999999::numeric AS valid
        FROM myfin.stock_packagings WHERE company_id=$1 AND item_id=$2 ORDER BY id`,[companyId,id,factorText])).rows;
      if(!calculated?.valid||convertedPacks.some(pack=>!pack.valid))v.fail(400,'stock_unit_conversion_out_of_range');
      const onHandAfter=calculated.on_hand_after,reorderAfter=calculated.reorder_after;
      data.onHand=number(onHandAfter);data.reorderLevel=number(reorderAfter);
      unitChange={id:randomUUID(),strategy:correction.strategy,factor:Number(factorText),factorText,reason:correction.reason,
        fromTrackingMode:current.tracking_mode,fromBaseUnit:current.base_unit,fromUnitVersion:Number(current.unit_version||1),
        onHandBefore:calculated.on_hand_before,onHandAfter,reorderBefore:calculated.reorder_before,reorderAfter,
        countQuantitiesWhole:calculated.on_hand_whole===true&&calculated.reorder_whole===true&&convertedPacks.every(pack=>pack.quantity_whole===true),
        packagingBefore:convertedPacks.map(pack=>({id:pack.id,label:pack.label,barcode:pack.barcode,quantityInBase:pack.quantity_before})),
        packagingAfter:convertedPacks.map(pack=>({id:pack.id,label:pack.label,barcode:pack.barcode,quantityInBase:pack.quantity_after}))};
    }
    if(data.trackingMode==='count'&&!(unitChange?unitChange.countQuantitiesWhole:
      countedQuantitiesValid([data.onHand,data.reorderLevel,...data.packagings.map(pack=>pack.quantityInBase)])))v.fail(400,'counted_stock_requires_whole_units');
    const internalCode=update?current.internal_code:await nextInternalCode(c,companyId);
    await supplier(c,companyId,data.preferredSupplierId);
    await ensureCodes(c,companyId,id,[internalCode,data.barcode,...data.packagings.map(row=>row.barcode)]);
    if(update)await c.query(`UPDATE myfin.stock_items SET name=$3,category=$4,tracking_mode=$5,base_unit=$6,barcode=$7,
      on_hand=CASE WHEN $13='convert' THEN round(on_hand*$14::numeric,6) ELSE on_hand END,
      reorder_level=CASE WHEN $13='convert' THEN round(reorder_level*$14::numeric,6) WHEN $13='relabel' THEN reorder_level ELSE $8 END,
      preferred_supplier_id=$9,active=$10,notes=$11,version=version+1,unit_version=unit_version+$12,updated_at=now() WHERE company_id=$1 AND id=$2`,[companyId,id,data.name,data.category,data.trackingMode,data.baseUnit,data.barcode,data.reorderLevel,data.preferredSupplierId||null,data.active,data.notes,unitChanged?1:0,unitChange?.strategy||'',unitChange?.factorText||'1.000000000']);
    else await c.query(`INSERT INTO myfin.stock_items(company_id,id,internal_code,name,category,tracking_mode,base_unit,barcode,on_hand,reorder_level,preferred_supplier_id,active,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[companyId,id,internalCode,data.name,data.category,data.trackingMode,data.baseUnit,data.barcode,data.onHand,data.reorderLevel,data.preferredSupplierId||null,data.active,data.notes]);
    if(!unitChanged)await reconcilePackagings(c,companyId,id,data.packagings);
    if(unitChange?.strategy==='convert')await c.query(`UPDATE myfin.stock_packagings SET quantity_in_base=round(quantity_in_base*$3::numeric,6)
      WHERE company_id=$1 AND item_id=$2`,[companyId,id,unitChange.factorText]);
    if(unitChange)await c.query(`INSERT INTO myfin.stock_unit_corrections(company_id,id,stock_item_id,actor_id,
      from_tracking_mode,from_base_unit,from_unit_version,to_tracking_mode,to_base_unit,to_unit_version,
      strategy,conversion_factor,on_hand_before,on_hand_after,reorder_level_before,reorder_level_after,
      packagings_before,packagings_after,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,[companyId,unitChange.id,id,req.identity.id,
      unitChange.fromTrackingMode,unitChange.fromBaseUnit,unitChange.fromUnitVersion,data.trackingMode,data.baseUnit,unitChange.fromUnitVersion+1,
      unitChange.strategy,unitChange.factorText,unitChange.onHandBefore,unitChange.onHandAfter,unitChange.reorderBefore,unitChange.reorderAfter,
      JSON.stringify(unitChange.packagingBefore),JSON.stringify(unitChange.packagingAfter),unitChange.reason]);
    if(!update&&data.onHand>0){
      const openingId=randomUUID(),openingDigest=createHash('sha256').update(JSON.stringify(canonical({kind:'opening',itemId:id,actorId:req.identity.id,quantity:data.onHand}))).digest('hex');
      await c.query(`INSERT INTO myfin.stock_ledger(company_id,id,item_id,actor_id,kind,input_quantity,delta,quantity_after,reason,idempotency_key,request_digest)
        VALUES($1,$2,$3,$4,'adjust',$5,$5,$5,'Opening balance',$2,$6)`,[companyId,openingId,id,req.identity.id,data.onHand,openingDigest]);
    }
    await audit(c,req.identity,companyId,unitChange?'Correct stock measurement':update?'Update stock item':'Create stock item',
      unitChange?`${id} · ${unitChange.fromTrackingMode}/${unitChange.fromBaseUnit} → ${data.trackingMode}/${data.baseUnit} · ${unitChange.strategy} × ${unitChange.factor} · ${unitChange.reason}`:id);
    const row=(await c.query('SELECT * FROM myfin.stock_items WHERE company_id=$1 AND id=$2',[companyId,id])).rows[0],packs=await packagings(c,companyId,[id]);
    return output(row,packs.get(id));
  });
  app.post('/api/companies/:company/stock_items',req=>save(req,false));
  app.put('/api/companies/:company/stock_items/:id',req=>save(req,true));
  app.get('/api/companies/:company/stock_items/:id/purge-check',req=>scoped(req,async(c,companyId)=>{
    if(!owner(req.identity))v.fail(403,'workspace_owner_required');
    const id=v.parse(v.id,req.params.id),row=(await c.query(
      'SELECT id,name,active,on_hand FROM myfin.stock_items WHERE company_id=$1 AND id=$2',[companyId,id])).rows[0];
    if(!row)v.fail(404,'not_found');
    const dependencies=await stockDependencies(c,companyId,id),blocked=dependencyKeys.filter(key=>dependencies[key]>0);
    return {id,name:row.name,archived:!row.active,onHand:number(row.on_hand),dependencies,blocked,
      canPurge:!row.active&&number(row.on_hand)===0&&!blocked.length};
  }));
  app.delete('/api/companies/:company/stock_items/:id/purge',req=>scoped(req,async(c,companyId)=>{
    if(!owner(req.identity))v.fail(403,'workspace_owner_required');
    const id=v.parse(v.id,req.params.id);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,9))',[companyId]);
    const row=(await c.query('SELECT id,name,active,on_hand FROM myfin.stock_items WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,id])).rows[0];
    if(!row)v.fail(404,'not_found');
    if(row.active)v.fail(409,'archive_stock_item_before_purge');
    if(number(row.on_hand)!==0)v.fail(409,'zero_stock_balance_before_purge');
    const dependencies=await stockDependencies(c,companyId,id);
    if(dependencyKeys.some(key=>dependencies[key]>0))v.fail(409,'stock_item_has_audit_dependencies');
    await c.query('DELETE FROM myfin.stock_items WHERE company_id=$1 AND id=$2',[companyId,id]);
    await audit(c,req.identity,companyId,'Purge unused stock item',`${id} · ${row.name}`);
    return {ok:true,id};
  }));
  app.delete('/api/companies/:company/stock_items/:id',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'inventoryWrite');const id=v.parse(v.id,req.params.id);
    const result=await c.query('UPDATE myfin.stock_items SET active=false,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING id',[companyId,id]);
    if(!result.rowCount)v.fail(404,'not_found');await audit(c,req.identity,companyId,'Archive stock item',id);return {ok:true};
  }));
  app.post('/api/companies/:company/stock_items/:id/movements',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'inventoryTransact');const itemId=v.parse(v.id,req.params.id),data=v.parse(movement,req.body);
    const digest=createHash('sha256').update(JSON.stringify(canonical({itemId,actorId:req.identity.id,data}))).digest('hex');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,10))',[companyId+':stock-movement:'+data.idempotencyKey]);
    const duplicate=(await c.query('SELECT * FROM myfin.stock_ledger WHERE company_id=$1 AND idempotency_key=$2',[companyId,data.idempotencyKey])).rows[0];
    if(duplicate){if(duplicate.request_digest!==digest)v.fail(409,'stock_movement_payload_changed');return {duplicate:true,movement:ledgerOutput(duplicate)};}
    const row=(await c.query('SELECT * FROM myfin.stock_items WHERE company_id=$1 AND id=$2 AND active FOR UPDATE',[companyId,itemId])).rows[0];
    if(!row)v.fail(404,'stock_item_not_found');
    if(data.unitVersion!==Number(row.unit_version))v.fail(409,'stock_unit_changed_reload');
    let factor=1,packagingId=data.packagingId||null;
    if(packagingId){const pack=(await c.query('SELECT quantity_in_base FROM myfin.stock_packagings WHERE company_id=$1 AND item_id=$2 AND id=$3 FOR KEY SHARE',[companyId,itemId,packagingId])).rows[0];if(!pack)v.fail(404,'stock_packaging_not_found');factor=number(pack.quantity_in_base);}
    if(row.tracking_mode==='count'&&(!Number.isInteger(data.quantity)||!Number.isInteger(data.quantity*factor)))v.fail(400,'counted_stock_requires_whole_units');
    await supplier(c,companyId,data.supplierId);await expense(c,companyId,data.expenseId);
    const calculated=stockMovement({kind:data.kind,quantity:data.quantity*factor},number(row.on_hand));
    const id=randomUUID();
    await c.query('UPDATE myfin.stock_items SET on_hand=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2',[companyId,itemId,calculated.quantityAfter]);
    const inserted=(await c.query(`INSERT INTO myfin.stock_ledger(company_id,id,item_id,actor_id,kind,input_quantity,delta,quantity_after,packaging_id,supplier_id,expense_id,reason,idempotency_key,request_digest)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[companyId,id,itemId,req.identity.id,data.kind,calculated.inputQuantity,calculated.delta,calculated.quantityAfter,packagingId,data.supplierId||null,data.expenseId||null,data.reason,data.idempotencyKey,digest])).rows[0];
    await audit(c,req.identity,companyId,'Stock '+data.kind,`${itemId} · ${calculated.delta}`);
    return {duplicate:false,movement:ledgerOutput(inserted),item:{id:itemId,onHand:calculated.quantityAfter,version:Number(row.version)+1}};
  }));
}
