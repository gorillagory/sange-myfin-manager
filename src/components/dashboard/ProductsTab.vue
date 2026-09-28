<script setup>
import {ref,computed} from 'vue';
import {Store} from '../../store';
import ProductList from './products/ProductList.vue';
import ProductEditorModal from './products/ProductEditorModal.vue';
import ProductResourcesModal from './products/ProductResourcesModal.vue';
import Modal from '../ui/EditionModal.vue';
import {importProductsCsv,exportProductsCsv,templateCsv,validateProduct} from '../../domain/inventoryCsv';
import {downloadFile} from '../../services/download';
import {useStorage} from '../../composables/useStorage';
const {uploadFile}=useStorage();
const search=ref(''),saving=ref(false),showModal=ref(false),editingProduct=ref(null),resourceProduct=ref(null),deleting=ref(null);
const importOpen=ref(false),importRows=ref([]),importError=ref(''),importName=ref(''),importBusy=ref(false),importCompany=ref('');
const products=computed(()=>Store.state.products.filter(p=>[p.name,p.sku,p.code,p.barcode,...(p.variants||[]).flatMap(v=>[v.name,v.sku,v.barcode])].join(' ').toLowerCase().includes(search.value.toLowerCase())));
const currency=computed(()=>Store.state.selectedCompany?.preferences?.currency||'RM');
const categories=computed(()=>[...new Set(['Food','Beverage','Retail','Service','Other',...Store.state.products.map(p=>p.category).filter(Boolean)])]);
function openModal(p=null){if(!Store.can('inventoryWrite')||!Store.state.online||Store.state.fromCache)return;editingProduct.value=p;showModal.value=true;}
async function saveProduct(data,file){
  if(saving.value||!Store.can('inventoryWrite')||!Store.state.online||Store.state.fromCache)return;
  try{
    data.name=data.name.trim();data.sku=data.sku.trim();
    if(data.category==='Service'||!data.trackStock){data.trackStock=false;data.stock=0;data.variants.forEach(v=>v.stock=0);}
    validateProduct(data,Store.state.products);saving.value=true;
    const companyId=Store.state.selectedCompany.id;
    if(file){const object=await uploadFile(file,`products/${companyId}`);data.imageUrl=object.url;data.imagePath=object.path;}
    if(Store.state.selectedCompany.id!==companyId)throw new Error('The store changed. Reopen the product in the correct store.');
    if(data.id)await Store.updateProduct(data);else await Store.addProduct(data);
    showModal.value=false;
  }catch(e){Store.notify(e.message,'error');}finally{saving.value=false;}
}
async function deleteProduct(){if(saving.value)return;saving.value=true;try{await Store.deleteProduct(deleting.value.id);deleting.value=null;}catch(e){Store.notify(e.message,'error');}finally{saving.value=false;}}
async function readCsv(event){
  importRows.value=[];importError.value='';const file=event.target.files?.[0];if(!file)return;importName.value=file.name;
  try{if(file.size>2*1024*1024)throw new Error('CSV files must be 2 MB or less.');importRows.value=importProductsCsv(await file.text(),Store.state.products,{includeCosts:Store.can('costsWrite')});importCompany.value=Store.state.selectedCompany.id;}catch(e){importError.value=e.message;}
}
async function commitImport(){
  if(importBusy.value||!importRows.value.length)return;importBusy.value=true;importError.value='';
  try{if(importCompany.value!==Store.state.selectedCompany.id)throw new Error('Store changed. Select your CSV again.');await Store.inventoryModule.importProducts(Store,importRows.value);Store.notify(`${importRows.value.length} products imported.`);importRows.value=[];importOpen.value=false;}catch(e){importError.value=e.message;}finally{importBusy.value=false;}
}
function openImport(){importRows.value=[];importError.value='';importName.value='';importOpen.value=true;}
</script>
<template><div class="ed-page">
<header class="ed-page-head"><div><div class="ed-eyebrow">INVENTORY</div><h1>A place for every product.</h1><p>Products, variants and stock, in one clear view.</p></div><button v-if="Store.can('inventoryWrite')" class="ed-btn primary" :disabled="!Store.state.online" @click="openModal()">+ Add product</button></header>
<div class="ed-filters"><div class="ed-search"><input v-model="search" class="ed-input" style="padding-left:12px" aria-label="Search inventory" placeholder="Search name, SKU or barcode"></div><span class="ed-muted">{{ products.length }} products</span></div>
<div v-if="Store.can('inventoryWrite')" class="ed-actions" style="margin-bottom:20px"><button class="ed-btn" @click="downloadFile(templateCsv({includeCosts:Store.can('costsRead')&&Store.state.online&&!Store.state.fromCache}),'sku-mass-upload-template.csv','text/csv;charset=utf-8')">Download SKU template</button><button class="ed-btn" :disabled="!Store.state.online||Store.state.fromCache" @click="openImport">Upload CSV</button><button class="ed-btn" :disabled="!products.length" @click="downloadFile(exportProductsCsv(products,{includeCosts:Store.can('costsRead')&&Store.state.online&&!Store.state.fromCache}),'inventory-export.csv','text/csv;charset=utf-8')">Export {{ search?'results':'inventory' }}</button></div>
<p v-if="!Store.can('inventoryWrite')" class="ed-notice">Read-only catalog: selling prices and stock availability. Ask a manager to update products.</p>
<ProductList :products="products" :currency="currency" :can-delete="Store.can('inventoryWrite')&&Store.state.online&&!Store.state.fromCache" :can-write="Store.can('inventoryWrite')&&Store.state.online&&!Store.state.fromCache" @edit="openModal" @delete="deleting=$event" @resources="resourceProduct=$event" />
<ProductEditorModal :show="showModal && Store.can('inventoryWrite')" :show-costs="Store.can('costsWrite')&&Store.state.online&&!Store.state.fromCache" :busy="saving" :product="editingProduct" :categories="categories" :currency="currency" @close="showModal=false" @save="saveProduct" />
<ProductResourcesModal v-if="resourceProduct && Store.can('inventoryWrite')" :product="resourceProduct" :currency="currency" @close="resourceProduct=null" />
<Modal v-if="deleting && Store.can('inventoryWrite')" title="Delete product?" :busy="saving" @close="deleting=null"><p>Delete {{ deleting.name }} from inventory? Saved receipts will keep their original item details.</p><template #actions><button class="ed-btn" :disabled="saving" @click="deleting=null">Cancel</button><button class="ed-btn danger" :disabled="saving" @click="deleteProduct">{{ saving?'Deleting…':'Delete product' }}</button></template></Modal>
<Modal v-if="importOpen && Store.can('inventoryWrite')" title="Import SKU CSV" wide :busy="importBusy" @close="importOpen=false">
  <p class="ed-muted">Create new products from the template. Use one row per variant and repeat its parent SKU and product details. Existing SKUs are rejected to protect current stock. Up to 300 products / 1,000 rows per file.</p>
  <label class="ed-field" style="margin-top:20px"><span>CSV file (UTF-8, max 2 MB)</span><input type="file" accept=".csv,text/csv" :disabled="importBusy" @change="readCsv"></label>
  <p v-if="importError" class="ed-alert" role="alert">{{ importError }}</p>
  <template v-if="importRows.length"><div class="ed-notice">{{ importName }} · {{ importRows.length }} new products ready to import.</div><div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>SKU</th><th>Name</th><th>Options</th><th>Price / Stock</th></tr></thead><tbody><tr v-for="p in importRows" :key="p.sku"><td>{{ p.sku }}</td><td>{{ p.name }}</td><td>{{ p.variants.length||'Standard' }}</td><td><div v-for="(v,i) in p.variants.length?p.variants:[p]" :key="i">{{ v.name }} · {{ currency }} {{ v.price }} / {{ p.trackStock?v.stock:'Not tracked' }}</div></td></tr></tbody></table></div></template>
  <template #actions><button class="ed-btn" :disabled="importBusy" @click="importOpen=false">Cancel</button><button class="ed-btn primary" :disabled="importBusy||!importRows.length" @click="commitImport">{{ importBusy?'Importing…':`Import ${importRows.length} products` }}</button></template>
</Modal>
</div></template>
