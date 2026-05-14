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
const clientName = computed(() => props.clients.find(c => c.id === props.txForm.client_id)?.name || 'Unassigned Client');

const termTemplates = computed(() => {
    const currency = props.companyPrefs.currency || 'RM';
    const company = props.activeCompany.name || 'the company';
    const docType = props.txForm.type === 'Quote' ? 'quotation' : 'invoice';

    return [
        {
            label: 'Standard',
            icon: 'fas fa-file-contract',
            text: `Payment is due within 14 days from the ${docType} date.\nPlease reference ${props.txForm.number || 'the document number'} when making payment.\nAll goods and services remain subject to ${company}'s standard approval and fulfilment terms.`
        },
        {
            label: 'Quote Validity',
            icon: 'fas fa-hourglass-half',
            text: `This quote is valid for 30 days from the issue date.\nPrices, availability, and delivery timelines may change after the validity period.\nWork will begin after written approval or confirmed purchase order.`
        },
        {
            label: 'Deposit',
            icon: 'fas fa-coins',
            text: `A 50% deposit is required before work begins.\nThe remaining balance is due upon completion or before final delivery.\nPayments should be made in ${currency} unless otherwise agreed in writing.`
        },
        {
            label: 'Delivery',
            icon: 'fas fa-truck',
            text: `Delivery timelines are estimates and depend on confirmation of requirements, payment, and stock availability.\nAny changes requested after approval may affect final pricing and completion dates.`
        }
    ];
});

