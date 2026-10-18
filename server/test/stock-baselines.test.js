import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {registerStock} from '../src/stock.js';

function routesFor(client){
  const routes=new Map(),app={
    get:(path,handler)=>routes.set(`GET ${path}`,handler),
    post:(path,handler)=>routes.set(`POST ${path}`,handler),
    put:(path,handler)=>routes.set(`PUT ${path}`,handler),
    delete:(path,handler)=>routes.set(`DELETE ${path}`,handler),
  };
  registerStock(app,{scoped:(request,operation)=>operation(client,'company'),audit:async()=>{}});
  return routes;
}

test('baseline migration preserves build unit versions and adds immutable stock starting points',async()=>{
  const [sql,buildSource]=await Promise.all([
    readFile(new URL('../../db/migrations/0046_stock_baselines_and_build_versions.sql',import.meta.url),'utf8'),
    readFile(new URL('../src/inventory-recipes.js',import.meta.url),'utf8'),
  ]);
  assert.match(sql,/ADD COLUMN stock_tracking_mode text/);
  assert.match(sql,/ADD COLUMN stock_base_unit text/);
  assert.match(sql,/ADD COLUMN stock_unit_version bigint/);
  assert.match(sql,/DISABLE TRIGGER immutable_inventory_recipe_components/);
  assert.match(sql,/FROM myfin\.stock_unit_corrections correction/);
  assert.match(sql,/correction\.created_at<=build_version\.created_at/);
  assert.match(sql,/snapshot_inventory_recipe_component_unit_before_insert/);
  assert.match(sql,/NEW\.stock_tracking_mode:=item_row\.tracking_mode/);
  assert.match(sql,/NEW\.stock_base_unit:=item_row\.base_unit/);
  assert.match(sql,/NEW\.stock_unit_version:=item_row\.unit_version/);
  assert.doesNotMatch(sql,/stock_unit_version SET DEFAULT/);
  assert.match(sql,/CREATE TABLE myfin\.stock_baselines/);
  assert.match(sql,/CREATE TABLE myfin\.stock_baseline_items/);
  assert.match(sql,/ALTER TABLE myfin\.stock_ledger ADD COLUMN baseline_id text/);
  assert.match(sql,/immutable_stock_baselines/);
  assert.match(sql,/immutable_stock_baseline_items/);
  assert.match(buildSource,/inventory_recipe_components\(company_id,recipe_id,recipe_version,stock_item_id,position,[\s\S]*quantity_per_unit\)[\s\S]*component\.quantityPerUnit/);
  assert.doesNotMatch(buildSource,/quantity_per_unit,stock_unit_version/);
});

