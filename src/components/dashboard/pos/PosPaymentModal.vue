<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
    total: Number,
    company: Object
});

const emit = defineEmits(['close', 'complete']);

const paymentMethod = ref('Cash');
const cashReceived = ref(0);

const changeDue = computed(() => Math.max(0, cashReceived.value - props.total));

function setExact() { cashReceived.value = props.total; }
function addCash(amount) { cashReceived.value += amount; }

function process() {
    if (paymentMethod.value === 'Cash' && cashReceived.value < props.total) {
        return alert("Insufficient Cash"); // Simple alert fallback for logic check
    }
    emit('complete', { 
        method: paymentMethod.value, 
        received: cashReceived.value, 
        change: changeDue.value 
    });
}
</script>

<template>
    <div class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
        <div class="bg-white dark:bg-slate-800 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div class="p-4 border-b dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex justify-between items-center">
                <h3 class="text-lg font-bold">Checkout</h3>
                <div class="text-xl font-black text-emerald-600">RM {{ total.toFixed(2) }}</div>
            </div>
            
            <div class="p-6 space-y-6 overflow-y-auto">
                <div class="grid grid-cols-3 gap-2 p-1 bg-gray-100 dark:bg-slate-900 rounded-lg">
                    <button v-for="m in ['Cash', 'QR Pay', 'Card']" :key="m" @click="paymentMethod = m"
                        class="py-2 rounded-md font-bold text-sm transition relative overflow-hidden"
                        :class="paymentMethod === m ? 'bg-white text-emerald-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'">
                        {{ m }}
                    </button>
                </div>

                <div v-if="paymentMethod === 'Cash'" class="space-y-4">
                    <div class="bg-emerald-50 dark:bg-slate-900 p-4 rounded-xl text-center border-2 border-emerald-100 dark:border-slate-700">
                        <div class="text-xs text-emerald-600 uppercase font-bold mb-1">Cash Received</div>
                        <div class="flex items-center justify-center gap-2">
                            <span class="text-2xl text-gray-400 font-bold">RM</span>
                            <input type="number" v-model="cashReceived" class="text-4xl font-bold bg-transparent text-center w-32 outline-none text-slate-800 dark:text-white" autofocus>
                        </div>
                    </div>
                    
                    <div class="grid grid-cols-4 gap-2">
                        <button @click="setExact" class="col-span-2 bg-blue-100 hover:bg-blue-200 text-blue-700 font-bold py-3 rounded-lg text-sm transition">Exact</button>
                        <button v-for="amt in [10, 20, 50, 100]" :key="amt" @click="addCash(amt)" 
                            class="bg-white border hover:bg-gray-50 font-bold py-3 rounded-lg shadow-sm text-slate-700 active:bg-gray-100 transition">
                            +{{ amt }}
                        </button>
                    </div>

                    <div v-if="changeDue > 0" class="text-center pt-2">
                        <span class="text-gray-400 font-bold text-sm uppercase">Change Due</span>
                        <div class="text-3xl font-black text-emerald-500">RM {{ changeDue.toFixed(2) }}</div>
                    </div>
                </div>

                <div v-if="paymentMethod === 'QR Pay'" class="text-center py-4">
                    <div v-if="company.qrCodeUrl" class="mb-4">
                        <img :src="company.qrCodeUrl" class="w-56 h-56 mx-auto border-4 border-white shadow-xl rounded-xl object-cover">
                    </div>
                    <div v-else class="w-56 h-56 mx-auto bg-gray-100 flex flex-col items-center justify-center rounded-xl mb-4 text-gray-400 border-2 border-dashed">
                        <i class="fas fa-qrcode text-4xl mb-2"></i><span class="text-xs">No QR Code</span>
                    </div>
                    <p class="text-sm text-gray-500">Scan to pay <strong>RM {{ total.toFixed(2) }}</strong></p>
                </div>

                <div v-if="paymentMethod === 'Card'" class="text-center py-8 text-gray-400">
                    <i class="fas fa-credit-card text-5xl mb-4"></i><p>Use external terminal.</p>
                </div>
            </div>

            <div class="p-4 border-t dark:border-slate-700 bg-gray-50 dark:bg-slate-900 flex gap-3">
                <button @click="$emit('close')" class="w-1/3 py-3 font-bold text-gray-500 hover:bg-gray-200 rounded-xl transition">Cancel</button>
                <button @click="process" class="w-2/3 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl shadow-lg shadow-emerald-200 transition transform active:scale-95">Complete Sale</button>
            </div>
        </div>
    </div>
</template>