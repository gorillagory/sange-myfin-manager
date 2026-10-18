<script setup>
import { computed, ref, watch } from 'vue';
import { Store } from '../../store';
import { api, companyPath } from '../../services/api';
import Modal from '../ui/EditionModal.vue';
import Icon from '../ui/EditionIcon.vue';

const tab = ref('receiving'), loading = ref(false), busy = ref(false), error = ref('');
const queue = ref([]), alerts = ref([]), orders = ref([]), valuation = ref([]), identifiers = ref([]);
const receipt = ref(null), orderForm = ref(null), identifierForm = ref(null), resolved = ref(null), lookup = ref('');
let generation = 0;
const owner = computed(() => Store.can('costsRead'));
const canMaintain = computed(() => Store.can('inventoryWrite'));
const stockItems = computed(() => Store.state.stock_items.filter(item => item.active).sort((a,b) => a.name.localeCompare(b.name)));
const suppliers = computed(() => Store.state.clients.filter(item => item.type === 'Supplier').sort((a,b) => a.name.localeCompare(b.name)));
const currency = computed(() => Store.state.selectedCompany?.preferences?.currency || 'RM');
const path = suffix => companyPath(Store, suffix);
const fmt = value => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits:6 });
const amount = sen => `${currency.value} ${(Number(sen || 0) / 100).toFixed(2)}`;
const statusLabel = value => String(value || '').replaceAll('_',' ').replace(/\b\w/g, letter => letter.toUpperCase());
const toLocalDateTime = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16);
const selectedIdentifierItem = computed(() => stockItems.value.find(item => item.id === identifierForm.value?.stockItemId));

function requireOnline() {
  if (Store.state.online) return true;
  error.value = 'Purchasing requires a live connection.';
  return false;
}
function clearTenantData() {
  queue.value=[];alerts.value=[];orders.value=[];valuation.value=[];identifiers.value=[];resolved.value=null;
  loading.value=false;error.value='';
}

async function load() {
  const request = ++generation, companyId = Store.state.selectedCompany?.id;
  if (!companyId || !Store.can('inventoryRead') || !Store.state.online) return;
  loading.value = true; error.value = '';
  try {
    const tasks = [
      api(path('/receiving-queue')),
      api(path('/low-stock-alerts')),
      api(path('/stock-identifiers')),
      ...(owner.value ? [api(path('/purchase-orders')),api(path('/inventory-valuation'))] : []),
    ];
    const values = await Promise.all(tasks);
    if (request !== generation || companyId !== Store.state.selectedCompany?.id) return;
    queue.value = values[0].rows || [];
    alerts.value = values[1].rows || [];
    identifiers.value = values[2].rows || [];
    orders.value = owner.value ? values[3].rows || [] : [];
    valuation.value = owner.value ? values[4].rows || [] : [];
  } catch (failure) { if (request === generation) error.value = failure.message || 'Purchasing data could not be loaded.'; }
  finally { if (request === generation) loading.value = false; }
}

function openReceipt(order) {
  if (!requireOnline()) return;
  receipt.value = {
    order, reference:'', receivedAt:toLocalDateTime(), idempotencyKey:crypto.randomUUID(),
    lines:order.lines.filter(line => line.receivedQuantity < line.orderedQuantity).map(line => ({
      purchaseOrderLineId:line.id, quantity:'', batchCode:'', lotCode:'', expiryDate:'',
    })),
  };
  error.value = '';
}
async function receive() {
  if (busy.value || !receipt.value || !requireOnline()) return;
  const receivedAt = new Date(receipt.value.receivedAt);
  if (!Number.isFinite(receivedAt.getTime())) { error.value = 'Choose a valid received date and time.'; return; }
  const lines = receipt.value.lines.filter(line => Number(line.quantity) > 0).map(line => ({
    purchaseOrderLineId:line.purchaseOrderLineId,quantity:Number(line.quantity),batchCode:line.batchCode,
    lotCode:line.lotCode,expiryDate:line.expiryDate,
  }));
  if (!lines.length) { error.value = 'Enter a received quantity for at least one line.'; return; }
  const orderLines = new Map(receipt.value.order.lines.map(line => [line.id,line]));
  if (lines.some(line => !Number.isFinite(line.quantity) || line.quantity > Number(orderLines.get(line.purchaseOrderLineId)?.orderedQuantity || 0) - Number(orderLines.get(line.purchaseOrderLineId)?.receivedQuantity || 0) + 1e-9)) {
    error.value = 'A received quantity exceeds the amount still outstanding.'; return;
  }
  busy.value = true; error.value = '';
  try {
    await api(path(`/purchase-orders/${encodeURIComponent(receipt.value.order.id)}/receipts`), {
      method:'POST', body:{ reference:receipt.value.reference,receivedAt:receivedAt.toISOString(),
        idempotencyKey:receipt.value.idempotencyKey,lines },
    });
    receipt.value = null; await Promise.all([Store.refreshData(),load()]); Store.notify('Goods receipt posted.');
  } catch (failure) { error.value = failure.message || 'The receipt could not be posted.'; }
  finally { busy.value = false; }
}

