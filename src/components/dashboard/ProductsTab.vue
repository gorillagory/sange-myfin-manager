<script setup>
import {ref,computed,watch} from 'vue';
import {Store} from '../../store';
import ProductList from './products/ProductList.vue';
import ProductEditorModal from './products/ProductEditorModal.vue';
import ProductResourcesModal from './products/ProductResourcesModal.vue';
import Modal from '../ui/EditionModal.vue';
import {importProductsCsv,exportProductsCsv,templateCsv,validateProduct,filterInventoryProducts,inventoryFacets,categoryPath} from '../../domain/inventoryCsv';
import {downloadFile} from '../../services/download';
import {useStorage} from '../../composables/useStorage';
import {api,companyPath} from '../../services/api';
const {uploadFile}=useStorage();
const search=ref(''),categoryFilter=ref(''),subcategoryFilter=ref(''),saving=ref(false),showModal=ref(false),editingProduct=ref(null),resourceProduct=ref(null),deleting=ref(null);
const importOpen=ref(false),importRows=ref([]),importError=ref(''),importName=ref(''),importBusy=ref(false),importCompany=ref('');
const adjustment=ref(null),adjustBusy=ref(false),adjustError=ref('');
const products=computed(()=>filterInventoryProducts(Store.state.products,{query:search.value,category:categoryFilter.value,subcategory:subcategoryFilter.value}));
const currency=computed(()=>Store.state.selectedCompany?.preferences?.currency||'RM');
const facets=computed(()=>inventoryFacets(Store.state.products,categoryFilter.value));
const categories=computed(()=>[...new Set(['Menu','Food','Beverage','Retail','Service','Other',...facets.value.categories])]);
const subcategories=computed(()=>[...new Set(Store.state.products.map(p=>p.subcategory).filter(Boolean))].sort((a,b)=>a.localeCompare(b)));
const hasFilters=computed(()=>!!(search.value||categoryFilter.value||subcategoryFilter.value));
watch(categoryFilter,()=>{if(subcategoryFilter.value&&!facets.value.subcategories.includes(subcategoryFilter.value))subcategoryFilter.value='';});
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
async function saveAdjustment(){if(adjustBusy.value||!adjustment.value)return;adjustBusy.value=true;adjustError.value='';try{const value=adjustment.value;if(!value.productId||!Number(value.quantity)||value.reason.trim().length<3)throw new Error('Choose a product, enter a non-zero quantity and explain the movement.');await api(companyPath(Store,'/stock-adjustments'),{method:'POST',body:{reason:value.reason.trim(),adjustments:[{productId:value.productId,...(value.variantId?{variantId:value.variantId}:{}),quantity:Number(value.quantity)}]}});adjustment.value=null;await Store.refreshData();Store.notify('Inventory transaction recorded.');}catch(e){adjustError.value=e.message;}finally{adjustBusy.value=false;}}
</script>
<template><div class="ed-page">
<header class="ed-page-head"><div><div class="ed-eyebrow">INVENTORY</div><h1>A place for every product.</h1><p>Products, variants and stock, in one clear view.</p></div><div class="ed-actions"><button v-if="Store.can('inventoryTransact')" class="ed-btn" :disabled="!Store.state.online||Store.state.fromCache" @click="adjustment={productId:'',variantId:'',quantity:0,reason:''}">Record stock movement</button><button v-if="Store.can('inventoryWrite')" class="ed-btn primary" :disabled="!Store.state.online" @click="openModal()">+ Add product</button></div></header>
<div class="ed-filters"><div class="ed-search"><input v-model="search" class="ed-input" style="padding-left:12px" aria-label="Search inventory" placeholder="Search product, category, SKU or barcode"></div><label class="ed-field ed-filter-field"><span>Category</span><select v-model="categoryFilter"><option value="">All categories</option><option v-for="category in facets.categories" :key="category">{{ category }}</option></select></label><label class="ed-field ed-filter-field"><span>Subcategory</span><select v-model="subcategoryFilter"><option value="">All subcategories</option><option v-for="subcategory in facets.subcategories" :key="subcategory">{{ subcategory }}</option></select></label><button v-if="hasFilters" class="ed-btn" @click="search='';categoryFilter='';subcategoryFilter=''">Clear filters</button><span class="ed-muted">{{ products.length }} of {{ Store.state.products.length }} products</span></div>
<div v-if="Store.can('inventoryWrite')" class="ed-actions" style="margin-bottom:20px"><button class="ed-btn" @click="downloadFile(templateCsv({includeCosts:Store.can('costsRead')&&Store.state.online&&!Store.state.fromCache}),'sku-mass-upload-template.csv','text/csv;charset=utf-8')">Download SKU template</button><button class="ed-btn" :disabled="!Store.state.online||Store.state.fromCache" @click="openImport">Upload CSV</button><button class="ed-btn" :disabled="!products.length" @click="downloadFile(exportProductsCsv(products,{includeCosts:Store.can('costsRead')&&Store.state.online&&!Store.state.fromCache}),'inventory-export.csv','text/csv;charset=utf-8')">Export {{ hasFilters?'results':'inventory' }}</button></div>
<p v-if="!Store.can('inventoryWrite')" class="ed-notice">Read-only catalog: selling prices and stock availability. Ask a manager to update products.</p>
<ProductList :products="products" :currency="currency" :can-delete="Store.can('inventoryWrite')&&Store.state.online&&!Store.state.fromCache" :can-write="Store.can('inventoryWrite')&&Store.state.online&&!Store.state.fromCache" @edit="openModal" @delete="deleting=$event" @resources="resourceProduct=$event" />
<ProductEditorModal :show="showModal && Store.can('inventoryWrite')" :show-costs="Store.can('costsWrite')&&Store.state.online&&!Store.state.fromCache" :busy="saving" :product="editingProduct" :categories="categories" :subcategories="subcategories" :currency="currency" @close="showModal=false" @save="saveProduct" />
<ProductResourcesModal v-if="resourceProduct && Store.can('inventoryWrite')" :product="resourceProduct" :currency="currency" @close="resourceProduct=null" />
<Modal v-if="deleting && Store.can('inventoryWrite')" title="Delete product?" :busy="saving" @close="deleting=null"><p>Delete {{ deleting.name }} from inventory? Saved receipts will keep their original item details.</p><template #actions><button class="ed-btn" :disabled="saving" @click="deleting=null">Cancel</button><button class="ed-btn danger" :disabled="saving" @click="deleteProduct">{{ saving?'Deleting…':'Delete product' }}</button></template></Modal>
<Modal v-if="importOpen && Store.can('inventoryWrite')" title="Import SKU CSV" wide :busy="importBusy" @close="importOpen=false">
  <p class="ed-muted">Create new products from the template. Category and subcategory build the catalog hierarchy. Older files that use “Menu section: …” in description are recognized automatically. Use one row per variant and repeat its parent SKU and product details. Existing SKUs are rejected to protect current stock. Up to 300 products / 1,000 rows per file.</p>
  <label class="ed-field" style="margin-top:20px"><span>CSV file (UTF-8, max 2 MB)</span><input type="file" accept=".csv,text/csv" :disabled="importBusy" @change="readCsv"></label>
  <p v-if="importError" class="ed-alert" role="alert">{{ importError }}</p>
  <template v-if="importRows.length"><div class="ed-notice">{{ importName }} · {{ importRows.length }} new products ready to import.</div><div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>SKU</th><th>Name</th><th>Classification</th><th>Options</th><th>Price / Stock</th></tr></thead><tbody><tr v-for="p in importRows" :key="p.sku"><td>{{ p.sku }}</td><td>{{ p.name }}</td><td>{{ categoryPath(p).join(' / ') }}</td><td>{{ p.variants.length||'Standard' }}</td><td><div v-for="(v,i) in p.variants.length?p.variants:[p]" :key="i">{{ v.name }} · {{ currency }} {{ v.price }} / {{ p.trackStock?v.stock:'Not tracked' }}</div></td></tr></tbody></table></div></template>
  <template #actions><button class="ed-btn" :disabled="importBusy" @click="importOpen=false">Cancel</button><button class="ed-btn primary" :disabled="importBusy||!importRows.length" @click="commitImport">{{ importBusy?'Importing…':`Import ${importRows.length} products` }}</button></template>
