<script setup>
import { ref } from 'vue';

const props = defineProps({
    icon: String,
    label: String, 
    confirmLabel: { type: String, default: 'Sure?' }, 
    color: { type: String, default: 'text-gray-400 hover:text-gray-600' }, 
    confirmColor: { type: String, default: 'text-red-500 font-bold bg-red-50 rounded px-2 text-xs' } 
});

const emit = defineEmits(['confirmed']);
const state = ref('idle'); 
let timeout = null;

function handleClick() {
    if (state.value === 'idle') {
        state.value = 'confirming';
        timeout = setTimeout(() => { state.value = 'idle'; }, 3000); // Reset after 3s
    } else {
        clearTimeout(timeout);
        state.value = 'idle';
        emit('confirmed');
    }
}
</script>

<template>
    <button type="button" 
        @click.stop="handleClick" 
        class="transition-all duration-200 whitespace-nowrap"
        :class="state === 'confirming' ? confirmColor : color"
        :title="state === 'idle' ? (label || 'Action') : 'Click again to confirm'">
        
        <span v-if="state === 'idle'">
            <i v-if="icon" :class="icon"></i>
            <span v-if="label" class="ml-1">{{ label }}</span>
        </span>
        
        <span v-else class="flex items-center animate-pulse">
            <i class="fas fa-exclamation-circle mr-1"></i>
            {{ confirmLabel }}
        </span>
    </button>
</template>