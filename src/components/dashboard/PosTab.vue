<script setup>
import { ref, computed, nextTick } from 'vue';
import { Store } from '../../store';

// --- SUB COMPONENTS ---
import PosProductGrid from './pos/PosProductGrid.vue';
import PosCart from './pos/PosCart.vue';
import PosPaymentModal from './pos/PosPaymentModal.vue';
import PosOrderModal from './pos/PosOrderModal.vue';
import PosSuccessModal from './pos/PosSuccessModal.vue';

// --- STATE ---
const cart = ref([]);
const heldCarts = ref([]); 
const holdNameInput = ref('');
const activeCompany = computed(() => Store.state.selectedCompany || {});
const products = computed(() => Store.state.products.filter(p => p.company_id === activeCompany.value.id));
const categories = computed(() => ['All', ...new Set(products.value.map(p => p.category || 'General'))]);

// --- RECENT SALES COMPUTED PROPERTY ---
const recentSales = computed(() => {
    // Get sales from today only
    const today = new Date().toDateString();
    return Store.state.transactions
        .filter(t => 
            t.company_id === activeCompany.value.id && 
            t.status === 'Cleared' && // Only completed sales
            (t.type === 'Invoice' || t.number.startsWith('POS')) && // Invoices or POS
            new Date(t.date).toDateString() === today
        )
        .sort((a, b) => new Date(b.date) - new Date(a.date)); // Newest first
});

// --- MODAL CONTROLS ---
const showPayment = ref(false);
const showHistory = ref(false);
const showHold = ref(false);
const showSuccess = ref(false);
const showVariant = ref(false);
const lastChange = ref(0);

// --- CART LOGIC ---
const totals = computed(() => {
    const sub = cart.value.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const tax = sub * ((activeCompany.value.preferences?.taxRate || 0) / 100);
    return { sub, tax, total: sub + tax };
});

const selectedProductForVariants = ref(null);

function handleAddToCart(product) {
    if (product.variants?.length > 0) {
        selectedProductForVariants.value = product;
        showVariant.value = true;
    } else {
        addItem(product);
    }
}

function addItem(item) {
    const existing = cart.value.find(i => i.name === item.name && i.price === item.price);
    existing ? existing.qty++ : cart.value.push({ ...item, qty: 1 });
}

function addVariant(v) {
    addItem({ ...selectedProductForVariants.value, name: `${selectedProductForVariants.value.name} (${v.name})`, price: v.price });
    showVariant.value = false;
}

// --- ACTIONS ---
function confirmHoldCart() {
    heldCarts.value.push({ name: holdNameInput.value || `Order #${heldCarts.value.length+1}`, time: new Date(), items: [...cart.value], total: totals.value.total });
    cart.value = [];
    showHold.value = false;
    Store.notify("Order Parked");
}

async function handleCompleteSale({ method, received, change }) {
    const tx = {
        id: Date.now().toString(),
        company_id: activeCompany.value.id,
        date: new Date().toISOString(),
        type: 'Invoice',
        number: 'POS-' + Date.now().toString().slice(-6),
        status: 'Cleared',
        items: cart.value.map(i => ({ desc: i.name, qty: i.qty, price: i.price, unit: 'Unit' })),
        subtotal: totals.value.sub,
        tax: totals.value.tax,
        total: totals.value.total,
        paymentMethod: method,
        history: [{ date: new Date().toISOString(), action: `POS Sale (${method})`, user: Store.state.currentUser?.username }]
    };

    await Store.addTransaction(tx);
    
    lastChange.value = change;
    cart.value = [];
    showPayment.value = false;
    showSuccess.value = true; 
}

function restoreCart(index) {
    cart.value = heldCarts.value[index].items;
    heldCarts.value.splice(index, 1);
    showHistory.value = false;
}

function printReceipt(tx) {
    console.log("Printing receipt for", tx.number);
    Store.notify("Printing Receipt...");
}
</script>

<template>
    <div class="h-full flex flex-col lg:flex-row gap-4">
        
        <PosProductGrid :products="products" :categories="categories" @add-to-cart="handleAddToCart" />

        <div class="w-full lg:w-96 flex flex-col gap-4">
            <PosCart 
                :cart="cart" 
                :heldCount="heldCarts.length" 
                :totals="totals"
                @remove-item="(i) => cart.splice(i, 1)"
                @clear-cart="cart = []"
                @hold-order="() => { holdNameInput = ''; showHold = true; }"
                @open-payment="showPayment = true"
                @open-history="showHistory = true"
            />
        </div>

        <Transition name="slide-up">
            <PosPaymentModal v-if="showPayment" 
                :total="totals.total" :company="activeCompany" 
                @close="showPayment = false" @complete="handleCompleteSale" 
            />
        </Transition>

        <Transition name="scale">
            <PosOrderModal v-if="showHistory" 
                :heldCarts="heldCarts" 
                :recentSales="recentSales"
                :isCartEmpty="cart.length === 0"
                @close="showHistory = false" 
                @restore="restoreCart" 
                @delete-hold="(i) => heldCarts.splice(i, 1)"
                @print-receipt="printReceipt"
            />
        </Transition>

        <Transition name="scale">
            <PosSuccessModal v-if="showSuccess" :change="lastChange" @close="showSuccess = false" @print="printReceipt" />
        </Transition>

        <Transition name="scale">
            <div v-if="showVariant" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" @click.self="showVariant = false">
                <div class="bg-white dark:bg-slate-800 rounded-xl p-6 w-96 shadow-2xl">
                    <h3 class="font-bold text-lg mb-4 text-slate-800 dark:text-white">{{ selectedProductForVariants?.name }}</h3>
                    <div class="grid grid-cols-2 gap-3">
                        <button v-for="v in selectedProductForVariants?.variants" :key="v.name" @click="addVariant(v)" class="p-3 border dark:border-slate-600 rounded-lg hover:bg-emerald-50 dark:hover:bg-slate-700 text-left">
                            <div class="font-bold text-slate-700 dark:text-white">{{ v.name }}</div>
                            <div class="text-sm text-gray-500">RM {{ Number(v.price).toFixed(2) }}</div>
                        </button>
                    </div>
                </div>
            </div>
        </Transition>

        <Transition name="scale">
            <div v-if="showHold" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50" @click.self="showHold = false">
                <div class="bg-white dark:bg-slate-800 rounded-xl p-6 w-80 shadow-2xl">
                    <h3 class="font-bold mb-4 text-slate-800 dark:text-white">Park Order</h3>
                    <input v-model="holdNameInput" class="w-full border-b-2 border-emerald-500 bg-transparent py-2 text-lg font-bold outline-none text-slate-800 dark:text-white" placeholder="Order Reference" autofocus>
                    <div class="flex justify-end gap-3 mt-4">
                        <button @click="showHold = false" class="text-gray-400 font-bold">Cancel</button>
                        <button @click="confirmHoldCart" class="bg-emerald-600 text-white px-4 py-2 rounded-lg font-bold">Park</button>
                    </div>
                </div>
            </div>
        </Transition>

    </div>
</template>