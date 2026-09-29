<script setup>
import {computed,nextTick,onBeforeUnmount,ref} from 'vue';
import {Store} from '../../store';
import {STOCK_MODES,defaultStockUnit,findStockCode,normalizeStockItem,stockMovement} from '../../domain/stock.js';
import Icon from '../ui/EditionIcon.vue';
import Modal from '../ui/EditionModal.vue';

const tab=ref('items'),search=ref(''),form=ref(null),movement=ref(null),busy=ref(false),error=ref(''),scanCode=ref(''),camera=ref(false),video=ref(null);
const cameraTarget=ref({kind:'lookup',index:-1});
let scanControls=null,scanRequest=0;
const suppliers=computed(()=>Store.state.clients.filter(client=>client.type==='Supplier'));
const expenses=computed(()=>Store.state.expenses.filter(item=>!item.voided_at));
const items=computed(()=>Store.state.stock_items.filter(item=>[item.name,item.category,item.barcode,item.baseUnit,...(item.packagings||[]).flatMap(pack=>[pack.label,pack.barcode])].join(' ').toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())).sort((a,b)=>Number(b.active)-Number(a.active)||a.category.localeCompare(b.category)||a.name.localeCompare(b.name)));
const itemMap=computed(()=>new Map(Store.state.stock_items.map(item=>[item.id,item])));
const history=computed(()=>[...Store.state.stock_ledger].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))));
const mode=computed(()=>STOCK_MODES.find(value=>value.value===form.value?.trackingMode));
const selectedPack=computed(()=>movement.value?.packagingId?movement.value.item.packagings.find(pack=>pack.id===movement.value.packagingId):null);
const preview=computed(()=>{if(!movement.value)return null;try{return stockMovement({kind:movement.value.kind,quantity:Number(movement.value.quantity||0)*Number(selectedPack.value?.quantityInBase||1)},movement.value.item.onHand);}catch{return null;}});
const fmt=value=>Number(value||0).toLocaleString(undefined,{maximumFractionDigits:6});
const supplierName=id=>suppliers.value.find(item=>item.id===id)?.name||'—';

function edit(item=null){form.value=normalizeStockItem(item||{trackingMode:'count',baseUnit:'pcs',active:true});error.value='';}
function changeMode(){if(form.value)form.value.baseUnit=defaultStockUnit(form.value.trackingMode);}
function addPackaging(){form.value.packagings.push({label:'',barcode:'',quantityInBase:1});}
async function save(){if(busy.value)return;busy.value=true;error.value='';try{if(form.value.id)await Store.updateStockItem(form.value);else await Store.addStockItem(form.value);form.value=null;Store.notify('Stock item saved.');}catch(e){error.value=e.message;}finally{busy.value=false;}}
function openMovement(item,kind='receive',packaging=null){movement.value={item,kind,quantity:packaging?1:'',packagingId:packaging?.id||'',supplierId:item.preferredSupplierId||'',expenseId:'',reason:kind==='count'?'Physical stock count':'',idempotencyKey:crypto.randomUUID()};error.value='';}
async function submitMovement(){if(busy.value)return;busy.value=true;error.value='';try{const {item,...payload}=movement.value;payload.quantity=Number(payload.quantity);await Store.recordStockMovement(item.id,payload);movement.value=null;Store.notify('Stock movement recorded.');}catch(e){error.value=e.message;}finally{busy.value=false;}}
async function archive(item){if(busy.value)return;busy.value=true;try{await Store.archiveStockItem(item.id);Store.notify('Stock item archived.');}catch(e){Store.notify(e.message,'error');}finally{busy.value=false;}}
async function restore(item){if(busy.value)return;busy.value=true;try{await Store.updateStockItem({...item,active:true});Store.notify('Stock item restored.');}catch(e){Store.notify(e.message,'error');}finally{busy.value=false;}}
function useScan(code=scanCode.value){const match=findStockCode(Store.state.stock_items,code);if(!match){error.value='No stock item uses that barcode or QR code.';return;}scanCode.value='';error.value='';openMovement(match.item,'receive',match.packaging);}
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
onBeforeUnmount(stopCamera);
</script>

