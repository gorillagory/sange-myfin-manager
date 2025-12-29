<script setup>
import { ref, computed, watch } from 'vue';
import { Store } from '../../store';

const products = computed(() => Store.state.products);
const currency = computed(() => Store.state.selectedCompany?.preferences?.currency || 'RM');

const showModal = ref(false);
const categories = ['Food', 'Beverage', 'Retail', 'Service', 'Other'];

// Form State
const form = ref({ 
    id: null, 
    name: '', 
    category: 'Retail', 
    unit: 'pcs',       
    description: '', 
    sku: '',
    trackStock: true,  
    price: 0, cost: 0, stock: 0,
    hasVariants: false, variants: [] 
});

const newVar = ref({ name: '', price: 0, cost: 0, stock: 0 });

// --- HELPERS ---
function generateSKU() {
    // SKU Format: CAT-RANDOM (e.g. FOO-8392)
    const prefix = form.value.category.substring(0, 3).toUpperCase();
    const rand = Math.floor(1000 + Math.random() * 9000);
    form.value.sku = `${prefix}-${rand}`;
}

// --- WATCHER: Auto-Update SKU & Settings when Category Changes ---
watch(() => form.value.category, (newCat) => {
    // 1. Logic for Service vs Retail
    if (newCat === 'Service') {
        form.value.trackStock = false;
        form.value.unit = 'hr'; 
    } else {
        form.value.trackStock = true;
        if(form.value.unit === 'hr') form.value.unit = 'pcs';
    }

    // 2. AUTO-GENERATE SKU
    // Only do this for NEW products so we don't break existing barcodes on edit
    if (!form.value.id) {
        generateSKU();
    }
});

function openModal(prod = null) {
    if (prod) {
        // Edit Mode
        form.value = JSON.parse(JSON.stringify(prod));
        if(!form.value.variants) form.value.variants = [];
        form.value.hasVariants = form.value.variants.length > 0;
        
        // Compatibility checks
        if(form.value.trackStock === undefined) form.value.trackStock = form.value.category !== 'Service';
        if(!form.value.unit) form.value.unit = 'pcs';
        
    } else {
        // Create Mode
        form.value = { 
            id: null, 
            name: '', 
            category: 'Retail', 
            unit: 'pcs',
            description: '', 
            sku: '', 
            trackStock: true,
            price: 0, cost: 0, stock: 0, 
            hasVariants: false, variants: [] 
        };
        generateSKU(); // Generate initial SKU
    }
    showModal.value = true;
}

function addVariant() {
    if(!newVar.value.name) return;
    form.value.variants.push({ ...newVar.value });
    newVar.value = { name: '', price: 0, cost: 0, stock: 0 }; 
}

function removeVariant(index) {
    form.value.variants.splice(index, 1);
}

