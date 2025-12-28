<script setup>
const props = defineProps(['show', 'tx']);
const emit = defineEmits(['close', 'print', 'share']);
</script>

<template>
    <div v-if="show" class="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-[80] backdrop-blur-sm">
        <div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl p-8 text-center max-w-sm w-full animate-bounce-in">
            <div class="w-20 h-20 bg-emerald-100 text-emerald-500 rounded-full flex items-center justify-center mx-auto mb-6 text-4xl">
                <i class="fas fa-check"></i>
            </div>
            <h2 class="text-2xl font-bold text-slate-800 dark:text-white mb-2">Sale Completed!</h2>
            <p class="text-gray-500 mb-8">Transaction #{{ tx?.number }} recorded.</p>
            
            <div class="grid grid-cols-2 gap-4">
                <button @click="$emit('print', tx)" class="bg-slate-800 text-white py-3 rounded-lg font-bold hover:bg-slate-700"><i class="fas fa-print mr-2"></i> Print</button>
                <button @click="$emit('share', tx)" class="bg-blue-600 text-white py-3 rounded-lg font-bold hover:bg-blue-700"><i class="fas fa-share-alt mr-2"></i> Share</button>
            </div>
            <button @click="$emit('close')" class="mt-4 text-gray-400 hover:text-gray-600 text-sm font-bold">Close & New Sale</button>
        </div>
    </div>
</template>

<style scoped>
@keyframes bounce-in {
  0% { transform: scale(0.8); opacity: 0; }
  50% { transform: scale(1.05); }
  100% { transform: scale(1); opacity: 1; }
}
.animate-bounce-in {
  animation: bounce-in 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}
</style>