test('a stock baseline atomically counts multiple items and replays exactly once',async()=>{
  const stock=new Map([
    ['cup',{id:'cup',active:true,tracking_mode:'count',unit_version:'1',on_hand:'25.000000',version:'4'}],
    ['milk',{id:'milk',active:true,tracking_mode:'volume',unit_version:'2',on_hand:'3500.000000',version:'7'}],
  ]),ledger=[],baselineItems=[];
  let savedBaseline=null;
  const client={query:async(sql,args=[])=>{
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('FROM myfin.stock_baselines')&&sql.includes('idempotency_key'))return {rows:savedBaseline?[savedBaseline]:[],rowCount:savedBaseline?1:0};
    if(sql.includes('FROM myfin.stock_baseline_items'))return {rows:baselineItems,rowCount:baselineItems.length};
    if(sql.includes('FROM myfin.stock_items')&&sql.includes('FOR UPDATE')){
      const rows=args[1].map(id=>stock.get(id)).filter(Boolean);return {rows,rowCount:rows.length};
    }
    if(sql.startsWith('INSERT INTO myfin.stock_baselines')){
      savedBaseline={company_id:args[0],id:args[1],idempotency_key:args[2],request_digest:args[3],reason:args[4],
        item_count:args[5],created_by:args[6],created_at:'2026-10-18T08:00:00.000Z'};
      return {rows:[],rowCount:1};
    }
    if(sql.startsWith('UPDATE myfin.stock_items')){const row=stock.get(args[1]);row.on_hand=String(args[2]);row.version=String(Number(row.version)+1);return {rows:[],rowCount:1};}
    if(sql.startsWith('INSERT INTO myfin.stock_ledger')){ledger.push({company_id:args[0],id:args[1],item_id:args[2],actor_id:args[3],
      kind:'count',input_quantity:args[4],delta:args[5],quantity_after:args[6],reason:args[7],idempotency_key:args[8],
      request_digest:args[9],baseline_id:args[10]});return {rows:[],rowCount:1};}
    if(sql.startsWith('INSERT INTO myfin.stock_baseline_items')){baselineItems.push({company_id:args[0],baseline_id:args[1],
      stock_item_id:args[2],stock_unit_version:args[3],quantity_before:args[4],quantity_after:args[5],ledger_id:args[6]});
      return {rows:[],rowCount:1};}
    if(sql.includes('FROM myfin.stock_baselines')&&sql.includes('id=$2'))return {rows:[savedBaseline],rowCount:1};
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  const route=routesFor(client).get('POST /api/companies/:company/stock-baselines'),request={
    identity:{id:'manager',role:'manager'},body:{reason:'Fresh physical count before automatic deduction',idempotencyKey:'baseline-request-1',items:[
      {stockItemId:'milk',expectedVersion:7,unitVersion:2,quantity:1000},
      {stockItemId:'cup',expectedVersion:4,unitVersion:1,quantity:0},
    ]},
  };
  const first=await route(request);
  assert.equal(first.duplicate,false);assert.equal(first.baseline.itemCount,2);
  assert.deepEqual(first.items.map(row=>[row.stockItemId,row.quantityBefore,row.quantityAfter]),[
    ['cup',25,0],['milk',3500,1000],
  ]);
  assert.equal(ledger.length,2);assert.ok(ledger.every(row=>row.baseline_id===first.baseline.id));
  assert.equal(stock.get('cup').on_hand,'0');assert.equal(stock.get('milk').on_hand,'1000');
  const replay=await route(request);
  assert.equal(replay.duplicate,true);assert.equal(ledger.length,2);assert.deepEqual(replay.items,first.items);
  await assert.rejects(()=>route({...request,body:{...request.body,reason:'Changed baseline reason after replay'}}),
    error=>error.statusCode===409&&error.message==='stock_baseline_payload_changed');
});

test('counted stock baseline quantities must be whole and stale unit revisions fail before writes',async()=>{
  const calls=[],client={query:async(sql,args=[])=>{
    calls.push({sql,args});
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('FROM myfin.stock_baselines'))return {rows:[],rowCount:0};
    if(sql.includes('FROM myfin.stock_items'))return {rows:[{id:'cup',active:true,tracking_mode:'count',unit_version:'2',on_hand:'4',version:'3'}],rowCount:1};
    throw Error(`Unexpected SQL: ${sql}`);
  }},route=routesFor(client).get('POST /api/companies/:company/stock-baselines');
  const request={identity:{id:'owner',role:'workspace_owner'},body:{reason:'Recount the active cup stock',idempotencyKey:'baseline-cups-1',
    items:[{stockItemId:'cup',expectedVersion:3,unitVersion:2,quantity:1.5}]}};
  await assert.rejects(()=>route(request),error=>error.statusCode===400&&error.message==='counted_stock_requires_whole_units');
  request.body.items[0]={stockItemId:'cup',expectedVersion:3,unitVersion:1,quantity:1};request.body.idempotencyKey='baseline-cups-2';
  await assert.rejects(()=>route(request),error=>error.statusCode===409&&error.message==='stock_unit_changed_reload');
  assert.equal(calls.some(call=>call.sql.startsWith('INSERT INTO myfin.stock_baselines')),false);
});

test('a stock baseline rejects stale balances and operators before writing',async()=>{
  const calls=[],client={async query(sql){calls.push(sql);if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('FROM myfin.stock_baselines'))return {rows:[],rowCount:0};
    if(sql.includes('FROM myfin.stock_items'))return {rows:[{id:'milk',active:true,tracking_mode:'volume',unit_version:'1',on_hand:'900',version:'6'}],rowCount:1};
    throw Error(`Unexpected SQL: ${sql}`);
  }},route=routesFor(client).get('POST /api/companies/:company/stock-baselines'),body={reason:'Count after the morning delivery',
    idempotencyKey:'baseline-stale-1',items:[{stockItemId:'milk',expectedVersion:5,unitVersion:1,quantity:1000}]};
  await assert.rejects(()=>route({identity:{id:'manager',role:'manager'},body}),
    error=>error.statusCode===409&&error.message==='stock_item_changed_reload');
  assert.equal(calls.some(sql=>sql.startsWith('INSERT INTO myfin.stock_baselines')),false);
  calls.length=0;
  await assert.rejects(()=>route({identity:{id:'operator',role:'operator'},body}),
    error=>error.statusCode===403&&error.message==='access_denied');
  assert.deepEqual(calls,[]);
});