async function saveProduct() {
    if (!form.value.name) return Store.notify("Name required", "error");
    
    // Force stock logic for Services
    if (form.value.category === 'Service') {
        form.value.trackStock = false;
        form.value.stock = 0; 
        if(form.value.hasVariants) form.value.variants.forEach(v => v.stock = 0);
    }

    if (form.value.hasVariants && form.value.variants.length === 0) {
        return Store.notify("Please add at least one variant", "error");
    }

    if (form.value.id) await Store.inventoryModule.updateProduct(Store, form.value);
    else await Store.addProduct(form.value);
    
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

        <div class="bg-white dark:bg-slate-800 rounded-xl shadow border dark:border-slate-700 overflow-hidden flex-grow flex flex-col">
            <div class="overflow-y-auto flex-grow">
                <table class="w-full text-left border-collapse">
                    <thead class="bg-gray-50 dark:bg-slate-900 sticky top-0 z-10 text-xs font-bold text-gray-500 uppercase">
                        <tr>
                            <th class="p-4">Item Name</th>
                            <th class="p-4">Category</th>
                            <th class="p-4 text-right">Stock</th>
                            <th class="p-4 text-right">Price</th>
                            <th class="p-4 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody class="text-sm">
                        <tr v-for="p in products" :key="p.id" class="border-b dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50">
                            <td class="p-4 font-bold text-slate-800 dark:text-white">
                                <div>{{ p.name }}</div>
                                <div class="text-[10px] text-gray-400 font-mono">{{ p.sku }}</div>
                            </td>
                            <td class="p-4">
                                <span class="px-2 py-1 rounded text-[10px] font-bold uppercase bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-300">
                                    {{ p.category }}
                                </span>
                            </td>
                            
                            <td class="p-4 text-right font-mono">
                                <span v-if="!p.trackStock && p.category === 'Service'" class="text-blue-500 text-xs font-bold">N/A (Service)</span>
                                <span v-else-if="p.variants?.length" class="text-gray-400 text-xs italic">See Variants</span>
                                <span v-else :class="p.stock <= 5 ? 'text-red-500 font-bold' : 'text-emerald-600'">
                                    {{ p.stock }} {{ p.unit || 'pcs' }}
                                </span>
                            </td>

                            <td class="p-4 text-right font-bold text-slate-700 dark:text-gray-300">
                                <span v-if="p.variants?.length">{{ currency }} {{ Math.min(...p.variants.map(v=>v.price)) }} - {{ Math.max(...p.variants.map(v=>v.price)) }}</span>
                                <span v-else>{{ currency }} {{ p.price }}</span>
                            </td>

                            <td class="p-4 text-right space-x-3">
                                <button @click="openModal(p)" class="text-blue-500 hover:text-blue-700"><i class="fas fa-edit"></i></button>
                                <button @click="deleteProduct(p.id)" class="text-red-400 hover:text-red-600"><i class="fas fa-trash"></i></button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div v-if="showModal" class="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 backdrop-blur-sm">
            <div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-2xl p-6 border dark:border-slate-700 max-h-[90vh] overflow-y-auto animate-fade-in">
                
                <div class="flex justify-between items-center mb-6">
                    <h3 class="font-bold text-xl text-slate-800 dark:text-white">{{ form.id ? 'Edit Item' : 'New Item' }}</h3>
                    <button @click="showModal = false" class="text-gray-400 hover:text-red-500"><i class="fas fa-times"></i></button>
                </div>

                <div class="space-y-4">
                    <div class="grid grid-cols-3 gap-4">
                        <div class="col-span-2">
                            <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Item Name</label>
                            <input v-model="form.name" placeholder="e.g. Latte" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none focus:ring-2 focus:ring-blue-500">
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-gray-500 uppercase mb-1">SKU</label>
                            <div class="flex">
                                <input v-model="form.sku" class="w-full border p-2 rounded-l dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none font-mono text-sm uppercase">
                                <button @click="generateSKU" class="bg-gray-200 dark:bg-slate-600 px-3 rounded-r hover:bg-gray-300 transition" title="Auto Generate">
                                    <i class="fas fa-magic text-gray-600 dark:text-gray-300"></i>
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="grid grid-cols-3 gap-4">
                        <div>
                            <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Category</label>
                            <select v-model="form.category" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none">
                                <option v-for="c in categories" :value="c">{{ c }}</option>
                            </select>
                        </div>
                         <div>
                            <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Unit</label>
                            <input v-model="form.unit" placeholder="pcs, kg, hr" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none">
                        </div>
                        <div class="flex items-end pb-2">
                            <label class="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" v-model="form.trackStock" :disabled="form.category === 'Service'" class="w-4 h-4 accent-emerald-500">
                                <span class="text-sm font-bold text-slate-700 dark:text-gray-300" :class="{'opacity-50': form.category === 'Service'}">Track Stock</span>
                            </label>
                        </div>
                    </div>

                    <div v-if="form.category === 'Service'" class="bg-blue-50 dark:bg-blue-900/20 p-3 rounded text-xs text-blue-600 dark:text-blue-300 flex items-center gap-2">
                        <i class="fas fa-info-circle"></i> Service items do not require stock tracking.
                    </div>

                    <div class="flex items-center gap-3 py-2 border-t border-b dark:border-slate-700">
                        <input type="checkbox" v-model="form.hasVariants" id="hasVariants" class="w-5 h-5 accent-blue-600">
                        <label for="hasVariants" class="font-bold text-sm text-slate-700 dark:text-white">This item has variants (Size, Color, etc.)</label>
                    </div>

                    <div v-if="!form.hasVariants" class="grid grid-cols-3 gap-4 bg-gray-50 dark:bg-slate-900 p-4 rounded-lg">
                        <div>
                            <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Selling Price</label>
                            <input v-model="form.price" type="number" step="0.01" class="w-full border p-2 rounded outline-none dark:bg-slate-700 dark:border-slate-600 dark:text-white">
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Cost Price</label>
                            <input v-model="form.cost" type="number" step="0.01" class="w-full border p-2 rounded outline-none dark:bg-slate-700 dark:border-slate-600 dark:text-white">
                        </div>
                        <div v-if="form.trackStock">
                            <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Current Stock</label>
                            <input v-model="form.stock" type="number" class="w-full border p-2 rounded outline-none dark:bg-slate-700 dark:border-slate-600 dark:text-white">
                        </div>
                    </div>

                    <div v-else class="space-y-3">
                        <div class="bg-gray-50 dark:bg-slate-900 p-4 rounded-lg border dark:border-slate-700">
                            <div class="grid grid-cols-4 gap-2 mb-2">
                                <input v-model="newVar.name" placeholder="Name (e.g. Large)" class="col-span-1 border p-2 rounded text-sm dark:bg-slate-700 dark:border-slate-600 dark:text-white">
                                <input v-model="newVar.price" type="number" placeholder="Price" class="col-span-1 border p-2 rounded text-sm dark:bg-slate-700 dark:border-slate-600 dark:text-white">
                                <input v-if="form.trackStock" v-model="newVar.stock" type="number" placeholder="Stock" class="col-span-1 border p-2 rounded text-sm dark:bg-slate-700 dark:border-slate-600 dark:text-white">
                                <div v-else class="col-span-1 flex items-center justify-center text-xs text-gray-400 font-bold bg-slate-200 dark:bg-slate-800 rounded">N/A</div>
                                
                                <button @click="addVariant" class="bg-emerald-600 text-white rounded font-bold text-xs hover:bg-emerald-700 transition">ADD</button>
                            </div>
                            
                            <div v-for="(v, idx) in form.variants" :key="idx" class="flex items-center justify-between bg-white dark:bg-slate-800 p-2 rounded border dark:border-slate-600 mb-1">
                                <span class="font-bold text-sm dark:text-white">{{ v.name }}</span>
                                <div class="flex gap-4 text-xs text-gray-500">
                                    <span>{{ currency }} {{ v.price }}</span>
                                    <span v-if="form.trackStock">Qty: {{ v.stock }}</span>
                                </div>
                                <button @click="removeVariant(idx)" class="text-red-400 hover:text-red-600"><i class="fas fa-times"></i></button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="mt-6 flex justify-end gap-3">
                    <button @click="showModal = false" class="px-4 py-2 text-gray-500 font-bold hover:bg-gray-100 dark:hover:bg-slate-700 rounded transition">Cancel</button>
                    <button @click="saveProduct" class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded font-bold shadow-lg transition">Save Item</button>
                </div>
            </div>
        </div>
    </div>
</template>