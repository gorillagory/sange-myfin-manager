import { randomUUID,createHash } from 'node:crypto';
import { z } from 'zod';
import * as v from './validation.js';
import { requireCapability } from './access.js';
import { cents,canonical } from '../../src/domain/pos.js';

const realDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;

const expenseRow=z.strictObject({
  date:z.string().refine(realDate),
  description:z.string().trim().min(1).max(500),
  category:z.string().trim().max(120).default('General'),
  amount:z.number().finite().positive().max(1e9),
  supplier_id:z.union([v.id,z.literal('')]).optional(),
  payee:z.string().trim().max(500).optional(),
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
    for(const row of rows){
      const amount=cents(row.amount)/100;
      if(amount<=0||amount!==row.amount)v.fail(400,'invalid_expense_amount');
      const id=randomUUID(),supplierId=row.supplier_id||null,supplier=supplierMap.get(supplierId);
      const data={...row,id,company_id:companyId,amount,supplier_id:supplierId||'',payee:row.payee||supplier?.name||''};
      await c.query('INSERT INTO myfin.expenses(company_id,id,data,amount,created_by,supplier_id) VALUES($1,$2,$3,$4,$5,$6)',[companyId,id,data,amount,req.identity.id,supplierId]);
    }
    await audit(c,req.identity,companyId,'Import expenses',String(rows.length));
    return {count:rows.length,alreadyImported:false};
  }));
}
