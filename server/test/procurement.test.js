import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createPurchaseOrder, orderStatusAfterReceiptReversal, registerProcurement } from '../src/procurement.js';

const input={number:'PO-100',supplierId:'supplier',currencyCode:'MYR',expectedDate:'2026-10-20',notes:'Weekly order',
  idempotencyKey:'po-request-100',lines:[
    {id:'line-b',stockItemId:'milk',supplierItemReference:'MILK-C',description:'Milk carton',purchaseUnit:'carton',orderedQuantity:2.5,quantityInBase:1000,unitPriceSen:850},
    {id:'line-a',stockItemId:'cups',supplierItemReference:'CUP-C',description:'Cup carton',purchaseUnit:'carton',orderedQuantity:2,quantityInBase:50,unitPriceSen:1200},
  ]};

class PurchaseDatabase {
  constructor(){this.order=null;this.lines=[];this.calls=[];this.orderInserts=0;}
  async query(sql,args=[]){
    this.calls.push({sql,args});
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
    if(sql.includes('SELECT id,request_digest FROM myfin.purchase_orders'))return {rows:this.order?[{id:this.order.id,request_digest:this.order.request_digest}]:[],rowCount:this.order?1:0};
    if(sql.includes('FROM myfin.clients')&&sql.includes('FOR KEY SHARE'))return {rows:[{id:'supplier',data:{type:'Supplier',name:'Supplier'}}],rowCount:1};
    if(sql.includes('FROM myfin.stock_items')&&sql.includes('FOR KEY SHARE'))return {rows:[...args[1]].map(id=>({id,active:true})),rowCount:args[1].length};
    if(sql.startsWith('INSERT INTO myfin.purchase_orders')){
      this.orderInserts++;this.order={id:args[1],request_digest:args[9],number:args[2],supplier_id:args[3],status:'draft',
        currency_code:args[4],total_sen:args[5],expected_date:args[6],notes:args[7],version:1,created_at:'2026-10-09T00:00:00Z',submitted_at:null,cancelled_at:null};
      return {rows:[],rowCount:1};
    }
    if(sql.startsWith('INSERT INTO myfin.purchase_order_lines')){
      this.lines.push({id:args[2],position:args[3],stock_item_id:args[4],supplier_item_reference:args[5],description:args[6],
        purchase_unit:args[7],ordered_purchase_quantity:args[8],quantity_in_base:args[9],unit_price_sen:args[10],
        line_total_sen:args[11],stock_item_name:args[4],base_unit:args[4]==='milk'?'ml':'pcs'});return {rows:[],rowCount:1};
    }
    if(sql.startsWith('INSERT INTO myfin.purchase_order_events'))return {rows:[],rowCount:1};
    if(sql.includes("cl.data->>'name' AS supplier_name"))return {rows:[{...this.order,supplier_name:'Supplier'}],rowCount:1};
    if(sql.includes('FROM myfin.purchase_order_lines pol'))return {rows:[...this.lines].sort((a,b)=>a.position-b.position),rowCount:this.lines.length};
    if(sql.includes('FROM myfin.goods_receipt_lines gl'))return {rows:[],rowCount:0};
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

test('owner purchase-order creation is tenant-idempotent and locks referenced stock in stable order',async()=>{
  const db=new PurchaseDatabase(),who={id:'owner',role:'workspace_owner'},audits=[];
  const first=await createPurchaseOrder(db,who,'company',input,async(...args)=>audits.push(args));
  assert.equal(first.duplicate,false);
  assert.equal(first.order.totalSen,'4525');
  assert.deepEqual(first.order.lines.map(line=>line.lineTotalSen),['2125','2400']);
  const stockLock=db.calls.find(call=>call.sql.includes('FROM myfin.stock_items')&&call.sql.includes('FOR KEY SHARE'));
  assert.deepEqual(stockLock.args[1],['cups','milk']);
  const replay=await createPurchaseOrder(db,who,'company',input);
  assert.equal(replay.duplicate,true);
  assert.equal(db.orderInserts,1);
  await assert.rejects(()=>createPurchaseOrder(db,who,'company',{...input,notes:'changed'}),
    error=>error.statusCode===409&&error.message==='purchase_order_payload_changed');
  assert.equal(audits.length,1);
});

test('purchase costs are owner-only while the receiving queue omits them for inventory staff',async()=>{
  const routes=new Map();
  const app={get:(path,handler)=>routes.set(`GET ${path}`,handler),post:(path,handler)=>routes.set(`POST ${path}`,handler)};
  const rows={order:{id:'po',number:'PO-1',supplier_id:'supplier',supplier_name:'Supplier',status:'submitted',currency_code:'MYR',
    total_sen:'1000',expected_date:null,notes:'',version:2,created_at:'now',submitted_at:'now',cancelled_at:null},
  line:{id:'line',stock_item_id:'milk',stock_item_name:'Milk',base_unit:'ml',supplier_item_reference:'M',description:'Milk',
    purchase_unit:'carton',ordered_purchase_quantity:'1',quantity_in_base:'1000',unit_price_sen:'1000',line_total_sen:'1000'}};
  const client={async query(sql){
    if(sql.includes("status IN ('submitted','partially_received')"))return {rows:[{id:'po'}],rowCount:1};
    if(sql.includes("cl.data->>'name'"))return {rows:[rows.order],rowCount:1};
    if(sql.includes('FROM myfin.purchase_order_lines pol'))return {rows:[rows.line],rowCount:1};
    if(sql.includes('FROM myfin.goods_receipt_lines gl'))return {rows:[],rowCount:0};
    throw Error(`Unexpected SQL: ${sql}`);
  }};
  registerProcurement(app,{scoped:(req,fn)=>fn(client,'company'),audit:async()=>{}});
  const result=await routes.get('GET /api/companies/:company/receiving-queue')({identity:{id:'operator',role:'operator'}});
  assert.equal(result.rows[0].lines[0].orderedQuantity,1);
  assert.doesNotMatch(JSON.stringify(result),/unitPrice|lineTotal|totalSen|cost|valuation/i);
  await assert.rejects(()=>routes.get('POST /api/companies/:company/purchase-orders')({
    identity:{id:'manager',role:'manager'},body:input,
  }),error=>error.statusCode===403&&error.message==='access_denied');
});

test('receipt reversal preserves a deliberately cancelled purchase order',()=>{
  assert.equal(orderStatusAfterReceiptReversal('cancelled','submitted'),'cancelled');
  assert.equal(orderStatusAfterReceiptReversal('cancelled','partially_received'),'cancelled');
  assert.equal(orderStatusAfterReceiptReversal('received','partially_received'),'partially_received');
});

test('procurement migration enforces immutable evidence, stable tenant uniqueness and no automatic supplier order',async()=>{
  const sql=await readFile(new URL('../../db/migrations/0023_procurement.sql',import.meta.url),'utf8');
  for(const table of ['stock_identifiers','purchase_orders','purchase_order_lines','purchase_order_events','goods_receipts',
    'goods_receipt_lines','goods_receipt_reversals','stock_batches','inventory_weighted_costs','inventory_valuation_events',
    'low_stock_alerts','low_stock_alert_events'])assert.match(sql,new RegExp(`CREATE TABLE myfin\\.${table}`));
  assert.match(sql,/UNIQUE\(company_id,idempotency_key\)/g);
  assert.match(sql,/stock_identifiers_active_value_key[\s\S]*\(company_id,normalized_value\) WHERE active/);
  assert.match(sql,/submitted_purchase_order_line_immutable/);
  assert.match(sql,/submitted_purchase_order_snapshot_immutable/);
  assert.match(sql,/gl\.purchase_order_line_id=line\.id/);
  assert.match(sql,/received_within/);
  assert.match(sql,/CREATE FUNCTION myfin\.enforce_scan_code_uniqueness/);
  assert.match(sql,/pg_advisory_xact_lock\(hashtextextended\(NEW\.company_id\|\|':scan-code:'/);
  assert.equal((sql.match(/EXECUTE FUNCTION myfin\.enforce_scan_code_uniqueness/g)||[]).length,6);
  assert.match(sql,/REVOKE ALL ON FUNCTION myfin\.enforce_goods_receipt_line\(\) FROM PUBLIC/);
  assert.match(sql,/stock_ledger_procurement_effect_key/);
  assert.match(sql,/low_stock_alerts_active_item_key[\s\S]*status IN \('open','acknowledged'\)/);
  assert.equal((sql.match(/EXECUTE FUNCTION myfin\.protect_procurement_evidence/g)||[]).length,17);
  assert.match(sql,/There is intentionally no in-place draft edit/);
  assert.match(sql,/Remaining-batch balances and FEFO consumption are not implemented/);
  assert.doesNotMatch(sql,/https?:\/\/|supplier_order_job/i);
  const source=await readFile(new URL('../src/procurement.js',import.meta.url),'utf8');
  assert.match(source,/ORDER BY id FOR UPDATE/);
  assert.match(source,/ORDER BY stock_item_id FOR UPDATE/);
  assert.match(source,/receipt_stock_already_consumed/);
});
