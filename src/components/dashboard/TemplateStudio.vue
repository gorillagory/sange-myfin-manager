<script setup>
import { ref, computed, onMounted } from 'vue';
import { Store } from '../../store';
import { api, companyPath } from '../../services/api';
import { templateDefaults } from '../../domain/documents';
import { presentDocument, presentReceipt } from '../../domain/documentPresentation';
import { capabilities } from '../../domain/permissions';
import { businessDate } from '../../domain/pos';
import { downloadDocumentPdf } from '../../services/documentPdf';
import DocumentPreview from './docdesign/DocumentPreview.vue';
import Modal from '../ui/EditionModal.vue';
const templates=ref([]),kind=ref('Invoice'),selected=ref(null),name=ref(''),settings=ref(templateDefaults()),busy=ref(false),error=ref(''),notice=ref(''),confirmPublish=ref(false),baseline=ref(''),loading=ref(false);
const canEdit=computed(()=>capabilities(Store.state.currentUser).templatesWrite);
const dirty=computed(()=>JSON.stringify({name:name.value,settings:settings.value})!==baseline.value);
const matching=computed(()=>templates.value.filter(template=>template.kind===kind.value));
const company=computed(()=>Store.state.selectedCompany||{});
const sample=computed(()=>{
  const doc={type:kind.value,number:kind.value==='Receipt'?'POS-PREVIEW':'DRAFT',documentState:kind.value==='Receipt'?'issued':'draft',status:kind.value==='Receipt'?'Paid':'Draft',date:kind.value==='Receipt'?new Date().toISOString():businessDate(),dueDate:kind.value==='Invoice'?businessDate():'',validUntil:kind.value==='Quote'?businessDate():'',items:[{desc:'Professional service\nDetailed description of the work provided.',qty:2,unit:'hours',price:125},{desc:'Materials and supplies',qty:3,unit:'pcs',price:18.5}],discount:10,taxRate:company.value.preferences?.taxRate??company.value.preferences?.tax??0,customerName:'Sample customer',customerEmail:'customer@example.test',cashierName:'Sample teammate',paymentMethod:'Cash',notes:'A preview using sample document data.',templateSnapshot:settings.value,companySnapshot:{name:company.value.name,registration:company.value.registration,address:company.value.address,phone:company.value.phone,email:company.value.email,logo:company.value.logo,qrCode:company.value.qrCode||company.value.qrCodeUrl,currency:company.value.preferences?.currency||'RM'}};
  const customer={name:'Sample customer',registration:'CUSTOMER-001',address:'Customer address\nCity, postcode',email:'customer@example.test',phone:'0000000000'};
  return kind.value==='Receipt'?presentReceipt({...doc,clientSnapshot:customer,storeSnapshot:{paperWidth:settings.value.paperWidth,footer:settings.value.footer}}):presentDocument(doc,company.value,customer,{settings:settings.value});
});
async function load(){loading.value=true;try{templates.value=await api(companyPath(Store,'/templates'));}catch{error.value='Templates could not be loaded. Try again.';}finally{loading.value=false;}}
function choose(template=null){selected.value=template;name.value=template?.name||kind.value+' template';settings.value=JSON.parse(JSON.stringify(template?.settings||templateDefaults(kind.value)));baseline.value=JSON.stringify({name:name.value,settings:settings.value});error.value='';notice.value='';}
function changeKind(value){kind.value=value;choose(matching.value.find(template=>template.isDefault)||matching.value[0]||null);}
async function save(){
  if(busy.value||!canEdit.value)return;busy.value=true;error.value='';notice.value='';
  try{
    const result=await api(companyPath(Store,'/templates'+(selected.value?'/'+encodeURIComponent(selected.value.id):'')),{method:selected.value?'PUT':'POST',body:{name:name.value.trim(),settings:settings.value,...(selected.value?{version:selected.value.version}:{kind:kind.value})}});
    await load();choose(templates.value.find(template=>template.id===result.id)||result);notice.value='Draft template saved. Publish it when you are ready to use it for new documents.';
  }catch(failure){error.value=failure.status===409?'This template changed. Reload it before saving again.':'The template could not be saved. Check the fields and try again.';}finally{busy.value=false;}
}
async function publish(){
  busy.value=true;error.value='';
  try{await api(companyPath(Store,'/templates/'+encodeURIComponent(selected.value.id)+'/publish'),{method:'POST',body:{version:selected.value.version}});confirmPublish.value=false;const id=selected.value.id;await load();choose(templates.value.find(template=>template.id===id));await Store.startListeners();notice.value='Published. New documents use this version; issued documents keep their saved version.';}
  catch(failure){error.value=failure.status===409?'This template changed. Reload it and publish the latest saved version.':'Publishing could not be completed. Try again.';}finally{busy.value=false;}
}
async function pdf(){busy.value=true;error.value='';try{await downloadDocumentPdf(sample.value,{paperWidth:settings.value.paperWidth});}catch{error.value='The preview PDF could not be created.';}finally{busy.value=false;}}
onMounted(async()=>{await load();choose(matching.value.find(template=>template.isDefault)||matching.value[0]||null);});
</script>
<template>
  <section class="ed-page mf-template-studio">
    <header class="ed-page-head"><div><div class="ed-eyebrow">COMPANY / DOCUMENT TEMPLATES</div><h1>Documents that feel like your business.</h1><p>The preview and exported document use the same company details and template settings.</p></div></header>
    <div class="ed-tabs" aria-label="Document format"><button v-for="format in ['Invoice','Quote','Receipt']" :key="format" :class="{active:kind===format}" :disabled="busy" @click="changeKind(format)">{{ format }}</button></div>
    <p v-if="!Store.state.online" class="ed-notice warning">Connect to save or publish templates. Issued documents retain their saved appearance.</p>
    <p v-if="error&&!confirmPublish" class="ed-notice error" role="alert">{{ error }}</p><p v-if="notice" class="ed-notice" role="status">{{ notice }}</p>
    <div class="mf-template-layout">
      <form id="document-template-form" class="mf-template-controls" @submit.prevent="save">
        <fieldset :disabled="busy||!canEdit">
          <label class="ed-field"><span>Saved templates</span><select :value="selected?.id||''" @change="choose(templates.find(template=>template.id===$event.target.value)||null)"><option value="">New template</option><option v-for="template in matching" :key="template.id" :value="template.id">{{ template.name }}{{ template.isDefault?' · Company default':template.published?' · Published':'' }}</option></select></label>
          <div class="ed-actions" style="margin:14px 0"><button type="button" class="ed-btn small" @click="choose()">New template</button><span v-if="selected" class="ed-muted">Saved v{{ selected.version }}{{ selected.published?' · Published v'+(selected.publishedVersion||selected.version):' · Draft' }}</span></div>
          <label class="ed-field"><span>Template name *</span><input v-model="name" required maxlength="120"></label>
          <div class="ed-form-grid"><label class="ed-field"><span>Layout</span><select v-model="settings.layout"><option value="clean">Clean</option><option value="corporate">Corporate</option><option value="modern">Modern</option></select></label><label class="ed-field"><span>Font</span><select v-model="settings.fontFamily"><option value="system">Sans serif</option><option value="serif">Serif</option></select></label><label class="ed-field"><span>Brand color</span><input v-model="settings.primaryColor" type="color"></label><label class="ed-field"><span>Paper</span><select v-model="settings.paperWidth"><option v-if="kind!=='Receipt'" value="A4">A4</option><template v-else><option value="80">80 mm thermal</option><option value="58">58 mm thermal</option></template></select></label></div>
          <label class="ed-field"><span>Document title *</span><input v-model="settings.labels.title" required maxlength="120"></label><label class="ed-field"><span>Customer heading *</span><input v-model="settings.labels.billTo" required maxlength="120"></label><label class="ed-field"><span>Total label *</span><input v-model="settings.labels.total" required maxlength="120"></label>
          <label class="mf-template-check"><input v-model="settings.showLogo" type="checkbox">Show company logo</label><label class="mf-template-check"><input v-model="settings.showPaymentQr" type="checkbox">Show company payment QR</label>
          <h2>Payment details</h2><label class="ed-field"><span>Bank name</span><input v-model="settings.bankName" maxlength="120"></label><label class="ed-field"><span>Account name</span><input v-model="settings.accountName" maxlength="120"></label><label class="ed-field"><span>Account number</span><input v-model="settings.accountNumber" maxlength="120" inputmode="text"></label><label class="ed-field"><span>Payment instructions</span><textarea v-model="settings.paymentInstructions" maxlength="10000" rows="3"></textarea></label>
          <h2>Terms & finishing details</h2><label class="ed-field"><span>{{ kind==='Quote'?'Quote terms & acceptance':'Document terms' }}</span><textarea v-model="settings.terms" maxlength="10000" rows="4"></textarea></label><label class="ed-field"><span>Footer</span><textarea v-model="settings.footer" maxlength="10000" rows="3"></textarea></label><label class="mf-template-check"><input v-model="settings.showSignature" type="checkbox">Include signature line</label><label v-if="settings.showSignature" class="ed-field"><span>Signature label</span><input v-model="settings.signatureLabel" maxlength="120"></label>
        </fieldset>
        <div class="ed-actions mf-template-save"><button class="ed-btn" type="submit" :disabled="busy||!Store.state.online||!canEdit">{{ busy?'Working…':'Save draft template' }}</button><button class="ed-btn primary" type="button" :disabled="busy||dirty||!selected||!Store.state.online||!canEdit" @click="confirmPublish=true">Publish version</button></div><p v-if="dirty" class="ed-muted">Save these changes before publishing.</p>
      </form>
      <section class="mf-template-preview"><div class="ed-section-head"><div><h2>Actual document preview</h2><small class="ed-muted">Sample data · {{ kind==='Receipt'?settings.paperWidth+' mm':'A4' }}</small></div><button class="ed-btn" :disabled="busy" @click="pdf">Download preview PDF</button></div><DocumentPreview :document="sample"/></section>
    </div>
    <Modal v-if="confirmPublish" title="Publish this template version?" :busy="busy" @close="confirmPublish=false"><p><strong>{{ name }}</strong> becomes the default {{ kind.toLowerCase() }} template for new documents in this company.</p><p>Issued documents keep their saved version. Unsaved preview changes will not be published.</p><p v-if="error" class="ed-notice error" role="alert">{{ error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="confirmPublish=false">Cancel</button><button class="ed-btn primary" :disabled="busy||!Store.state.online" @click="publish">{{ busy?'Publishing…':'Publish template' }}</button></template></Modal>
  </section>
</template>
<style scoped>
.mf-template-layout{display:grid;grid-template-columns:minmax(270px,340px) minmax(0,1fr);gap:28px;margin-top:25px;align-items:start}.mf-template-controls{background:var(--ed-paper);border:1px solid var(--ed-line);padding:22px}.mf-template-controls fieldset{border:0;padding:0;margin:0;min-width:0}.mf-template-controls .ed-field{margin-bottom:17px}.mf-template-controls .ed-form-grid{gap:12px}.mf-template-controls h2{margin:25px 0 16px;border-top:1px solid var(--ed-line);padding-top:20px}.mf-template-check{display:flex;align-items:center;gap:12px;min-height:43px;font-size:12px}.mf-template-check input{width:18px;height:18px;accent-color:var(--ed-accent)}.mf-template-preview{background:#e9ede7;padding:20px;min-width:0}.mf-template-preview>.ed-section-head{flex-wrap:wrap}.mf-template-preview .ed-section-head small{display:block}.mf-template-save{margin-top:22px}.mf-template-save .ed-btn{flex:1}.mf-template-controls>p{font-size:12px}@media(max-width:1000px){.mf-template-layout{grid-template-columns:1fr}.mf-template-preview{padding:10px}}
</style>
