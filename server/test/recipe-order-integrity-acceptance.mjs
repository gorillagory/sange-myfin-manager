// Explicit opt-in: this suite creates and drops one database on a disposable,
// locally bound PostgreSQL 16 cluster carrying the marker below.
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { readMigrations,runMigrations } from '../src/migrations.js';
import { assertRecipeAvailability,consumeRecipeStock,reserveRecipeStock } from '../src/inventory-recipes.js';
import { expireStaleCustomerOrders } from '../src/customer-order-maintenance.js';
import { releaseOrderReservations } from '../src/customer-order-reservations.js';

const marker='myfin-recipe-order-integrity-pg16';
const adminConnection=process.env.MYFIN_RECIPE_ORDER_DATABASE_URL||'';
if(process.env.MYFIN_RECIPE_ORDER_ACCEPTANCE!==marker||!adminConnection)
  throw Error('recipe_order_integrity_opt_in_required');
const parsed=new URL(adminConnection);
if(!['127.0.0.1','localhost','::1'].includes(parsed.hostname)||parsed.pathname!=='/postgres')
  throw Error('unsafe_recipe_order_integrity_target');

const admin=new pg.Client({connectionString:adminConnection});
await admin.connect();
assert.match((await admin.query('SELECT version() AS version')).rows[0].version,/PostgreSQL 16\./);
assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name,marker);

const databaseName=`myfin_recipe_order_${randomUUID().replaceAll('-','').slice(0,16)}`;
if(!/^myfin_recipe_order_[a-f0-9]{16}$/.test(databaseName))throw Error('unsafe_test_database_name');
const databaseUrl=new URL(adminConnection);databaseUrl.pathname=`/${databaseName}`;
let pool;
const digest=value=>createHash('sha256').update(String(value)).digest('hex');
let publicSequence=0;

async function transaction(work){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const result=await work(client);
    await client.query('COMMIT');
    return result;
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{client.release();}
}

async function seedFixture(client,key,{onHand=20,quantityPerUnit=2,trackingMode='weight',
  versionCreatedAt=new Date(Date.now()-3600000)}={}){
  const fixture={key,workspaceId:`workspace-${key}`,companyId:`company-${key}`,actorId:`actor-${key}`,
    productId:`product-${key}`,stockItemId:`ingredient-${key}`,recipeId:`recipe-${key}`,
    locationId:`location-${key}`,hostname:`order-${key}.test`,guestDigest:digest(`guest-${key}`)};
  await client.query('INSERT INTO myfin.workspaces(id,name,slug) VALUES($1,$2,$3)',
    [fixture.workspaceId,`Workspace ${key}`,fixture.workspaceId]);
  await client.query('INSERT INTO myfin.app_identities(id,display_name) VALUES($1,$2)',
    [fixture.actorId,`Actor ${key}`]);
  await client.query(`INSERT INTO myfin.companies(id,name,workspace_id,slug,data)
    VALUES($1,$2,$3,$4,'{}')`,[fixture.companyId,`Company ${key}`,fixture.workspaceId,fixture.companyId]);
  await client.query(`INSERT INTO myfin.products(company_id,id,data,stock,price,cost)
    VALUES($1,$2,$3,0,10,2)`,[fixture.companyId,fixture.productId,
    {id:fixture.productId,name:`Product ${key}`,stock:0,trackStock:false,variants:[],category:'Food'}]);
  await client.query(`INSERT INTO myfin.stock_items(company_id,id,name,tracking_mode,base_unit,on_hand)
    VALUES($1,$2,$3,$4,$5,$6)`,[fixture.companyId,fixture.stockItemId,`Ingredient ${key}`,
    trackingMode,trackingMode==='count'?'unit':'g',onHand]);
  await client.query(`INSERT INTO myfin.storefront_hosts(hostname,company_id,created_by)
    VALUES($1,$2,$3)`,[fixture.hostname,fixture.companyId,fixture.actorId]);
  await client.query(`INSERT INTO myfin.customer_guest_sessions(token_digest,storefront_hostname,expires_at)
    VALUES($1,$2,now()+interval '1 day')`,[fixture.guestDigest,fixture.hostname]);
  await client.query(`INSERT INTO myfin.shop_locations(company_id,id,name,token_digest,token_hint,created_by)
    VALUES($1,$2,$3,$4,'hint',$5)`,[fixture.companyId,fixture.locationId,`Location ${key}`,
    digest(`location-${key}`),fixture.actorId]);
  await client.query(`INSERT INTO myfin.inventory_recipes(
    company_id,id,product_id,enabled,version,updated_by) VALUES($1,$2,$3,true,1,$4)`,
  [fixture.companyId,fixture.recipeId,fixture.productId,fixture.actorId]);
  await client.query(`INSERT INTO myfin.inventory_recipe_versions(
    company_id,recipe_id,version,enabled,catalog_stock_disabled,request_digest,created_by,created_at)
    VALUES($1,$2,1,true,true,$3,$4,$5)`,[fixture.companyId,fixture.recipeId,digest(`${key}:v1`),
    fixture.actorId,versionCreatedAt]);
  await client.query(`INSERT INTO myfin.inventory_recipe_components(
    company_id,recipe_id,recipe_version,stock_item_id,position,quantity_per_unit)
    VALUES($1,$2,1,$3,0,$4)`,[fixture.companyId,fixture.recipeId,fixture.stockItemId,quantityPerUnit]);
  return fixture;
}

