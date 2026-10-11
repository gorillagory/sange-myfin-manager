import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonical, normalizeProduct } from '../../src/domain/pos.js';
import { normalizeRecipeDraft, recipeAvailability, validateRecipeStockUnits } from '../../src/domain/inventoryRecipes.js';
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

const POWERS=Object.freeze([1n,10n,100n,1000n,10000n,100000n,1000000n]);
function scaled(value,digits,code='invalid_recipe_quantity'){
  let text=String(value??'').trim();
  if(/[eE]/.test(text)){
    const numeric=Number(text);
    if(!Number.isFinite(numeric))v.fail(400,code);
    text=numeric.toFixed(digits);
  }
  const match=/^(\d+)(?:\.(\d+))?$/.exec(text);
  if(!match)v.fail(400,code);
  const fraction=match[2]||'';
  if(fraction.length>digits&&/[1-9]/.test(fraction.slice(digits)))v.fail(400,code);
  return BigInt(match[1])*POWERS[digits]+BigInt((fraction.slice(0,digits)+'0'.repeat(digits)).slice(0,digits)||'0');
}
const micro=value=>scaled(value,6);
const milli=value=>scaled(value,3,'invalid_recipe_sale');
const formatScaled=(value,digits=6)=>{
  const whole=value/POWERS[digits],fraction=(value%POWERS[digits]).toString().padStart(digits,'0');
  return `${whole}.${fraction}`;
};
const roundPositive=(value,divisor)=> (value+divisor/2n)/divisor;
const targetKey=(productId,variantId='')=>`${productId}\u0000${variantId||''}`;

function recipeObjects(rows){
  const recipes=new Map();
  for(const row of rows){
    if(!row.catalog_stock_disabled)v.fail(409,'recipe_double_stock_tracking');
    if(!recipes.has(row.id))recipes.set(row.id,{id:row.id,productId:row.product_id,variantId:row.variant_id||'',
      version:Number(row.version),enabled:true,createdAt:row.created_at,components:[]});
    recipes.get(row.id).components.push({stockItemId:row.stock_item_id,
      quantityPerUnit:String(row.quantity_per_unit),quantityPerUnitMicro:micro(row.quantity_per_unit)});
  }
  return [...recipes.values()];
}

async function resolvedRecipes(c,companyId,productIds,{effectiveAt=null}={}){
  if(!productIds.length)return [];
  const rows=effectiveAt?(await c.query(`SELECT r.id,r.product_id,coalesce(r.variant_id,'') AS variant_id,
      effective.version,effective.enabled,effective.catalog_stock_disabled,effective.created_at,
      component.stock_item_id,component.quantity_per_unit
    FROM myfin.inventory_recipes r
    JOIN LATERAL (SELECT rv.version,rv.enabled,rv.catalog_stock_disabled,rv.created_at
      FROM myfin.inventory_recipe_versions rv
      WHERE rv.company_id=r.company_id AND rv.recipe_id=r.id AND rv.created_at<=$3::timestamptz
      ORDER BY rv.created_at DESC,rv.version DESC LIMIT 1) effective ON effective.enabled
    JOIN myfin.inventory_recipe_components component ON component.company_id=r.company_id
      AND component.recipe_id=r.id AND component.recipe_version=effective.version
    WHERE r.company_id=$1 AND r.product_id=ANY($2::text[])
    ORDER BY r.product_id,r.variant_id NULLS FIRST,r.id,component.position`,[companyId,productIds,effectiveAt])).rows:
    (await c.query(`SELECT r.id,r.product_id,coalesce(r.variant_id,'') AS variant_id,
      version_row.version,version_row.enabled,version_row.catalog_stock_disabled,version_row.created_at,
      component.stock_item_id,component.quantity_per_unit
    FROM myfin.inventory_recipes r
    JOIN myfin.inventory_recipe_versions version_row ON version_row.company_id=r.company_id
      AND version_row.recipe_id=r.id AND version_row.version=r.version AND version_row.enabled
    JOIN myfin.inventory_recipe_components component ON component.company_id=r.company_id
      AND component.recipe_id=r.id AND component.recipe_version=version_row.version
    WHERE r.company_id=$1 AND r.product_id=ANY($2::text[]) AND r.enabled
    ORDER BY r.product_id,r.variant_id NULLS FIRST,r.id,component.position`,[companyId,productIds])).rows;
  return recipeObjects(rows);
}

