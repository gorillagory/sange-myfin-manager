<script setup>
import { ref, computed, watch } from 'vue';
import SalesProjectDrawer from './SalesProjectDrawer.vue';

const props = defineProps(['transactions', 'currency', 'clients']); 
const emit = defineEmits(['edit', 'delete', 'mark-paid', 'convert', 'download', 'new-invoice']);
const activeTab = ref('invoice');
const selectedItems = ref([]); 
const projectFilter = ref('All Projects');

const drawerVisible = ref(false);
const drawerMode = ref('create');

const availableProjects = computed(() => {
    const projects = new Set(props.transactions.map(t => t.project).filter(Boolean));
    return ['All Projects', ...Array.from(projects)];
});

const displayedTransactions = computed(() => {
    let txs = props.transactions;

    if (projectFilter.value && projectFilter.value !== 'All Projects') {
        txs = txs.filter(t => t.project === projectFilter.value);
    }

    if (activeTab.value === 'quote') {
        return txs.filter(t => t.type === 'Quote').sort((a,b) => new Date(b.date) - new Date(a.date));
    } 
    if (activeTab.value === 'invoice') {
        return txs.filter(t => t.type === 'Invoice' && t.status !== 'Cleared').sort((a,b) => new Date(b.date) - new Date(a.date));
    }
    if (activeTab.value === 'receipt') {
        return txs.filter(t => t.type === 'Invoice' && t.status === 'Cleared').sort((a,b) => new Date(b.date) - new Date(a.date));
    }
    return [];
});

const drawerItems = computed(() => {
    if (projectFilter.value !== 'All Projects') {
        return props.transactions.filter(t => t.project === projectFilter.value);
    }
    return selectedItems.value;
});

watch(projectFilter, (newVal) => {
    if (newVal !== 'All Projects') {
        drawerMode.value = 'view';
        drawerVisible.value = true;
        selectedItems.value = []; 
    } else {
        drawerVisible.value = false;
        drawerMode.value = 'create';
    }
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

const money = (n) => (props.currency || 'RM') + ' ' + Number(n).toLocaleString('en-US', {minimumFractionDigits: 2});
const getClientName = (id) => props.clients.find(c => c.id === id)?.name || 'Unknown';
</script>

<template>
    <div class="flex-grow flex flex-col overflow-hidden relative w-full">
        
        <div class="px-4 sm:px-6 pt-4 flex gap-4 sm:gap-6 border-b dark:border-slate-700 bg-white dark:bg-slate-800 items-center overflow-x-auto whitespace-nowrap hide-scrollbar">
            <button @click="activeTab = 'invoice'" class="pb-3 border-b-2 text-sm font-bold transition" 
                :class="activeTab === 'invoice' ? 'border-emerald-500 text-emerald-600' : 'border-transparent text-gray-400 hover:text-gray-600'">Invoices</button>
            <button @click="activeTab = 'receipt'" class="pb-3 border-b-2 text-sm font-bold transition" 
                :class="activeTab === 'receipt' ? 'border-emerald-500 text-emerald-600' : 'border-transparent text-gray-400 hover:text-gray-600'">Paid</button>
            <button @click="activeTab = 'quote'" class="pb-3 border-b-2 text-sm font-bold transition" 
                :class="activeTab === 'quote' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-400 hover:text-gray-600'">Quotes</button>

            <div class="h-6 w-px bg-gray-200 dark:bg-slate-700 mx-1 sm:mx-2 hidden sm:block"></div>

            <div class="pb-2">
                <select v-model="projectFilter" class="bg-gray-100 dark:bg-slate-700 text-xs font-bold px-3 py-1.5 rounded-lg border-none outline-none cursor-pointer text-slate-600 dark:text-white hover:ring-2 ring-emerald-500 transition max-w-[120px] sm:max-w-none">
                    <option value="All Projects">All Projects</option>
                    <option v-for="p in availableProjects.filter(p => p !== 'All Projects')" :key="p" :value="p">{{ p }}</option>
                </select>
            </div>
            
            <div class="flex-grow"></div>
             <button @click="$emit('new-invoice', activeTab)" class="mb-2 bg-emerald-600 hover:bg-emerald-700 text-white px-3 sm:px-4 py-1.5 rounded-lg font-bold shadow-lg transition text-xs flex items-center gap-2">
                <i class="fas fa-plus"></i> <span class="hidden sm:inline">New</span>
             </button>
        </div>

        <div class="flex-grow overflow-y-auto p-4 sm:p-6 bg-gray-50 dark:bg-slate-900 pb-40 w-full"> 
            
            <div class="overflow-x-auto bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700">
                <table class="w-full text-left border-collapse min-w-[700px]">
                    <thead class="text-xs font-bold text-gray-400 uppercase border-b dark:border-slate-700 bg-gray-50 dark:bg-slate-900/50">
                        <tr>
                            <th class="p-4 w-10"><i class="fas fa-check-square"></i></th>
                            <th class="p-4">Document</th>
                            <th class="p-4">Project</th>
                            <th class="p-4">Client</th>
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
                                <div class="font-bold text-slate-700 dark:text-white">{{ t.number }}</div>
                                <div class="text-xs text-gray-400">{{ t.date }}</div>
                            </td>

                            <td class="p-4">
                                <span v-if="t.project" class="text-[10px] uppercase font-bold bg-indigo-50 text-indigo-600 px-2 py-1 rounded cursor-pointer hover:bg-indigo-100" @click="projectFilter = t.project">{{ t.project }}</span>
                                <span v-else class="text-gray-300 text-xs">-</span>
                            </td>

                            <td class="p-4 font-bold text-gray-600 dark:text-gray-300 truncate max-w-[150px]">{{ getClientName(t.client_id) }}</td>
                            <td class="p-4 text-right font-mono font-bold text-slate-700 dark:text-gray-200 whitespace-nowrap">{{ money(t.total) }}</td>
                            <td class="p-4 text-center">
                                <span class="px-2 py-1 rounded text-[10px] font-bold uppercase whitespace-nowrap"
                                    :class="t.status === 'Cleared' ? 'bg-emerald-100 text-emerald-700' : (t.status === 'Converted' ? 'bg-purple-100 text-purple-700' : 'bg-yellow-100 text-yellow-700')">
                                    {{ t.status }}
                                </span>
                            </td>
                            <td class="p-4 text-right flex justify-end gap-3 md:opacity-0 group-hover:opacity-100 transition-opacity">
                                <button v-if="t.status !== 'Cleared' && t.type === 'Invoice'" @click="$emit('mark-paid', t)" class="text-emerald-500 hover:text-emerald-700 p-2" title="Mark Paid"><i class="fas fa-check-circle"></i></button>
                                <button v-if="t.type === 'Quote' && t.status !== 'Converted'" @click="$emit('convert', t)" class="text-purple-500 hover:text-purple-700 p-2" title="Convert to Invoice"><i class="fas fa-magic"></i></button>
                                <button @click="$emit('download', t)" class="text-gray-400 hover:text-gray-600 p-2"><i class="fas fa-file-pdf"></i></button>
                                <button @click="$emit('edit', t)" class="text-blue-500 hover:text-blue-700 p-2"><i class="fas fa-edit"></i></button>
                                <button @click="$emit('delete', t.id)" class="text-red-400 hover:text-red-600 p-2"><i class="fas fa-trash"></i></button>
                            </td>
                        </tr>
                        <tr v-if="displayedTransactions.length === 0"><td colspan="7" class="text-center py-10 text-gray-400 italic">No documents found.</td></tr>
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