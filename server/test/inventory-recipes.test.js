import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRecipeAvailability,catalogTracksStock,consumeRecipeStock,planRecipeConsumption,recipeAvailabilityForProducts,recipeRows,saveRecipe} from '../src/inventory-recipes.js';

class RecipeDatabase {
  constructor({milk=1000,beans=100,recipeEffectiveAt='2026-10-09T00:00:00.000Z'}={}){
    this.stock=new Map([
      ['beans',{id:'beans',company_id:'company',tracking_mode:'weight',on_hand:beans,active:true,version:1}],
      ['milk',{id:'milk',company_id:'company',tracking_mode:'volume',on_hand:milk,active:true,version:1}],
    ]);
    this.effect=null;this.ledger=[];this.locked=[];this.updates=[];this.recipeEffectiveAt=recipeEffectiveAt;
  }
  async query(sql,args=[]){
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('FROM myfin.inventory_source_effects'))return {rows:this.effect?[this.effect]:[],rowCount:this.effect?1:0};
    if(sql.includes('FROM myfin.inventory_recipes r')){
      const active=!sql.includes('JOIN LATERAL')||new Date(args[2])>=new Date(this.recipeEffectiveAt);
      const rows=active?[
        {id:'recipe-latte',product_id:'latte',variant_id:'',version:3,enabled:true,catalog_stock_disabled:true,stock_item_id:'milk',quantity_per_unit:'200'},
        {id:'recipe-latte',product_id:'latte',variant_id:'',version:3,enabled:true,catalog_stock_disabled:true,stock_item_id:'beans',quantity_per_unit:'18'},
      ]:[];
      return {rows,rowCount:rows.length};
    }
    if(sql.includes('FROM myfin.customer_order_recipe_reservations reservation'))return {rows:[],rowCount:0};
    if(sql.includes('FROM myfin.stock_items')&&sql.includes('FOR UPDATE')){
      this.locked=[...args[1]];
      const rows=args[1].map(id=>this.stock.get(id)).filter(Boolean);
      return {rows,rowCount:rows.length};
    }
    if(sql.startsWith('UPDATE myfin.stock_items')){
      const row=this.stock.get(args[1]);row.on_hand=args[2];row.version++;this.updates.push(args[1]);
      return {rows:[],rowCount:1};
    }
    if(sql.includes('INSERT INTO myfin.stock_ledger')){
      const row={company_id:args[0],id:args[1],item_id:args[2],actor_id:args[3],kind:'consume',
        input_quantity:args[4],delta:args[5],quantity_after:args[6],reason:args[7],idempotency_key:args[8],
        request_digest:args[9],source_type:'pos_sale',source_id:args[10],source_details:args[11],created_at:'2026-10-09T00:00:00Z'};
      this.ledger.push(row);return {rows:[row],rowCount:1};
    }
    if(sql.includes('INSERT INTO myfin.inventory_source_effects')){
      this.effect={request_digest:args[3],details:args[4]};return {rows:[],rowCount:1};
    }
    if(sql.includes('FROM myfin.stock_ledger'))return {rows:[...this.ledger].sort((a,b)=>a.item_id.localeCompare(b.item_id)),rowCount:this.ledger.length};
    throw Error(`Unexpected SQL: ${sql}`);
  }
}

const request={companyId:'company',actorId:'cashier',saleId:'sale-1',occurredAt:'2026-10-09T01:00:00.000Z',items:[
  {productId:'latte',qty:2},{productId:'latte',qty:1},
]};

