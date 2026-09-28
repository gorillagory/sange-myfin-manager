<script setup>
import { computed } from 'vue';
import { Store } from '../../store';
import UserDirectory from '../management/UserDirectory.vue';
const companyId = computed(() => Store.state.selectedCompany?.id || '');
</script>
<template><UserDirectory :company-id="companyId" :companies="Store.state.companies"/></template>