function newOrder() {
  if (!requireOnline()) return;
  const timestamp = [...new Date().toISOString()].filter(character => character >= '0' && character <= '9').join('').slice(0,14);
  orderForm.value = { number:`PO-${timestamp}`,supplierId:'',
    expectedDate:'',notes:'',idempotencyKey:crypto.randomUUID(),lines:[newOrderLine()] };
  error.value = '';
}
function newOrderLine() { return { stockItemId:'',unitVersion:0,supplierItemReference:'',description:'',purchaseUnit:'carton',orderedQuantity:1,quantityInBase:1,unitPrice:'' }; }
function selectOrderItem(line) {
  const item = stockItems.value.find(row => row.id === line.stockItemId);
  if (item) { line.unitVersion=Number(item.unitVersion);line.description = item.name; line.purchaseUnit = item.baseUnit || 'unit'; line.quantityInBase = 1; }
}
async function createOrder() {
  if (busy.value || !orderForm.value || !requireOnline()) return;
  busy.value = true; error.value = '';
  try {
    const payload = { number:orderForm.value.number,supplierId:orderForm.value.supplierId,currencyCode:'MYR',
      expectedDate:orderForm.value.expectedDate,notes:orderForm.value.notes,idempotencyKey:orderForm.value.idempotencyKey,
      lines:orderForm.value.lines.map(line => ({
      stockItemId:line.stockItemId,unitVersion:Number(line.unitVersion),supplierItemReference:line.supplierItemReference,description:line.description,
      purchaseUnit:line.purchaseUnit,orderedQuantity:Number(line.orderedQuantity),quantityInBase:Number(line.quantityInBase),
      unitPriceSen:Math.round(Number(line.unitPrice) * 100),
    })) };
    await api(path('/purchase-orders'),{method:'POST',body:payload});
    orderForm.value = null; await load(); Store.notify('Purchase order draft created.');
  } catch (failure) { error.value = failure.message==='stock_unit_changed_reload'?'A stock item’s unit changed while this order was open. Close the order, reload, and enter its quantities again.':failure.message || 'The purchase order could not be created.'; }
  finally { busy.value = false; }
}
async function orderAction(order, action) {
  if (busy.value || !requireOnline()) return;
  if (action === 'cancel' && !confirm(`Cancel ${order.number}? Its history will remain.`)) return;
  busy.value = true; error.value = '';
  try {
    await api(path(`/purchase-orders/${encodeURIComponent(order.id)}/${action}`), { method:'POST',
      body:action === 'cancel' ? {version:order.version,reason:'Cancelled by workspace owner'} : {version:order.version} });
    await load(); Store.notify(action === 'submit' ? 'Purchase order submitted for receiving.' : 'Purchase order cancelled.');
  } catch (failure) { error.value = failure.message || 'The purchase order could not be updated.'; }
  finally { busy.value = false; }
}

