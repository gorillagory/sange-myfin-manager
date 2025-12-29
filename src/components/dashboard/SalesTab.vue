<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';
import { usePdfGenerator } from '../../composables/usePdfGenerator'; 

// --- COMPONENTS ---
import SmartButton from '../ui/SmartButton.vue';
import TemplateClean from './docdesign/TemplateClean.vue';
import TemplateModern from './docdesign/TemplateModern.vue';
import TemplateCorporate from './docdesign/TemplateCorporate.vue';

// --- STATE ---
const { generatePdf } = usePdfGenerator();
const view = ref('list');
const filterType = ref('all');
const txForm = ref({});
const isGeneratingPdf = ref(false);

// --- STORE DATA ---
const activeCompany = computed(() => Store.state.selectedCompany || {});
const clients = computed(() => Store.state.clients.filter(c => c.company_id === activeCompany.value.id));
const products = computed(() => (Store.state.products || []).filter(p => p.company_id === activeCompany.value.id));
const currentUser = computed(() => Store.state.currentUser);

// --- PERMISSIONS ---
const canDelete = computed(() => {
    return ['super', 'company_admin'].includes(currentUser.value?.role);
});

// --- PREFERENCES ---
const companyPrefs = computed(() => ({
    baseTheme: 'clean', 
    primaryColor: '#10b981', 
    fontFamily: 'sans', 
    currency: 'RM',
    labels: { invoice: 'INVOICE', quote: 'QUOTE', billTo: 'Bill To', total: 'Total' }, 
    showLogo: true,
    ...(activeCompany.value.preferences || {})
}));

const fontStyle = computed(() => companyPrefs.value.fontFamily === 'serif' ? 'font-serif' : 'font-sans');

// --- CALCULATIONS ---
const calculations = computed(() => {
    if (!txForm.value.items) return { subtotal: '0.00', discount: '0.00', tax: '0.00', grandTotal: '0.00' };
    
    const sub = txForm.value.items.reduce((s, i) => s + (i.qty * i.price), 0);
    const disc = sub * ((txForm.value.discount || 0) / 100);
    const taxable = sub - disc;
    const tax = taxable * ((txForm.value.taxRate || 0) / 100);
    
    return {
        subtotal: sub.toLocaleString('en-US', {minimumFractionDigits: 2}),
        discount: disc.toLocaleString('en-US', {minimumFractionDigits: 2}),
        tax: tax.toLocaleString('en-US', {minimumFractionDigits: 2}),
        grandTotal: (taxable + tax).toLocaleString('en-US', {minimumFractionDigits: 2})
    };
});

const salesData = computed(() => {
    let data = Store.state.transactions
        .filter(t => t.company_id === activeCompany.value.id && ['Invoice', 'Quote'].includes(t.type))
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    
    return filterType.value === 'all' ? data : data.filter(t => t.type.toLowerCase() === filterType.value);
});

// --- UTILS ---
const getClientName = (id) => clients.value.find(x => x.id === id)?.name || 'Unknown';

const timeAgo = (d) => {
    if (!d) return '';
    const diff = Math.floor((new Date() - new Date(d)) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
    return `${Math.floor(diff/86400)}d ago`;
};

const formatExactDate = (d) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });

// --- ACTIONS ---
function addToHistory(action) {
    if (!txForm.value.history) txForm.value.history = [];
    txForm.value.history.unshift({
        date: new Date().toISOString(),
        action,
        user: currentUser.value?.username || 'User'
    });
}

function openEditor(tx = null) {
    if (tx) {
        txForm.value = JSON.parse(JSON.stringify(tx));
    } else {
        txForm.value = { 
            id: null, company_id: activeCompany.value.id, client_id: '', type: 'Quote', 
            number: 'QT-' + Date.now().toString().slice(-6), date: new Date().toISOString().split('T')[0], 
            status: 'Pending', items: [{ desc: 'Service', unit: 'Unit', qty: 1, price: 0 }], 
            taxRate: 0, discount: 0, notes: '', history: [] 
        };
    }
    view.value = 'editor';
}

function saveTx() {
    if (!txForm.value.client_id && txForm.value.type !== 'Invoice') return Store.notify("Client Required", "error");
    
    // Quick Calc for DB
    const sub = txForm.value.items.reduce((s, i) => s + (i.qty * i.price), 0);
    const total = (sub * (1 - (txForm.value.discount||0)/100)) * (1 + (txForm.value.taxRate||0)/100);
    txForm.value.total = total;

    const isNew = !txForm.value.id;
    addToHistory(isNew ? 'Document Created' : 'Document Updated');
    
    if (isNew) {
        txForm.value.id = Date.now().toString();
        Store.addTransaction(JSON.parse(JSON.stringify(txForm.value)));
    } else {
        Store.updateTransaction(JSON.parse(JSON.stringify(txForm.value)));
    }
    Store.notify("Document Saved"); view.value = 'list';
}

