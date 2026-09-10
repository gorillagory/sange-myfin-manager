<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';
import { useStorage } from '../../composables/useStorage';
import SmartButton from '../ui/SmartButton.vue';
const { uploadFile, removeFile } = useStorage();

const view = ref('list');
const isUploading = ref(false);
const form = ref({});
const fileData = ref(null);

const activeCompany = computed(() => Store.state.selectedCompany || {});
const expenses = computed(() => {
    return (Store.state.expenses || [])
        .filter(e => e.company_id === activeCompany.value.id)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
});
const companyPrefs = computed(() => activeCompany.value.preferences || {});

const totalExpenses = computed(() => {
    return expenses.value.reduce((sum, e) => sum + Number(e.amount || 0), 0);
});

function resetForm() {
    form.value = {
        id: null, company_id: activeCompany.value.id, date: new Date().toISOString().split('T')[0],
        description: '', category: 'General', amount: 0, receiptUrl: '', receiptPath: '' 
    };
    fileData.value = null;
}

function openEditor(expense = null) {
    if (expense) form.value = JSON.parse(JSON.stringify(expense));
    else resetForm();
    view.value = 'editor';
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        if (file.size > 5 * 1024 * 1024) return alert("File too large (Max 5MB)");
        fileData.value = file;
    }
}

async function saveExpense() {
    if (!form.value.description || !form.value.amount) return Store.notify("Description & Amount required", "error");
    isUploading.value = true;

    try {
        if (fileData.value) {
            if (form.value.receiptPath) await removeFile(form.value.receiptPath);
            const fileName = `receipts/${activeCompany.value.id}/${Date.now()}_${fileData.value.name}`;
            const uploadResult = await uploadFile(fileData.value, fileName);
            form.value.receiptUrl = uploadResult.url;
            form.value.receiptPath = uploadResult.path;
        }

        if (form.value.id) {
            await Store.financeModule.updateTransaction(Store, { ...form.value, type: 'Expense' });
            Store.notify("Expense Updated");
        } else {
            form.value.id = Date.now().toString();
            form.value.type = 'Expense';
            await Store.financeModule.addTransaction(Store, form.value);
            Store.notify("Expense Added");
        }
        view.value = 'list';
    } catch (err) {
        Store.notify("Error saving: " + err.message, "error");
    } finally {
        isUploading.value = false;
    }
}

async function deleteExpense(expense) {
    try {
        if (expense.receiptPath) await removeFile(expense.receiptPath);
        await Store.deleteTransaction(expense.id);
        Store.notify("Expense Deleted");
    } catch (err) {
        Store.notify("Failed to delete: " + err.message, "error");
    }
}
</script>