// --- LIVE CALCULATIONS (Fixed Number Formatting) ---
const editorCalcs = computed(() => {
    if (!props.txForm.items) return { subtotal: '0.00', grandTotal: '0.00', tax: '0.00', discount: '0.00', taxableAmount: '0.00' };
    
    const sub = props.txForm.items.reduce((s, i) => s + (i.qty * i.price), 0);
    const discountAmount = sub * ((props.txForm.discount || 0) / 100);
    const taxableAmount = Math.max(0, sub - discountAmount);
    const taxAmount = taxableAmount * ((props.txForm.taxRate || 0) / 100);
    const total = taxableAmount + taxAmount;
    
    // Proper comma formatting for totals (e.g., 1,000,000.00)
    const formatMoney = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    return { 
        subtotal: formatMoney(sub), 
        grandTotal: formatMoney(total), 
        tax: formatMoney(taxAmount),
        discount: formatMoney(discountAmount),
        taxableAmount: formatMoney(taxableAmount)
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

function applyTerms(text) {
    props.txForm.notes = text;
}

function appendTerms(text) {
    props.txForm.notes = [props.txForm.notes, text].filter(Boolean).join('\n\n');
}

function saveTermsDefault() {
    emit('saveDefaultNotes', props.txForm.notes || '');
}
</script>

<template>
    <div class="flex flex-col xl:flex-row gap-6 max-w-[1500px] mx-auto w-full p-6 h-screen overflow-hidden">
        <div class="flex-grow bg-white shadow-2xl rounded-lg overflow-hidden flex flex-col h-full min-w-0">
            
            <div class="bg-slate-100 dark:bg-slate-800 px-6 py-3 border-b dark:border-slate-700 flex justify-between items-center no-print flex-shrink-0">
                <div class="flex items-center gap-4 min-w-0">
                    <button @click="$emit('cancel')" class="text-gray-600 dark:text-gray-300 hover:text-black dark:hover:text-white font-medium transition">
                        <i class="fas fa-arrow-left mr-2"></i> Dashboard
                    </button>
                    <div class="hidden md:block min-w-0">
                        <div class="text-xs font-bold uppercase tracking-wider text-gray-400">{{ txForm.type || 'Document' }}</div>
                        <div class="font-black text-slate-800 dark:text-white truncate">{{ txForm.number || 'Draft' }} <span class="text-gray-400 font-bold">for</span> {{ clientName }}</div>
                    </div>
                </div>
                <div class="flex items-center gap-3">
                    <span class="hidden sm:inline-flex px-3 py-1 rounded-full text-xs font-black uppercase"
                        :class="txForm.status === 'Cleared' ? 'bg-emerald-100 text-emerald-700' : (txForm.status === 'Converted' ? 'bg-purple-100 text-purple-700' : 'bg-amber-100 text-amber-700')">
                        {{ txForm.status || 'Pending' }}
                    </span>
                    <button @click="$emit('save')" class="bg-emerald-600 text-white px-4 py-2 rounded-lg shadow hover:bg-emerald-700 font-bold transition">
                        <i class="fas fa-save mr-2"></i> Save
                    </button>
                </div>
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
                    @saveDefaultNotes="saveTermsDefault"
                />
            </div>

        </div>

        <aside class="no-print w-full xl:w-80 flex-shrink-0 overflow-y-auto space-y-4">
            <div class="bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-xl shadow-sm p-4">
                <div class="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">Document</div>
                <div class="space-y-3">
                    <div>
                        <label class="block text-[10px] font-bold uppercase text-gray-400 mb-1">Type</label>
                        <div class="font-black text-slate-800 dark:text-white">{{ txForm.type || 'Draft' }}</div>
                    </div>
                    <div>
                        <label class="block text-[10px] font-bold uppercase text-gray-400 mb-1">Project</label>
                        <input v-model="txForm.project" class="w-full bg-gray-100 dark:bg-slate-900 border dark:border-slate-700 rounded-lg px-3 py-2 text-sm font-bold dark:text-white outline-none focus:ring-2 ring-emerald-500" placeholder="Project name">
                    </div>
                    <div class="grid grid-cols-2 gap-3">
                        <div>
                            <label class="block text-[10px] font-bold uppercase text-gray-400 mb-1">Discount %</label>
                            <input v-model="txForm.discount" type="number" class="w-full bg-gray-100 dark:bg-slate-900 border dark:border-slate-700 rounded-lg px-3 py-2 text-sm font-bold dark:text-white outline-none">
                        </div>
                        <div>
                            <label class="block text-[10px] font-bold uppercase text-gray-400 mb-1">Tax %</label>
                            <input v-model="txForm.taxRate" type="number" class="w-full bg-gray-100 dark:bg-slate-900 border dark:border-slate-700 rounded-lg px-3 py-2 text-sm font-bold dark:text-white outline-none">
                        </div>
                    </div>
                </div>
            </div>

            <div class="bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-xl shadow-sm p-4">
                <div class="flex items-center justify-between mb-3">
                    <div>
                        <div class="text-xs font-bold uppercase tracking-wider text-gray-400">Terms</div>
                        <div class="font-black text-slate-800 dark:text-white">Templates</div>
                    </div>
                    <button @click="saveTermsDefault" class="text-xs font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300 px-3 py-1.5 rounded-lg transition">
                        <i class="fas fa-save mr-1"></i> Default
                    </button>
                </div>

                <div class="grid grid-cols-2 gap-2 mb-4">
                    <button v-for="preset in termTemplates" :key="preset.label" @click="applyTerms(preset.text)" class="text-left border dark:border-slate-700 hover:border-emerald-500 dark:hover:border-emerald-500 rounded-lg p-3 transition bg-gray-50 dark:bg-slate-900">
                        <i :class="preset.icon" class="text-emerald-500 mb-2"></i>
                        <div class="text-xs font-black text-slate-700 dark:text-white">{{ preset.label }}</div>
                    </button>
                </div>

                <textarea v-model="txForm.notes" rows="8" class="w-full bg-gray-100 dark:bg-slate-900 border dark:border-slate-700 rounded-lg p-3 text-sm leading-relaxed dark:text-white outline-none focus:ring-2 ring-emerald-500" placeholder="Terms, payment details, delivery notes..."></textarea>

                <div class="mt-3 flex gap-2">
                    <button @click="txForm.notes = ''" class="flex-1 text-xs font-bold text-gray-500 hover:text-red-600 bg-gray-100 dark:bg-slate-900 px-3 py-2 rounded-lg transition">
                        Clear
                    </button>
                    <button @click="appendTerms(termTemplates[0].text)" class="flex-1 text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-300 px-3 py-2 rounded-lg transition">
                        Append
                    </button>
                </div>
            </div>
        </aside>
    </div>
</template>
