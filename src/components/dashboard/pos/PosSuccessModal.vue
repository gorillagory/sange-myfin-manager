<script setup>
const props = defineProps({ change: Number });
const emit = defineEmits(['close', 'print']);
</script>

<template>
    <div class="fixed inset-0 flex items-center justify-center z-50 p-4 bg-emerald-900/40 backdrop-blur-sm">
        <div class="bg-white dark:bg-slate-800 rounded-2xl p-8 w-full max-w-sm shadow-2xl text-center">
            <div class="w-20 h-20 bg-emerald-100 text-emerald-500 rounded-full flex items-center justify-center mx-auto mb-4 text-4xl">
                <i class="fas fa-check"></i>
            </div>
            
            <h2 class="text-2xl font-black text-slate-800 dark:text-white mb-2">Sale Completed!</h2>
            
            <div v-if="change > 0" class="bg-emerald-50 dark:bg-slate-900 p-4 rounded-xl border border-emerald-100 dark:border-slate-700 my-6">
                <div class="text-xs text-emerald-600 uppercase font-bold">Change Due</div>
                <div class="text-4xl font-black text-emerald-600">RM {{ change.toFixed(2) }}</div>
            </div>
            <div v-else class="text-gray-400 my-6 italic">No change due</div>

            <div class="grid grid-cols-2 gap-3">
                <button @click="$emit('print')" class="bg-gray-200 hover:bg-gray-300 text-slate-700 py-3 rounded-xl font-bold flex items-center justify-center gap-2">
                    <i class="fas fa-print"></i> Receipt
                </button>
                <button @click="$emit('close')" class="bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-xl font-bold">
                    New Sale
                </button>
            </div>
        </div>
    </div>
</template>