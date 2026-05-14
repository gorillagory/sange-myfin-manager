<script setup>
import { ref, computed, watch } from 'vue';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';
import { Doughnut } from 'vue-chartjs';
import SalesProjectDrawer from './SalesProjectDrawer.vue';

ChartJS.register(ArcElement, Tooltip, Legend);

const props = defineProps(['transactions', 'currency', 'clients']); 
const emit = defineEmits(['edit', 'delete', 'mark-paid', 'convert', 'download', 'new-invoice']);
const activeView = ref('sales');
const selectedItems = ref([]); 
const projectFilter = ref('All Projects');

const drawerVisible = ref(false);
const drawerMode = ref('create');

const availableProjects = computed(() => {
    const projects = new Set(props.transactions.map(t => t.project).filter(Boolean));
    return ['All Projects', ...Array.from(projects)];
});

const filteredTransactions = computed(() => {
    let txs = props.transactions;

    if (projectFilter.value && projectFilter.value !== 'All Projects') {
        txs = txs.filter(t => t.project === projectFilter.value);
    }

    return txs;
});

const quoteTransactions = computed(() => {
    return filteredTransactions.value
        .filter(t => t.type === 'Quote')
        .sort((a, b) => new Date(b.date) - new Date(a.date));
});

const salesTransactions = computed(() => {
    return filteredTransactions.value
        .filter(t => t.type === 'Invoice')
        .sort((a, b) => new Date(b.date) - new Date(a.date));
});

const displayedTransactions = computed(() => {
    return activeView.value === 'quotes' ? quoteTransactions.value : salesTransactions.value;
});

const drawerItems = computed(() => {
    if (projectFilter.value !== 'All Projects') {
        return props.transactions.filter(t => t.project === projectFilter.value);
    }
    return selectedItems.value;
});

watch(projectFilter, () => {
    selectedItems.value = [];
    if (drawerMode.value === 'view') drawerVisible.value = false;
});

watch(selectedItems, (newVal) => {
    if (newVal.length > 0 && projectFilter.value === 'All Projects') {
        drawerMode.value = 'create';
        drawerVisible.value = true;
    } else if (newVal.length === 0 && projectFilter.value === 'All Projects') {
        drawerVisible.value = false;
    }
}, { deep: true });

function toggleSelection(tx) {
    const idx = selectedItems.value.findIndex(t => t.id === tx.id);
    if (idx > -1) selectedItems.value.splice(idx, 1);
    else selectedItems.value.push(tx);
}

function openProjectSummary() {
    if (projectFilter.value === 'All Projects') return;
    drawerMode.value = 'view';
    drawerVisible.value = true;
}

const money = (n) => (props.currency || 'RM') + ' ' + Number(n).toLocaleString('en-US', {minimumFractionDigits: 2});
const getClientName = (id) => props.clients.find(c => c.id === id)?.name || 'Unknown';

function isStale(tx) {
    if (tx.status === 'Cleared' || tx.status === 'Converted') return false;
    const date = new Date(tx.date);
    if (Number.isNaN(date.getTime())) return false;
    const ageInDays = (Date.now() - date.getTime()) / 86400000;
    return ageInDays > 30;
}

function getDocAge(tx) {
    const date = new Date(tx.date);
    if (Number.isNaN(date.getTime())) return 'No date';
    const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
    if (days === 0) return 'Today';
    if (days === 1) return '1 day open';
    return `${days} days open`;
}

function summarize(items, completedStatus) {
    const completed = items.filter(t => t.status === completedStatus);
    const stale = items.filter(t => t.status !== completedStatus && isStale(t));
    const pending = items.filter(t => t.status !== completedStatus && !isStale(t));
    const totalValue = items.reduce((sum, t) => sum + Number(t.total || 0), 0);

    return {
        completed: completed.length,
        stale: stale.length,
        pending: pending.length,
        total: items.length,
        totalValue
    };
}

const quoteSummary = computed(() => summarize(quoteTransactions.value, 'Converted'));
const salesSummary = computed(() => summarize(salesTransactions.value, 'Cleared'));

function makeChartData(summary, completedLabel) {
    return {
        labels: [completedLabel, 'Pending', 'Stale'],
        datasets: [{
            backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
            borderColor: ['#ffffff', '#ffffff', '#ffffff'],
            borderWidth: 3,
            data: [summary.completed, summary.pending, summary.stale]
        }]
    };
}

