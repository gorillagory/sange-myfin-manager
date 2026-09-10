<script setup>
const props = defineProps(['analytics', 'currency']);
const money = (n) => (props.currency || 'RM') + ' ' + Number(n || 0).toLocaleString('en-US', {minimumFractionDigits: 2});
</script>

<template>
    <div class="grid grid-cols-4 gap-4 mb-6">
        <div class="bg-slate-50 dark:bg-slate-700 p-3 rounded-lg border dark:border-slate-600">
            <div class="text-[10px] font-bold text-gray-400 uppercase">Total Billed</div>
            <div class="text-lg font-bold text-slate-800 dark:text-white">{{ money(analytics.totalRevenue) }}</div>
        </div>
         <div class="bg-emerald-50 dark:bg-emerald-900/20 p-3 rounded-lg border border-emerald-100 dark:border-emerald-800">
            <div class="text-[10px] font-bold text-emerald-600 uppercase">Collected</div>
            <div class="text-lg font-bold text-emerald-700 dark:text-emerald-400">{{ money(analytics.paidRevenue) }}</div>
        </div>
        <div class="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-100 dark:border-red-800">
            <div class="text-[10px] font-bold text-red-500 uppercase">Outstanding</div>
            <div class="text-lg font-bold text-red-600 dark:text-red-400">{{ money(analytics.outstanding) }}</div>
        </div>
        <div class="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-100 dark:border-blue-800">
            <div class="text-[10px] font-bold text-blue-500 uppercase">Open Quotes</div>
            <div class="text-lg font-bold text-blue-600 dark:text-blue-400">{{ analytics.pendingQuotes }} Active</div>
        </div>
    </div>
</template>