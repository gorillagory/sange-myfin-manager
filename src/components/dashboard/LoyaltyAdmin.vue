<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { Store } from '../../store';
import { api } from '../../services/api';
import Icon from '../ui/EditionIcon.vue';

const props=defineProps({company:{type:Object,required:true}});
const settings=ref({enabled:true,stampsRequired:10,rewardLabel:'Reward',minimumSpend:0,earnRule:'one_stamp_per_eligible_paid_order'});
const events=ref([]),loading=ref(false),busy=ref(false),error=ref(''),saved=ref('');
const canConfigure=computed(()=>Store.permissions().owner);
const currency=computed(()=>props.company.preferences?.currency||'RM');
const path=suffix=>`/companies/${encodeURIComponent(props.company.id)}/loyalty${suffix}`;
const stamp=value=>value?new Intl.DateTimeFormat('en-MY',{timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'—';
async function load(){loading.value=true;error.value='';try{const [config,history]=await Promise.all([api(path('')),api(path('/events?limit=50'))]);settings.value=config;events.value=history.rows||[];}catch(caught){error.value=caught.message||'Loyalty settings could not be loaded.';}finally{loading.value=false;}}
async function save(){if(!canConfigure.value||busy.value)return;busy.value=true;error.value='';saved.value='';try{settings.value=await api(path(''),{method:'PUT',body:{enabled:!!settings.value.enabled,stampsRequired:Number(settings.value.stampsRequired),rewardLabel:settings.value.rewardLabel.trim(),minimumSpend:Number(settings.value.minimumSpend)}});saved.value=settings.value.enabled?'Loyalty earning is enabled for signed-in customers.':'Loyalty earning is paused.';Store.notify(saved.value);}catch(caught){error.value=caught.message==='workspace_owner_required'?'Only a workspace owner can change the shared loyalty rule.':caught.message||'Loyalty settings could not be saved.';}finally{busy.value=false;}}
watch(()=>props.company.id,load);onMounted(load);
</script>

<template>
  <section class="ed-section mf-loyalty-admin" aria-labelledby="loyalty-title">
    <div class="ed-section-head"><div><div class="ed-eyebrow">CUSTOMER LOYALTY</div><h2 id="loyalty-title">Workspace stamp program</h2><small>One customer login works across companies; its stamp balance remains inside this workspace.</small></div><span class="ed-pill" :class="{warning:!settings.enabled}">{{ settings.enabled?'Earning enabled':'Paused' }}</span></div>
    <div v-if="loading" class="ed-notice" role="status">Loading loyalty settings…</div><p v-if="error" class="ed-notice error" role="alert">{{ error }}</p><p v-if="saved" class="ed-notice" role="status">{{ saved }}</p>
    <template v-if="!loading"><form class="mf-loyalty-config" @submit.prevent="save">
      <div class="ed-notice"><Icon name="spark"/><div><strong>One stamp per eligible paid order</strong>Unpaid, cancelled and duplicate orders earn nothing. The customer must place the order while signed in; an email-verification provider is not active yet.</div></div>
      <div class="ed-form-grid"><label class="ed-field"><span>Stamps required for a reward</span><input v-model.number="settings.stampsRequired" type="number" min="2" max="1000" step="1" :disabled="busy||!canConfigure"></label><label class="ed-field"><span>Reward name</span><input v-model="settings.rewardLabel" maxlength="120" placeholder="Free drink" :disabled="busy||!canConfigure"></label><label class="ed-field"><span>Minimum paid order ({{ currency }})</span><input v-model.number="settings.minimumSpend" type="number" min="0" max="1000000" step="0.01" :disabled="busy||!canConfigure"><small>Use 0 to make every paid order eligible.</small></label><label class="mf-switch-field"><input v-model="settings.enabled" type="checkbox" :disabled="busy||!canConfigure"><span><strong>Earn stamps on eligible payments</strong><small>Redemption is not automatic; staff can see the append-only history.</small></span></label></div>
      <div class="ed-actions ed-management-space"><button v-if="canConfigure" class="ed-btn primary" type="submit" :disabled="busy||!Store.state.online"><Icon name="check"/>{{ busy?'Saving…':'Save workspace loyalty' }}</button><p v-else class="ed-muted">Managers can review activity. A workspace owner controls the rule shared by every company.</p></div>
    </form><section class="ed-editor-section"><div class="ed-section-head"><div><h3>Recent stamp history</h3><small>{{ Store.permissions().owner?'All companies in this workspace':'This company only' }} · immutable ledger</small></div><button class="ed-btn small" :disabled="loading" @click="load"><Icon name="clock"/>Refresh</button></div>
      <div v-for="event in events" :key="event.id" class="ed-row"><span class="ed-avatar"><Icon name="spark"/></span><div style="flex:1"><strong>{{ event.customerName }}</strong><small>{{ event.customerEmail||'Signed-in customer' }} · {{ stamp(event.createdAt) }}</small><small>{{ event.reason }}<template v-if="event.saleId"> · sale {{ event.saleId }}</template></small></div><strong :class="event.stamps>0?'mf-stamps-positive':'mf-stamps-negative'">{{ event.stamps>0?'+':'' }}{{ event.stamps }} stamp{{ Math.abs(event.stamps)===1?'':'s' }}</strong><span class="ed-pill">Balance {{ event.balanceAfter }}</span></div>
      <div v-if="!events.length" class="ed-empty"><Icon name="spark"/><h3>No stamp activity yet.</h3><p>The first eligible paid order from a signed-in customer will appear here.</p></div>
    </section></template>
  </section>
</template>
