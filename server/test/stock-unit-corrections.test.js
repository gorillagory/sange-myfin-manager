import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {countedQuantitiesValid,registerStock} from '../src/stock.js';

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

test('unit correction migration preserves immutable units and monotonic stock codes',async()=>{
  const sql=await readFile(new URL('../../db/migrations/0045_stock_unit_corrections.sql',import.meta.url),'utf8');
  assert.match(sql,/CREATE TABLE myfin\.stock_internal_code_counters/);
  assert.match(sql,/CREATE OR REPLACE FUNCTION myfin\.assign_stock_internal_code/);
  assert.match(sql,/pg_advisory_xact_lock\(hashtextextended\(NEW\.company_id,9\)\)/);
  assert.match(sql,/tracking_mode_at_time text/);
  assert.match(sql,/base_unit_at_time text/);
  assert.match(sql,/packaging_label_at_time IS NOT NULL/);
  assert.match(sql,/FROM myfin\.stock_items[\s\S]*FOR KEY SHARE/);
  assert.match(sql,/CREATE TABLE myfin\.stock_unit_corrections/);
  assert.match(sql,/conversion_factor numeric\(19,9\)[\s\S]*conversion_factor <= 1000000000/);
  assert.match(sql,/packagings_before jsonb NOT NULL/);
  assert.match(sql,/packagings_after jsonb NOT NULL/);
  assert.match(sql,/UNIQUE\(company_id,stock_item_id,from_unit_version\)/);
  assert.match(sql,/UNIQUE\(company_id,stock_item_id,to_unit_version\)/);
  assert.match(sql,/immutable_stock_unit_corrections/);
});

test('count-mode validation uses converted package quantities',()=>{
  assert.equal(countedQuantitiesValid(['2.000000','1.000000','1.000000']),true);
  assert.equal(countedQuantitiesValid(['1.000000','0.500000']),false);
});

