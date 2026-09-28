<script setup>
import UserEditor from '../management/UserEditor.vue';
defineProps({ show: Boolean, companies: Array, user: Object });
defineEmits(['close','save']);
</script>
<template><UserEditor v-if="show" :companies="companies || []" :user="user" @close="$emit('close')" @saved="$emit('save')"/></template>
