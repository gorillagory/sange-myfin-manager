<script setup>
import {computed,nextTick,onBeforeUnmount,ref} from 'vue';
import {Store} from '../../store';
import {STOCK_MODES,defaultStockUnit,duplicateStockItem,findStockCode,normalizeStockItem,stockConversionText,stockMovement} from '../../domain/stock.js';
import {normalizeRecipeDraft,recipeAvailability,validateRecipeStockUnits} from '../../domain/inventoryRecipes.js';
import {EXPENSE_STATUS_LABELS,effectiveExpenseStatus} from '../../domain/expenseLifecycle.js';
import {api,companyPath} from '../../services/api.js';
import Icon from '../ui/EditionIcon.vue';
import Modal from '../ui/EditionModal.vue';
import StockCodeResourcesModal from './StockCodeResourcesModal.vue';

const tab=ref('items'),search=ref(''),form=ref(null),movement=ref(null),resourceItem=ref(null),busy=ref(false),error=ref(''),scanCode=ref(''),camera=ref(false),video=ref(null);
const cameraTarget=ref({kind:'lookup',index:-1});
const recipes=ref([]),recipeSelection=ref(''),recipeForm=ref(null),recipeLoading=ref(false),recipeError=ref('');
let scanControls=null,scanRequest=0;
const suppliers=computed(()=>Store.state.clients.filter(client=>client.type==='Supplier'));
const expenses=computed(()=>Store.state.expenses.filter(item=>!item.voided_at));
const items=computed(()=>Store.state.stock_items.filter(item=>[item.name,item.category,item.internalCode,item.barcode,item.baseUnit,...(item.packagings||[]).flatMap(pack=>[pack.label,pack.barcode])].join(' ').toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())).sort((a,b)=>Number(b.active)-Number(a.active)||a.category.localeCompare(b.category)||a.name.localeCompare(b.name)));
const itemMap=computed(()=>new Map(Store.state.stock_items.map(item=>[item.id,item])));
const history=computed(()=>[...Store.state.stock_ledger].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))));
const mode=computed(()=>STOCK_MODES.find(value=>value.value===form.value?.trackingMode));
const selectedPack=computed(()=>movement.value?.packagingId?movement.value.item.packagings.find(pack=>pack.id===movement.value.packagingId):null);
const preview=computed(()=>{if(!movement.value)return null;try{return stockMovement({kind:movement.value.kind,quantity:Number(movement.value.quantity||0)*Number(selectedPack.value?.quantityInBase||1)},movement.value.item.onHand);}catch{return null;}});
const recipeTargets=computed(()=>Store.state.products.flatMap(product=>[
  {value:`${product.id}::`,productId:product.id,variantId:'',product,variant:null,label:`${product.name}${product.variants?.length?' — default for variants':''}`},
  ...(product.variants||[]).map(variant=>({value:`${product.id}::${variant.id}`,productId:product.id,variantId:variant.id,product,variant,label:`${product.name} — ${variant.name}`})),
]));
const currentRecipeTarget=computed(()=>recipeTargets.value.find(target=>target.value===recipeSelection.value));
const recipeProduct=computed(()=>Store.state.products.find(product=>product.id===recipeForm.value?.productId));
const recipePreview=computed(()=>recipeForm.value?recipeAvailability(recipeForm.value.components,Store.state.stock_items):null);
const fmt=value=>Number(value||0).toLocaleString(undefined,{maximumFractionDigits:6});
const supplierName=id=>suppliers.value.find(item=>item.id===id)?.name||'—';
const expenseLabel=expense=>`${expense.date} · ${expense.description} · ${EXPENSE_STATUS_LABELS[effectiveExpenseStatus(expense)]}`;
const linkedExpenseStatus=entry=>entry.expenseEffectiveStatus==='voided'?'Voided':EXPENSE_STATUS_LABELS[entry.expenseEffectiveStatus||effectiveExpenseStatus({status:entry.expenseStatus,creditDueDate:entry.expenseDueDate})]||'Legacy';

