<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../../store';
import { usePdfGenerator } from '../../../composables/usePdfGenerator';

// --- SUB COMPONENTS ---
import ClientDirectory from './sales-parts/ClientDirectory.vue';
import SalesStats from './sales-parts/SalesStats.vue';
import SalesTable from './sales-parts/SalesTable.vue';
import SalesEditor from './sales-parts/SalesEditor.vue';

// --- STATE ---
const { generatePdf } = usePdfGenerator();
const view = ref('dashboard');
const selectedClient = ref(null);
const txForm = ref({});
const isGeneratingPdf = ref(false);

// --- DATA ---
const activeCompany = computed(() => Store.state.selectedCompany || {});
const clients = computed(() => Store.state.clients.filter(c => c.company_id === activeCompany.value.id));
const products = computed(() => (Store.state.products || []).filter(p => p.company_id === activeCompany.value.id));

// Filter Transactions by Client (if selected)
const clientTransactions = computed(() => {
    let txs = Store.state.transactions.filter(t => t.company_id === activeCompany.value.id);
    if (selectedClient.value) {
        txs = txs.filter(t => t.client_id === selectedClient.value.id);
    }
    return txs;
});

// Calculate Analytics for Top Cards
const analytics = computed(() => {
    const txs = clientTransactions.value;
    const totalRevenue = txs.filter(t => t.type === 'Invoice').reduce((sum, t) => sum + Number(t.total || 0), 0);
    const paidRevenue = txs.filter(t => t.type === 'Invoice' && t.status === 'Cleared').reduce((sum, t) => sum + Number(t.total || 0), 0);
    return { 
        totalRevenue, 
        paidRevenue, 
        outstanding: totalRevenue - paidRevenue, 
        pendingQuotes: txs.filter(t => t.type === 'Quote' && t.status === 'Pending').length 
    };
});

// Prefs
const companyPrefs = computed(() => ({
    baseTheme: 'clean', 
    currency: 'RM',
    labels: { invoice: 'INVOICE', quote: 'QUOTE', billTo: 'Bill To' }, 
    showLogo: true,
    defaultNotes: '', // Added default notes parameter
    ...(activeCompany.value.preferences || {})
}));

// --- ACTIONS ---
function handleNewInvoice(type) {
    txForm.value = { 
        id: null, 
        company_id: activeCompany.value.id, 
        client_id: selectedClient.value ? selectedClient.value.id : '',
        project: '', // Initialize empty project
        type: type === 'quote' ? 'Quote' : 'Invoice', 
        number: (type === 'quote' ? 'QT-' : 'INV-') + Date.now().toString().slice(-6), 
        date: new Date().toISOString().split('T')[0], 
        status: 'Pending', 
        items: [{ desc: 'Service', unit: 'Unit', qty: 1, price: 0 }], 
        taxRate: 0, 
        discount: 0, 
        notes: companyPrefs.value.defaultNotes || '' // Inject default remarks automatically
    };
    view.value = 'editor';
}

function handleEdit(tx) {
    txForm.value = JSON.parse(JSON.stringify(tx));
    view.value = 'editor';
}

function saveTx() {
    if (!txForm.value.client_id && txForm.value.type !== 'Invoice') return Store.notify("Client Required", "error");

    const sub = txForm.value.items.reduce((s, i) => s + (i.qty * i.price), 0);
    const total = (sub * (1 - (txForm.value.discount || 0) / 100)) * (1 + (txForm.value.taxRate || 0) / 100);
    txForm.value.total = total;
    txForm.value.subtotal = sub;

    if (!txForm.value.id) {
        txForm.value.id = Date.now().toString();
        Store.addTransaction(JSON.parse(JSON.stringify(txForm.value)));
    } else {
        Store.updateTransaction(JSON.parse(JSON.stringify(txForm.value)));
    }
    
    Store.notify("Document Saved");
    view.value = 'dashboard';
}

async function handleDelete(id) { 
    if(confirm("Delete?")) await Store.deleteTransaction(id); 
}

function handleMarkPaid(t) { 
    Store.updateTransaction({ ...t, status: 'Cleared' }); 
}

function handleConvert(t) { 
    const newInv = { 
        ...t, 
        id: Date.now().toString(), 
        type: 'Invoice', 
        number: 'INV-' + Date.now().toString().slice(-5), 
        status: 'Pending', 
        date: new Date().toISOString().split('T')[0] 
    };
    Store.addTransaction(newInv);
    Store.updateTransaction({ ...t, status: 'Converted' });
    Store.notify("Quote Converted!");
}

function handleDownload(t) {
    if (!txForm.value.id || txForm.value.id !== t.id) txForm.value = JSON.parse(JSON.stringify(t));
    view.value = 'editor';
    isGeneratingPdf.value = true;
    
    generatePdf(t, 'invoice-print-area', `${t.number}.pdf`, () => {
        isGeneratingPdf.value = false;
        Store.notify("PDF Downloaded");
        view.value = 'dashboard'; 
    });
}

function handleSaveDefaultNotes(notesText) {
    Store.updatePreferences({ ...companyPrefs.value, defaultNotes: notesText });
    Store.notify("Remarks saved as default for future documents!");
}
</script>

<template>
    <div class="h-full flex flex-col bg-slate-50 dark:bg-slate-900">
        
        <div v-if="view === 'dashboard'" class="flex flex-grow overflow-hidden relative">
            <ClientDirectory 
                :clients="clients" 
                :selectedClient="selectedClient" 
                @select="(c) => selectedClient = c" 
                @clear="selectedClient = null"
            />

            <div class="flex-grow flex flex-col overflow-hidden bg-gray-50 dark:bg-slate-900">
                <div class="bg-white dark:bg-slate-800 border-b dark:border-slate-700 p-6 shadow-sm z-10">
                    <h1 class="text-2xl font-bold text-slate-800 dark:text-white mb-4">
                        {{ selectedClient ? selectedClient.name : 'Sales Overview' }}
                    </h1>
                    <SalesStats :analytics="analytics" :currency="companyPrefs.currency" />
                </div>

                <SalesTable 
                    :transactions="clientTransactions" 
                    :currency="companyPrefs.currency"
                    :clients="clients"
                    @edit="handleEdit"
                    @delete="handleDelete"
                    @mark-paid="handleMarkPaid"
                    @convert="handleConvert"
                    @download="handleDownload"
                    @new-invoice="handleNewInvoice"
                />
            </div>
        </div>

        <SalesEditor 
            v-else
            :txForm="txForm"
            :activeCompany="activeCompany"
            :companyPrefs="companyPrefs"
            :clients="clients"
            :products="products"
            :isGeneratingPdf="isGeneratingPdf"
            @save="saveTx"
            @cancel="view = 'dashboard'"
            @saveDefaultNotes="handleSaveDefaultNotes"
        />

    </div>
</template>