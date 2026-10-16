<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Store } from '../../../store';
import { api, companyPath } from '../../../services/api';
import { validEmail } from '../../../domain/inventoryCsv';
import { capabilities } from '../../../domain/permissions';
import { clearReceiptEmailIntent, loadOrCreateReceiptEmailIntent, loadReceiptEmailIntent, receiptEmailRecipient } from '../../../services/receiptEmailIntent';

const props=defineProps({sale:{type:Object,required:true},email:{type:String,default:''},blocked:{type:Boolean,default:false}});
const enabled=ref(false),loading=ref(false),busy=ref(false),rows=ref([]),error=ref(''),sendIntent=ref(null);
let timer=0,disposed=false;
const permission=computed(()=>capabilities(Store.state.currentUser));
const ready=computed(()=>enabled.value&&Store.state.online&&!props.blocked&&validEmail(props.email));
const matching=computed(()=>rows.value.find(row=>receiptEmailRecipient(row.recipient)===receiptEmailRecipient(props.email))||null);
const latest=computed(()=>matching.value||rows.value[0]||null);
const ordinaryBlocked=computed(()=>matching.value&&['queued','running','retry_wait','sent','failed','delivery_unknown'].includes(matching.value.state));
const active=computed(()=>rows.value.some(row=>['queued','running','retry_wait'].includes(row.state)));
const labels={queued:'Queued',running:'Sending',retry_wait:'Retry scheduled',sent:'Sent',failed:'Not sent',delivery_unknown:'Delivery needs review'};
const errorLabels={smtp_connect_unavailable:'Mail server unavailable',smtp_temporary_rejection:'Mail server asked MyFin to retry',smtp_authentication_failed:'Mail service credentials need attention',recipient_rejected:'Recipient address was rejected',message_rejected:'Message was rejected',retry_budget_exhausted:'Retry limit reached',delivery_outcome_unknown:'The mail server may have accepted this receipt'};
const stamp=value=>value?new Date(value).toLocaleString('en-MY',{timeZone:'Asia/Kuala_Lumpur'}):'';
function path(suffix=''){return companyPath(Store,`/transactions/${encodeURIComponent(props.sale.id)}/receipt-emails${suffix}`);}
function schedule(){clearTimeout(timer);if(!disposed&&active.value)timer=setTimeout(load,5000);}
async function load(){
  if(props.blocked||!Store.state.online)return;
  loading.value=true;
  try{const result=await api(path());enabled.value=result.enabled===true;rows.value=result.rows||[];error.value='';
    const companyId=Store.state.selectedCompany.id;
    sendIntent.value=await loadReceiptEmailIntent(companyId,props.sale.id,props.email);
    if(sendIntent.value&&rows.value.some(row=>row.idempotencyKey===sendIntent.value.id)){
      clearReceiptEmailIntent(companyId,props.sale.id,sendIntent.value);sendIntent.value=null;
    }
  }
  catch(failure){error.value=failure.network?'Connect to check receipt email status.':'Receipt email status is temporarily unavailable.';}
  finally{loading.value=false;schedule();}
}
async function send(sendAgain=false){
  error.value='';if(!validEmail(props.email)){error.value='Enter a valid customer email.';return;}
  if(!ready.value){error.value=props.blocked?'Sync and approve this receipt before emailing it.':!Store.state.online?'Connect to send this receipt.':'Receipt delivery is not connected. Use the email draft or PDF fallback.';return;}
  if(!sendAgain&&ordinaryBlocked.value){error.value=matching.value.state==='sent'?'This receipt was already sent to this address. A manager can explicitly send another copy.':matching.value.state==='delivery_unknown'?'Delivery may already have succeeded. A manager must review it before sending again.':'A delivery to this address is already in progress.';return;}
  const recipient=receiptEmailRecipient(props.email),companyId=Store.state.selectedCompany.id;
  if(sendIntent.value?.recipient!==recipient)sendIntent.value=await loadOrCreateReceiptEmailIntent(companyId,props.sale.id,recipient);
  busy.value=true;
  try{const delivery=await api(path(),{method:'POST',body:{recipient,idempotencyKey:sendIntent.value.id,sendAgain}});rows.value=[delivery,...rows.value.filter(row=>row.id!==delivery.id)];clearReceiptEmailIntent(companyId,props.sale.id,sendIntent.value);sendIntent.value=null;Store.notify('Receipt email queued.');schedule();}
  catch(failure){
    if(['receipt_email_already_requested','receipt_email_resend_not_allowed'].includes(failure.message)){error.value='A delivery already exists for this address. Refresh its status before sending another copy.';await load();}
    else error.value=failure.message==='receipt_email_unavailable'?'Receipt delivery is not connected. Use the email draft or PDF fallback.':failure.message==='receipt_email_payload_changed'?'This send request changed. Try once more.':failure.message==='receipt_email_limit_reached'?'This receipt reached its delivery limit. Use the email draft or PDF fallback.':failure.network?'Connection interrupted. Retry uses the same safe request; it will not queue twice.':'The receipt could not be queued. Try again.';
  }
  finally{busy.value=false;}
}
async function retry(row){
  error.value='';busy.value=true;
  try{const delivery=await api(companyPath(Store,`/receipt-emails/${encodeURIComponent(row.id)}/retry`),{method:'POST',body:{idempotencyKey:crypto.randomUUID()}});rows.value=[delivery,...rows.value];Store.notify('Receipt email queued again.');schedule();}
  catch(failure){error.value=['receipt_email_retry_not_required','receipt_email_resend_not_allowed'].includes(failure.message)?'This delivery is already active or sent.':failure.message==='receipt_email_unavailable'?'Receipt delivery is not connected.':'The retry could not be queued.';}
  finally{busy.value=false;}
}
onMounted(load);onBeforeUnmount(()=>{disposed=true;clearTimeout(timer);});
</script>
<template>
  <section class="receipt-email-panel" aria-label="Receipt email delivery">
    <div class="ed-actions">
      <button class="ed-btn primary" :disabled="busy||loading||!ready||ordinaryBlocked" @click="send(false)">{{ busy?'Queuing…':'Send receipt email' }}</button>
      <button v-if="permission.receiptEmailsRetry&&matching?.state==='sent'" class="ed-btn" :disabled="busy||loading||!ready" @click="send(true)">Send another copy</button>
      <button v-if="Store.state.online&&!blocked" class="ed-btn small" :disabled="busy||loading" @click="load">Refresh status</button>
    </div>
    <p v-if="blocked" class="ed-muted">Sync and approve this paid receipt before sending it from MyFin.</p>
    <p v-else-if="!enabled&&!loading" class="ed-muted">Direct receipt delivery is not connected. The email draft and PDF options remain available.</p>
    <div v-if="latest" class="receipt-email-status" role="status" aria-live="polite">
      <span class="ed-pill" :class="{ready:latest.state==='sent',warning:['queued','running','retry_wait','delivery_unknown'].includes(latest.state)}">{{ labels[latest.state]||latest.state }}</span>
      <span><strong>{{ latest.recipient }}</strong><small>{{ latest.state==='sent'?stamp(latest.acceptedAt):stamp(latest.updatedAt||latest.createdAt) }}<template v-if="latest.errorCode"> · {{ errorLabels[latest.errorCode]||'Delivery needs attention' }}</template></small></span>
      <button v-if="permission.receiptEmailsRetry&&['failed','delivery_unknown'].includes(latest.state)" class="ed-btn small" :disabled="busy||!enabled||!Store.state.online" @click="retry(latest)">Send again</button>
    </div>
    <p class="ed-muted">Receipt delivery is transactional only and does not add the customer to marketing.</p>
    <p v-if="error" class="ed-alert" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.receipt-email-panel{margin-top:14px;padding-top:14px;border-top:1px solid var(--ed-line)}.receipt-email-status{display:flex;align-items:center;gap:10px;margin-top:10px;padding:10px 12px;border:1px solid var(--ed-line);border-radius:10px}.receipt-email-status>span:nth-child(2){display:flex;min-width:0;flex:1;flex-direction:column;gap:2px;overflow-wrap:anywhere}.receipt-email-status small{color:var(--ed-muted)}
</style>
