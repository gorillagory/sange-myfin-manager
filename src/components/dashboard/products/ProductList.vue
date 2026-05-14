<script setup>
const props = defineProps({
    products: { type: Array, required: true },
    currency: { type: String, default: 'RM' }
});
const emit = defineEmits(['edit', 'delete']);
</script>

<template>
    <div class="bg-white dark:bg-slate-800 rounded-xl shadow border dark:border-slate-700 overflow-hidden flex-grow flex flex-col w-full">
        <div class="overflow-y-auto overflow-x-auto flex-grow w-full">
            <table class="w-full text-left border-collapse min-w-[600px]">
                <thead class="bg-gray-50 dark:bg-slate-900 sticky top-0 z-10 text-xs font-bold text-gray-500 uppercase">
                    <tr>
                        <th class="p-4">Item Name</th>
                        <th class="p-4">Category</th>
                        <th class="p-4 text-right">Stock</th>
                        <th class="p-4 text-right">Price</th>
                        <th class="p-4 text-right">Actions</th>
                    </tr>
                </thead>
                <tbody class="text-sm">
                    <tr v-for="p in products" :key="p.id" class="border-b dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50">
                        <td class="p-4 font-bold text-slate-800 dark:text-white">
                            <div>{{ p.name }}</div>
                            <div class="text-[10px] text-gray-400 font-mono">{{ p.sku }}</div>
                        </td>
                        <td class="p-4">
                            <span class="px-2 py-1 rounded text-[10px] font-bold uppercase bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-300">
                                {{ p.category }}
                            </span>
                        </td>
                        <td class="p-4 text-right font-mono">
                            <span v-if="!p.trackStock && p.category === 'Service'" class="text-blue-500 text-xs font-bold">N/A</span>
                            <span v-else-if="p.variants?.length" class="text-gray-400 text-xs italic">See Variants</span>
                            <span v-else :class="p.stock <= 5 ? 'text-red-500 font-bold' : 'text-emerald-600'">
                                {{ p.stock }} {{ p.unit || 'pcs' }}
                            </span>
                        </td>
                        <td class="p-4 text-right font-bold text-slate-700 dark:text-gray-300">
                            <span v-if="p.variants?.length">{{ currency }} {{ Math.min(...p.variants.map(v=>v.price)) }} - {{ Math.max(...p.variants.map(v=>v.price)) }}</span>
                            <span v-else>{{ currency }} {{ p.price }}</span>
                        </td>
                        <td class="p-4 text-right space-x-3">
                            <button @click="$emit('edit', p)" class="text-blue-500 hover:text-blue-700"><i class="fas fa-edit"></i></button>
                            <button @click="$emit('delete', p.id)" class="text-red-400 hover:text-red-600"><i class="fas fa-trash"></i></button>
                        </td>
                    </tr>
                    <tr v-if="products.length === 0"><td colspan="5" class="p-10 text-center text-gray-400 italic">No products found.</td></tr>
                </tbody>
            </table>
        </div>
    </div>
</template>