<script setup>
import { ref } from 'vue';
import { eligibilityActions, eligibilityStatusLabel, studentReviewPayload } from '../../../domain/studentPrograms.js';
import Icon from '../../ui/EditionIcon.vue';
import Modal from '../../ui/EditionModal.vue';

const props=defineProps({rows:{type:Array,default:()=>[]},canReview:Boolean,busy:Boolean,error:{type:String,default:''}});
const emit=defineEmits(['save']);
const review=ref(null),localError=ref('');
const id=row=>row.customerId||row.customer_id||row.id;
const status=row=>row.status||row.eligibility?.status||'';
const version=row=>Number(row.version||row.eligibility?.version||0);
const name=row=>row.displayName||row.customerName||row.customer?.displayName||row.email||'Registered customer';
const email=row=>row.email||row.customerEmail||row.customer?.email||'No email shown';
const institution=row=>row.institutionName||row.institution_name||row.eligibility?.institutionName||'';
const hint=row=>row.referenceHint||row.reference_hint||row.eligibility?.referenceHint||'';
const expiry=row=>row.validUntil||row.valid_until||row.eligibility?.validUntil||null;
const date=value=>value?new Intl.DateTimeFormat('en-MY',{dateStyle:'medium',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(value)):'—';
const localTime=value=>{if(!value)return'';const parsed=new Date(value);const offset=parsed.getTimezoneOffset()*60000;return new Date(parsed-offset).toISOString().slice(0,16);};
function open(row,decision){review.value={row,status:decision,expectedVersion:version(row),institutionName:institution(row),referenceHint:hint(row),validUntil:decision==='verified'?localTime(expiry(row)||Date.now()+365*86400000):'',reason:''};localError.value='';}
function save(){try{const payload=studentReviewPayload(review.value);emit('save',{customerId:id(review.value.row),payload,done:()=>review.value=null});}catch(error){localError.value=error.message;}}
</script>

<template>
  <section class="mf-eligibility-panel">
    <div class="ed-section-head"><div><div class="ed-eyebrow">ELIGIBILITY</div><h2>Customer eligibility</h2><small>Eligibility is one audience signal. It is not the marketing platform itself.</small></div><span class="ed-pill">{{ rows.length }} customer{{ rows.length===1?'':'s' }}</span></div>
    <div class="ed-notice"><Icon name="shield"/><div><strong>Minimal verification only</strong>Review evidence outside MyFin. Store the institution, decision, expiry and an optional masked hint. Never enter or upload identity documents or full student numbers.</div></div>
    <div v-if="!canReview" class="ed-notice"><Icon name="shield"/><div><strong>Read-only for managers</strong>A workspace owner or SuperAdmin controls eligibility decisions.</div></div>
    <div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Customer</th><th>Status</th><th>Institution</th><th>Reference / expiry</th><th>Review</th></tr></thead><tbody><tr v-for="row in rows" :key="id(row)"><td><strong>{{ name(row) }}</strong><small>{{ email(row) }}</small></td><td><span class="ed-pill" :class="{ready:status(row)==='verified',warning:status(row)==='pending'}">{{ eligibilityStatusLabel(status(row)) }}</span><small v-if="version(row)">Version {{ version(row) }}</small></td><td>{{ institution(row)||'Not supplied' }}</td><td><strong>{{ hint(row)||'No hint saved' }}</strong><small>{{ expiry(row)?`Expires ${date(expiry(row))}`:'No active expiry' }}</small></td><td><div v-if="canReview" class="ed-actions"><button v-for="action in eligibilityActions({status:status(row)})" :key="action" class="ed-btn small" @click="open(row,action)">{{ action==='pending'?'Start review':action==='verified'?(status(row)==='verified'?'Renew':'Verify'):action==='rejected'?'Reject':'Revoke' }}</button></div><span v-else class="ed-muted">Read only</span></td></tr><tr v-if="!rows.length"><td colspan="5" class="ed-empty">No registered customer is available for eligibility review.</td></tr></tbody></table></div>
    <Modal v-if="review&&canReview" :title="`${eligibilityStatusLabel(review.status)} · ${name(review.row)}`" :busy="busy" @close="review=null"><form id="eligibility-review-form" class="ed-form-grid" @submit.prevent="save"><label class="ed-field wide"><span>Institution name</span><input v-model="review.institutionName" minlength="2" maxlength="160" required></label><template v-if="review.status==='verified'"><label class="ed-field"><span>Masked reference hint · optional</span><input v-model="review.referenceHint" maxlength="11" pattern="\*{3}[A-Za-z0-9._-]{1,8}" placeholder="***1234"></label><label class="ed-field"><span>Valid until</span><input v-model="review.validUntil" type="datetime-local" required></label></template><label v-if="['rejected','revoked'].includes(review.status)" class="ed-field wide"><span>Reason</span><textarea v-model="review.reason" minlength="3" maxlength="500" rows="3" required></textarea></label></form><p v-if="localError||error" class="ed-notice error">{{ localError||error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="review=null">Cancel</button><button class="ed-btn primary" type="submit" form="eligibility-review-form" :disabled="busy">{{ busy?'Saving…':'Save review event' }}</button></template></Modal>
  </section>
</template>

<style scoped>
.mf-eligibility-panel{display:grid;gap:18px}.ed-table small{display:block;margin-top:5px}
</style>
