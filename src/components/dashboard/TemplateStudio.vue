<script setup>
import { ref, computed, watch } from 'vue';
import { Store } from '../../store';

const activeCompany = computed(() => Store.state.selectedCompany || {});

// Default Config
const config = ref({
    baseTheme: 'clean', // clean, corporate, modern
    primaryColor: '#10b981', // Emerald default
    fontFamily: 'sans', // sans, serif, mono
    labels: {
        invoice: 'INVOICE',
        quote: 'QUOTE',
        billTo: 'Bill To',
        total: 'Total'
    },
    showLogo: true
});

// Load existing preferences if they exist
watch(activeCompany, (newVal) => {
    if (newVal && newVal.preferences) {
        config.value = { ...config.value, ...newVal.preferences };
    }
}, { immediate: true });

function save() {
    Store.saveCompanyStyle(JSON.parse(JSON.stringify(config.value)));
}

// Live Preview Helper
const previewStyle = computed(() => {
    return {
        '--doc-color': config.value.primaryColor,
        'font-family': config.value.fontFamily === 'serif' ? 'Georgia, serif' : 'Inter, sans-serif'
    };
});
</script>

<template>
    <div class="flex flex-col lg:flex-row gap-6 h-[calc(100vh-100px)] no-print">
        
        <div class="w-full lg:w-1/3 bg-white dark:bg-slate-800 p-6 rounded-lg shadow overflow-y-auto">
            <h2 class="text-2xl font-bold mb-6 dark:text-white">Template Studio</h2>
            
            <div class="space-y-6">
                <div>
                    <label class="block text-sm font-bold text-gray-500 mb-2">Structure</label>
                    <div class="grid grid-cols-3 gap-2">
                        <button @click="config.baseTheme='clean'" :class="config.baseTheme==='clean' ? 'ring-2 ring-emerald-500 bg-gray-100' : 'border'" class="p-2 rounded text-xs">Clean</button>
                        <button @click="config.baseTheme='corporate'" :class="config.baseTheme==='corporate' ? 'ring-2 ring-emerald-500 bg-gray-100' : 'border'" class="p-2 rounded text-xs">Corp</button>
                        <button @click="config.baseTheme='modern'" :class="config.baseTheme==='modern' ? 'ring-2 ring-emerald-500 bg-gray-100' : 'border'" class="p-2 rounded text-xs">Modern</button>
                    </div>
                </div>

                <div>
                    <label class="block text-sm font-bold text-gray-500 mb-2">Brand Color</label>
                    <div class="flex gap-2 items-center">
                        <input type="color" v-model="config.primaryColor" class="h-10 w-10 border-none cursor-pointer">
                        <input type="text" v-model="config.primaryColor" class="border p-2 rounded w-full dark:bg-slate-700 dark:text-white uppercase">
                    </div>
                </div>

                <div>
                    <label class="block text-sm font-bold text-gray-500 mb-2">Rename Labels</label>
                    <div class="space-y-2">
                        <input v-model="config.labels.invoice" placeholder="Invoice Title" class="w-full border p-2 rounded text-sm">
                        <input v-model="config.labels.billTo" placeholder="Bill To Label" class="w-full border p-2 rounded text-sm">
                    </div>
                </div>

                <div class="flex items-center gap-2">
                    <input type="checkbox" v-model="config.showLogo" id="logoToggle" class="h-4 w-4">
                    <label for="logoToggle" class="dark:text-white">Show Company Logo</label>
                </div>

                <button @click="save" class="w-full bg-slate-900 text-white py-3 rounded font-bold hover:bg-slate-700">Save Template</button>
            </div>
        </div>

        <div class="w-full lg:w-2/3 bg-gray-100 dark:bg-slate-900 flex items-center justify-center p-8 overflow-hidden">
            
            <div class="bg-white w-[500px] min-h-[700px] shadow-2xl p-8 text-xs relative transform scale-90 origin-top" :style="previewStyle">
                
                <div v-if="config.baseTheme === 'clean'" class="text-slate-700">
                    <div class="flex justify-between border-b-2 pb-4 mb-4" :style="{ borderColor: config.primaryColor }">
                        <div>
                            <div v-if="config.showLogo" class="h-8 w-8 bg-gray-200 mb-2 rounded"></div>
                            <h1 class="text-2xl font-bold tracking-widest uppercase" :style="{ color: config.primaryColor }">{{ config.labels.invoice }}</h1>
                        </div>
                        <div class="text-right">
                            <div class="font-bold">{{ activeCompany.name || 'Your Company' }}</div>
                        </div>
                    </div>
                    <div class="mb-4">
                        <div class="text-[10px] font-bold uppercase text-gray-400">{{ config.labels.billTo }}</div>
                        <div class="font-bold text-lg">Client Name</div>
                    </div>
                    <table class="w-full mb-4">
                        <thead :style="{ color: config.primaryColor }" class="border-b font-bold text-left"><tr><th class="py-2">Item</th><th class="text-right">Total</th></tr></thead>
                        <tbody><tr class="border-b"><td class="py-2">Web Development</td><td class="text-right">100.00</td></tr></tbody>
                    </table>
                </div>

                <div v-if="config.baseTheme === 'modern'" class="font-sans">
                    <div class="flex flex-row-reverse justify-between border-b-4 pb-4 mb-4" :style="{ borderColor: config.primaryColor }">
                        <div class="text-right">
                            <h1 class="text-4xl font-bold" :style="{ color: config.primaryColor }">{{ config.labels.invoice }}</h1>
                        </div>
                        <div><div v-if="config.showLogo" class="h-10 w-10 bg-gray-200 rounded"></div></div>
                    </div>
                     <div class="bg-gray-50 p-2 mb-4 rounded border-l-4" :style="{ borderColor: config.primaryColor }">
                        <div class="font-bold">{{ config.labels.billTo }}: Client Name</div>
                    </div>
                    <table class="w-full mb-4">
                        <thead class="text-white" :style="{ backgroundColor: config.primaryColor }"><tr><th class="p-2 text-left">Item</th><th class="p-2 text-right">Total</th></tr></thead>
                        <tbody><tr class="border-b"><td class="p-2">Services</td><td class="p-2 text-right">100.00</td></tr></tbody>
                    </table>
                </div>

                <div v-if="config.baseTheme === 'corporate'" class="font-serif">
                     <div class="bg-slate-50 border p-4 mb-4 flex justify-between items-center">
                        <h1 class="text-2xl font-bold underline" :style="{ color: config.primaryColor }">{{ config.labels.invoice }}</h1>
                        <div class="font-bold">{{ activeCompany.name }}</div>
                    </div>
                    <div class="mb-4"><span class="font-bold">{{ config.labels.billTo }}:</span> Client Name</div>
                    <table class="w-full mb-4">
                        <thead class="text-white" :style="{ backgroundColor: config.primaryColor }"><tr><th class="p-2 text-left">Item</th><th class="p-2 text-right">Total</th></tr></thead>
                        <tbody><tr class="border-b"><td class="p-2">Consulting</td><td class="p-2 text-right">100.00</td></tr></tbody>
                    </table>
                </div>

            </div>
        </div>
    </div>
</template>