function newIdentifier() { if (!requireOnline()) return; identifierForm.value = {stockItemId:'',type:'gtin',value:'',supplierId:'',packagingId:''}; error.value=''; }
function identifierItemChanged() { if (identifierForm.value) identifierForm.value.packagingId=''; }
function identifierTypeChanged() { if (identifierForm.value?.type!=='supplier_barcode') identifierForm.value.supplierId=''; }
async function saveIdentifier() {
  if (busy.value || !identifierForm.value || !requireOnline()) return;
  busy.value = true; error.value = '';
  try {
    const form=identifierForm.value,payload={stockItemId:form.stockItemId,type:form.type,value:form.value,
      supplierId:form.type==='supplier_barcode'?form.supplierId:'',packagingId:form.packagingId||''};
    await api(path('/stock-identifiers'),{method:'POST',body:payload});
    identifierForm.value = null;resolved.value=null;await load(); Store.notify('Scan identifier added.');
  } catch (failure) { error.value = failure.message || 'The identifier could not be added.'; }
  finally { busy.value = false; }
}
async function archiveIdentifier(row) {
  if (busy.value || !requireOnline() || !confirm(`Archive ${row.value}?`)) return;
  busy.value = true;error.value='';
  try { await api(path(`/stock-identifiers/${encodeURIComponent(row.id)}/archive`),{method:'POST',body:{version:row.version}}); resolved.value=null;await load(); }
  catch (failure) { error.value = failure.message; }
  finally { busy.value = false; }
}
async function resolveCode() {
  if (!lookup.value.trim() || !requireOnline()) return;
  error.value = ''; resolved.value = null;
  try { resolved.value = await api(path(`/stock-identifiers/resolve/${encodeURIComponent(lookup.value.trim())}`)); }
  catch (failure) { error.value = failure.message === 'stock_identifier_not_found' ? 'No active identifier matches that code.' : failure.message; }
}
async function acknowledge(row) {
  if (busy.value || !requireOnline()) return;
  busy.value = true; error.value = '';
  try { await api(path(`/low-stock-alerts/${encodeURIComponent(row.id)}/acknowledge`),{method:'POST',body:{version:row.version}}); await load(); }
  catch (failure) { error.value = failure.message; }
  finally { busy.value = false; }
}
watch(() => [Store.state.selectedCompany?.id,Store.state.currentUser?.role,Store.state.online], () => {
  receipt.value=null;orderForm.value=null;identifierForm.value=null;clearTenantData();
  if (!owner.value && ['orders','valuation'].includes(tab.value)) tab.value='receiving';
  load();
}, {immediate:true});
</script>

