<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';

const products = computed(() => Store.state.products);
const currency = computed(() => Store.state.selectedCompany?.preferences?.currency || 'RM');
const taxRate = computed(() => Store.state.selectedCompany?.preferences?.tax || 0);

const cart = ref([]);
const activeCategory = ref('All');
const categories = ['All', 'Food', 'Beverage', 'Retail', 'Service'];

// Variant Selector State
const showVariantModal = ref(false);
const selectedProduct = ref(null);

// --- SEARCH & FILTER ---
const searchQuery = ref('');
const filteredProducts = computed(() => {
    return products.value.filter(p => {
        const matchCat = activeCategory.value === 'All' || p.category === activeCategory.value;
        const matchSearch = p.name.toLowerCase().includes(searchQuery.value.toLowerCase());
        return matchCat && matchSearch;
    });
});

// --- CART LOGIC ---
function addToCart(product) {
    if (product.variants && product.variants.length > 0) {
        // Trigger Modal
        selectedProduct.value = product;
        showVariantModal.value = true;
    } else {
        // Simple Add
        if(product.stock <= 0) return Store.notify("Out of Stock!", "error");
        
        const existing = cart.value.find(i => i.id === product.id && !i.variant);
        if (existing) {
            if(existing.qty >= product.stock) return Store.notify("Max stock reached", "warning");
            existing.qty++;
        } else {
            cart.value.push({
                id: product.id,
                name: product.name,
                price: product.price,
                qty: 1,
                variant: null,
                maxStock: product.stock
            });
        }
    }
}

function addVariantToCart(variant) {
    if(variant.stock <= 0) return Store.notify("Variant Out of Stock", "error");

    const existing = cart.value.find(i => i.id === selectedProduct.value.id && i.variant?.name === variant.name);
    
    if (existing) {
        if(existing.qty >= variant.stock) return Store.notify("Max stock reached", "warning");
        existing.qty++;
    } else {
        cart.value.push({
            id: selectedProduct.value.id,
            name: `${selectedProduct.value.name} (${variant.name})`,
            price: variant.price,
            qty: 1,
            variant: variant, // Store full variant object for tracking
            maxStock: variant.stock
        });
    }
    showVariantModal.value = false;
}

function removeFromCart(index) {
    cart.value.splice(index, 1);
}

// --- CHECKOUT ---
const subtotal = computed(() => cart.value.reduce((sum, i) => sum + (i.price * i.qty), 0));
const taxAmount = computed(() => subtotal.value * (taxRate.value / 100));
const total = computed(() => subtotal.value + taxAmount.value);

async function checkout() {
    if (cart.value.length === 0) return;
    
    const transaction = {
        date: new Date().toISOString(),
        items: cart.value.map(i => ({ 
            productId: i.id, 
            desc: i.name, 
            price: i.price, 
            qty: i.qty,
            variant: i.variant ? i.variant.name : null 
        })),
        subtotal: subtotal.value,
        tax: taxAmount.value,
        total: total.value,
        status: 'Paid',
        paymentMethod: 'Cash'
    };

    // 1. Record Sale
    await Store.financeModule.addTransaction(Store, transaction);
    
    // 2. Deduct Stock (Inventory Logic)
    await Store.inventoryModule.deductStock(Store, transaction.items);
    
    // 3. Reset
    cart.value = [];
    Store.notify("Payment Successful!");
}
</script>

