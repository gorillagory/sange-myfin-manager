<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';

const activeCompany = computed(() => Store.state.selectedCompany || {});

// 1. GET PREFS (For Currency)
const companyPrefs = computed(() => {
    return { currency: 'RM', ...(activeCompany.value.preferences || {}) };
});

const clients = computed(() => Store.state.clients.filter(c => c.company_id === activeCompany.value.id));
const expenseData = computed(() => Store.state.transactions.filter(t => t.company_id === activeCompany.value.id && t.type === 'Payment Voucher').sort((a, b) => new Date(b.date) - new Date(a.date)));

const expenseModal = ref(false);
const expenseForm = ref({});

// --- CALCULATIONS (For Top Stats) ---
const totalStats = computed(() => {
    const total = expenseData.value.reduce((sum, t) => sum + Number(t.total || 0), 0);
    const now = new Date();
    const thisMonth = expenseData.value
        .filter(t => new Date(t.date).getMonth() === now.getMonth() && new Date(t.date).getFullYear() === now.getFullYear())
        .reduce((sum, t) => sum + Number(t.total || 0), 0);
    return { total, thisMonth };
});

function getClientName(id) { const c = clients.value.find(x => x.id === id); return c ? c.name : 'Unknown'; }

function openExpenseModal(exp = null) {
    if (exp) {
        expenseForm.value = JSON.parse(JSON.stringify(exp));
    } else {
        expenseForm.value = { 
            id: null, company_id: activeCompany.value.id, type: 'Payment Voucher', 
            category: 'General', date: new Date().toISOString().split('T')[0],
            client_id: '', number: 'EXP-' + Date.now().toString().slice(-5),
            items: [{desc: 'Expense', qty: 1, price: 0}], total: 0, status: 'Paid', notes: ''
        };
    }
    expenseModal.value = true;
}

function saveExpense() {
    if (!expenseForm.value.total) return Store.notify("Amount required", 'error');
    if (!expenseForm.value.client_id) return Store.notify("Payee required", 'error');
    if (!expenseForm.value.id) expenseForm.value.id = Date.now();
    
    expenseForm.value.items[0].price = expenseForm.value.total;
    const cleanData = JSON.parse(JSON.stringify(expenseForm.value));
    
    Store.addTransaction(cleanData);
    expenseModal.value = false;
    Store.notify("Expense Saved");
}

function deleteTx(id) {
    if (confirm("Delete?")) Store.deleteTransaction(id);
}
</script>

<template>
    <div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8 no-print">
            <div class="bg-white dark:bg-slate-800 p-6 rounded-lg shadow border-l-4 border-rose-500 flex justify-between items-center">
                <div>
                    <div class="text-sm font-bold text-gray-400 uppercase tracking-wider">This Month</div>
                    <div class="text-3xl font-bold text-slate-800 dark:text-white">{{ companyPrefs.currency }} {{ totalStats.thisMonth.toLocaleString('en-US', {minimumFractionDigits: 2}) }}</div>
                </div>
                <div class="h-12 w-12 rounded-full bg-rose-100 text-rose-500 flex items-center justify-center text-xl"><i class="fas fa-calendar-alt"></i></div>
            </div>
            <div class="bg-white dark:bg-slate-800 p-6 rounded-lg shadow border-l-4 border-gray-500 flex justify-between items-center">
                <div>
                    <div class="text-sm font-bold text-gray-400 uppercase tracking-wider">Total All Time</div>
                    <div class="text-3xl font-bold text-slate-800 dark:text-white">{{ companyPrefs.currency }} {{ totalStats.total.toLocaleString('en-US', {minimumFractionDigits: 2}) }}</div>
                </div>
                <div class="h-12 w-12 rounded-full bg-gray-100 text-gray-500 flex items-center justify-center text-xl"><i class="fas fa-wallet"></i></div>
            </div>
        </div>

        <div class="flex justify-between items-center mb-4"><h2 class="text-2xl font-bold text-slate-800 dark:text-white">Expenses</h2><button @click="openExpenseModal()" class="bg-red-600 text-white px-3 py-1 rounded text-sm shadow">Record Expense</button></div>
        <div class="bg-white dark:bg-slate-800 shadow rounded overflow-hidden">
            <table class="w-full text-sm text-left text-gray-600 dark:text-gray-300">
                <thead class="bg-gray-50 dark:bg-slate-700 uppercase text-xs font-bold"><tr><th class="p-4">Date</th><th class="p-4">Payee</th><th class="p-4">Category</th><th class="p-4">Amount</th><th class="p-4 text-right">Action</th></tr></thead>
                <tbody>
                    <tr v-for="t in expenseData" :key="t.id" class="border-b dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700">
                        <td class="p-4">{{ t.date }}</td>
                        <td class="p-4">{{ getClientName(t.client_id) }}</td>
                        <td class="p-4">{{ t.category }}</td>
                        <td class="p-4 font-bold text-red-500">{{ companyPrefs.currency }} {{ t.total.toFixed(2) }}</td>
                        <td class="p-4 text-right"><button @click="openExpenseModal(t)" class="text-blue-500 mr-2">Edit</button><button @click="deleteTx(t.id)" class="text-red-500">Del</button></td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div v-if="expenseModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999]">
             <div class="bg-white dark:bg-slate-800 p-6 rounded w-96 space-y-4 shadow-2xl border dark:border-slate-600">
                <h3 class="font-bold dark:text-white text-lg text-red-500">Record Expense</h3>
                <select v-model="expenseForm.client_id" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white"><option value="" disabled>Select Payee...</option><option v-for="c in clients" :value="c.id">{{ c.name }}</option></select>
                <div class="grid grid-cols-2 gap-2">
                    <input type="date" v-model="expenseForm.date" class="border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white">
                    <input type="number" v-model="expenseForm.total" placeholder="Amount" class="border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white font-bold">
                </div>
                <select v-model="expenseForm.category" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white"><option>General</option><option>Utilities</option><option>Rent</option><option>Salary</option><option>Supplies</option></select>
                <input v-model="expenseForm.notes" placeholder="Notes" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white">
                <div class="flex justify-end gap-2 pt-2"><button @click="expenseModal=false" class="px-3 py-1 rounded border dark:border-slate-600 dark:text-white">Cancel</button><button @click="saveExpense" class="bg-red-600 text-white px-4 py-2 rounded">Save</button></div>
            </div>
        </div>
    </div>
</template>