<template>
    <div class="w-full">
        <div v-if="view === 'list'">
            <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
                <div>
                    <h2 class="text-2xl font-bold text-slate-800 dark:text-white">Expenses</h2>
                    <p class="text-sm text-gray-500">Track spending and upload receipts.</p>
                </div>
                
                <div class="flex items-center gap-4 w-full sm:w-auto justify-between sm:justify-end border-t sm:border-t-0 border-gray-200 dark:border-slate-700 pt-4 sm:pt-0">
                    <div class="text-left sm:text-right">
                        <div class="text-xs text-gray-400 uppercase font-bold">Total Spent</div>
                        <div class="text-lg sm:text-xl font-bold text-slate-700 dark:text-white">
                            {{ companyPrefs.currency || 'RM' }} {{ totalExpenses.toLocaleString('en-US', {minimumFractionDigits: 2}) }}
                        </div>
                    </div>
                    <button @click="openEditor()" class="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded flex items-center gap-2 font-bold shadow transition whitespace-nowrap">
                        <i class="fas fa-plus"></i> Add
                    </button>
                </div>
            </div>

            <div class="bg-white dark:bg-slate-800 shadow rounded-lg overflow-x-auto border dark:border-slate-700 w-full">
                <table class="w-full text-sm text-left text-gray-600 dark:text-gray-300 min-w-[600px]">
                    <thead class="bg-gray-50 dark:bg-slate-700 uppercase text-xs font-bold text-gray-500 dark:text-gray-200">
                        <tr>
                            <th class="p-4">Date</th>
                            <th class="p-4">Description</th>
                            <th class="p-4">Category</th>
                            <th class="p-4 text-right">Amount</th>
                            <th class="p-4 text-center">Receipt</th>
                            <th class="p-4 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="ex in expenses" :key="ex.id" class="border-b dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700 transition">
                            <td class="p-4 font-mono text-xs">{{ ex.date }}</td>
                            <td class="p-4 font-bold text-slate-700 dark:text-white">{{ ex.description }}</td>
                            <td class="p-4">
                                <span class="px-2 py-1 rounded-full text-xs font-bold bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-gray-300">
                                    {{ ex.category }}
                                </span>
                            </td>
                            <td class="p-4 text-right font-bold text-red-500 whitespace-nowrap">
                                {{ companyPrefs.currency }} {{ Number(ex.amount).toLocaleString('en-US', {minimumFractionDigits: 2}) }}
                            </td>
                            <td class="p-4 text-center">
                                <a v-if="ex.receiptUrl" :href="ex.receiptUrl" target="_blank" class="text-blue-500 hover:underline text-xs whitespace-nowrap">
                                    <i class="fas fa-paperclip mr-1"></i> View
                                </a>
                                <span v-else class="text-gray-300">-</span>
                            </td>
                            <td class="p-4 text-right flex justify-end gap-3">
                                <button @click="openEditor(ex)" class="text-blue-500 hover:text-blue-700 p-1"><i class="fas fa-edit"></i></button>
                                <SmartButton icon="fas fa-trash" color="text-red-300 hover:text-red-500 p-1" confirmLabel="Delete?" @confirmed="deleteExpense(ex)" />
                            </td>
                        </tr>
                        <tr v-if="expenses.length === 0">
                            <td colspan="6" class="p-8 text-center text-gray-400 italic">No expenses recorded yet.</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div v-else class="max-w-2xl mx-auto bg-white dark:bg-slate-800 shadow rounded-lg p-6 w-full">
            <h3 class="text-xl font-bold mb-6 text-slate-800 dark:text-white">{{ form.id ? 'Edit Expense' : 'New Expense' }}</h3>
            <div class="space-y-4">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Date</label>
                        <input v-model="form.date" type="date" class="w-full border rounded p-2 bg-transparent dark:border-slate-600 dark:text-white">
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Amount</label>
                        <input v-model="form.amount" type="number" step="0.01" class="w-full border rounded p-2 bg-transparent dark:border-slate-600 dark:text-white font-bold">
                    </div>
                </div>
                <div>
                    <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Description</label>
                    <input v-model="form.description" type="text" placeholder="e.g. Office Rent, Server Costs" class="w-full border rounded p-2 bg-transparent dark:border-slate-600 dark:text-white">
                </div>
                <div>
                    <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Category</label>
                    <select v-model="form.category" class="w-full border rounded p-2 bg-transparent dark:border-slate-600 dark:text-white">
                        <option>General</option><option>Utilities</option><option>Rent</option><option>Salaries</option>
                        <option>Equipment</option><option>Marketing</option><option>Software/SaaS</option><option>Travel</option>
                    </select>
                </div>
                <div>
                    <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Receipt (Optional)</label>
                    <input type="file" @change="handleFileSelect" accept="image/*,application/pdf" class="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100 transition">
                    <p v-if="form.receiptUrl && !fileData" class="text-xs text-green-600 mt-1"><i class="fas fa-check-circle"></i> Attached</p>
                </div>
            </div>
            <div class="flex justify-end gap-3 mt-8">
                <button @click="view = 'list'" class="text-gray-500 hover:text-gray-700 px-4 py-2">Cancel</button>
                <button @click="saveExpense" :disabled="isUploading" class="bg-red-500 hover:bg-red-600 text-white px-6 py-2 rounded font-bold shadow disabled:opacity-50 flex items-center gap-2">
                    <i v-if="isUploading" class="fas fa-spinner fa-spin"></i>{{ isUploading ? 'Saving...' : 'Save Expense' }}
                </button>
            </div>
        </div>
    </div>
</template>