<script setup>
import { computed, ref, watch } from 'vue';
import { Store } from '../../store';
import { api, companyPath } from '../../services/api';
import Icon from '../ui/EditionIcon.vue';

const loading = ref(false), savingGateway = ref(false), error = ref(''), gatewayError = ref(''), result = ref(null), gateway = ref(null);
let requestVersion = 0;
const company = computed(() => Store.state.selectedCompany || {});
const provider = computed(() => result.value?.providers?.[0] || null);
const connection = computed(() => provider.value?.connection || { status:'disabled' });
const reconciliation = computed(() => provider.value?.reconciliation || {});
const gatewayReady = computed(() => gateway.value?.status === 'active' && gateway.value?.credentialAvailable);
const gatewayForm = ref({ expectedVersion:0,status:'disabled',providerEnvironment:'sandbox',accountHint:'',secretRef:'' });
const capabilityLabels = {
  merchantAuthorization:'Merchant authorization', catalog:'Catalog', availability:'Availability',
  orders:'Order import', orderLifecycle:'Order lifecycle', providerFinanceEvidence:'Finance evidence',
  paymentGateway:'Payment gateway',
};
const statusLabel = value => ({ disabled:'Disabled', pending:'Pending review', active:'Active' }[value] || 'Disabled');
const capabilityLabel = value => ({ documented:'Documented by candidate provider', not_established:'Not established' }[value] || value);
function sen(value) {
  let amount;
  try { amount = BigInt(value || 0); } catch { amount = 0n; }
  const negative = amount < 0n; if (negative) amount = -amount;
  return `${negative ? '-' : ''}RM ${(amount / 100n).toString()}.${(amount % 100n).toString().padStart(2,'0')}`;
}
async function load() {
  const current = ++requestVersion;
  if (!company.value.id) { result.value = null; return; }
  loading.value = true; error.value = '';
  try {
    const [response,payment] = await Promise.all([
      api(companyPath(Store, '/integrations')),
      api(companyPath(Store, '/payment-gateway')),
    ]);
    if (current === requestVersion) {
      result.value = response;
      gateway.value = payment.connection;
      gatewayForm.value = {
        expectedVersion:Number(payment.connection?.version||0),
        status:payment.connection?.status||'disabled',
        providerEnvironment:payment.connection?.providerEnvironment||'sandbox',
        accountHint:payment.connection?.accountHint||'',
        secretRef:payment.connection?.secretRef||'',
      };
    }
  } catch (failure) {
    if (current === requestVersion) error.value = failure.message || 'Unable to load integrations.';
  } finally { if (current === requestVersion) loading.value = false; }
}
async function saveGateway(){
  if(savingGateway.value||!company.value.id)return;
  savingGateway.value=true;gatewayError.value='';
  try{
    const response=await api(companyPath(Store,'/payment-gateway'),{method:'PUT',body:{
      expectedVersion:Number(gatewayForm.value.expectedVersion||0),status:gatewayForm.value.status,
      providerEnvironment:gatewayForm.value.providerEnvironment,accountHint:gatewayForm.value.accountHint.trim(),
      secretRef:gatewayForm.value.secretRef.trim(),
    }});
    gateway.value={...response.connection,webhookUrls:response.connection?.webhookUrls||gateway.value?.webhookUrls||[]};
    gatewayForm.value={...gatewayForm.value,expectedVersion:Number(response.connection.version||0)};
    Store.notify(response.connection.status==='active'?'HitPay online checkout is active.':'HitPay settings saved; online checkout remains disabled.');
  }catch(failure){
    gatewayError.value=({payment_gateway_secret_unavailable:'The server cannot read that credential reference. Install the HitPay key and webhook salt on the server first.',payment_gateway_secret_ref_required:'Enter the server credential reference before activation.',record_conflict:'These settings changed elsewhere. Refresh and review the latest version.'})[failure.message]||failure.message||'HitPay settings could not be saved.';
  }finally{savingGateway.value=false;}
}
watch(() => company.value.id, load, { immediate:true });
</script>

