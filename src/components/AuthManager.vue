<script setup>
import EditionLogin from './EditionLogin.vue';
import PosLogin from './PosLogin.vue';
import TerminalSetup from './TerminalSetup.vue';
</script>
<template><TerminalSetup v-if="$route.path==='/terminal-setup'"/><PosLogin v-else-if="$route.path==='/poslog'"/><EditionLogin v-else /></template>
