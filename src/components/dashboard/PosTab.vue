<script setup>
import { ref, computed, onMounted } from 'vue';
import { Store } from '../../store';

// Import Sub-Components
import PosPaymentModal from './pos/PosPaymentModal.vue';
import PosOrdersModal from './pos/PosOrdersModal.vue';
import PosSuccessModal from './pos/PosSuccessModal.vue';

// --- STATE ---
const searchTerm = ref('');
const cart = ref([]);
const heldCarts = ref([]);
const lastTransaction = ref(null);

// Modal Visibility
const showPayModal = ref(false);
const showOrdersModal = ref(false);
const showSuccessModal = ref(false);
const showConfirm = ref(false);
const confirmConfig = ref({ title: '', message: '', action: null, type: 'warning' });

// --- DATA ---
const products = computed(() => Store.state.products);
const activeCompany = computed(() => Store.state.selectedCompany || {});
const companyPrefs = computed(() => ({ currency: 'RM', ...(activeCompany.value.preferences || {}) }));
const filteredProducts = computed(() => {
    if (!searchTerm.value) return products.value;
    const lower = searchTerm.value.toLowerCase();
    return products.value.filter(p => p.name.toLowerCase().includes(lower) || p.code?.toLowerCase().includes(lower));
});
const recentSales = computed(() => Store.state.transactions.filter(t => t.type === 'Invoice' && t.number.startsWith('POS')).sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,20));
const totals = computed(() => { const sub = cart.value.reduce((s,i)=>s+(i.price*i.qty),0); return {sub, total:sub}; });

// --- ACTIONS ---
function addToCart(p) {
    const ex = cart.value.find(i => i.id === p.id);
    if(ex) ex.qty++; else cart.value.push({id:p.id, name:p.name, price:Number(p.price), qty:1, code:p.code});
}
function updateQty(item, chg) { item.qty+=chg; if(item.qty<=0) cart.value = cart.value.filter(i=>i.id!==item.id); }
function clearCart() { if(cart.value.length) askConfirm("Clear?", "Empty cart?", ()=>{cart.value=[]}, 'danger'); }

// --- CHECKOUT HANDLER (Fixed) ---
function openPayModal() {
    if (cart.value.length === 0) return Store.notify("Cart is empty!", "error");
    showPayModal.value = true;
}

// --- HOLD/RECALL ---
function holdCart() {
    if(!cart.value.length) return Store.notify("Empty", "error");
    heldCarts.value.push({id:Date.now(), time:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), items:[...cart.value], total:totals.value.total});
    cart.value=[]; Store.notify("Held"); saveHeld();
}
function recallCart(i) {
    const doRecall = () => { cart.value=heldCarts.value[i].items; heldCarts.value.splice(i,1); saveHeld(); showOrdersModal.value=false; };
    if(cart.value.length) askConfirm("Overwrite?", "Replace cart?", doRecall); else doRecall();
}
function deleteHeld(i) { askConfirm("Delete?", "Discard order?", ()=>{heldCarts.value.splice(i,1); saveHeld();}, 'danger'); }
function saveHeld() { localStorage.setItem('myfin_held_carts', JSON.stringify(heldCarts.value)); }
onMounted(() => { const s = localStorage.getItem('myfin_held_carts'); if(s) heldCarts.value=JSON.parse(s); });

// --- PAYMENT ---
function completeSale(paymentData) {
    const tx = {
        company_id: activeCompany.value.id, client_id: '', type: 'Invoice', 
        number: 'POS-'+Date.now().toString().slice(-6), date: new Date().toISOString().split('T')[0],
        status: 'Paid', items: cart.value.map(i=>({desc:i.name, unit:'Unit', qty:i.qty, price:i.price, type:'POS', productId:i.id})),
        total: totals.value.total, notes: `POS via ${paymentData.method}`, 
        history: [{date:new Date().toISOString(), action:'Sale (POS)'}]
    };
    Store.addTransaction(tx);
    lastTransaction.value = { ...tx, change: paymentData.change };
    cart.value = []; showPayModal.value = false; showSuccessModal.value = true;
}