test('POS recipe consumption locks stock in order and writes one exactly-once movement per item',async()=>{
  const db=new RecipeDatabase();
  const first=await consumeRecipeStock(db,request);
  assert.equal(first.duplicate,false);
  assert.equal(first.matchedLines,2);
  assert.deepEqual(db.locked,['beans','milk']);
  assert.deepEqual(db.updates,['beans','milk']);
  assert.equal(Number(db.stock.get('beans').on_hand),46);
  assert.equal(Number(db.stock.get('milk').on_hand),400);
  assert.deepEqual(first.movements.map(row=>[row.itemId,row.inputQuantity,row.sourceType,row.sourceId]),[
    ['beans',54,'pos_sale','sale-1'],['milk',600,'pos_sale','sale-1'],
  ]);
  assert.equal(new Set(first.movements.map(row=>row.id)).size,2);

  const replay=await consumeRecipeStock(db,request);
  assert.equal(replay.duplicate,true);
  assert.equal(replay.matchedLines,2);
  assert.equal(db.updates.length,2);
  assert.equal(db.ledger.length,2);
  await assert.rejects(()=>consumeRecipeStock(db,{...request,items:[{productId:'latte',qty:1}]}),
    error=>error.statusCode===409&&error.message==='inventory_source_payload_changed');
});

test('legacy products with inferred stock tracking cannot also use recipe deduction',()=>{
  assert.equal(catalogTracksStock({name:'Legacy',stock:0,variants:[]}),true);
  assert.equal(catalogTracksStock({name:'Legacy variant',variants:[{id:'v',stock:0}]}),true);
  assert.equal(catalogTracksStock({name:'Service',category:'Service',stock:20}),false);
  assert.equal(catalogTracksStock({name:'Explicit recipe mode',trackStock:false,stock:20}),false);
});