<template><div v-if="Store.can('inventoryRead')" class="ed-page"><header class="ed-page-head"><div><div class="ed-eyebrow">OPERATIONS / STOCK RECORDS</div><h1>Know what is on the shelf.</h1><p>Track counted items, weight and volume independently from the sellable menu.</p></div><div class="ed-actions"><button v-if="Store.can('inventoryWrite')" class="ed-btn primary" @click="edit()"><Icon name="plus"/>New stock item</button></div></header>
  <div class="ed-tabs"><button :class="{active:tab==='items'}" @click="tab='items'">Items</button><button v-if="Store.can('stockHistoryRead')" :class="{active:tab==='history'}" @click="tab='history'">Movement history</button></div>
  <template v-if="tab==='items'"><div class="ed-filters"><div class="ed-search"><Icon name="search"/><input v-model="search" class="ed-input" placeholder="Search stock, barcode or category" aria-label="Search stock records"></div><div class="ed-stock-scan"><input v-model="scanCode" class="ed-input" placeholder="Scan or enter barcode / QR" aria-label="Barcode or QR code" @keydown.enter="useScan()"><button class="ed-btn" @click="useScan()">Find</button><button class="ed-btn" @click="startCamera('lookup')"><Icon name="qr"/>Camera</button></div></div><p v-if="error&&!form&&!movement" class="ed-alert" role="alert">{{ error }}</p>
    <div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Stock item</th><th>Tracking</th><th>On hand</th><th>Reorder at</th><th>Supplier</th><th>Actions</th></tr></thead><tbody><tr v-for="item in items" :key="item.id" :class="{'ed-company-archived':!item.active}"><td><strong>{{ item.name }}</strong><small>{{ item.category }}<template v-if="item.barcode"> · {{ item.barcode }}</template><template v-if="!item.active"> · Archived</template></small></td><td>{{ STOCK_MODES.find(mode=>mode.value===item.trackingMode)?.label }}</td><td :class="{'ed-low-stock':item.active&&item.onHand<=item.reorderLevel}"><strong>{{ fmt(item.onHand) }} {{ item.baseUnit }}</strong></td><td>{{ fmt(item.reorderLevel) }} {{ item.baseUnit }}</td><td>{{ supplierName(item.preferredSupplierId) }}</td><td><div class="ed-actions"><button v-if="item.active" class="ed-btn small" @click="openMovement(item,'receive')">Receive</button><button v-if="item.active" class="ed-btn small" @click="openMovement(item,'count')">Count</button><button v-if="Store.can('inventoryWrite')" class="ed-icon-button" :aria-label="`Edit ${item.name}`" @click="edit(item)"><Icon name="edit"/></button><button v-if="Store.can('inventoryWrite')&&item.active" class="ed-icon-button" :aria-label="`Archive ${item.name}`" @click="archive(item)"><Icon name="close"/></button><button v-if="Store.can('inventoryWrite')&&!item.active" class="ed-btn small" :aria-label="`Restore ${item.name}`" @click="restore(item)">Restore</button></div></td></tr></tbody></table></div><div v-if="!items.length" class="ed-empty"><Icon name="box"/><h3>No stock records found.</h3><p>Add cups, ingredients or bulk goods, then receive or count them.</p></div>
  </template>
  <template v-else><div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date</th><th>Item</th><th>Action</th><th>Change</th><th>Balance</th><th>Reason</th></tr></thead><tbody><tr v-for="entry in history" :key="entry.id"><td>{{ new Date(entry.createdAt).toLocaleString() }}</td><td>{{ itemMap.get(entry.itemId)?.name||entry.itemId }}</td><td><span class="ed-pill">{{ entry.kind }}</span></td><td>{{ entry.delta>0?'+':'' }}{{ fmt(entry.delta) }} {{ itemMap.get(entry.itemId)?.baseUnit }}</td><td>{{ fmt(entry.quantityAfter) }} {{ itemMap.get(entry.itemId)?.baseUnit }}</td><td>{{ entry.reason }}</td></tr></tbody></table></div><div v-if="!history.length" class="ed-empty"><Icon name="clock"/><h3>No movements recorded.</h3></div></template>

  <Modal v-if="form" :title="form.id?'Edit stock item':'New stock item'" :busy="busy" wide @close="form=null"><form id="stock-item-form" class="ed-form-grid" @submit.prevent="save"><label class="ed-field wide"><span>Name</span><input v-model="form.name" required maxlength="120"></label><label class="ed-field"><span>Category</span><input v-model="form.category" maxlength="120" placeholder="Ingredients"></label><label class="ed-field"><span>Tracking method</span><select v-model="form.trackingMode" @change="changeMode"><option v-for="choice in STOCK_MODES" :key="choice.value" :value="choice.value">{{ choice.label }}</option></select><small>{{ mode?.examples }}</small></label><label class="ed-field"><span>Base unit</span><select v-model="form.baseUnit"><option v-for="unit in mode?.units||[]" :key="unit">{{ unit }}</option><option v-if="form.baseUnit&&!(mode?.units||[]).includes(form.baseUnit)">{{ form.baseUnit }}</option></select></label><div class="ed-field"><span id="stock-item-barcode-label">Item barcode / QR</span><div class="ed-stock-code-control"><input v-model="form.barcode" maxlength="128" aria-labelledby="stock-item-barcode-label"><button type="button" class="ed-btn small" aria-label="Scan item barcode with camera" @click="startCamera('item')"><Icon name="qr"/>Scan</button></div></div><label class="ed-field"><span>{{ form.id?'Current stock':'Opening stock' }}</span><input v-model.number="form.onHand" type="number" min="0" step="0.000001" :disabled="!!form.id"><small v-if="form.id">Use Receive, Count or Adjust to preserve history.</small></label><label class="ed-field"><span>Reorder level</span><input v-model.number="form.reorderLevel" type="number" min="0" step="0.000001"></label><label v-if="Store.can('suppliersRead')" class="ed-field"><span>Preferred supplier</span><select v-model="form.preferredSupplierId"><option value="">None</option><option v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id">{{ supplier.name }}</option></select></label><label class="ed-field wide"><span>Notes</span><textarea v-model="form.notes" rows="3" maxlength="10000"></textarea></label><fieldset class="ed-field wide ed-editor-section"><legend><strong>Scannable packaging</strong></legend><p class="ed-muted">Example: a 1 kg bag contains 1,000 g. Scanning the bag starts a movement in that package.</p><div v-for="(pack,index) in form.packagings" :key="pack.id||index" class="ed-stock-package"><input v-model="pack.label" required placeholder="1 kg bag" aria-label="Packaging label"><div class="ed-stock-package-scan"><input v-model="pack.barcode" placeholder="Barcode / QR" aria-label="Packaging barcode"><button type="button" class="ed-btn small" :aria-label="'Scan packaging '+(index+1)+' barcode with camera'" @click="startCamera('packaging',index)"><Icon name="qr"/>Scan</button></div><input v-model.number="pack.quantityInBase" required type="number" min="0.000001" step="0.000001" :aria-label="`Quantity in ${form.baseUnit}`"><span>{{ form.baseUnit }}</span><button type="button" class="ed-icon-button" aria-label="Remove packaging" @click="form.packagings.splice(index,1)"><Icon name="close"/></button></div><button type="button" class="ed-btn small" @click="addPackaging"><Icon name="plus"/>Add packaging</button></fieldset></form><p v-if="error" class="ed-alert" role="alert">{{ error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="form=null">Cancel</button><button class="ed-btn primary" :disabled="busy" type="submit" form="stock-item-form">{{ busy?'Saving…':'Save item' }}</button></template></Modal>
  <Modal v-if="movement" :title="`Update ${movement.item.name}`" :busy="busy" @close="movement=null"><form id="stock-movement-form" class="ed-form-grid" @submit.prevent="submitMovement"><label class="ed-field"><span>Action</span><select v-model="movement.kind"><option value="receive">Receive</option><option value="count">Physical count</option><option value="consume">Consume / use</option><option value="waste">Waste</option><option value="adjust">Adjustment (+ or −)</option></select></label><label v-if="movement.item.packagings.length" class="ed-field"><span>Unit</span><select v-model="movement.packagingId"><option value="">{{ movement.item.baseUnit }}</option><option v-for="pack in movement.item.packagings" :key="pack.id" :value="pack.id">{{ pack.label }} ({{ fmt(pack.quantityInBase) }} {{ movement.item.baseUnit }})</option></select></label><label class="ed-field"><span>{{ movement.kind==='count'?'Counted quantity':'Quantity' }}</span><input v-model="movement.quantity" type="number" :min="movement.kind==='adjust'?undefined:0" step="0.000001" required></label><label v-if="Store.can('suppliersRead')" class="ed-field"><span>Supplier · optional</span><select v-model="movement.supplierId"><option value="">None</option><option v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id">{{ supplier.name }}</option></select></label><label v-if="Store.can('expensesRead')" class="ed-field wide"><span>Linked expense · optional</span><select v-model="movement.expenseId"><option value="">None</option><option v-for="expense in expenses" :key="expense.id" :value="expense.id">{{ expense.date }} · {{ expense.description }}</option></select></label><label class="ed-field wide"><span>Reason</span><input v-model="movement.reason" minlength="3" maxlength="1000" required placeholder="Delivery, physical count, damaged stock…"></label></form><p v-if="preview" class="ed-notice">Balance after this entry: <strong>{{ fmt(preview.quantityAfter) }} {{ movement.item.baseUnit }}</strong> ({{ preview.delta>0?'+':'' }}{{ fmt(preview.delta) }})</p><p v-if="error" class="ed-alert" role="alert">{{ error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="movement=null">Cancel</button><button class="ed-btn primary" :disabled="busy||!preview||movement.reason.trim().length<3" type="submit" form="stock-movement-form">{{ busy?'Recording…':'Record movement' }}</button></template></Modal>
  <Modal v-if="camera" title="Scan barcode or QR" @close="stopCamera"><video ref="video" class="ed-stock-camera" playsinline muted></video><p v-if="cameraTarget.kind==='lookup'" class="ed-muted">Point the camera at an existing item code to open Receive.</p><p v-else class="ed-muted">Point the camera at the item or packaging code. The form will fill in; save the item to keep it.</p><template #actions><button class="ed-btn" @click="stopCamera">Cancel</button></template></Modal>
</div></template>