// --- UTIL ---
function askConfirm(t,m,cb,type='warning'){ confirmConfig.value={title:t,message:m,action:cb,type}; showConfirm.value=true; }
function handleConfirmYes(){ if(confirmConfig.value.action) confirmConfig.value.action(); showConfirm.value=false; }
function formatMoney(n){ return Number(n).toLocaleString('en-US',{minimumFractionDigits:2}); }

// --- RECEIPT ---
function printReceipt(tx) {
    const el = document.getElementById('receipt-print-area');
    el.innerHTML = `<div class="receipt"><div class="header"><h2>${activeCompany.value.name}</h2><p>${tx.date} #${tx.number}</p></div><hr/><div class="items">${tx.items.map(i=>`<div class="item"><span>${i.desc} x${i.qty}</span><span>${formatMoney(i.price*i.qty)}</span></div>`).join('')}</div><hr/><div class="totals"><div class="row"><strong>TOTAL</strong><strong>${companyPrefs.value.currency} ${formatMoney(tx.total)}</strong></div>${tx.change!==undefined?`<div class="row"><span>Change</span><span>${formatMoney(tx.change)}</span></div>`:''}</div></div>`;
    window.print();
}
async function shareReceipt(tx) {
    const text = `Receipt ${activeCompany.value.name}\nTotal: ${companyPrefs.value.currency} ${formatMoney(tx.total)}\nRef: ${tx.number}`;
    if(navigator.share) try{await navigator.share({title:'Receipt',text});}catch(e){} else {navigator.clipboard.writeText(text); Store.notify("Copied!");}
}
</script>