function edit(item=null){form.value=normalizeStockItem(item||{trackingMode:'count',baseUnit:'pcs',active:true});error.value='';}
function duplicate(item){form.value=duplicateStockItem(item);error.value='';}
function changeMode(){if(form.value)form.value.baseUnit=defaultStockUnit(form.value.trackingMode);}
function addPackaging(preset=''){
  const common=preset==='litre'?{label:'1 L package',quantityInBase:1000}:preset==='kilogram'?{label:'1 kg package',quantityInBase:1000}:{label:'',quantityInBase:1};
  form.value.packagings.push({...common,barcode:''});
}
async function save(){if(busy.value)return;busy.value=true;error.value='';try{if(form.value.id)await Store.updateStockItem(form.value);else await Store.addStockItem(form.value);form.value=null;Store.notify('Stock item saved.');}catch(e){error.value=e.message;}finally{busy.value=false;}}
function openMovement(item,kind='receive',packaging=null){movement.value={item,kind,quantity:packaging?1:'',packagingId:packaging?.id||'',supplierId:item.preferredSupplierId||'',expenseId:'',reason:kind==='count'?'Physical stock count':'',idempotencyKey:crypto.randomUUID()};error.value='';}
async function submitMovement(){if(busy.value)return;busy.value=true;error.value='';try{const {item,...payload}=movement.value;payload.quantity=Number(payload.quantity);await Store.recordStockMovement(item.id,payload);movement.value=null;Store.notify('Stock movement recorded.');}catch(e){error.value=e.message;}finally{busy.value=false;}}
async function archive(item){if(busy.value)return;busy.value=true;try{await Store.archiveStockItem(item.id);Store.notify('Stock item archived.');}catch(e){Store.notify(e.message,'error');}finally{busy.value=false;}}
async function restore(item){if(busy.value)return;busy.value=true;try{await Store.updateStockItem({...item,active:true});Store.notify('Stock item restored.');}catch(e){Store.notify(e.message,'error');}finally{busy.value=false;}}
function useScan(code=scanCode.value){const match=findStockCode(Store.state.stock_items,code);if(!match){error.value='No stock item uses that barcode or QR code.';return;}scanCode.value='';error.value='';openMovement(match.item,'receive',match.packaging);}
async function loadRecipes(){
  if(!Store.can('inventoryWrite')||recipeLoading.value)return;
  recipeLoading.value=true;recipeError.value='';
  try{recipes.value=(await api(companyPath(Store,'/inventory-recipes'))).rows||[];}
  catch(e){recipeError.value=e.message;}
  finally{recipeLoading.value=false;}
}
async function openRecipes(){tab.value='recipes';await loadRecipes();}
function configureRecipe(value=recipeSelection.value){
  const target=recipeTargets.value.find(item=>item.value===value);if(!target)return;
  const saved=recipes.value.find(item=>item.productId===target.productId&&(item.variantId||'')===target.variantId);
  recipeForm.value=saved?{productId:saved.productId,variantId:saved.variantId||'',version:saved.version,enabled:saved.enabled,
    components:saved.components.map(component=>({stockItemId:component.stockItemId,quantityPerUnit:component.quantityPerUnit}))}
    :{productId:target.productId,variantId:target.variantId,version:0,enabled:false,components:[]};
  recipeError.value='';
}
function addRecipeComponent(){recipeForm.value?.components.push({stockItemId:'',quantityPerUnit:1});}
async function saveRecipe(){
  if(recipeLoading.value||!recipeForm.value)return;
  recipeLoading.value=true;recipeError.value='';
  try{
    const payload=validateRecipeStockUnits(normalizeRecipeDraft(recipeForm.value),Store.state.stock_items);
    const saved=await api(companyPath(Store,'/inventory-recipes'),{method:'PUT',body:payload});
    recipes.value=[...recipes.value.filter(row=>row.id!==saved.id),saved].sort((a,b)=>a.productName.localeCompare(b.productName)||a.variantName.localeCompare(b.variantName));
    recipeForm.value=null;Store.notify('Inventory recipe saved.');
  }catch(e){
    recipeError.value=({recipe_requires_catalog_stock_disabled:'Turn off catalog stock tracking for this product before enabling its recipe.',inventory_recipe_changed:'This recipe changed. Close it, reload recipes and try again.',stock_item_archived:'Choose active stock items only.',recipe_count_requires_whole_units:'Counted recipe components must use whole base units.'})[e.message]||e.message;
  }finally{recipeLoading.value=false;}
}
function acceptCameraCode(code,target){
  const value=String(code||'').trim();if(!value)return;
  if(target.kind==='item'){
    if(!form.value)return;
    form.value.barcode=value;error.value='';Store.notify('Item barcode captured. Save the item to keep it.');return;
  }
  if(target.kind==='packaging'){
    if(!form.value?.packagings[target.index])return;
    form.value.packagings[target.index].barcode=value;error.value='';Store.notify('Packaging barcode captured. Save the item to keep it.');return;
  }
  scanCode.value=value;useScan(value);
}
async function startCamera(kind='lookup',index=-1){
  if(camera.value)return;
  const request=++scanRequest;
  cameraTarget.value={kind,index};error.value='';camera.value=true;
  await nextTick();
  try{
    // Load 1D barcode and QR decoding only when a camera is opened.
    const {BrowserMultiFormatReader}=await import('@zxing/browser');
    if(!camera.value||request!==scanRequest)return;
    const reader=new BrowserMultiFormatReader();
    const controls=await reader.decodeFromConstraints({video:{facingMode:{ideal:'environment'}}},video.value,(result)=>{
      if(!result||!camera.value||request!==scanRequest)return;
      const code=result.getText?.();if(!code?.trim())return;
      const target={...cameraTarget.value};stopCamera();acceptCameraCode(code,target);
    });
    if(!camera.value||request!==scanRequest)controls.stop();else scanControls=controls;
  }catch{
    if(request!==scanRequest)return;
    stopCamera();error.value='Camera scanning is unavailable. Use a USB/Bluetooth scanner or enter the code manually.';
  }
}
function stopCamera(){
  scanRequest++;camera.value=false;scanControls?.stop();scanControls=null;
  for(const track of video.value?.srcObject?.getTracks?.()||[])track.stop();
  if(video.value)video.value.srcObject=null;
  cameraTarget.value={kind:'lookup',index:-1};
}
function closeActionMenu(event){event.currentTarget.closest('details')?.removeAttribute('open');}
onBeforeUnmount(stopCamera);
</script>

