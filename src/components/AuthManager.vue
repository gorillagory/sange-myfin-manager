<script setup>
import EditionLogin from './EditionLogin.vue';
import PosLogin from './PosLogin.vue';
</script>
<template><PosLogin v-if="$route.path==='/poslog'"/><EditionLogin v-else /></template>
