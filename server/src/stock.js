import { randomUUID,createHash } from 'node:crypto';
import { z } from 'zod';
import * as v from './validation.js';
import { requireCapability } from './access.js';
import { stockMovement } from '../../src/domain/stock.js';
import { canonical } from '../../src/domain/pos.js';

const quantity=z.number().finite().min(-1e12).max(1e12).refine(value=>Math.abs(value*1e6-Math.round(value*1e6))<1e-5);
const packaging=z.strictObject({id:v.id.optional(),label:z.string().trim().min(1).max(120),barcode:z.string().trim().max(128).default(''),quantityInBase:quantity.positive()});
const item=z.strictObject({
  id:v.id.optional(),company_id:v.id.optional(),version:z.number().int().positive().optional(),
  name:z.string().trim().min(1).max(120),category:z.string().trim().max(120).default('General'),
  trackingMode:z.enum(['count','weight','volume']),baseUnit:z.string().trim().min(1).max(32),
  barcode:z.string().trim().max(128).default(''),onHand:quantity.nonnegative().default(0),reorderLevel:quantity.nonnegative().default(0),
  preferredSupplierId:z.union([v.id,z.literal('')]).optional(),active:z.boolean().default(true),notes:z.string().trim().max(10000).default(''),
  packagings:z.array(packaging).max(50).default([]),
});
const movement=z.strictObject({kind:z.enum(['receive','count','adjust','consume','waste']),quantity,packagingId:z.union([v.id,z.literal('')]).optional(),supplierId:z.union([v.id,z.literal('')]).optional(),expenseId:z.union([v.id,z.literal('')]).optional(),reason:z.string().trim().min(3).max(1000),idempotencyKey:z.string().min(8).max(128)});
const key=value=>String(value||'').trim().toLocaleUpperCase();
const number=value=>Number(value);

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
const output=(row,packs=[])=>({id:row.id,company_id:row.company_id,name:row.name,category:row.category,trackingMode:row.tracking_mode,baseUnit:row.base_unit,barcode:row.barcode,onHand:number(row.on_hand),reorderLevel:number(row.reorder_level),preferredSupplierId:row.preferred_supplier_id||'',active:row.active,notes:row.notes,version:Number(row.version),packagings:packs});
const ledgerOutput=row=>({id:row.id,company_id:row.company_id,itemId:row.item_id,actorId:row.actor_id,kind:row.kind,inputQuantity:number(row.input_quantity),delta:number(row.delta),quantityAfter:number(row.quantity_after),packagingId:row.packaging_id||'',supplierId:row.supplier_id||'',expenseId:row.expense_id||'',reason:row.reason,createdAt:row.created_at});