<template><div v-if="Store.can('inventoryRead')" class="ed-page mf-stock-page">
  <div class="mf-stock-viewbar">
    <div class="ed-tabs" aria-label="Stock record views"><button :class="{active:tab==='items'}" @click="tab='items'">Items</button><button v-if="Store.can('stockHistoryRead')" :class="{active:tab==='history'}" @click="tab='history'">Movement history</button><button v-if="Store.can('inventoryWrite')" :class="{active:tab==='recipes'}" @click="openRecipes">Recipes</button></div>
    <button v-if="Store.can('inventoryWrite')" class="ed-btn primary mf-stock-new" @click="edit()"><Icon name="plus"/>New stock item</button>
  </div>
  <template v-if="tab==='items'"><div class="ed-filters mf-stock-filters"><div class="ed-search"><Icon name="search"/><input v-model="search" class="ed-input" placeholder="Search stock, internal code, barcode or category" aria-label="Search stock records"></div><div class="ed-stock-scan"><input v-model="scanCode" class="ed-input" placeholder="Scan or enter internal code / barcode / QR" aria-label="Internal code, barcode or QR code" @keydown.enter="useScan()"><button class="ed-btn" @click="useScan()">Find</button><button class="ed-btn" @click="startCamera('lookup')"><Icon name="qr"/>Camera</button></div></div><p v-if="error&&!form&&!movement" class="ed-alert" role="alert">{{ error }}</p>
    <div class="ed-table-wrap mf-stock-table-wrap"><table class="ed-table mf-stock-table"><colgroup><col class="mf-stock-col-item"><col class="mf-stock-col-tracking"><col class="mf-stock-col-balance"><col class="mf-stock-col-reorder"><col class="mf-stock-col-supplier"><col class="mf-stock-col-actions"></colgroup><thead><tr><th>Stock item</th><th>Tracking</th><th>On hand</th><th>Reorder at</th><th>Supplier</th><th>Actions</th></tr></thead><tbody><tr v-for="item in items" :key="item.id" :class="{'ed-company-archived':!item.active}"><td data-label="Stock item"><strong>{{ item.name }}</strong><small><template v-if="item.internalCode">{{ item.internalCode }} · </template>{{ item.category }}<template v-if="item.barcode"> · {{ item.barcode }}</template><template v-if="!item.active"> · Archived</template></small><small class="mf-stock-supplier-inline">Supplier · {{ supplierName(item.preferredSupplierId) }}</small></td><td data-label="Tracking">{{ STOCK_MODES.find(mode=>mode.value===item.trackingMode)?.label }}<small v-for="pack in item.packagings" :key="pack.id">{{ stockConversionText(pack,item.baseUnit) }}</small></td><td data-label="On hand" :class="{'ed-low-stock':item.active&&item.onHand<=item.reorderLevel}"><strong>{{ fmt(item.onHand) }} {{ item.baseUnit }}</strong></td><td data-label="Reorder at">{{ fmt(item.reorderLevel) }} {{ item.baseUnit }}</td><td data-label="Supplier">{{ supplierName(item.preferredSupplierId) }}</td><td data-label="Actions"><div class="mf-stock-actions"><button v-if="item.active" class="ed-btn small mf-stock-row-action" @click="openMovement(item,'receive')">Receive</button><button v-if="item.active" class="ed-btn small mf-stock-row-action" @click="openMovement(item,'count')">Count</button><details v-if="item.internalCode||Store.can('inventoryWrite')" class="mf-stock-action-menu" name="stock-row-actions"><summary class="ed-btn small" :aria-label="`More actions for ${item.name}`" :title="`More actions for ${item.name}`"><span aria-hidden="true">•••</span></summary><div class="mf-stock-action-panel" :aria-label="`More actions for ${item.name}`"><button v-if="item.internalCode" type="button" @click="closeActionMenu($event);resourceItem=item"><Icon name="qr"/>Code &amp; labels</button><button v-if="Store.can('inventoryWrite')" type="button" @click="closeActionMenu($event);duplicate(item)"><Icon name="plus"/>Duplicate</button><button v-if="Store.can('inventoryWrite')" type="button" @click="closeActionMenu($event);edit(item)"><Icon name="edit"/>Edit</button><button v-if="Store.can('inventoryWrite')&&item.active" type="button" class="danger" @click="closeActionMenu($event);archive(item)"><Icon name="close"/>Archive</button><button v-if="Store.can('inventoryWrite')&&!item.active" type="button" @click="closeActionMenu($event);restore(item)"><Icon name="check"/>Restore</button></div></details><span v-if="!item.active&&!item.internalCode&&!Store.can('inventoryWrite')" class="ed-muted">—</span></div></td></tr></tbody></table></div><div v-if="!items.length" class="ed-empty"><Icon name="box"/><h3>No stock records found.</h3><p>Add cups, ingredients or bulk goods, then receive or count them.</p></div>
  </template>
  <template v-else-if="tab==='history'"><div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date</th><th>Item</th><th>Action</th><th>Change</th><th>Balance</th><th>Expense</th><th>Reason</th></tr></thead><tbody><tr v-for="entry in history" :key="entry.id"><td>{{ new Date(entry.createdAt).toLocaleString() }}</td><td>{{ itemMap.get(entry.itemId)?.name||entry.itemId }}</td><td>{{ entry.sourceType==='pos_sale'?'Sale recipe':entry.kind }}</td><td>{{ entry.delta>0?'+':'' }}{{ fmt(entry.delta) }} {{ itemMap.get(entry.itemId)?.baseUnit }}</td><td>{{ fmt(entry.quantityAfter) }} {{ itemMap.get(entry.itemId)?.baseUnit }}</td><td><template v-if="entry.expenseId"><strong>{{ entry.expenseDescription||entry.expenseId }}</strong><small>{{ linkedExpenseStatus(entry) }}<template v-if="entry.expenseStatus==='pending'&&entry.expenseDueDate"> · due {{ entry.expenseDueDate }}</template><template v-else-if="entry.expensePaidOn"> · paid {{ entry.expensePaidOn }}</template></small></template><span v-else class="ed-muted">—</span></td><td>{{ entry.reason }}</td></tr></tbody></table></div><div v-if="!history.length" class="ed-empty"><Icon name="clock"/><h3>No movements recorded.</h3></div></template>
  <template v-else-if="tab==='recipes'"><section class="ed-editor-section"><div class="ed-section-head"><div><h2>Product recipes</h2><p class="ed-muted">Map one sellable unit to the ingredients or packaging it consumes. Recipes are disabled until you explicitly enable them.</p></div><button class="ed-btn" :disabled="recipeLoading" @click="loadRecipes">Refresh</button></div><div class="ed-form-grid"><label class="ed-field wide"><span>Sellable product or variant</span><select v-model="recipeSelection"><option value="">Choose a target</option><option v-for="target in recipeTargets" :key="target.value" :value="target.value">{{ target.label }}</option></select></label><div class="ed-field"><span>&nbsp;</span><button class="ed-btn primary" :disabled="!currentRecipeTarget||recipeLoading" @click="configureRecipe()">Configure recipe</button></div></div><p v-if="recipeError&&!recipeForm" class="ed-alert" role="alert">{{ recipeError }}</p></section>
    <div v-if="recipeLoading&&!recipes.length" class="ed-empty"><Icon name="clock"/><h3>Loading recipes…</h3></div><div v-else-if="recipes.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Sellable item</th><th>Status</th><th>Components</th><th>Projected availability</th><th>Version</th><th>Actions</th></tr></thead><tbody><tr v-for="recipe in recipes" :key="recipe.id"><td><strong>{{ recipe.productName }}</strong><small>{{ recipe.variantName||'Default recipe' }}</small></td><td><span class="ed-pill" :class="{warning:!recipe.enabled}">{{ recipe.enabled?'Enabled':'Disabled' }}</span></td><td><span v-for="component in recipe.components" :key="component.stockItemId" class="ed-block"><strong>{{ component.stockItemName }}</strong> · {{ fmt(component.quantityPerUnit) }} {{ component.baseUnit }}</span><small v-if="!recipe.components.length">No components</small></td><td><strong>{{ recipe.availability.units }} sale units</strong><small v-if="recipe.availability.limitingStockItemId">Limited by {{ itemMap.get(recipe.availability.limitingStockItemId)?.name||recipe.availability.limitingStockItemId }}</small></td><td>v{{ recipe.version }}</td><td><button class="ed-btn small" @click="configureRecipe(`${recipe.productId}::${recipe.variantId||''}`)">Edit</button></td></tr></tbody></table></div><div v-else-if="!recipeLoading" class="ed-empty"><Icon name="box"/><h3>No product recipes configured.</h3><p>Choose a product above to prepare its first disabled recipe.</p></div>
  </template>

  <Modal v-if="form" :title="form.id?'Edit stock item':'New stock item'" :busy="busy" wide @close="form=null">
    <form id="stock-item-form" class="ed-form-grid" @submit.prevent="save">
      <div class="ed-notice wide"><div><strong>{{ form.id?form.internalCode:'Internal code assigned on save' }}</strong><small>The server assigns a company-unique stock code. It can be searched or scanned and stays with this item.</small></div></div>
      <label class="ed-field wide"><span>Name</span><input v-model="form.name" required maxlength="120"></label>
      <label class="ed-field"><span>Category</span><input v-model="form.category" maxlength="120" placeholder="Ingredients"></label>
      <label class="ed-field"><span>Tracking method</span><select v-model="form.trackingMode" @change="changeMode"><option v-for="choice in STOCK_MODES" :key="choice.value" :value="choice.value">{{ choice.label }}</option></select><small>{{ mode?.examples }}</small></label>
      <label class="ed-field"><span>Smallest working unit</span><select v-model="form.baseUnit"><option v-for="unit in mode?.units||[]" :key="unit">{{ unit }}</option><option v-if="form.baseUnit&&!(mode?.units||[]).includes(form.baseUnit)">{{ form.baseUnit }}</option></select><small>Recipes consume and balances store this unit.</small></label>
      <div class="ed-field"><span id="stock-item-barcode-label">Item barcode / QR</span><div class="ed-stock-code-control"><input v-model="form.barcode" maxlength="128" aria-labelledby="stock-item-barcode-label"><button type="button" class="ed-btn small" aria-label="Scan item barcode with camera" @click="startCamera('item')"><Icon name="qr"/>Scan</button></div></div>
      <label class="ed-field"><span>{{ form.id?'Current stock':'Opening stock' }}</span><input v-model.number="form.onHand" type="number" min="0" :step="form.trackingMode==='count'?1:0.000001" :disabled="!!form.id"><small v-if="form.id">Use Receive, Count or Adjust to preserve history.</small></label>
      <label class="ed-field"><span>Reorder level</span><input v-model.number="form.reorderLevel" type="number" min="0" :step="form.trackingMode==='count'?1:0.000001"></label>
      <label v-if="Store.can('suppliersRead')" class="ed-field"><span>Preferred supplier</span><select v-model="form.preferredSupplierId"><option value="">None</option><option v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id">{{ supplier.name }}</option></select></label>
      <label class="ed-field wide"><span>Notes</span><textarea v-model="form.notes" rows="3" maxlength="10000"></textarea></label>
      <fieldset class="ed-field wide ed-editor-section"><legend><strong>Purchase and scan conversions</strong></legend>
        <p class="ed-muted">Describe what one scanned package adds in the smallest unit. Example: “1 L milk carton = 1,000 ml” or “1 L syrup bottle = 50 pump”.</p>
        <div v-for="(pack,index) in form.packagings" :key="pack.id||index" class="ed-stock-package">
          <input v-model="pack.label" required placeholder="1 L bottle" aria-label="Package name">
          <div class="ed-stock-package-scan"><input v-model="pack.barcode" placeholder="Barcode / QR" aria-label="Packaging barcode"><button type="button" class="ed-btn small" :aria-label="'Scan packaging '+(index+1)+' barcode with camera'" @click="startCamera('packaging',index)"><Icon name="qr"/>Scan</button></div>
          <input v-model.number="pack.quantityInBase" required type="number" min="0.000001" :step="form.trackingMode==='count'?1:0.000001" :aria-label="`Base units in one ${pack.label||'package'}`"><span>{{ form.baseUnit }}</span>
          <button type="button" class="ed-icon-button" aria-label="Remove packaging" @click="form.packagings.splice(index,1)"><Icon name="close"/></button>
          <small class="ed-stock-conversion">{{ stockConversionText(pack,form.baseUnit)||'Enter the package name and conversion.' }}</small>
        </div>
        <div class="ed-actions"><button type="button" class="ed-btn small" @click="addPackaging()"><Icon name="plus"/>Add packaging</button><button v-if="form.baseUnit==='ml'" type="button" class="ed-btn small" @click="addPackaging('litre')">+ 1 L package</button><button v-if="form.baseUnit==='g'" type="button" class="ed-btn small" @click="addPackaging('kilogram')">+ 1 kg package</button></div>
      </fieldset>
    </form>
    <p v-if="error" class="ed-alert" role="alert">{{ error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="form=null">Cancel</button><button class="ed-btn primary" :disabled="busy" type="submit" form="stock-item-form">{{ busy?'Saving…':'Save item' }}</button></template>
  </Modal>
  <Modal v-if="movement" :title="`Update ${movement.item.name}`" :busy="busy" @close="movement=null"><form id="stock-movement-form" class="ed-form-grid" @submit.prevent="submitMovement"><label class="ed-field"><span>Action</span><select v-model="movement.kind"><option value="receive">Receive</option><option value="count">Physical count</option><option value="consume">Consume / use</option><option value="waste">Waste</option><option value="adjust">Adjustment (+ or −)</option></select></label><label v-if="movement.item.packagings.length" class="ed-field"><span>Unit</span><select v-model="movement.packagingId"><option value="">{{ movement.item.baseUnit }}</option><option v-for="pack in movement.item.packagings" :key="pack.id" :value="pack.id">{{ pack.label }} ({{ fmt(pack.quantityInBase) }} {{ movement.item.baseUnit }})</option></select></label><label class="ed-field"><span>{{ movement.kind==='count'?'Counted quantity':'Quantity' }}</span><input v-model="movement.quantity" type="number" :min="movement.kind==='adjust'?undefined:0" step="0.000001" required></label><label v-if="Store.can('suppliersRead')" class="ed-field"><span>Supplier · optional</span><select v-model="movement.supplierId"><option value="">None</option><option v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id">{{ supplier.name }}</option></select></label><label v-if="Store.can('expensesRead')" class="ed-field wide"><span>Linked expense · optional</span><select v-model="movement.expenseId"><option value="">None</option><option v-for="expense in expenses" :key="expense.id" :value="expense.id">{{ expenseLabel(expense) }}</option></select></label><label class="ed-field wide"><span>Reason</span><input v-model="movement.reason" minlength="3" maxlength="1000" required placeholder="Delivery, physical count, damaged stock…"></label></form><p v-if="preview" class="ed-notice">Balance after this entry: <strong>{{ fmt(preview.quantityAfter) }} {{ movement.item.baseUnit }}</strong> ({{ preview.delta>0?'+':'' }}{{ fmt(preview.delta) }})</p><p v-if="error" class="ed-alert" role="alert">{{ error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="movement=null">Cancel</button><button class="ed-btn primary" :disabled="busy||!preview||movement.reason.trim().length<3" type="submit" form="stock-movement-form">{{ busy?'Recording…':'Record movement' }}</button></template></Modal>
  <Modal v-if="recipeForm" title="Product recipe" :busy="recipeLoading" wide @close="recipeForm=null;recipeError=''">
    <form id="inventory-recipe-form" class="ed-form-grid" @submit.prevent="saveRecipe">
      <div class="ed-field wide"><span>Sellable item</span><strong>{{ recipeTargets.find(target=>target.productId===recipeForm.productId&&target.variantId===recipeForm.variantId)?.label }}</strong><small>Recipe version {{ recipeForm.version||'new' }}</small></div>
      <label class="ed-check wide"><input v-model="recipeForm.enabled" type="checkbox" :disabled="recipeProduct?.trackStock">Enable automatic stock consumption</label>
      <div v-if="recipeProduct?.trackStock" class="ed-notice warning wide"><Icon name="alert"/><div><strong>Catalog stock tracking is still on.</strong>Turn off “Track stock” for this product in Inventory before enabling the recipe. This prevents the same sale being deducted twice.</div></div>
      <fieldset class="ed-field wide ed-editor-section"><legend><strong>What one sold unit consumes</strong></legend><p class="ed-muted">Use each stock item’s smallest unit. A coffee may use 250 ml milk and 1 pump syrup; selling four consumes 1,000 ml and 4 pumps.</p>
        <div v-for="(component,index) in recipeForm.components" :key="index" class="ed-stock-package">
          <select v-model="component.stockItemId" required aria-label="Recipe stock item"><option value="">Choose stock item</option><option v-for="item in Store.state.stock_items.filter(row=>row.active)" :key="item.id" :value="item.id">{{ item.name }} · {{ fmt(item.onHand) }} {{ item.baseUnit }}</option></select>
          <input v-model.number="component.quantityPerUnit" required type="number" min="0.000001" max="1000000000000" :step="itemMap.get(component.stockItemId)?.trackingMode==='count'?1:0.000001" aria-label="Quantity consumed per sale"><span>{{ itemMap.get(component.stockItemId)?.baseUnit||'unit' }}</span>
          <button type="button" class="ed-icon-button" aria-label="Remove recipe component" @click="recipeForm.components.splice(index,1)"><Icon name="close"/></button>
          <small class="ed-stock-conversion">Each sale consumes {{ fmt(component.quantityPerUnit) }} {{ itemMap.get(component.stockItemId)?.baseUnit||'unit' }} of {{ itemMap.get(component.stockItemId)?.name||'this stock item' }}.</small>
        </div><button type="button" class="ed-btn small" @click="addRecipeComponent"><Icon name="plus"/>Add component</button>
      </fieldset>
      <div v-if="recipePreview" class="ed-notice wide"><div><strong>Projected availability: {{ recipePreview.units }} sale units</strong><span v-if="recipePreview.limitingStockItemId"> · limited by {{ itemMap.get(recipePreview.limitingStockItemId)?.name||recipePreview.limitingStockItemId }}</span><small>This preview uses current on-hand stock. It does not reserve stock.</small></div></div>
    </form><p v-if="recipeError" class="ed-alert" role="alert">{{ recipeError }}</p><template #actions><button class="ed-btn" :disabled="recipeLoading" @click="recipeForm=null;recipeError=''">Cancel</button><button class="ed-btn primary" :disabled="recipeLoading||recipeForm.enabled&&recipeProduct?.trackStock" type="submit" form="inventory-recipe-form">{{ recipeLoading?'Saving…':'Save recipe' }}</button></template>
  </Modal>
  <StockCodeResourcesModal v-if="resourceItem" :item="resourceItem" @close="resourceItem=null"/>
  <Modal v-if="camera" title="Scan barcode or QR" @close="stopCamera"><video ref="video" class="ed-stock-camera" playsinline muted></video><p v-if="cameraTarget.kind==='lookup'" class="ed-muted">Point the camera at an existing item code to open Receive.</p><p v-else class="ed-muted">Point the camera at the item or packaging code. The form will fill in; save the item to keep it.</p><template #actions><button class="ed-btn" @click="stopCamera">Cancel</button></template></Modal>
</div></template>

<style scoped>
.mf-stock-viewbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.mf-stock-viewbar .ed-tabs {
  min-width: 0;
}

.mf-stock-new {
  flex: 0 0 auto;
}

.mf-stock-filters {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) minmax(450px, .95fr);
  align-items: center;
}

.mf-stock-filters .ed-search,
.mf-stock-filters .ed-stock-scan {
  min-width: 0;
}

.mf-stock-filters .ed-stock-scan {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto auto;
  justify-content: stretch;
}

.mf-stock-filters .ed-stock-scan input {
  max-width: none;
}

.mf-stock-table-wrap {
  max-width: 100%;
  overflow: visible;
  overscroll-behavior-inline: contain;
}

.mf-stock-table {
  min-width: 940px;
  table-layout: fixed;
}

.mf-stock-col-item { width: 25%; }
.mf-stock-col-tracking { width: auto; }
.mf-stock-col-balance { width: 112px; }
.mf-stock-col-reorder { width: 112px; }
.mf-stock-col-supplier { width: 14%; }
.mf-stock-col-actions { width: 205px; }

.mf-stock-table :is(th, td) {
  vertical-align: middle;
}

.mf-stock-table :is(th, td):nth-child(1),
.mf-stock-table :is(th, td):nth-child(2),
.mf-stock-table :is(th, td):nth-child(5) {
  overflow-wrap: anywhere;
  white-space: normal;
}

.mf-stock-table :is(th, td):nth-child(3),
.mf-stock-table :is(th, td):nth-child(4) {
  white-space: nowrap;
}

.mf-stock-table :is(th, td):last-child {
  text-align: right;
}

.mf-stock-supplier-inline {
  display: none;
}

.mf-stock-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  white-space: nowrap;
}

