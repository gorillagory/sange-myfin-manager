<script setup>
import { computed } from 'vue';
import { Store } from '../../store';

const activeCompany = computed(() => Store.state.selectedCompany || {});

// 1. GET PREFS
const companyPrefs = computed(() => {
    return { currency: 'RM', ...(activeCompany.value.preferences || {}) };
});

const allTransactions = computed(() => {
    return Store.state.transactions
        .filter(t => t.company_id === activeCompany.value.id)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
});

const financials = computed(() => {
    let income = 0;
    let expenses = 0;

    allTransactions.value.forEach(t => {
        if (t.type === 'Invoice') {
            income += Number(t.total || 0);
        }
        else if (t.type === 'Expense' || t.type === 'Payment Voucher') {
            expenses += Number(t.total || 0);
        }
    });

    return {
        income,
        expenses,
        profit: income - expenses,
        margin: income > 0 ? ((income - expenses) / income) * 100 : 0
    };
});

const recentActivity = computed(() => allTransactions.value.slice(0, 5));

function formatMoney(amount) {
    // 2. USE DYNAMIC CURRENCY
    return companyPrefs.value.currency + ' ' + Number(amount).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

function getTypeColor(type) {
    if (type === 'Invoice') return 'text-emerald-600 bg-emerald-100';
    if (type === 'Quote') return 'text-blue-600 bg-blue-100';
    return 'text-rose-600 bg-rose-100';
}
</script>

<template>
    <div class="max-w-7xl mx-auto no-print">
        
        <div class="mb-8 flex justify-between items-end">
            <div>
                <h1 class="text-3xl font-bold text-slate-800 dark:text-white">Dashboard</h1>
                <p class="text-gray-500 dark:text-gray-400 mt-1">Financial Overview for <span class="font-bold text-emerald-600">{{ activeCompany.name }}</span></p>
            </div>
            <div class="text-right hidden sm:block">
                <div class="text-xs font-bold text-gray-400 uppercase">Today</div>
                <div class="font-mono font-bold dark:text-white">{{ new Date().toLocaleDateString() }}</div>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div class="bg-white dark:bg-slate-800 p-6 rounded-lg shadow border-b-4 border-emerald-500">
                <div class="flex justify-between items-start mb-4">
                    <div>
                        <div class="text-xs font-bold text-gray-400 uppercase tracking-wider">Total Revenue</div>
                        <div class="text-2xl font-bold text-slate-800 dark:text-white mt-1">{{ formatMoney(financials.income) }}</div>
                    </div>
                    <div class="p-2 bg-emerald-100 rounded text-emerald-600"><i class="fas fa-arrow-up"></i></div>
                </div>
            </div>

            <div class="bg-white dark:bg-slate-800 p-6 rounded-lg shadow border-b-4 border-rose-500">
                <div class="flex justify-between items-start mb-4">
                    <div>
                        <div class="text-xs font-bold text-gray-400 uppercase tracking-wider">Total Expenses</div>
                        <div class="text-2xl font-bold text-slate-800 dark:text-white mt-1">{{ formatMoney(financials.expenses) }}</div>
                    </div>
                    <div class="p-2 bg-rose-100 rounded text-rose-600"><i class="fas fa-arrow-down"></i></div>
                </div>
            </div>

            <div class="bg-slate-800 dark:bg-slate-700 p-6 rounded-lg shadow border-b-4" :class="financials.profit >= 0 ? 'border-emerald-400' : 'border-rose-500'">
                <div class="flex justify-between items-start mb-4">
                    <div>
                        <div class="text-xs font-bold text-slate-400 uppercase tracking-wider">Net Profit</div>
                        <div class="text-3xl font-bold text-white mt-1" :class="financials.profit >= 0 ? 'text-emerald-400' : 'text-rose-400'">
                            {{ formatMoney(financials.profit) }}
                        </div>
                    </div>
                    <div class="text-right">
                        <div class="text-xs font-bold text-slate-400 uppercase">Margin</div>
                        <div class="font-bold text-white">{{ financials.margin.toFixed(1) }}%</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
            
            <div class="lg:col-span-2 bg-white dark:bg-slate-800 rounded-lg shadow p-6">
                <h3 class="font-bold text-lg text-slate-800 dark:text-white mb-6">Financial Health</h3>
                
                <div class="space-y-6">
                    <div>
                        <div class="flex justify-between text-sm mb-1">
                            <span class="font-bold text-emerald-600">Income</span>
                            <span class="text-gray-500">{{ Math.round((financials.income / (financials.income + financials.expenses || 1)) * 100) }}%</span>
                        </div>
                        <div class="w-full bg-gray-200 rounded-full h-4 dark:bg-gray-700 overflow-hidden">
                            <div class="bg-emerald-500 h-4 rounded-full transition-all duration-1000" :style="{ width: (financials.income / (financials.income + financials.expenses || 1) * 100) + '%' }"></div>
                        </div>
                    </div>

                    <div>
                        <div class="flex justify-between text-sm mb-1">
                            <span class="font-bold text-rose-500">Expenses</span>
                            <span class="text-gray-500">{{ Math.round((financials.expenses / (financials.income + financials.expenses || 1)) * 100) }}%</span>
                        </div>
                        <div class="w-full bg-gray-200 rounded-full h-4 dark:bg-gray-700 overflow-hidden">
                            <div class="bg-rose-500 h-4 rounded-full transition-all duration-1000" :style="{ width: (financials.expenses / (financials.income + financials.expenses || 1) * 100) + '%' }"></div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="bg-white dark:bg-slate-800 rounded-lg shadow p-6">
                <h3 class="font-bold text-lg text-slate-800 dark:text-white mb-4">Recent Activity</h3>
                <div class="space-y-4">
                    <div v-for="t in recentActivity" :key="t.id" class="flex items-center justify-between p-3 rounded hover:bg-gray-50 dark:hover:bg-slate-700 transition">
                        <div class="flex items-center gap-3">
                            <div class="h-10 w-10 rounded-full flex items-center justify-center text-lg shrink-0" :class="getTypeColor(t.type)">
                                <i :class="t.type === 'Invoice' ? 'fas fa-arrow-up' : (t.type === 'Quote' ? 'fas fa-file-alt' : 'fas fa-arrow-down')"></i>
                            </div>
                            <div class="overflow-hidden">
                                <div class="font-bold text-sm text-slate-800 dark:text-white truncate w-32">{{ t.client_id ? 'Client #' + t.client_id : (t.payee || 'Unknown') }}</div>
                                <div class="text-xs text-gray-500">{{ new Date(t.date).toLocaleDateString() }}</div>
                            </div>
                        </div>
                        <div class="text-right">
                            <div class="font-bold text-sm" :class="t.type === 'Expense' || t.type === 'Payment Voucher' ? 'text-rose-600' : 'text-emerald-600'">
                                {{ t.type === 'Expense' || t.type === 'Payment Voucher' ? '-' : '+' }} {{ companyPrefs.currency }} {{ Number(t.total).toFixed(0) }}
                            </div>
                            <div class="text-[10px] uppercase font-bold text-gray-400">{{ t.type }}</div>
                        </div>
                    </div>
                    <div v-if="recentActivity.length === 0" class="text-center text-gray-400 text-sm py-4 italic">No activity yet.</div>
                </div>
            </div>

        </div>
    </div>
</template>