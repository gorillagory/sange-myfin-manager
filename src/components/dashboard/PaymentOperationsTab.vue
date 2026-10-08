<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Store } from '../../store';
import { api, companyPath } from '../../services/api';
import {
  defaultPaymentOperationsRange, formatSen, paymentOperationsQuery, paymentReasonLabel, paymentStatusLabel,
} from '../../domain/paymentOperations';
import Icon from '../ui/EditionIcon.vue';

const initial = defaultPaymentOperationsRange();
const from = ref(initial.from), to = ref(initial.to), provider = ref(''), status = ref('all');
const loading = ref(false), error = ref(''), result = ref(null);
let generation = 0;
const company = computed(() => Store.state.selectedCompany || {});
const providers = computed(() => result.value?.connections || []);
const summary = computed(() => result.value?.reconciliationSummary || {});
const methods = computed(() => result.value?.paymentMethods || []);
const transactions = computed(() => result.value?.providerTransactions || []);
const reconciliations = computed(() => result.value?.reconciliations || []);
const unresolved = computed(() => Number(summary.value.pending || 0) + Number(summary.value.mismatch || 0) + Number(summary.value.unavailable || 0));
const currency = computed(() => company.value.preferences?.currency || 'MYR');

async function load() {
  const request = ++generation, companyId = company.value.id;
  if (!companyId || !Store.can('financialReports') || !Store.state.online) { result.value = null; return; }
  if (from.value > to.value) { error.value = 'Date from must be on or before date to.'; return; }
  loading.value = true; error.value = '';
  try {
    const query = paymentOperationsQuery({ from:from.value, to:to.value, provider:provider.value, status:status.value });
    const response = await api(companyPath(Store, `/payment-operations?${query}`));
    if (request === generation && company.value.id === companyId) result.value = response;
  } catch (failure) {
    if (request === generation) error.value = failure.message || 'Payment operations could not be loaded.';
  } finally { if (request === generation) loading.value = false; }
}
function showExceptions() { status.value = 'mismatch'; load(); }
watch(() => [company.value.id, Store.state.currentUser?.role, Store.state.online], load, { immediate:true });
onBeforeUnmount(() => { ++generation; });
</script>