<template>
  <section class="ed-page mf-integrations">
    <header class="ed-page-head"><div><div class="ed-eyebrow">SETTINGS / INTEGRATIONS</div><h1>Integration Center.</h1><p>Review external commerce channels and payment providers for {{ company.name }}.</p></div><button class="ed-btn" :disabled="loading || !Store.state.online" @click="load"><Icon name="cloud"/>{{ loading?'Loading…':'Refresh' }}</button></header>
    <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
    <p v-else-if="loading && !provider" class="ed-notice" role="status">Loading integration metadata…</p>
    <template v-if="provider">
      <article class="mf-integration-card mf-gateway-card">
        <header><div><div class="ed-eyebrow">ONLINE CHECKOUT</div><h2>HitPay</h2><p>Hosted payment for accepted pickup and delivery orders. Card and bank details never enter MyFin.</p></div><span class="ed-pill" :class="{ready:gatewayReady,warning:!gatewayReady}">{{ gatewayReady?'Ready':'Not taking online payments' }}</span></header>
        <form class="mf-gateway-form" @submit.prevent="saveGateway">
          <div class="mf-integration-columns">
            <section><h3>Connection</h3><label class="ed-field"><span>Environment</span><select v-model="gatewayForm.providerEnvironment" :disabled="savingGateway"><option value="sandbox">Sandbox testing</option><option value="production">Production</option></select></label><label class="ed-field"><span>Merchant label</span><input v-model.trim="gatewayForm.accountHint" maxlength="80" placeholder="Example: Ba|Li Coffee"></label><label class="ed-field"><span>Server credential reference</span><input v-model.trim="gatewayForm.secretRef" maxlength="252" placeholder="secretref://hitpay/company-name" autocomplete="off"><small>This is a lookup name only. API keys and webhook salts remain in the server-mounted secret file.</small></label></section>
            <section><h3>Activation checklist</h3><ol class="mf-gateway-checks"><li :class="{done:gateway?.configured}">Connection metadata saved</li><li :class="{done:gateway?.credentialAvailable}">Server credentials verified</li><li :class="{done:gatewayReady}">Hosted checkout enabled</li></ol><div v-if="gateway?.webhookUrls?.length" class="mf-webhook"><strong>HitPay webhook URL</strong><code v-for="url in gateway.webhookUrls" :key="url">{{ url }}</code></div><p class="mf-gateway-copy">Start in Sandbox. A returned checkout page never marks an order paid; MyFin waits for HitPay’s signed completion webhook, then a manager or owner posts the confirmed payment once.</p></section>
          </div>
          <p v-if="gatewayError" class="ed-notice error" role="alert">{{ gatewayError }}</p>
          <footer class="ed-actions"><label class="mf-gateway-switch"><input v-model="gatewayForm.status" type="checkbox" true-value="active" false-value="disabled"><span>Enable customer online checkout</span></label><button class="ed-btn primary" :disabled="savingGateway||!Store.state.online">{{ savingGateway?'Saving…':'Save HitPay settings' }}</button></footer>
        </form>
      </article>
      <div class="ed-notice warning"><Icon name="alert"/><div><strong>Candidate awaiting confirmation</strong>“GoCo” has not yet been confirmed as Gokoo / 悟空海外. Provider identity, commercial access and the complete callback signature contract must be confirmed before activation.</div></div>
      <article class="mf-integration-card">
        <header><div><div class="ed-eyebrow">COMMERCE CHANNEL CANDIDATE</div><h2>{{ provider.displayName }}</h2><p>Malaysia · {{ provider.currencyCode }} · provider key {{ provider.providerKey }}</p></div><span class="ed-pill" :class="{warning:connection.status==='pending',ready:connection.status==='active'}">{{ statusLabel(connection.status) }}</span></header>
        <div class="mf-integration-columns">
          <section><h3>Connection</h3><dl class="ed-management-details"><div><dt>Identity</dt><dd>Candidate awaiting confirmation</dd></div><div><dt>External merchant</dt><dd>{{ connection.externalAccountId || 'Not linked' }}</dd></div><div><dt>Credential reference</dt><dd>{{ connection.credentialConfigured ? 'Configured outside MyFin' : 'Not configured' }}</dd></div><div><dt>Activation</dt><dd>{{ provider.activationAllowed ? 'Eligible for reviewed activation' : 'Blocked by readiness gates' }}</dd></div></dl></section>
          <section><h3>Capability evidence</h3><div v-for="(value,key) in provider.capabilities" :key="key" class="ed-row"><span><strong>{{ capabilityLabels[key] || key }}</strong><small>{{ capabilityLabel(value) }}</small></span><span class="ed-pill" :class="{warning:value==='not_established'}">{{ value==='documented'?'Candidate':'Unavailable' }}</span></div></section>
        </div>
      </article>
      <section class="mf-integration-summary"><div class="ed-eyebrow">READ-ONLY RECONCILIATION EVIDENCE</div><div class="ed-metrics"><div class="ed-metric"><label>Checks</label><strong>{{ reconciliation.total || 0 }}</strong><small>{{ reconciliation.pending || 0 }} pending</small></div><div class="ed-metric"><label>Matched</label><strong>{{ reconciliation.matched || 0 }}</strong><small>{{ reconciliation.unavailable || 0 }} unavailable</small></div><div class="ed-metric"><label>Mismatches</label><strong>{{ reconciliation.mismatch || 0 }}</strong><small>{{ sen(reconciliation.mismatchDifferenceSen) }} net difference</small></div><div class="ed-metric"><label>Evidence</label><strong>{{ (reconciliation.eventCount || 0) + (reconciliation.financialEntryCount || 0) }}</strong><small>{{ reconciliation.eventCount || 0 }} events · {{ reconciliation.financialEntryCount || 0 }} finance entries</small></div></div></section>
      <div class="ed-notice"><Icon name="shield"/><div><strong>Foundation remains non-operational</strong>No outbound provider calls, public webhook, credential capture, cash recognition, order changes or stock changes are enabled. Connection metadata uses optimistic versions and references an external secret store only.</div></div>
    </template>
  </section>