// --- SMART ACTIONS ---

// FIXED: Correct Delete Logic
async function deleteTx(id) {
    try {
        await Store.deleteTransaction(id);
        // Changed "error" to "success" (default) so it shows Green
        Store.notify("Document Deleted Successfully"); 
    } catch (e) {
        // Now this will only show if the actual DB delete failed
        Store.notify("Delete Failed: " + e.message, "error");
    }
}

function markCleared(t) {
    const copy = { ...t, status: 'Cleared' };
    if (!copy.history) copy.history = [];
    copy.history.unshift({ date: new Date().toISOString(), action: 'Marked Paid', user: currentUser.value?.username });
    Store.updateTransaction(copy);
    Store.notify("Marked as Paid");
}

function convertQuote(t) {
    Store.updateTransaction({ ...t, status: 'Converted' }); // Close Quote
    
    const newInv = {
        ...JSON.parse(JSON.stringify(t)),
        id: Date.now().toString(),
        type: 'Invoice',
        number: 'INV-' + Date.now().toString().slice(-5),
        status: 'Pending',
        date: new Date().toISOString().split('T')[0],
        notes: `Converted from Quote ${t.number}. ` + (t.notes || ''),
        history: [{ date: new Date().toISOString(), action: `Generated from Quote ${t.number}`, user: currentUser.value?.username }]
    };
    Store.addTransaction(newInv);
    Store.notify("Quote Converted to Invoice");
}

function downloadPDF(t) {
    if (!txForm.value.id || txForm.value.id !== t.id) txForm.value = JSON.parse(JSON.stringify(t));
    view.value = 'editor';
    addToHistory('PDF Generated');
    Store.updateTransaction(JSON.parse(JSON.stringify(txForm.value)));
    isGeneratingPdf.value = true;
    
    generatePdf(t, 'invoice-print-area', `${t.number}.pdf`, () => {
        isGeneratingPdf.value = false;
        Store.notify("PDF Downloaded");
    });
}
</script>