.mf-stock-row-action {
  padding-inline: 9px;
}

.mf-stock-action-menu {
  position: relative;
  flex: 0 0 auto;
}

.mf-stock-action-menu > summary {
  width: 38px;
  padding-inline: 0;
  cursor: pointer;
  list-style: none;
  letter-spacing: 1px;
}

.mf-stock-action-menu > summary::-webkit-details-marker {
  display: none;
}

.mf-stock-action-menu > summary::marker {
  content: '';
}

.mf-stock-action-menu[open] > summary {
  border-color: var(--ed-accent);
  background: var(--ed-tint);
  color: var(--ed-accent);
}

.mf-stock-action-panel {
  position: absolute;
  z-index: 12;
  top: calc(100% + 6px);
  right: 0;
  width: 188px;
  padding: 6px;
  border: 1px solid var(--ed-line);
  border-radius: var(--ed-radius);
  background: var(--ed-paper);
  box-shadow: var(--ed-shadow-sm, 0 10px 28px #172c2624);
  text-align: left;
}

.mf-stock-action-panel button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 9px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ed-ink);
  font-size: 12px;
  font-weight: 580;
  text-align: left;
}

.mf-stock-action-panel button:hover,
.mf-stock-action-panel button:focus-visible {
  background: var(--ed-tint);
  color: var(--ed-accent);
}