const quoteChartData = computed(() => makeChartData(quoteSummary.value, 'Converted'));
const salesChartData = computed(() => makeChartData(salesSummary.value, 'Cleared'));
const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '68%',
    plugins: {
        legend: { display: false },
        tooltip: { enabled: true }
    }
};

function statusLabel(tx) {
    if (tx.type === 'Quote' && tx.status === 'Converted') return 'Converted';
    if (tx.type === 'Invoice' && tx.status === 'Cleared') return 'Cleared';
    return isStale(tx) ? 'Stale' : (tx.status || 'Pending');
}

function statusClass(tx) {
    const label = statusLabel(tx);
    if (label === 'Converted' || label === 'Cleared') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
    if (label === 'Stale') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
}

function viewTitle() {
    return activeView.value === 'quotes' ? 'Quotes' : 'Sales';
}

function emptyText() {
    return activeView.value === 'quotes' ? 'No quotes found for this view.' : 'No sales found for this view.';
}
</script>

<template>
    <div class="flex-grow flex flex-col overflow-hidden relative w-full">
        <div class="border-b dark:border-slate-700 bg-white dark:bg-slate-800 p-4 sm:p-6 space-y-5">
            <div class="flex flex-col xl:flex-row xl:items-end justify-between gap-4">
                <div>
                    <div class="text-xs font-bold uppercase tracking-wider text-gray-400 mb-1">Document View</div>
                    <div class="inline-flex rounded-xl bg-gray-100 dark:bg-slate-900 p-1 border dark:border-slate-700">
                        <button @click="activeView = 'sales'" class="px-4 py-2 rounded-lg text-sm font-bold transition"
                            :class="activeView === 'sales' ? 'bg-white dark:bg-slate-700 text-emerald-600 shadow-sm' : 'text-gray-500 hover:text-slate-700 dark:hover:text-white'">
                            <i class="fas fa-chart-line mr-2"></i>Sales
                        </button>
                        <button @click="activeView = 'quotes'" class="px-4 py-2 rounded-lg text-sm font-bold transition"
                            :class="activeView === 'quotes' ? 'bg-white dark:bg-slate-700 text-blue-600 shadow-sm' : 'text-gray-500 hover:text-slate-700 dark:hover:text-white'">
                            <i class="fas fa-file-signature mr-2"></i>Quotes
                        </button>
                    </div>
                </div>

                <div class="flex flex-col sm:flex-row gap-3 sm:items-end">
                    <div>
                        <label class="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1">Project</label>
                        <select v-model="projectFilter" class="w-full sm:w-64 bg-gray-100 dark:bg-slate-900 border dark:border-slate-700 rounded-xl px-4 py-2.5 outline-none cursor-pointer text-sm font-bold text-slate-700 dark:text-white focus:ring-2 ring-emerald-500 transition">
                            <option value="All Projects">All Projects</option>
                            <option v-for="p in availableProjects.filter(p => p !== 'All Projects')" :key="p" :value="p">{{ p }}</option>
                        </select>
                    </div>
                    <button v-if="projectFilter !== 'All Projects'" @click="openProjectSummary" class="bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:hover:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 px-4 py-2.5 rounded-xl font-bold text-sm transition">
                        <i class="fas fa-folder-open mr-2"></i>Project Summary
                    </button>
                    <button @click="$emit('new-invoice', activeView === 'quotes' ? 'quote' : 'sales')" class="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2.5 rounded-xl font-bold shadow-lg transition text-sm flex items-center justify-center gap-2">
                        <i class="fas fa-plus"></i> New {{ activeView === 'quotes' ? 'Quote' : 'Sale' }}
                    </button>
                </div>
            </div>

            <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <div class="rounded-xl border dark:border-slate-700 bg-slate-50 dark:bg-slate-900 p-4 flex items-center gap-4"
                    :class="activeView === 'sales' ? 'ring-2 ring-emerald-500/20' : ''">
                    <div class="relative h-28 w-28 shrink-0">
                        <Doughnut :data="salesChartData" :options="chartOptions" />
                        <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                            <div class="text-2xl font-black text-slate-800 dark:text-white">{{ salesSummary.total }}</div>
                            <div class="text-[10px] font-bold uppercase text-gray-400">Sales</div>
                        </div>
                    </div>
                    <div class="min-w-0 flex-grow">
                        <div class="flex justify-between gap-3 items-start mb-3">
                            <div>
                                <h3 class="font-black text-slate-800 dark:text-white">Sales</h3>
                                <p class="text-xs text-gray-500">Cleared, pending, and stale invoices.</p>
                            </div>
                            <div class="text-right font-bold text-slate-700 dark:text-white whitespace-nowrap">{{ money(salesSummary.totalValue) }}</div>
                        </div>
                        <div class="grid grid-cols-3 gap-2 text-xs">
                            <div class="rounded-lg bg-white dark:bg-slate-800 p-2"><span class="block text-gray-400 font-bold uppercase">Cleared</span><span class="font-black text-emerald-600">{{ salesSummary.completed }}</span></div>
                            <div class="rounded-lg bg-white dark:bg-slate-800 p-2"><span class="block text-gray-400 font-bold uppercase">Pending</span><span class="font-black text-amber-600">{{ salesSummary.pending }}</span></div>
                            <div class="rounded-lg bg-white dark:bg-slate-800 p-2"><span class="block text-gray-400 font-bold uppercase">Stale</span><span class="font-black text-red-600">{{ salesSummary.stale }}</span></div>
                        </div>
                    </div>
                </div>

                <div class="rounded-xl border dark:border-slate-700 bg-slate-50 dark:bg-slate-900 p-4 flex items-center gap-4"
                    :class="activeView === 'quotes' ? 'ring-2 ring-blue-500/20' : ''">
                    <div class="relative h-28 w-28 shrink-0">
                        <Doughnut :data="quoteChartData" :options="chartOptions" />
                        <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                            <div class="text-2xl font-black text-slate-800 dark:text-white">{{ quoteSummary.total }}</div>
                            <div class="text-[10px] font-bold uppercase text-gray-400">Quotes</div>
                        </div>
                    </div>
                    <div class="min-w-0 flex-grow">
                        <div class="flex justify-between gap-3 items-start mb-3">
                            <div>
                                <h3 class="font-black text-slate-800 dark:text-white">Quotes</h3>
                                <p class="text-xs text-gray-500">Converted, pending, and stale quotes.</p>
                            </div>
                            <div class="text-right font-bold text-slate-700 dark:text-white whitespace-nowrap">{{ money(quoteSummary.totalValue) }}</div>
                        </div>
                        <div class="grid grid-cols-3 gap-2 text-xs">
                            <div class="rounded-lg bg-white dark:bg-slate-800 p-2"><span class="block text-gray-400 font-bold uppercase">Converted</span><span class="font-black text-emerald-600">{{ quoteSummary.completed }}</span></div>
                            <div class="rounded-lg bg-white dark:bg-slate-800 p-2"><span class="block text-gray-400 font-bold uppercase">Pending</span><span class="font-black text-amber-600">{{ quoteSummary.pending }}</span></div>
                            <div class="rounded-lg bg-white dark:bg-slate-800 p-2"><span class="block text-gray-400 font-bold uppercase">Stale</span><span class="font-black text-red-600">{{ quoteSummary.stale }}</span></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div class="flex-grow overflow-y-auto p-4 sm:p-6 bg-gray-50 dark:bg-slate-900 pb-40 w-full">
            <div class="mb-4 flex flex-col sm:flex-row sm:items-end justify-between gap-2">
                <div>
                    <h2 class="text-xl font-black text-slate-800 dark:text-white">{{ viewTitle() }}</h2>
                    <p class="text-sm text-gray-500">
                        {{ displayedTransactions.length }} document{{ displayedTransactions.length === 1 ? '' : 's' }}
                        <span v-if="projectFilter !== 'All Projects'">in {{ projectFilter }}</span>
                    </p>
                </div>
                <div v-if="selectedItems.length" class="text-xs font-bold text-blue-600 bg-blue-50 dark:bg-blue-900/20 dark:text-blue-300 px-3 py-2 rounded-lg">
                    {{ selectedItems.length }} selected for project grouping
                </div>
            </div>

            <div class="overflow-x-auto bg-white dark:bg-slate-800 rounded-xl shadow-sm border dark:border-slate-700">
                <table class="w-full text-left border-collapse min-w-[860px]">
                    <thead class="text-xs font-bold text-gray-400 uppercase border-b dark:border-slate-700 bg-gray-50 dark:bg-slate-900/50">
                        <tr>
                            <th class="p-4 w-10"><i class="fas fa-check-square"></i></th>
                            <th class="p-4">Document</th>
                            <th class="p-4">Client</th>
                            <th class="p-4">Project</th>
                            <th class="p-4">Age</th>
                            <th class="p-4 text-right">Amount</th>
                            <th class="p-4 text-center">Status</th>
                            <th class="p-4 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody class="text-sm">
                        <tr v-for="t in displayedTransactions" :key="t.id" 
                            class="border-b dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50 transition group"
                            :class="selectedItems.find(i => i.id === t.id) ? 'bg-blue-50 dark:bg-blue-900/20' : ''">
                            
                            <td class="p-4">
                                <input type="checkbox" :checked="!!selectedItems.find(i => i.id === t.id)" @change="toggleSelection(t)" class="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer">
                            </td>
                            
                            <td class="p-4">
                                <div class="flex items-center gap-3">
                                    <div class="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
                                        :class="t.type === 'Quote' ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300' : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300'">
                                        <i class="fas" :class="t.type === 'Quote' ? 'fa-file-signature' : 'fa-file-invoice-dollar'"></i>
                                    </div>
                                    <div>
                                        <div class="font-black text-slate-800 dark:text-white">{{ t.number }}</div>
                                        <div class="text-xs text-gray-400">{{ t.date }} • {{ t.type }}</div>
                                    </div>
                                </div>
                            </td>

                            <td class="p-4">
                                <div class="font-bold text-slate-700 dark:text-gray-200 truncate max-w-[180px]">{{ getClientName(t.client_id) }}</div>
                                <div class="text-[10px] text-gray-400 uppercase tracking-wider">Client</div>
                            </td>

                            <td class="p-4">
                                <span v-if="t.project" class="text-[10px] uppercase font-bold bg-indigo-50 text-indigo-600 px-2 py-1 rounded cursor-pointer hover:bg-indigo-100" @click="projectFilter = t.project">{{ t.project }}</span>
                                <span v-else class="text-gray-300 text-xs italic">Unassigned</span>
                            </td>

                            <td class="p-4 text-xs font-bold text-gray-500 whitespace-nowrap">{{ getDocAge(t) }}</td>
                            <td class="p-4 text-right font-mono font-black text-slate-800 dark:text-gray-100 whitespace-nowrap">{{ money(t.total || 0) }}</td>
                            <td class="p-4 text-center">
                                <span class="px-2 py-1 rounded-full text-[10px] font-black uppercase whitespace-nowrap" :class="statusClass(t)">
                                    {{ statusLabel(t) }}
                                </span>
                            </td>
                            <td class="p-4 text-right">
                                <div class="flex justify-end gap-2 md:opacity-0 group-hover:opacity-100 transition-opacity">
                                <button v-if="t.status !== 'Cleared' && t.type === 'Invoice'" @click="$emit('mark-paid', t)" class="text-emerald-500 hover:text-emerald-700 p-2" title="Mark Paid"><i class="fas fa-check-circle"></i></button>
                                <button v-if="t.type === 'Quote' && t.status !== 'Converted'" @click="$emit('convert', t)" class="text-purple-500 hover:text-purple-700 p-2" title="Convert to Invoice"><i class="fas fa-magic"></i></button>
                                <button @click="$emit('download', t)" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-2" title="Download PDF"><i class="fas fa-file-pdf"></i></button>
                                <button @click="$emit('edit', t)" class="text-blue-500 hover:text-blue-700 p-2" title="Edit"><i class="fas fa-edit"></i></button>
                                <button @click="$emit('delete', t.id)" class="text-red-400 hover:text-red-600 p-2" title="Delete"><i class="fas fa-trash"></i></button>
                                </div>
                            </td>
                        </tr>
                        <tr v-if="displayedTransactions.length === 0"><td colspan="8" class="text-center py-12 text-gray-400 italic">{{ emptyText() }}</td></tr>
                    </tbody>
                </table>
            </div>
        </div>

        <SalesProjectDrawer 
            v-if="drawerVisible"
            :items="drawerItems"
            :currency="currency"
            :mode="drawerMode"
            :title="projectFilter"
            @close="drawerVisible = false; projectFilter = 'All Projects'"
            @clear="selectedItems = []"
            @refresh="selectedItems = []" 
        />
        
    </div>
</template>

<style scoped>
/* Hide scrollbar for Chrome, Safari and Opera */
.hide-scrollbar::-webkit-scrollbar {
  display: none;
}
/* Hide scrollbar for IE, Edge and Firefox */
.hide-scrollbar {
  -ms-overflow-style: none;  /* IE and Edge */
  scrollbar-width: none;  /* Firefox */
}
</style>
