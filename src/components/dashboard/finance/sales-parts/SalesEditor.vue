<script setup>
import { computed } from 'vue';

// --- TEMPLATES ---
import TemplateClean from '../../docdesign/TemplateClean.vue';
import TemplateModern from '../../docdesign/TemplateModern.vue';
import TemplateCorporate from '../../docdesign/TemplateCorporate.vue';

const props = defineProps({
    txForm: { type: Object, required: true },
    activeCompany: { type: Object, required: true },
    companyPrefs: { type: Object, required: true },
    clients: { type: Array, required: true },
    products: { type: Array, required: true },
    isGeneratingPdf: { type: Boolean, default: false }
});

const emit = defineEmits(['save', 'cancel', 'saveDefaultNotes']);

// --- DYNAMIC STYLING ---
const fontStyle = computed(() => props.companyPrefs.fontFamily === 'serif' ? 'font-serif' : 'font-sans');

// --- LIVE CALCULATIONS (Fixed Number Formatting) ---
const editorCalcs = computed(() => {
    if (!props.txForm.items) return { subtotal: '0.00', grandTotal: '0.00', tax: '0.00', discount: 0 };
    
    const sub = props.txForm.items.reduce((s, i) => s + (i.qty * i.price), 0);
    const total = (sub * (1 - (props.txForm.discount || 0) / 100)) * (1 + (props.txForm.taxRate || 0) / 100);
    
    // Proper comma formatting for totals (e.g., 1,000,000.00)
    const formatMoney = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    return { 
        subtotal: formatMoney(sub), 
        grandTotal: formatMoney(total), 
        tax: formatMoney(total - sub), 
        discount: props.txForm.discount || 0 
    };
});

// --- LINE ITEM MANAGEMENT ---
function handleAddItem(prod = null) {
    if (prod && prod.id) {
        props.txForm.items.push({ desc: prod.name, unit: prod.unit || 'Unit', qty: 1, price: prod.price });
    } else {
        props.txForm.items.push({ desc: '', unit: 'Unit', qty: 1, price: 0 });
    }
}

function handleRemoveItem(index) {
    props.txForm.items.splice(index, 1);
}
</script>

<template>
    <div class="flex flex-col lg:flex-row gap-6 max-w-7xl mx-auto w-full p-6 h-screen overflow-hidden">
        <div class="flex-grow bg-white shadow-2xl rounded-lg overflow-hidden flex flex-col h-full">
            
            <div class="bg-slate-100 dark:bg-slate-800 px-6 py-3 border-b dark:border-slate-700 flex justify-between items-center no-print flex-shrink-0">
                <button @click="$emit('cancel')" class="text-gray-600 dark:text-gray-300 hover:text-black font-medium transition">
                    <i class="fas fa-arrow-left mr-2"></i> Dashboard
                </button>
                <button @click="$emit('save')" class="bg-emerald-600 text-white px-4 py-2 rounded shadow hover:bg-emerald-700 font-bold transition">
                    <i class="fas fa-save mr-2"></i> Save
                </button>
            </div>

            <div id="invoice-print-area" class="p-12 text-gray-800 bg-white" :class="[fontStyle, isGeneratingPdf ? 'pdf-mode h-auto overflow-visible block' : 'overflow-y-auto flex-grow']">
                <component 
                    :is="companyPrefs.baseTheme === 'modern' ? TemplateModern : (companyPrefs.baseTheme === 'corporate' ? TemplateCorporate : TemplateClean)"
                    :form="txForm" 
                    :company="activeCompany" 
                    :prefs="companyPrefs" 
                    :clients="clients" 
                    :products="products" 
                    :isPdf="isGeneratingPdf" 
                    :calculations="editorCalcs"
                    @addItem="handleAddItem"
                    @removeItem="handleRemoveItem"
                    @saveDefaultNotes="$emit('saveDefaultNotes', txForm.notes)"
                />
            </div>

        </div>
    </div>
</template>