.mf-stock-action-panel button.danger {
  color: var(--ed-danger);
}

.mf-stock-action-panel .ed-icon {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
}

@media (max-width: 1180px) {
  .mf-stock-filters {
    grid-template-columns: 1fr;
  }

  .mf-stock-table-wrap {
    overflow: auto;
  }

  .mf-stock-table {
    min-width: 710px;
  }

  .mf-stock-table :is(th, td):nth-child(5),
  .mf-stock-col-supplier {
    display: none;
  }

  .mf-stock-supplier-inline {
    display: block;
  }

  .mf-stock-col-item { width: 26%; }
  .mf-stock-col-balance,
  .mf-stock-col-reorder { width: 100px; }

  .mf-stock-actions {
    flex-wrap: wrap;
  }

  .mf-stock-action-menu[open] {
    flex: 0 0 100%;
  }

  .mf-stock-action-menu[open] > summary {
    margin-left: auto;
  }

  .mf-stock-action-panel {
    position: static;
    width: 100%;
    margin-top: 6px;
  }
}

@media (max-width: 720px) {
  .mf-stock-viewbar {
    align-items: stretch;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }

  .mf-stock-viewbar .ed-tabs {
    flex: 1 1 100%;
  }

  .mf-stock-new {
    width: 100%;
  }

  .mf-stock-filters .ed-stock-scan {
    grid-template-columns: 1fr 1fr;
  }

  .mf-stock-filters .ed-stock-scan input {
    grid-column: 1 / -1;
  }

  .mf-stock-filters .ed-stock-scan .ed-btn {
    width: 100%;
  }
}

