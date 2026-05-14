<script setup>
import { ref, watch } from 'vue';
import { useProductLogic } from '../../../composables/useProductLogic';

const props = defineProps({
    show: Boolean,
    product: Object,
    categories: Array,
    currency: String
});

const emit = defineEmits(['close', 'save']);
const { generateSKU } = useProductLogic();

const form = ref({ 
    id: null, name: '', category: 'Retail', unit: 'pcs', description: '', sku: '',
    trackStock: true, price: 0, cost: 0, stock: 0, hasVariants: false, variants: [] 
});
const newVar = ref({ name: '', price: 0, cost: 0, stock: 0 });

// Handle Modal Open & Data Population
watch(() => props.show, (isVisible) => {
    if (isVisible) {
        if (props.product) {
            form.value = JSON.parse(JSON.stringify(props.product));
            if(!form.value.variants) form.value.variants = [];
            form.value.hasVariants = form.value.variants.length > 0;
            if(form.value.trackStock === undefined) form.value.trackStock = form.value.category !== 'Service';
            if(!form.value.unit) form.value.unit = 'pcs';
        } else {
            form.value = { 
                id: null, name: '', category: 'Retail', unit: 'pcs', description: '', sku: '', 
                trackStock: true, price: 0, cost: 0, stock: 0, hasVariants: false, variants: [] 
            };
            form.value.sku = generateSKU(form.value.category);
        }
    }
});

// Auto-Update SKU & Settings when Category Changes
watch(() => form.value.category, (newCat) => {
    if (newCat === 'Service') {
        form.value.trackStock = false;
        form.value.unit = 'hr'; 
    } else {
        form.value.trackStock = true;
        if(form.value.unit === 'hr') form.value.unit = 'pcs';
    }
    if (!form.value.id) {
        form.value.sku = generateSKU(newCat);
    }
});

function handleGenerateSKU() {
    form.value.sku = generateSKU(form.value.category);
}

function addVariant() {
    if(!newVar.value.name) return;
    form.value.variants.push({ ...newVar.value });
    newVar.value = { name: '', price: 0, cost: 0, stock: 0 }; 
}

function removeVariant(index) {
    form.value.variants.splice(index, 1);
}

function triggerSave() {
    emit('save', form.value);
}
</script>

<template>
    <div v-if="show" class="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 backdrop-blur-sm">
        <div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-2xl p-6 border dark:border-slate-700 max-h-[90vh] overflow-y-auto animate-fade-in">
            
            <div class="flex justify-between items-center mb-6">
                <h3 class="font-bold text-xl text-slate-800 dark:text-white">{{ form.id ? 'Edit Item' : 'New Item' }}</h3>
                <button @click="$emit('close')" class="text-gray-400 hover:text-red-500"><i class="fas fa-times"></i></button>
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
                            <button @click="handleGenerateSKU" class="bg-gray-200 dark:bg-slate-600 px-3 rounded-r hover:bg-gray-300 transition" title="Auto Generate">
                                <i class="fas fa-magic text-gray-600 dark:text-gray-300"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <div class="grid grid-cols-3 gap-4">
                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Category</label>
                        <select v-model="form.category" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none">
                            <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
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
                <button @click="$emit('close')" class="px-4 py-2 text-gray-500 font-bold hover:bg-gray-100 dark:hover:bg-slate-700 rounded transition">Cancel</button>
                <button @click="triggerSave" class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded font-bold shadow-lg transition">Save Item</button>
            </div>
        </div>
    </div>
</template>