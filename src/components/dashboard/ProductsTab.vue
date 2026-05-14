<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';
import ProductList from './products/ProductList.vue';
import ProductEditorModal from './products/ProductEditorModal.vue';

const products = computed(() => Store.state.products);
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

    if (productData.id) await Store.inventoryModule.updateProduct(Store, productData);
    else await Store.addProduct(productData);
    
    showModal.value = false;
}

function deleteProduct(id) {
    if(confirm("Delete this product?")) Store.deleteProduct(id);
}
</script>

<template>
    <div class="h-full flex flex-col">
        <div class="flex justify-between items-center mb-6">
            <div>
                <h2 class="text-2xl font-bold text-slate-800 dark:text-white">Product Catalog</h2>
                <p class="text-sm text-gray-500">Manage inventory, services, and variants.</p>
            </div>
            <button @click="openModal()" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-bold shadow transition flex items-center gap-2">
                <i class="fas fa-plus"></i> Add Item
            </button>
        </div>

        <ProductList 
            :products="products" 
            :currency="currency" 
            @edit="openModal" 
            @delete="deleteProduct" 
        />

        <ProductEditorModal 
            :show="showModal"
            :product="editingProduct"
            :categories="categories"
            :currency="currency"
            @close="showModal = false"
            @save="saveProduct"
        />
    </div>
</template>