</template>

<style scoped>
.mf-integration-card{border:1px solid var(--ed-line);background:var(--ed-paper);padding:28px;margin-top:24px}.mf-integration-card>header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding-bottom:24px;border-bottom:1px solid var(--ed-line)}.mf-integration-card h2{font-family:var(--ed-font-sans);font-size:30px;font-weight:400;margin:8px 0 5px}.mf-integration-card header p{color:var(--ed-muted);font-size:12px;margin:0}.mf-integration-columns{display:grid;grid-template-columns:1fr 1fr;gap:38px;padding-top:25px}.mf-integration-columns h3{font-size:14px;margin:0 0 12px}.mf-integration-summary{margin-top:30px}.mf-integration-summary>.ed-eyebrow{margin-bottom:12px}@media(max-width:800px){.mf-integration-columns{grid-template-columns:1fr}.mf-integration-card{padding:20px}.mf-integration-card>header{flex-wrap:wrap}}
.mf-gateway-card{margin-bottom:24px}.mf-gateway-form footer{justify-content:space-between;border-top:1px solid var(--ed-line);margin-top:24px;padding-top:20px}.mf-gateway-checks{display:grid;gap:10px;margin:0;padding:0;list-style:none}.mf-gateway-checks li{display:flex;align-items:center;gap:9px;color:var(--ed-muted);font-size:12px}.mf-gateway-checks li:before{content:'\00d7';display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#f5e8e3;color:#8b3e2e;font-weight:800}.mf-gateway-checks li.done{color:var(--ed-ink)}.mf-gateway-checks li.done:before{content:'\2713';background:#e5f3e9;color:#17603b}.mf-webhook{display:grid;gap:6px;margin-top:22px}.mf-webhook strong{font-size:11px}.mf-webhook code{overflow-wrap:anywhere;border:1px solid var(--ed-line);background:var(--ed-bg);padding:9px;font-size:10px}.mf-gateway-copy{color:var(--ed-muted);font-size:11px;line-height:1.55}.mf-gateway-switch{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:700}.mf-gateway-switch input{width:18px;height:18px;accent-color:var(--ed-accent)}
</style>
