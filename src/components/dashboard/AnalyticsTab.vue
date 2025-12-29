<script setup>
import { computed } from 'vue';
import { Store } from '../../store';

// 1. DATA SOURCES
const transactions = computed(() => Store.state.transactions);
const expenses = computed(() => Store.state.expenses);
const currency = computed(() => Store.state.selectedCompany?.preferences?.currency || 'RM');

// --- HELPER FUNCTIONS ---
const isSameDay = (d1, d2) => {
    const date1 = new Date(d1); const date2 = new Date(d2);
    return date1.getDate() === date2.getDate() && date1.getMonth() === date2.getMonth() && date1.getFullYear() === date2.getFullYear();
};
const formatMoney = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 2. FINANCIAL ENGINE (Today vs Yesterday)
function getDailyStats(targetDate) {
    // A. Revenue (Money In)
    const sales = transactions.value.filter(t => t.status === 'Paid' && isSameDay(t.date, targetDate));
    const revenue = sales.reduce((sum, t) => sum + Number(t.total), 0);
    
    // B. Expenses (Money Out)
    const costs = expenses.value.filter(e => isSameDay(e.date, targetDate));
    const expenseTotal = costs.reduce((sum, e) => sum + Number(e.amount), 0);

    return { 
        revenue, 
        expense: expenseTotal, 
        profit: revenue - expenseTotal,
        count: sales.length 
    };
}

const today = computed(() => getDailyStats(new Date()));
const yesterday = computed(() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return getDailyStats(d);
});

// Growth Calculation (Profit Growth)
const profitGrowth = computed(() => {
    if (yesterday.value.profit === 0) return today.value.profit > 0 ? 100 : 0;
    return ((today.value.profit - yesterday.value.profit) / Math.abs(yesterday.value.profit)) * 100;
});

// 3. CHART ENGINE (Last 7 Days Net Profit)
const weeklyChart = computed(() => {
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        
        // Revenue
        const rev = transactions.value
            .filter(t => t.status === 'Paid' && t.date.startsWith(dateStr))
            .reduce((sum, t) => sum + Number(t.total), 0);
            
        // Expenses
        const exp = expenses.value
            .filter(e => e.date === dateStr)
            .reduce((sum, e) => sum + Number(e.amount), 0);

        const profit = rev - exp;
        
        days.push({ 
            day: d.toLocaleDateString('en-US', { weekday: 'short' }), 
            date: dateStr, 
            profit: profit,
            isNegative: profit < 0
        });
    }
    
    // Normalization for Bar Height (Handle negatives gracefully)
    const maxVal = Math.max(...days.map(d => Math.abs(d.profit))) || 1;
    return days.map(d => ({ ...d, height: (Math.abs(d.profit) / maxVal) * 100 }));
});

// 4. TOP PRODUCTS
const topProducts = computed(() => {
    const tally = {};
    transactions.value.filter(t => t.status === 'Paid').forEach(tx => {
        tx.items.forEach(item => {
            if (!tally[item.desc]) tally[item.desc] = { name: item.desc, qty: 0, revenue: 0 };
            tally[item.desc].qty += item.qty;
            tally[item.desc].revenue += (item.price * item.qty);
        });
    });
    return Object.values(tally).sort((a, b) => b.qty - a.qty).slice(0, 5);
});
</script>

