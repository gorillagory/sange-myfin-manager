<script setup>
const props = defineProps(['form', 'company', 'prefs', 'clients', 'isPdf', 'calculations', 'products']);
const emit = defineEmits(['removeItem', 'addItem', 'saveDefaultNotes']);

// Helper format for strict 1,000,000.00 styling inside the template rows
const formatRowMoney = (n) => Number(n || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const clientName = () => props.clients.find(c => c.id === props.form.client_id)?.name || 'Unknown';
const docTitle = () => props.form.type === 'Quote' ? props.prefs.labels.quote : props.prefs.labels.invoice;
</script>

<template>
    <div class="doc-clean font-sans text-slate-800 relative bg-white">
        
        <div v-if="form.status === 'Cleared'" 
             class="absolute top-40 right-10 border-4 border-green-600 text-green-600 font-black text-6xl uppercase opacity-30 transform -rotate-12 px-4 py-2 pointer-events-none select-none z-0">
            PAID
        </div>

        <table class="w-full mb-8 border-collapse" width="100%">
            <tbody>
                <tr>
                    <td class="align-top" width="52%">
                        <img v-if="company.logo && prefs.showLogo" :src="company.logo" class="h-24 w-auto object-contain mb-4">
                        
                        <h1 class="text-4xl font-black tracking-widest uppercase leading-none mb-2" :style="{ color: prefs.primaryColor }">
                            {{ docTitle() }}
                        </h1>
                        <div class="text-[10px] uppercase tracking-wider text-slate-400 font-black">{{ form.status || 'Pending' }}</div>
                    </td>

                    <td class="align-top text-right" width="48%">
                        <div class="font-bold text-xl text-slate-900">{{ company.name }}</div>
                        <div class="text-sm opacity-75 whitespace-pre-line leading-tight mt-1 text-slate-600">
                            {{ company.address1 || company.address }}
                        </div>
                        <div v-if="company.phone" class="text-sm text-slate-600 mt-1">{{ company.phone }}</div>
                        <div v-if="company.email" class="text-sm text-slate-600">{{ company.email }}</div>
                        <div v-if="company.registration" class="text-[10px] font-bold uppercase tracking-wider text-slate-400 mt-2">Reg: {{ company.registration }}</div>
                    </td>
                </tr>
            </tbody>
        </table>

        <div class="grid grid-cols-2 gap-8 mb-8 relative z-10 border-y border-slate-200 py-4">
            <div>
                <div class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">{{ prefs.labels.billTo }}</div>
                <div v-if="isPdf" class="font-black text-lg text-slate-800 leading-tight">{{ clientName() }}</div>
                <select v-else v-model="form.client_id" class="w-full bg-transparent font-black text-lg border-b border-gray-300 outline-none pb-1">
                    <option value="" disabled>Select Client...</option>
                    <option v-for="c in clients" :value="c.id">{{ c.name }}</option>
                </select>
                <div v-if="form.project" class="mt-2 text-xs font-bold text-slate-500">
                    <span class="uppercase tracking-wider text-gray-400 mr-1">Project</span>{{ form.project }}
                </div>
            </div>
            <div>
                <div class="grid grid-cols-2 gap-3 text-sm">
                    <div>
                        <div class="text-[10px] font-bold uppercase tracking-wider text-gray-400">Date Issued</div>
                        <span v-if="isPdf" class="font-mono font-bold">{{ form.date }}</span>
                        <input v-else v-model="form.date" type="date" class="bg-transparent outline-none font-mono font-bold w-full">
                    </div>
                    <div>
                        <div class="text-[10px] font-bold uppercase tracking-wider text-gray-400">Reference</div>
                        <div class="font-mono font-bold">{{ form.number }}</div>
                    </div>
                </div>
            </div>
        </div>

        <table class="w-full mb-2 border-collapse table-fixed relative z-10" width="100%">
            <thead>
                <tr class="border-y border-slate-300">
                    <th class="py-3 text-left text-xs font-black uppercase tracking-wider text-slate-600" width="45%">Description</th> 
                    <th class="py-3 text-center text-xs font-black uppercase tracking-wider text-slate-600" width="10%">Unit</th>
                    <th class="py-3 text-center text-xs font-black uppercase tracking-wider text-slate-600" width="10%">Qty</th>
                    <th class="py-3 text-right text-xs font-black uppercase tracking-wider text-slate-600" width="17%">Price</th>
                    <th class="py-3 text-right text-xs font-black uppercase tracking-wider text-slate-600" width="18%">Total</th>
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
                        <button @click="$emit('removeItem', i)" class="text-red-400 hover:text-red-600"><i class="fas fa-times"></i></button>
                    </td>
                </tr>
            </tbody>
        </table>

        <div class="mb-4 no-print flex gap-2">
            <button @click="$emit('addItem')" class="text-xs font-bold uppercase border rounded px-3 py-2 hover:bg-gray-50 transition" :style="{ color: prefs.primaryColor, borderColor: prefs.primaryColor }"><i class="fas fa-plus mr-1"></i> Add Line</button>
            <select @change="(e) => { const prod = props.products.find(p => p.id == e.target.value); $emit('addItem', prod); e.target.value = ''; }" class="text-xs border rounded px-3 py-2 bg-white focus:outline-none cursor-pointer w-64 shadow-sm hover:border-emerald-500 transition text-gray-600">
                <option value="" disabled selected>+ Pick Product...</option>
                <option v-for="p in props.products" :key="p.id" :value="p.id">{{ p.code ? `[${p.code}] ` : '' }}{{ p.name }}</option>
            </select>
        </div>

        <div class="flex justify-end mt-8 relative z-10">
            <div class="w-80">
                <div class="flex justify-between text-slate-500 mb-1 text-sm"><span>Subtotal</span><span class="font-mono">{{ prefs.currency }} {{ calculations.subtotal }}</span></div>
                <div class="flex justify-between text-slate-500 mb-1 text-sm items-center">
                    <div class="flex items-center gap-1"><span>Discount</span><div v-if="!isPdf" class="flex items-center bg-gray-100 rounded px-1"><input v-model="form.discount" type="number" class="w-10 bg-transparent text-right font-bold text-xs outline-none" placeholder="0"><span class="text-xs">%</span></div><span v-else class="text-xs">({{ form.discount || 0 }}%)</span></div>
                    <span class="text-red-400 font-mono">- {{ prefs.currency }} {{ calculations.discount }}</span>
                </div>
                <div class="flex justify-between text-slate-500 mb-2 text-sm items-center pb-1">
                    <div class="flex items-center gap-1"><span>Tax</span><div v-if="!isPdf" class="flex items-center bg-gray-100 rounded px-1"><input v-model="form.taxRate" type="number" class="w-10 bg-transparent text-right font-bold text-xs outline-none" placeholder="0"><span class="text-xs">%</span></div><span v-else class="text-xs">({{ form.taxRate || 0 }}%)</span></div>
                    <span class="font-mono">+ {{ prefs.currency }} {{ calculations.tax }}</span>
                </div>
                <div class="flex justify-between font-black text-2xl text-slate-800 pt-3 border-t-2 border-slate-800"><span>Total</span><span>{{ prefs.currency }} {{ calculations.grandTotal }}</span></div>
            </div>
        </div>

        <div class="mt-8 text-xs text-gray-500 relative z-10 avoid-break border-t border-slate-200 pt-5">
            <div class="flex justify-between items-center mb-2 max-w-2xl">
                <div class="font-black uppercase tracking-wider text-[12px] text-slate-900">Terms & Conditions</div>
                <button v-if="!isPdf" @click="$emit('saveDefaultNotes')" class="text-[10px] font-bold text-blue-500 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-2 py-0.5 rounded cursor-pointer transition flex items-center shadow-sm">
                    <i class="fas fa-save mr-1"></i> Save as Default
                </button>
            </div>
            
            <div v-if="isPdf" class="whitespace-pre-wrap leading-relaxed text-[11px] max-w-2xl">{{ form.notes }}</div>
            <textarea v-else v-model="form.notes" class="w-full max-w-2xl bg-slate-50 resize-none overflow-hidden outline-none border border-slate-200 hover:border-gray-300 p-3 rounded transition" rows="3" oninput="this.style.height = ''; this.style.height = this.scrollHeight + 'px'" placeholder="Payment terms, bank account details, etc..."></textarea>
        </div>
    </div>
</template>
