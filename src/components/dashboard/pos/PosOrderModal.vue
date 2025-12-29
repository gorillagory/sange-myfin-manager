<script setup>
import { ref } from 'vue';
import SmartButton from '../../ui/SmartButton.vue';

const props = defineProps({ 
    heldCarts: Array, 
    recentSales: Array, // <--- NEW PROP
    isCartEmpty: Boolean 
});

const emit = defineEmits(['close', 'restore', 'delete-hold', 'print-receipt']);

const activeTab = ref('held'); // 'held' | 'history'
</script>

<template>
    <div class="fixed inset-0 flex items-center justify-center z-50 p-4 bg-black/50 backdrop-blur-sm" @click.self="$emit('close')">
        <div class="bg-white dark:bg-slate-800 rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[80vh]">
            
            <div class="flex border-b dark:border-slate-700">
                <button @click="activeTab = 'held'" 
                    class="flex-1 py-4 font-bold text-sm uppercase tracking-wider transition border-b-2"
                    :class="activeTab === 'held' ? 'text-emerald-600 border-emerald-600 bg-emerald-50 dark:bg-slate-700' : 'text-gray-400 border-transparent hover:text-gray-600'">
                    Held Orders ({{ heldCarts.length }})
                </button>
                <button @click="activeTab = 'history'" 
                    class="flex-1 py-4 font-bold text-sm uppercase tracking-wider transition border-b-2"
                    :class="activeTab === 'history' ? 'text-emerald-600 border-emerald-600 bg-emerald-50 dark:bg-slate-700' : 'text-gray-400 border-transparent hover:text-gray-600'">
                    Recent Sales
                </button>
            </div>
            
            <div class="flex-grow overflow-y-auto p-4 space-y-3 bg-gray-50 dark:bg-slate-900/50">
                
                <div v-if="activeTab === 'held'" class="space-y-3">
                    <div v-for="(h, i) in heldCarts" :key="i" class="flex justify-between items-center p-4 bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-gray-100 dark:border-slate-700">
                        <div>
                            <div class="font-bold text-slate-800 dark:text-white">{{ h.name }}</div>
                            <div class="text-xs text-gray-400 mt-1">
                                <i class="fas fa-clock mr-1"></i> {{ h.time.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) }} 
                                • {{ h.items.length }} items
                            </div>
                            <div class="font-bold text-emerald-600 text-sm mt-1">RM {{ h.total.toFixed(2) }}</div>
                        </div>
                        <div class="flex flex-col gap-2">
                             <SmartButton v-if="!isCartEmpty" label="Restore" confirmLabel="Overwrite?" class="text-xs bg-blue-100 text-blue-600 px-3 py-1.5 rounded-lg font-bold" confirmColor="bg-red-100 text-red-600 px-3 py-1.5 rounded-lg font-bold" @confirmed="$emit('restore', i)" />
                            <button v-else @click="$emit('restore', i)" class="text-xs bg-blue-100 hover:bg-blue-200 text-blue-600 px-4 py-2 rounded-lg font-bold transition">Restore</button>
                            <button @click="$emit('delete-hold', i)" class="text-xs text-gray-400 hover:text-red-400 font-bold">Delete</button>
                        </div>
                    </div>
                    <div v-if="heldCarts.length === 0" class="text-center text-gray-400 py-12 italic">
                        <i class="fas fa-pause-circle text-4xl mb-2 opacity-20"></i><br>No held orders.
                    </div>
                </div>

                <div v-else class="space-y-3">
                    <div v-for="tx in recentSales" :key="tx.id" class="flex justify-between items-center p-4 bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-gray-100 dark:border-slate-700">
                        <div>
                            <div class="font-bold text-slate-800 dark:text-white flex items-center gap-2">
                                {{ tx.number }}
                                <span class="px-2 py-0.5 rounded text-[10px] uppercase font-bold bg-green-100 text-green-700">{{ tx.paymentMethod }}</span>
                            </div>
                            <div class="text-xs text-gray-400 mt-1">
                                {{ new Date(tx.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) }}
                            </div>
                        </div>
                        <div class="text-right">
                            <div class="font-black text-slate-800 dark:text-white text-lg">RM {{ Number(tx.total).toFixed(2) }}</div>
                            <button @click="$emit('print-receipt', tx)" class="text-xs font-bold text-blue-500 hover:text-blue-700 mt-1 flex items-center justify-end gap-1">
                                <i class="fas fa-print"></i> Reprint
                            </button>
                        </div>
                    </div>
                    <div v-if="recentSales.length === 0" class="text-center text-gray-400 py-12 italic">
                        <i class="fas fa-history text-4xl mb-2 opacity-20"></i><br>No sales today.
                    </div>
                </div>

            </div>

            <div class="p-4 border-t dark:border-slate-700 bg-white dark:bg-slate-800">
                <button @click="$emit('close')" class="w-full py-3 bg-gray-100 hover:bg-gray-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-600 dark:text-white font-bold rounded-xl transition">
                    Close
                </button>
            </div>
        </div>
    </div>
</template>