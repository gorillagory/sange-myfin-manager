<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';

const expenses = computed(() => Store.state.expenses);
const currency = computed(() => Store.state.selectedCompany?.preferences?.currency || 'RM');

const showModal = ref(false);
const showReceiptModal = ref(false);
const activeReceipt = ref(null); // Stores the receipt object to view
const activeFilter = ref('All');

// Form Data
const form = ref({ 
    date: new Date().toISOString().split('T')[0], 
    description: '', 
    category: 'Supplies', 
    amount: '', 
    paymentMethod: 'Cash',
    file: null // <--- Holds the raw file object
});

const categories = ['Rent', 'Utilities', 'Salaries', 'Supplies', 'Marketing', 'Maintenance', 'Software', 'Other'];

// --- COMPUTED STATS ---
const currentMonthTotal = computed(() => {
    const now = new Date();
    return expenses.value
        .filter(e => {
            const d = new Date(e.date);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        })
        .reduce((sum, e) => sum + Number(e.amount), 0);
});

const filteredExpenses = computed(() => {
    let list = expenses.value.sort((a,b) => new Date(b.date) - new Date(a.date));
    if (activeFilter.value !== 'All') {
        list = list.filter(e => e.category === activeFilter.value);
    }
    return list;
});

// --- ACTIONS ---
function openModal() {
    form.value = { date: new Date().toISOString().split('T')[0], description: '', category: 'Supplies', amount: '', paymentMethod: 'Cash', file: null };
    showModal.value = true;
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        // Simple Validation: Max 5MB
        if (file.size > 5 * 1024 * 1024) return Store.notify("File too large (Max 5MB)", "error");
        form.value.file = file;
    }
}

async function saveExpense() {
    if (!form.value.description || !form.value.amount) return Store.notify("Details required", "error");
    
    // Pass the raw file to the store action
    await Store.addExpense({
        ...form.value,
        amount: Number(form.value.amount)
    });
    
    showModal.value = false;
}

function viewReceipt(expense) {
    if (!expense.receipt) return;
    activeReceipt.value = expense.receipt;
    showReceiptModal.value = true;
}

function deleteItem(expense) {
    if(confirm("Undo this expense? This will also delete the attached receipt.")) Store.deleteExpense(expense.id); // Note: Updated Store signature needs whole object now, but we can fix that or pass ID
    // Actually, to delete the file we need the 'path'. 
    // Let's update the Store call to pass the whole object:
    Store.financeModule.deleteExpense(Store, expense); 
}

// Wrapper for Store delete that handles the object requirement
// Ideally we move this logic entirely to store/index.js proxy
function handleDelete(e) {
    if(confirm("Delete expense record?")) Store.deleteExpense(e); // We need to update Store.deleteExpense signature
}

function formatMoney(n) { return Number(n).toLocaleString('en-US', {minimumFractionDigits:2}); }
</script>