<template>
  <div v-if="Store.can('inventoryRead')" class="ed-page procurement-page">
    <header class="ed-page-head"><div><div class="ed-eyebrow">INVENTORY / PURCHASING</div><h1>Receive what you ordered.</h1><p>Track supplier orders, scannable identifiers, low stock and purchase cost evidence.</p></div><div class="ed-actions"><button class="ed-btn" :disabled="loading||!Store.state.online" @click="load">{{ loading?'Loading…':'Refresh' }}</button><button v-if="owner" class="ed-btn primary" :disabled="busy||!Store.state.online" @click="newOrder"><Icon name="plus"/>New purchase order</button></div></header>
    <p v-if="!Store.state.online" class="ed-notice warning">Purchasing requires a live connection so stock and cost evidence remain atomic.</p>
    <p v-if="error&&!receipt&&!orderForm&&!identifierForm" class="ed-notice error" role="alert">{{ error }}</p>
    <div class="ed-tabs"><button :class="{active:tab==='receiving'}" @click="tab='receiving'">Receiving <span v-if="queue.length" class="ed-pill warning">{{ queue.length }}</span></button><button :class="{active:tab==='alerts'}" @click="tab='alerts'">Low stock <span v-if="alerts.filter(row=>row.status!=='resolved').length" class="ed-pill warning">{{ alerts.filter(row=>row.status!=='resolved').length }}</span></button><button :class="{active:tab==='identifiers'}" @click="tab='identifiers'">Identifiers</button><button v-if="owner" :class="{active:tab==='orders'}" @click="tab='orders'">Purchase orders</button><button v-if="owner" :class="{active:tab==='valuation'}" @click="tab='valuation'">Valuation</button></div>

    <template v-if="tab==='receiving'"><div v-if="queue.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Order</th><th>Supplier</th><th>Expected</th><th>Outstanding items</th><th>Status</th><th>Action</th></tr></thead><tbody><tr v-for="order in queue" :key="order.id"><td><strong>{{ order.number }}</strong><small>{{ new Date(order.createdAt).toLocaleDateString('en-MY') }}</small></td><td>{{ order.supplierName }}</td><td>{{ order.expectedDate||'Not set' }}</td><td>{{ order.lines.filter(line=>line.receivedQuantity<line.orderedQuantity).length }}</td><td><span class="ed-pill warning">{{ statusLabel(order.status) }}</span></td><td><button class="ed-btn small primary" :disabled="busy||!Store.state.online" @click="openReceipt(order)">Receive</button></td></tr></tbody></table></div><div v-else-if="!loading" class="ed-empty"><Icon name="truck"/><h3>No supplier deliveries are waiting.</h3><p>Submitted purchase orders appear here for staff receiving.</p></div></template>

    <template v-else-if="tab==='alerts'"><div v-if="alerts.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Stock item</th><th>Observed</th><th>Reorder threshold</th><th>Status</th><th>Opened</th><th>Action</th></tr></thead><tbody><tr v-for="row in alerts" :key="row.id"><td><strong>{{ row.stockItemName }}</strong></td><td>{{ fmt(row.observedQuantity) }} {{ row.baseUnit }}</td><td>{{ fmt(row.reorderThreshold) }} {{ row.baseUnit }}</td><td><span class="ed-pill" :class="{warning:row.status!=='resolved',ready:row.status==='resolved'}">{{ statusLabel(row.status) }}</span></td><td>{{ new Date(row.openedAt).toLocaleString('en-MY') }}</td><td><button v-if="row.status==='open'&&canMaintain" class="ed-btn small" :disabled="busy||!Store.state.online" @click="acknowledge(row)">Acknowledge</button></td></tr></tbody></table></div><div v-else-if="!loading" class="ed-empty"><Icon name="box"/><h3>No low-stock alerts.</h3></div></template>

    <template v-else-if="tab==='identifiers'"><div class="ed-filters"><div class="ed-search"><Icon name="search"/><input v-model="lookup" class="ed-input" placeholder="Scan or enter stock code, GTIN, barcode, SKU or QR" :disabled="!Store.state.online" @keydown.enter="resolveCode"><button class="ed-btn" :disabled="!Store.state.online" @click="resolveCode">Resolve</button></div><button v-if="canMaintain" class="ed-btn primary" :disabled="busy||!Store.state.online" @click="newIdentifier"><Icon name="plus"/>Add identifier</button></div><div v-if="resolved" class="ed-notice"><strong>{{ resolved.stockItem.name }}</strong> · {{ fmt(resolved.stockItem.onHand) }} {{ resolved.stockItem.baseUnit }} · {{ resolved.identifier.type.toUpperCase() }}</div><div v-if="identifiers.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Code</th><th>Type</th><th>Stock item</th><th>Supplier</th><th>Status</th><th>Action</th></tr></thead><tbody><tr v-for="row in identifiers" :key="row.id"><td><strong>{{ row.value }}</strong></td><td>{{ row.type.toUpperCase() }}</td><td>{{ stockItems.find(item=>item.id===row.stockItemId)?.name||row.stockItemId }}</td><td>{{ suppliers.find(item=>item.id===row.supplierId)?.name||'—' }}</td><td>{{ row.active?'Active':'Archived' }}</td><td><button v-if="row.active&&canMaintain" class="ed-btn small" :disabled="busy||!Store.state.online" @click="archiveIdentifier(row)">Archive</button></td></tr></tbody></table></div><div v-else-if="!loading" class="ed-empty"><Icon name="qr"/><h3>No central identifiers yet.</h3><p>Every stock item still has an automatic internal code; add manufacturer or supplier identifiers here when needed.</p></div></template>

    <template v-else-if="tab==='orders'&&owner"><div v-if="orders.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Order</th><th>Supplier</th><th>Items</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead><tbody><tr v-for="order in orders" :key="order.id"><td><strong>{{ order.number }}</strong><small>v{{ order.version }} · {{ order.expectedDate||'No expected date' }}</small></td><td>{{ order.supplierName }}</td><td>{{ order.lines.length }}</td><td>{{ amount(order.totalSen) }}</td><td><span class="ed-pill" :class="{warning:['draft','submitted','partially_received'].includes(order.status),ready:order.status==='received'}">{{ statusLabel(order.status) }}</span></td><td><div class="ed-actions"><button v-if="order.status==='draft'" class="ed-btn small primary" :disabled="busy||!Store.state.online" @click="orderAction(order,'submit')">Submit</button><button v-if="['draft','submitted','partially_received'].includes(order.status)" class="ed-btn small" :disabled="busy||!Store.state.online" @click="orderAction(order,'cancel')">Cancel</button></div></td></tr></tbody></table></div><div v-else-if="!loading" class="ed-empty"><Icon name="receipt"/><h3>No purchase orders yet.</h3></div></template>

    <template v-else-if="tab==='valuation'&&owner"><p class="ed-notice">Weighted-average values include posted purchase receipts. Existing opening stock without a receipt remains uncosted.</p><div v-if="valuation.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Stock item</th><th>On hand</th><th>Receipt quantity</th><th>Average cost</th><th>Current value</th></tr></thead><tbody><tr v-for="row in valuation" :key="row.stockItemId"><td><strong>{{ row.name }}</strong></td><td>{{ fmt(row.onHand) }} {{ row.baseUnit }}</td><td>{{ fmt(row.cumulativeReceivedQuantity) }} {{ row.baseUnit }}</td><td>{{ amount(row.averageCostSen) }} / {{ row.baseUnit }}</td><td><strong>{{ amount(row.inventoryValueSen) }}</strong></td></tr></tbody></table></div><div v-else-if="!loading" class="ed-empty"><Icon name="chart"/><h3>No costed receipts yet.</h3></div></template>

    <Modal v-if="receipt" :title="`Receive ${receipt.order.number}`" :busy="busy" wide @close="receipt=null"><form id="goods-receipt-form" class="ed-form-grid" @submit.prevent="receive"><label class="ed-field"><span>Delivery reference</span><input v-model.trim="receipt.reference" maxlength="128" placeholder="Delivery order or invoice"></label><label class="ed-field"><span>Received at</span><input v-model="receipt.receivedAt" type="datetime-local" required></label><fieldset class="ed-field wide ed-editor-section"><legend><strong>Received quantities</strong></legend><div v-for="line in receipt.order.lines.filter(item=>item.receivedQuantity<item.orderedQuantity)" :key="line.id" class="receipt-line"><div><strong>{{ line.stockItemName }}</strong><small>{{ fmt(line.receivedQuantity) }} of {{ fmt(line.orderedQuantity) }} {{ line.purchaseUnit }} already received</small></div><input v-model="receipt.lines.find(item=>item.purchaseOrderLineId===line.id).quantity" type="number" min="0" :max="line.orderedQuantity-line.receivedQuantity" step="0.000001" :aria-label="`Received quantity for ${line.stockItemName}`" placeholder="Received quantity"><input v-model.trim="receipt.lines.find(item=>item.purchaseOrderLineId===line.id).batchCode" maxlength="128" placeholder="Batch · optional"><input v-model.trim="receipt.lines.find(item=>item.purchaseOrderLineId===line.id).lotCode" maxlength="128" placeholder="Lot · optional"><input v-model="receipt.lines.find(item=>item.purchaseOrderLineId===line.id).expiryDate" type="date" :aria-label="`Expiry date for ${line.stockItemName}`"></div></fieldset></form><p v-if="error" class="ed-notice error">{{ error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="receipt=null">Cancel</button><button class="ed-btn primary" :disabled="busy||!Store.state.online" type="submit" form="goods-receipt-form">{{ busy?'Posting…':'Post receipt' }}</button></template></Modal>

    <Modal v-if="orderForm" title="New purchase order" :busy="busy" wide @close="orderForm=null"><form id="purchase-order-form" class="ed-form-grid" @submit.prevent="createOrder"><label class="ed-field"><span>PO number</span><input v-model.trim="orderForm.number" required maxlength="64"></label><label class="ed-field"><span>Supplier</span><select v-model="orderForm.supplierId" required><option value="">Choose supplier</option><option v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id">{{ supplier.name }}</option></select></label><label class="ed-field"><span>Expected date</span><input v-model="orderForm.expectedDate" type="date"></label><label class="ed-field wide"><span>Notes</span><textarea v-model="orderForm.notes" maxlength="10000" rows="2"></textarea></label><fieldset class="ed-field wide ed-editor-section"><legend><strong>Order lines</strong></legend><div v-for="(line,index) in orderForm.lines" :key="index" class="order-line"><select v-model="line.stockItemId" required @change="selectOrderItem(line)"><option value="">Stock item</option><option v-for="item in stockItems" :key="item.id" :value="item.id">{{ item.name }} · {{ item.baseUnit }}</option></select><input v-model.trim="line.description" required maxlength="500" placeholder="Description"><input v-model.trim="line.supplierItemReference" maxlength="128" placeholder="Supplier item ref"><input v-model.trim="line.purchaseUnit" required maxlength="32" placeholder="Purchase unit"><input v-model.number="line.orderedQuantity" required type="number" min="0.000001" step="0.000001" placeholder="Qty"><input v-model.number="line.quantityInBase" required type="number" min="0.000001" step="0.000001" placeholder="Base units each"><input v-model="line.unitPrice" required type="number" min="0" max="10000000" step="0.01" placeholder="Unit price (MYR)"><button type="button" class="ed-icon-button" aria-label="Remove line" :disabled="orderForm.lines.length===1" @click="orderForm.lines.splice(index,1)"><Icon name="close"/></button></div><button type="button" class="ed-btn small" @click="orderForm.lines.push(newOrderLine())"><Icon name="plus"/>Add line</button></fieldset></form><p v-if="error" class="ed-notice error">{{ error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="orderForm=null">Cancel</button><button class="ed-btn primary" :disabled="busy||!Store.state.online" type="submit" form="purchase-order-form">{{ busy?'Saving…':'Create draft' }}</button></template></Modal>

    <Modal v-if="identifierForm" title="Add stock identifier" :busy="busy" @close="identifierForm=null"><form id="stock-identifier-form" class="ed-form-grid" @submit.prevent="saveIdentifier"><label class="ed-field wide"><span>Stock item</span><select v-model="identifierForm.stockItemId" required @change="identifierItemChanged"><option value="">Choose item</option><option v-for="item in stockItems" :key="item.id" :value="item.id">{{ item.name }}</option></select></label><label class="ed-field"><span>Identifier type</span><select v-model="identifierForm.type" @change="identifierTypeChanged"><option value="gtin">GTIN</option><option value="ean">EAN</option><option value="upc">UPC</option><option value="manufacturer_barcode">Manufacturer barcode</option><option value="supplier_barcode">Supplier barcode</option><option value="internal_sku">Internal SKU</option><option value="qr">QR</option></select></label><label class="ed-field"><span>Value</span><input v-model.trim="identifierForm.value" required maxlength="256"></label><label v-if="selectedIdentifierItem?.packagings?.length" class="ed-field wide"><span>Packaging · optional</span><select v-model="identifierForm.packagingId"><option value="">Base unit</option><option v-for="pack in selectedIdentifierItem.packagings" :key="pack.id" :value="pack.id">{{ pack.label }} · {{ fmt(pack.quantityInBase) }} {{ selectedIdentifierItem.baseUnit }}</option></select></label><label v-if="identifierForm.type==='supplier_barcode'" class="ed-field wide"><span>Supplier</span><select v-model="identifierForm.supplierId" required><option value="">Choose supplier</option><option v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id">{{ supplier.name }}</option></select></label></form><p v-if="error" class="ed-notice error">{{ error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="identifierForm=null">Cancel</button><button class="ed-btn primary" :disabled="busy||!Store.state.online" type="submit" form="stock-identifier-form">{{ busy?'Saving…':'Add identifier' }}</button></template></Modal>
  </div>
  <div v-else class="ed-notice">This account cannot view inventory purchasing.</div>
</template>

<style scoped>
.procurement-page .ed-tabs{flex-wrap:wrap}.receipt-line,.order-line{display:grid;gap:9px;align-items:end;padding:12px 0;border-top:1px solid var(--ed-line)}.receipt-line{grid-template-columns:minmax(180px,1.4fr) repeat(4,minmax(110px,1fr))}.order-line{grid-template-columns:1.1fr 1.1fr .8fr .7fr .55fr .7fr .7fr auto}.receipt-line>div{display:flex;flex-direction:column;gap:4px}.receipt-line small{color:var(--ed-muted)}.receipt-line input,.order-line input,.order-line select{width:100%;min-width:0}.order-line .ed-icon-button{align-self:center}@media(max-width:1000px){.receipt-line,.order-line{grid-template-columns:1fr 1fr}.receipt-line>div{grid-column:1/-1}}@media(max-width:620px){.receipt-line,.order-line{grid-template-columns:1fr}.procurement-page .ed-actions,.procurement-page .ed-filters{width:100%}.procurement-page .ed-search{min-width:0;width:100%}}
</style>
