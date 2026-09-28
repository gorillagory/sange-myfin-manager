<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../../../store';
import { documentDefaults } from '../../../../domain/documents';
import { resolveDocumentTemplate } from '../../../../domain/documentTemplates';
import { presentDocument } from '../../../../domain/documentPresentation';
import { capabilities } from '../../../../domain/permissions';
import { businessDate, money } from '../../../../domain/pos';
import DocumentPreview from '../../docdesign/DocumentPreview.vue';
import Icon from '../../../ui/EditionIcon.vue';
const props=defineProps({document:Object,company:Object,clients:Array,products:Array,templates:Array,users:Array,busy:Boolean,error:String});
const emit=defineEmits(['save','cancel','pdf']);
const permission=computed(()=>capabilities(Store.state.currentUser));
const form=ref({...documentDefaults(props.document?.type||'Invoice'),date:businessDate(),taxRate:props.company?.preferences?.taxRate??props.company?.preferences?.tax??0,...JSON.parse(JSON.stringify(props.document||{}))});
const previewOpen=ref(false),picker=ref('');
const catalogChoices=computed(()=>(props.products||[]).flatMap(product=>(product.variants?.length?product.variants:[product]).map(variant=>({key:product.id+':'+(variant===product?'':variant.id),desc:product.name+(variant===product?'':' — '+variant.name),qty:1,unit:product.unit||'pcs',price:Number(variant.price),productId:product.id,...(variant!==product?{variantId:variant.id}:{}),sku:variant.sku||product.sku||''}))));
const available=computed(()=>(props.templates||[]).filter(template=>template.kind===form.value.type&&template.published));
const selected=computed(()=>resolveDocumentTemplate(props.templates,form.value.type,form.value.templateId));
const preview=computed(()=>{const view=presentDocument(form.value,props.company,(props.clients||[]).find(client=>client.id===form.value.client_id)||{},{settings:selected.value.settings});return selected.value.unavailable?{...view,invalid:true,previewError:'The selected template is no longer published. Choose a published template or the company default.'}:view;});
function addLine(){form.value.items.push({desc:'',qty:1,unit:'pcs',price:0});}
function addProduct(){const item=catalogChoices.value.find(item=>item.key===picker.value);if(!item)return;const {key,...line}=item;form.value.items.push(line);picker.value='';}