</Modal>
<Modal v-if="adjustment" title="Record inventory transaction" :busy="adjustBusy" @close="adjustment=null"><form id="stock-adjustment-form" class="ed-form-grid" @submit.prevent="saveAdjustment"><label class="ed-field wide"><span>Product *</span><select v-model="adjustment.productId" required @change="adjustment.variantId=''"><option value="" disabled>Select product</option><option v-for="product in products.filter(p=>p.trackStock)" :key="product.id" :value="product.id">{{ product.name }}</option></select></label><label v-if="products.find(p=>p.id===adjustment.productId)?.variants?.length" class="ed-field wide"><span>Variant *</span><select v-model="adjustment.variantId" required><option value="" disabled>Select variant</option><option v-for="variant in products.find(p=>p.id===adjustment.productId)?.variants||[]" :key="variant.id" :value="variant.id">{{ variant.name }} · stock {{ variant.stock }}</option></select></label><label class="ed-field"><span>Quantity change *</span><input v-model.number="adjustment.quantity" type="number" step="0.001" required><small>Use a positive number for stock received and a negative number for stock used or corrected.</small></label><label class="ed-field wide"><span>Reason *</span><input v-model="adjustment.reason" minlength="3" maxlength="500" required placeholder="Delivery received, damaged stock…"></label></form><p v-if="adjustError" class="ed-alert">{{ adjustError }}</p><template #actions><button class="ed-btn" :disabled="adjustBusy" @click="adjustment=null">Cancel</button><button class="ed-btn primary" form="stock-adjustment-form" type="submit" :disabled="adjustBusy">Record transaction</button></template></Modal>
</div></template>
