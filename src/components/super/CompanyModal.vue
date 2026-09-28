<script setup>
import CompanyEditor from '../management/CompanyEditor.vue';
defineProps({ show: Boolean, company: Object, users: Array });
defineEmits(['close','save']);
</script>
<template><CompanyEditor v-if="show" :company="company" :users="users || []" @close="$emit('close')" @saved="$emit('save',$event)"/></template>
