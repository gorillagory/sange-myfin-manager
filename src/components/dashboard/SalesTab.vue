<script setup>
import { ref, computed, nextTick, defineAsyncComponent } from 'vue';
import { Store } from '../../store';
import html2pdf from 'html2pdf.js';

// --- STATIC IMPORTS ---
import TemplateClean from './docdesign/TemplateClean.vue';
import TemplateModern from './docdesign/TemplateModern.vue';
import TemplateCorporate from './docdesign/TemplateCorporate.vue';

// --- STATE ---
const activeCompany = computed(() => Store.state.selectedCompany || {});
const clients = computed(() => Store.state.clients.filter(c => c.company_id === activeCompany.value.id));
const products = computed(() => (Store.state.products || []).filter(p => p.company_id === activeCompany.value.id));

const companyPrefs = computed(() => {
    const defaults = { 
        baseTheme: 'clean', 
        primaryColor: '#10b981', 
        fontFamily: 'sans', 
        currency: 'RM', // <--- NEW: Default Currency
        labels: { invoice: 'INVOICE', quote: 'QUOTE', billTo: 'Bill To', total: 'Total' }, 
        showLogo: true 
    };
    return { ...defaults, ...(activeCompany.value.preferences || {}) };
});

const fontStyle = computed(() => companyPrefs.value.fontFamily === 'serif' ? 'font-serif' : 'font-sans');
const view = ref('list');
const filterType = ref('all');
const txForm = ref({});
const isGeneratingPdf = ref(false);
const currentUser = computed(() => Store.state.currentUser);
const canDelete = computed(() => currentUser.value.role === 'super' || currentUser.value.role === 'company_admin');

// --- CALCULATIONS (UPDATED WITH DISCOUNT) ---
const calculations = computed(() => {
    if (!txForm.value.items) return { subtotal: '0.00', discount: '0.00', tax: '0.00', grandTotal: '0.00' };
    
    // 1. Subtotal
    const sub = txForm.value.items.reduce((sum, i) => sum + (i.qty * i.price), 0);
    
    // 2. Discount
    const discountRate = txForm.value.discount || 0;
    const discountAmt = sub * (discountRate / 100);
    
    // 3. Tax (Applied on Amount AFTER Discount)
    const taxableAmt = sub - discountAmt;
    const taxRate = txForm.value.taxRate || 0;
    const taxAmt = taxableAmt * (taxRate / 100);
    
    // 4. Total
    const total = taxableAmt + taxAmt;

    return {
        subtotal: sub.toLocaleString('en-US', {minimumFractionDigits: 2}),
        discount: discountAmt.toLocaleString('en-US', {minimumFractionDigits: 2}),
        tax: taxAmt.toLocaleString('en-US', {minimumFractionDigits: 2}),
        grandTotal: total.toLocaleString('en-US', {minimumFractionDigits: 2})
    };
});

// --- DATA LIST ---
const salesData = computed(() => {
    let data = Store.state.transactions
        .filter(t => t.company_id === activeCompany.value.id && (t.type === 'Invoice' || t.type === 'Quote'))
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    
    if (filterType.value === 'invoice') return data.filter(t => t.type === 'Invoice');
    if (filterType.value === 'quote') return data.filter(t => t.type === 'Quote');
    return data;
});

// --- ACTIONS ---
function addToHistory(action) {
    if (!txForm.value.history) txForm.value.history = [];
    txForm.value.history.unshift({
        date: new Date().toISOString(),
        action: action,
        user: Store.state.currentUser?.username || 'User'
    });
}

function getClientName(id) { const c = clients.value.find(x => x.id === id); return c ? c.name : 'Unknown'; }

function getStatusColor(t) {
    if (t.type === 'Quote') return t.status === 'Converted' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800';
    if (t.status === 'Cleared') return 'bg-emerald-100 text-emerald-800';
    const daysOld = (new Date() - new Date(t.date)) / (1000 * 60 * 60 * 24);
    if (daysOld > 30) return 'bg-red-100 text-red-800 font-bold border border-red-200';
    return 'bg-yellow-100 text-yellow-800';
}

function resetForm() {
    txForm.value = { 
        id: null, 
        company_id: activeCompany.value.id, 
        client_id: '', 
        type: 'Quote', 
        number: 'QT-' + Date.now().toString().slice(-6), 
        date: new Date().toISOString().split('T')[0], 
        status: 'Pending', 
        items: [{ desc: 'Service', unit: 'Unit', qty: 1, price: 0 }], 
        taxRate: 0, 
        discount: 0, // <--- NEW FIELD
        notes: '', 
        history: [] 
    };
}

function openEditor(tx = null) {
    if (tx) txForm.value = JSON.parse(JSON.stringify(tx)); else resetForm();
    view.value = 'editor';
}

