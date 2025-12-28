<script setup>
import { computed } from 'vue';
import { Store } from '../../store';

// --- SMART FILTERING ---
const logs = computed(() => {
    const allLogs = Store.state.activities || [];
    const currentUser = Store.state.currentUser;
    const currentCompany = Store.state.selectedCompany;

    // 1. If Super Admin -> Show EVERYTHING
    if (currentUser && currentUser.role === 'super') {
        return allLogs;
    }

    // 2. If Company Admin -> Show ONLY my company's logs
    if (currentCompany) {
        return allLogs.filter(log => 
            // Match by ID (New logs)
            log.company_id === currentCompany.id || 
            // OR Match by Name (Old logs fallback)
            log.company === currentCompany.name
        );
    }

    // 3. Fallback (No company selected) -> Show nothing
    return [];
});

function getActionColor(action) {
    if (action.includes('Delete')) return 'text-red-500 bg-red-100';
    if (action.includes('Create')) return 'text-emerald-500 bg-emerald-100';
    if (action.includes('Update')) return 'text-blue-500 bg-blue-100';
    return 'text-gray-500 bg-gray-100';
}
</script>

<template>
    <div class="max-w-5xl mx-auto no-print">
        <div class="flex justify-between items-center mb-6">
            <h2 class="text-2xl font-bold text-slate-800 dark:text-white">Audit Log</h2>
            <div class="text-xs text-gray-500">
                Showing {{ logs.length }} events
                <span v-if="Store.state.currentUser.role !== 'super'">(Filtered for {{ Store.state.selectedCompany?.name }})</span>
            </div>
        </div>
        
        <div class="bg-white dark:bg-slate-800 shadow rounded-lg overflow-hidden border dark:border-slate-700">
            <div v-if="logs.length === 0" class="p-8 text-center text-gray-400">
                No activity recorded for this workspace.
            </div>
            
            <div v-else class="divide-y dark:divide-slate-700">
                <div v-for="log in logs" :key="log.id" class="p-4 hover:bg-gray-50 dark:hover:bg-slate-700/50 transition flex items-start gap-4">
                    
                    <div class="h-10 w-10 rounded-full flex items-center justify-center shrink-0" :class="getActionColor(log.action)">
                        <i class="fas" :class="log.action.includes('Delete') ? 'fa-trash' : (log.action.includes('Create') ? 'fa-plus' : 'fa-info')"></i>
                    </div>

                    <div class="flex-grow">
                        <div class="flex justify-between items-start">
                            <div class="font-bold text-slate-700 dark:text-white">{{ log.action }}</div>
                            <div class="text-xs text-gray-400 font-mono">{{ new Date(log.date).toLocaleString() }}</div>
                        </div>
                        <div class="text-sm text-slate-600 dark:text-gray-300 mt-1">{{ log.details }}</div>
                        <div class="text-xs text-gray-400 mt-2 flex gap-4">
                            <span><i class="fas fa-user mr-1"></i> {{ log.user }}</span>
                            <span v-if="Store.state.currentUser.role === 'super'">
                                <i class="fas fa-building mr-1"></i> {{ log.company }}
                            </span>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    </div>
</template>