async function createOrder(client,fixture,{quantity=2,expiresInMs=3600000}={}){
  const ordinal=++publicSequence,id=`order-${fixture.key}-${ordinal}`;
  await client.query(`INSERT INTO myfin.customer_order_requests(
    company_id,id,public_code,location_id,currency,subtotal,total_before_rounding,total,
    guest_session_digest,idempotency_key,request_digest,expires_at,service_mode)
    VALUES($1,$2,$3,$4,'MYR',$5,$5,$5,$6,$7,$8,$9,'pickup')`,[fixture.companyId,id,
    String(ordinal).padStart(8,'0'),fixture.locationId,quantity*10,fixture.guestDigest,
    `idempotency-${fixture.key}-${ordinal}`,digest(`${fixture.key}:order:${ordinal}`),
    new Date(Date.now()+expiresInMs)]);
  await client.query(`INSERT INTO myfin.customer_order_lines(
    company_id,order_id,line_no,product_id,description,quantity,unit_price,line_total)
    VALUES($1,$2,1,$3,$4,$5,10,$6)`,[fixture.companyId,id,fixture.productId,
    `Product ${fixture.key}`,quantity,quantity*10]);
  return (await client.query('SELECT * FROM myfin.customer_order_requests WHERE company_id=$1 AND id=$2',
    [fixture.companyId,id])).rows[0];
}

async function acceptOrder(fixture,orderId){
  return transaction(async client=>{
    const order=(await client.query(`SELECT * FROM myfin.customer_order_requests
      WHERE company_id=$1 AND id=$2 FOR UPDATE`,[fixture.companyId,orderId])).rows[0];
    const lines=(await client.query(`SELECT * FROM myfin.customer_order_lines
      WHERE company_id=$1 AND order_id=$2 ORDER BY line_no`,[fixture.companyId,orderId])).rows;
    await reserveRecipeStock(client,{companyId:fixture.companyId,order,lines});
    await client.query(`UPDATE myfin.customer_order_requests
      SET status='accepted',accepted_at=now(),version=version+1,updated_at=now()
      WHERE company_id=$1 AND id=$2`,[fixture.companyId,orderId]);
    return (await client.query('SELECT * FROM myfin.customer_order_requests WHERE company_id=$1 AND id=$2',
      [fixture.companyId,orderId])).rows[0];
  });
}

