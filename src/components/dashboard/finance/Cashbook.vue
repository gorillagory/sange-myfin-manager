<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Store } from '../../../store';
import { api, companyPath } from '../../../services/api';
import { businessDate, money } from '../../../domain/pos';
import { reportRange } from '../../../domain/financialReport';
import Icon from '../../ui/EditionIcon.vue';

const today = businessDate();
const from = ref(`${today.slice(0, 4)}-01-01`), to = ref(today), report = ref(null), loading = ref(false), error = ref(''), query = ref(''), direction = ref('');
let generation = 0;
const currency = computed(() => Store.state.selectedCompany?.preferences?.currency || 'RM');
const entries = computed(() => {
  const receipts = (report.value?.receipts || []).map(row => ({ ...row, direction: 'in', label: row.kind, description: row.number || row.id, cashImpact: true }));
  const expenses = (report.value?.expenses || []).map(row => ({ ...row, direction: row.cashImpact ? 'out' : 'pending', label: row.kind, description: row.description || row.number || row.id }));
  return [...receipts, ...expenses].sort((a, b) => b.date.localeCompare(a.date) || String(a.id).localeCompare(String(b.id)));
});
const shown = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return entries.value.filter(row => (!direction.value || row.direction === direction.value) && (!needle || [row.label, row.description, row.number, row.payee, row.category, row.status].some(value => String(value || '').toLocaleLowerCase().includes(needle))));
});

async function refresh() {
  const request = ++generation;
  error.value = reportRange(from.value, to.value);
  report.value = null;
  if (error.value || !Store.can('financialReports') || !Store.state.online || !Store.state.selectedCompany) return;
  loading.value = true;
  try {
    const params = new URLSearchParams({ from: from.value, to: to.value });
    const result = await api(companyPath(Store, `/reports/details?${params}`));
    if (request === generation) report.value = result;
  } catch { if (request === generation) error.value = 'The cash book could not be loaded. Reconnect and retry.'; }
  finally { if (request === generation) loading.value = false; }
}
function preset(name) {
  const end = businessDate(); to.value = end;
  from.value = name === 'month' ? `${end.slice(0, 7)}-01` : name === 'week' ? businessDate(new Date(Date.now() - 6 * 86400000)) : name === 'twelve' ? businessDate(new Date(Date.now() - 365 * 86400000)) : `${end.slice(0, 4)}-01-01`;
  refresh();
}
watch(() => [Store.state.selectedCompany?.id, Store.state.currentUser?.role, Store.state.online], refresh, { immediate: true });
onBeforeUnmount(() => ++generation);
</script>

<template>
  <section v-if="Store.can('financialReports') && Store.state.online" class="ed-page mf-cashbook">
    <header class="ed-page-head"><div><div class="ed-eyebrow">FINANCE / CASH BOOK</div><h1>Money in and money out.</h1><p>Follow actual collections and payments separately from issued sales, quotations and pending commitments.</p></div><div class="ed-actions"><router-link :to="{path:'/documents',query:{new:'invoice'}}" class="ed-btn">New invoice</router-link><router-link to="/expenses" class="ed-btn primary"><Icon name="plus"/>Record expense</router-link></div></header>
    <div class="ed-actions cashbook-presets"><button class="ed-btn small" @click="preset('week')">Last 7 days</button><button class="ed-btn small" @click="preset('month')">This month</button><button class="ed-btn small" @click="preset('year')">Year to date</button><button class="ed-btn small" @click="preset('twelve')">Last 12 months</button></div>
    <form class="ed-filters cashbook-filters" @submit.prevent="refresh"><label class="ed-field"><span>Date from</span><input v-model="from" type="date" required></label><label class="ed-field"><span>Date to</span><input v-model="to" type="date" required></label><button class="ed-btn primary" :disabled="loading">Apply dates</button></form>
    <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p><p v-if="loading" class="ed-notice" role="status">Loading cash movements…</p>
    <template v-if="report">
      <div class="ed-metrics"><div class="ed-metric"><label>Cash in</label><strong>{{ money(report.totals.cashIn,currency) }}</strong></div><div class="ed-metric"><label>Cash out</label><strong>{{ money(report.totals.cashOut,currency) }}</strong></div><div class="ed-metric"><label>Net cash movement</label><strong>{{ money(report.totals.cashFlow,currency) }}</strong></div><div class="ed-metric"><label>Issued sales</label><strong>{{ money(report.totals.sales,currency) }}</strong></div></div>
      <div class="ed-filters"><div class="ed-search"><Icon name="search"/><input v-model="query" class="ed-input" type="search" aria-label="Search cash book" placeholder="Search source, reference or payee"></div><label class="ed-field"><span>Movement</span><select v-model="direction"><option value="">All entries</option><option value="in">Money in</option><option value="out">Money out</option><option value="pending">Pending out</option></select></label></div>
      <p v-if="report.limited" class="ed-notice warning">Totals include the full period. The entry list shows the first 250 records per source.</p>
      <p class="ed-muted">{{ shown.length }} {{ shown.length === 1 ? 'entry' : 'entries' }} shown · {{ from }} to {{ to }}</p>
      <div v-if="shown.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date</th><th>Movement</th><th>Source</th><th>Reference / description</th><th>Status</th><th class="num">Money in</th><th class="num">Money out</th></tr></thead><tbody><tr v-for="row in shown" :key="`${row.direction}-${row.id}`"><td>{{ row.date }}</td><td><span class="ed-pill" :class="{warning:row.direction==='pending'}">{{ row.direction === 'in' ? 'In' : row.direction === 'out' ? 'Out' : 'Pending out' }}</span></td><td>{{ row.label }}</td><td>{{ row.description }}<small v-if="row.payee" class="cashbook-secondary">{{ row.payee }}</small></td><td>{{ row.status || (row.direction === 'pending' ? 'Pending' : 'Recorded') }}</td><td class="num">{{ row.direction === 'in' ? money(row.amount,currency) : '—' }}</td><td class="num">{{ row.direction === 'out' ? money(row.amount,currency) : row.direction === 'pending' ? 'Not paid' : '—' }}</td></tr></tbody></table></div>
      <div v-else class="ed-empty"><Icon name="wallet"/><h3>No matching movements.</h3><p>Record an invoice payment or expense, or change the date and movement filters.</p></div>
      <div class="ed-row"><div><strong>Quotation to cash</strong><small>Create and issue a quote, convert it to an invoice, then record payment. The invoice becomes sales when issued and cash in when payment is recorded.</small></div><router-link class="ed-link" to="/documents">Open quotes and invoices<Icon name="arrow"/></router-link></div>
    </template>
  </section>
  <div v-else class="ed-notice">Connect with an authorized owner or manager account to view the cash book.</div>
</template>

<style scoped>
.cashbook-presets{margin:-8px 0 18px;flex-wrap:wrap}.cashbook-filters{align-items:end}.cashbook-filters .ed-field{min-width:170px}.cashbook-secondary{display:block;margin-top:4px;color:var(--ed-muted)}.mf-cashbook>.ed-muted{font-size:12px;margin:14px 0}@media(max-width:650px){.cashbook-filters{display:grid;grid-template-columns:1fr 1fr}.cashbook-filters>.ed-btn{grid-column:1/-1}.cashbook-filters .ed-field{min-width:0}}
</style>
