import { csvCell, parseCsv } from './inventoryCsv.js';
import { businessDate } from './pos.js';
import { normalizeExpenseLifecycle } from './expenseLifecycle.js';

export const EXPENSE_COLUMNS = ['date','description','category','amount','status','paid_by_type','paid_by_user_id',
  'paid_by_name','credit_terms_days','credit_due_date','paid_on','supplier_id','supplier_name','payee','stock_item_ids',
  'stock_movement_ids','purchase_order_ids','goods_receipt_ids'];
const clean = value => String(value ?? '').trim();
const supplierType = value => ['supplier'].includes(clean(value).toLowerCase());
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const linkColumns = Object.freeze({stock_item_ids:'stock_item',stock_movement_ids:'stock_movement',purchase_order_ids:'purchase_order',goods_receipt_ids:'goods_receipt'});
const ids = (value, line, field) => clean(value) ? clean(value).split(';').map(clean).filter(Boolean).map(id => {
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new Error(`Row ${line}: ${field} contains an invalid ID.`);
  return id;
}) : [];

function supplierFor(row, suppliers, line) {
  const byId = clean(row.supplier_id);
  const byName = clean(row.supplier_name);
  if (!byId && !byName) return null;
  const available = suppliers.filter(item => supplierType(item.type));
  const idMatch = byId ? available.find(item => item.id === byId) : null;
  const nameMatches = byName ? available.filter(item => clean(item.name).toLocaleLowerCase() === byName.toLocaleLowerCase()) : [];
  if (byId && !idMatch) throw new Error(`Row ${line}: supplier_id does not match an available supplier.`);
  if (!byId && nameMatches.length !== 1) throw new Error(`Row ${line}: supplier_name must match exactly one supplier.`);
  const match = idMatch || nameMatches[0];
  if (byName && clean(match.name).toLocaleLowerCase() !== byName.toLocaleLowerCase()) throw new Error(`Row ${line}: supplier_id and supplier_name refer to different suppliers.`);
  return match;
}

export function importExpensesCsv(text, suppliers = []) {
  const [header, ...rows] = parseCsv(text);
  if (!header || !rows.length) throw new Error('The CSV needs a header and at least one expense row.');
  const columns = header.map(value => clean(value).toLowerCase());
  if (new Set(columns).size !== columns.length) throw new Error('Duplicate column headings.');
  for (const required of ['date','description','amount']) if (!columns.includes(required)) throw new Error(`Missing required column: ${required}. Download the expense template.`);
  if (columns.some(column => !EXPENSE_COLUMNS.includes(column))) throw new Error('Unknown expense column. Download the latest template.');
  if (rows.length > 500) throw new Error('Upload at most 500 expenses at a time.');
  return rows.map((cells,index) => {
    const line=index+2;
    if(cells.length!==columns.length)throw new Error(`Row ${line}: column count does not match the header.`);
    const row=Object.fromEntries(columns.map((column,i)=>[column,clean(cells[i])]));
    if(!validDate(row.date))throw new Error(`Row ${line}: date must be a real YYYY-MM-DD date.`);
    if(!row.description||row.description.length>500)throw new Error(`Row ${line}: description is required and must use at most 500 characters.`);
    if(!/^\d+(?:\.\d{1,2})?$/.test(row.amount)||Number(row.amount)<=0)throw new Error(`Row ${line}: amount must be greater than zero with at most two decimal places.`);
    if(row.category?.length>120)throw new Error(`Row ${line}: category is too long.`);
    for(const field of ['payee','supplier_name'])if(row[field]?.length>500)throw new Error(`Row ${line}: ${field} is too long.`);
    const supplier=supplierFor(row,suppliers,line);
    const links=Object.entries(linkColumns).flatMap(([column,type])=>ids(row[column],line,column).map(id=>({type,id})));
    let lifecycle;
    const status=row.status||'paid',paidByType=row.paid_by_type||'other';
    try{lifecycle=normalizeExpenseLifecycle({date:row.date,status,paidByType,
      paidByUserId:row.paid_by_user_id||'',paidByName:row.paid_by_name||(paidByType==='other'?'Imported / unspecified':''),
      creditTermsDays:row.credit_terms_days===''||row.credit_terms_days==null?null:Number(row.credit_terms_days),
      creditDueDate:row.credit_due_date||'',paidOn:row.paid_on||(status==='paid'?row.date:''),links});}
    catch(error){throw new Error(`Row ${line}: ${error.message}`);}
    return {
      date:row.date,
      description:row.description,
      category:row.category||'General',
      amount:Number(row.amount),
      supplier_id:supplier?.id||'',
      payee:row.payee||supplier?.name||'',
      ...lifecycle,
    };
  });
}

export function exportExpensesCsv(expenses = [], suppliers = []) {
  const names=new Map(suppliers.map(supplier=>[supplier.id,supplier.name]));
  const linked=(expense,type)=>(expense.links||[]).filter(link=>link.type===type).map(link=>link.id).join(';');
  const rows=[EXPENSE_COLUMNS,...expenses.map(expense=>[
    businessDate(expense.date),expense.description,expense.category||'General',Number(expense.amount||0).toFixed(2),
    expense.status||'paid',expense.paidByType||'other',expense.paidByUserId||'',expense.paidByName||'',
    expense.creditTermsDays??'',expense.creditDueDate||'',expense.paidOn||(expense.status!=='pending'?businessDate(expense.date):''),
    expense.supplier_id||'',names.get(expense.supplier_id)||'',expense.payee||'',
    linked(expense,'stock_item'),linked(expense,'stock_movement'),linked(expense,'purchase_order'),linked(expense,'goods_receipt'),
  ])];
  return '\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
}

export const expenseTemplateCsv = (today = new Date().toISOString().slice(0,10)) => exportExpensesCsv([
  {date:today,description:'Example supplies purchase',category:'Inventory',amount:125.50,status:'paid',paidByType:'other',paidByName:'Business account',payee:'Example supplier'},
]);
