<script setup>
import {ref,computed,watch} from 'vue';
import Modal from '../../ui/EditionModal.vue';
import {codeImage,labelPdf} from '../../../services/printing';
import {safeFilename} from '../../../services/download';
const props=defineProps({product:Object,currency:String});defineEmits(['close']);
const option=ref(''),kind=ref('qr'),size=ref('50x30'),copies=ref(1),image=ref(''),error=ref(''),busy=ref(false);
const variant=computed(()=>props.product.variants?.find(v=>v.id===option.value));
const code=computed(()=>variant.value ? variant.value.barcode||variant.value.sku||'' : props.product.barcode||props.product.sku||'');
const name=computed(()=>props.product.name+(variant.value?` (${variant.value.name})`:''));
let generation=0;
watch([code,kind],async()=>{const current=++generation;error.value='';image.value='';try{const result=await codeImage(code.value,kind.value);if(current===generation)image.value=result;}catch(e){if(current===generation)error.value=e.message;}},{immediate:true});
async function labels(){busy.value=true;error.value='';try{const pdf=await labelPdf({name:name.value,code:code.value,price:variant.value?.price??props.product.price,kind:kind.value,size:size.value,copies:copies.value,currency:props.currency});pdf.save(`${safeFilename(code.value)}-labels.pdf`);}catch(e){error.value=e.message;}finally{busy.value=false;}}
</script>
<template><Modal title="SKU resources & labels" wide :busy="busy" @close="$emit('close')">
<h3>{{ product.name }}</h3><div class="ed-form-grid" style="margin-top:20px">
<label v-if="product.variants?.length" class="ed-field"><span>Product / variant</span><select v-model="option"><option value="">Parent product (opens variant choices)</option><option v-for="v in product.variants" :key="v.id" :value="v.id">{{ v.name }}</option></select></label>
<label class="ed-field"><span>Code type</span><select v-model="kind"><option value="qr">QR code</option><option value="barcode">Code 128 barcode</option></select></label>
<div class="ed-code-preview wide"><img v-if="image" :src="image" :alt="`${kind} for ${code}`"><strong>{{ code||'Add a unique SKU or barcode to this variant.' }}</strong><a v-if="image" class="ed-btn" :href="image" :download="`${safeFilename(code)}-${kind}.png`">Download code PNG</a></div>
<label class="ed-field"><span>Sticker size</span><select v-model="size"><option value="50x30">50 × 30 mm</option><option value="40x30">40 × 30 mm</option><option value="60x40">60 × 40 mm</option></select></label>
<label class="ed-field"><span>Number of labels</span><input v-model.number="copies" type="number" min="1" max="100" step="1" inputmode="numeric"></label>
<p class="ed-muted wide">Download the label PDF and print at actual size (100%) using the matching paper size in your sticker printer driver. Test one label before printing a batch.</p>
<p v-if="product.variants?.length&&!variant" class="ed-notice wide">Choose a variant for its selling-price sticker. Parent codes open the product’s option list at checkout.</p>
<p v-if="error" class="ed-alert wide" role="alert">{{ error }}</p>
</div><template #actions><button class="ed-btn" :disabled="busy" @click="$emit('close')">Close</button><button class="ed-btn primary" :disabled="busy||!image||(product.variants?.length&&!variant)" @click="labels">{{ busy?'Preparing…':'Download sticker PDF' }}</button></template>
</Modal></template>