async function publishRecipeVersion(client,fixture,{version,quantityPerUnit,createdAt=new Date()}={}){
  await client.query(`INSERT INTO myfin.inventory_recipe_versions(
    company_id,recipe_id,version,enabled,catalog_stock_disabled,request_digest,created_by,created_at)
    VALUES($1,$2,$3,true,true,$4,$5,$6)`,[fixture.companyId,fixture.recipeId,version,
    digest(`${fixture.key}:v${version}`),fixture.actorId,createdAt]);
  await client.query(`INSERT INTO myfin.inventory_recipe_components(
    company_id,recipe_id,recipe_version,stock_item_id,position,quantity_per_unit)
    VALUES($1,$2,$3,$4,0,$5)`,[fixture.companyId,fixture.recipeId,version,
    fixture.stockItemId,quantityPerUnit]);
  await client.query(`UPDATE myfin.inventory_recipes SET version=$3,enabled=true,updated_by=$4,updated_at=now()
    WHERE company_id=$1 AND id=$2`,[fixture.companyId,fixture.recipeId,version,fixture.actorId]);
}

async function insertSale(client,fixture,saleId,occurredAt){
  await client.query(`INSERT INTO myfin.transactions(company_id,id,actor_id,source,total,fingerprint,data)
    VALUES($1,$2,$3,'pos',20,$4,$5)`,[fixture.companyId,saleId,fixture.actorId,digest(`${saleId}:fingerprint`),
    {type:'Receipt',date:occurredAt,customerName:'Acceptance customer',items:[]}]);
}

async function tenderReservedOrder(fixture,{orderId,saleId,requestId,serverOccurredAt,quantity=2,
  failAfterInventory=false}={}){
  return transaction(async client=>{
    const prior=(await client.query(`SELECT sale_id FROM myfin.customer_order_payments
      WHERE company_id=$1 AND request_id=$2`,[fixture.companyId,requestId])).rows[0];
    if(prior)return {duplicate:true,saleId:prior.sale_id};
    await insertSale(client,fixture,saleId,serverOccurredAt);
    const inventory=await consumeRecipeStock(client,{companyId:fixture.companyId,actorId:fixture.actorId,
      saleId,serverOccurredAt,capturedAt:serverOccurredAt,reservationOrderId:orderId,
      items:[{productId:fixture.productId,variantId:'',qty:quantity}]});
    if(failAfterInventory)throw Error('forced_after_inventory');
    await client.query(`INSERT INTO myfin.customer_order_payments(
      company_id,order_id,sale_id,actor_id,request_id,request_digest)
      VALUES($1,$2,$3,$4,$5,$6)`,[fixture.companyId,orderId,saleId,fixture.actorId,
      requestId,digest(`${requestId}:payment`)]);
    const paid=await client.query(`UPDATE myfin.customer_order_requests
      SET status='paid',payment_state='paid',version=version+1,updated_at=now()
      WHERE company_id=$1 AND id=$2 AND status IN ('accepted','preparing','ready')
      RETURNING id`,[fixture.companyId,orderId]);
    assert.equal(paid.rowCount,1);
    return {duplicate:false,saleId,inventory};
  });
}

