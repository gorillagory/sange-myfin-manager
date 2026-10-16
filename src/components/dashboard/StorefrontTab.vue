<script setup>
import { computed } from 'vue';
import { Store } from '../../store';
import StorefrontAdmin from './StorefrontAdmin.vue';

const company = computed(() => Store.state.selectedCompany);
</script>

<template>
  <section v-if="company" class="ed-page mf-storefront-page">
    <StorefrontAdmin :company="company" />
  </section>
</template>

<style scoped>
.mf-storefront-page{max-width:1500px}
</style>
