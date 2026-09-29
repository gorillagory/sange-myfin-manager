<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { Store } from '../../store';
import { api } from '../../services/api';
import { businessDate, cents, money } from '../../domain/pos';
import { reportRange } from '../../domain/financialReport';

const from = ref(businessDate(new Date(Date.now() - 29 * 86400000)));
const to = ref(businessDate());
const workspaceId = ref('');
const report = ref(null), loading = ref(false), error = ref('');
let generation = 0;
const groups = computed(() => {
  const grouped = new Map();
  for (const company of report.value?.companies || []) {
    const key = company.currency || 'RM';
    if (!grouped.has(key)) grouped.set(key, { currency: key, companies: 0, sales: 0, tax: 0, expenses: 0, cashFlow: 0 });
    const group = grouped.get(key);
    group.companies++;
    for (const field of ['sales', 'tax', 'expenses', 'cashFlow']) group[field] += cents(company[field]);
  }
  return [...grouped.values()].map(group => ({ ...group, sales: group.sales / 100, tax: group.tax / 100, expenses: group.expenses / 100, cashFlow: group.cashFlow / 100 }));
});

async function refresh() {
  const request = ++generation;
  loading.value = false;
  error.value = reportRange(from.value, to.value);
  if (error.value) return;
  report.value = null;
  if (!Store.can('financialReports') || !Store.state.online) return;
  loading.value = true;
  try {
    const query = new URLSearchParams({ from: from.value, to: to.value });
    if (workspaceId.value) query.set('workspaceId', workspaceId.value);
    const result = await api(`/reports/consolidation?${query}`);
    if (request === generation && Store.can('financialReports') && Store.state.online) { report.value = result; workspaceId.value = result.workspaceId; }
  } catch (failure) {
    if (request === generation) error.value = failure.status === 403 ? 'Consolidation requires a password session with owner or manager access to the workspace.' : 'Consolidation could not be loaded. Reconnect and retry.';
  } finally { if (request === generation) loading.value = false; }
}
watch(() => [Store.state.currentUser?.id, Store.state.selectedCompany?.id], () => { workspaceId.value = ''; refresh(); }, { immediate: true });
watch(() => [Store.state.currentUser?.role, Store.state.online], refresh);
onBeforeUnmount(() => ++generation);
</script>

<template>
  <section v-if="Store.can('financialReports') && Store.state.online" class="ed-page consolidation-page">
    <header class="ed-page-head"><div><div class="ed-eyebrow">ANALYTICS / CONSOLIDATION</div><h1>Your companies, together.</h1><p>Compare sales, tax, expenses and cash flow across the companies you manage in one workspace.</p></div><button class="ed-btn" :disabled="loading" @click="refresh">{{ loading ? 'Loading…' : 'Refresh' }}</button></header>
    <form class="ed-filters consolidation-controls" @submit.prevent="refresh"><label v-if="report?.workspaces?.length > 1" class="ed-field"><span>Workspace</span><select v-model="workspaceId" @change="refresh"><option v-for="workspace in report.workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name }}</option></select></label><label class="ed-field"><span>Date from</span><input v-model="from" type="date" required></label><label class="ed-field"><span>Date to</span><input v-model="to" type="date" required></label><button class="ed-btn primary" type="submit" :disabled="loading">Apply dates</button></form>
    <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p><p v-if="loading" class="ed-notice" role="status">Loading authorized company reports…</p>
    <template v-if="report"><p class="ed-muted">{{ report.from }} to {{ report.to }} · Kuala Lumpur dates · {{ report.companies.length }} authorized {{ report.companies.length === 1 ? 'company' : 'companies' }}</p>
      <div v-if="groups.length" class="consolidation-totals"><section v-for="group in groups" :key="group.currency"><h2>{{ group.currency }} · {{ group.companies }} {{ group.companies === 1 ? 'company' : 'companies' }}</h2><div class="ed-metrics"><div class="ed-metric"><label>Sales</label><strong>{{ money(group.sales,group.currency) }}</strong></div><div class="ed-metric"><label>Tax</label><strong>{{ money(group.tax,group.currency) }}</strong></div><div class="ed-metric"><label>Expenses</label><strong>{{ money(group.expenses,group.currency) }}</strong></div><div class="ed-metric"><label>Cash flow</label><strong>{{ money(group.cashFlow,group.currency) }}</strong></div></div></section></div>
      <div v-if="report.companies.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Company</th><th>Sales</th><th>Tax</th><th>Expenses</th><th>Cash flow</th></tr></thead><tbody><tr v-for="company in report.companies" :key="company.id"><td><strong>{{ company.name }}</strong><small class="consolidation-currency">{{ company.currency }}</small></td><td>{{ money(company.sales,company.currency) }}</td><td>{{ money(company.tax,company.currency) }}</td><td>{{ money(company.expenses,company.currency) }}</td><td>{{ money(company.cashFlow,company.currency) }}</td></tr></tbody></table></div><p v-else class="ed-notice">No active companies with financial-report access in this workspace.</p>
      <p class="ed-muted">Totals are grouped by currency; amounts from different currencies are never added together. Sales follow receipt or invoice issue dates, while cash flow follows receipts, invoice payments and expenses.</p>
    </template>
  </section><div v-else class="ed-notice">Connect with an authorized owner or manager account to view consolidation.</div>
</template>

<style scoped>
.consolidation-controls{align-items:end;gap:16px}.consolidation-controls .ed-field{min-width:180px}.consolidation-controls>.ed-btn{min-height:42px}.consolidation-totals>section{margin:26px 0}.consolidation-totals h2{font-size:18px;margin-bottom:14px}.consolidation-currency{display:block;color:var(--ed-muted);font-size:11px;margin-top:4px}@media(max-width:720px){.consolidation-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.consolidation-controls .ed-field{min-width:0}.consolidation-controls>.ed-btn{grid-column:1/-1}}
</style>
