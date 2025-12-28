<script setup>
const props = defineProps(['form', 'company', 'prefs', 'clients', 'isPdf', 'calculations', 'products']);
const emit = defineEmits(['removeItem', 'addItem']);
</script>
<template>
    <div class="flex-grow flex flex-col h-full">
        <div class="bg-slate-50 border p-6 mb-8 flex justify-between items-center">
            <div>
                <img v-if="company.logo && prefs.showLogo" :src="company.logo" class="h-16 object-contain mb-2">
                <h1 class="text-3xl font-bold underline decoration-2 underline-offset-4" :style="{ color: prefs.primaryColor, textDecorationColor: prefs.primaryColor }">{{ form.type === 'Quote' ? prefs.labels.quote : prefs.labels.invoice }}</h1>
            </div>
            <div class="text-right"><div class="font-bold text-lg">{{ company.name }}</div><div>{{ form.number }}</div></div>
        </div>

        <div class="mb-8 border p-4"><span class="font-bold mr-2">{{ prefs.labels.billTo }}:</span> 
             <span v-if="isPdf" class="font-bold text-lg">{{ props.clients.find(c => c.id === form.client_id)?.name || 'Unknown' }}</span>
             <select v-else v-model="form.client_id" class="bg-transparent font-bold text-lg w-1/2"><option value="" disabled>Select...</option><option v-for="c in clients" :value="c.id">{{ c.name }}</option></select>
        </div>

        <table class="w-full mb-8 border">
            <thead class="text-white" :style="{ backgroundColor: prefs.primaryColor }">
                <tr>
                <th class="py-2 px-2 text-left w-[55%]">Description</th>
                <th class="py-2 text-center w-[10%]">Unit</th>
                <th class="py-2 text-center w-[5%]">Qty</th>
                <th class="py-2 text-right w-[15%]">Price</th>
                <th class="py-2 text-right px-2 w-[15%]">Total</th>
                <th class="no-print w-[0%]"></th></tr>
            </thead>
            <tbody>
                <tr v-for="(item, i) in form.items" :key="i" class="border-b">
                    <td class="py-2 px-2 align-top"><div v-if="isPdf" class="whitespace-pre-wrap break-words w-full">{{ (item.desc || '').split('\n')[0] }}<div class="text-[10px] mt-1 text-gray-500">{{ (item.desc || '').split('\n').slice(1).join('\n') }}</div></div><textarea v-else v-model="item.desc" rows="1" class="w-full bg-transparent resize-none overflow-hidden" oninput="this.style.height = ''; this.style.height = this.scrollHeight + 'px'"></textarea></td>
                    <td class="py-2 align-top text-center"><div v-if="isPdf">{{ item.unit }}</div><input v-else v-model="item.unit" class="w-full text-center bg-transparent" placeholder="Unit"></td>
                    <td class="py-2 align-top text-center"><div v-if="isPdf">{{ Number(item.qty).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 }) }}</div><input v-else v-model="item.qty" type="number" class="w-full text-center bg-transparent"></td>
                    <td class="py-2 align-top text-right"><div v-if="isPdf"><span class="text-xs text-gray-400 mr-1">{{ prefs.currency }}</span>{{ Number(item.price).toLocaleString('en-US', {minimumFractionDigits: 2}) }}</div><input v-else v-model="item.price" type="number" class="w-full text-right bg-transparent"></td>
                    <td class="py-2 align-top text-right font-bold px-2"><span class="text-xs text-gray-400 mr-1">{{ prefs.currency }}</span>{{ (item.qty * item.price).toLocaleString('en-US', {minimumFractionDigits: 2}) }}</td>
                    <td class="no-print text-center align-top"><button @click="$emit('removeItem', i)" class="text-red-400"><i class="fas fa-times"></i></button></td>
                </tr>
            </tbody>
        </table>

        <div class="mb-4 no-print flex gap-2">
            <button @click="$emit('addItem')" class="text-sm font-bold uppercase border rounded px-3 py-1 hover:bg-gray-50 dark:hover:bg-slate-700 dark:border-slate-600 transition" :style="{ color: prefs.primaryColor }">+ Empty Line</button>
            <select @change="(e) => { const prod = props.products.find(p => p.id == e.target.value); $emit('addItem', prod); e.target.value = ''; }" class="text-sm border rounded px-3 py-1 bg-white dark:bg-slate-700 dark:border-slate-600 dark:text-white focus:outline-none cursor-pointer w-64 shadow-sm hover:border-emerald-500 transition">
                <option value="" disabled selected>+ Pick Product/Service...</option>
                <option v-for="p in props.products" :key="p.id" :value="p.id">{{ p.code ? `[${p.code}] ` : '' }}{{ p.name }} - RM {{ Number(p.price).toFixed(2) }}</option>
            </select>
        </div>

        <div class="flex justify-end mt-auto">
            <div class="w-72 border p-4 bg-slate-50 shadow-sm">
                <div class="flex justify-between text-sm mb-1 text-gray-600"><span>Subtotal</span><span>{{ prefs.currency }} {{ calculations.subtotal }}</span></div>
                
                <div class="flex justify-between text-sm mb-1 text-gray-600 items-center">
                    <div class="flex items-center gap-2"><span>Discount</span><div v-if="!isPdf" class="flex bg-white border rounded px-1"><input v-model="form.discount" type="number" class="w-10 text-right text-xs outline-none bg-transparent" placeholder="0"><span class="text-xs">%</span></div><span v-else>({{ form.discount || 0 }}%)</span></div>
                    <span class="text-red-500">- {{ prefs.currency }} {{ calculations.discount }}</span>
                </div>

                <div class="flex justify-between text-sm mb-2 text-gray-600 border-b border-gray-300 pb-2 items-center">
                    <div class="flex items-center gap-2"><span>Tax</span><div v-if="!isPdf" class="flex bg-white border rounded px-1"><input v-model="form.taxRate" type="number" class="w-10 text-right text-xs outline-none bg-transparent" placeholder="0"><span class="text-xs">%</span></div><span v-else>({{ form.taxRate || 0 }}%)</span></div>
                    <span>{{ prefs.currency }} {{ calculations.tax }}</span>
                </div>

                <div class="flex justify-between font-bold text-xl text-slate-800"><span>{{ prefs.labels.total }}</span><span>{{ prefs.currency }} {{ calculations.grandTotal }}</span></div>
            </div>
        </div>

        <div class="mt-8 pt-4 text-sm opacity-75 border-t border-dotted">
            <div class="flex items-center gap-2"><span class="font-bold">Date:</span> <span v-if="isPdf">{{ form.date }}</span><input v-else v-model="form.date" type="date" class="bg-transparent"></div>
            <div v-if="isPdf" class="whitespace-pre-wrap mt-2 italic">{{ form.notes }}</div><textarea v-else v-model="form.notes" class="w-full bg-transparent mt-2 italic resize-none overflow-hidden" rows="1" oninput="this.style.height = ''; this.style.height = this.scrollHeight + 'px'" placeholder="Terms..."></textarea>
        </div>
    </div>
</template>