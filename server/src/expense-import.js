import { randomUUID,createHash } from 'node:crypto';
import { z } from 'zod';
import * as v from './validation.js';
import { requireCapability } from './access.js';
import { canonical } from '../../src/domain/pos.js';
import { prepareExpense,recordExpenseEvent,replaceExpenseLinks } from './expense-lifecycle.js';
import { recordExpensePayment } from './petty-cash.js';

const realDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;

const expenseRow=z.strictObject({
  date:z.string().refine(realDate),
  description:z.string().trim().min(1).max(500),
  category:z.string().trim().max(120).default('General'),
  amount:z.number().finite().positive().max(1e9),
  supplier_id:z.union([v.id,z.literal('')]).optional(),
  payee:z.string().trim().max(500).optional(),
  status:z.enum(['draft','pending','pending_payment','paid']).default('paid'),
  paidByType:z.enum(['unassigned','app_user','non_user','petty_cash','other','credit']).default('other'),
  paidByUserId:z.union([v.id,z.literal('')]).default(''),
  paidByName:z.string().trim().max(500).default(''),
  pettyCashFundId:z.union([v.id,z.literal('')]).default(''),
  creditTermsDays:z.union([z.number().int().min(1).max(3650),z.null()]).optional(),
  creditDueDate:z.string().max(10).default(''),
  paidOn:z.string().max(10).default(''),
  links:z.array(z.strictObject({type:z.enum(['stock_item','stock_movement','purchase_order','goods_receipt']),id:v.id})).max(100).default([]),
});

async function suppliers(c,companyId,ids){
  if(!ids.length)return new Map();
  const result=await c.query("SELECT id,data FROM myfin.clients WHERE company_id=$1 AND id=ANY($2::text[]) FOR KEY SHARE",[companyId,ids]);
  if(result.rowCount!==ids.length||result.rows.some(row=>row.data.type!=='Supplier'))v.fail(409,'supplier_not_found');
  return new Map(result.rows.map(row=>[row.id,row.data]));
}

export function registerExpenseImport(app,{scoped,audit}){
  app.post('/api/companies/:company/import-expenses',req=>scoped(req,async(c,companyId)=>{
    requireCapability(req.identity,'expensesWrite');
    const {batchId,rows}=v.parse(z.strictObject({batchId:v.id.refine(value=>value.length>=8),rows:z.array(expenseRow).min(1).max(500)}),req.body);
    const digest=createHash('sha256').update(JSON.stringify(canonical(rows))).digest('hex');
    const inserted=await c.query(`INSERT INTO myfin.expense_import_batches(company_id,batch_id,request_digest,imported_count,created_by)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING batch_id`,[companyId,batchId,digest,rows.length,req.identity.id]);
    if(!inserted.rowCount){
      const old=(await c.query('SELECT request_digest,imported_count FROM myfin.expense_import_batches WHERE company_id=$1 AND batch_id=$2',[companyId,batchId])).rows[0];
      if(!old||old.request_digest!==digest)v.fail(409,'expense_import_payload_changed');
      return {count:old.imported_count,alreadyImported:true};
    }
    const ids=[...new Set(rows.map(row=>row.supplier_id).filter(Boolean))];
    const supplierMap=await suppliers(c,companyId,ids);
    for(const [index,row] of rows.entries()){
      const id=randomUUID(),supplierId=row.supplier_id||null,supplier=supplierMap.get(supplierId);
      const input={...row,id,company_id:companyId,supplier_id:supplierId||'',payee:row.payee||supplier?.name||'',
        paidByName:row.paidByName||(row.paidByType==='other'?'Imported / unspecified':''),
        paidOn:row.paidOn||(row.status==='paid'?row.date:'')};
      const prepared=await prepareExpense(c,companyId,req.identity,input),amount=prepared.amountSen/100;
      const data={...prepared.data,id,company_id:companyId,amount};
      const initialStatus=prepared.status==='paid'?'pending_payment':prepared.status;
      const initialData={...data,status:initialStatus,paidOn:'',paidAmountSen:0,outstandingAmountSen:prepared.amountSen};
      await c.query(`INSERT INTO myfin.expenses(company_id,id,data,amount,amount_sen,created_by,supplier_id,status,
        paid_by_type,paid_by_identity_id,paid_by_name,petty_cash_fund_id,credit_terms_days,credit_due_date,paid_on)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[companyId,id,initialData,amount,prepared.amountSen,
        req.identity.id,supplierId,initialStatus,prepared.paidByType,prepared.paidByUserId||null,
        prepared.paidByName||null,prepared.pettyCashFundId||null,prepared.creditTermsDays,prepared.creditDueDate||null,null]);
      await replaceExpenseLinks(c,companyId,id,prepared.links,req.identity);
      let saved=(await c.query('SELECT * FROM myfin.expenses WHERE company_id=$1 AND id=$2',[companyId,id])).rows[0];
      await recordExpenseEvent(c,companyId,req.identity,{expenseId:id,expenseVersion:Number(saved.version),
        action:'imported',to:saved,reason:`Imported in batch ${batchId}`});
      if(prepared.status==='paid'){
        await recordExpensePayment(c,req.identity,companyId,id,{amount,sourceType:prepared.paidByType,
          pettyCashFundId:prepared.pettyCashFundId||'',paidByUserId:prepared.paidByUserId||'',
          paidByName:prepared.paidByName||'',paidOn:prepared.paidOn,reference:'',
          reason:`Imported payment in batch ${batchId}`,
          idempotencyKey:`import-${createHash('sha256').update(`${batchId}\u0000${index}`).digest('hex')}`,
          expectedVersion:Number(saved.version)},async()=>{},{requireWrite:false});
      }
    }
    await audit(c,req.identity,companyId,'Import expenses',String(rows.length));
    return {count:rows.length,alreadyImported:false};
  }));
}
