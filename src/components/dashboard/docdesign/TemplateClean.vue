<script setup>
const props = defineProps(['form', 'company', 'prefs', 'clients', 'isPdf', 'calculations', 'products']);
const emit = defineEmits(['removeItem', 'addItem', 'saveDefaultNotes']);

// Helper format for strict 1,000,000.00 styling inside the template rows
const formatRowMoney = (n) => Number(n || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
</script>

<template>
    <div class="doc-clean font-sans text-slate-800 relative bg-white">
        
        <div v-if="form.status === 'Cleared'" 
             class="absolute top-40 right-10 border-4 border-green-600 text-green-600 font-black text-6xl uppercase opacity-30 transform -rotate-12 px-4 py-2 pointer-events-none select-none z-0">
            PAID
        </div>

        <table class="w-full mb-6 border-collapse" width="100%">
            <tbody>
                <tr>
                    <td class="align-top" width="60%">
                        <img v-if="company.logo && prefs.showLogo" :src="company.logo" class="h-24 w-auto object-contain mb-4">
                        
                        <h1 class="text-3xl font-bold tracking-widest uppercase leading-none mb-1" :style="{ color: prefs.primaryColor }">
                            {{ form.type === 'Quote' ? prefs.labels.quote : prefs.labels.invoice }}
                        </h1>
                        <div class="font-mono text-gray-500 font-bold text-lg"># {{ form.number }}</div>
                        
                        <div v-if="isPdf && form.project" class="text-sm font-bold text-slate-600 mt-2 bg-slate-100 inline-block px-2 py-1 rounded">
                            Project: {{ form.project }}
                        </div>
                        <div v-else-if="!isPdf" class="mt-2 w-64">
                            <input v-model="form.project" class="w-full bg-transparent border-b border-gray-300 outline-none text-sm font-bold text-slate-600 pb-1" placeholder="+ Assign Project Name...">
                        </div>
                    </td>

                    <td class="align-top text-right" width="40%">
                        <div class="font-bold text-xl text-slate-900">{{ company.name }}</div>
                        <div class="text-sm opacity-75 whitespace-pre-line leading-tight mt-1 text-slate-600">
                            {{ company.address1 || company.address }}
                        </div>
                        <div v-if="company.phone" class="text-sm text-slate-600 mt-1">{{ company.phone }}</div>
                    </td>
                </tr>
            </tbody>
        </table>

        <div class="mb-8 pb-2 relative z-10">
            <div class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-0.5">{{ prefs.labels.billTo }}</div>
            <div v-if="isPdf" class="font-bold text-lg text-slate-800 leading-tight">
                {{ props.clients.find(c => c.id === form.client_id)?.name || 'Unknown' }}
            </div>
             <select v-else v-model="form.client_id" class="w-full bg-transparent font-bold text-lg border-b border-gray-300 outline-none pb-1">
                <option value="" disabled>Select Client...</option>
                <option v-for="c in clients" :value="c.id">{{ c.name }}</option>
            </select>
        </div>

        <table class="w-full mb-2 border-collapse table-fixed relative z-10" width="100%">
            <thead>
                <tr>
                    <th class="py-2 text-left text-xs font-bold uppercase tracking-wider text-slate-500" width="45%">Description</th> 
                    <th class="py-2 text-center text-xs font-bold uppercase tracking-wider text-slate-500" width="10%">Unit</th>
                    <th class="py-2 text-center text-xs font-bold uppercase tracking-wider text-slate-500" width="10%">Qty</th>
                    <th class="py-2 text-right text-xs font-bold uppercase tracking-wider text-slate-500" width="17%">Price</th>
                    <th class="py-2 text-right text-xs font-bold uppercase tracking-wider text-slate-500" width="18%">Total</th>
                    <th v-if="!isPdf" class="w-8" width="5%"></th>
                </tr>
            </thead>
            <tbody class="text-sm">
                <tr v-for="(item, i) in form.items" :key="i" class="group">
                    <td class="py-2 pr-2 align-top break-words">
                        <div v-if="isPdf" class="w-full">
                            <div class="font-bold text-slate-800 text-sm">{{ (item.desc || '').split('\n')[0] }}</div>
                            <div class="whitespace-pre-wrap text-[10px] text-slate-500 mt-0.5 leading-snug">{{ (item.desc || '').split('\n').slice(1).join('\n') }}</div>
                        </div>
                        <textarea v-else v-model="item.desc" rows="1" class="w-full bg-transparent resize-none overflow-hidden font-medium outline-none text-slate-800" oninput="this.style.height = ''; this.style.height = this.scrollHeight + 'px'"></textarea>
                    </td>
                    <td class="py-2 align-top text-center text-slate-600">
                        <div v-if="isPdf">{{ item.unit }}</div><input v-else v-model="item.unit" class="w-full text-center bg-transparent outline-none" placeholder="Unit">
                    </td> 
                    <td class="py-2 align-top text-center font-bold text-slate-800">
                        <div v-if="isPdf">{{ Number(item.qty) }}</div><input v-else v-model="item.qty" type="number" class="w-full text-center bg-transparent outline-none">
                    </td>
                    <td class="py-2 align-top text-right whitespace-nowrap text-slate-600">
                        <div v-if="isPdf">{{ formatRowMoney(item.price) }}</div><input v-else v-model="item.price" type="number" class="w-full text-right bg-transparent outline-none">
                    </td>
                    <td class="py-2 align-top text-right font-bold whitespace-nowrap text-slate-800">
                        {{ formatRowMoney(item.qty * item.price) }}
                    </td>
                    <td v-if="!isPdf" class="text-center align-top opacity-0 group-hover:opacity-100 transition-opacity">
                        <button @click="$emit('removeItem', i)" class="text-red-400 hover:text-red-600"><LegacyIcon class="fas fa-times" /></button>
                    </td>
                </tr>
            </tbody>
        </table>

        <div class="mb-4 no-print flex gap-2">
            <button @click="$emit('addItem')" class="text-xs font-bold uppercase border rounded px-3 py-2 hover:bg-gray-50 transition" :style="{ color: prefs.primaryColor, borderColor: prefs.primaryColor }"><LegacyIcon class="fas fa-plus mr-1" /> Add Line</button>
            <select @change="(e) => { const prod = props.products.find(p => p.id == e.target.value); $emit('addItem', prod); e.target.value = ''; }" class="text-xs border rounded px-3 py-2 bg-white focus:outline-none cursor-pointer w-64 shadow-sm hover:border-emerald-500 transition text-gray-600">
                <option value="" disabled selected>+ Pick Product...</option>
                <option v-for="p in props.products" :key="p.id" :value="p.id">{{ p.code ? `[${p.code}] ` : '' }}{{ p.name }}</option>
            </select>
        </div>

        <div class="flex justify-end mt-8 relative z-10">
            <div class="w-72">
                <div class="flex justify-between text-slate-500 mb-1 text-sm"><span>Subtotal</span><span class="font-mono">{{ prefs.currency }} {{ calculations.subtotal }}</span></div>
                <div class="flex justify-between text-slate-500 mb-1 text-sm items-center">
                    <div class="flex items-center gap-1"><span>Discount</span><div v-if="!isPdf" class="flex items-center bg-gray-100 rounded px-1"><input v-model="form.discount" type="number" class="w-10 bg-transparent text-right font-bold text-xs outline-none" placeholder="0"><span class="text-xs">%</span></div><span v-else class="text-xs">({{ form.discount || 0 }}%)</span></div>
                    <span class="text-red-400 font-mono">- {{ prefs.currency }} {{ calculations.discount }}</span>
                </div>
                <div class="flex justify-between text-slate-500 mb-2 text-sm items-center pb-1">
                    <div class="flex items-center gap-1"><span>Tax</span><div v-if="!isPdf" class="flex items-center bg-gray-100 rounded px-1"><input v-model="form.taxRate" type="number" class="w-10 bg-transparent text-right font-bold text-xs outline-none" placeholder="0"><span class="text-xs">%</span></div><span v-else class="text-xs">({{ form.taxRate || 0 }}%)</span></div>
                    <span class="font-mono">+ {{ prefs.currency }} {{ calculations.tax }}</span>
                </div>
                <div class="flex justify-between font-bold text-xl text-slate-800 pt-2 border-t border-slate-200"><span>Total</span><span>{{ prefs.currency }} {{ calculations.grandTotal }}</span></div>
            </div>
        </div>

        <div class="mt-8 text-xs text-gray-500 relative z-10 avoid-break">
            <div class="flex items-center gap-2 mb-2">
                <span class="font-bold uppercase tracking-wider text-[10px] text-gray-400">Date Issued:</span> 
                <span v-if="isPdf" class="font-mono">{{ form.date }}</span>
                <input v-else v-model="form.date" type="date" class="bg-transparent outline-none font-mono">
            </div>
            
            <div class="flex justify-between items-center mb-0.5 max-w-lg">
                <div class="font-extrabold uppercase tracking-wider text-[12px] text-slate-900">Notes / Terms / Account Details:</div>
                <button v-if="!isPdf" @click="$emit('saveDefaultNotes')" class="text-[10px] font-bold text-blue-500 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-2 py-0.5 rounded cursor-pointer transition flex items-center shadow-sm">
                    <LegacyIcon class="fas fa-save mr-1" /> Save as Default
                </button>
            </div>
            
            <div v-if="isPdf" class="whitespace-pre-wrap italic leading-relaxed text-[11px] max-w-lg">{{ form.notes }}</div>
            <textarea v-else v-model="form.notes" class="w-full max-w-lg bg-transparent italic resize-none overflow-hidden outline-none border border-transparent hover:border-gray-200 p-1 rounded transition" rows="2" oninput="this.style.height = ''; this.style.height = this.scrollHeight + 'px'" placeholder="Payment terms, bank account details, etc..."></textarea>
        </div>
    </div>
</template>