<template>
    <div class="h-full flex gap-6">
        
        <div class="flex-grow flex flex-col">
            <div class="flex gap-4 mb-4">
                <input v-model="searchQuery" placeholder="Search products..." class="bg-white dark:bg-slate-800 border dark:border-slate-700 p-3 rounded-lg flex-grow outline-none dark:text-white shadow-sm">
                <div class="flex gap-2">
                    <button v-for="cat in categories" :key="cat" 
                        @click="activeCategory = cat"
                        class="px-4 py-2 rounded-lg text-sm font-bold transition shadow-sm border"
                        :class="activeCategory === cat ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-gray-600 hover:bg-gray-50 border-gray-200'">
                        {{ cat }}
                    </button>
                </div>
            </div>

            <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 overflow-y-auto flex-grow pr-2">
                <div v-for="p in filteredProducts" :key="p.id" 
                    @click="addToCart(p)"
                    class="bg-white dark:bg-slate-800 p-4 rounded-xl shadow border dark:border-slate-700 cursor-pointer hover:shadow-lg transition relative group overflow-hidden h-32 flex flex-col justify-between">
                    
                    <div>
                        <div class="font-bold text-slate-800 dark:text-white leading-tight mb-1">{{ p.name }}</div>
                        <div class="text-xs text-gray-500">{{ p.category }}</div>
                    </div>
                    
                    <div class="flex justify-between items-end">
                        <div class="font-bold text-emerald-600 dark:text-emerald-400">
                             <span v-if="p.variants?.length" class="text-xs text-slate-400">From</span> 
                             {{ currency }} {{ p.variants?.length ? Math.min(...p.variants.map(v=>v.price)) : p.price }}
                        </div>
                        
                        <div v-if="!p.variants?.length">
                            <span v-if="p.stock <= 0" class="bg-red-100 text-red-600 text-[10px] font-bold px-2 py-1 rounded">SOLD OUT</span>
                            <span v-else-if="p.stock <= 5" class="bg-orange-100 text-orange-600 text-[10px] font-bold px-2 py-1 rounded">LOW: {{ p.stock }}</span>
                        </div>
                         <div v-else>
                            <span class="bg-purple-100 text-purple-600 text-[10px] font-bold px-2 py-1 rounded">{{ p.variants.length }} Options</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div class="w-96 bg-white dark:bg-slate-800 rounded-xl shadow-xl border dark:border-slate-700 flex flex-col h-full">
            <div class="p-4 border-b dark:border-slate-700 bg-slate-50 dark:bg-slate-900 rounded-t-xl">
                <h3 class="font-bold text-lg dark:text-white">Current Order</h3>
                <p class="text-xs text-gray-500">{{ cart.length }} items</p>
            </div>

            <div class="flex-grow overflow-y-auto p-4 space-y-3">
                <div v-for="(item, idx) in cart" :key="idx" class="flex justify-between items-center group">
                    <div>
                        <div class="font-bold text-sm dark:text-white">{{ item.name }}</div>
                        <div class="text-xs text-gray-400">{{ currency }} {{ item.price }} x {{ item.qty }}</div>
                    </div>
                    <div class="flex items-center gap-3">
                        <div class="font-bold text-slate-700 dark:text-gray-300">{{ currency }} {{ item.price * item.qty }}</div>
                        <button @click="removeFromCart(idx)" class="text-red-300 hover:text-red-500"><i class="fas fa-times-circle"></i></button>
                    </div>
                </div>
                
                <div v-if="cart.length === 0" class="text-center py-10 opacity-30">
                    <i class="fas fa-shopping-cart text-4xl mb-2"></i>
                    <p>Cart Empty</p>
                </div>
            </div>

            <div class="p-6 bg-slate-50 dark:bg-slate-900 border-t dark:border-slate-700 rounded-b-xl">
                <div class="flex justify-between text-sm mb-2 text-gray-500">
                    <span>Subtotal</span>
                    <span>{{ currency }} {{ subtotal.toFixed(2) }}</span>
                </div>
                <div class="flex justify-between text-sm mb-4 text-gray-500">
                    <span>Tax ({{ taxRate }}%)</span>
                    <span>{{ currency }} {{ taxAmount.toFixed(2) }}</span>
                </div>
                <div class="flex justify-between text-2xl font-bold text-slate-800 dark:text-white mb-6">
                    <span>Total</span>
                    <span>{{ currency }} {{ total.toFixed(2) }}</span>
                </div>
                
                <button @click="checkout" :disabled="cart.length === 0" 
                    class="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-400 text-white py-4 rounded-xl font-bold shadow-lg transition text-lg">
                    Charge {{ currency }} {{ total.toFixed(2) }}
                </button>
            </div>
        </div>

        <div v-if="showVariantModal" class="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 backdrop-blur-sm">
            <div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl p-6 w-full max-w-sm animate-bounce-in">
                <h3 class="font-bold text-xl mb-4 dark:text-white">{{ selectedProduct?.name }}</h3>
                <p class="text-sm text-gray-500 mb-4">Select an option:</p>
                
                <div class="grid grid-cols-1 gap-3">
                    <button v-for="v in selectedProduct?.variants" :key="v.name"
                        @click="addVariantToCart(v)"
                        :disabled="v.stock <= 0"
                        class="flex justify-between items-center p-4 border rounded-lg hover:border-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition group disabled:opacity-50 disabled:cursor-not-allowed">
                        <span class="font-bold dark:text-white">{{ v.name }}</span>
                        <div class="text-right">
                            <div class="font-bold text-emerald-600">{{ currency }} {{ v.price }}</div>
                            <div class="text-[10px]" :class="v.stock > 0 ? 'text-gray-400' : 'text-red-500'">
                                {{ v.stock > 0 ? `Qty: ${v.stock}` : 'Sold Out' }}
                            </div>
                        </div>
                    </button>
                </div>
                
                <button @click="showVariantModal = false" class="mt-4 w-full text-gray-500 py-2">Cancel</button>
            </div>
        </div>

    </div>
</template>