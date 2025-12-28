<script setup>
const props = defineProps(['form', 'company', 'prefs', 'clients', 'isPdf', 'calculations', 'products']);
const emit = defineEmits(['removeItem', 'addItem']);
</script>

<template>
    <div class="flex-grow flex flex-col h-full">
        <div class="flex justify-between items-start mb-8 pb-4 border-b-2" :style="{ borderColor: prefs.primaryColor }">
            <div>
                <img v-if="company.logo && prefs.showLogo" :src="company.logo" class="h-24 w-auto object-contain mb-4">
                <h1 class="text-3xl font-bold tracking-widest uppercase" :style="{ color: prefs.primaryColor }">
                    {{ form.type === 'Quote' ? prefs.labels.quote : prefs.labels.invoice }}
                </h1>
                <div class="font-mono text-gray-500 mt-1"># {{ form.number }}</div>
            </div>
            <div class="text-right">
                <div class="font-bold text-xl">{{ company.name }}</div>
                <div class="text-sm opacity-75 whitespace-pre-line">{{ company.address1 }}</div>
            </div>
        </div>

        <div class="mb-8">
            <div class="text-xs font-bold text-gray-400 uppercase">{{ prefs.labels.billTo }}</div>
            <div v-if="isPdf" class="font-bold text-lg">{{ props.clients.find(c => c.id === form.client_id)?.name || 'Unknown' }}</div>
             <select v-else v-model="form.client_id" class="w-full bg-transparent font-bold text-lg border-b border-gray-300">
                <option value="" disabled>Select...</option>
                <option v-for="c in clients" :value="c.id">{{ c.name }}</option>
            </select>
        </div>

        <table class="w-full mb-8">
            <thead :style="{ color: prefs.primaryColor }" class="font-bold text-sm uppercase tracking-wider">
                <tr>
                    <th class="py-2 text-left w-[55%]">Description</th> 
                    <th class="py-2 text-center w-[10%]">Unit</th>
                    <th class="py-2 text-center w-[10%]">Qty</th>
                    <th class="py-2 text-right w-[12.5%]">Price</th>
                    <th class="py-2 text-right w-[12.5%]">Total</th>
                    <th class="no-print w-[0%]"></th>
                </tr>
            </thead>
            <tbody class="text-sm">
                <tr v-for="(item, i) in form.items" :key="i" class="group">
                    
                    <td class="py-3 pr-2 align-top">
                        <div v-if="isPdf" class="w-full break-words">
                            <div class="font-bold text-slate-800 leading-tight">
                                {{ (item.desc || '').split('\n')[0] }}
                            </div>
                            <div class="whitespace-pre-wrap text-[10px] text-slate-500 leading-snug mt-1">
                                {{ (item.desc || '').split('\n').slice(1).join('\n') }}
                            </div>
                        </div>
                        <textarea v-else v-model="item.desc" rows="1" class="w-full bg-transparent resize-none overflow-hidden font-medium" oninput="this.style.height = ''; this.style.height = this.scrollHeight + 'px'"></textarea>
                    </td>

                    <td class="py-3 align-top text-center">
                        <div v-if="isPdf">{{ item.unit }}</div>
                        <input v-else v-model="item.unit" class="w-full text-center bg-transparent" placeholder="Unit">
                    </td> 
                    <td class="py-3 align-top text-center">
                        <div v-if="isPdf">{{ Number(item.qty).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 }) }}</div>
                        <input v-else v-model="item.qty" type="number" class="w-full text-center bg-transparent">
                    </td>

                    <td class="py-3 align-top text-right whitespace-nowrap">
                        <div v-if="isPdf">
                            <span class="text-xs text-gray-400 mr-1">{{ prefs.currency }}</span>
                            {{ Number(item.price).toLocaleString('en-US', {minimumFractionDigits: 2}) }}
                        </div>
                        <input v-else v-model="item.price" type="number" class="w-full text-right bg-transparent">
                    </td>

                    <td class="py-3 align-top text-right font-bold whitespace-nowrap">
                        <span class="text-xs text-gray-400 mr-1 font-normal">{{ prefs.currency }}</span>
                        {{ (item.qty * item.price).toLocaleString('en-US', {minimumFractionDigits: 2}) }}
                    </td>
                    
                    <td class="no-print text-center align-top opacity-0 group-hover:opacity-100 transition-opacity">
                        <button @click="$emit('removeItem', i)" class="text-red-400 hover:text-red-600"><i class="fas fa-times"></i></button>
                    </td>
                </tr>
            </tbody>
        </table>

        <div class="mb-4 no-print flex gap-2">
            <button @click="$emit('addItem')" class="text-sm font-bold uppercase border rounded px-3 py-1 hover:bg-gray-50" :style="{ color: prefs.primaryColor }">+ Empty Line</button>
            <select @change="(e) => { const prod = props.products.find(p => p.id == e.target.value); $emit('addItem', prod); e.target.value = ''; }" class="text-sm border rounded px-3 py-1 bg-white focus:outline-none cursor-pointer w-64">
                <option value="" disabled selected>+ Pick Product...</option>
                <option v-for="p in props.products" :key="p.id" :value="p.id">{{ p.code ? `[${p.code}] ` : '' }}{{ p.name }}</option>
            </select>
        </div>

        <div class="flex justify-end mt-auto">
            <div class="w-72 border-t-2 pt-4" :style="{ borderColor: prefs.primaryColor }">
                
                <div class="flex justify-between text-gray-500 mb-2 text-sm">
                    <span>Subtotal</span>
                    <span>{{ prefs.currency }} {{ calculations.subtotal }}</span>
                </div>

                <div class="flex justify-between text-gray-500 mb-2 text-sm items-center">
                    <div class="flex items-center gap-1">
                        <span>Discount</span>
                        <div v-if="!isPdf" class="flex items-center bg-gray-100 rounded px-1">
                            <input v-model="form.discount" type="number" class="w-10 bg-transparent text-right font-bold text-xs outline-none" placeholder="0">
                            <span class="text-xs">%</span>
                        </div>
                        <span v-else class="text-xs">({{ form.discount || 0 }}%)</span>
                    </div>
                    <span>- {{ prefs.currency }} {{ calculations.discount }}</span>
                </div>

                <div class="flex justify-between text-gray-500 mb-4 text-sm items-center border-b pb-2">
                    <div class="flex items-center gap-1">
                        <span>Tax</span>
                        <div v-if="!isPdf" class="flex items-center bg-gray-100 rounded px-1">
                            <input v-model="form.taxRate" type="number" class="w-10 bg-transparent text-right font-bold text-xs outline-none" placeholder="0" value="8">
                            <span class="text-xs">%</span>
                        </div>
                        <span v-else class="text-xs">({{ form.taxRate || 0 }}%)</span>
                    </div>
                    <span>+ {{ prefs.currency }} {{ calculations.tax }}</span>
                </div>

                <div class="flex justify-between font-bold text-2xl text-slate-800">
                    <span>{{ prefs.labels.total }}</span>
                    <span>{{ prefs.currency }} {{ calculations.grandTotal }}</span>
                </div>
            </div>
        </div>

        <div class="mt-12 pt-6 text-sm opacity-75 border-t border-dotted">
             <div class="flex items-center gap-2">
                <span class="font-bold">Date:</span> 
                <span v-if="isPdf">{{ form.date }}</span>
                <input v-else v-model="form.date" type="date" class="bg-transparent">
            </div>
            <div v-if="isPdf" class="whitespace-pre-wrap mt-2 italic text-xs leading-relaxed text-slate-500">{{ form.notes }}</div>
            <textarea v-else v-model="form.notes" class="w-full bg-transparent mt-2 italic resize-none overflow-hidden" rows="1" oninput="this.style.height = ''; this.style.height = this.scrollHeight + 'px'" placeholder="Terms..."></textarea>
        </div>
    </div>
</template>