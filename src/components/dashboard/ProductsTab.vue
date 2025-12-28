<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';

const activeCompany = computed(() => Store.state.selectedCompany || {});
const products = computed(() => (Store.state.products || []).filter(p => p.company_id === activeCompany.value.id));
// Add this line inside <script setup>
const companyPrefs = computed(() => ({ currency: 'RM', ...(activeCompany.value.preferences || {}) }));

// --- SMART TYPES ---
// Scans existing products to suggest types (e.g. "Service", "Hardware")
const existingTypes = computed(() => {
    const types = new Set(products.value.map(p => p.type).filter(t => t));
    return Array.from(types).sort();
});

const showModal = ref(false);
const form = ref({});
const isEditing = computed(() => !!form.value.id);

// --- ACTIONS ---
function openModal(prod = null) {
    if (prod) {
        form.value = JSON.parse(JSON.stringify(prod));
    } else {
        form.value = { 
            id: null, 
            company_id: activeCompany.value.id, 
            code: '', 
            name: '', 
            type: '', 
            price: '', 
            unit: 'Unit', 
            desc: '' 
        };
    }
    showModal.value = true;
}

// --- SKU GENERATOR (THE MAGIC WAND) ---
function autoGenCode() {
    // 1. Check prerequisites
    if (!form.value.type || !form.value.name) {
        return Store.notify("Please enter a Name and Type first", "error");
    }

    // 2. Extract Prefixes (Remove spaces/symbols, take first 3 chars)
    const t = form.value.type.replace(/[^a-zA-Z0-9]/g, '').substring(0, 3).toUpperCase();
    const n = form.value.name.replace(/[^a-zA-Z0-9]/g, '').substring(0, 3).toUpperCase();
    
    // 3. Add Uniqueness (4-digit random number to prevent collisions)
    // This makes it safe for Barcodes/QR later
    const unique = Math.floor(1000 + Math.random() * 9000);

    // 4. Set Code
    form.value.code = `${t}-${n}-${unique}`;
}

function save() {
    if (!form.value.name || !form.value.price) return Store.notify("Name and Price required", "error");
    Store.addProduct(JSON.parse(JSON.stringify(form.value)));
    showModal.value = false;
    Store.notify("Product Saved");
}

function remove(id) {
    if (confirm("Delete this product?")) Store.deleteProduct(id);
}
</script>

