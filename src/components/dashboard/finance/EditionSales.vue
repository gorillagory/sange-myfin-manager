<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Store } from '../../../store';
import { api, companyPath } from '../../../services/api';
import { documentCollectedAmount, documentDefaults, documentOutstandingAmount } from '../../../domain/documents';
import { resolveDocumentTemplate } from '../../../domain/documentTemplates';
import { presentDocument } from '../../../domain/documentPresentation';
import { capabilities } from '../../../domain/permissions';
import { businessDate, money } from '../../../domain/pos';
import { csvCell } from '../../../domain/inventoryCsv';
import { downloadFile } from '../../../services/download';
import { downloadDocumentPdf } from '../../../services/documentPdf';
import SalesEditor from './sales-parts/SalesEditor.vue';
import DocumentPreview from '../docdesign/DocumentPreview.vue';
import Receipt from '../pos/EditionReceipt.vue';
import Modal from '../../ui/EditionModal.vue';
import Icon from '../../ui/EditionIcon.vue';
const permission=computed(()=>capabilities(Store.state.currentUser)), company=computed(()=>Store.state.selectedCompany||{});
const route=useRoute(),router=useRouter();
const documents=ref([]),templates=ref([]),loading=ref(false),busy=ref(false),error=ref(''),query=ref(''),kind=ref(''),status=ref(''),mode=ref('list'),editing=ref(null),detail=ref(null),receipt=ref(null),action=ref(null),reason=ref(''),payment=ref({}),actionError=ref(''),uncertain=ref(false);
let generation=0;
const rows=computed(()=>[...documents.value,...Store.state.transactions.filter(row=>row.source==='pos')].sort((a,b)=>String(b.date).localeCompare(String(a.date))));
const stateOf=doc=>doc.source==='pos'?'paid':doc.documentState==='draft'?'draft':['Paid','Cleared'].includes(doc.status)?'paid':['Voided','Corrected','Converted'].includes(doc.status)?doc.status.toLowerCase():doc.documentState==='issued'?'issued':'legacy';
const filtered=computed(()=>rows.value.filter(doc=>(!kind.value||(kind.value==='Receipt'?doc.source==='pos':doc.type===kind.value&&doc.source!=='pos'))&&(!status.value||stateOf(doc)===status.value)&&(!query.value||[doc.number,doc.customerName,Store.state.clients.find(client=>client.id===doc.client_id)?.name,doc.issuedSnapshot?.clientSnapshot?.name].some(value=>(value||'').toLowerCase().includes(query.value.trim().toLowerCase())))));
const summary=computed(()=>({collected:rows.value.reduce((total,doc)=>total+documentCollectedAmount(doc),0),outstanding:documents.value.filter(doc=>doc.type==='Invoice'&&['issued','legacy'].includes(doc.documentState)&&!['Voided','Corrected'].includes(doc.status)).reduce((total,doc)=>total+documentOutstandingAmount(doc),0)}));
const issueReasonRequired=computed(()=>permission.value.manager&&Number(detail.value?.discount||0)>Number(company.value.preferences?.staffDiscountLimit||0));
const currency=computed(()=>company.value.preferences?.currency||'RM');
const selectedTemplate=doc=>resolveDocumentTemplate(templates.value,doc?.type,doc?.templateId);
const presentation=doc=>{const selected=selectedTemplate(doc);const view=presentDocument(doc,company.value,Store.state.clients.find(client=>client.id===doc.client_id)||{},{settings:selected.settings});return selected.unavailable&&doc.documentState==='draft'?{...view,invalid:true,previewError:'The selected template is no longer published. Edit the draft and choose a published template or the company default.'}:view;};
const preview=computed(()=>detail.value?presentation(detail.value):null);
const canEdit=doc=>doc.documentState==='draft'&&(permission.value.documentsIssue||doc.createdBy===Store.state.currentUser?.id||doc.assignedTo===Store.state.currentUser?.id);
const canIssue=doc=>permission.value.documentsIssue&&doc.documentState==='draft'&&!selectedTemplate(doc).unavailable;
const canAct=doc=>permission.value.documentsCorrect&&doc.documentState==='issued'&&!['Voided','Corrected','Converted'].includes(doc.status);
const balance=documentOutstandingAmount;
const customer=doc=>doc.issuedSnapshot?.clientSnapshot?.name||doc.customerName||Store.state.clients.find(client=>client.id===doc.client_id)?.name||'Walk-in customer';
function explain(failure){
  return ({stale_document:'This draft changed. Reload it before saving.',document_conflict:'This document changed. Reload and review it again.',record_conflict:'This record changed. Refresh and try again.',draft_version_conflict:'This draft changed. Reload it before saving.',template_version_changed:'The published template changed. Refresh and review the document again.',template_changed:'The published template changed. Refresh and review the document again.',document_not_draft:'Issued documents cannot be edited. Use a correction draft when available.',document_not_issued:'Issue the document before this action.',receipt_review_required:'This receipt needs manager review. Its paid details remain preserved.',access_denied:'Your role does not allow this action.',invalid_input:'Check the required fields, amounts and dates.',manager_override_reason_required:'Explain why this discount exceeds the company limit before issuing.'})[failure.message]||(failure.network?'Connection interrupted. Your draft is still on this page.':failure.status===409?'The document or template changed. Reload and review the latest version.':'The request could not be completed. Check the details and try again.');
}
async function refresh(){
  const run=++generation;loading.value=true;error.value='';
  try{const [docs,styles]=await Promise.all([api(companyPath(Store,'/documents')),api(companyPath(Store,'/templates'))]);if(run!==generation)return;documents.value=docs;templates.value=styles;}
  catch(failure){if(run===generation)error.value=explain(failure);}finally{if(run===generation)loading.value=false;}
}
function newDocument(type){editing.value={...documentDefaults(type),id:crypto.randomUUID(),_new:true,date:businessDate(),taxRate:company.value.preferences?.taxRate??company.value.preferences?.tax??0};mode.value='editor';error.value='';}
function openRequestedDraft(){const requested=String(route.query.new||'').toLowerCase();if(!['quote','invoice'].includes(requested)||!Store.state.online)return;newDocument(requested==='quote'?'Quote':'Invoice');const query={...route.query};delete query.new;router.replace({path:route.path,query});}
function edit(doc){editing.value=JSON.parse(JSON.stringify(doc));detail.value=null;mode.value='editor';error.value='';}
async function save(payload){
  if(busy.value)return;busy.value=true;error.value='';
  try{const {id,...body}=payload;const creating=editing.value?._new===true;const saved=await api(companyPath(Store,'/documents'+(!creating&&id?'/'+encodeURIComponent(id):'')),{method:creating?'POST':'PUT',body:{...body,...(creating?{id}:{})}});mode.value='list';editing.value=null;await refresh();detail.value=documents.value.find(doc=>doc.id===saved.id)||saved;await Store.refreshData();Store.notify('Draft saved for review.');}
  catch(failure){error.value=explain(failure);}finally{busy.value=false;}
}
async function open(doc){if(doc.source==='pos'){receipt.value=doc;return;}detail.value=doc;}
async function pdf(doc){busy.value=true;error.value='';try{await downloadDocumentPdf(doc);}catch{error.value='The PDF could not be created. Please try again.';}finally{busy.value=false;}}
function requestAction(name){
  action.value=name;actionError.value='';reason.value='';uncertain.value=false;
  payment.value={id:crypto.randomUUID(),amount:balance(detail.value),method:'Bank transfer',reference:'',date:businessDate()};
}
async function applyAction(){
  if(busy.value||!Store.state.online)return;busy.value=true;actionError.value='';
  const doc=detail.value,operation=action.value;
  try{
    const suffix={issue:'issue',convert:'convert',payment:'payments',void:'void',correct:'corrections'}[operation];
    const template=selectedTemplate(doc);
    const body=operation==='issue'?{version:doc.version,expectedTemplateId:template.id,expectedTemplateVersion:template.version,...(issueReasonRequired.value?{reason:reason.value.trim()}:{})}:operation==='payment'?payment.value:['void','correct'].includes(operation)?{reason:reason.value}:{};
    const result=await api(companyPath(Store,'/documents/'+encodeURIComponent(doc.id)+'/'+suffix),{method:'POST',body});
    action.value=null;uncertain.value=false;await refresh();await Store.refreshData();
    if(['convert','correct'].includes(operation)){const created=documents.value.find(row=>row.id===result.id)||await api(companyPath(Store,'/documents/'+encodeURIComponent(result.id)));edit(created);}
    else detail.value=documents.value.find(row=>row.id===doc.id)||result;
    Store.notify({issue:'Document issued. Its details and template are preserved.',convert:'Invoice draft created from the quote.',payment:'Payment recorded.',void:'Document voided. Its history is retained.',correct:'Correction draft created. The original stays unchanged until replacement is issued.'}[operation]);
  }catch(failure){actionError.value=explain(failure);uncertain.value=operation==='payment'&&(failure.network||failure.status>=500);}finally{busy.value=false;}
}
function exportList(){const records=[['Number','Type','Date','Customer','Status','Total'],...filtered.value.map(doc=>[doc.number,doc.source==='pos'?'Receipt':doc.type,doc.date,customer(doc),doc.status,doc.total])];downloadFile(records.map(row=>row.map(csvCell).join(',')).join('\r\n'),'document-list.csv','text/csv;charset=utf-8');}
onMounted(async()=>{await refresh();openRequestedDraft();});watch(()=>route.query.new,openRequestedDraft);onBeforeUnmount(()=>generation++);
</script>
<template>
  <SalesEditor v-if="mode==='editor'" :document="editing" :company="company" :clients="Store.state.clients.filter(client=>client.type!=='Supplier')" :products="Store.state.products" :templates="templates" :users="Store.state.users" :busy="busy" :error="error" @cancel="mode='list';editing=null;error=''" @save="save" @pdf="pdf"/>
  <section v-else class="ed-page mf-documents">
    <header class="ed-page-head"><div><div class="ed-eyebrow">WORKSPACE / DOCUMENTS & RECEIPTS</div><h1>Every document, clearly handled.</h1><p>{{ permission.staff?'Your drafts and checkout receipts. Managers review and issue completed drafts.':'Create drafts, review and issue documents, and keep every receipt accessible.' }}</p></div><div class="ed-actions"><button v-if="permission.bulkExport" class="ed-btn" :disabled="!filtered.length" @click="exportList">Export list</button><button class="ed-btn" :disabled="!Store.state.online" @click="newDocument('Quote')">New quote</button><button class="ed-btn primary" :disabled="!Store.state.online" @click="newDocument('Invoice')"><Icon name="plus"/>New invoice</button></div></header>
    <div v-if="permission.financialReports" class="ed-metrics"><div class="ed-metric"><label>Recorded collections</label><strong>{{ money(summary.collected,currency) }}</strong></div><div class="ed-metric"><label>Invoice balance due</label><strong>{{ money(summary.outstanding,currency) }}</strong></div></div>
    <p v-if="!Store.state.online" class="ed-notice warning">Document changes need a connection. Your cached checkout receipts remain available.</p><p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
    <div class="ed-filters mf-document-filters"><label class="ed-field mf-document-search"><span>Search documents</span><input v-model="query" type="search" placeholder="Number or customer"></label><label class="ed-field"><span>Document type</span><select v-model="kind"><option value="">All types</option><option>Invoice</option><option>Quote</option><option>Receipt</option></select></label><label class="ed-field"><span>Status</span><select v-model="status"><option value="">All statuses</option><option value="draft">Draft</option><option value="issued">Issued</option><option value="paid">Paid</option><option value="converted">Converted</option><option value="corrected">Corrected</option><option value="voided">Voided</option><option v-if="permission.owner" value="legacy">Historical</option></select></label><button class="ed-btn" :disabled="loading||!Store.state.online" @click="refresh">Refresh</button></div>
    <p class="ed-muted" role="status">{{ loading?'Loading documents…':filtered.length+' documents shown' }}</p>
    <div v-if="filtered.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Document</th><th>Customer</th><th>Date</th><th>Status</th><th class="num">Amount</th><th>Actions</th></tr></thead><tbody><tr v-for="doc in filtered" :key="doc.id" :data-document-id="doc.id"><td><strong>{{ doc.number||'Unnumbered draft' }}</strong><small>{{ doc.source==='pos'?'Receipt':doc.type }}{{ doc.correctionOf?' · Correction':'' }}</small></td><td>{{ customer(doc) }}</td><td>{{ doc.businessDate||String(doc.date).slice(0,10) }}</td><td><span class="ed-pill" :class="{warning:stateOf(doc)==='draft'}">{{ stateOf(doc)==='legacy'?'Historical · read only':doc.status||'Draft' }}</span></td><td class="num">{{ money(doc.total,currency) }}</td><td><div class="ed-actions"><button class="ed-btn small" @click="open(doc)">{{ doc.source==='pos'?'Receipt / PDF':'Review' }}</button><button v-if="canEdit(doc)" class="ed-btn small" :disabled="!Store.state.online" @click="edit(doc)">Edit draft</button></div></td></tr></tbody></table></div>
    <div v-else-if="!loading" class="ed-empty"><Icon name="receipt"/><h3>No documents match this view.</h3><p>Create a draft or change the filters to find a document.</p></div>
    <Modal v-if="detail" title="Document review" wide :busy="busy||!!action" @close="detail=null">
      <p v-if="detail.documentState==='draft'" class="ed-notice">Draft only. Review the customer, lines, dates and payment details before issuing.</p><p v-else-if="!detail.issuedSnapshot" class="ed-notice warning">Historical document · Retained for owner review. It has no issued snapshot and cannot be edited or reissued here.</p><p v-else class="ed-notice">Issued details and template are preserved. Status and recorded payments reflect the latest history.</p>
      <DocumentPreview :document="preview"/>
      <template #actions><button class="ed-btn" :disabled="busy||preview.invalid" @click="pdf(preview)">Download {{ preview.isDraft?'draft ':'' }}PDF</button><button v-if="canEdit(detail)" class="ed-btn" :disabled="busy||!Store.state.online" @click="edit(detail)">Edit draft</button><button v-if="canIssue(detail)" class="ed-btn primary" :disabled="busy||!Store.state.online" @click="requestAction('issue')">Issue {{ detail.type.toLowerCase() }}</button><template v-if="canAct(detail)"><button v-if="detail.type==='Quote'&&!detail.convertedTo" class="ed-btn primary" :disabled="busy||!Store.state.online" @click="requestAction('convert')">Convert to invoice</button><button v-if="detail.type==='Invoice'&&balance(detail)>0" class="ed-btn primary" :disabled="busy||!Store.state.online" @click="requestAction('payment')">Record payment</button><button v-if="!Number(detail.paidAmount)" class="ed-btn" :disabled="busy||!Store.state.online" @click="requestAction('correct')">Create correction</button><button v-if="!Number(detail.paidAmount)" class="ed-btn danger" :disabled="busy||!Store.state.online" @click="requestAction('void')">Void document</button></template></template>
    </Modal>
    <Modal v-if="action" :title="{issue:'Issue this document?',convert:'Convert quote to invoice?',payment:'Record a payment',void:'Void this document?',correct:'Create a correction draft?'}[action]" :busy="busy||uncertain" @close="action=null">
      <form id="document-action-form" @submit.prevent="applyAction">
        <p v-if="action==='issue'">Issuing assigns the document number and preserves its company, customer, line items, dates, terms and published template. Review the preview first. Inventory quantities are handled through Checkout.</p><p v-else-if="action==='convert'">Create an invoice draft from this issued quote. A manager will review and issue the invoice separately.</p>
        <template v-else-if="action==='payment'"><p>Record a payment already confirmed by your bank, terminal or cash collection. This does not charge the customer. Inventory quantities are handled through Checkout.</p><div class="ed-form-grid"><label class="ed-field"><span>Payment amount *</span><input v-model.number="payment.amount" type="number" required min="0.01" :max="balance(detail)" step="0.01" :disabled="busy||uncertain"></label><label class="ed-field"><span>Payment method *</span><select v-model="payment.method" :disabled="busy||uncertain"><option>Bank transfer</option><option>Cash</option><option>QR Pay</option><option>Card</option><option>Other</option></select></label><label class="ed-field"><span>Payment date</span><input v-model="payment.date" type="date" :disabled="busy||uncertain"></label><label class="ed-field"><span>Reference</span><input v-model="payment.reference" maxlength="500" :disabled="busy||uncertain"></label></div></template>
        <template v-else><p>{{ action==='void'?'Void this unpaid document while retaining its original details and history.':'Create a linked draft for corrected details. The original remains issued until the replacement is issued.' }}</p><label class="ed-field"><span>Reason *</span><textarea v-model="reason" required minlength="3" maxlength="1000" rows="3"></textarea></label></template>
        <label v-if="action==='issue'&&issueReasonRequired" class="ed-field"><span>Discount approval reason *</span><textarea v-model="reason" required minlength="3" maxlength="1000" rows="3"></textarea><small class="ed-muted">This draft proposes {{ detail.discount }}% discount, above the company limit of {{ company.preferences?.staffDiscountLimit||0 }}%. Your reason is saved with the issuance history.</small></label>
        <p v-if="actionError" class="ed-notice error" role="alert">{{ actionError }}</p><p v-if="uncertain" class="ed-notice warning">The response was interrupted. Retry this exact payment to confirm its result without recording it twice. Closing is paused until the result is confirmed.</p>
      </form>
      <template #actions><button class="ed-btn" :disabled="busy||uncertain" @click="action=null">Cancel</button><button type="submit" form="document-action-form" class="ed-btn" :class="action==='void'?'danger':'primary'" :disabled="busy||!Store.state.online">{{ busy?'Saving…':uncertain?'Retry payment':{issue:'Confirm issue',convert:'Create invoice draft',payment:'Save payment',void:'Void document',correct:'Create correction draft'}[action] }}</button></template>
    </Modal>
    <Receipt v-if="receipt" :sale="receipt" @close="receipt=null"/>
  </section>
</template>
<style scoped>
.mf-document-filters{align-items:end}.mf-document-search{flex:1;min-width:200px}.mf-document-filters>.ed-field:not(.mf-document-search){min-width:150px}.mf-documents>.ed-muted{font-size:12px;margin-bottom:16px}.mf-documents .ed-table td{vertical-align:top}.mf-documents .ed-table td:first-child{min-width:150px}.mf-documents .ed-table td:nth-child(2){white-space:normal;min-width:120px;overflow-wrap:anywhere}@media(max-width:600px){.mf-document-filters{display:grid;grid-template-columns:1fr 1fr}.mf-document-search{grid-column:1/-1}.mf-document-filters>.ed-field:not(.mf-document-search){min-width:0}}
</style>
