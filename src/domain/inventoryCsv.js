// CSV is deliberately create-only: importing a file must never reset live stock.
export const CSV_COLUMNS = ['sku','name','category','unit','track_stock','price','cost','stock','variant_name','variant_sku','barcode','image_url','description'];
export const validEmail = value => !value || (value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
export const validImageUrl = value => !value || (/^https:\/\/[^\s]+$/i.test(value) || /^\/api\/files\/[A-Za-z0-9_-]+$/.test(value));
export function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i+1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += c; }
    else if (c === ',' || c === '\n' || c === '\r') {
      row.push(cell); cell = ''; closed = false;
      if (c !== ',') { if (row.some(v => v.trim())) rows.push(row); row = []; if (c === '\r' && text[i+1] === '\n') i++; }
    } else if (c === '"' && !cell && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error('Invalid CSV quoting. Export as CSV UTF-8 and try again.'); cell += c; }
  }
  if (quoted) throw new Error('An opening quote has no closing quote.');
  row.push(cell); if (row.some(v => v.trim())) rows.push(row);
  return rows;
}
const key = value => String(value || '').trim().toUpperCase();
export function validateProduct(product, existing = []) {
  if (!product.name?.trim() || !product.sku?.trim()) throw new Error('Product name and SKU are required.');
  if (product.name.length > 120 || product.sku.length > 64) throw new Error('Use up to 120 characters for names and 64 for SKUs.');
  if (!validImageUrl(product.imageUrl)) throw new Error('Image URL must start with https://.');
  const variants = product.hasVariants ? product.variants : [];
  if (product.hasVariants && !variants?.length) throw new Error('Add at least one variant.');
  const rows = variants.length ? variants : [product];
  if (rows.some(r => ['price','cost','stock'].some(k => !Number.isFinite(Number(r[k] ?? 0)) || Number(r[k] ?? 0) < 0))) throw new Error('Prices, costs and stock must be zero or more.');
  const names = new Set();
  for (const v of variants) { if (!v.name?.trim() || names.has(key(v.name))) throw new Error('Each variant needs a unique name.'); names.add(key(v.name)); }
  const codes = [product.sku, product.barcode, ...variants.flatMap(v => [v.sku, v.barcode])].filter(Boolean);
  for (const code of codes) if (!/^[\x20-\x7E]{1,64}$/.test(code) || /^[=+@]/.test(code)) throw new Error('SKUs/barcodes need 1–64 printable characters and cannot begin with =, + or @.');
  const used = new Map();
  for (const [index, row] of [product, ...variants].entries()) for (const code of [row.sku, row.barcode].filter(Boolean)) {
    const k = key(code); if (used.has(k) && used.get(k) !== index) throw new Error('Product and variant codes must be unique.'); used.set(k,index);
  }
  for (const other of existing.filter(p => p.id !== product.id || !p.id)) {
    for (const code of [other.sku, other.code, other.barcode, ...(other.variants || []).flatMap(v => [v.sku,v.barcode])]) if (code && used.has(key(code))) throw new Error(`SKU/barcode ${code} already belongs to ${other.name}.`);
  }
  return product;
}
export function importProductsCsv(text, existing = [], {includeCosts=true} = {}) {
  const [header, ...rows] = parseCsv(text);
  if (!header || !rows.length) throw new Error('The CSV needs a header and at least one product row.');
  const columns = header.map(c => c.trim().toLowerCase());
  if (!includeCosts && columns.includes('cost')) throw new Error('Use the cost-free inventory template for this account.');
  if (new Set(columns).size !== columns.length) throw new Error('Duplicate column headings.');
  for (const c of ['sku','name','price']) if (!columns.includes(c)) throw new Error(`Missing required column: ${c}. Download the template.`);
  if (columns.some(c => !CSV_COLUMNS.includes(c))) throw new Error('Unknown column. Use the headings in the SKU template.');
  if (rows.length > 1000) throw new Error('Upload at most 1,000 rows at a time.');
  const groups = new Map();
  for (const [index, cells] of rows.entries()) {
    const line = index + 2;
    if (cells.length !== columns.length) throw new Error(`Row ${line}: column count does not match the header.`);
    const r = Object.fromEntries(columns.map((c,i) => [c,cells[i].trim()]));
    if (!r.sku || !r.name) throw new Error(`Row ${line}: name and SKU are required.`);
    if (r.track_stock && !['true','false'].includes(r.track_stock.toLowerCase())) throw new Error(`Row ${line}: track_stock must be true or false.`);
    for (const field of ['price','cost','stock']) if ((field === 'price' && !r[field]) || (r[field] && !/^\d+(\.\d+)?$/.test(r[field]))) throw new Error(`Row ${line}: ${field} must be a non-negative number without currency symbols.`);
    const base = { sku:r.sku,name:r.name,category:r.category||'Other',unit:r.unit||'pcs',trackStock:r.category !== 'Service' && r.track_stock?.toLowerCase() !== 'false',description:r.description||'',imageUrl:r.image_url||'' };
    const value = {price:Number(r.price),...(includeCosts?{cost:Number(r.cost||0)}:{}),stock:base.trackStock?Number(r.stock||0):0,barcode:r.barcode||''};
    let p = groups.get(key(r.sku));
    if (p && (!r.variant_name || !p.hasVariants)) throw new Error(`Row ${line}: duplicate SKU. Repeat a product SKU only for its variants.`);
    if (p && Object.keys(base).some(k => base[k] !== p[k])) throw new Error(`Row ${line}: product details must match for every variant of ${r.sku}.`);
    if (!p) { p = {...base,...value,hasVariants:!!r.variant_name,variants:[]}; if (p.hasVariants) { p.barcode='';p.stock=0;p.price=0;if(includeCosts)p.cost=0; } groups.set(key(r.sku),p); }
    if (r.variant_name) p.variants.push({...value,id:crypto.randomUUID(),name:r.variant_name,sku:r.variant_sku||''});
    else if (r.variant_sku) throw new Error(`Row ${line}: variant_sku needs a variant_name.`);
  }
  if (groups.size > 300) throw new Error('Upload at most 300 products at a time.');
  const products = [];
  for (const p of groups.values()) { validateProduct(p,[...existing,...products]); products.push(p); }
  return products;
}
// Neutralize spreadsheet formula execution in text fields, including exported names.
export const csvCell = value => '"' + String(value ?? '').replace(/^[\t\r\n ]*[=+@-]/, m => "'"+m).replaceAll('"','""') + '"';
export function exportProductsCsv(products, {includeCosts=true} = {}) {
  const rows = products.flatMap(p => (p.variants?.length ? p.variants : [p]).map(v => [p.sku,p.name,p.category,p.unit,p.trackStock,v.price,v.cost,v.stock,p.variants?.length?v.name:'',p.variants?.length?v.sku:'',v.barcode,p.imageUrl,p.description]));
  const selected=[CSV_COLUMNS,...rows].map(row=>includeCosts?row:row.filter((_,i)=>i!==6));
  return '\uFEFF'+selected.map(row => row.map(csvCell).join(',')).join('\r\n');
}
export const templateCsv = (options = {}) => exportProductsCsv([
  {sku:'RET-EXAMPLE',name:'Example product',category:'Retail',unit:'pcs',trackStock:true,price:10,cost:4,stock:20},
  {sku:'BEV-EXAMPLE',name:'Example latte',category:'Beverage',unit:'cup',trackStock:true,variants:[{name:'Iced',sku:'BEV-EXAMPLE-ICED',price:9,cost:3,stock:50},{name:'Hot',sku:'BEV-EXAMPLE-HOT',price:8,cost:3,stock:50}]}
], options);
