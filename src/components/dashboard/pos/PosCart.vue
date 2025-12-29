<script setup>
import SmartButton from '../../ui/SmartButton.vue';

const props = defineProps({
    cart: Array,
    heldCount: Number,
    totals: Object
});

const emit = defineEmits(['remove-item', 'clear-cart', 'hold-order', 'open-payment', 'open-history']);
</script>

<template>
    <div class="bg-white dark:bg-slate-800 rounded-xl shadow border dark:border-slate-700 flex flex-col flex-grow h-[60vh] lg:h-auto overflow-hidden">
        <div class="p-3 border-b dark:border-slate-700 font-bold flex justify-between items-center bg-slate-50 dark:bg-slate-900">
            <span class="flex items-center gap-2 text-slate-700 dark:text-white">
                <i class="fas fa-shopping-cart text-emerald-500"></i> Cart
            </span>
            <div class="flex items-center gap-2">
                <button @click="$emit('open-history')" class="text-gray-400 hover:text-emerald-600 transition" title="Sales History">
                    <i class="fas fa-clock fa-lg"></i>
                </button>

                <button v-if="heldCount > 0" @click="$emit('open-history')" class="text-xs bg-yellow-100 text-yellow-700 px-3 py-1 rounded-full hover:bg-yellow-200 transition font-bold shadow-sm">
                    {{ heldCount }} Held
                </button>
                
                <SmartButton v-if="cart.length > 0" icon="fas fa-trash" color="text-gray-400 hover:text-red-500" confirmLabel="Clear?" @confirmed="$emit('clear-cart')" />
            </div>
        </div>

        <div class="flex-grow overflow-y-auto p-2 space-y-2">
            <TransitionGroup name="fade">
                <div v-for="(item, i) in cart" :key="item.name + i" class="flex justify-between items-center bg-gray-50 dark:bg-slate-700/50 p-2 rounded-lg group hover:bg-gray-100 dark:hover:bg-slate-700 transition">
                    <div class="flex-grow">
                        <div class="font-bold text-sm text-slate-700 dark:text-gray-200">{{ item.name }}</div>
                        <div class="text-xs text-gray-400">RM {{ Number(item.price).toFixed(2) }} x {{ item.qty }}</div>
                    </div>
                    <div class="text-right font-bold text-slate-700 dark:text-gray-200 mr-3">
                        {{ (item.price * item.qty).toFixed(2) }}
                    </div>
                    <button @click="$emit('remove-item', i)" class="text-gray-300 hover:text-red-500 transition px-2"><i class="fas fa-times"></i></button>
                </div>
            </TransitionGroup>
            
            <div v-if="cart.length === 0" class="h-full flex flex-col items-center justify-center text-gray-300 space-y-2 opacity-50">
                <i class="fas fa-cash-register text-4xl"></i>
                <span class="text-sm italic">Cart is empty</span>
            </div>
        </div>

        <div class="p-4 bg-slate-50 dark:bg-slate-900 border-t dark:border-slate-700 space-y-2 z-10">
            <div class="flex justify-between text-sm text-gray-500"><span>Subtotal</span><span>{{ totals.sub.toFixed(2) }}</span></div>
            <div class="flex justify-between text-sm text-gray-500"><span>Tax</span><span>{{ totals.tax.toFixed(2) }}</span></div>
            <div class="flex justify-between text-2xl font-black text-slate-800 dark:text-white mt-2">
                <span>Total</span><span>RM {{ totals.total.toFixed(2) }}</span>
            </div>
            
            <div class="grid grid-cols-3 gap-2 mt-4">
                <button @click="$emit('hold-order')" :disabled="cart.length === 0" class="col-span-1 bg-gray-200 hover:bg-gray-300 text-slate-600 py-3 rounded-xl font-bold transition disabled:opacity-50 disabled:cursor-not-allowed">
                    Hold
                </button>
                <button @click="$emit('open-payment')" :disabled="cart.length === 0" class="col-span-2 bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-xl font-bold shadow-lg shadow-emerald-200 dark:shadow-none transition transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none">
                    Pay Now
                </button>
            </div>
        </div>
    </div>
</template>