function planRecipeConsumption(items,recipes){
  const byTarget=new Map(recipes.map(recipe=>[targetKey(recipe.productId,recipe.variantId),recipe]));
  const consumptions=new Map(),lines=[];
  let matchedLines=0;
  for(let index=0;index<items.length;index++){
    const item=items[index]||{},productId=String(item.productId||''),variantId=String(item.variantId||''),
      quantityMilli=milli(item.qty??item.quantity),lineNo=Number(item.lineNo||index+1);
    if(!productId||quantityMilli<=0n||!Number.isInteger(lineNo)||lineNo<1)v.fail(400,'invalid_recipe_sale');
    const recipe=byTarget.get(targetKey(productId,variantId))||(variantId?byTarget.get(targetKey(productId,'')):null);
    const line={lineNo,productId,variantId,quantityMilli:quantityMilli.toString(),recipeId:'',recipeVersion:0,components:[]};
    if(!recipe){lines.push(line);continue;}
    matchedLines++;line.recipeId=recipe.id;line.recipeVersion=recipe.version;
    for(const component of recipe.components){
      const quantityMicro=roundPositive(component.quantityPerUnitMicro*quantityMilli,1000n);
      if(quantityMicro<=0n)v.fail(400,'invalid_recipe_sale');
      const contribution={line:lineNo,recipeId:recipe.id,recipeVersion:recipe.version,stockItemId:component.stockItemId,productId,variantId,
        recipeVariantId:recipe.variantId,units:Number(quantityMilli)/1000,quantityMilli:quantityMilli.toString(),
        quantityPerUnit:component.quantityPerUnit,quantity:formatScaled(quantityMicro),quantityMicro:quantityMicro.toString()};
      line.components.push(contribution);
      const current=consumptions.get(component.stockItemId)||{stockItemId:component.stockItemId,quantityMicro:0n,contributions:[]};
      current.quantityMicro+=quantityMicro;current.contributions.push(contribution);consumptions.set(component.stockItemId,current);
    }
    lines.push(line);
  }
  return {matchedLines,lines,consumptions:[...consumptions.values()].sort((a,b)=>a.stockItemId.localeCompare(b.stockItemId))};
}

const planEvidence=plan=>plan.lines.map(line=>({lineNo:line.lineNo,productId:line.productId,variantId:line.variantId,
  quantityMilli:line.quantityMilli,recipeId:line.recipeId,recipeVersion:line.recipeVersion,
  components:line.components.map(component=>({stockItemId:component.stockItemId,quantityPerUnit:component.quantityPerUnit,
    quantity:component.quantity}))}));
const planDigest=plan=>digest(planEvidence(plan));

async function activeRecipeReservationQuantities(c,companyId,stockItemIds,excludedOrderId=''){
  if(!stockItemIds.length)return new Map();
  const rows=(await c.query(`SELECT reservation.stock_item_id,sum(reservation.reserved_quantity)::numeric AS quantity
    FROM myfin.customer_order_recipe_reservations reservation
    JOIN myfin.customer_order_requests order_row
      ON order_row.company_id=reservation.company_id AND order_row.id=reservation.order_id
    WHERE reservation.company_id=$1 AND reservation.stock_item_id=ANY($2::text[])
      AND reservation.state='active' AND reservation.expires_at>now()
      AND order_row.status IN ('accepted','preparing','ready')
      AND ($3='' OR reservation.order_id<>$3)
    GROUP BY reservation.stock_item_id`,[companyId,stockItemIds,excludedOrderId])).rows;
  return new Map(rows.map(row=>[row.stock_item_id,micro(row.quantity)]));
}

async function stockForPlan(c,companyId,plan,{lock='update',excludedOrderId=''}={}){
  const stockIds=plan.consumptions.map(row=>row.stockItemId);
  if(!stockIds.length)return {rows:[],reserved:new Map()};
  const clause=lock==='share'?'FOR SHARE':'FOR UPDATE';
  const rows=(await c.query(`SELECT * FROM myfin.stock_items WHERE company_id=$1 AND id=ANY($2::text[])
    ORDER BY id ${clause}`,[companyId,stockIds])).rows;
  if(rows.length!==stockIds.length)v.fail(409,'recipe_stock_changed');
  const reserved=await activeRecipeReservationQuantities(c,companyId,stockIds,excludedOrderId);
  for(const consumption of plan.consumptions){
    const stock=rows.find(row=>row.id===consumption.stockItemId);
    if(!stock?.active)v.fail(409,'recipe_stock_changed');
    if(stock.tracking_mode==='count'&&consumption.contributions.some(row=>BigInt(row.quantityMicro)%1000000n!==0n))
      v.fail(409,'recipe_count_requires_whole_units');
    const available=micro(stock.on_hand)-(reserved.get(stock.id)||0n);
    if(available<consumption.quantityMicro)v.fail(409,'recipe_stock_unavailable');
  }
  return {rows,reserved};
}