async function ensureCodes(c,companyId,itemId,codes){
  const normalized=codes.filter(Boolean).map(key);
  if(new Set(normalized).size!==normalized.length)v.fail(409,'duplicate_stock_barcode');
  if(!normalized.length)return;
  const conflicts=await c.query(`SELECT barcode FROM myfin.stock_items WHERE company_id=$1 AND id<>$2 AND upper(barcode)=ANY($3::text[])
    UNION ALL SELECT barcode FROM myfin.stock_packagings WHERE company_id=$1 AND item_id<>$2 AND upper(barcode)=ANY($3::text[])`,[companyId,itemId,normalized]);
  if(conflicts.rowCount)v.fail(409,'duplicate_stock_barcode');
}
async function reconcilePackagings(c,companyId,itemId,requested){
  const prior=(await c.query('SELECT * FROM myfin.stock_packagings WHERE company_id=$1 AND item_id=$2 ORDER BY id FOR UPDATE',[companyId,itemId])).rows;
  const oldById=new Map(prior.map(row=>[row.id,row]));
  const wantedIds=requested.map(pack=>pack.id).filter(Boolean);
  if(new Set(wantedIds).size!==wantedIds.length)v.fail(400,'duplicate_packaging_id');
  if(wantedIds.some(id=>!oldById.has(id)))v.fail(409,'stock_packaging_changed');
  const usedIds=new Set((await c.query('SELECT DISTINCT packaging_id FROM myfin.stock_ledger WHERE company_id=$1 AND item_id=$2 AND packaging_id IS NOT NULL',[companyId,itemId])).rows.map(row=>row.packaging_id));
  for(const old of prior){
    const next=requested.find(pack=>pack.id===old.id);
    if(usedIds.has(old.id)&&(!next||next.label!==old.label||next.barcode!==old.barcode||next.quantityInBase!==number(old.quantity_in_base)))v.fail(409,'used_packaging_immutable');
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

export function registerStock(app,{scoped,audit}){
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
    const result=await c.query('SELECT * FROM myfin.stock_ledger WHERE company_id=$1 AND id>$2 ORDER BY id LIMIT $3',[companyId,query.after||'',query.limit+1]);
    const visible=result.rows.slice(0,query.limit);
    return {rows:visible.map(ledgerOutput),next:result.rowCount>query.limit?visible.at(-1).id:null};
  }));
  const save=(req,update)=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'inventoryWrite');
    const data=v.parse(item,req.body),id=update?v.parse(v.id,req.params.id):data.id||randomUUID();
    if((data.id&&data.id!==id)||(data.company_id&&data.company_id!==companyId))v.fail(403,'invalid_tenant_or_id');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,9))',[companyId]);
    const current=update?(await c.query('SELECT * FROM myfin.stock_items WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,id])).rows[0]:null;
    if(update&&!current)v.fail(404,'not_found');
    if(update&&data.version!==Number(current.version))v.fail(409,'stock_item_changed');
    if(update&&data.onHand!==number(current.on_hand))v.fail(409,'use_stock_movement');
    if(update&&(data.trackingMode!==current.tracking_mode||data.baseUnit!==current.base_unit)){
      const used=await c.query('SELECT 1 FROM myfin.stock_ledger WHERE company_id=$1 AND item_id=$2 LIMIT 1',[companyId,id]);
      if(used.rowCount)v.fail(409,'stock_unit_immutable_after_movements');
    }
    if(data.trackingMode==='count'&&(!Number.isInteger(data.onHand)||!Number.isInteger(data.reorderLevel)||data.packagings.some(pack=>!Number.isInteger(pack.quantityInBase))))v.fail(400,'counted_stock_requires_whole_units');
    await supplier(c,companyId,data.preferredSupplierId);
    await ensureCodes(c,companyId,id,[data.barcode,...data.packagings.map(row=>row.barcode)]);
    if(update)await c.query(`UPDATE myfin.stock_items SET name=$3,category=$4,tracking_mode=$5,base_unit=$6,barcode=$7,reorder_level=$8,
      preferred_supplier_id=$9,active=$10,notes=$11,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2`,[companyId,id,data.name,data.category,data.trackingMode,data.baseUnit,data.barcode,data.reorderLevel,data.preferredSupplierId||null,data.active,data.notes]);
    else await c.query(`INSERT INTO myfin.stock_items(company_id,id,name,category,tracking_mode,base_unit,barcode,on_hand,reorder_level,preferred_supplier_id,active,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[companyId,id,data.name,data.category,data.trackingMode,data.baseUnit,data.barcode,data.onHand,data.reorderLevel,data.preferredSupplierId||null,data.active,data.notes]);
    await reconcilePackagings(c,companyId,id,data.packagings);
    if(!update&&data.onHand>0){
      const openingId=randomUUID(),openingDigest=createHash('sha256').update(JSON.stringify(canonical({kind:'opening',itemId:id,actorId:req.identity.id,quantity:data.onHand}))).digest('hex');
      await c.query(`INSERT INTO myfin.stock_ledger(company_id,id,item_id,actor_id,kind,input_quantity,delta,quantity_after,reason,idempotency_key,request_digest)
        VALUES($1,$2,$3,$4,'adjust',$5,$5,$5,'Opening balance',$2,$6)`,[companyId,openingId,id,req.identity.id,data.onHand,openingDigest]);
    }
    await audit(c,req.identity,companyId,update?'Update stock item':'Create stock item',id);
    const row=(await c.query('SELECT * FROM myfin.stock_items WHERE company_id=$1 AND id=$2',[companyId,id])).rows[0],packs=await packagings(c,companyId,[id]);
    return output(row,packs.get(id));
  });
  app.post('/api/companies/:company/stock_items',req=>save(req,false));
  app.put('/api/companies/:company/stock_items/:id',req=>save(req,true));
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