<template>
  <section v-if="Store.can('financialReports')" class="ed-page payment-operations">
    <header class="ed-page-head"><div><div class="ed-eyebrow">FINANCE / PAYMENT OPERATIONS</div><h1>Payments, matched.</h1><p>Review collection methods, imported provider evidence and reconciliation exceptions for {{ company.name }}.</p></div><button class="ed-btn" :disabled="loading || !Store.state.online" @click="load"><Icon name="cloud"/>{{ loading?'Loading…':'Refresh' }}</button></header>
    <div v-if="!Store.state.online" class="ed-notice warning"><Icon name="cloud"/><div><strong>Reconnect to review payments.</strong>This page always reads current server evidence and is not cached on this device.</div></div>
    <form class="ed-filters payment-filters" @submit.prevent="load">
      <label class="ed-field"><span>Date from</span><input v-model="from" type="date" required></label>
      <label class="ed-field"><span>Date to</span><input v-model="to" type="date" required></label>
      <label class="ed-field"><span>Provider</span><select v-model="provider"><option value="">All providers</option><option v-for="item in providers" :key="item.providerKey" :value="item.providerKey">{{ item.displayName }}</option></select></label>
      <label class="ed-field"><span>Reconciliation</span><select v-model="status"><option value="all">All states</option><option value="pending">Pending</option><option value="matched">Matched</option><option value="mismatch">Mismatch</option><option value="unavailable">Unavailable</option></select></label>
      <button class="ed-btn primary" type="submit" :disabled="loading || !Store.state.online">Apply</button>
    </form>
    <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p><p v-else-if="loading && !result" class="ed-notice" role="status">Loading payment evidence…</p>

    <template v-if="result">
      <div class="ed-metrics payment-metrics"><div class="ed-metric"><label>Recorded collections</label><strong>{{ methods.reduce((sum,item)=>sum+item.transactionCount,0) }}</strong><small>POS and invoice receipts</small></div><div class="ed-metric"><label>Reconciliation checks</label><strong>{{ summary.total || 0 }}</strong><small>{{ summary.matched || 0 }} matched</small></div><div class="ed-metric"><label>Needs review</label><strong>{{ unresolved }}</strong><small>{{ summary.mismatch || 0 }} mismatches</small></div><div class="ed-metric"><label>Mismatch difference</label><strong>{{ formatSen(summary.mismatchDifferenceSen,currency) }}</strong><small>Net provider evidence</small></div></div>

      <section class="payment-section"><div class="ed-section-head"><div><h2>Provider connections</h2><p class="ed-muted">Connection state is visible here. Secrets remain outside MyFin and are never returned to this screen.</p></div></div><div class="connection-grid"><article v-for="item in providers" :key="item.providerKey" class="connection-card"><header><div><strong>{{ item.displayName }}</strong><small>{{ item.kind==='payment_provider'?'Payment provider':'Commerce channel' }}</small></div><span class="ed-pill" :class="{warning:item.status!=='active',ready:item.status==='active'}">{{ item.status }}</span></header><dl><div><dt>Provider identity</dt><dd>{{ item.identityStatus.replaceAll('_',' ') }}</dd></div><div><dt>External account</dt><dd>{{ item.externalAccountHint || 'Not linked' }}</dd></div><div><dt>Credentials</dt><dd>{{ item.credentialConfigured?'Configured outside MyFin':'Not configured' }}</dd></div><div><dt>Exceptions</dt><dd>{{ item.reconciliation.mismatch + item.reconciliation.unavailable + item.reconciliation.pending }}</dd></div></dl><p v-if="item.providerKey==='gokoo' && !item.activationAllowed" class="ed-notice warning"><strong>Candidate only.</strong> Gokoo stays disabled until its exact gateway identity, contract and signatures are verified.</p></article></div></section>

      <section class="payment-section"><div class="ed-section-head"><div><h2>Collection methods</h2><p class="ed-muted">Amounts are derived from saved POS sales and recorded invoice receipts in the selected Kuala Lumpur date range.</p></div></div><div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Method</th><th>Transactions</th><th>Collected</th><th>Sources</th></tr></thead><tbody><tr v-for="item in methods" :key="item.key"><td><strong>{{ item.label }}</strong></td><td>{{ item.transactionCount }}</td><td>{{ formatSen(item.amountSen,currency) }}</td><td><span v-for="source in item.sources" :key="source.label" class="source-line">{{ source.label }} · {{ source.transactionCount }} · {{ formatSen(source.amountSen,currency) }}</span></td></tr><tr v-if="!methods.length"><td colspan="4" class="ed-muted">No saved collections in this range.</td></tr></tbody></table></div></section>

      <section class="payment-section"><div class="ed-section-head"><div><h2>Imported provider transactions</h2><p class="ed-muted">Append-only normalized evidence. Imported records do not recognize cash or alter orders, stock or accounting.</p></div></div><p v-if="result.limited.providerTransactions" class="ed-notice warning">Showing the latest 200 provider transactions in this range.</p><div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Occurred</th><th>Provider / reference</th><th>Type</th><th>Method</th><th>Status</th><th>Amount</th></tr></thead><tbody><tr v-for="item in transactions" :key="item.id"><td>{{ item.occurredAt || item.importedAt }}</td><td>{{ item.providerName }}<small class="source-line">{{ item.transactionReferenceHint || 'Reference unavailable' }}<template v-if="item.orderReferenceHint"> · order {{ item.orderReferenceHint }}</template></small></td><td>{{ item.transactionType }}</td><td>{{ item.paymentMethodLabel }}<small v-if="item.providerMethodCode" class="source-line">{{ item.providerMethodCode }}</small></td><td>{{ item.providerStatus || 'Unspecified' }}</td><td>{{ formatSen(item.amountSen,item.currencyCode) }}</td></tr><tr v-if="!transactions.length"><td colspan="6" class="ed-muted">No approved provider importer has supplied payment transactions for this range.</td></tr></tbody></table></div></section>

      <section class="payment-section"><div class="ed-section-head"><div><h2>Reconciliation</h2><p class="ed-muted">Expected and observed amounts remain exact integer sen. Resolve exceptions in the source provider before introducing accounting effects.</p></div><button v-if="summary.mismatch" class="ed-btn" @click="showExceptions">Show mismatches</button></div><p v-if="result.limited.reconciliations" class="ed-notice warning">Showing the latest 200 reconciliation checks matching this filter.</p><div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Checked</th><th>Provider / reference</th><th>Status</th><th>Expected</th><th>Observed</th><th>Difference</th><th>Reason</th></tr></thead><tbody><tr v-for="item in reconciliations" :key="item.id"><td>{{ item.checkedAt }}</td><td>{{ item.providerName }}<small class="source-line">{{ item.referenceHint }}</small></td><td><span class="ed-pill" :class="{warning:item.status!=='matched',ready:item.status==='matched'}">{{ paymentStatusLabel(item.status) }}</span></td><td>{{ item.expectedAmountSen===null?'—':formatSen(item.expectedAmountSen,item.currencyCode) }}</td><td>{{ item.observedAmountSen===null?'—':formatSen(item.observedAmountSen,item.currencyCode) }}</td><td>{{ item.differenceAmountSen===null?'—':formatSen(item.differenceAmountSen,item.currencyCode) }}</td><td>{{ paymentReasonLabel(item.reasonCode) }}</td></tr><tr v-if="!reconciliations.length"><td colspan="7" class="ed-muted">No reconciliation checks match this selection.</td></tr></tbody></table></div></section>
      <div class="ed-notice"><Icon name="shield"/><div><strong>Evidence boundary</strong>This view does not capture credentials, call providers, charge customers, post cash, or alter sales. Gokoo remains a disabled commerce-channel candidate.</div></div>
    </template>
  </section>
  <div v-else class="ed-notice">Connect with an authorized workspace owner or manager account to review payment operations.</div>
</template>

<style scoped>
.payment-filters{display:flex;align-items:end;gap:14px;flex-wrap:wrap}.payment-filters .ed-field{min-width:150px}.payment-section{margin-top:32px}.payment-metrics{margin-top:22px}.connection-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.connection-card{border:1px solid var(--ed-line);background:var(--ed-paper);padding:20px}.connection-card>header{display:flex;justify-content:space-between;gap:16px}.connection-card header div{display:flex;flex-direction:column;gap:4px}.connection-card header small,.source-line{display:block;color:var(--ed-muted);font-size:10px;margin-top:4px}.connection-card dl{margin:18px 0}.connection-card dl div{display:flex;justify-content:space-between;gap:14px;padding:8px 0;border-top:1px solid var(--ed-line)}.connection-card dt{color:var(--ed-muted);font-size:11px}.connection-card dd{margin:0;text-align:right;font-size:11px;overflow-wrap:anywhere}@media(max-width:850px){.connection-grid{grid-template-columns:1fr}}@media(max-width:650px){.payment-filters{display:grid;grid-template-columns:1fr 1fr}.payment-filters .ed-field{min-width:0}.payment-filters .ed-btn{grid-column:1/-1}}
</style>
