<script setup>
import { ref, watch } from 'vue';
import { stripConfidential } from '../../../domain/permissions';
import Modal from '../../ui/EditionModal.vue';
import { useProductLogic } from '../../../composables/useProductLogic';
const props = defineProps({show:Boolean,busy:Boolean,product:Object,categories:Array,subcategories:Array,currency:String,showCosts:Boolean});
const emit = defineEmits(['close','save']);
const {generateSKU} = useProductLogic();
const form=ref({}), imageFile=ref(null), preview=ref(''), fileError=ref('');
watch(()=>props.show, visible=>{
  if (!visible) { if(preview.value) URL.revokeObjectURL(preview.value); preview.value=''; return; }
  imageFile.value=null;fileError.value='';
  form.value = props.product ? JSON.parse(JSON.stringify(props.product)) : {name:'',sku:generateSKU('Retail'),category:'Retail',subcategory:'',unit:'pcs',description:'',barcode:'',imageUrl:'',trackStock:true,price:0,...(props.showCosts?{cost:0}:{}),stock:0,variants:[]};
  form.value.subcategory ||= '';
  if(!props.showCosts)form.value=stripConfidential(form.value);
  form.value.hasVariants=!!form.value.variants?.length;form.value.variants ||= [];
});
function categoryChanged(){ if(form.value.category==='Service'){form.value.trackStock=false;form.value.stock=0;} }
function chooseImage(event){
  const file=event.target.files?.[0];fileError.value='';if(!file)return;
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>3*1024*1024){fileError.value='Choose a JPG, PNG or WebP image up to 3 MB.';event.target.value='';return;}
  if(preview.value)URL.revokeObjectURL(preview.value);imageFile.value=file;preview.value=URL.createObjectURL(file);
}
function removeImage(){if(preview.value)URL.revokeObjectURL(preview.value);preview.value='';imageFile.value=null;form.value.imageUrl='';form.value.imagePath='';}
function addVariant(){form.value.variants.push({id:crypto.randomUUID(),name:'',sku:'',barcode:'',price:0,...(props.showCosts?{cost:0}:{}),stock:0});}
function save(){if(!props.busy)emit('save',{...form.value,variants:form.value.hasVariants?form.value.variants:[]},imageFile.value);}
</script>
<template>
<Modal v-if="show" :title="form.id?'Edit product':'New product'" wide :busy="busy" @close="emit('close')">
  <form id="product-editor" class="ed-editor" @submit.prevent="save">
    <fieldset :disabled="busy">
      <div class="ed-form-grid">
        <label class="ed-field"><span>Product name *</span><input v-model="form.name" required maxlength="120" placeholder="e.g. Latte" autofocus></label>
        <label class="ed-field"><span>Product SKU *</span><div class="ed-actions ed-sku-input"><input v-model.trim="form.sku" required maxlength="64" placeholder="BEV-LATTE"><button type="button" class="ed-btn" aria-label="Generate SKU" @click="form.sku=generateSKU(form.category)">Generate</button></div></label>
        <label class="ed-field"><span>Category *</span><input v-model.trim="form.category" list="inventory-category-list" maxlength="120" required placeholder="e.g. Menu" @change="categoryChanged"><datalist id="inventory-category-list"><option v-for="c in categories" :key="c" :value="c" /></datalist></label>
        <label class="ed-field"><span>Subcategory</span><input v-model.trim="form.subcategory" list="inventory-subcategory-list" maxlength="120" placeholder="e.g. Beverages"><datalist id="inventory-subcategory-list"><option v-for="c in subcategories" :key="c" :value="c" /></datalist><small>Optional second level used for grouping and filters.</small></label>
        <label class="ed-field"><span>Unit</span><input v-model="form.unit" required maxlength="24" placeholder="pcs, cup, kg"></label>
        <label class="ed-check"><input v-model="form.trackStock" type="checkbox" :disabled="form.category==='Service'">Track stock</label>
        <label class="ed-check"><input v-model="form.hasVariants" type="checkbox">This product has variants</label>
      </div>
      <div v-if="!form.hasVariants" class="ed-form-grid ed-three-fields ed-editor-section">
        <label class="ed-field"><span>Selling price ({{ currency }})</span><input v-model.number="form.price" type="number" min="0" step="0.01" inputmode="decimal" required></label>
        <label v-if="showCosts" class="ed-field"><span>Cost ({{ currency }})</span><input v-model.number="form.cost" type="number" min="0" step="0.01" inputmode="decimal" required></label>
        <label v-if="form.trackStock" class="ed-field"><span>Stock</span><input v-model.number="form.stock" type="number" min="0" step="0.001" inputmode="decimal" required></label>
      </div>
      <section v-else class="ed-editor-section">
        <div class="ed-section-head"><div><h3>Variants</h3><small>Edit each option, its price and stock directly.</small></div><button class="ed-btn" type="button" @click="addVariant">+ Add variant</button></div>
        <p v-if="!form.variants.length" class="ed-muted">Add your first option, such as Iced or Hot.</p>
        <div v-for="(v,i) in form.variants" :key="v.id" class="ed-variant-editor">
          <div class="ed-section-head"><strong>Option {{ i+1 }}</strong><button class="ed-btn danger" type="button" :aria-label="`Remove variant ${v.name||i+1}`" @click="form.variants.splice(i,1)">Remove</button></div>
          <div class="ed-form-grid ed-three-fields">
            <label class="ed-field"><span>Variant name *</span><input v-model="v.name" required maxlength="100" placeholder="e.g. Iced"></label>
            <label class="ed-field"><span>Variant SKU</span><input v-model.trim="v.sku" maxlength="64" placeholder="BEV-LATTE-ICED"></label>
            <label class="ed-field"><span>Barcode value</span><input v-model.trim="v.barcode" maxlength="64" placeholder="Optional scanner code"></label>
            <label class="ed-field"><span>Price ({{ currency }})</span><input v-model.number="v.price" required type="number" min="0" step="0.01" inputmode="decimal"></label>
            <label v-if="showCosts" class="ed-field"><span>Cost ({{ currency }})</span><input v-model.number="v.cost" required type="number" min="0" step="0.01" inputmode="decimal"></label>
            <label v-if="form.trackStock" class="ed-field"><span>Stock</span><input v-model.number="v.stock" required type="number" min="0" step="0.001" inputmode="decimal"></label>
          </div>
        </div>
      </section>
      <section class="ed-editor-section"><h3>SKU resources</h3><p class="ed-muted">Add a product photo. QR codes and barcodes are generated from your saved SKU or barcode value.</p>
        <div class="ed-form-grid">
          <label class="ed-field"><span>Product barcode value</span><input v-model.trim="form.barcode" maxlength="64" placeholder="Optional; defaults to SKU"></label>
          <label class="ed-field"><span>Upload photo (JPG, PNG, WebP · max 3 MB)</span><input type="file" accept="image/jpeg,image/png,image/webp" @change="chooseImage"></label>
          <label class="ed-field wide"><span>Or image URL (HTTPS)</span><input v-model.trim="form.imageUrl" :type="form.imageUrl?.startsWith('/api/files/')?'text':'url'" :disabled="!!imageFile" placeholder="https://…"></label>
          <div v-if="preview||form.imageUrl" class="ed-actions wide"><img :src="preview||form.imageUrl" class="ed-resource-photo" alt="Product photo preview"><button class="ed-btn danger" type="button" @click="removeImage">Remove photo</button></div>
          <p v-if="fileError" role="alert" class="ed-alert wide">{{ fileError }}</p>
          <label class="ed-field wide"><span>Description</span><textarea v-model="form.description" maxlength="2000" placeholder="Notes about this product"></textarea></label>
        </div>
      </section>
    </fieldset>
  </form>
  <template #actions><button class="ed-btn" :disabled="busy" @click="emit('close')">Cancel</button><button class="ed-btn primary" form="product-editor" type="submit" :disabled="busy">{{ busy?'Saving…':'Save product' }}</button></template>
</Modal>
</template>
