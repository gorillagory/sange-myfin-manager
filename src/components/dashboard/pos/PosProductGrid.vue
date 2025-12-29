<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
    products: Array,
    categories: Array
});

const emit = defineEmits(['add-to-cart']);

const searchQuery = ref('');
const selectedCategory = ref('All');

// Local Filter Logic
const filteredProducts = computed(() => {
    let list = props.products;
    if (selectedCategory.value !== 'All') {
        list = list.filter(p => p.category === selectedCategory.value);
    }
    if (searchQuery.value) {
        const q = searchQuery.value.toLowerCase();
        list = list.filter(p => 
            p.name.toLowerCase().includes(q) || 
            p.code?.toLowerCase().includes(q)
        );
    }
    return list;
});
</script>

<template>
    <div class="flex-grow flex flex-col bg-white dark:bg-slate-800 rounded-xl shadow border dark:border-slate-700 overflow-hidden">
        <div class="p-4 border-b dark:border-slate-700 flex gap-2">
            <div class="relative flex-grow">
                <i class="fas fa-search absolute left-3 top-3 text-gray-400"></i>
                <input v-model="searchQuery" placeholder="Search Products..." class="w-full bg-gray-100 dark:bg-slate-900 border-none rounded-lg pl-10 pr-4 py-2 outline-none transition focus:ring-2 focus:ring-emerald-500/20">
            </div>
            <select v-model="selectedCategory" class="bg-gray-100 dark:bg-slate-900 rounded-lg px-4 py-2 outline-none text-sm font-bold cursor-pointer hover:bg-gray-200 transition">
                <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
            </select>
        </div>

        <div class="p-4 overflow-y-auto grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 content-start flex-grow">
            <div v-for="p in filteredProducts" :key="p.id" 
                @click="$emit('add-to-cart', p)"
                class="bg-gray-50 dark:bg-slate-700 hover:bg-white dark:hover:bg-slate-600 border dark:border-slate-600 hover:border-emerald-500 hover:shadow-md cursor-pointer rounded-xl p-3 transition-all duration-200 flex flex-col justify-between group h-32 relative overflow-hidden">
                
                <div>
                    <div class="font-bold text-sm text-slate-700 dark:text-gray-200 leading-tight mb-1 line-clamp-2">{{ p.name }}</div>
                    <div class="text-[10px] text-gray-500 uppercase tracking-wider">{{ p.code }}</div>
                </div>
                
                <div class="flex justify-between items-end mt-2">
                    <div class="font-bold text-emerald-600 dark:text-emerald-400">RM {{ Number(p.price).toFixed(2) }}</div>
                    <div v-if="p.variants?.length" class="text-[10px] bg-slate-200 dark:bg-slate-900 px-2 py-0.5 rounded-full text-slate-600 dark:text-gray-300 font-bold">
                        {{ p.variants.length }} <span class="hidden sm:inline">Options</span>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>