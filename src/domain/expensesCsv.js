import { csvCell, parseCsv } from './inventoryCsv.js';
import { businessDate } from './pos.js';

export const EXPENSE_COLUMNS = ['date','description','category','amount','supplier_id','supplier_name','payee'];
const clean = value => String(value ?? '').trim();
const supplierType = value => ['supplier'].includes(clean(value).toLowerCase());
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;

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
    return {
      date:row.date,
      description:row.description,
      category:row.category||'General',
      amount:Number(row.amount),
      supplier_id:supplier?.id||'',
      payee:row.payee||supplier?.name||'',
    };
  });
}

export function exportExpensesCsv(expenses = [], suppliers = []) {
  const names=new Map(suppliers.map(supplier=>[supplier.id,supplier.name]));
  const rows=[EXPENSE_COLUMNS,...expenses.map(expense=>[
    businessDate(expense.date),expense.description,expense.category||'General',Number(expense.amount||0).toFixed(2),expense.supplier_id||'',names.get(expense.supplier_id)||'',expense.payee||'',
  ])];
  return '\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
}

export const expenseTemplateCsv = (today = new Date().toISOString().slice(0,10)) => exportExpensesCsv([
  {date:today,description:'Example supplies purchase',category:'Inventory',amount:125.50,payee:'Example supplier'},
]);
