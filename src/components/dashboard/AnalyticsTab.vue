<script setup>
import { computed } from 'vue';
import { Store } from '../../store';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement
} from 'chart.js';
import { Line, Bar, Doughnut } from 'vue-chartjs';

// Register Chart components
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Title, Tooltip, Legend, ArcElement);

// --- DATA SOURCE ---
const transactions = computed(() => Store.state.transactions);
const activeCompany = computed(() => Store.state.selectedCompany || {});
const currency = computed(() => activeCompany.value.preferences?.currency || 'RM');

// --- 1. REVENUE TREND (Line Chart) ---
const trendData = computed(() => {
    // Group by Month (Last 6 months)
    const months = {};
    const today = new Date();
    for (let i = 5; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const key = d.toLocaleString('default', { month: 'short' });
        months[key] = 0;
    }

    transactions.value.forEach(t => {
        if (t.type === 'Invoice' || t.type === 'Invoice (POS)') { // POS usually saves as Invoice type
            const d = new Date(t.date);
            const key = d.toLocaleString('default', { month: 'short' });
            if (months[key] !== undefined) months[key] += Number(t.total);
        }
    });

    return {
        labels: Object.keys(months),
        datasets: [{
            label: 'Total Revenue',
            backgroundColor: '#10b981',
            borderColor: '#10b981',
            data: Object.values(months),
            tension: 0.4
        }]
    };
});

// --- 2. SALES BY CATEGORY (Hardware vs Service vs POS) ---
const categoryData = computed(() => {
    const stats = { 'Hardware': 0, 'Service': 0, 'POS Walk-in': 0, 'Other': 0 };
    
    transactions.value.forEach(t => {
        // Look inside items to find type
        if (t.items && t.items.length > 0) {
            t.items.forEach(item => {
                const type = item.type || (t.number.startsWith('POS') ? 'POS Walk-in' : 'Other');
                const amt = Number(item.price) * Number(item.qty);
                
                // Normalize keys
                if (type.toLowerCase().includes('hardware')) stats['Hardware'] += amt;
                else if (type.toLowerCase().includes('service')) stats['Service'] += amt;
                else if (t.number.startsWith('POS')) stats['POS Walk-in'] += amt;
                else stats['Other'] += amt;
            });
        }
    });

    return {
        labels: Object.keys(stats),
        datasets: [{
            backgroundColor: ['#3b82f6', '#8b5cf6', '#10b981', '#9ca3af'],
            data: Object.values(stats)
        }]
    };
});

// --- 3. TOP PRODUCTS (Bar Chart) ---
const productData = computed(() => {
    const productStats = {};
    
    transactions.value.forEach(t => {
        if (t.items) {
            t.items.forEach(i => {
                if (!productStats[i.desc]) productStats[i.desc] = 0;
                productStats[i.desc] += i.qty;
            });
        }
    });

    // Sort and take Top 5
    const sorted = Object.entries(productStats).sort((a,b) => b[1] - a[1]).slice(0, 5);

    return {
        labels: sorted.map(x => x[0].substring(0, 15) + '...'), // Truncate names
        datasets: [{
            label: 'Units Sold',
            backgroundColor: '#f43f5e',
            data: sorted.map(x => x[1])
        }]
    };
});

const chartOptions = { responsive: true, maintainAspectRatio: false };
</script>

<template>
    <div class="h-full overflow-y-auto no-print">
        <h2 class="text-2xl font-bold text-slate-800 dark:text-white mb-6">Business Intelligence</h2>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div class="bg-white dark:bg-slate-800 p-6 rounded-xl shadow border-l-4 border-emerald-500">
                <div class="text-gray-500 text-sm font-bold uppercase">Total Revenue (All Time)</div>
                <div class="text-3xl font-bold text-slate-800 dark:text-white mt-2">{{ currency }} {{ transactions.reduce((sum, t) => sum + (t.type === 'Invoice' ? Number(t.total) : 0), 0).toLocaleString() }}</div>
            </div>
            <div class="bg-white dark:bg-slate-800 p-6 rounded-xl shadow border-l-4 border-blue-500">
                <div class="text-gray-500 text-sm font-bold uppercase">Invoices Issued</div>
                <div class="text-3xl font-bold text-slate-800 dark:text-white mt-2">{{ transactions.length }}</div>
            </div>
            <div class="bg-white dark:bg-slate-800 p-6 rounded-xl shadow border-l-4 border-purple-500">
                <div class="text-gray-500 text-sm font-bold uppercase">Avg. Sale Value</div>
                <div class="text-3xl font-bold text-slate-800 dark:text-white mt-2">{{ currency }} {{ (transactions.length ? (transactions.reduce((sum, t) => sum + Number(t.total), 0) / transactions.length) : 0).toFixed(0) }}</div>
            </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
            <div class="bg-white dark:bg-slate-800 p-6 rounded-xl shadow h-80">
                <h3 class="font-bold text-slate-700 dark:text-white mb-4">Revenue Trend (6 Months)</h3>
                <Line :data="trendData" :options="chartOptions" />
            </div>

            <div class="bg-white dark:bg-slate-800 p-6 rounded-xl shadow h-80">
                <h3 class="font-bold text-slate-700 dark:text-white mb-4">Sales Mix (Hardware vs Service)</h3>
                <div class="h-64 flex justify-center">
                    <Doughnut :data="categoryData" :options="chartOptions" />
                </div>
            </div>
        </div>

        <div class="bg-white dark:bg-slate-800 p-6 rounded-xl shadow h-96">
            <h3 class="font-bold text-slate-700 dark:text-white mb-4">Top 5 Best Sellers</h3>
            <Bar :data="productData" :options="chartOptions" />
        </div>

    </div>
</template>