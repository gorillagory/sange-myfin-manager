<script setup>
import { ref, computed, onBeforeUnmount } from 'vue';
import Modal from '../../ui/EditionModal.vue';
import Icon from '../../ui/EditionIcon.vue';
import DocumentPreview from '../docdesign/DocumentPreview.vue';
import { Store } from '../../../store';
import { receiptMailto } from '../../../domain/receipt';
import { presentReceipt } from '../../../domain/documentPresentation';
import { downloadDocumentPdf } from '../../../services/documentPdf';
import { validEmail } from '../../../domain/inventoryCsv';
import { capabilities } from '../../../domain/permissions';
const props=defineProps({sale:Object});defineEmits(['close']);
const pending=computed(()=>props.sale.syncStatus==='pending'||Store.state.pendingSales.some(sale=>sale.id===props.sale.id));
const contact=computed(()=>Store.state.clients.find(client=>client.id===props.sale.client_id)||{});
const printable=computed(()=>({...props.sale,pending:pending.value}));
const document=computed(()=>{const view=presentReceipt(printable.value,Store.state.selectedCompany,contact.value);return {...view,settings:{...view.settings,paperWidth:paperWidth.value}};});
const paperWidth=ref(props.sale.storeSnapshot?.paperWidth||props.sale.templateSnapshot?.paperWidth||Store.state.selectedCompany?.preferences?.paperWidth||'80');
const email=ref(props.sale.customerEmail||contact.value.email||''),error=ref(''),emailOpened=ref(false),busy=ref(false);
const permission=computed(()=>capabilities(Store.state.currentUser));
const existingContact=computed(()=>Store.state.clients.find(c=>c.id===props.sale.client_id)||Store.state.clients.find(c=>c.email?.toLowerCase()===email.value.toLowerCase()&&c.type!=='Supplier'));
const contactChangeBlocked=computed(()=>!permission.value.clientsWrite&&existingContact.value&&existingContact.value.email?.toLowerCase()!==email.value.toLowerCase());
const mailLink=computed(()=>{try{return receiptMailto({...printable.value,clientSnapshot:document.value.customer},email.value)}catch{return ''}});
async function saveEmail(){
  error.value='';if(!email.value||!validEmail(email.value)){error.value='Enter a valid customer email.';return;}
  if(!Store.state.online){error.value='Connect to the internet to save this email to contacts.';return;}
  if(contactChangeBlocked.value){error.value='A manager can update saved customer details. You can still open an email draft to this address.';return;}
  if(existingContact.value?.email?.toLowerCase()===email.value.toLowerCase()){Store.notify('This email is already saved in contacts.');return;}
  busy.value=true;
  try{const existing=Store.state.clients.find(c=>c.id===props.sale.client_id)||Store.state.clients.find(c=>c.email?.toLowerCase()===email.value.toLowerCase()&&c.type!=='Supplier');await Store.addClient({...existing,id:existing?.id||`pos-${props.sale.id}`,name:existing?.name||props.sale.customerName||email.value,type:existing?.type||'Client',email:email.value});Store.notify('Customer email saved.');}
  catch(failure){error.value=failure.message;}finally{busy.value=false;}
}
async function pdf(){busy.value=true;error.value='';try{await downloadDocumentPdf(document.value,{paperWidth:paperWidth.value});}catch{error.value='The PDF could not be created. Please try again.';}finally{busy.value=false;}}
function cleanup(){window.document.body.classList.remove('ed-print-receipt');window.document.body.style.removeProperty('--receipt-width');}
function print(){window.document.body.style.setProperty('--receipt-width',paperWidth.value==='58'?'58mm':'80mm');window.document.body.classList.add('ed-print-receipt');window.addEventListener('afterprint',cleanup,{once:true});window.print();}
onBeforeUnmount(cleanup);
</script>
<template>
  <Modal title="Receipt preview" :busy="busy" @close="$emit('close')">
    <div class="ed-receipt-tools">
      <div class="ed-form-grid"><label class="ed-field"><span>Receipt paper</span><select v-model="paperWidth"><option value="80">80 mm thermal</option><option value="58">58 mm thermal</option></select></label><label class="ed-field"><span>Email receipt to</span><input v-model.trim="email" type="email" maxlength="254" autocomplete="email" placeholder="customer@example.com"></label></div>
      <div class="ed-actions" style="margin-top:12px"><a v-if="mailLink" class="ed-btn" :href="mailLink" @click="emailOpened=true">Open email draft</a><button class="ed-btn" :disabled="busy||!email||!validEmail(email)||contactChangeBlocked" @click="saveEmail">Save email to contacts</button><button class="ed-btn" :disabled="busy" @click="pdf">Download receipt PDF</button></div>
      <p v-if="contactChangeBlocked" class="ed-muted">A manager can update this saved customer’s email. You can still open an email draft to the address above.</p><p class="ed-muted">Your mail app opens with the same receipt details. Review and send it there; attach the downloaded PDF if needed.</p>
      <p v-if="emailOpened" class="ed-notice">Email draft requested. If your mail app does not open or truncates a long receipt, attach the downloaded PDF in a new email.</p><p v-if="error" class="ed-alert" role="alert">{{ error }}</p>
    </div>
    <DocumentPreview :document="document"/>
    <template #actions><button class="ed-btn" :disabled="busy" @click="$emit('close')">Close</button><button class="ed-btn primary" :disabled="busy" @click="print"><Icon name="printer"/>Print receipt</button></template>
  </Modal>
</template>
<style>
@media print{body.ed-print-receipt .mf-document--receipt{max-width:none;width:var(--receipt-width,80mm);padding:3mm;font-size:9px}body.ed-print-receipt .mf-document--receipt .mf-document-header{margin-bottom:12px;padding-bottom:12px}body.ed-print-receipt .ed-receipt-tools{display:none!important}}
</style>