export async function assertRecipeAvailability(c,{companyId,items,effectiveAt=null,lock='share',excludedOrderId=''}={}){
  const productIds=[...new Set((items||[]).map(item=>String(item.productId||'')))].filter(Boolean).sort();
  const recipes=await resolvedRecipes(c,companyId,productIds,{effectiveAt});
  const plan=planRecipeConsumption(items,recipes);
  const stock=await stockForPlan(c,companyId,plan,{lock,excludedOrderId});
  return {plan,...stock};
}

export async function recipeAvailabilityForProducts(c,companyId,productRows,{cap=1000}={}){
  const ids=[...new Set(productRows.map(row=>String(row.id||'')))].filter(Boolean).sort();
  const recipes=await resolvedRecipes(c,companyId,ids),byTarget=new Map(recipes.map(recipe=>[targetKey(recipe.productId,recipe.variantId),recipe]));
  const stockIds=[...new Set(recipes.flatMap(recipe=>recipe.components.map(component=>component.stockItemId)))].sort();
  const stockRows=stockIds.length?(await c.query(`SELECT * FROM myfin.stock_items WHERE company_id=$1 AND id=ANY($2::text[])
    ORDER BY id FOR SHARE`,[companyId,stockIds])).rows:[];
  const reserved=await activeRecipeReservationQuantities(c,companyId,stockIds),stock=new Map(stockRows.map(row=>[row.id,row]));
  const capMilli=BigInt(Math.max(0,Math.floor(Number(cap)*1000))),result=new Map();
  const availability=recipe=>{
    let limit=capMilli;
    for(const component of recipe.components){
      const row=stock.get(component.stockItemId);
      if(!row?.active)return 0;
      const available=micro(row.on_hand)-(reserved.get(row.id)||0n);
      if(available<=0n)return 0;
      const unitsMilli=available*1000n/component.quantityPerUnitMicro;
      if(unitsMilli<limit)limit=unitsMilli;
    }
    return Number(limit)/1000;
  };
  for(const row of productRows){
    const product=row.data||row,variants=product.variants||[];
    if(variants.length){
      for(const variant of variants){
        const recipe=byTarget.get(targetKey(row.id,variant.id))||byTarget.get(targetKey(row.id,''));
        if(recipe)result.set(targetKey(row.id,variant.id),{recipeTracked:true,availableQuantity:availability(recipe),recipeVersion:recipe.version});
      }
    }else{
      const recipe=byTarget.get(targetKey(row.id,''));
      if(recipe)result.set(targetKey(row.id,''),{recipeTracked:true,availableQuantity:availability(recipe),recipeVersion:recipe.version});
    }
  }
  return result;
}

export async function reserveRecipeStock(c,{companyId,order,lines}){
  const items=lines.map(line=>({lineNo:Number(line.line_no),productId:line.product_id,
    variantId:line.variant_id||'',qty:Number(line.quantity)}));
  const {plan}=await assertRecipeAvailability(c,{companyId,items,lock:'update',excludedOrderId:order.id});
  for(const line of plan.lines){
    const lineQuantity=formatScaled(BigInt(line.quantityMilli),3);
    for(const component of line.components)await c.query(`INSERT INTO myfin.customer_order_recipe_reservations(
        company_id,order_id,line_no,stock_item_id,recipe_id,recipe_version,line_quantity,quantity_per_unit,
        reserved_quantity,state,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10)`,[companyId,order.id,line.lineNo,
      component.stockItemId,line.recipeId,line.recipeVersion,lineQuantity,component.quantityPerUnit,
      component.quantity,order.expires_at]);
  }
  return plan;
}

export async function offlineRecipeBoundary(c,{companyId,items,capturedAt}){
  const captured=new Date(capturedAt);
  if(!Number.isFinite(captured.getTime()))v.fail(400,'invalid_recipe_sale');
  const saleItems=items.map((item,index)=>({lineNo:index+1,productId:String(item.productId||''),
    variantId:String(item.variantId||''),qty:Number(item.qty)}));
  const productIds=[...new Set(saleItems.map(item=>item.productId))].filter(Boolean).sort();
  const current=planRecipeConsumption(saleItems,await resolvedRecipes(c,companyId,productIds));
  const historical=planRecipeConsumption(saleItems,await resolvedRecipes(c,companyId,productIds,
    {effectiveAt:captured.toISOString()}));
  return {changed:planDigest(current)!==planDigest(historical),currentDigest:planDigest(current),
    capturedDigest:planDigest(historical)};
}

