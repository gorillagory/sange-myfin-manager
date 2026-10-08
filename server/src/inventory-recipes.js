import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonical, normalizeProduct } from '../../src/domain/pos.js';
import { aggregateRecipeConsumption, normalizeRecipeDraft, recipeAvailability } from '../../src/domain/inventoryRecipes.js';
import { requireCapability } from './access.js';
import * as v from './validation.js';

const componentSchema=z.strictObject({stockItemId:v.id,quantityPerUnit:z.number().finite().positive().max(1e12)
  .refine(value=>Math.abs(value*1e6-Math.round(value*1e6))<1e-5)});
const recipeSchema=z.strictObject({productId:v.id,variantId:z.union([v.id,z.literal('')]).default(''),
  version:z.number().int().min(0),enabled:z.boolean(),components:z.array(componentSchema).max(50)});
const number=value=>Number(value);
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sourceKey=(companyId,saleId)=>`${companyId}:inventory-recipe:pos:${saleId}`;
const movementKey=(companyId,saleId,itemId)=>`pos:${createHash('sha256').update(`${companyId}\u0000${saleId}\u0000${itemId}`).digest('hex')}`;
export const catalogTracksStock=product=>normalizeProduct(product||{}).trackStock===true;

const ledgerOutput=row=>({id:row.id,company_id:row.company_id,itemId:row.item_id,actorId:row.actor_id,
  kind:row.kind,inputQuantity:number(row.input_quantity),delta:number(row.delta),quantityAfter:number(row.quantity_after),
  packagingId:row.packaging_id||'',supplierId:row.supplier_id||'',expenseId:row.expense_id||'',reason:row.reason,
  sourceType:row.source_type||'',sourceId:row.source_id||'',sourceDetails:row.source_details||{},createdAt:row.created_at});

async function recipeRows(c,companyId){
  const recipes=(await c.query(`SELECT r.*,p.data AS product_data
    FROM myfin.inventory_recipes r JOIN myfin.products p ON p.company_id=r.company_id AND p.id=r.product_id
    WHERE r.company_id=$1 ORDER BY p.data->>'name',r.product_id,r.variant_id NULLS FIRST`,[companyId])).rows;
  if(!recipes.length)return [];
  const components=(await c.query(`SELECT c.*,s.name AS stock_item_name,s.base_unit,s.on_hand,s.active
    FROM myfin.inventory_recipe_components c
    JOIN myfin.inventory_recipes r ON r.company_id=c.company_id AND r.id=c.recipe_id AND r.version=c.recipe_version
    JOIN myfin.stock_items s ON s.company_id=c.company_id AND s.id=c.stock_item_id
    WHERE c.company_id=$1 ORDER BY c.recipe_id,c.position`,[companyId])).rows;
  const byRecipe=new Map();
  for(const row of components){
    if(!byRecipe.has(row.recipe_id))byRecipe.set(row.recipe_id,[]);
    byRecipe.get(row.recipe_id).push({stockItemId:row.stock_item_id,quantityPerUnit:number(row.quantity_per_unit),
      stockItemName:row.stock_item_name,baseUnit:row.base_unit,onHand:number(row.on_hand),active:row.active});
  }
  return recipes.map(row=>{
    const parts=byRecipe.get(row.id)||[],product=row.product_data||{},variant=(product.variants||[]).find(item=>item.id===row.variant_id);
    return {id:row.id,productId:row.product_id,variantId:row.variant_id||'',version:Number(row.version),enabled:row.enabled,
      productName:String(product.name||row.product_id),variantName:String(variant?.name||''),catalogTrackStock:catalogTracksStock(product),
      components:parts,availability:recipeAvailability(parts,parts.map(part=>({id:part.stockItemId,onHand:part.onHand,active:part.active})))};
  });
}

async function recipeOutput(c,companyId,recipeId){
  const rows=await recipeRows(c,companyId),found=rows.find(row=>row.id===recipeId);
  if(!found)v.fail(404,'inventory_recipe_not_found');
  return found;
}

