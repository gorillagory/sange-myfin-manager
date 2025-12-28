<script setup>
import { ref } from 'vue';

const props = defineProps(['show', 'heldCarts', 'recentSales', 'currency']);
const emit = defineEmits(['close', 'recall', 'deleteHeld', 'print', 'share']);

const activeTab = ref('hold');

function formatMoney(amount) {
    return Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
</script>

<template>
    <div v-if="show" class="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-[60] backdrop-blur-sm">
        <div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-2xl h-[500px] flex flex-col overflow-hidden animate-fade-in">
            <div class="flex border-b dark:border-slate-700">
                <button @click="activeTab='hold'" :class="activeTab==='hold' ? 'border-b-2 border-orange-500 text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-slate-700' : 'text-gray-500'" class="flex-1 py-4 font-bold text-center transition"><i class="fas fa-pause mr-2"></i> On Hold ({{ heldCarts.length }})</button>
                <button @click="activeTab='history'" :class="activeTab==='history' ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-slate-700' : 'text-gray-500'" class="flex-1 py-4 font-bold text-center transition"><i class="fas fa-history mr-2"></i> Recent Sales</button>
                <button @click="$emit('close')" class="px-6 text-gray-400 hover:text-red-500"><i class="fas fa-times text-xl"></i></button>
            </div>

            <div class="flex-grow overflow-y-auto p-4 bg-gray-50 dark:bg-slate-900">
                
                <div v-if="activeTab === 'hold'" class="space-y-3">
                    <div v-if="heldCarts.length === 0" class="text-center text-gray-400 mt-10">No orders on hold.</div>
                    <div v-for="(h, i) in heldCarts" :key="h.id" class="bg-white dark:bg-slate-800 p-4 rounded shadow flex justify-between items-center border-l-4 border-orange-400">
                        <div>
                            <div class="font-bold text-slate-800 dark:text-white">Order @ {{ h.time }}</div>
                            <div class="text-sm text-gray-500">{{ h.items.length }} items • {{ currency }} {{ formatMoney(h.total) }}</div>
                            <div class="text-xs text-gray-400 mt-1 truncate w-64">{{ h.items.map(x=>x.name).join(', ') }}</div>
                        </div>
                        <div class="flex gap-2">
                            <button @click="$emit('deleteHeld', i)" class="text-red-400 hover:bg-red-50 p-2 rounded"><i class="fas fa-trash"></i></button>
                            <button @click="$emit('recall', i)" class="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded font-bold shadow">Resume</button>
                        </div>
                    </div>
                </div>

                <div v-if="activeTab === 'history'" class="space-y-3">
                    <div v-for="t in recentSales" :key="t.id" class="bg-white dark:bg-slate-800 p-4 rounded shadow flex justify-between items-center border-l-4 border-blue-400">
                        <div>
                            <div class="font-bold text-slate-800 dark:text-white">{{ t.number }}</div>
                            <div class="text-xs text-gray-500">{{ new Date(t.date).toLocaleDateString() }} • {{ currency }} {{ formatMoney(t.total) }}</div>
                        </div>
                        <div class="flex gap-2">
                            <button @click="$emit('print', t)" class="text-gray-500 hover:bg-gray-100 p-2 rounded" title="Reprint"><i class="fas fa-print"></i></button>
                            <button @click="$emit('share', t)" class="text-blue-500 hover:bg-blue-50 p-2 rounded" title="Share"><i class="fas fa-share-alt"></i></button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>