<template>
    <div class="flex h-full gap-6 no-print relative">
        <div class="flex-grow flex flex-col">
            <div class="mb-4 flex gap-4">
                <div class="relative flex-grow"><i class="fas fa-search absolute left-4 top-3 text-gray-400"></i><input v-model="searchTerm" placeholder="Search..." class="w-full pl-12 pr-4 py-3 rounded-lg shadow-sm border-none bg-white dark:bg-slate-800 dark:text-white focus:ring-2 focus:ring-emerald-500 outline-none text-lg"></div>
                <button @click="showOrdersModal=true" class="bg-indigo-600 text-white px-6 rounded-lg font-bold shadow-sm flex items-center gap-2 relative transition hover:bg-indigo-700"><i class="fas fa-clock"></i><span class="hidden sm:inline">Recall</span><span v-if="heldCarts.length" class="absolute -top-2 -right-2 bg-red-500 text-white text-xs w-6 h-6 rounded-full flex items-center justify-center">{{heldCarts.length}}</span></button>
            </div>
            <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 overflow-y-auto pb-4 pr-2 custom-scrollbar">
                <button v-for="p in filteredProducts" :key="p.id" @click="addToCart(p)" class="bg-white dark:bg-slate-800 p-4 rounded-xl shadow-sm hover:shadow-md ring-emerald-500 hover:ring-2 transition flex flex-col justify-between h-32 text-left group">
                    <div><div class="font-bold text-slate-800 dark:text-white line-clamp-2 leading-tight">{{ p.name }}</div><div v-if="p.code" class="text-xs text-gray-400 mt-1">{{ p.code }}</div></div>
                    <div class="font-bold text-emerald-600 group-hover:scale-105 transition-transform">{{ companyPrefs.currency }} {{ formatMoney(p.price) }}</div>
                </button>
            </div>
        </div>

        <div class="w-96 bg-white dark:bg-slate-800 rounded-xl shadow-lg flex flex-col border dark:border-slate-700 flex-shrink-0">
            <div class="p-4 border-b dark:border-slate-700 bg-slate-50 dark:bg-slate-700/50 rounded-t-xl flex justify-between items-center"><h3 class="font-bold text-slate-700 dark:text-white"><i class="fas fa-shopping-cart mr-2"></i> Sale</h3><div class="flex gap-2"><button @click="holdCart" class="text-xs bg-orange-100 text-orange-600 px-3 py-1 rounded hover:bg-orange-200 font-bold"><i class="fas fa-pause mr-1"></i> HOLD</button><button @click="clearCart" class="text-xs bg-red-100 text-red-500 px-3 py-1 rounded hover:bg-red-200 font-bold"><i class="fas fa-trash"></i></button></div></div>
            <div class="flex-grow overflow-y-auto p-4 space-y-3">
                <div v-if="!cart.length" class="text-center text-gray-400 italic mt-10 opacity-50"><i class="fas fa-cash-register text-4xl mb-2 block"></i>Add items...</div>
                <div v-for="item in cart" :key="item.id" class="flex justify-between items-center bg-gray-50 dark:bg-slate-700/30 p-2 rounded">
                    <div class="flex-grow min-w-0 pr-2"><div class="text-sm font-bold text-slate-800 dark:text-white truncate">{{ item.name }}</div><div class="text-xs text-gray-500">{{ companyPrefs.currency }} {{ formatMoney(item.price) }} x {{ item.qty }}</div></div>
                    <div class="flex items-center gap-2 shrink-0"><button @click="updateQty(item,-1)" class="w-6 h-6 rounded bg-white dark:bg-slate-600 shadow flex justify-center items-center text-slate-600 dark:text-white">-</button><span class="font-bold w-4 text-center dark:text-white">{{ item.qty }}</span><button @click="updateQty(item,1)" class="w-6 h-6 rounded bg-white dark:bg-slate-600 shadow flex justify-center items-center text-emerald-600">+</button></div>
                    <div class="w-16 text-right font-bold text-slate-700 dark:text-emerald-400">{{ formatMoney(item.price*item.qty) }}</div>
                </div>
            </div>
            <div class="p-6 bg-slate-50 dark:bg-slate-700/50 border-t dark:border-slate-700 rounded-b-xl">
                <div class="flex justify-between items-end mb-4"><span class="text-gray-500 text-sm">Total</span><span class="text-3xl font-bold text-slate-800 dark:text-white">{{ companyPrefs.currency }} {{ formatMoney(totals.total) }}</span></div>
                <button @click="openPayModal" class="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-4 rounded-lg shadow-lg text-lg transition active:scale-95 flex justify-center items-center gap-2"><i class="fas fa-check-circle"></i> CHECKOUT</button>
            </div>
        </div>

        <PosPaymentModal 
            :show="showPayModal" 
            :total="totals.total" 
            :currency="companyPrefs.currency" 
            :qrCode="activeCompany.qrCode"
            @close="showPayModal=false" 
            @complete="completeSale" 
        />
        <PosOrdersModal :show="showOrdersModal" :heldCarts="heldCarts" :recentSales="recentSales" :currency="companyPrefs.currency" @close="showOrdersModal=false" @recall="recallCart" @deleteHeld="deleteHeld" @print="printReceipt" @share="shareReceipt" />
        <PosSuccessModal :show="showSuccessModal" :tx="lastTransaction" @close="showSuccessModal=false" @print="printReceipt" @share="shareReceipt" />

        <div v-if="showConfirm" class="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-[70] backdrop-blur-sm"><div class="bg-white dark:bg-slate-800 rounded-lg shadow-2xl p-6 w-96 max-w-full border-t-4" :class="confirmConfig.type==='danger'?'border-red-500':'border-orange-500'"><h3 class="text-lg font-bold mb-2 text-slate-800 dark:text-white">{{confirmConfig.title}}</h3><p class="text-gray-600 dark:text-gray-300 mb-6">{{confirmConfig.message}}</p><div class="flex justify-end gap-3"><button @click="showConfirm=false" class="px-4 py-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700 rounded font-bold">Cancel</button><button @click="handleConfirmYes" class="px-4 py-2 text-white rounded shadow font-bold" :class="confirmConfig.type==='danger'?'bg-red-500':'bg-orange-500'">Confirm</button></div></div></div>
        
        <div id="receipt-print-area" class="hidden"></div>
    </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar { width: 6px; }
.custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
.custom-scrollbar::-webkit-scrollbar-thumb { background-color: rgba(156, 163, 175, 0.5); border-radius: 20px; }
</style>