function saveTx() {
    if (!txForm.value.client_id) return Store.notify("Client Required", "error");
    
    // Re-run calculation for saving
    const sub = txForm.value.items.reduce((sum, i) => sum + (i.qty * i.price), 0);
    const disc = sub * ((txForm.value.discount || 0) / 100);
    const tax = (sub - disc) * ((txForm.value.taxRate || 0) / 100);
    txForm.value.total = (sub - disc) + tax;
    
    // ... rest of save function
    const isNew = !txForm.value.id;
    addToHistory(isNew ? 'Document Created' : 'Document Updated');
    if (isNew) { txForm.value.id = Date.now(); Store.addTransaction(JSON.parse(JSON.stringify(txForm.value))); }
    else { Store.updateTransaction(JSON.parse(JSON.stringify(txForm.value))); }
    Store.notify("Document Saved"); view.value = 'list';
}

function deleteTx(id) { if (confirm("Delete?")) Store.deleteTransaction(id); }

function addItem(product = null) {
    if (product && product.id) {
        txForm.value.items.push({ 
            desc: product.name + (product.desc ? '\n' + product.desc : ''), 
            unit: product.unit, 
            qty: 1, 
            price: product.price,
            // NEW: Hidden fields for future Analytics
            type: product.type || 'General', 
            productId: product.id,
            code: product.code 
        });
    } else {
        txForm.value.items.push({ 
            desc: '', unit: 'Unit', qty: 1, price: 0,
            type: 'General', productId: null 
        });
    }
}

function removeItem(i) { txForm.value.items.splice(i, 1); }

function markCleared(t) {
    if (!confirm(`Mark Invoice ${t.number} as Paid/Cleared?`)) return;
    const copy = JSON.parse(JSON.stringify(t));
    if (!copy.history) copy.history = [];
    copy.history.unshift({ date: new Date().toISOString(), action: 'Marked as Paid', user: Store.state.currentUser?.username || 'User' });
    copy.status = 'Cleared';
    Store.updateTransaction(copy);
    Store.notify("Invoice Marked as Paid");
}

function convertQuote(t) {
    if (!confirm(`Convert Quote ${t.number} to a new Invoice?`)) return;
    const oldQuote = JSON.parse(JSON.stringify(t));
    oldQuote.status = 'Converted';
    if (!oldQuote.history) oldQuote.history = [];
    oldQuote.history.unshift({ date: new Date().toISOString(), action: 'Converted to Invoice', user: Store.state.currentUser?.username });
    Store.updateTransaction(oldQuote);
    const newInv = JSON.parse(JSON.stringify(t));
    newInv.id = Date.now();
    newInv.type = 'Invoice';
    newInv.number = 'INV-' + Date.now().toString().slice(-5);
    newInv.status = 'Pending';
    newInv.date = new Date().toISOString().split('T')[0];
    newInv.notes = `Converted from Quote ${t.number}. ` + (newInv.notes || '');
    newInv.history = [{ date: new Date().toISOString(), action: `Generated from Quote ${t.number}`, user: Store.state.currentUser?.username }];
    Store.addTransaction(newInv);
    Store.notify("Success! Invoice Created");
}

function downloadPDF(t) {
    if (!txForm.value.id || txForm.value.id !== t.id) {
         txForm.value = JSON.parse(JSON.stringify(t));
    }
    view.value = 'editor'; 
    addToHistory('PDF Generated / Printed');
    Store.updateTransaction(JSON.parse(JSON.stringify(txForm.value)));
    isGeneratingPdf.value = true;
    setTimeout(() => {
        const element = document.getElementById('invoice-print-area');
        const opt = { margin: 0, filename: `${t.number}.pdf`, image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } };
        html2pdf().set(opt).from(element).save().then(() => { isGeneratingPdf.value = false; });
    }, 500);
}
</script>

