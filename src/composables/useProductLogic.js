const code=value=>String(value||'').trim().toLocaleUpperCase();
const prefix=value=>code(value).replace(/[^A-Z0-9]/g,'').slice(0,3)||'ITM';
const allCodes=products=>new Set(products.flatMap(product=>[product.sku,product.code,product.barcode,
  ...(product.variants||[]).flatMap(variant=>[variant.sku,variant.barcode])]).filter(Boolean).map(code));

export function generateUniqueSKU(category,existingCodes=[],uuid=()=>crypto.randomUUID()){
  const used=new Set([...existingCodes].filter(Boolean).map(code));
  for(let attempt=0;attempt<100;attempt++){
    const suffix=code(uuid()).replace(/[^A-Z0-9]/g,'').slice(0,8);
    const candidate=`${prefix(category)}-${suffix}`;
    if(suffix&&!used.has(candidate))return candidate;
  }
  throw new Error('Could not generate a unique SKU. Try again.');
}

function variantSKU(base,name,index,used){
  const stem=`${base}-${code(name).replace(/[^A-Z0-9]/g,'').slice(0,12)||`OPTION${index+1}`}`;
  let candidate=stem,suffix=1;
  while(used.has(candidate))candidate=`${stem}-${++suffix}`;
  used.add(candidate);return candidate.slice(0,64);
}

export function duplicateProductDraft(product,existingProducts=[],uuid=()=>crypto.randomUUID()){
  const used=allCodes(existingProducts),sku=generateUniqueSKU(product.category,used,uuid);used.add(sku);
  const copy=structuredClone(product);
  for(const key of ['id','company_id','version','recipeTracked','availableQuantity','recipeVersion'])delete copy[key];
  return {...copy,name:`${product.name} copy`,sku,barcode:'',stock:0,
    variants:(product.variants||[]).map((variant,index)=>({
      ...variant,id:uuid(),sku:variantSKU(sku,variant.name,index,used),barcode:'',stock:0,
    }))};
}

export function useProductLogic(existingProducts=[]) {
    const generateSKU=category=>generateUniqueSKU(category,allCodes(typeof existingProducts==='function'?existingProducts():existingProducts));
    return { generateSKU };
}
