<script setup>
import { computed } from 'vue';
import { Store } from '../../store';
import { isPaid, businessDate, expenseRecords } from '../../domain/pos';

// 1. DATA SOURCES
const transactions = computed(() => Store.state.transactions);
const expenses = computed(() => expenseRecords(Store.state));
const currency = computed(() => Store.state.selectedCompany?.preferences?.currency || 'RM');

// --- HELPER FUNCTIONS ---
const isSameDay = (a,b) => businessDate(a) === businessDate(b);
const formatMoney = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 2. FINANCIAL ENGINE (Today vs Yesterday)
function getDailyStats(targetDate) {
    // A. Revenue (Money In)
    const sales = transactions.value.filter(t => isPaid(t) && isSameDay(t.date, targetDate));
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

// Growth Calculation (Surplus Growth)
const profitGrowth = computed(() => {
    if (yesterday.value.profit === 0) return today.value.profit > 0 ? 100 : 0;
    return ((today.value.profit - yesterday.value.profit) / Math.abs(yesterday.value.profit)) * 100;
});

// 3. CHART ENGINE (Last 7 Days Cash surplus)
const weeklyChart = computed(() => {
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const dateStr = businessDate(d);
        
        // Revenue
        const rev = transactions.value
            .filter(t => isPaid(t) && businessDate(t.date) === dateStr)
            .reduce((sum, t) => sum + Number(t.total), 0);
            
        // Expenses
        const exp = expenses.value
            .filter(e => businessDate(e.date) === dateStr)
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
    transactions.value.filter(t => isPaid(t)).forEach(tx => {
        (tx.items || []).forEach(item => {
            if (!tally[item.desc]) tally[item.desc] = { name: item.desc, qty: 0, revenue: 0 };
            tally[item.desc].qty += Number(item.qty);
            tally[item.desc].revenue += (item.price * item.qty);
        });
    });
    return Object.values(tally).sort((a, b) => b.qty - a.qty).slice(0, 5);
});
</script>

<template><div class="ed-page"><header class="ed-page-head"><div><div class="ed-eyebrow">WORKSPACE / ANALYTICS</div><h1>A clearer view of business.</h1><p>Cash coming in, spending going out, and the products customers love.</p></div><span class="ed-pill">{{ businessDate(new Date()) }}</span></header>
<div class="ed-metrics ed-metrics-three"><div class="ed-metric"><label>Collected today</label><strong><span class="ed-currency">{{ currency }}</span>{{ formatMoney(today.revenue) }}</strong><small>{{ today.count }} paid sales</small></div><div class="ed-metric"><label>Expenses today</label><strong><span class="ed-currency">{{ currency }}</span>{{ formatMoney(today.expense) }}</strong><small>Recorded business outgoings</small></div><div class="ed-metric"><label>Cash surplus today</label><strong><span class="ed-currency">{{ currency }}</span>{{ formatMoney(today.profit) }}</strong><small>{{ currency }} {{ formatMoney(today.profit-yesterday.profit) }} change from yesterday</small></div></div>
<div class="ed-two-col"><section><div class="ed-section-head"><h2>Seven days, in perspective.</h2><span class="ed-muted" style="font-size:11px">Cash surplus</span></div><div class="ed-surplus-chart" role="img" :aria-label="weeklyChart.map(d=>d.day+': '+currency+' '+formatMoney(d.profit)).join('; ')"><div v-for="bar in weeklyChart" :key="bar.date" class="ed-surplus-column"><div class="ed-surplus-plot"><div class="ed-surplus-bar" :style="{height:Math.max(.5,bar.height/2)+'%',top:bar.isNegative?'50%':(50-bar.height/2)+'%',background:bar.isNegative?'#b97459':'var(--ed-accent)'}" :title="currency+' '+formatMoney(bar.profit)"></div></div><strong>{{ bar.day }}</strong><small>{{ formatMoney(bar.profit) }}</small></div></div><p class="ed-muted" style="font-size:11px;margin-top:20px">Above the line: collected sales exceed expenses. Below: expenses exceed sales. Cash surplus excludes inventory valuation and is not net profit.</p></section><aside class="ed-side-section"><div class="ed-section-head"><h2>Customer favourites.</h2></div><div v-for="(prod,i) in topProducts" :key="prod.name" class="ed-row"><span class="ed-avatar">{{ i+1 }}</span><div style="flex:1;min-width:0"><strong>{{ prod.name }}</strong><small>{{ prod.qty }} sold · all time</small></div><span style="font-size:12px;white-space:nowrap">{{ currency }} {{ formatMoney(prod.revenue) }}</span></div><div v-if="!topProducts.length" class="ed-empty"><h3>Your first bestseller awaits.</h3><p>Completed sales will fill this view.</p></div></aside></div></div></template>