test('a movement opened before a unit correction is rejected before writing',async()=>{
  const calls=[];const client={query:async(sql,args=[])=>{
    calls.push({sql,args});
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('FROM myfin.stock_ledger')&&sql.includes('idempotency_key'))return {rows:[],rowCount:0};
    if(sql.includes('FROM myfin.stock_items')&&sql.includes('FOR UPDATE'))return {rows:[{id:'stock',unit_version:'2',active:true}],rowCount:1};
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  const route=routesFor(client).get('POST /api/companies/:company/stock_items/:id/movements');
  await assert.rejects(()=>route({identity:{id:'owner',role:'workspace_owner'},params:{id:'stock'},body:{
    kind:'receive',quantity:1,unitVersion:1,reason:'Supplier delivery',idempotencyKey:'movement-0001',
  }}),error=>error.statusCode===409&&error.message==='stock_unit_changed_reload');
  assert.equal(calls.some(call=>call.sql.startsWith('UPDATE myfin.stock_items')),false);
});

test('ordinary item edits round-trip unitVersion without rewriting the balance',async()=>{
  let updateSql='';
  const current={id:'stock',company_id:'company',internal_code:'STK-000001',name:'Milk',category:'Ingredients',
    tracking_mode:'volume',base_unit:'ml',unit_version:'3',barcode:'',on_hand:'999999999999.999999',
    reorder_level:'100',preferred_supplier_id:null,active:true,notes:'',version:'7'};
  const client={query:async(sql,args=[])=>{
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('SELECT * FROM myfin.stock_items')&&sql.includes('FOR UPDATE'))return {rows:[current],rowCount:1};
    if(sql.includes('SELECT barcode AS code'))return {rows:[],rowCount:0};
    if(sql.includes('SELECT * FROM myfin.stock_packagings')&&sql.includes('FOR UPDATE'))return {rows:[],rowCount:0};
    if(sql.includes('SELECT DISTINCT packaging_id'))return {rows:[],rowCount:0};
    if(sql.startsWith('UPDATE myfin.stock_items SET')){updateSql=sql;current.name=args[2];current.version='8';return {rows:[],rowCount:1};}
    if(sql.includes('SELECT * FROM myfin.stock_items'))return {rows:[current],rowCount:1};
    if(sql.includes('item_id=ANY'))return {rows:[],rowCount:0};
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  const route=routesFor(client).get('PUT /api/companies/:company/stock_items/:id');
  const result=await route({identity:{id:'owner',role:'workspace_owner'},params:{id:'stock'},body:{
    id:'stock',company_id:'company',version:7,unitVersion:3,internalCode:'STK-000001',name:'Fresh milk',
    category:'Ingredients',trackingMode:'volume',baseUnit:'ml',barcode:'',onHand:1e12,reorderLevel:100,
    preferredSupplierId:'',active:true,notes:'',packagings:[],
  }});
  assert.equal(result.name,'Fresh milk');
  assert.equal(result.unitVersion,3);
  assert.match(updateSql,/on_hand=CASE WHEN \$13='convert'[\s\S]*ELSE on_hand END/);
  assert.doesNotMatch(updateSql,/on_hand=\$8/);
});

test('converted count validation trusts exact PostgreSQL whole flags at the numeric ceiling',async()=>{
  const exactMaximum='999999999999.999999',calls=[];
  assert.equal(Number.isInteger(Number(exactMaximum)),true,'JavaScript loses the fractional part at this magnitude');
  const current={id:'stock',company_id:'company',internal_code:'STK-000001',name:'Bulk pieces',category:'General',
    tracking_mode:'volume',base_unit:'ml',unit_version:'4',barcode:'',on_hand:exactMaximum,
    reorder_level:'2.000000',preferred_supplier_id:null,active:true,notes:'',version:'9'};
  const pack={id:'pack',item_id:'stock',company_id:'company',label:'Tank',barcode:'',quantity_in_base:exactMaximum};
  const client={query:async(sql,args=[])=>{
    calls.push({sql,args});
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('SELECT * FROM myfin.stock_items')&&sql.includes('FOR UPDATE'))return {rows:[current],rowCount:1};
    if(sql.includes('SELECT * FROM myfin.stock_packagings')&&sql.includes('FOR UPDATE'))return {rows:[pack],rowCount:1};
    if(sql.includes(' AS ledger,'))return {rows:[{}],rowCount:1};
    if(sql.includes('SELECT on_hand::text'))return {rows:[{on_hand_before:exactMaximum,reorder_before:'2.000000',
      on_hand_after:exactMaximum,reorder_after:'2.000000',on_hand_whole:false,reorder_whole:true,valid:true}],rowCount:1};
    if(sql.includes('quantity_in_base::text AS quantity_before'))return {rows:[{id:'pack',label:'Tank',barcode:'',
      quantity_before:exactMaximum,quantity_after:exactMaximum,quantity_whole:false,valid:true}],rowCount:1};
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  const route=routesFor(client).get('PUT /api/companies/:company/stock_items/:id');
  await assert.rejects(()=>route({identity:{id:'owner',role:'workspace_owner'},params:{id:'stock'},body:{
    id:'stock',company_id:'company',version:9,unitVersion:4,internalCode:'STK-000001',name:'Bulk pieces',
    category:'General',trackingMode:'count',baseUnit:'pcs',barcode:'',onHand:Number(exactMaximum),reorderLevel:2,
    preferredSupplierId:'',active:true,notes:'',packagings:[{id:'pack',label:'Tank',barcode:'',quantityInBase:Number(exactMaximum)}],
    unitCorrection:{strategy:'relabel',conversionFactor:1,reason:'Correct the tracking method'},
  }}),error=>error.statusCode===400&&error.message==='counted_stock_requires_whole_units');
  const calculation=calls.find(call=>call.sql.includes('SELECT on_hand::text'));
  const packages=calls.find(call=>call.sql.includes('quantity_in_base::text AS quantity_before'));
  assert.match(calculation.sql,/AS on_hand_whole/);
  assert.match(calculation.sql,/AS reorder_whole/);
  assert.match(packages.sql,/AS quantity_whole/);
  assert.equal(calls.some(call=>call.sql.startsWith('UPDATE myfin.stock_items SET')),false);
});

test('a reorder edit cannot be folded into a unit correction',async()=>{
  const calls=[],current={id:'stock',company_id:'company',internal_code:'STK-000001',name:'Milk',category:'Ingredients',
    tracking_mode:'volume',base_unit:'L',unit_version:'2',barcode:'',on_hand:'5.000000',reorder_level:'2.000000',
    preferred_supplier_id:null,active:true,notes:'',version:'3'};
  const client={query:async(sql,args=[])=>{
    calls.push({sql,args});
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('SELECT * FROM myfin.stock_items')&&sql.includes('FOR UPDATE'))return {rows:[current],rowCount:1};
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  const route=routesFor(client).get('PUT /api/companies/:company/stock_items/:id');
  await assert.rejects(()=>route({identity:{id:'owner',role:'workspace_owner'},params:{id:'stock'},body:{
    id:'stock',company_id:'company',version:3,unitVersion:2,internalCode:'STK-000001',name:'Milk',category:'Ingredients',
    trackingMode:'volume',baseUnit:'ml',barcode:'',onHand:5,reorderLevel:3,preferredSupplierId:'',active:true,notes:'',packagings:[],
    unitCorrection:{strategy:'convert',conversionFactor:1000,reason:'Correct litres to millilitres'},
  }}),error=>error.statusCode===409&&error.message==='save_unit_correction_separately_from_reorder_change');
  assert.equal(calls.some(call=>call.sql.includes('SELECT on_hand::text')),false);
  assert.equal(calls.some(call=>call.sql.startsWith('UPDATE ')),false);
});

test('descriptive item edits cannot be folded into a measurement correction audit',async()=>{
  const calls=[],current={id:'stock',company_id:'company',internal_code:'STK-000001',name:'Milk',category:'Ingredients',
    tracking_mode:'volume',base_unit:'L',unit_version:'2',barcode:'',on_hand:'5.000000',reorder_level:'2.000000',
    preferred_supplier_id:null,active:true,notes:'Original note',version:'3'};
  const client={query:async(sql,args=[])=>{
    calls.push({sql,args});
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('SELECT * FROM myfin.stock_items')&&sql.includes('FOR UPDATE'))return {rows:[current],rowCount:1};
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  const route=routesFor(client).get('PUT /api/companies/:company/stock_items/:id');
  await assert.rejects(()=>route({identity:{id:'owner',role:'workspace_owner'},params:{id:'stock'},body:{
    id:'stock',company_id:'company',version:3,unitVersion:2,internalCode:'STK-000001',name:'Renamed milk',category:'Ingredients',
    trackingMode:'volume',baseUnit:'ml',barcode:'',onHand:5,reorderLevel:2,preferredSupplierId:'',active:true,notes:'Original note',packagings:[],
    unitCorrection:{strategy:'convert',conversionFactor:1000,reason:'Correct litres to millilitres'},
  }}),error=>error.statusCode===409&&error.message==='save_unit_correction_separately_from_item_changes');
  assert.equal(calls.some(call=>call.sql.includes('SELECT * FROM myfin.stock_packagings')),false);
  assert.equal(calls.some(call=>call.sql.startsWith('UPDATE ')),false);
});

test('conversion preserves exact package snapshots without rewriting browser-rounded quantities first',async()=>{
  const exactMaximum='999999999999.999999',calls=[];
  const current={id:'stock',company_id:'company',internal_code:'STK-000001',name:'Milk',category:'Ingredients',
    tracking_mode:'volume',base_unit:'ml',unit_version:'7',barcode:'',on_hand:exactMaximum,reorder_level:'100.000000',
    preferred_supplier_id:null,active:true,notes:'',version:'11'};
  const pack={id:'pack',item_id:'stock',company_id:'company',label:'Reservoir',barcode:'',quantity_in_base:exactMaximum};
  let correctionArgs;
  const client={query:async(sql,args=[])=>{
    calls.push({sql,args});
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('SELECT * FROM myfin.stock_items')&&sql.includes('FOR UPDATE'))return {rows:[current],rowCount:1};
    if(sql.includes('SELECT * FROM myfin.stock_packagings')&&sql.includes('FOR UPDATE'))return {rows:[pack],rowCount:1};
    if(sql.includes(' AS ledger,'))return {rows:[{}],rowCount:1};
    if(sql.includes('SELECT on_hand::text'))return {rows:[{on_hand_before:exactMaximum,reorder_before:'100.000000',
      on_hand_after:'1000000.000000',reorder_after:'0.000100',on_hand_whole:true,reorder_whole:false,valid:true}],rowCount:1};
    if(sql.includes('quantity_in_base::text AS quantity_before'))return {rows:[{id:'pack',label:'Reservoir',barcode:'',
      quantity_before:exactMaximum,quantity_after:'1000000.000000',quantity_whole:true,valid:true}],rowCount:1};
    if(sql.includes('SELECT barcode AS code'))return {rows:[],rowCount:0};
    if(sql.startsWith('UPDATE myfin.stock_items SET')){
      current.base_unit='L';current.on_hand='1000000.000000';current.reorder_level='0.000100';current.unit_version='8';current.version='12';
      return {rows:[],rowCount:1};
    }
    if(sql.startsWith('UPDATE myfin.stock_packagings SET quantity_in_base=')){pack.quantity_in_base='1000000.000000';return {rows:[],rowCount:1};}
    if(sql.startsWith('INSERT INTO myfin.stock_unit_corrections')){correctionArgs=args;return {rows:[],rowCount:1};}
    if(sql.includes('SELECT * FROM myfin.stock_items'))return {rows:[current],rowCount:1};
    if(sql.includes('item_id=ANY'))return {rows:[pack],rowCount:1};
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  const route=routesFor(client).get('PUT /api/companies/:company/stock_items/:id');
  const result=await route({identity:{id:'owner',role:'workspace_owner'},params:{id:'stock'},body:{
    id:'stock',company_id:'company',version:11,unitVersion:7,internalCode:'STK-000001',name:'Milk',category:'Ingredients',
    trackingMode:'volume',baseUnit:'L',barcode:'',onHand:Number(exactMaximum),reorderLevel:100,preferredSupplierId:'',active:true,notes:'',
    packagings:[{id:'pack',label:'Reservoir',barcode:'',quantityInBase:Number(exactMaximum)}],
    unitCorrection:{strategy:'convert',conversionFactor:0.000001,reason:'Correct microunits to litres'},
  }});
  assert.equal(result.unitVersion,8);
  assert.deepEqual(JSON.parse(correctionArgs[16]),[{id:'pack',label:'Reservoir',barcode:'',quantityInBase:exactMaximum}]);
  assert.deepEqual(JSON.parse(correctionArgs[17]),[{id:'pack',label:'Reservoir',barcode:'',quantityInBase:'1000000.000000'}]);
  assert.equal(correctionArgs[11],'0.000001000');
  assert.equal(calls.find(call=>call.sql.startsWith('UPDATE myfin.stock_items SET')).args[13],correctionArgs[11]);
  assert.equal(calls.find(call=>call.sql.startsWith('UPDATE myfin.stock_packagings')).args[2],correctionArgs[11]);
  assert.equal(calls.some(call=>call.sql.includes('SET label=$4,barcode=$5,quantity_in_base=$6')),false);
  assert.equal(calls.filter(call=>call.sql.startsWith('UPDATE myfin.stock_packagings')).length,1);
});

test('the maximum API conversion factor reaches PostgreSQL as the schema-supported boundary',async()=>{
  let factorArgument='';
  const current={id:'stock',company_id:'company',internal_code:'STK-000001',name:'Empty tank',category:'General',
    tracking_mode:'volume',base_unit:'L',unit_version:'1',barcode:'',on_hand:'0.000000',reorder_level:'0.000000',
    preferred_supplier_id:null,active:true,notes:'',version:'1'};
  const client={query:async(sql,args=[])=>{
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('SELECT * FROM myfin.stock_items')&&sql.includes('FOR UPDATE'))return {rows:[current],rowCount:1};
    if(sql.includes('SELECT * FROM myfin.stock_packagings')&&sql.includes('FOR UPDATE'))return {rows:[],rowCount:0};
    if(sql.includes(' AS ledger,'))return {rows:[{}],rowCount:1};
    if(sql.includes('SELECT on_hand::text')){factorArgument=args[2];return {rows:[{on_hand_before:'0.000000',reorder_before:'0.000000',
      on_hand_after:'0.000000',reorder_after:'0.000000',on_hand_whole:true,reorder_whole:true,valid:false}],rowCount:1};}
    if(sql.includes('quantity_in_base::text AS quantity_before'))return {rows:[],rowCount:0};
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  const route=routesFor(client).get('PUT /api/companies/:company/stock_items/:id');
  await assert.rejects(()=>route({identity:{id:'owner',role:'workspace_owner'},params:{id:'stock'},body:{
    id:'stock',company_id:'company',version:1,unitVersion:1,internalCode:'STK-000001',name:'Empty tank',category:'General',
    trackingMode:'volume',baseUnit:'ml',barcode:'',onHand:0,reorderLevel:0,preferredSupplierId:'',active:true,notes:'',packagings:[],
    unitCorrection:{strategy:'convert',conversionFactor:1000000000,reason:'Apply the supported upper boundary'},
  }}),error=>error.statusCode===400&&error.message==='stock_unit_conversion_out_of_range');
  assert.equal(factorArgument,'1000000000.000000000');
});
