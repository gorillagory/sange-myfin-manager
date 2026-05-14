<script setup>
import { ref, computed } from 'vue';

const props = defineProps(['clients', 'selectedClient']);
const emit = defineEmits(['select', 'clear']);
const search = ref('');

const filteredClients = computed(() => {
    if (!search.value) return props.clients;
    const q = search.value.toLowerCase();
    return props.clients.filter(c => c.name.toLowerCase().includes(q));
});
</script>

<template>
    <div class="w-72 bg-white dark:bg-slate-800 border-r dark:border-slate-700 flex flex-col z-10 shadow-lg h-full transition-colors duration-300">
        <div class="p-4 border-b dark:border-slate-700">
            <h2 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Client Directory</h2>
            <input v-model="search" placeholder="Search Clients..." class="w-full bg-gray-100 dark:bg-slate-900 dark:text-white border-none rounded p-2 text-sm outline-none focus:ring-2 ring-emerald-500 transition-colors">
        </div>
        
        <div class="flex-grow overflow-y-auto">
            <div @click="$emit('clear')" 
                 class="p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700 border-b dark:border-slate-700 transition"
                 :class="!selectedClient ? 'bg-emerald-50 dark:bg-slate-700 border-l-4 border-emerald-500' : 'border-l-4 border-transparent'">
                <div class="font-bold text-slate-800 dark:text-white">All Clients</div>
                <div class="text-xs text-gray-500">Global Overview</div>
            </div>

            <div v-for="c in filteredClients" :key="c.id" @click="$emit('select', c)" 
                 class="p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700 border-b dark:border-slate-700 transition group"
                 :class="selectedClient?.id === c.id ? 'bg-emerald-50 dark:bg-slate-700 border-l-4 border-emerald-500' : 'border-l-4 border-transparent'">
                <div class="flex justify-between items-center">
                    <div class="font-bold text-slate-700 dark:text-gray-200 group-hover:text-emerald-600">{{ c.name }}</div>
                    <i v-if="selectedClient?.id === c.id" class="fas fa-chevron-right text-xs text-emerald-500"></i>
                </div>
                <div class="text-[10px] text-gray-400 mt-1 truncate">{{ c.phone || 'No Phone' }}</div>
            </div>
        </div>
    </div>
</template>