async function reservedRecipePlan(c,companyId,orderId,serverOccurredAt){
  const rows=(await c.query(`SELECT reservation.*,line.product_id,coalesce(line.variant_id,'') AS variant_id,
      line.quantity AS order_line_quantity,component.quantity_per_unit AS component_quantity_per_unit
    FROM myfin.customer_order_recipe_reservations reservation
    JOIN myfin.customer_order_lines line ON line.company_id=reservation.company_id
      AND line.order_id=reservation.order_id AND line.line_no=reservation.line_no
    JOIN myfin.inventory_recipe_components component ON component.company_id=reservation.company_id
      AND component.recipe_id=reservation.recipe_id AND component.recipe_version=reservation.recipe_version
      AND component.stock_item_id=reservation.stock_item_id
    WHERE reservation.company_id=$1 AND reservation.order_id=$2
    ORDER BY reservation.stock_item_id,reservation.line_no FOR UPDATE OF reservation`,[companyId,orderId])).rows;
  const lines=new Map(),consumptions=new Map();
  for(const row of rows){
    if(row.state!=='active'||new Date(row.expires_at)<=new Date(serverOccurredAt))v.fail(409,'recipe_reservation_unavailable');
    const lineMilli=milli(row.line_quantity),orderMilli=milli(row.order_line_quantity),perMicro=micro(row.quantity_per_unit),
      componentMicro=micro(row.component_quantity_per_unit),reservedMicro=micro(row.reserved_quantity),
      expected=roundPositive(lineMilli*perMicro,1000n);
    if(lineMilli!==orderMilli||perMicro!==componentMicro||reservedMicro!==expected)v.fail(409,'recipe_reservation_changed');
    const key=Number(row.line_no),line=lines.get(key)||{lineNo:key,productId:row.product_id,variantId:row.variant_id||'',
      quantityMilli:lineMilli.toString(),recipeId:row.recipe_id,recipeVersion:Number(row.recipe_version),components:[]};
    if(line.recipeId!==row.recipe_id||line.recipeVersion!==Number(row.recipe_version))v.fail(409,'recipe_reservation_changed');
    const contribution={line:key,recipeId:row.recipe_id,recipeVersion:Number(row.recipe_version),stockItemId:row.stock_item_id,
      productId:row.product_id,variantId:row.variant_id||'',recipeVariantId:'',units:Number(lineMilli)/1000,
      quantityMilli:lineMilli.toString(),quantityPerUnit:String(row.quantity_per_unit),
      quantity:String(row.reserved_quantity),quantityMicro:reservedMicro.toString()};
    line.components.push(contribution);lines.set(key,line);
    const consumption=consumptions.get(row.stock_item_id)||{stockItemId:row.stock_item_id,quantityMicro:0n,contributions:[]};
    consumption.quantityMicro+=reservedMicro;consumption.contributions.push(contribution);consumptions.set(row.stock_item_id,consumption);
  }
  return {matchedLines:lines.size,lines:[...lines.values()].sort((a,b)=>a.lineNo-b.lineNo),
    consumptions:[...consumptions.values()].sort((a,b)=>a.stockItemId.localeCompare(b.stockItemId)),reservationCount:rows.length};
}

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
  const stock=componentIds.length?(await c.query('SELECT id,active,tracking_mode FROM myfin.stock_items WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[companyId,componentIds])).rows:[];
  if(stock.length!==componentIds.length)v.fail(404,'stock_item_not_found');
  if(stock.some(row=>!row.active))v.fail(409,'stock_item_archived');
  try{validateRecipeStockUnits(data,stock);}catch{v.fail(400,'recipe_count_requires_whole_units');}
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
// Online sales resolve the recipe that is current under the already-held product
// locks. Offline captured time is evidence only unless a manager explicitly
// reconciles a recipe-boundary review to the captured recipe.
export async function consumeRecipeStock(c,{companyId,actorId,saleId,serverOccurredAt,occurredAt,
  capturedAt,items,reservationOrderId='',offline=false,inventoryRecipeResolution=''}){
  const serverTime=new Date(serverOccurredAt||occurredAt),capturedTime=new Date(capturedAt||serverOccurredAt||occurredAt);
  if(!companyId||!actorId||!saleId||!Number.isFinite(serverTime.getTime())||!Number.isFinite(capturedTime.getTime())||
      !Array.isArray(items)||!items.length)v.fail(400,'invalid_recipe_sale');
  const serverIso=serverTime.toISOString(),capturedIso=capturedTime.toISOString();
  const saleItems=items.map((item,index)=>({lineNo:index+1,productId:String(item.productId||''),
    variantId:String(item.variantId||''),qty:Number(item.qty)}));
  const selectedResolution=inventoryRecipeResolution||'current_recipe';
  if(!['current_recipe','captured_recipe'].includes(selectedResolution))v.fail(400,'invalid_inventory_recipe_resolution');
  const requestDigest=digest({companyId,actorId,saleId,capturedAt:capturedIso,items:saleItems,
    reservationOrderId,resolution:selectedResolution});
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
  let plan,mode='current_recipe';
  if(reservationOrderId){
    plan=await reservedRecipePlan(c,companyId,reservationOrderId,serverIso);mode='reserved_order';
  }else{
    const currentPlan=planRecipeConsumption(saleItems,await resolvedRecipes(c,companyId,productIds));
    let capturedPlan=currentPlan;
    if(offline){
      capturedPlan=planRecipeConsumption(saleItems,await resolvedRecipes(c,companyId,productIds,{effectiveAt:capturedIso}));
      const boundaryChanged=planDigest(currentPlan)!==planDigest(capturedPlan);
      if(boundaryChanged&&!inventoryRecipeResolution)
        v.fail(409,'receipt_review_required_recipe_timing');
      if(!boundaryChanged&&inventoryRecipeResolution)v.fail(400,'inventory_recipe_resolution_not_applicable');
    }
    plan=offline&&selectedResolution==='captured_recipe'?capturedPlan:currentPlan;
    mode=offline?selectedResolution:'current_recipe';
  }
  const {rows:stockRows}=await stockForPlan(c,companyId,plan,{lock:'update',excludedOrderId:reservationOrderId});
  const planned=plan.consumptions.map(consumption=>{
    const stock=stockRows.find(row=>row.id===consumption.stockItemId),afterMicro=micro(stock.on_hand)-consumption.quantityMicro;
    if(afterMicro<0n)v.fail(409,'recipe_stock_unavailable');
    return {consumption,stock,after:formatScaled(afterMicro)};
  });
  if(reservationOrderId&&plan.reservationCount){
    const changed=await c.query(`UPDATE myfin.customer_order_recipe_reservations
      SET state='consumed',consumed_at=$3,updated_at=now()
      WHERE company_id=$1 AND order_id=$2 AND state='active'`,[companyId,reservationOrderId,serverIso]);
    if(changed.rowCount!==plan.reservationCount)v.fail(409,'recipe_reservation_changed');
  }
  const movements=[];
  for(const {consumption,stock,after} of planned){
    const id=randomUUID(),quantity=formatScaled(consumption.quantityMicro),details={recipes:consumption.contributions,
      mode,reservationOrderId:reservationOrderId||undefined};
    await c.query('UPDATE myfin.stock_items SET on_hand=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2',[companyId,stock.id,after]);
    const inserted=(await c.query(`INSERT INTO myfin.stock_ledger(company_id,id,item_id,actor_id,kind,input_quantity,delta,quantity_after,
        reason,idempotency_key,request_digest,source_type,source_id,source_details)
      VALUES($1,$2,$3,$4,'consume',$5,$6,$7,$8,$9,$10,'pos_sale',$11,$12) RETURNING *`,
    [companyId,id,stock.id,actorId,quantity,`-${quantity}`,after,
      `Automatic recipe consumption for sale ${saleId}`,movementKey(companyId,saleId,stock.id),requestDigest,saleId,details])).rows[0];
    movements.push(ledgerOutput(inserted));
  }
  const details={serverOccurredAt:serverIso,capturedAt:capturedIso,mode,reservationOrderId:reservationOrderId||'',
    recipePlanDigest:planDigest(plan),matchedLines:plan.matchedLines,
    unconfiguredLines:saleItems.length-plan.matchedLines,stockItemCount:movements.length};
  await c.query(`INSERT INTO myfin.inventory_source_effects(company_id,source_type,source_id,actor_id,request_digest,details)
    VALUES($1,'pos_sale',$2,$3,$4,$5)`,[companyId,saleId,actorId,requestDigest,details]);
  return {duplicate:false,...details,movements};
}

export { activeRecipeReservationQuantities, planRecipeConsumption, recipeRows, resolvedRecipes, saveRecipe };