<template>
    <div>
        <div v-if="view === 'list'" class="no-print">
            <div class="flex justify-between items-center mb-6">
                <div class="flex items-center gap-4">
                    <h2 class="text-2xl font-bold text-slate-800 dark:text-white">Sales & Invoices</h2>
                    <select v-model="filterType" class="bg-white dark:bg-slate-700 border rounded-lg px-3 py-1 text-sm dark:text-white outline-none">
                        <option value="all">Show All</option>
                        <option value="invoice">Invoices</option>
                        <option value="quote">Quotes</option>
                    </select>
                </div>
                <button @click="openEditor()" class="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded flex items-center gap-2 font-bold shadow transition">
                    <i class="fas fa-plus"></i> Create New
                </button>
            </div>
            
            <div class="bg-white dark:bg-slate-800 shadow rounded-lg overflow-hidden border dark:border-slate-700">
                <table class="w-full text-sm text-left text-gray-600 dark:text-gray-300">
                    <thead class="bg-gray-50 dark:bg-slate-700 uppercase text-xs font-bold text-gray-500 dark:text-gray-200">
                        <tr>
                            <th class="p-4">Date / No.</th>
                            <th class="p-4">Client</th>
                            <th class="p-4">Total</th>
                            <th class="p-4 text-center">Status</th>
                            <th class="p-4 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="t in salesData" :key="t.id" class="border-b dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700 transition">
                            <td class="p-4">
                                <div class="font-bold text-slate-700 dark:text-white">{{ t.number }}</div>
                                <div class="text-[10px] text-gray-400">{{ t.date }}</div>
                            </td>
                            <td class="p-4 font-bold">{{ getClientName(t.client_id) }}</td>
                            <td class="p-4 font-mono text-slate-700 dark:text-gray-200">
                                {{ companyPrefs.currency }} {{ Number(t.total).toLocaleString('en-US', {minimumFractionDigits: 2}) }}
                            </td>
                            <td class="p-4 text-center">
                                <span class="px-3 py-1 rounded-full text-xs font-bold uppercase"
                                    :class="t.status === 'Cleared' ? 'bg-emerald-100 text-emerald-700' : (t.status === 'Converted' ? 'bg-purple-100 text-purple-700' : 'bg-yellow-100 text-yellow-700')">
                                    {{ t.status }}
                                </span>
                            </td>
                            <td class="p-4 text-right whitespace-nowrap flex justify-end items-center gap-3">
                                
                                <SmartButton v-if="t.type === 'Invoice' && t.status !== 'Cleared'" 
                                    icon="fas fa-check-circle" 
                                    color="text-emerald-500 hover:text-emerald-700" 
                                    confirmLabel="Paid?"
                                    @confirmed="markCleared(t)" />

                                <SmartButton v-if="t.type === 'Quote' && t.status !== 'Converted'" 
                                    icon="fas fa-magic" 
                                    color="text-purple-500 hover:text-purple-700" 
                                    confirmLabel="Convert?"
                                    @confirmed="convertQuote(t)" />
                                
                                <button @click="downloadPDF(t)" class="text-gray-400 hover:text-gray-600"><i class="fas fa-file-pdf"></i></button>
                                <button @click="openEditor(t)" class="text-blue-500 hover:text-blue-700"><i class="fas fa-edit"></i></button>
                                
                                <SmartButton 
                                    v-if="canDelete"
                                    icon="fas fa-trash" 
                                    color="text-red-300 hover:text-red-500" 
                                    confirmLabel="Delete?"
                                    @confirmed="deleteTx(t.id)" />
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div v-else class="flex flex-col lg:flex-row gap-6 max-w-7xl mx-auto">
            <div class="flex-grow bg-white shadow-2xl rounded-lg overflow-hidden flex flex-col">
                 <div class="bg-slate-100 dark:bg-slate-800 px-6 py-3 border-b dark:border-slate-700 flex justify-between items-center no-print">
                    <button @click="view = 'list'" class="text-gray-600 dark:text-gray-300 hover:text-black font-medium transition"><i class="fas fa-arrow-left mr-2"></i>Back</button>
                    <div class="flex gap-2">
                         <button @click="saveTx" class="bg-emerald-600 text-white px-4 py-2 rounded shadow hover:bg-emerald-700 font-bold transition">
                            <i class="fas fa-save mr-2"></i> Save
                        </button>
                    </div>
                </div>

                <div id="invoice-print-area" class="p-12 text-gray-800 bg-white min-h-[1100px] flex flex-col" :class="[fontStyle, isGeneratingPdf ? 'pdf-mode' : '']">
                    <component 
                        :is="companyPrefs.baseTheme === 'modern' ? TemplateModern : (companyPrefs.baseTheme === 'corporate' ? TemplateCorporate : TemplateClean)"
                        :form="txForm" :company="activeCompany" :prefs="companyPrefs" :clients="clients" :products="products" 
                        :isPdf="isGeneratingPdf" :calculations="calculations"
                        @addItem="() => txForm.items.push({ desc: '', unit: 'Unit', qty: 1, price: 0 })"
                        @removeItem="(i) => txForm.items.splice(i, 1)"
                    />
                </div>
            </div>

            <div class="w-full lg:w-80 flex-shrink-0 no-print space-y-4">
                <div class="bg-white dark:bg-slate-800 rounded-lg shadow-lg border dark:border-slate-700 overflow-hidden sticky top-4">
                    <div class="bg-slate-100 dark:bg-slate-900 px-4 py-3 border-b dark:border-slate-700 font-bold text-slate-700 dark:text-gray-300 flex items-center gap-2">
                        <i class="fas fa-history text-blue-500"></i> Process Timeline
                    </div>
                    <div class="p-4 max-h-[500px] overflow-y-auto">
                        <div v-if="txForm.history?.length > 0" class="relative pl-4 border-l-2 border-gray-200 dark:border-slate-700 space-y-6">
                            <div v-for="(h, i) in txForm.history" :key="i" class="relative group">
                                <div class="absolute -left-[21px] top-1 h-3 w-3 rounded-full border-2 border-white dark:border-slate-800 shadow-sm" 
                                     :class="(h.action||'').includes('Created') ? 'bg-emerald-500' : 'bg-blue-400'"></div>
                                <div>
                                    <div class="flex justify-between items-center mb-1">
                                        <span class="text-xs font-bold text-slate-600 dark:text-gray-300">{{ timeAgo(h.date) }}</span>
                                        <span class="text-[10px] text-gray-400 font-mono">{{ formatExactDate(h.date) }}</span>
                                    </div>
                                    <div class="text-sm font-bold text-slate-800 dark:text-gray-200 leading-tight">{{ h.action }}</div>
                                    <div class="text-xs text-gray-500 italic mt-1"><i class="fas fa-user-circle"></i> {{ h.user }}</div>
                                </div>
                            </div>
                        </div>
                        <div v-else class="text-center text-gray-400 text-sm py-8 italic">No history yet.</div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style>
.pdf-mode { padding: 0px !important; background: white !important; min-height: 0px !important; height: auto !important; }
.pdf-mode input, .pdf-mode select, .pdf-mode textarea { border: none !important; background: transparent !important; resize: none; padding: 0; }
</style>