async function saveRecipe(c,who,companyId,input,audit){
  let data;
  try{data=normalizeRecipeDraft(v.parse(recipeSchema,input));}catch(error){
    if(error?.statusCode)throw error;
    v.fail(400,'invalid_inventory_recipe');
  }
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,21))',[`${companyId}:recipe:${data.productId}:${data.variantId}`]);
  const product=(await c.query('SELECT * FROM myfin.products WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,data.productId])).rows[0];
  if(!product)v.fail(404,'product_not_found');
  if(data.variantId){
    const variant=await c.query('SELECT id FROM myfin.product_variants WHERE company_id=$1 AND product_id=$2 AND id=$3 FOR KEY SHARE',[companyId,data.productId,data.variantId]);
    if(!variant.rowCount)v.fail(404,'variant_not_found');
  }
  const componentIds=[...new Set(data.components.map(row=>row.stockItemId))].sort();
  if(componentIds.length!==data.components.length)v.fail(400,'duplicate_recipe_stock_item');
  const stock=componentIds.length?(await c.query('SELECT id,active FROM myfin.stock_items WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[companyId,componentIds])).rows:[];
  if(stock.length!==componentIds.length)v.fail(404,'stock_item_not_found');
  if(stock.some(row=>!row.active))v.fail(409,'stock_item_archived');
  if(data.enabled&&!data.components.length)v.fail(400,'recipe_components_required');
  if(data.enabled&&catalogTracksStock(product.data))v.fail(409,'recipe_requires_catalog_stock_disabled');

  const current=(await c.query(`SELECT * FROM myfin.inventory_recipes WHERE company_id=$1 AND product_id=$2
    AND coalesce(variant_id,'')=$3 FOR UPDATE`,[companyId,data.productId,data.variantId])).rows[0];
  if((current&&data.version!==Number(current.version))||(!current&&data.version!==0))v.fail(409,'inventory_recipe_changed');
  const id=current?.id||randomUUID(),nextVersion=current?Number(current.version)+1:1;
  if(current)await c.query(`UPDATE myfin.inventory_recipes SET enabled=$3,version=$4,updated_by=$5,updated_at=now()
    WHERE company_id=$1 AND id=$2`,[companyId,id,data.enabled,nextVersion,who.id]);
  else await c.query(`INSERT INTO myfin.inventory_recipes(company_id,id,product_id,variant_id,enabled,version,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[companyId,id,data.productId,data.variantId||null,data.enabled,nextVersion,who.id]);
  const requestDigest=digest({productId:data.productId,variantId:data.variantId,enabled:data.enabled,components:data.components});
  await c.query(`INSERT INTO myfin.inventory_recipe_versions(company_id,recipe_id,version,enabled,catalog_stock_disabled,request_digest,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[companyId,id,nextVersion,data.enabled,!catalogTracksStock(product.data),requestDigest,who.id]);
  for(let position=0;position<data.components.length;position++){
    const component=data.components[position];
    await c.query(`INSERT INTO myfin.inventory_recipe_components(company_id,recipe_id,recipe_version,stock_item_id,position,quantity_per_unit)
      VALUES($1,$2,$3,$4,$5,$6)`,[companyId,id,nextVersion,component.stockItemId,position,component.quantityPerUnit]);
  }
  await audit(c,who,companyId,data.enabled?'Enable inventory recipe':'Save inventory recipe',`${data.productId}${data.variantId?` · ${data.variantId}`:''} · v${nextVersion}`);
  return recipeOutput(c,companyId,id);
}

export function registerInventoryRecipes(app,{scoped,audit}){
  app.get('/api/companies/:company/inventory-recipes',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'inventoryWrite');
    return {rows:await recipeRows(c,companyId)};
  }));
  app.put('/api/companies/:company/inventory-recipes',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'inventoryWrite');
    return saveRecipe(c,req.identity,companyId,req.body,audit);
  }));
}

