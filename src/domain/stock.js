export const STOCK_MODES = Object.freeze([
  { value:'count', label:'Counted items', examples:'cups, pastries, cake slices', units:['pcs','cup','slice','box','pack'] },
  { value:'weight', label:'Measured by weight', examples:'coffee beans, sugar, flour', units:['g','kg'] },
  { value:'volume', label:'Measured by volume', examples:'milk, syrup, oil', units:['ml','L'] },
]);

const clean=value=>String(value??'').trim();
const amount=value=>Math.round(Number(value)*1e6)/1e6;
export const stockMode = value => STOCK_MODES.find(mode=>mode.value===value);
export const defaultStockUnit = mode => stockMode(mode)?.units[0] || 'pcs';

export function normalizeStockItem(input={}) {
  const mode=stockMode(input.trackingMode)?.value||'count';
  return {
    ...(input.id?{id:input.id}:{}),
    ...(input.company_id?{company_id:input.company_id}:{}),
    ...(input.version?{version:Number(input.version)}:{}),
    name:clean(input.name),category:clean(input.category)||'General',trackingMode:mode,
    baseUnit:clean(input.baseUnit)||defaultStockUnit(mode),barcode:clean(input.barcode),
    onHand:amount(input.onHand||0),reorderLevel:amount(input.reorderLevel||0),
    preferredSupplierId:clean(input.preferredSupplierId),active:input.active!==false,notes:clean(input.notes),
    packagings:(input.packagings||[]).map(item=>({
      ...(item.id?{id:item.id}:{}),label:clean(item.label),barcode:clean(item.barcode),quantityInBase:amount(item.quantityInBase),
    })),
  };
}

export function validateStockItem(input, existing=[]) {
  const item=normalizeStockItem(input);
  if(!item.name)throw new Error('Stock item name is required.');
  if(!stockMode(item.trackingMode))throw new Error('Choose count, weight or volume tracking.');
  if(!item.baseUnit||item.baseUnit.length>32)throw new Error('Choose a short base unit.');
  if(![item.onHand,item.reorderLevel].every(value=>Number.isFinite(value)&&value>=0))throw new Error('Stock quantities must be zero or more.');
  const codes=[item.barcode,...item.packagings.map(pack=>pack.barcode)].filter(Boolean).map(code=>code.toLocaleUpperCase());
  if(codes.some(code=>code.length>128)||new Set(codes).size!==codes.length)throw new Error('Barcodes must be unique and use at most 128 characters.');
  const labels=new Set();
  for(const pack of item.packagings){
    const label=pack.label.toLocaleLowerCase();
    if(!label||labels.has(label)||!Number.isFinite(pack.quantityInBase)||pack.quantityInBase<=0)throw new Error('Each packaging needs a unique label and a quantity greater than zero.');
    labels.add(label);
  }
  const used=new Set(existing.filter(other=>other.id!==item.id).flatMap(other=>[other.barcode,...(other.packagings||[]).map(pack=>pack.barcode)]).filter(Boolean).map(code=>String(code).toLocaleUpperCase()));
  if(codes.some(code=>used.has(code)))throw new Error('A barcode is already assigned to another stock item.');
  return item;
}

export function findStockCode(items, code) {
  const target=clean(code).toLocaleUpperCase();
  if(!target)return null;
  for(const item of items){
    if(item.active===false)continue;
    if(clean(item.barcode).toLocaleUpperCase()===target)return {item,packaging:null,quantity:1};
    const packaging=(item.packagings||[]).find(pack=>clean(pack.barcode).toLocaleUpperCase()===target);
    if(packaging)return {item,packaging,quantity:Number(packaging.quantityInBase)};
  }
  return null;
}

export function stockMovement(input, current) {
  const kind=input.kind,quantity=amount(input.quantity),onHand=amount(current);
  if(!['receive','count','adjust','consume','waste'].includes(kind)||!Number.isFinite(quantity))throw new Error('Choose a stock action and enter a valid quantity.');
  let delta;
  if(kind==='count'){if(quantity<0)throw new Error('A physical count cannot be negative.');delta=amount(quantity-onHand);}
  else if(kind==='adjust'){if(!quantity)throw new Error('An adjustment cannot be zero.');delta=quantity;}
  else {if(quantity<=0)throw new Error('Enter a quantity greater than zero.');delta=['consume','waste'].includes(kind)?-quantity:quantity;}
  const after=amount(onHand+delta);
  if(after<0)throw new Error('This movement would make stock negative.');
  return {kind,inputQuantity:quantity,delta,quantityAfter:after};
}