test('recipe enablement rejects inferred catalog tracking before writing history',async()=>{
  const writes=[];
  const db={async query(sql,args=[]){
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('FROM myfin.products')&&sql.includes('FOR UPDATE'))return {rows:[{id:'latte',company_id:'company',data:{name:'Legacy latte',stock:0,variants:[]}}],rowCount:1};
    if(sql.includes('FROM myfin.stock_items'))return {rows:[{id:'milk',active:true,unit_version:1}],rowCount:1};
    if(/^\s*(INSERT|UPDATE)/.test(sql)){writes.push({sql,args});return {rows:[],rowCount:1};}
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  await assert.rejects(()=>saveRecipe(db,{id:'manager'},'company',{
    productId:'latte',variantId:'',version:0,enabled:true,components:[{stockItemId:'milk',unitVersion:1,quantityPerUnit:200}],
  },async()=>{}),error=>error.statusCode===409&&error.message==='recipe_requires_catalog_stock_disabled');
  assert.equal(writes.length,0);
});

test('counted recipe fractions are rejected when the recipe is saved',async()=>{
  const writes=[];
  const db={async query(sql){
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('FROM myfin.products')&&sql.includes('FOR UPDATE'))return {rows:[{id:'latte',data:{name:'Latte',trackStock:false,variants:[]}}],rowCount:1};
    if(sql.includes('FROM myfin.stock_items'))return {rows:[{id:'pump',active:true,tracking_mode:'count',unit_version:1}],rowCount:1};
    if(/^\s*(INSERT|UPDATE)/.test(sql)){writes.push(sql);return {rows:[],rowCount:1};}
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  await assert.rejects(()=>saveRecipe(db,{id:'manager'},'company',{
    productId:'latte',variantId:'',version:0,enabled:true,components:[{stockItemId:'pump',unitVersion:1,quantityPerUnit:.5}],
  },async()=>{}),error=>error.statusCode===400&&error.message==='recipe_count_requires_whole_units');
  assert.equal(writes.length,0);
});

test('a recipe form opened before a stock unit correction is rejected',async()=>{
  const db={async query(sql){
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('FROM myfin.products')&&sql.includes('FOR UPDATE'))return {rows:[{id:'latte',data:{name:'Latte',trackStock:false,variants:[]}}],rowCount:1};
    if(sql.includes('FROM myfin.stock_items'))return {rows:[{id:'milk',active:true,tracking_mode:'volume',unit_version:2}],rowCount:1};
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  await assert.rejects(()=>saveRecipe(db,{id:'manager'},'company',{
    productId:'latte',variantId:'',version:0,enabled:true,
    components:[{stockItemId:'milk',unitVersion:1,quantityPerUnit:200}],
  },async()=>{}),error=>error.statusCode===409&&error.message==='stock_unit_changed_reload');
});

test('recipe planning converts four coffees into one litre of milk and four syrup pumps',()=>{
  const plan=planRecipeConsumption([{productId:'latte',qty:4}],[{id:'latte-recipe',productId:'latte',variantId:'',version:1,components:[
    {stockItemId:'milk',quantityPerUnit:'250',quantityPerUnitMicro:250000000n},
    {stockItemId:'syrup',quantityPerUnit:'1',quantityPerUnitMicro:1000000n},
  ]}]);
  assert.deepEqual(plan.consumptions.map(row=>[row.stockItemId,row.quantityMicro]),[['milk',1000000000n],['syrup',4000000n]]);
});

test('recipe projections expose quantities and availability without confidential costs',async()=>{
  const db={async query(sql){
    if(sql.includes('FROM myfin.inventory_recipes r JOIN myfin.products'))return {rows:[{id:'r',product_id:'latte',variant_id:null,
      version:1,enabled:false,product_data:{name:'Latte',cost:93847,variants:[{id:'iced',name:'Iced',cost:93847}]}}]};
    if(sql.includes('FROM myfin.inventory_recipe_components c'))return {rows:[{recipe_id:'r',stock_item_id:'milk',quantity_per_unit:'200',
      stock_item_name:'Milk',base_unit:'ml',unit_version:'1',on_hand:'1000',active:true,unit_cost:93847}]};
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  const result=await recipeRows(db,'company');
  assert.equal(result[0].availability.units,5);
  assert.doesNotMatch(JSON.stringify(result),/cost|93847/i);
});

test('a forged pre-activation date cannot bypass the current server recipe',async()=>{
  const db=new RecipeDatabase();
  const old={...request,saleId:'offline-before-recipe',occurredAt:'2026-10-08T23:59:59.000Z'};
  const first=await consumeRecipeStock(db,old);
  assert.equal(first.mode,'current_recipe');
  assert.equal(first.matchedLines,2);
  assert.equal(first.stockItemCount,2);
  assert.deepEqual(db.updates,['beans','milk']);
  const replay=await consumeRecipeStock(db,old);
  assert.equal(replay.duplicate,true);
  assert.equal(replay.movements.length,2);
  assert.equal(db.updates.length,2);
});

test('offline history crossing recipe activation needs an explicit manager interpretation',async()=>{
  const capturedAt='2026-10-08T23:59:59.000Z',base={...request,saleId:'offline-boundary',
    serverOccurredAt:'2026-10-09T01:00:00.000Z',capturedAt,offline:true};
  await assert.rejects(()=>consumeRecipeStock(new RecipeDatabase(),base),
    error=>error.statusCode===409&&error.message==='receipt_review_required_recipe_timing');
  const currentDb=new RecipeDatabase(),current=await consumeRecipeStock(currentDb,{...base,inventoryRecipeResolution:'current_recipe'});
  assert.equal(current.mode,'current_recipe');
  assert.equal(current.movements.length,2);
  const capturedDb=new RecipeDatabase(),captured=await consumeRecipeStock(capturedDb,{...base,saleId:'offline-captured',inventoryRecipeResolution:'captured_recipe'});
  assert.equal(captured.mode,'captured_recipe');
  assert.equal(captured.movements.length,0);
  assert.deepEqual(capturedDb.updates,[]);
});

test('shared ingredients aggregate with exact milli sale and micro recipe math',()=>{
  const plan=planRecipeConsumption([
    {lineNo:1,productId:'latte',qty:1.111},
    {lineNo:2,productId:'mocha',qty:2.222},
  ],[
    {id:'r1',productId:'latte',variantId:'',version:1,components:[{stockItemId:'milk',quantityPerUnit:'0.333333',quantityPerUnitMicro:333333n}]},
    {id:'r2',productId:'mocha',variantId:'',version:4,components:[{stockItemId:'milk',quantityPerUnit:'0.666667',quantityPerUnitMicro:666667n}]},
  ]);
  assert.equal(plan.consumptions.length,1);
  assert.equal(plan.consumptions[0].quantityMicro,1851667n);
  assert.deepEqual(plan.consumptions[0].contributions.map(row=>row.quantity),['0.370333','1.481334']);
});

test('staff projections are target-specific and subtract shared ingredient reservations',async()=>{
  const db={async query(sql){
    if(sql.includes('FROM myfin.inventory_recipes r'))return {rows:[
      {id:'iced-recipe',product_id:'tea',variant_id:'iced',version:2,enabled:true,catalog_stock_disabled:true,
        stock_item_id:'milk',quantity_per_unit:'2'},
      {id:'latte-recipe',product_id:'latte',variant_id:'',version:4,enabled:true,catalog_stock_disabled:true,
        stock_item_id:'milk',quantity_per_unit:'3'},
    ]};
    if(sql.includes('FROM myfin.stock_items'))return {rows:[{id:'milk',on_hand:'10',active:true,tracking_mode:'volume'}]};
    if(sql.includes('FROM myfin.customer_order_recipe_reservations reservation'))return {rows:[{stock_item_id:'milk',quantity:'4'}]};
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  const availability=await recipeAvailabilityForProducts(db,'company',[
    {id:'tea',data:{variants:[{id:'iced'},{id:'hot'}]}},{id:'latte',data:{variants:[]}},
  ]);
  assert.deepEqual(availability.get('tea\u0000iced'),{recipeTracked:true,availableQuantity:3,recipeVersion:2});
  assert.equal(availability.has('tea\u0000hot'),false);
  assert.deepEqual(availability.get('latte\u0000'),{recipeTracked:true,availableQuantity:2,recipeVersion:4});
});

test('count ingredients reject fractional reservation lines even when their shared aggregate is whole',async()=>{
  const db={async query(sql){
    if(sql.includes('FROM myfin.inventory_recipes r'))return {rows:[
      {id:'r1',product_id:'one',variant_id:'',version:1,enabled:true,catalog_stock_disabled:true,
        stock_item_id:'cup',quantity_per_unit:'0.5'},
      {id:'r2',product_id:'two',variant_id:'',version:1,enabled:true,catalog_stock_disabled:true,
        stock_item_id:'cup',quantity_per_unit:'0.5'},
    ]};
    if(sql.includes('FROM myfin.stock_items'))return {rows:[{id:'cup',on_hand:'10',active:true,tracking_mode:'count'}]};
    if(sql.includes('FROM myfin.customer_order_recipe_reservations reservation'))return {rows:[]};
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  await assert.rejects(assertRecipeAvailability(db,{companyId:'company',items:[
    {productId:'one',qty:1},{productId:'two',qty:1},
  ],lock:'share'}),error=>error.statusCode===409&&error.message==='recipe_count_requires_whole_units');
});

test('POS recipe shortage rejects before balances or source markers change',async()=>{
  const db=new RecipeDatabase({milk:500,beans:40});
  await assert.rejects(()=>consumeRecipeStock(db,request),
    error=>error.statusCode===409&&error.message==='recipe_stock_unavailable');
  assert.equal(db.stock.get('beans').on_hand,40);
  assert.equal(db.stock.get('milk').on_hand,500);
  assert.equal(db.updates.length,0);
  assert.equal(db.ledger.length,0);
  assert.equal(db.effect,null);
});

test('an individually approved paid receipt records a financial-only recipe shortage exactly once',async()=>{
  const db=new RecipeDatabase({milk:500,beans:40});
  const approved={...request,saleId:'approved-shortage',inventoryShortageResolution:'record_shortage'};
  const first=await consumeRecipeStock(db,approved);
  assert.equal(first.duplicate,false);
  assert.equal(first.inventoryShortage,true);
  assert.equal(first.mode,'current_recipe_financial_only');
  assert.deepEqual(first.shortages.map(row=>row.stockItemId),['beans','milk']);
  assert.deepEqual(db.updates,[]);
  assert.deepEqual(db.ledger,[]);
  assert.equal(db.stock.get('beans').on_hand,40);
  assert.equal(db.stock.get('milk').on_hand,500);
  const replay=await consumeRecipeStock(db,approved);
  assert.equal(replay.duplicate,true);
  assert.equal(replay.inventoryShortage,true);
  assert.deepEqual(replay.movements,[]);
});
