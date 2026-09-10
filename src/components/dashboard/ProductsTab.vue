<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';
import ProductList from './products/ProductList.vue';
import ProductEditorModal from './products/ProductEditorModal.vue';

const search=ref('');
const saving=ref(false);
const products = computed(() => Store.state.products.filter(p => [p.name,p.sku,p.code].join(' ').toLowerCase().includes(search.value.toLowerCase())));
const currency = computed(() => Store.state.selectedCompany?.preferences?.currency || 'RM');
const showModal = ref(false);
const editingProduct = ref(null);
const categories = ['Food', 'Beverage', 'Retail', 'Service', 'Other'];

function openModal(prod = null) {
    editingProduct.value = prod;
    showModal.value = true;
}

async function saveProduct(productData) {
    if (!productData.name) return Store.notify("Name required", "error");

    if (productData.category === 'Service') {
        productData.trackStock = false;
        productData.stock = 0; 
        if(productData.hasVariants) productData.variants.forEach(v => v.stock = 0);
    }

    if (productData.hasVariants && productData.variants.length === 0) {
        return Store.notify("Please add at least one variant", "error");
    }

    const rows = productData.hasVariants ? productData.variants : [productData];
    if (rows.some(row => ['price', 'cost', 'stock'].some(key => !Number.isFinite(Number(row[key] ?? 0)) || Number(row[key] ?? 0) < 0))) return Store.notify('Enter valid prices, costs and stock of zero or more.', 'error');
    if (productData.hasVariants && rows.some(row => !row.name?.trim())) return Store.notify('Give each variant a name.', 'error');

    saving.value = true;
    try {
    if (productData.id) await Store.inventoryModule.updateProduct(Store, productData);
    else await Store.addProduct(productData);
    
    showModal.value = false;
    } catch(e) { Store.notify(e.message, "error"); } finally { saving.value = false; }
}

function deleteProduct(id) {
    if(confirm("Delete this product?")) Store.deleteProduct(id);
}
</script>

<template>
    <div class="h-full flex flex-col">
        <div class="flex flex-wrap gap-4 justify-between items-center mb-6">
            <div>
                <h2 class="text-2xl font-bold text-slate-800 dark:text-white">A place for every product.</h2>
                <p class="text-sm text-gray-500">Your products, services and stock, in one clear view.</p>
            </div>
            <button @click="openModal()" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-bold shadow transition flex items-center gap-2">
                <LegacyIcon class="fas fa-plus" /> Add product
            </button>
        </div>

        <div class="ed-filters"><div class="ed-search"><input v-model="search" class="ed-input" style="padding-left:12px" aria-label="Search inventory" placeholder="Search by product name or SKU"></div><span class="ed-muted" style="font-size:12px">{{ products.length }} products</span></div>
        <ProductList 
            :products="products" 
            :currency="currency" 
            @edit="openModal" 
            @delete="deleteProduct" 
        />

        <ProductEditorModal 
            :show="showModal"
            :busy="saving"
            :product="editingProduct"
            :categories="categories"
            :currency="currency"
            @close="showModal = false"
            @save="saveProduct"
        />
    </div>
</template>