<template>
    <div class="max-w-6xl mx-auto no-print">
        <div class="flex justify-between items-center mb-6">
            <h2 class="text-2xl font-bold text-slate-800 dark:text-white">Products & Services</h2>
            <button @click="openModal()" class="bg-emerald-600 text-white px-4 py-2 rounded shadow flex items-center gap-2 hover:bg-emerald-700 transition">
                <i class="fas fa-plus"></i> Add Item
            </button>
        </div>

        <div class="bg-white dark:bg-slate-800 shadow rounded-lg overflow-hidden border dark:border-slate-700">
            <table class="w-full text-sm text-left text-gray-600 dark:text-gray-300">
                <thead class="bg-gray-50 dark:bg-slate-700 uppercase text-xs font-bold">
                    <tr>
                        <th class="p-4">SKU / Code</th>
                        <th class="p-4">Name</th>
                        <th class="p-4">Type</th>
                        <th class="p-4 text-center">Unit</th>
                        <th class="p-4 text-right">Price</th>
                        <th class="p-4 text-right">Action</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="p in products" :key="p.id" class="border-b dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700">
                        <td class="p-4 font-mono text-xs font-bold text-slate-500">{{ p.code || '-' }}</td>
                        <td class="p-4 font-bold">{{ p.name }}<div class="text-xs font-normal text-gray-400">{{ p.desc }}</div></td>
                        <td class="p-4">
                            <span v-if="p.type" class="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 px-2 py-1 rounded text-xs font-bold uppercase">{{ p.type }}</span>
                            <span v-else class="text-gray-400 text-xs italic">-</span>
                        </td>
                        <td class="p-4 text-center"><span class="bg-gray-100 dark:bg-slate-600 px-2 py-1 rounded text-xs">{{ p.unit }}</span></td>
                        <td class="p-4 text-right font-bold text-emerald-600">
                            {{ companyPrefs.currency }} {{ Number(p.price).toFixed(2) }}
                        </td>
                        <td class="p-4 text-right">
                            <button @click="openModal(p)" class="text-blue-500 hover:text-blue-700 mr-3"><i class="fas fa-edit"></i></button>
                            <button @click="remove(p.id)" class="text-red-400 hover:text-red-600"><i class="fas fa-trash"></i></button>
                        </td>
                    </tr>
                    <tr v-if="products.length === 0"><td colspan="6" class="p-8 text-center text-gray-400 italic">No products added yet.</td></tr>
                </tbody>
            </table>
        </div>

        <div v-if="showModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999] backdrop-blur-sm p-4">
            <div class="bg-white dark:bg-slate-800 w-full max-w-md rounded-xl shadow-2xl border dark:border-slate-600 p-6 transition-all transform scale-100">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="font-bold text-xl dark:text-white">{{ isEditing ? 'Edit' : 'New' }} Product</h3>
                    <button @click="showModal = false" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times"></i></button>
                </div>
                
                <div class="space-y-4">
                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Product Name</label>
                        <input v-model="form.name" class="w-full border dark:border-slate-600 p-2 rounded dark:bg-slate-700 dark:text-white focus:ring-2 focus:ring-emerald-500 outline-none" placeholder="e.g. Wireless Mouse">
                    </div>

                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Type / Category</label>
                        <input v-model="form.type" list="typeOptions" class="w-full border dark:border-slate-600 p-2 rounded dark:bg-slate-700 dark:text-white focus:ring-2 focus:ring-emerald-500 outline-none" placeholder="e.g. Hardware, Service">
                        <datalist id="typeOptions">
                            <option v-for="t in existingTypes" :key="t" :value="t"></option>
                        </datalist>
                    </div>

                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">SKU / Code</label>
                        <div class="flex">
                            <input v-model="form.code" class="w-full border-y border-l dark:border-slate-600 p-2 rounded-l dark:bg-slate-700 dark:text-white font-mono focus:ring-2 focus:ring-emerald-500 outline-none" placeholder="HRD-MOU-8821">
                            <button @click="autoGenCode" class="bg-gray-100 dark:bg-slate-600 border border-l-0 dark:border-slate-500 px-3 rounded-r text-gray-600 dark:text-gray-300 hover:bg-emerald-500 hover:text-white transition" title="Auto Generate SKU">
                                <i class="fas fa-magic"></i>
                            </button>
                        </div>
                        <div class="text-[10px] text-gray-400 mt-1 italic">Click the wand to auto-generate based on Name & Type</div>
                    </div>

                    <div class="flex gap-3">
                        <div class="w-1/2">
                            <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Price</label>
                            <input v-model="form.price" type="number" class="w-full border dark:border-slate-600 p-2 rounded dark:bg-slate-700 dark:text-white font-bold" placeholder="0.00">
                        </div>
                        <div class="w-1/2">
                            <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Unit</label>
                            <input v-model="form.unit" class="w-full border dark:border-slate-600 p-2 rounded dark:bg-slate-700 dark:text-white" placeholder="Unit, Hour">
                        </div>
                    </div>

                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Description (Optional)</label>
                        <textarea v-model="form.desc" rows="2" class="w-full border dark:border-slate-600 p-2 rounded dark:bg-slate-700 dark:text-white resize-none" placeholder="Details for invoice..."></textarea>
                    </div>
                </div>

                <div class="flex justify-end gap-2 mt-6 pt-4 border-t dark:border-slate-700">
                    <button @click="showModal = false" class="px-4 py-2 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700 transition">Cancel</button>
                    <button @click="save" class="bg-emerald-600 text-white px-6 py-2 rounded font-bold hover:bg-emerald-700 transition shadow-lg transform hover:-translate-y-0.5">Save Item</button>
                </div>
            </div>
        </div>
    </div>
</template>