try{
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const migrator=new pg.Client({connectionString:databaseUrl.href});
  await migrator.connect();
  try{
    await migrator.query('CREATE SCHEMA myfin');
    const migrations=await readMigrations();
    assert.equal((await runMigrations(migrator,migrations)).length,migrations.length);
    assert.deepEqual(await runMigrations(migrator,migrations),[]);
  }finally{await migrator.end();}
  pool=new pg.Pool({connectionString:databaseUrl.href,max:12});

  await test('concurrent accepted orders serialize one shared ingredient hold',async()=>{
    const fixture=await transaction(client=>seedFixture(client,`concurrent-${randomUUID().slice(0,8)}`,{onHand:6}));
    const [first,second]=await transaction(async client=>[
      await createOrder(client,fixture),await createOrder(client,fixture),
    ]);
    const results=await Promise.allSettled([acceptOrder(fixture,first.id),acceptOrder(fixture,second.id)]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    const failure=results.find(result=>result.status==='rejected')?.reason;
    assert.equal(failure?.statusCode,409);assert.equal(failure?.message,'recipe_stock_unavailable');
    const states=(await pool.query(`SELECT id,status FROM myfin.customer_order_requests
      WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id`,[fixture.companyId,[first.id,second.id]])).rows;
    assert.deepEqual(states.map(row=>row.status).sort(),['accepted','awaiting_acceptance']);
    const reservations=await pool.query(`SELECT count(*)::int AS count,sum(reserved_quantity)::numeric AS quantity
      FROM myfin.customer_order_recipe_reservations WHERE company_id=$1`,[fixture.companyId]);
    assert.equal(reservations.rows[0].count,1);assert.equal(Number(reservations.rows[0].quantity),4);
  });

  await test('held recipe version survives edits and tender plus retry are exact once',async()=>{
    const fixture=await transaction(client=>seedFixture(client,`version-${randomUUID().slice(0,8)}`,{onHand:20}));
    const order=await transaction(client=>createOrder(client,fixture));
    await acceptOrder(fixture,order.id);
    await transaction(client=>publishRecipeVersion(client,fixture,{version:2,quantityPerUnit:3}));
    const held=(await pool.query(`SELECT recipe_version,reserved_quantity,state
      FROM myfin.customer_order_recipe_reservations WHERE company_id=$1 AND order_id=$2`,
    [fixture.companyId,order.id])).rows[0];
    assert.equal(Number(held.recipe_version),1);assert.equal(Number(held.reserved_quantity),4);
    const instant=new Date().toISOString(),saleId=`sale-${fixture.key}`,requestId=`payment-${fixture.key}`;
    const paid=await tenderReservedOrder(fixture,{orderId:order.id,saleId,requestId,serverOccurredAt:instant});
    assert.equal(paid.duplicate,false);assert.equal(paid.inventory.mode,'reserved_order');
    const replay=await tenderReservedOrder(fixture,{orderId:order.id,saleId,requestId,serverOccurredAt:instant});
    assert.equal(replay.duplicate,true);
    const sourceReplay=await transaction(client=>consumeRecipeStock(client,{companyId:fixture.companyId,
      actorId:fixture.actorId,saleId,serverOccurredAt:instant,capturedAt:instant,reservationOrderId:order.id,
      items:[{productId:fixture.productId,variantId:'',qty:2}]}));
    assert.equal(sourceReplay.duplicate,true);
    const facts=(await pool.query(`SELECT
      (SELECT on_hand FROM myfin.stock_items WHERE company_id=$1 AND id=$2) AS on_hand,
      (SELECT state FROM myfin.customer_order_recipe_reservations WHERE company_id=$1 AND order_id=$3) AS state,
      (SELECT count(*)::int FROM myfin.customer_order_payments WHERE company_id=$1 AND order_id=$3) AS payments,
      (SELECT count(*)::int FROM myfin.stock_ledger WHERE company_id=$1 AND source_id=$4) AS movements,
      (SELECT source_details FROM myfin.stock_ledger WHERE company_id=$1 AND source_id=$4) AS details`,
    [fixture.companyId,fixture.stockItemId,order.id,saleId])).rows[0];
    assert.equal(Number(facts.on_hand),16);assert.equal(facts.state,'consumed');
    assert.equal(facts.payments,1);assert.equal(facts.movements,1);
    assert.equal(facts.details.recipes[0].recipeVersion,1);
  });

  await test('forced tender failure rolls inventory and reservation state back together',async()=>{
    const fixture=await transaction(client=>seedFixture(client,`rollback-${randomUUID().slice(0,8)}`,{onHand:12}));
    const order=await transaction(client=>createOrder(client,fixture));
    await acceptOrder(fixture,order.id);
    const instant=new Date().toISOString(),saleId=`sale-${fixture.key}`;
    await assert.rejects(tenderReservedOrder(fixture,{orderId:order.id,saleId,
      requestId:`payment-${fixture.key}`,serverOccurredAt:instant,failAfterInventory:true}),/forced_after_inventory/);
    const facts=(await pool.query(`SELECT
      (SELECT on_hand FROM myfin.stock_items WHERE company_id=$1 AND id=$2) AS on_hand,
      (SELECT state FROM myfin.customer_order_recipe_reservations WHERE company_id=$1 AND order_id=$3) AS state,
      (SELECT count(*)::int FROM myfin.transactions WHERE company_id=$1 AND id=$4) AS sales,
      (SELECT count(*)::int FROM myfin.inventory_source_effects WHERE company_id=$1 AND source_id=$4) AS effects`,
    [fixture.companyId,fixture.stockItemId,order.id,saleId])).rows[0];
    assert.equal(Number(facts.on_hand),12);assert.equal(facts.state,'active');
    assert.equal(facts.sales,0);assert.equal(facts.effects,0);
  });

  await test('cancellation and scheduled expiry release active recipe holds',async()=>{
    const fixture=await transaction(client=>seedFixture(client,`release-${randomUUID().slice(0,8)}`,{onHand:30}));
    const [cancelled,expiring]=await transaction(async client=>[
      await createOrder(client,fixture,{expiresInMs:60000}),
      await createOrder(client,fixture,{expiresInMs:60000}),
    ]);
    await acceptOrder(fixture,cancelled.id);await acceptOrder(fixture,expiring.id);
    await transaction(async client=>{
      await client.query(`UPDATE myfin.customer_order_requests SET status='cancelled',version=version+1,updated_at=now()
        WHERE company_id=$1 AND id=$2`,[fixture.companyId,cancelled.id]);
      await releaseOrderReservations(client,fixture.companyId,cancelled.id,'cancelled');
    });
    await transaction(client=>expireStaleCustomerOrders(client,{now:new Date(Date.now()+120000),limit:100}));
    const rows=(await pool.query(`SELECT order_id,state,release_reason FROM myfin.customer_order_recipe_reservations
      WHERE company_id=$1 AND order_id=ANY($2::text[]) ORDER BY order_id`,
    [fixture.companyId,[cancelled.id,expiring.id]])).rows;
    assert.equal(rows.find(row=>row.order_id===cancelled.id).state,'released');
    assert.equal(rows.find(row=>row.order_id===cancelled.id).release_reason,'cancelled');
    assert.equal(rows.find(row=>row.order_id===expiring.id).state,'released');
    assert.equal(rows.find(row=>row.order_id===expiring.id).release_reason,'expired');
    assert.equal((await pool.query(`SELECT status FROM myfin.customer_order_requests
      WHERE company_id=$1 AND id=$2`,[fixture.companyId,expiring.id])).rows[0].status,'expired');
  });

  await test('client captured dates cannot replace the current online recipe',async()=>{
    const now=Date.now(),capturedAt=new Date(now-90*60000).toISOString();
    const fixture=await transaction(client=>seedFixture(client,`clock-${randomUUID().slice(0,8)}`,{
      onHand:100,quantityPerUnit:1,versionCreatedAt:new Date(now-2*3600000)}));
    await transaction(client=>publishRecipeVersion(client,fixture,{version:2,quantityPerUnit:3,
      createdAt:new Date(now-3600000)}));
    const serverOccurredAt=new Date(now).toISOString(),onlineSale=`online-${fixture.key}`;
    const online=await transaction(async client=>{
      await insertSale(client,fixture,onlineSale,serverOccurredAt);
      return consumeRecipeStock(client,{companyId:fixture.companyId,actorId:fixture.actorId,saleId:onlineSale,
        serverOccurredAt,capturedAt,offline:false,items:[{productId:fixture.productId,variantId:'',qty:2}]});
    });
    assert.equal(online.mode,'current_recipe');
    assert.equal(Number((await pool.query(`SELECT input_quantity FROM myfin.stock_ledger
      WHERE company_id=$1 AND source_id=$2`,[fixture.companyId,onlineSale])).rows[0].input_quantity),6);
    const unresolvedSale=`unresolved-${fixture.key}`;
    await assert.rejects(transaction(async client=>{
      await insertSale(client,fixture,unresolvedSale,serverOccurredAt);
      return consumeRecipeStock(client,{companyId:fixture.companyId,actorId:fixture.actorId,saleId:unresolvedSale,
        serverOccurredAt,capturedAt,offline:true,items:[{productId:fixture.productId,variantId:'',qty:2}]});
    }),error=>error?.statusCode===409&&error?.message==='receipt_review_required_recipe_timing');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM myfin.transactions WHERE company_id=$1 AND id=$2',
      [fixture.companyId,unresolvedSale])).rows[0].count,0);
    const capturedSale=`captured-${fixture.key}`;
    const resolved=await transaction(async client=>{
      await insertSale(client,fixture,capturedSale,serverOccurredAt);
      return consumeRecipeStock(client,{companyId:fixture.companyId,actorId:fixture.actorId,saleId:capturedSale,
        serverOccurredAt,capturedAt,offline:true,inventoryRecipeResolution:'captured_recipe',
        items:[{productId:fixture.productId,variantId:'',qty:2}]});
    });
    assert.equal(resolved.mode,'captured_recipe');
    assert.equal(Number((await pool.query(`SELECT input_quantity FROM myfin.stock_ledger
      WHERE company_id=$1 AND source_id=$2`,[fixture.companyId,capturedSale])).rows[0].input_quantity),2);
  });

  await test('database stock floor blocks every decrement path below a live hold',async()=>{
    const fixture=await transaction(client=>seedFixture(client,`floor-${randomUUID().slice(0,8)}`,{
      onHand:10,quantityPerUnit:4,trackingMode:'count'}));
    const order=await transaction(client=>createOrder(client,fixture));await acceptOrder(fixture,order.id);
    await pool.query('UPDATE myfin.inventory_recipes SET enabled=false WHERE company_id=$1 AND id=$2',
      [fixture.companyId,fixture.recipeId]);
    const rejected=(sql,message)=>assert.rejects(
      transaction(client=>client.query(sql,[fixture.companyId,fixture.stockItemId])),
      error=>error?.code==='23514'&&error?.message===message);
    // Archive, manual count, waste, and procurement reversal all converge on
    // stock_items; the database floor must reject each mutation before its
    // corresponding append-only evidence can be written.
    await rejected('UPDATE myfin.stock_items SET active=false WHERE company_id=$1 AND id=$2',
      'stock_item_has_active_recipe_reservations');
    await rejected('UPDATE myfin.stock_items SET on_hand=7 WHERE company_id=$1 AND id=$2',
      'stock_below_active_recipe_reservations');
    await rejected('UPDATE myfin.stock_items SET on_hand=on_hand-3 WHERE company_id=$1 AND id=$2',
      'stock_below_active_recipe_reservations');
    await rejected('UPDATE myfin.stock_items SET on_hand=0,version=version+1 WHERE company_id=$1 AND id=$2',
      'stock_below_active_recipe_reservations');
    const stock=(await pool.query('SELECT on_hand,active FROM myfin.stock_items WHERE company_id=$1 AND id=$2',
      [fixture.companyId,fixture.stockItemId])).rows[0];
    assert.equal(Number(stock.on_hand),10);assert.equal(stock.active,true);
    await pool.query('UPDATE myfin.stock_items SET on_hand=8 WHERE company_id=$1 AND id=$2',
      [fixture.companyId,fixture.stockItemId]);
  });

  await test('count ingredient preflight rejects fractional lines before their whole aggregate can reserve',async()=>{
    const fixture=await transaction(client=>seedFixture(client,`count-${randomUUID().slice(0,8)}`,{
      onHand:10,quantityPerUnit:0.5,trackingMode:'count'}));
    const productTwo=`product-two-${fixture.key}`,recipeTwo=`recipe-two-${fixture.key}`;
    await transaction(async client=>{
      await client.query(`INSERT INTO myfin.products(company_id,id,data,stock,price,cost)
        VALUES($1,$2,$3,0,10,2)`,[fixture.companyId,productTwo,
        {id:productTwo,name:'Second counted recipe',stock:0,trackStock:false,variants:[],category:'Food'}]);
      await client.query(`INSERT INTO myfin.inventory_recipes(company_id,id,product_id,enabled,version,updated_by)
        VALUES($1,$2,$3,true,1,$4)`,[fixture.companyId,recipeTwo,productTwo,fixture.actorId]);
      await client.query(`INSERT INTO myfin.inventory_recipe_versions(
        company_id,recipe_id,version,enabled,catalog_stock_disabled,request_digest,created_by,created_at)
        VALUES($1,$2,1,true,true,$3,$4,now()-interval '1 hour')`,
      [fixture.companyId,recipeTwo,digest(`${fixture.key}:second`),fixture.actorId]);
      await client.query(`INSERT INTO myfin.inventory_recipe_components(
        company_id,recipe_id,recipe_version,stock_item_id,position,quantity_per_unit)
        VALUES($1,$2,1,$3,0,0.5)`,[fixture.companyId,recipeTwo,fixture.stockItemId]);
    });
    await assert.rejects(transaction(client=>assertRecipeAvailability(client,{companyId:fixture.companyId,
      items:[{productId:fixture.productId,qty:1},{productId:productTwo,qty:1}],lock:'update'})),
    error=>error?.statusCode===409&&error?.message==='recipe_count_requires_whole_units');
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM myfin.customer_order_recipe_reservations
      WHERE company_id=$1`,[fixture.companyId])).rows[0].count,0);
  });

  await test('a recipe boundary discovered during another pending review retains both causes and resolution',async()=>{
    const fixture=await transaction(client=>seedFixture(client,`review-${randomUUID().slice(0,8)}`));
    const saleId=`review-sale-${fixture.key}`;
    const missingOfflineId=`missing-offline-${fixture.key}`;
    await assert.rejects(pool.query(`INSERT INTO myfin.receipt_reviews(
      company_id,id,actor_id,payload,request_digest,reason_code,status,approved_by,approval_reason,approved_at,
      inventory_recipe_resolution) VALUES($1,$2,$3,'{}',$4,'receipt_review_required_pricing_policy',
      'approved',$3,'Invalid captured recipe claim',now(),'captured_recipe')`,
    [fixture.companyId,missingOfflineId,fixture.actorId,digest(`${missingOfflineId}:review`)]),
    error=>error?.code==='23514');
    await pool.query(`INSERT INTO myfin.receipt_reviews(
      company_id,id,actor_id,payload,request_digest,reason_code)
      VALUES($1,$2,$3,'{"offline":true}',$4,'receipt_review_required_recipe_stock')`,
    [fixture.companyId,saleId,fixture.actorId,digest(`${saleId}:review`)]);
    await pool.query(`UPDATE myfin.receipt_reviews SET status='approved',approved_by=$3,
      approval_reason='Stock reconciled; current recipe selected',approved_at=now(),
      inventory_recipe_resolution='current_recipe' WHERE company_id=$1 AND id=$2`,
    [fixture.companyId,saleId,fixture.actorId]);
    const row=(await pool.query(`SELECT status,reason_code,inventory_recipe_resolution
      FROM myfin.receipt_reviews WHERE company_id=$1 AND id=$2`,[fixture.companyId,saleId])).rows[0];
    assert.deepEqual(row,{status:'approved',reason_code:'receipt_review_required_recipe_stock',
      inventory_recipe_resolution:'current_recipe'});
    const onlineId=`online-review-${fixture.key}`;
    await pool.query(`INSERT INTO myfin.receipt_reviews(
      company_id,id,actor_id,payload,request_digest,reason_code)
      VALUES($1,$2,$3,'{"offline":false}',$4,'receipt_review_required_pricing_policy')`,
    [fixture.companyId,onlineId,fixture.actorId,digest(`${onlineId}:review`)]);
    await assert.rejects(pool.query(`UPDATE myfin.receipt_reviews SET status='approved',approved_by=$3,
      approval_reason='Invalid captured recipe claim',approved_at=now(),
      inventory_recipe_resolution='captured_recipe' WHERE company_id=$1 AND id=$2`,
    [fixture.companyId,onlineId,fixture.actorId]),error=>error?.code==='23514');
    assert.deepEqual((await pool.query(`SELECT status,inventory_recipe_resolution
      FROM myfin.receipt_reviews WHERE company_id=$1 AND id=$2`,[fixture.companyId,onlineId])).rows[0],
    {status:'pending',inventory_recipe_resolution:null});
  });
}finally{
  if(pool)await pool.end().catch(()=>{});
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(()=>{});
  await admin.end();
}
