const clean=value=>String(value??'').trim();
const quantity=value=>Math.round(Number(value)*1e6)/1e6;

export const recipeTargetKey=(productId,variantId='')=>`${clean(productId)}\u0000${clean(variantId)}`;

export function normalizeRecipeDraft(input={}){
  const draft={
    productId:clean(input.productId),variantId:clean(input.variantId),
    version:Number(input.version||0),enabled:input.enabled===true,
    components:(input.components||[]).map(component=>({
      stockItemId:clean(component.stockItemId),quantityPerUnit:quantity(component.quantityPerUnit),
    })),
  };
  if(!draft.productId)throw new Error('Choose a sellable product or variant.');
  if(!Number.isInteger(draft.version)||draft.version<0)throw new Error('Recipe version is invalid.');
  if(draft.components.length>50)throw new Error('A recipe can use at most 50 stock items.');
  const ids=new Set();
  for(const component of draft.components){
    if(!component.stockItemId||ids.has(component.stockItemId))throw new Error('Choose each stock item once.');
    if(!Number.isFinite(component.quantityPerUnit)||component.quantityPerUnit<=0||component.quantityPerUnit>1e12)
      throw new Error('Each component needs a quantity greater than zero.');
    ids.add(component.stockItemId);
  }
  if(draft.enabled&&!draft.components.length)throw new Error('Add at least one stock item before enabling this recipe.');
  return draft;
}

export function recipeAvailability(components=[],stockItems=[]){
  if(!components.length)return {units:0,limitingStockItemId:'',complete:false};
  const items=new Map(stockItems.map(item=>[item.id,item]));
  let units=Number.MAX_SAFE_INTEGER,limitingStockItemId='',complete=true;
  for(const component of components){
    const item=items.get(component.stockItemId),per=Number(component.quantityPerUnit);
    if(!item||item.active===false||!Number.isFinite(per)||per<=0){complete=false;units=0;limitingStockItemId=component.stockItemId;break;}
    const available=Math.max(0,Math.floor((Number(item.onHand||0)+1e-9)/per));
    if(available<units){units=available;limitingStockItemId=item.id;}
  }
  return {units:units===Number.MAX_SAFE_INTEGER?0:units,limitingStockItemId,complete};
}

// An exact variant recipe overrides its product-level fallback. Components are
// aggregated before database locks so one source sale writes one movement per
// stock item even when several lines consume the same ingredient.
export function aggregateRecipeConsumption(saleItems=[],recipes=[]){
  const enabled=new Map(recipes.filter(recipe=>recipe.enabled).map(recipe=>[
    recipeTargetKey(recipe.productId,recipe.variantId),recipe,
  ]));
  const stock=new Map();let matchedLines=0;
  for(let index=0;index<saleItems.length;index++){
    const line=saleItems[index]||{},productId=clean(line.productId),variantId=clean(line.variantId),units=Number(line.qty??line.quantity);
    if(!productId||!Number.isFinite(units)||units<=0)throw new Error('Sale recipe quantities must be greater than zero.');
    const recipe=enabled.get(recipeTargetKey(productId,variantId))
      ||(variantId?enabled.get(recipeTargetKey(productId,'')):null);
    if(!recipe)continue;
    matchedLines++;
    for(const component of recipe.components||[]){
      const per=Number(component.quantityPerUnit),consumed=quantity(units*per);
      if(!component.stockItemId||!Number.isFinite(per)||per<=0||!Number.isFinite(consumed)||consumed<=0)
        throw new Error('Recipe component quantity is invalid.');
      const current=stock.get(component.stockItemId)||{stockItemId:component.stockItemId,quantity:0,contributions:[]};
      current.quantity=quantity(current.quantity+consumed);
      current.contributions.push({line:index+1,recipeId:recipe.id,recipeVersion:Number(recipe.version),
        productId,variantId,recipeVariantId:clean(recipe.variantId),units:quantity(units),
        quantityPerUnit:quantity(per),quantity:consumed});
      stock.set(component.stockItemId,current);
    }
  }
  return {matchedLines,consumptions:[...stock.values()].sort((a,b)=>a.stockItemId.localeCompare(b.stockItemId))};
}