@media (max-width: 640px) {
  .mf-stock-table-wrap {
    overflow: visible;
    border: 0;
    background: transparent;
    box-shadow: none;
  }

  .mf-stock-table {
    display: block;
    min-width: 0;
  }

  .mf-stock-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .mf-stock-table tbody {
    display: grid;
    gap: 12px;
  }

  .mf-stock-table tr {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    overflow: visible;
    border: 1px solid var(--ed-line);
    border-radius: var(--ed-radius);
    background: var(--ed-paper);
    box-shadow: var(--ed-shadow-xs, 0 1px 2px #172c260d);
  }

  .mf-stock-table td,
  .mf-stock-table :is(td, th):first-child,
  .mf-stock-table :is(td, th):last-child {
    display: block;
    min-width: 0;
    padding: 11px 13px;
    border: 0;
    text-align: left;
    white-space: normal;
  }

  .mf-stock-table td::before {
    content: attr(data-label);
    display: block;
    margin-bottom: 4px;
    color: var(--ed-muted);
    font-size: 10px;
    font-weight: 650;
    letter-spacing: .07em;
    text-transform: uppercase;
  }

  .mf-stock-table td:first-child {
    grid-column: 1 / -1;
    padding-block: 14px;
    border-bottom: 1px solid var(--ed-line);
  }

  .mf-stock-table td:first-child::before,
  .mf-stock-table td:nth-child(5) {
    display: none;
  }

  .mf-stock-table td:last-child {
    grid-column: 1 / -1;
    border-top: 1px solid var(--ed-line);
  }

  .mf-stock-actions {
    justify-content: flex-start;
  }

}

@media (pointer: coarse) {
  .mf-stock-action-menu > summary {
    width: 46px;
  }

  .mf-stock-action-panel button {
    min-height: 46px;
    font-size: 13px;
  }
}
</style>