<template>
    <div>
        <div v-if="view === 'list'" class="no-print">
            <div class="flex justify-between items-center mb-6">
                <div class="flex items-center gap-4">
                    <h2 class="text-2xl font-bold text-slate-800 dark:text-white">Sales & Invoices</h2>
                    <select v-model="filterType" class="bg-white dark:bg-slate-700 border rounded-lg px-3 py-1 text-sm dark:text-white">
                        <option value="all">Show All</option><option value="invoice">Invoices Only</option><option value="quote">Quotes Only</option>
                    </select>
                </div>
                <button @click="openEditor()" class="bg-emerald-600 text-white px-4 py-2 rounded flex items-center gap-2"><i class="fas fa-plus"></i> Create New</button>
            </div>
            
            <div class="bg-white dark:bg-slate-800 shadow rounded-lg overflow-hidden border dark:border-slate-700">
                <table class="w-full text-sm text-left text-gray-600 dark:text-gray-300">
                    <thead class="bg-gray-50 dark:bg-slate-700 uppercase text-xs font-bold">
                        <tr><th class="p-4">Date</th><th class="p-4">Number</th><th class="p-4">Client</th><th class="p-4">Total</th><th class="p-4 text-center">Status</th><th class="p-4 text-right">Actions</th></tr>
                    </thead>
                    <tbody>
                        <tr v-for="t in salesData" :key="t.id" class="border-b dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700">
                            <td class="p-4">{{ t.date }}</td>
                            <td class="p-4 font-mono font-bold">{{ t.number }}</td><td class="p-4">{{ getClientName(t.client_id) }}</td>
                            <td class="p-4 font-bold">
                                {{ companyPrefs.currency }} {{ Number(t.total).toLocaleString('en-US', {minimumFractionDigits: 2}) }}
                            </td>
                            <td class="p-4 text-center"><span :class="getStatusColor(t)" class="px-3 py-1 rounded-full text-xs font-bold uppercase">{{ t.status }}</span></td>
                            <td class="p-4 text-right whitespace-nowrap">
                                <button v-if="t.type === 'Invoice' && t.status !== 'Cleared'" @click="markCleared(t)" class="text-emerald-500 hover:text-emerald-700 mr-3" title="Mark Paid"><i class="fas fa-check-circle"></i></button>
                                <button v-if="t.type === 'Quote' && t.status !== 'Converted'" @click="convertQuote(t)" class="text-purple-500 hover:text-purple-700 mr-3" title="Convert to Invoice"><i class="fas fa-magic"></i></button>
                                <button @click="downloadPDF(t)" class="text-gray-400 hover:text-gray-600 mr-3"><i class="fas fa-file-pdf"></i></button>
                                <button @click="openEditor(t)" class="text-blue-500 hover:text-blue-700 mr-3"><i class="fas fa-edit"></i></button>
                                <button @click="deleteTx(t.id)" class="text-red-400 hover:text-red-600"><i class="fas fa-trash"></i></button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div v-else class="flex flex-col lg:flex-row gap-6 max-w-7xl mx-auto">
            
            <div class="flex-grow bg-white shadow-2xl rounded-lg overflow-hidden flex flex-col">
                 <div class="bg-slate-100 dark:bg-slate-800 px-6 py-3 border-b flex justify-between items-center no-print">
                    <button @click="view = 'list'" class="text-gray-600 dark:text-gray-300 hover:text-black font-medium"><i class="fas fa-arrow-left mr-2"></i>Back</button>
                    <div class="flex gap-2"><button @click="saveTx" class="bg-emerald-600 text-white px-4 py-2 rounded shadow hover:bg-emerald-700 font-bold"><i class="fas fa-save mr-2"></i>Save</button></div>
                </div>

                <div id="invoice-print-area" class="p-12 text-gray-800 bg-white min-h-[1100px] flex flex-col" :class="[fontStyle, isGeneratingPdf ? 'pdf-mode' : '']">
                    
                    <component 
                        :is="companyPrefs.baseTheme === 'modern' ? TemplateModern : (companyPrefs.baseTheme === 'corporate' ? TemplateCorporate : TemplateClean)"
                        :form="txForm"
                        :company="activeCompany"
                        :prefs="companyPrefs"
                        :clients="clients"
                        :products="products" 
                        :isPdf="isGeneratingPdf"
                        :calculations="calculations"
                        @addItem="addItem"
                        @removeItem="removeItem"
                    />
                </div>
            </div>

            <div class="w-full lg:w-80 flex-shrink-0 no-print">
                <div class="bg-white dark:bg-slate-800 rounded-lg shadow-lg border dark:border-slate-700 overflow-hidden sticky top-4">
                    <div class="bg-slate-100 dark:bg-slate-900 px-4 py-3 border-b dark:border-slate-700 font-bold text-slate-700 dark:text-gray-300">
                        <i class="fas fa-history mr-2"></i> Timeline
                    </div>
                    <div class="p-4 max-h-[500px] overflow-y-auto">
                        <div v-if="txForm.history && txForm.history.length > 0" class="relative pl-4 border-l-2 border-gray-200 dark:border-slate-700 space-y-6">
                            
                            <div v-for="(h, i) in txForm.history" :key="i" class="relative group">
                                <div class="absolute -left-[21px] top-1 h-3 w-3 rounded-full border-2 border-white dark:border-slate-800" 
                                     :class="(h.action || '').includes('Created') ? 'bg-emerald-500' : ((h.action || '').includes('Paid') ? 'bg-green-600' : 'bg-blue-400')">
                                </div>
                                
                                <div>
                                    <div class="text-xs text-gray-400 dark:text-gray-500 mb-1">
                                        {{ new Date(h.date).toLocaleDateString() }} <span class="opacity-50">at {{ new Date(h.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) }}</span>
                                    </div>
                                    <div class="text-sm font-bold text-slate-700 dark:text-gray-200">
                                        {{ h.action || 'Action logged' }}
                                    </div>
                                    <div class="text-xs text-gray-500 italic mt-1">
                                        by {{ h.user || 'System' }}
                                    </div>
                                </div>
                            </div>

                        </div>
                        <div v-else class="text-center text-gray-400 text-sm py-8 italic">
                            No history recorded yet.
                        </div>
                    </div>
                </div>
            </div>

        </div>
    </div>
</template>