<template>
    <div class="space-y-6">
        <div class="flex justify-between items-end">
            <div>
                <h2 class="text-2xl font-bold text-slate-800 dark:text-white">Business Intelligence</h2>
                <p class="text-sm text-gray-500">P&L Overview for <span class="font-bold text-emerald-600">{{ new Date().toLocaleDateString() }}</span></p>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div class="bg-white dark:bg-slate-800 p-6 rounded-xl shadow border-l-4 border-emerald-500 relative overflow-hidden group">
                <div class="absolute right-0 top-0 p-4 opacity-5 group-hover:opacity-10 transition"><i class="fas fa-wallet text-6xl"></i></div>
                <div class="text-xs font-bold text-gray-400 uppercase tracking-wider">Gross Revenue</div>
                <div class="text-2xl font-bold text-slate-800 dark:text-white mt-1">{{ currency }} {{ formatMoney(today.revenue) }}</div>
                <div class="mt-2 text-xs text-emerald-600 font-bold flex items-center gap-1">
                    <i class="fas fa-arrow-up"></i> {{ today.count }} Transactions
                </div>
            </div>

            <div class="bg-white dark:bg-slate-800 p-6 rounded-xl shadow border-l-4 border-red-500 relative overflow-hidden group">
                <div class="absolute right-0 top-0 p-4 opacity-5 group-hover:opacity-10 transition"><i class="fas fa-file-invoice text-6xl"></i></div>
                <div class="text-xs font-bold text-gray-400 uppercase tracking-wider">Total Expenses</div>
                <div class="text-2xl font-bold text-red-500 mt-1">{{ currency }} {{ formatMoney(today.expense) }}</div>
                <div class="mt-2 text-xs text-red-400 font-bold opacity-80">
                    Money Out Today
                </div>
            </div>

            <div class="bg-white dark:bg-slate-800 p-6 rounded-xl shadow border-l-4 relative overflow-hidden group"
                 :class="today.profit >= 0 ? 'border-blue-500' : 'border-orange-500'">
                <div class="absolute right-0 top-0 p-4 opacity-5 group-hover:opacity-10 transition"><i class="fas fa-piggy-bank text-6xl"></i></div>
                <div class="text-xs font-bold text-gray-400 uppercase tracking-wider">Net Profit</div>
                <div class="text-3xl font-bold mt-1" :class="today.profit >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-orange-500'">
                    {{ currency }} {{ formatMoney(today.profit) }}
                </div>
                <div class="mt-2 text-xs font-bold flex items-center gap-1" :class="profitGrowth >= 0 ? 'text-emerald-500' : 'text-red-500'">
                    <i class="fas" :class="profitGrowth >= 0 ? 'fa-chart-line' : 'fa-chart-line-down'"></i>
                    <span>{{ Math.abs(profitGrowth).toFixed(0) }}% vs Yesterday</span>
                </div>
            </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div class="lg:col-span-2 bg-white dark:bg-slate-800 p-6 rounded-xl shadow border dark:border-slate-700 flex flex-col">
                <h3 class="font-bold text-slate-700 dark:text-white mb-6">7-Day Net Profit Trend</h3>
                
                <div class="flex-grow flex items-end justify-between gap-3 h-64 pb-2 border-b dark:border-slate-700">
                    <div v-for="bar in weeklyChart" :key="bar.date" class="w-full flex flex-col justify-end group cursor-default relative h-full">
                        
                        <div class="absolute bottom-1/2 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-xs py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition whitespace-nowrap z-20 font-bold mb-2">
                            {{ currency }} {{ formatMoney(bar.profit) }}
                        </div>
                        
                        <div class="h-full flex flex-col justify-end relative">
                            <div v-if="!bar.isNegative" class="w-full bg-blue-100 dark:bg-blue-900/30 rounded-t-sm relative overflow-hidden transition-all duration-500 group-hover:bg-blue-200" 
                                 :style="{ height: bar.height + '%' }">
                                <div class="absolute bottom-0 left-0 w-full bg-blue-500 transition-all duration-1000" style="height: 100%"></div>
                            </div>
                            
                            <div v-else class="w-full bg-red-100 dark:bg-red-900/30 rounded-t-sm relative overflow-hidden transition-all duration-500 group-hover:bg-red-200" 
                                 :style="{ height: bar.height + '%' }">
                                <div class="absolute bottom-0 left-0 w-full bg-red-500 transition-all duration-1000" style="height: 100%"></div>
                            </div>
                        </div>
                        
                        <div class="text-center text-[10px] text-gray-400 mt-2 font-bold uppercase tracking-wider">{{ bar.day }}</div>
                    </div>
                </div>
            </div>

            <div class="bg-white dark:bg-slate-800 p-6 rounded-xl shadow border dark:border-slate-700">
                <h3 class="font-bold text-slate-700 dark:text-white mb-4">Top Performers</h3>
                <div class="space-y-3">
                    <div v-for="(prod, i) in topProducts" :key="i" class="flex items-center justify-between p-3 rounded-lg bg-gray-50 dark:bg-slate-700/30">
                        <div class="flex items-center gap-3">
                            <div class="w-6 h-6 rounded bg-emerald-100 text-emerald-600 flex items-center justify-center font-bold text-xs">
                                {{ i+1 }}
                            </div>
                            <div>
                                <div class="font-bold text-xs text-slate-800 dark:text-white line-clamp-1">{{ prod.name }}</div>
                                <div class="text-[10px] text-gray-400">{{ prod.qty }} Sold</div>
                            </div>
                        </div>
                        <div class="font-bold text-xs text-slate-600 dark:text-gray-300">{{ currency }} {{ formatMoney(prod.revenue) }}</div>
                    </div>
                    
                    <div v-if="topProducts.length === 0" class="text-center py-10 opacity-50">
                        <i class="fas fa-chart-bar text-4xl mb-2"></i>
                        <p class="text-xs">No sales yet.</p>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>