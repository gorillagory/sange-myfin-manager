<script setup>
import {ref,watch} from 'vue';
import Modal from '../ui/EditionModal.vue';
import {codeImage,labelPdf,LABEL_DESIGNS} from '../../services/printing';
import {safeFilename} from '../../services/download';
import {Store} from '../../store';

const props=defineProps({item:{type:Object,required:true}});
defineEmits(['close']);
const kind=ref('qr'),size=ref('50x30'),copies=ref(1),image=ref(''),error=ref(''),busy=ref(false);
const design=ref('classic'),accent=ref(Store.state.selectedCompany?.preferences?.primaryColor||'#245C49'),subtitle=ref('Stock item');
let generation=0;
watch(kind,async()=>{
  const current=++generation;error.value='';image.value='';
  try{const result=await codeImage(props.item.internalCode,kind.value);if(current===generation)image.value=result;}
  catch(failure){if(current===generation)error.value=failure.message;}
},{immediate:true});
async function labels(){
  busy.value=true;error.value='';
  try{
    const pdf=await labelPdf({name:props.item.name,code:props.item.internalCode,price:0,kind:kind.value,size:size.value,copies:copies.value,currency:'',showPrice:false,design:design.value,accent:accent.value,subtitle:subtitle.value});
    pdf.save(`${safeFilename(props.item.internalCode)}-stock-labels.pdf`);
  }catch(failure){error.value=failure.message;}finally{busy.value=false;}
}
</script>

<template><Modal title="Stock code & labels" wide :busy="busy" @close="$emit('close')">
  <h3>{{ item.name }}</h3><p class="ed-muted">This stable internal code identifies the stock record. Supplier and package barcodes remain separate.</p>
  <div class="ed-form-grid" style="margin-top:20px">
    <label class="ed-field"><span>Code type</span><select v-model="kind"><option value="qr">QR code</option><option value="barcode">Code 128 barcode</option></select></label>
    <div class="ed-code-preview wide"><img v-if="image" :src="image" :alt="`${kind} for ${item.internalCode}`"><strong>{{ item.internalCode }}</strong><a v-if="image" class="ed-btn" :href="image" :download="`${safeFilename(item.internalCode)}-${kind}.png`">Download code PNG</a></div>
    <label class="ed-field"><span>Sticker size</span><select v-model="size"><option value="50x30">50 × 30 mm</option><option value="40x30">40 × 30 mm</option><option value="60x40">60 × 40 mm</option></select></label>
    <label class="ed-field"><span>Number of labels</span><input v-model.number="copies" type="number" min="1" max="100" step="1" inputmode="numeric"></label>
    <label class="ed-field"><span>Label design</span><select v-model="design"><option v-for="item in LABEL_DESIGNS" :key="item.id" :value="item.id">{{ item.label }} · {{ item.description }}</option></select></label>
    <label class="ed-field"><span>Brand color</span><input v-model="accent" type="color"></label>
    <label class="ed-field wide"><span>Short label line</span><input v-model.trim="subtitle" maxlength="60" placeholder="Example: Stock item · Dry store"></label>
    <p class="ed-muted wide">The PDF includes the selected QR or barcode and your design. Print at actual size using calibrated label media. Test one label with the stock camera or scanner before printing a batch.</p>
    <p v-if="error" class="ed-alert wide" role="alert">{{ error }}</p>
  </div>
  <template #actions><button class="ed-btn" :disabled="busy" @click="$emit('close')">Close</button><button class="ed-btn primary" :disabled="busy||!image" @click="labels">{{ busy?'Preparing…':'Download sticker PDF' }}</button></template>
</Modal></template>
