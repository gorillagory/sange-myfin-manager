<script setup>
import { ref, onMounted, onBeforeUnmount, useId } from 'vue';
import Icon from './EditionIcon.vue';
const props = defineProps({ title: String, busy: Boolean, wide: Boolean });
const emit = defineEmits(['close']);
const dialog = ref(null), id = useId();
let previousFocus;
onMounted(() => { previousFocus = document.activeElement; dialog.value.showModal(); });
onBeforeUnmount(() => { dialog.value?.close(); if (previousFocus?.isConnected) previousFocus.focus(); });
function close(event) { if (event) event.preventDefault(); if (!props.busy) emit('close'); }
</script>
<template>
  <Teleport to="body"><dialog ref="dialog" class="ed-modal edition-app" :class="{wide}" :aria-labelledby="id" @cancel="close">
    <header><h2 :id="id">{{ title }}</h2><button class="ed-icon-button" aria-label="Close dialog" :disabled="busy" @click="close"><Icon name="close" /></button></header>
    <div class="ed-modal-body"><slot /></div><footer v-if="$slots.actions"><slot name="actions" /></footer>
  </dialog></Teleport>
</template>
