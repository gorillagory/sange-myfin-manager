<script setup>
import { computed } from 'vue';
import DocumentPreview from './DocumentPreview.vue';
import { presentDocument } from '../../../domain/documentPresentation';
const props=defineProps(['form','company','prefs','clients']);
const document=computed(()=>presentDocument(props.form,props.company,(props.clients||[]).find(client=>client.id===props.form?.client_id)||{},{settings:{...props.prefs,layout:'modern'}}));
</script>
<template><DocumentPreview :document="document"/></template>
