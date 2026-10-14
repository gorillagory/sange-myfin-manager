import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { releaseOrderReservations } from '../src/customer-order-reservations.js';
import { customerOrderTransitionExpiry } from '../src/customer-orders.js';
import { checkout, receiptCapturePolicy } from '../src/business.js';
import { canonical, cartItem, createSale } from '../../src/domain/pos.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('recipe reservations retain validated immutable line and component evidence', async () => {
  const sql = await read('../../db/migrations/0028_recipe_order_integrity.sql');
  assert.match(sql, /CREATE TABLE myfin\.customer_order_recipe_reservations/);
  assert.match(sql, /PRIMARY KEY\(company_id,order_id,line_no,stock_item_id\)/);
  assert.match(sql, /REFERENCES myfin\.customer_order_lines\(company_id,order_id,line_no\) ON DELETE RESTRICT/);
  assert.match(sql, /REFERENCES myfin\.inventory_recipe_components\(company_id,recipe_id,recipe_version,stock_item_id\)/);
  assert.match(sql, /CHECK\(reserved_quantity=round\(line_quantity\*quantity_per_unit,6\)\)/);
  const validation = sql.slice(sql.indexOf('CREATE FUNCTION myfin.validate_customer_order_recipe_reservation'),
    sql.indexOf('CREATE FUNCTION myfin.protect_customer_order_recipe_reservation'));
  assert.match(validation, /NEW\.line_quantity<>evidence\.order_line_quantity/);
  assert.match(validation, /NEW\.quantity_per_unit<>evidence\.component_quantity/);
  assert.match(validation, /evidence\.current_recipe_version<>NEW\.recipe_version/);
  assert.match(validation, /recipe_reservation_recipe_changed/);
  const guard = sql.slice(sql.indexOf('CREATE FUNCTION myfin.protect_customer_order_recipe_reservation'),
    sql.indexOf('CREATE FUNCTION myfin.enforce_recipe_reservation_stock_floor'));
  for (const field of ['recipe_id','recipe_version','line_quantity','quantity_per_unit','reserved_quantity'])
    assert.match(guard, new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}`));
  assert.match(guard, /OLD\.state<>'active' OR NEW\.state NOT IN \('released','consumed'\)/);
  assert.match(guard, /IF TG_OP='DELETE'[\s\S]*recipe_reservation_immutable/);
});

test('stock mutations preserve all live accepted recipe reservations', async () => {
  const sql = await read('../../db/migrations/0028_recipe_order_integrity.sql');
  assert.match(sql, /customer_order_recipe_reservations_stock_active_idx[\s\S]*WHERE state='active'/);
  const insert = sql.slice(sql.indexOf('CREATE FUNCTION myfin.validate_customer_order_recipe_reservation'),
    sql.indexOf('CREATE FUNCTION myfin.protect_customer_order_recipe_reservation'));
  assert.ok(insert.indexOf('FROM myfin.stock_items') < insert.indexOf('FROM myfin.customer_order_recipe_reservations reservation'),
    'the stock row lock must serialize reservation capacity checks');
  assert.match(insert, /FOR UPDATE/);
  assert.match(insert, /reservation\.state='active' AND reservation\.expires_at>now\(\)/);
  assert.match(insert, /held_order\.status IN \('accepted','preparing','ready'\) OR reservation\.order_id=NEW\.order_id/);
  const floor = sql.slice(sql.indexOf('CREATE FUNCTION myfin.enforce_recipe_reservation_stock_floor'),
    sql.indexOf('ALTER TABLE myfin.receipt_reviews'));
  assert.match(floor, /reservation\.state='active' AND reservation\.expires_at>now\(\)/);
  assert.match(floor, /order_row\.status IN \('accepted','preparing','ready'\)/);
  assert.match(floor, /NEW\.on_hand<held[\s\S]*stock_below_active_recipe_reservations/);
  assert.match(floor, /OLD\.active AND NOT NEW\.active AND held>0[\s\S]*stock_item_has_active_recipe_reservations/);
  assert.match(floor, /BEFORE UPDATE OF on_hand,active ON myfin\.stock_items/);
});

test('recipe timing resolution is recorded only during pending review approval, including a boundary discovered later', async () => {
  const sql = await read('../../db/migrations/0028_recipe_order_integrity.sql');
  assert.match(sql, /ADD COLUMN inventory_recipe_resolution text/);
  assert.match(sql, /inventory_recipe_resolution IN \('current_recipe','captured_recipe'\)/);
  assert.match(sql, /inventory_recipe_resolution IS NULL OR[\s\S]*status='approved' AND coalesce\(payload->>'offline','false'\)='true'/);
  assert.match(sql, /reason_code<>'receipt_review_required_recipe_timing' OR[\s\S]*inventory_recipe_resolution IS NOT NULL/);
  const guard = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION myfin.protect_receipt_review'));
  assert.match(guard, /OLD\.status='pending' AND NEW\.status='approved'/);
  assert.match(guard, /NEW\.inventory_recipe_resolution IN \('current_recipe','captured_recipe'\)/);
  assert.match(guard, /NEW\.inventory_recipe_resolution IS NULL OR[\s\S]*coalesce\(NEW\.payload->>'offline','false'\)='true'/);
  assert.match(guard, /NEW\.reason_code<>'receipt_review_required_recipe_timing' OR[\s\S]*NEW\.inventory_recipe_resolution IN/);
});

test('delayed online receipts become historical captures without changing accepted customer orders', () => {
  const captured = '2026-10-11T08:00:00.000Z';
  assert.deepEqual(receiptCapturePolicy({ date:captured, offline:false }, '2026-10-11T08:04:59.000Z'), {
    capturedAt:new Date(captured), serverAt:new Date('2026-10-11T08:04:59.000Z'),
    valid:true, delayedRecovery:false, historicalCapture:false,
  });
  assert.deepEqual(receiptCapturePolicy({ date:captured, offline:false }, '2026-10-11T08:05:01.000Z'), {
    capturedAt:new Date(captured), serverAt:new Date('2026-10-11T08:05:01.000Z'),
    valid:true, delayedRecovery:true, historicalCapture:true,
  });
  assert.equal(receiptCapturePolicy({ date:captured, offline:true }, '2026-10-11T08:00:01.000Z').historicalCapture,true);
  assert.deepEqual(receiptCapturePolicy({ date:captured, offline:false }, '2026-10-14T08:00:00.000Z',true), {
    capturedAt:new Date(captured), serverAt:new Date('2026-10-14T08:00:00.000Z'),
    valid:true, delayedRecovery:false, historicalCapture:false,
  });
  const source = receiptCapturePolicy.toString();
  assert.match(source,/Math\.abs/,'future device-clock skew and old retries share review protection');
});

test('new offline receipts always require durable review before posting', async () => {
  const source = await read('../src/business.js');
  const existingTransactionBranch = source.indexOf('if (existing.rowCount)');
  const offlineReviewGuard = source.indexOf("v.fail(409,'receipt_review_required_offline_sync')");
  const transactionInsert = source.indexOf('INSERT INTO myfin.transactions');
  assert.ok(existingTransactionBranch >= 0 && existingTransactionBranch < offlineReviewGuard,
    'an exact posted replay must remain idempotent');
  assert.ok(offlineReviewGuard < transactionInsert,
    'offline paid intent must enter review before accounting or inventory mutation');
  assert.match(source,/if\(!approval&&!options\.acceptedOrderQuote\)[\s\S]*receipt_review_required_offline_sync/,
    'approval replays and accepted customer-order checkouts bypass the staging guard');
  assert.ok(source.indexOf("receipt_review_required_offline_time") < offlineReviewGuard,
    'an unusual offline timestamp keeps its stronger review reason');
});

test('receipt review constraints permit recipe evidence for delayed-sync recovery only', async () => {
  const sql = await read('../../db/migrations/0034_receipt_sync_recovery.sql');
  assert.match(sql,/DROP CONSTRAINT receipt_reviews_recipe_resolution_context/);
  assert.match(sql,/reason_code='receipt_review_required_delayed_sync'/);
  assert.match(sql,/coalesce\(payload->>'offline','false'\)='true' OR[\s\S]*receipt_review_required_delayed_sync/);
  const guard = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION myfin.protect_receipt_review'));
  assert.match(guard,/NEW\.reason_code='receipt_review_required_delayed_sync'/);
  assert.doesNotMatch(sql,/GRANT .*UPDATE.*inventory_source_effects/);
});

test('runtime may create and finalize recipe reservations but never delete them', async () => {
  const grants = await Promise.all([
    read('../../db/grant-development-runtime.sql'), read('../../db/grant-production-runtime.sql'),
  ]);
  for (const sql of grants) {
    assert.match(sql, /GRANT SELECT,INSERT,UPDATE ON myfin\.customer_order_recipe_reservations/);
    assert.doesNotMatch(sql, /GRANT[^;]*DELETE[^;]*myfin\.customer_order_recipe_reservations/);
  }
});

test('all customer-order terminal paths share the guarded recipe release lifecycle', async () => {
  for (const reason of ['cancelled','expired','paid']) {
    const calls=[],client={query:async(sql,args)=>{calls.push({sql,args});return {rowCount:1,rows:[]};}};
    await releaseOrderReservations(client,'company','order',reason);
    assert.equal(calls.length,2);
    assert.match(calls[1].sql,/SET state='released',released_at=now\(\),release_reason=\$3/);
    assert.deepEqual(calls[1].args,['company','order',reason]);
  }
  const [orders,maintenance,storefront]=await Promise.all([
    read('../src/customer-orders.js'),read('../src/customer-order-maintenance.js'),read('../src/storefront-public.js'),
  ]);
  assert.match(orders,/\['cancelled','expired'\][\s\S]*releaseOrderReservations\(c, companyId, id, change\.status\)/);
  assert.match(orders,/releaseOrderReservations\(c, companyId, id, 'paid'\)/);
  assert.match(maintenance,/releaseOrderReservations\(c, order\.company_id, order\.id, 'expired'\)/);
  assert.match(storefront,/releaseOrderReservations\(c, order\.company_id, order\.id, 'expired'\)/);
});

test('pickup scheduling can establish reservation expiry only during acceptance',()=>{
  const now=Date.parse('2026-10-09T00:00:00.000Z'),row={expires_at:'2026-10-09T00:15:00.000Z'};
  assert.equal(customerOrderTransitionExpiry(row,{status:'accepted'},now).toISOString(),'2026-10-09T01:00:00.000Z');
  assert.equal(customerOrderTransitionExpiry(row,{status:'accepted',pickupAt:'2026-10-09T02:00:00.000Z'},now).toISOString(),
    '2026-10-09T02:30:00.000Z');
  assert.throws(()=>customerOrderTransitionExpiry(row,{status:'preparing',pickupAt:'2026-10-09T02:00:00.000Z'},now),
    error=>error.statusCode===400&&error.message==='pickup_time_only_on_acceptance');
  assert.throws(()=>customerOrderTransitionExpiry(row,{status:'accepted',pickupAt:'2026-10-08T23:59:59.000Z'},now),
    error=>error.statusCode===400&&error.message==='invalid_pickup_time');
});

test('walk-in recipe shortage enters paid-receipt review without bypassing order holds',async()=>{
  const source=await read('../src/business.js');
  assert.match(source,/!options\.reservationOrderId&&error\?\.message==='recipe_stock_unavailable'[\s\S]*receipt_review_required_recipe_stock/);
  const reviews=await read('../src/receipt-reviews.js');
  assert.match(reviews,/\^receipt_review_required_/);
});

test('existing receipt approval accepts only the recipe resolution recorded by the transaction',async()=>{
  const company={id:'resolution-company',name:'Resolution shop',preferences:{currency:'RM',taxRate:0}},
    cashier={id:'resolution-cashier',uid:'resolution-cashier',username:'Cashier',role:'operator'},
    sale=createSale({id:'resolution-replay',items:[cartItem({id:'latte',name:'Latte',price:10,
      stock:0,trackStock:false})],company,user:cashier,method:'Cash',received:10,offline:true});
  const row={id:sale.id,company_id:company.id,actor_id:cashier.id,source:'pos',total:sale.total,
    fingerprint:createHash('sha256').update(JSON.stringify(canonical(sale))).digest('hex'),
    data:{...sale,inventoryRecipeResolution:'current_recipe'}};
  const client={query:async sql=>{
    if(sql.includes('pg_advisory_xact_lock'))return {rowCount:1,rows:[]};
    if(sql.includes('FROM myfin.transactions'))return {rowCount:1,rows:[row]};
    throw Error(`Unexpected query: ${sql}`);
  }},options={serverNow:sale.date};
  const exact=await checkout(client,cashier,company.id,sale,
    {who:{id:'manager'},reason:'Reviewed',inventoryRecipeResolution:'current_recipe'},options);
  assert.equal(exact.id,sale.id);
  await assert.rejects(checkout(client,cashier,company.id,sale,
    {who:{id:'manager'},reason:'Changed',inventoryRecipeResolution:'captured_recipe'},options),
  error=>error?.statusCode===409&&error?.message==='inventory_recipe_resolution_changed');
  row.data={...sale};
  await assert.rejects(checkout(client,cashier,company.id,sale,
    {who:{id:'manager'},reason:'Invented',inventoryRecipeResolution:'current_recipe'},options),
  error=>error?.statusCode===409&&error?.message==='inventory_recipe_resolution_changed');
});
