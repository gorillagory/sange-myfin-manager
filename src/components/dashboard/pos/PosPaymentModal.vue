<script setup>
import { ref, watch, computed } from 'vue';

// NEW: Added 'qrCode' to props
const props = defineProps(['show', 'total', 'currency', 'qrCode']);
const emit = defineEmits(['close', 'complete']);

const payment = ref({ method: 'Cash', tendered: 0 });
const quickCash = [1, 5, 10, 20, 50, 100];

// Reset state when opening
watch(() => props.show, (val) => {
    if (val) payment.value = { method: 'Cash', tendered: 0 };
});

const changeDue = computed(() => Math.max(0, payment.value.tendered - props.total));

function formatMoney(amount) {
    return Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function addCash(amount) {
    payment.value.tendered = Number(payment.value.tendered) + amount;
}

function submit() {
    // For QR, we assume exact payment was verified visually
    const finalChange = payment.value.method === 'Cash' ? changeDue.value : 0;
    emit('complete', { ...payment.value, change: finalChange });
}
</script>

<template>
    <div v-if="show" class="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 backdrop-blur-sm">
        <div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-4xl overflow-hidden flex flex-col md:flex-row h-[600px] md:h-auto animate-fade-in">
            
            <div class="bg-emerald-600 text-white p-8 md:w-1/3 flex flex-col justify-between">
                <div>
                    <h3 class="text-emerald-100 font-bold uppercase text-sm mb-2">Total Payable</h3>
                    <div class="text-5xl font-bold mb-8">{{ currency }}<br>{{ formatMoney(total) }}</div>
                    
                    <div v-if="payment.method === 'Cash'" class="bg-emerald-700 p-4 rounded-lg mb-4">
                        <div class="text-xs uppercase opacity-70 mb-1">Change Due</div>
                        <div class="font-bold text-3xl">{{ currency }} {{ formatMoney(changeDue) }}</div>
                    </div>
                    <div v-else class="bg-emerald-700 p-4 rounded-lg mb-4">
                        <div class="text-xs uppercase opacity-70 mb-1">Payment Type</div>
                        <div class="font-bold text-2xl">{{ payment.method }}</div>
                    </div>
                </div>
                <button @click="$emit('close')" class="bg-emerald-800 hover:bg-emerald-900 text-white py-3 rounded mt-4">Cancel</button>
            </div>

            <div class="p-8 md:w-2/3 bg-gray-50 dark:bg-slate-900 flex flex-col">
                <h3 class="font-bold text-slate-800 dark:text-white text-xl mb-6">Payment Method</h3>
                
                <div class="grid grid-cols-3 gap-4 mb-6">
                    <button @click="payment.method='Cash'" :class="payment.method==='Cash' ? 'bg-white border-emerald-500 ring-2 ring-emerald-500 text-emerald-700' : 'bg-white border-gray-200 opacity-60'" class="p-4 rounded-lg shadow-sm border font-bold flex flex-col items-center gap-2 transition"><i class="fas fa-money-bill-wave text-2xl"></i> Cash</button>
                    <button @click="payment.method='QR'" :class="payment.method==='QR' ? 'bg-white border-emerald-500 ring-2 ring-emerald-500 text-emerald-700' : 'bg-white border-gray-200 opacity-60'" class="p-4 rounded-lg shadow-sm border font-bold flex flex-col items-center gap-2 transition"><i class="fas fa-qrcode text-2xl"></i> QR Pay</button>
                    <button @click="payment.method='Card'" :class="payment.method==='Card' ? 'bg-white border-emerald-500 ring-2 ring-emerald-500 text-emerald-700' : 'bg-white border-gray-200 opacity-60'" class="p-4 rounded-lg shadow-sm border font-bold flex flex-col items-center gap-2 transition"><i class="fas fa-credit-card text-2xl"></i> Card</button>
                </div>

                <div v-if="payment.method === 'Cash'" class="flex-grow">
                    <div class="mb-4 relative">
                        <span class="absolute left-4 top-4 text-gray-400 font-bold text-xl">{{ currency }}</span>
                        <input v-model="payment.tendered" type="number" class="w-full pl-16 p-3 text-3xl font-bold rounded-lg border dark:bg-slate-800 dark:text-white dark:border-slate-600 focus:ring-4 ring-emerald-200 outline-none" placeholder="0.00">
                        <button @click="payment.tendered=0" class="absolute right-4 top-5 text-gray-400 hover:text-red-500"><i class="fas fa-times-circle"></i></button>
                    </div>

                    <div class="grid grid-cols-3 gap-3 mb-4">
                        <button v-for="amt in quickCash" :key="amt" @click="addCash(amt)" class="bg-white dark:bg-slate-700 hover:bg-emerald-50 dark:hover:bg-slate-600 border dark:border-slate-600 py-3 rounded font-bold text-lg shadow-sm transition active:scale-95">
                            + {{ amt }}
                        </button>
                    </div>
                     <button @click="payment.tendered = total" class="w-full bg-blue-100 text-blue-700 py-2 rounded font-bold hover:bg-blue-200 mb-2">Exact Amount</button>
                </div>

                <div v-if="payment.method === 'QR'" class="flex-grow flex flex-col items-center justify-center text-center animate-fade-in">
                    <div v-if="qrCode" class="bg-white p-4 rounded-xl shadow-lg border mb-4">
                        <img :src="qrCode" class="w-48 h-48 object-contain">
                    </div>
                    <div v-else class="bg-gray-200 w-48 h-48 rounded-xl flex items-center justify-center text-gray-400 mb-4">
                        <div class="text-sm">No QR Uploaded<br>Check Settings</div>
                    </div>
                    
                    <div class="text-slate-800 dark:text-white font-bold mb-2">Ask customer to pay:</div>
                    <div class="text-4xl font-mono font-bold text-emerald-600 bg-emerald-50 px-6 py-2 rounded-lg border border-emerald-200 mb-2">
                        {{ currency }} {{ formatMoney(total) }}
                    </div>
                    <div class="text-xs text-gray-400 animate-pulse">Waiting for manual verification...</div>
                </div>

                <div v-if="payment.method === 'Card'" class="flex-grow flex flex-col items-center justify-center text-center animate-fade-in">
                    <i class="fas fa-credit-card text-6xl text-gray-300 mb-4"></i>
                    <p class="text-gray-500 font-bold">Process payment on external terminal.</p>
                </div>

                <div class="mt-auto">
                    <button @click="submit" class="w-full font-bold text-xl py-4 rounded-lg shadow-lg transition transform active:scale-[0.98]" 
                        :class="payment.method === 'QR' ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-emerald-600 hover:bg-emerald-700 text-white'">
                        {{ payment.method === 'QR' ? 'VERIFY & COMPLETE' : 'COMPLETE SALE' }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>