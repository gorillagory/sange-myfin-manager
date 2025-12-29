<script setup>
const props = defineProps(['form', 'company', 'prefs', 'clients', 'isPdf', 'calculations', 'products']);
const emit = defineEmits(['removeItem', 'addItem']);
</script>

<template>
    <div class="doc-corporate font-serif text-slate-900 relative bg-white">
        
        <div v-if="form.status === 'Cleared'" 
             class="absolute top-40 right-10 border-4 border-green-600 text-green-600 font-black text-6xl uppercase opacity-30 transform -rotate-12 px-4 py-2 pointer-events-none select-none z-0">
            PAID
        </div>

        <table class="w-full mb-6 border-collapse" width="100%">
            <tbody>
                <tr>
                    <td class="align-top" width="60%">
                        <img v-if="company.logo && prefs.showLogo" :src="company.logo" class="h-20 w-auto object-contain mb-2">
                        <h1 class="text-3xl font-bold underline decoration-2 underline-offset-4 mb-2" :style="{ color: prefs.primaryColor, textDecorationColor: prefs.primaryColor }">
                            {{ form.type === 'Quote' ? prefs.labels.quote : prefs.labels.invoice }}
                        </h1>
                    </td>
                    <td class="align-top text-right" width="40%">
                        <div class="font-bold text-xl">{{ company.name }}</div>
                        <div class="text-sm font-sans text-gray-600 mt-1 whitespace-pre-line">{{ company.address1 || company.address }}</div>
                        <div class="font-bold text-lg mt-2 font-mono"># {{ form.number }}</div>
                    </td>
                </tr>
            </tbody>
        </table>

        <div class="mb-6 relative z-10">
            <span class="font-bold mr-2 text-sm uppercase text-gray-500 font-sans">{{ prefs.labels.billTo }}:</span> 
             <span v-if="isPdf" class="font-bold text-xl">{{ props.clients.find(c => c.id === form.client_id)?.name || 'Unknown' }}</span>
             <select v-else v-model="form.client_id" class="bg-transparent font-bold text-xl w-1/2 outline-none border-b border-dotted border-gray-400">
                <option value="" disabled>Select...</option>
                <option v-for="c in clients" :value="c.id">{{ c.name }}</option>
            </select>
        </div>

        <table class="w-full mb-2 border-collapse table-fixed relative z-10" width="100%">
            <thead>
                <tr class="text-white" :style="{ backgroundColor: prefs.primaryColor }">
                    <th class="py-2 px-2 text-left text-xs font-bold font-sans uppercase tracking-wider" width="45%">Description</th> 
                    <th class="py-2 text-center text-xs font-bold font-sans uppercase tracking-wider" width="10%">Unit</th>
                    <th class="py-2 text-center text-xs font-bold font-sans uppercase tracking-wider" width="10%">Qty</th>
                    <th class="py-2 text-right text-xs font-bold font-sans uppercase tracking-wider" width="17%">Price</th>
                    <th class="py-2 pr-2 text-right text-xs font-bold font-sans uppercase tracking-wider" width="18%">Total</th>
                    <th v-if="!isPdf" class="w-8" width="5%"></th>
                </tr>
            </thead>
            <tbody class="text-sm">
                <tr v-for="(item, i) in form.items" :key="i" class="group">
                    <td class="py-2 px-2 align-top break-words">
                        <div v-if="isPdf" class="w-full">
                            <div class="font-bold">{{ (item.desc || '').split('\n')[0] }}</div>
                            <div class="whitespace-pre-wrap text-[11px] text-gray-600 mt-0.5 font-sans">{{ (item.desc || '').split('\n').slice(1).join('\n') }}</div>
                        </div>
                        <textarea v-else v-model="item.desc" rows="1" class="w-full bg-transparent resize-none overflow-hidden outline-none" oninput="this.style.height = ''; this.style.height = this.scrollHeight + 'px'"></textarea>
                    </td>
                    <td class="py-2 align-top text-center font-sans text-gray-600">
                        <div v-if="isPdf">{{ item.unit }}</div><input v-else v-model="item.unit" class="w-full text-center bg-transparent outline-none" placeholder="Unit">
                    </td>
                    <td class="py-2 align-top text-center">
                        <div v-if="isPdf">{{ Number(item.qty) }}</div><input v-else v-model="item.qty" type="number" class="w-full text-center bg-transparent outline-none">
                    </td>
                    <td class="py-2 align-top text-right whitespace-nowrap font-sans">
                        <div v-if="isPdf">{{ Number(item.price).toLocaleString('en-US', {minimumFractionDigits: 2}) }}</div><input v-else v-model="item.price" type="number" class="w-full text-right bg-transparent outline-none">
                    </td>
                    <td class="py-2 pr-2 align-top text-right font-bold whitespace-nowrap font-sans">
                        {{ (item.qty * item.price).toLocaleString('en-US', {minimumFractionDigits: 2}) }}
                    </td>
                    <td v-if="!isPdf" class="text-center align-top opacity-0 group-hover:opacity-100 transition-opacity">
                        <button @click="$emit('removeItem', i)" class="text-red-400 hover:text-red-600"><i class="fas fa-times"></i></button>
                    </td>
                </tr>
            </tbody>
        </table>

        <div class="mb-4 no-print flex gap-2 font-sans">
            <button @click="$emit('addItem')" class="text-xs font-bold uppercase border rounded px-3 py-2 hover:bg-gray-50 transition" :style="{ color: prefs.primaryColor, borderColor: prefs.primaryColor }">+ Line</button>
            <select @change="(e) => { const prod = props.products.find(p => p.id == e.target.value); $emit('addItem', prod); e.target.value = ''; }" class="text-xs border rounded px-3 py-2 bg-white focus:outline-none cursor-pointer w-64 shadow-sm hover:border-emerald-500 transition text-gray-600">
                <option value="" disabled selected>+ Pick Product...</option>
                <option v-for="p in props.products" :key="p.id" :value="p.id">{{ p.code ? `[${p.code}] ` : '' }}{{ p.name }}</option>
            </select>
        </div>

        <div class="flex justify-end mt-8 relative z-10">
            <div class="w-72 bg-slate-50 p-4 border border-gray-100">
                <div class="flex justify-between text-sm mb-1 text-gray-600 font-sans"><span>Subtotal</span><span>{{ prefs.currency }} {{ calculations.subtotal }}</span></div>
                <div class="flex justify-between text-sm mb-1 text-gray-600 items-center font-sans">
                    <div class="flex items-center gap-1"><span>Discount</span><div v-if="!isPdf" class="flex bg-white border rounded px-1"><input v-model="form.discount" type="number" class="w-10 text-right text-xs outline-none bg-transparent" placeholder="0"><span class="text-xs">%</span></div><span v-else>({{ form.discount || 0 }}%)</span></div>
                    <span class="text-red-500">- {{ prefs.currency }} {{ calculations.discount }}</span>
                </div>
                <div class="flex justify-between text-sm mb-2 text-gray-600 border-b border-gray-300 pb-2 items-center font-sans">
                    <div class="flex items-center gap-1"><span>Tax</span><div v-if="!isPdf" class="flex bg-white border rounded px-1"><input v-model="form.taxRate" type="number" class="w-10 text-right text-xs outline-none bg-transparent" placeholder="0"><span class="text-xs">%</span></div><span v-else>({{ form.taxRate || 0 }}%)</span></div>
                    <span>{{ prefs.currency }} {{ calculations.tax }}</span>
                </div>
                <div class="flex justify-between font-bold text-xl text-slate-900"><span>Total</span><span>{{ prefs.currency }} {{ calculations.grandTotal }}</span></div>
            </div>
        </div>

        <div class="mt-4 pt-4 text-sm border-t border-dotted border-gray-400 relative z-10">
            <div class="flex items-center gap-2 mb-1"><span class="font-bold font-sans text-xs uppercase text-gray-500">Date:</span> <span v-if="isPdf">{{ form.date }}</span><input v-else v-model="form.date" type="date" class="bg-transparent outline-none"></div>
            <div v-if="isPdf" class="whitespace-pre-wrap italic mt-2">{{ form.notes }}</div><textarea v-else v-model="form.notes" class="w-full bg-transparent mt-2 italic resize-none overflow-hidden outline-none" rows="1" oninput="this.style.height = ''; this.style.height = this.scrollHeight + 'px'" placeholder="Terms..."></textarea>
        </div>
    </div>
</template>