// Must run inside the same database transaction that persists the POS sale.
// No commit/rollback is performed here. A source marker makes an unconfigured
// sale a durable no-op, so enabling a recipe later cannot consume it on retry.
export async function consumeRecipeStock(c,{companyId,actorId,saleId,occurredAt,items}){
  const occurred=new Date(occurredAt);
  if(!companyId||!actorId||!saleId||typeof occurredAt!=='string'||!occurredAt.includes('T')||!Number.isFinite(occurred.getTime())||!Array.isArray(items)||!items.length)v.fail(400,'invalid_recipe_sale');
  const effectiveAt=occurred.toISOString();
  const saleItems=items.map(item=>({productId:String(item.productId||''),variantId:String(item.variantId||''),qty:Number(item.qty)}));
  const requestDigest=digest({companyId,actorId,saleId,occurredAt:effectiveAt,items:saleItems});
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,22))',[sourceKey(companyId,saleId)]);
  const prior=(await c.query(`SELECT request_digest,details FROM myfin.inventory_source_effects
    WHERE company_id=$1 AND source_type='pos_sale' AND source_id=$2 FOR UPDATE`,[companyId,saleId])).rows[0];
  if(prior){
    if(prior.request_digest!==requestDigest)v.fail(409,'inventory_source_payload_changed');
    const rows=(await c.query(`SELECT * FROM myfin.stock_ledger WHERE company_id=$1 AND source_type='pos_sale' AND source_id=$2 ORDER BY item_id`,[companyId,saleId])).rows;
    return {duplicate:true,matchedLines:Number(prior.details?.matchedLines||0),
      unconfiguredLines:Number(prior.details?.unconfiguredLines||0),movements:rows.map(ledgerOutput)};
  }

  const productIds=[...new Set(saleItems.map(item=>item.productId))].filter(Boolean).sort();
  if(productIds.length!==new Set(saleItems.map(item=>item.productId)).size)v.fail(400,'invalid_recipe_sale');
  // Recipe versions become effective at their database creation time. This is
  // intentionally compared with the validated sale occurrence time: an offline
  // sale made before enablement remains a no-op even if it synchronizes later.
  const rows=productIds.length?(await c.query(`SELECT r.id,r.product_id,coalesce(r.variant_id,'') AS variant_id,
      effective.version,effective.enabled,effective.catalog_stock_disabled,c.stock_item_id,c.quantity_per_unit
    FROM myfin.inventory_recipes r
    JOIN LATERAL (SELECT rv.version,rv.enabled,rv.catalog_stock_disabled FROM myfin.inventory_recipe_versions rv
      WHERE rv.company_id=r.company_id AND rv.recipe_id=r.id AND rv.created_at<=$3::timestamptz
      ORDER BY rv.created_at DESC,rv.version DESC LIMIT 1) effective ON effective.enabled
    JOIN myfin.inventory_recipe_components c ON c.company_id=r.company_id AND c.recipe_id=r.id AND c.recipe_version=effective.version
    WHERE r.company_id=$1 AND r.product_id=ANY($2::text[])
    ORDER BY r.product_id,r.variant_id NULLS FIRST,r.id,c.position`,[companyId,productIds,effectiveAt])).rows:[];
  const recipes=new Map();
  for(const row of rows){
    if(!row.catalog_stock_disabled)v.fail(409,'recipe_double_stock_tracking');
    if(!recipes.has(row.id))recipes.set(row.id,{id:row.id,productId:row.product_id,variantId:row.variant_id,
      version:Number(row.version),enabled:true,components:[]});
    recipes.get(row.id).components.push({stockItemId:row.stock_item_id,quantityPerUnit:number(row.quantity_per_unit)});
  }
  let aggregate;
  try{aggregate=aggregateRecipeConsumption(saleItems,[...recipes.values()]);}
  catch{v.fail(400,'invalid_recipe_sale');}
  const stockIds=aggregate.consumptions.map(row=>row.stockItemId);
  const stockRows=stockIds.length?(await c.query(`SELECT * FROM myfin.stock_items WHERE company_id=$1 AND id=ANY($2::text[])
    ORDER BY id FOR UPDATE`,[companyId,stockIds])).rows:[];
  if(stockRows.length!==stockIds.length)v.fail(409,'recipe_stock_changed');
  const planned=aggregate.consumptions.map(consumption=>{
    const stock=stockRows.find(row=>row.id===consumption.stockItemId);
    if(!stock?.active)v.fail(409,'recipe_stock_changed');
    if(stock.tracking_mode==='count'&&!Number.isInteger(consumption.quantity))v.fail(409,'recipe_count_requires_whole_units');
    const after=Math.round((number(stock.on_hand)-consumption.quantity)*1e6)/1e6;
    if(after<0)v.fail(409,'recipe_stock_unavailable');
    return {consumption,stock,after};
  });
  const movements=[];
  for(const {consumption,stock,after} of planned){
    const id=randomUUID(),details={recipes:consumption.contributions};
    await c.query('UPDATE myfin.stock_items SET on_hand=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2',[companyId,stock.id,after]);
    const inserted=(await c.query(`INSERT INTO myfin.stock_ledger(company_id,id,item_id,actor_id,kind,input_quantity,delta,quantity_after,
        reason,idempotency_key,request_digest,source_type,source_id,source_details)
      VALUES($1,$2,$3,$4,'consume',$5,$6,$7,$8,$9,$10,'pos_sale',$11,$12) RETURNING *`,
    [companyId,id,stock.id,actorId,consumption.quantity,-consumption.quantity,after,
      `Automatic recipe consumption for sale ${saleId}`,movementKey(companyId,saleId,stock.id),requestDigest,saleId,details])).rows[0];
    movements.push(ledgerOutput(inserted));
  }
  const details={occurredAt:effectiveAt,matchedLines:aggregate.matchedLines,unconfiguredLines:saleItems.length-aggregate.matchedLines,stockItemCount:movements.length};
  await c.query(`INSERT INTO myfin.inventory_source_effects(company_id,source_type,source_id,actor_id,request_digest,details)
    VALUES($1,'pos_sale',$2,$3,$4,$5)`,[companyId,saleId,actorId,requestDigest,details]);
  return {duplicate:false,...details,movements};
}

export { recipeRows, saveRecipe };
