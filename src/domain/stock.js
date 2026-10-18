export const STOCK_MODES = Object.freeze([
  { value:'count', label:'Counted items', examples:'cups, pastries, pumps, shots and portions', units:['pcs','cup','slice','pump','shot','portion','bottle','box','pack','tray'] },
  { value:'weight', label:'Measured by weight', examples:'coffee beans, sugar, flour', units:['g','kg'] },
  { value:'volume', label:'Measured by volume', examples:'milk, syrup, oil', units:['ml','L'] },
]);

const clean=value=>String(value??'').trim();
const amount=value=>Math.round(Number(value)*1e6)/1e6;
export const stockMode = value => STOCK_MODES.find(mode=>mode.value===value);
export const defaultStockUnit = mode => stockMode(mode)?.units[0] || 'pcs';

export function stockTypeOptions(items=[]) {
  const types=new Map();
  for(const item of items){
    const value=clean(item?.category);
    if(value&&!types.has(value.toLocaleLowerCase()))types.set(value.toLocaleLowerCase(),value);
  }
  return [...types.values()].sort((a,b)=>a.localeCompare(b));
}

export function normalizeStockItem(input={}) {
  const mode=stockMode(input.trackingMode)?.value||'count';
  return {
    ...(input.id?{id:input.id}:{}),
    ...(input.company_id?{company_id:input.company_id}:{}),
    ...(input.version?{version:Number(input.version)}:{}),
    ...(input.unitVersion?{unitVersion:Number(input.unitVersion)}:{}),
    ...(clean(input.internalCode)?{internalCode:clean(input.internalCode)}:{}),
    name:clean(input.name),category:clean(input.category)||'General',trackingMode:mode,
    baseUnit:clean(input.baseUnit)||defaultStockUnit(mode),barcode:clean(input.barcode),
    onHand:amount(input.onHand||0),reorderLevel:amount(input.reorderLevel||0),
    preferredSupplierId:clean(input.preferredSupplierId),active:input.active!==false,notes:clean(input.notes),
    packagings:(input.packagings||[]).map(item=>({
      ...(item.id?{id:item.id}:{}),label:clean(item.label),barcode:clean(item.barcode),quantityInBase:amount(item.quantityInBase),
    })),
    ...(input.unitCorrection?{unitCorrection:{strategy:input.unitCorrection.strategy==='convert'?'convert':'relabel',
      conversionFactor:Number(input.unitCorrection.conversionFactor),reason:clean(input.unitCorrection.reason)}}:{}),
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
  if(item.unitCorrection&&(!Number.isFinite(item.unitCorrection.conversionFactor)||item.unitCorrection.conversionFactor<=0||item.unitCorrection.conversionFactor>1e9||
    item.unitCorrection.reason.length<8||item.unitCorrection.reason.length>1000))throw new Error('Explain the unit correction and enter a valid conversion factor.');
  if(item.unitCorrection?.strategy==='relabel'&&item.unitCorrection.conversionFactor!==1)throw new Error('A label-only correction must keep the quantity unchanged.');
  const unitFactor=item.unitCorrection?.strategy==='convert'?item.unitCorrection.conversionFactor:1;
  if(item.trackingMode==='count'&&(!Number.isInteger(amount(item.onHand*unitFactor))||!Number.isInteger(amount(item.reorderLevel*unitFactor))||item.packagings.some(pack=>!Number.isInteger(amount(pack.quantityInBase*unitFactor)))))
    throw new Error('Counted stock and its package conversions must use whole base units.');
  const used=new Set(existing.filter(other=>other.id!==item.id).flatMap(other=>[other.internalCode,other.barcode,...(other.packagings||[]).map(pack=>pack.barcode)]).filter(Boolean).map(code=>String(code).toLocaleUpperCase()));
  if(codes.some(code=>used.has(code)))throw new Error('A barcode is already assigned to another stock item.');
  return item;
}

export function stockUnitCorrectionPreview(item={},correction={}){
  const strategy=correction.strategy==='convert'?'convert':'relabel',factor=strategy==='convert'?Number(correction.conversionFactor):1;
  if(!Number.isFinite(factor)||factor<=0||factor>1e9)return null;
  const convert=value=>amount(Number(value||0)*factor);
  return {strategy,factor,onHand:convert(item.onHand),reorderLevel:convert(item.reorderLevel),
    packagings:(item.packagings||[]).map(pack=>({...pack,quantityInBase:convert(pack.quantityInBase)}))};
}

export function findStockCode(items, code) {
  const target=clean(code).toLocaleUpperCase();
  if(!target)return null;
  for(const item of items){
    if(item.active===false)continue;
    if(clean(item.internalCode).toLocaleUpperCase()===target)return {item,packaging:null,quantity:1};
    if(clean(item.barcode).toLocaleUpperCase()===target)return {item,packaging:null,quantity:1};
    const packaging=(item.packagings||[]).find(pack=>clean(pack.barcode).toLocaleUpperCase()===target);
    if(packaging)return {item,packaging,quantity:Number(packaging.quantityInBase)};
  }
  return null;
}

export function stockConversionText(packaging,baseUnit){
  const label=clean(packaging?.label),unit=clean(baseUnit)||'unit',value=amount(packaging?.quantityInBase);
  if(!label||!Number.isFinite(value)||value<=0)return '';
  return `${label} = ${value.toLocaleString(undefined,{maximumFractionDigits:6})} ${unit}`;
}

// A duplicate keeps operating settings but never copies balances, immutable
// server-issued codes or physical scan codes.
export function duplicateStockItem(input={}){
  const item=normalizeStockItem(input);
  return {
    name:`${item.name} copy`,category:item.category,trackingMode:item.trackingMode,baseUnit:item.baseUnit,
    barcode:'',onHand:0,reorderLevel:item.reorderLevel,preferredSupplierId:item.preferredSupplierId,
    active:true,notes:item.notes,packagings:item.packagings.map(pack=>({label:pack.label,barcode:'',quantityInBase:pack.quantityInBase})),
  };
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
