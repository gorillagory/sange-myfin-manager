import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nextInternalCode} from '../src/stock.js';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('migration backfills collision-free internal stock codes and extends the scan-code invariant',async()=>{
  const sql=await read('../../db/migrations/0031_stock_internal_codes.sql');
  assert.match(sql,/FOR company_row IN SELECT DISTINCT company_id/);
  assert.match(sql,/CREATE FUNCTION myfin\.assign_stock_internal_code\(\)/);
  assert.match(sql,/IF NEW\.internal_code IS NOT NULL AND btrim\(NEW\.internal_code\)<>'' THEN RETURN NEW/);
  assert.match(sql,/pg_advisory_xact_lock\(hashtextextended\(NEW\.company_id,9\)\)/);
  assert.match(sql,/CREATE TRIGGER assign_stock_internal_code_before_insert[\s\S]*BEFORE INSERT ON myfin\.stock_items/);
  assert.match(sql,/SELECT 1 FROM myfin\.stock_items s[\s\S]*upper\(btrim\(s\.barcode\)\)=candidate/);
  assert.match(sql,/SELECT 1 FROM myfin\.stock_packagings p[\s\S]*upper\(btrim\(p\.barcode\)\)=candidate/);
  assert.match(sql,/SELECT 1 FROM myfin\.stock_identifiers i[\s\S]*normalized_value=candidate/);
  assert.match(sql,/CREATE UNIQUE INDEX stock_items_internal_code_key/);
  assert.match(sql,/CHECK\(internal_code ~ '\^STK-\[0-9\]\{6,18\}\$'\)/);
  assert.match(sql,/upper\(btrim\(s\.barcode\)\)=scan_code OR upper\(s\.internal_code\)=scan_code/);
  assert.match(sql,/BEFORE UPDATE OF company_id,barcode,internal_code/);
  assert.match(sql,/IF btrim\(NEW\.barcode\)<>'' AND upper\(btrim\(NEW\.barcode\)\)=upper\(NEW\.internal_code\)/);
});

test('server generator skips any occupied scan value and returns the next tenant sequence',async()=>{
  const candidates=[];
  const db={query:async(sql,args)=>{
    if(sql.includes('max(substring'))return {rows:[{next:'7'}],rowCount:1};
    candidates.push(args[1]);
    return {rows:candidates.length===1?[{conflict:1}]:[],rowCount:candidates.length===1?1:0};
  }};
  assert.equal(await nextInternalCode(db,'company'),'STK-000008');
  assert.deepEqual(candidates,['STK-000007','STK-000008']);
  const source=await read('../src/stock.js');
  assert.match(source,/internal_code ~ '\^STK-\[0-9\]\{6,18\}\$'/);
});

test('stock create serializes code allocation and returns the immutable server code',async()=>{
  const source=await read('../src/stock.js');
  const save=source.slice(source.indexOf('const save='),source.indexOf("app.post('/api/companies/:company/stock_items'"));
  assert.ok(save.indexOf('pg_advisory_xact_lock')<save.indexOf('nextInternalCode'));
  assert.match(save,/INSERT INTO myfin\.stock_items\(company_id,id,internal_code/);
  assert.match(source,/internalCode:row\.internal_code/);
  assert.match(save,/stock_internal_code_immutable/);
});

test('procurement lookup resolves generated stock codes and prevents identifier shadowing',async()=>{
  const source=await read('../src/procurement.js');
  const resolve=source.slice(source.indexOf("stock-identifiers/resolve/:code"),source.indexOf("app.post('/api/companies/:company/stock-identifiers'"));
  assert.match(resolve,/WHERE company_id=\$1 AND upper\(internal_code\)=\$2/);
  assert.match(resolve,/type:'internal_sku'/);
  assert.match(source,/upper\(btrim\(barcode\)\)=\$2 OR upper\(internal_code\)=\$2/);
});

test('existing runtime grants already cover the new stock_items column',async()=>{
  const grants=await Promise.all([read('../../db/grant-development-runtime.sql'),read('../../db/grant-production-runtime.sql')]);
  for(const sql of grants)assert.match(sql,/GRANT SELECT,\s*INSERT,\s*UPDATE ON myfin\.stock_items/i);
});
