import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogTracksStock,consumeRecipeStock,recipeRows,saveRecipe} from '../src/inventory-recipes.js';

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
      const rows=new Date(args[2])>=new Date(this.recipeEffectiveAt)?[
        {id:'recipe-latte',product_id:'latte',variant_id:'',version:3,enabled:true,catalog_stock_disabled:true,stock_item_id:'milk',quantity_per_unit:'200'},
        {id:'recipe-latte',product_id:'latte',variant_id:'',version:3,enabled:true,catalog_stock_disabled:true,stock_item_id:'beans',quantity_per_unit:'18'},
      ]:[];
      return {rows,rowCount:rows.length};
    }
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
  assert.equal(db.stock.get('beans').on_hand,46);
  assert.equal(db.stock.get('milk').on_hand,400);
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
    if(sql.includes('FROM myfin.stock_items'))return {rows:[{id:'milk',active:true}],rowCount:1};
    if(/^\s*(INSERT|UPDATE)/.test(sql)){writes.push({sql,args});return {rows:[],rowCount:1};}
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  await assert.rejects(()=>saveRecipe(db,{id:'manager'},'company',{
    productId:'latte',variantId:'',version:0,enabled:true,components:[{stockItemId:'milk',quantityPerUnit:200}],
  },async()=>{}),error=>error.statusCode===409&&error.message==='recipe_requires_catalog_stock_disabled');
  assert.equal(writes.length,0);
});

test('recipe projections expose quantities and availability without confidential costs',async()=>{
  const db={async query(sql){
    if(sql.includes('FROM myfin.inventory_recipes r JOIN myfin.products'))return {rows:[{id:'r',product_id:'latte',variant_id:null,
      version:1,enabled:false,product_data:{name:'Latte',cost:93847,variants:[{id:'iced',name:'Iced',cost:93847}]}}]};
    if(sql.includes('FROM myfin.inventory_recipe_components c'))return {rows:[{recipe_id:'r',stock_item_id:'milk',quantity_per_unit:'200',
      stock_item_name:'Milk',base_unit:'ml',on_hand:'1000',active:true,unit_cost:93847}]};
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  const result=await recipeRows(db,'company');
  assert.equal(result[0].availability.units,5);
  assert.doesNotMatch(JSON.stringify(result),/cost|93847/i);
});

test('a pre-activation offline sale is recorded as an exactly-once no-op',async()=>{
  const db=new RecipeDatabase();
  const old={...request,saleId:'offline-before-recipe',occurredAt:'2026-10-08T23:59:59.000Z'};
  const first=await consumeRecipeStock(db,old);
  assert.deepEqual(first,{duplicate:false,occurredAt:'2026-10-08T23:59:59.000Z',matchedLines:0,unconfiguredLines:2,stockItemCount:0,movements:[]});
  assert.equal(db.effect.details.occurredAt,old.occurredAt);
  db.recipeEffectiveAt='2026-10-01T00:00:00.000Z';
  const replay=await consumeRecipeStock(db,old);
  assert.equal(replay.duplicate,true);
  assert.equal(replay.movements.length,0);
  assert.equal(db.updates.length,0);
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