<template>
    <div class="h-full flex flex-col space-y-6">
        
        <div class="flex justify-between items-end bg-white dark:bg-slate-800 p-6 rounded-xl shadow border dark:border-slate-700">
            <div>
                <h2 class="text-2xl font-bold text-slate-800 dark:text-white">Expense Tracker</h2>
                <p class="text-sm text-gray-500">Record operational costs and audit proofs.</p>
            </div>
            <div class="text-right">
                <div class="text-xs font-bold text-gray-400 uppercase">This Month</div>
                <div class="text-3xl font-bold text-red-500">- {{ currency }} {{ formatMoney(currentMonthTotal) }}</div>
            </div>
        </div>

        <div class="flex flex-wrap gap-2 items-center">
            <button @click="openModal" class="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-bold shadow-lg transition flex items-center gap-2">
                <i class="fas fa-plus"></i> Record Expense
            </button>
            <div class="w-px h-8 bg-gray-300 dark:bg-slate-700 mx-2"></div>
            <button v-for="cat in ['All', ...categories]" :key="cat" 
                @click="activeFilter = cat"
                class="px-3 py-1 rounded-full text-xs font-bold transition border"
                :class="activeFilter === cat ? 'bg-slate-700 text-white border-slate-700' : 'bg-white dark:bg-slate-800 text-gray-500 border-gray-200 dark:border-slate-700 hover:bg-gray-50'">
                {{ cat }}
            </button>
        </div>

        <div class="flex-grow bg-white dark:bg-slate-800 rounded-xl shadow border dark:border-slate-700 overflow-hidden flex flex-col">
            <div class="overflow-y-auto flex-grow">
                <table class="w-full text-left border-collapse">
                    <thead class="bg-gray-50 dark:bg-slate-900 sticky top-0 z-10 text-xs font-bold text-gray-500 uppercase">
                        <tr>
                            <th class="p-4">Date</th>
                            <th class="p-4">Description</th>
                            <th class="p-4">Category</th>
                            <th class="p-4">Proof</th> <th class="p-4 text-right">Amount</th>
                            <th class="p-4 w-10"></th>
                        </tr>
                    </thead>
                    <tbody class="text-sm">
                        <tr v-for="e in filteredExpenses" :key="e.id" class="border-b dark:border-slate-700 hover:bg-red-50 dark:hover:bg-red-900/10 transition group">
                            <td class="p-4 font-mono text-gray-500">{{ e.date }}</td>
                            <td class="p-4 font-bold text-slate-800 dark:text-white">{{ e.description }}</td>
                            <td class="p-4">
                                <span class="px-2 py-1 rounded text-[10px] font-bold uppercase bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-slate-600">
                                    {{ e.category }}
                                </span>
                            </td>
                            <td class="p-4">
                                <button v-if="e.receipt" @click="viewReceipt(e)" class="text-blue-500 hover:text-blue-700 flex items-center gap-1 font-bold text-xs">
                                    <i class="fas fa-paperclip"></i> View
                                </button>
                                <span v-else class="text-gray-300 text-xs">-</span>
                            </td>
                            <td class="p-4 text-right font-bold text-red-500">{{ currency }} {{ formatMoney(e.amount) }}</td>
                            <td class="p-4 text-right">
                                <button @click="handleDelete(e)" class="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition"><i class="fas fa-trash"></i></button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div v-if="showModal" class="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 backdrop-blur-sm">
            <div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-md p-6 border dark:border-slate-700">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="font-bold text-xl text-slate-800 dark:text-white">Add Expense</h3>
                    <button @click="showModal = false" class="text-gray-400 hover:text-red-500"><i class="fas fa-times"></i></button>
                </div>

                <div class="space-y-4">
                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Date</label>
                            <input v-model="form.date" type="date" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none">
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Amount</label>
                            <input v-model="form.amount" type="number" step="0.01" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white font-bold text-red-500 outline-none">
                        </div>
                    </div>

                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Description</label>
                        <input v-model="form.description" placeholder="e.g. Monthly Rent" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none">
                    </div>

                    <div class="bg-gray-50 dark:bg-slate-900 p-3 rounded border dark:border-slate-700">
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-2">Attach Receipt (Image/PDF)</label>
                        <div class="flex items-center gap-2">
                            <label class="cursor-pointer bg-white dark:bg-slate-800 border dark:border-slate-600 hover:bg-gray-100 px-3 py-2 rounded text-sm font-bold shadow-sm text-slate-600 dark:text-slate-300">
                                <i class="fas fa-cloud-upload-alt mr-2"></i> Choose File
                                <input type="file" accept="image/*,application/pdf" class="hidden" @change="handleFileSelect">
                            </label>
                            <span class="text-xs text-gray-500 truncate max-w-[150px]">{{ form.file ? form.file.name : 'No file chosen' }}</span>
                        </div>
                    </div>

                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Category</label>
                            <select v-model="form.category" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none">
                                <option v-for="c in categories" :value="c">{{ c }}</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Payment</label>
                            <select v-model="form.paymentMethod" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none">
                                <option>Cash</option>
                                <option>Bank Transfer</option>
                                <option>Credit Card</option>
                                <option>DuitNow QR</option>
                            </select>
                        </div>
                    </div>
                </div>

                <div class="mt-8 flex justify-end gap-3">
                    <button @click="showModal = false" class="px-4 py-2 text-gray-500 font-bold hover:bg-gray-100 dark:hover:bg-slate-700 rounded transition">Cancel</button>
                    <button @click="saveExpense" class="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded font-bold shadow-lg transition">
                        {{ form.file ? 'Save & Upload' : 'Save Expense' }}
                    </button>
                </div>
            </div>
        </div>

        <div v-if="showReceiptModal && activeReceipt" class="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-[60] backdrop-blur-sm p-4">
            <div class="bg-white dark:bg-slate-800 w-full max-w-4xl h-[80vh] rounded-lg shadow-2xl flex flex-col overflow-hidden">
                <div class="flex justify-between items-center p-4 bg-slate-900 text-white border-b border-slate-700">
                    <div>
                        <h3 class="font-bold">{{ activeReceipt.name }}</h3>
                        <p class="text-xs opacity-50">{{ activeReceipt.type }}</p>
                    </div>
                    <div class="flex gap-3">
                        <a :href="activeReceipt.url" target="_blank" download class="bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded text-xs font-bold flex items-center gap-2">
                            <i class="fas fa-download"></i> Download
                        </a>
                        <button @click="showReceiptModal = false" class="text-gray-400 hover:text-white text-xl"><i class="fas fa-times"></i></button>
                    </div>
                </div>
                
                <div class="flex-grow bg-gray-100 dark:bg-slate-900 flex items-center justify-center overflow-auto p-4 relative">
                    <img v-if="activeReceipt.type.startsWith('image/')" :src="activeReceipt.url" class="max-w-full max-h-full object-contain shadow-lg">
                    
                    <iframe v-else-if="activeReceipt.type === 'application/pdf'" :src="activeReceipt.url" class="w-full h-full shadow-lg border-0"></iframe>
                    
                    <div v-else class="text-center">
                        <i class="fas fa-file-alt text-6xl text-gray-400 mb-4"></i>
                        <p class="text-gray-500 mb-4">Preview not available for this file type.</p>
                        <a :href="activeReceipt.url" target="_blank" class="bg-blue-600 text-white px-4 py-2 rounded font-bold">Download File</a>
                    </div>
                </div>
            </div>
        </div>

    </div>
</template>