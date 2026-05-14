<script setup>
import { ref, computed } from 'vue';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';
import { Pie } from 'vue-chartjs';
import { Store } from '../../../../store';

ChartJS.register(ArcElement, Tooltip, Legend);

const props = defineProps(['items', 'currency', 'mode', 'title']); 
const emit = defineEmits(['clear', 'refresh', 'close']);

const projectName = ref('');
const isSaving = ref(false);

// --- FIXED ANALYTICS ENGINE ---
const stats = computed(() => {
    const txs = props.items || [];
    const sum = (arr) => arr.reduce((acc, curr) => acc + Number(curr.total || 0), 0);

    // 1. INVOICES (Booked Revenue)
    const invoices = txs.filter(i => i.type === 'Invoice');
    const unpaid = invoices.filter(i => i.status !== 'Cleared');
    const paid = invoices.filter(i => i.status === 'Cleared');

    // 2. QUOTES (Pipeline Revenue)
    // CRITICAL FIX: Only count 'Pending' quotes. 
    // 'Converted' quotes are ignored because their value is already in the 'invoices' array.
    const activeQuotes = txs.filter(i => i.type === 'Quote' && i.status === 'Pending');

    return {
        quotes: { count: activeQuotes.length, val: sum(activeQuotes) },
        unpaid: { count: unpaid.length, val: sum(unpaid) },
        paid: { count: paid.length, val: sum(paid) },
        
        // TOTAL = Booked Revenue + Pipeline Revenue (Excluding converted duplicates)
        total: sum(invoices) + sum(activeQuotes)
    };
});

// --- CHART DATA ---
const chartData = computed(() => ({
    labels: ['Paid', 'Due', 'Pipeline (Quotes)'],
    datasets: [{
        backgroundColor: ['#10b981', '#ef4444', '#94a3b8'], // Green, Red, Slate (Pipeline)
        data: [stats.value.paid.val, stats.value.unpaid.val, stats.value.quotes.val]
    }]
}));

const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: 'right', labels: { boxWidth: 10, usePointStyle: true } } }
};

// --- ACTIONS ---
async function saveProject() {
    if (!projectName.value) return alert("Please enter a project name");
    isSaving.value = true;
    
    await Store.assignProject({
        ids: props.items.map(i => i.id),
        projectName: projectName.value
    });
    
    isSaving.value = false;
    projectName.value = '';
    emit('refresh'); 
}

const format = (n) => (props.currency || 'RM') + ' ' + n.toLocaleString('en-US', { minimumFractionDigits: 2 });
</script>

<template>
    <div v-if="items && items.length > 0" class="absolute bottom-0 left-0 right-0 bg-white dark:bg-slate-800 shadow-[0_-10px_40px_rgba(0,0,0,0.2)] z-50 rounded-t-2xl border-t dark:border-slate-700 animate-slide-up max-h-[60vh] overflow-y-auto">
        
        <div class="max-w-7xl mx-auto p-6 flex flex-col md:flex-row gap-8">
            
            <div class="w-full md:w-1/4 h-40 flex items-center justify-center">
                 <Pie :data="chartData" :options="chartOptions" />
            </div>

            <div class="flex-grow grid grid-cols-2 md:grid-cols-4 gap-4 items-center">
                <div class="p-4 rounded-lg bg-gray-50 dark:bg-slate-700 text-center">
                    <div class="text-[10px] uppercase font-bold text-gray-500 mb-1">Project Value</div>
                    <div class="text-xl font-black text-slate-800 dark:text-white">{{ format(stats.total) }}</div>
                    <div class="text-xs text-gray-400">{{ items.length }} Items</div>
                </div>

                <div class="text-center border-r dark:border-slate-700">
                    <div class="text-xs font-bold text-emerald-600 uppercase">Paid</div>
                    <div class="font-bold text-lg dark:text-white">{{ format(stats.paid.val) }}</div>
                </div>

                <div class="text-center border-r dark:border-slate-700">
                    <div class="text-xs font-bold text-red-500 uppercase">Due</div>
                    <div class="font-bold text-lg dark:text-white">{{ format(stats.unpaid.val) }}</div>
                </div>

                <div class="text-center">
                    <div class="text-xs font-bold text-slate-400 uppercase">Pipeline</div>
                    <div class="font-bold text-lg dark:text-white">{{ format(stats.quotes.val) }}</div>
                    <div class="text-[10px] text-gray-400">Potential</div>
                </div>
            </div>

            <div class="w-full md:w-1/3 bg-gray-100 dark:bg-slate-900 p-4 rounded-xl flex flex-col justify-between transition-all">
                
                <div v-if="mode === 'view'">
                    <label class="text-xs font-bold text-gray-500 uppercase mb-2 block">Active Project</label>
                    <div class="font-black text-xl text-emerald-600 truncate"><i class="fas fa-folder-open mr-2"></i>{{ title }}</div>
                    <p class="text-xs text-gray-400 mt-1">
                        Displaying <strong>booked</strong> revenue and <strong>active</strong> pipeline only.
                    </p>
                </div>

                <div v-else>
                    <label class="text-xs font-bold text-gray-500 uppercase mb-2 block">Group Selection & Save</label>
                    <div class="flex gap-2">
                        <input v-model="projectName" placeholder="New Project Name..." class="w-full bg-white dark:bg-slate-800 border-none rounded p-2 text-sm outline-none shadow-sm focus:ring-2 ring-emerald-500 dark:text-white">
                        <button @click="saveProject" :disabled="isSaving" class="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded font-bold shadow transition disabled:opacity-50">
                            {{ isSaving ? '...' : 'Save' }}
                        </button>
                    </div>
                </div>

                <div class="flex justify-between items-end mt-4">
                    <button class="text-xs text-gray-400 hover:text-slate-800 dark:hover:text-white font-bold underline">Export Report</button>
                    <button @click="$emit('close')" class="text-red-400 hover:text-red-600 text-sm font-bold bg-white dark:bg-slate-800 px-3 py-1 rounded shadow-sm hover:shadow">Close Panel</button>
                </div>
            </div>

        </div>
    </div>
</template>

<style scoped>
.animate-slide-up { animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
</style>