function save(){
  const value=form.value;
  const payload={...(value.id?{id:value.id}:{}),type:value.type,client_id:value.client_id||'',date:value.date,dueDate:value.type==='Invoice'?value.dueDate||'':'',validUntil:value.type==='Quote'?value.validUntil||'':'',items:value.items.map(item=>({desc:item.desc.trim(),qty:Number(item.qty),unit:item.unit||'pcs',price:Number(item.price),...(item.productId?{productId:item.productId}:{}),...(item.variantId?{variantId:item.variantId}:{}),...(item.sku?{sku:item.sku}:{})})),discount:Number(value.discount)||0,taxRate:Number(value.taxRate)||0,notes:value.notes||'',paymentInstructions:value.paymentInstructions||'',terms:value.terms||'',footer:value.footer||'',signatureLabel:value.signatureLabel||'',templateId:value.templateId||'',assignedTo:value.assignedTo||'',...(value.version?{version:value.version}:{})};
  emit('save',payload);
}
</script>
<template>
  <section class="ed-page mf-editor">
    <header class="ed-page-head"><div><div class="ed-eyebrow">{{ document?.id&&!document?._new?'EDIT DRAFT':'NEW DRAFT' }}</div><h1>{{ form.type }} draft.</h1><p>{{ permission.documentsIssue?'Prepare the details, then review and issue the saved draft.':'Prepare the details for a manager to review and issue.' }}</p></div><div class="ed-actions"><button class="ed-btn" :disabled="busy" @click="$emit('cancel')">Back to documents</button><button class="ed-btn" @click="previewOpen=!previewOpen">{{ previewOpen?'Show editor':'Preview document' }}</button><button v-if="!previewOpen" class="ed-btn primary" type="submit" form="document-draft-form" :disabled="busy||!Store.state.online||preview.invalid">{{ busy?'Saving…':'Save draft' }}</button></div></header>
    <p v-if="!Store.state.online" class="ed-notice warning">Document drafts require a connection. Checkout receipts already queued on this device remain safe.</p><p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
    <div v-if="previewOpen" class="mf-preview-stage"><DocumentPreview :document="preview"/><button class="ed-btn mf-preview-download" :disabled="preview.invalid" @click="$emit('pdf',preview)">Download draft PDF</button></div>
    <form v-else id="document-draft-form" @submit.prevent="save">
      <fieldset :disabled="busy" class="mf-editor-fields">
        <div class="ed-form-grid">
          <label class="ed-field"><span>Document type</span><select v-model="form.type" :disabled="!!document?.id&&!document?._new" @change="form.templateId=''"><option>Invoice</option><option>Quote</option></select></label>
          <label class="ed-field"><span>Customer *</span><select v-model="form.client_id" required><option value="" disabled>Choose a customer</option><option v-for="client in clients" :key="client.id" :value="client.id">{{ client.name }}</option></select></label>
          <label class="ed-field"><span>Issue date *</span><input v-model="form.date" type="date" required></label>
          <label v-if="form.type==='Invoice'" class="ed-field"><span>Payment due</span><input v-model="form.dueDate" type="date" :min="form.date"></label><label v-else class="ed-field"><span>Quote valid until</span><input v-model="form.validUntil" type="date" :min="form.date"></label>
          <label class="ed-field"><span>Published template</span><select v-model="form.templateId"><option value="">Company default</option><option v-for="template in available" :key="template.id" :value="template.id">{{ template.name }} · v{{ template.publishedVersion||template.version }}</option></select><small class="ed-muted">{{ selected.template?selected.template.name+' · Published v'+selected.version:'Built-in '+form.type.toLowerCase()+' template' }}. Issuing preserves this published template and the company details.</small></label>
          <label v-if="permission.documentsIssue" class="ed-field"><span>Assigned teammate</span><select v-model="form.assignedTo"><option value="">Keep with creator</option><option v-for="user in (users||[]).filter(user=>!user.disabled && user.company_id===company.id)" :key="user.id" :value="user.id">{{ user.username }}</option></select></label>
        </div>
        <section class="mf-editor-section"><div class="ed-section-head"><h2>Line items</h2><button type="button" class="ed-btn" @click="addLine"><Icon name="plus"/>Add line</button></div>
          <label class="ed-field" style="max-width:440px;margin-bottom:18px"><span>Add from catalog</span><select v-model="picker" @change="addProduct"><option value="">Select a product</option><option v-for="product in catalogChoices" :key="product.key" :value="product.key">{{ product.desc }}</option></select></label>
          <div v-for="(item,index) in form.items" :key="index" class="mf-line-editor">
            <label class="ed-field mf-line-description"><span>Line {{ index+1 }} description *</span><textarea v-model="item.desc" required maxlength="500" rows="2"></textarea></label>
            <label class="ed-field"><span>Quantity *</span><input v-model.number="item.qty" required type="number" min="0.001" max="1000000" step="0.001"></label>
            <label class="ed-field"><span>Unit</span><input v-model="item.unit" maxlength="120"></label>
            <label class="ed-field"><span>Unit price *</span><input v-model.number="item.price" required type="number" min="0" max="1000000000" step="0.01"></label>
            <button type="button" class="ed-icon-button" :disabled="form.items.length<2" :aria-label="'Remove line '+(index+1)" @click="form.items.splice(index,1)"><Icon name="close"/></button>
          </div>
          <div class="ed-form-grid mf-editor-totals"><label class="ed-field"><span>Discount (%)</span><input v-model.number="form.discount" required type="number" min="0" max="100" step="0.01"></label><label class="ed-field"><span>Tax (%)</span><input v-model.number="form.taxRate" required type="number" min="0" max="100" step="0.01"></label></div>
          <p v-if="preview.invalid" class="ed-notice warning" role="status">{{ preview.previewError }}</p><div v-else class="mf-totals"><span>Subtotal {{ money(preview.subtotal,preview.currency) }}</span><span>Discount −{{ money(preview.discountAmount,preview.currency) }}</span><span>Tax {{ money(preview.tax,preview.currency) }}</span><strong>Total {{ money(preview.total,preview.currency) }}</strong></div>
        </section>
        <section class="mf-editor-section"><h2>Notes, terms & payment</h2><p class="ed-muted">Leave overrides blank to use the published template’s defaults.</p><div class="ed-form-grid">
          <label class="ed-field wide"><span>Document notes</span><textarea v-model="form.notes" maxlength="10000" rows="3"></textarea></label><label class="ed-field wide"><span>Payment instructions override</span><textarea v-model="form.paymentInstructions" maxlength="10000" rows="3"></textarea></label><label class="ed-field wide"><span>Terms override</span><textarea v-model="form.terms" maxlength="10000" rows="3"></textarea></label><label class="ed-field"><span>Footer override</span><textarea v-model="form.footer" maxlength="10000" rows="2"></textarea></label><label class="ed-field"><span>Signature label override</span><input v-model="form.signatureLabel" maxlength="120"></label>
        </div></section>
      </fieldset>
    </form>
  </section>
</template>
<style scoped>
.mf-editor-fields{border:0;padding:0;margin:0;min-width:0}.mf-editor-section{border-top:1px solid var(--ed-line);padding-top:25px;margin-top:30px}.mf-editor-section>h2{margin-bottom:10px}.mf-line-editor{display:grid;grid-template-columns:minmax(0,3fr) minmax(70px,1fr) minmax(70px,1fr) minmax(100px,1.2fr) 32px;gap:12px;align-items:end;border-bottom:1px solid var(--ed-line);padding:18px 0}.mf-line-editor textarea{min-height:65px}.mf-editor-totals{max-width:420px;margin:25px 0 15px auto}.mf-totals{display:flex;flex-wrap:wrap;gap:20px;justify-content:flex-end;padding:15px;background:var(--ed-tint);font-size:12px}.mf-totals strong{font-size:16px}.mf-preview-stage{background:#e9ede7;padding:22px;border:1px solid var(--ed-line);overflow:auto}.mf-preview-download{margin-top:20px}
@media(max-width:720px){.mf-line-editor{grid-template-columns:1fr 1fr 1fr 32px}.mf-line-description{grid-column:1/-1}.mf-preview-stage{padding:8px}.mf-totals{justify-content:flex-start;gap:12px}.mf-editor .ed-form-grid{grid-template-columns:1fr}}
</style>
