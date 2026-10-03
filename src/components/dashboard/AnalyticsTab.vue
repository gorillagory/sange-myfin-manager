<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { Store } from '../../store';
import { api, companyPath } from '../../services/api';
import { businessDate, money } from '../../domain/pos';
import { reportBuckets, reportBucketLabel, reportRange } from '../../domain/financialReport';
import Modal from '../ui/EditionModal.vue';

const today = businessDate();
const from = ref(`${today.slice(0, 4)}-01-01`);
const to = ref(today);
const cadence = ref('day');
const report = ref(null), loading = ref(false), error = ref('');
const selected = ref(null), details = ref(null), detailLoading = ref(false), detailError = ref('');
let generation = 0, detailGeneration = 0;
const currency = computed(() => Store.state.selectedCompany?.preferences?.currency || 'RM');
const buckets = computed(() => reportBuckets(report.value?.daily || [], cadence.value));
const largest = computed(() => Math.max(1, ...buckets.value.map(row => Math.abs(row.cashFlow))));
const label = bucket => reportBucketLabel(bucket, cadence.value);
const barStyle = bucket => {
  const height = Math.max(.6, Math.abs(bucket.cashFlow) / largest.value * 47);
  return { height: `${height}%`, top: bucket.cashFlow < 0 ? '50%' : `${50 - height}%`, background: bucket.cashFlow < 0 ? '#b97459' : 'var(--ed-accent)' };
};
function applyPreset(name) {
  const end = businessDate(), year = end.slice(0, 4), month = end.slice(0, 7);
  to.value = end;
  if (name === 'week') from.value = businessDate(new Date(Date.now() - 6 * 86400000));
  if (name === 'month') from.value = `${month}-01`;
  if (name === 'year') from.value = `${year}-01-01`;
  if (name === 'twelve') from.value = businessDate(new Date(Date.now() - 365 * 86400000));
  cadence.value = name === 'week' ? 'day' : name === 'month' ? 'day' : 'month';
  refresh();
}

async function refresh() {
  const request = ++generation;
  loading.value = false;
  error.value = reportRange(from.value, to.value);
  if (error.value) return;
  report.value = null;
  closeBucket();
  if (!Store.can('financialReports') || !Store.state.online || !Store.state.selectedCompany) return;
  loading.value = true;
  const companyId = Store.state.selectedCompany.id;
  try {
    const query = new URLSearchParams({ from: from.value, to: to.value });
    const value = await api(companyPath(Store, `/reports/summary?${query}`));
    if (request === generation && Store.state.selectedCompany?.id === companyId && Store.can('financialReports') && Store.state.online) report.value = value;
  } catch {
    if (request === generation) error.value = 'The financial report could not be loaded. Reconnect and retry.';
  } finally { if (request === generation) loading.value = false; }
}

async function openBucket(bucket) {
  selected.value = bucket;
  details.value = null;
  detailError.value = '';
  detailLoading.value = true;
  const request = ++detailGeneration, companyId = Store.state.selectedCompany?.id;
  try {
    const query = new URLSearchParams({ from: bucket.from, to: bucket.to });
    const value = await api(companyPath(Store, `/reports/details?${query}`));
    if (request === detailGeneration && Store.state.selectedCompany?.id === companyId) details.value = value;
  } catch {
    if (request === detailGeneration) detailError.value = 'The underlying records could not be loaded. Close this view and try again.';
  } finally { if (request === detailGeneration) detailLoading.value = false; }
}
function closeBucket() { ++detailGeneration; selected.value = null; details.value = null; detailLoading.value = false; }
watch(() => [Store.state.selectedCompany?.id, Store.state.currentUser?.role, Store.state.online], refresh, { immediate: true });
watch(cadence, closeBucket);
onBeforeUnmount(() => { ++generation; ++detailGeneration; });
</script>

<template>
  <div v-if="Store.can('financialReports') && Store.state.online" class="ed-page report-page">
    <header class="ed-page-head"><div><div class="ed-eyebrow">ANALYTICS / FINANCIAL ANALYSIS</div><h1>Sales and cash, clearly.</h1><p>Sales, tax, expenses and cash flow for {{ Store.state.selectedCompany?.name || 'this company' }}.</p></div><button class="ed-btn" :disabled="loading" @click="refresh">{{ loading ? 'Loading…' : 'Refresh report' }}</button></header>
    <div class="report-presets ed-actions" aria-label="Report date presets"><button class="ed-btn small" type="button" @click="applyPreset('week')">Last 7 days</button><button class="ed-btn small" type="button" @click="applyPreset('month')">This month</button><button class="ed-btn small" type="button" @click="applyPreset('year')">Year to date</button><button class="ed-btn small" type="button" @click="applyPreset('twelve')">Last 12 months</button></div>
    <form class="report-controls ed-filters" @submit.prevent="refresh">
      <fieldset class="report-interval"><legend>Group by</legend><div class="ed-segmented"><button v-for="choice in [{ value: 'day', title: 'Daily' }, { value: 'week', title: 'Weekly' }, { value: 'month', title: 'Monthly' }]" :key="choice.value" type="button" :class="{ active: cadence === choice.value }" :aria-pressed="cadence === choice.value" @click="cadence = choice.value">{{ choice.title }}</button></div></fieldset>
      <label class="ed-field"><span>Date from</span><input v-model="from" type="date" required></label>
      <label class="ed-field"><span>Date to</span><input v-model="to" type="date" required></label>
      <button class="ed-btn primary" type="submit" :disabled="loading">Apply dates</button>
    </form>
    <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p><p v-if="loading" class="ed-notice" role="status">Loading the financial report…</p>
    <template v-if="report">
      <p class="ed-muted">{{ report.from }} to {{ report.to }} · Kuala Lumpur dates · {{ buckets.length }} {{ cadence === 'day' ? 'days' : cadence === 'week' ? 'weeks' : 'months' }}</p>
      <div class="ed-metrics"><div class="ed-metric"><label>Issued sales</label><strong>{{ money(report.sales, currency) }}</strong></div><div class="ed-metric"><label>Cash in</label><strong>{{ money(report.cashIn, currency) }}</strong></div><div class="ed-metric"><label>Cash out</label><strong>{{ money(report.cashOut, currency) }}</strong></div><div class="ed-metric"><label>Net cash movement</label><strong>{{ money(report.cashFlow, currency) }}</strong></div><div class="ed-metric"><label>Recognized expenses</label><strong>{{ money(report.expenses, currency) }}</strong></div><div class="ed-metric"><label>Open quote pipeline</label><strong>{{ money(report.quoted, currency) }}</strong></div><div class="ed-metric"><label>Converted quote value</label><strong>{{ money(report.convertedQuoted, currency) }}</strong></div><div class="ed-metric"><label>Tax on sales</label><strong>{{ money(report.tax, currency) }}</strong></div></div>
      <section class="report-chart-section"><div class="ed-section-head"><div><h2>{{ cadence === 'day' ? 'Daily' : cadence === 'week' ? 'Weekly' : 'Monthly' }} cash flow</h2><p class="ed-muted">Hover or focus for a breakdown. Select a bar to review the records.</p></div></div>
        <div class="report-chart-scroll"><div class="report-chart" role="group" aria-label="Cash flow by reporting interval"><button v-for="bucket in buckets" :key="bucket.key" type="button" class="report-column" :aria-label="`${label(bucket)}: sales ${money(bucket.sales,currency)}, cash in ${money(bucket.cashIn,currency)}, cash out ${money(bucket.cashOut,currency)}, cash flow ${money(bucket.cashFlow,currency)}. Open details.`" @click="openBucket(bucket)">
          <span class="report-tooltip" role="tooltip"><strong>{{ label(bucket) }}</strong><span>Sales {{ money(bucket.sales,currency) }}</span><span>Cash in {{ money(bucket.cashIn,currency) }}</span><span>Cash out {{ money(bucket.cashOut,currency) }}</span><span>Expenses {{ money(bucket.expenses,currency) }}</span><span>Cash flow {{ money(bucket.cashFlow,currency) }}</span></span>
          <span class="report-plot"><span class="report-bar" :style="barStyle(bucket)"></span></span><strong class="report-label">{{ cadence === 'month' ? label(bucket) : bucket.from.slice(5) }}</strong><small>{{ money(bucket.cashFlow,currency) }}</small>
        </button></div></div>
      </section>
      <div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Period</th><th>Sales</th><th>Cash in</th><th>Cash out</th><th>Expenses</th><th>Net cash</th><th>Details</th></tr></thead><tbody><tr v-for="bucket in buckets" :key="bucket.key"><td>{{ label(bucket) }}<small v-if="bucket.from !== bucket.to" class="report-range">{{ bucket.from }}–{{ bucket.to }}</small></td><td>{{ money(bucket.sales,currency) }}</td><td>{{ money(bucket.cashIn,currency) }}</td><td>{{ money(bucket.cashOut,currency) }}</td><td>{{ money(bucket.expenses,currency) }}</td><td>{{ money(bucket.cashFlow,currency) }}</td><td><button class="ed-btn small" @click="openBucket(bucket)">Review</button></td></tr></tbody><tfoot><tr><th>Period total</th><td>{{ money(report.sales,currency) }}</td><td>{{ money(report.cashIn,currency) }}</td><td>{{ money(report.cashOut,currency) }}</td><td>{{ money(report.expenses,currency) }}</td><td>{{ money(report.cashFlow,currency) }}</td><td></td></tr></tfoot></table></div>
      <p class="ed-muted">{{ report.basis }} Acquisition cost, margin, valuation and profit are excluded.</p>
    </template>
    <Modal v-if="selected" :title="`${label(selected)} · financial detail`" wide @close="closeBucket">
      <p class="ed-muted">{{ selected.from }} to {{ selected.to }} · Kuala Lumpur dates</p>
      <div class="report-detail-totals"><div><span>Sales</span><strong>{{ money(selected.sales,currency) }}</strong></div><div><span>Cash in</span><strong>{{ money(selected.cashIn,currency) }}</strong></div><div><span>Cash out</span><strong>{{ money(selected.cashOut,currency) }}</strong></div><div><span>Expenses</span><strong>{{ money(selected.expenses,currency) }}</strong></div><div><span>Tax</span><strong>{{ money(selected.tax,currency) }}</strong></div><div><span>Net cash</span><strong>{{ money(selected.cashFlow,currency) }}</strong></div></div>
      <p v-if="detailLoading" role="status">Loading sales, expenses and receipt details…</p><p v-if="detailError" class="ed-notice error" role="alert">{{ detailError }}</p>
      <template v-if="details"><p v-if="details.limited" class="ed-notice warning">This period has many records. The totals include all records; each list below shows the first 250.</p>
        <section class="report-detail-section"><h3>Sales · {{ details.counts.sales }}</h3><div v-if="details.sales.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date / number</th><th>Kind / customer</th><th>Sales</th><th>Tax</th></tr></thead><tbody><tr v-for="item in details.sales" :key="item.id"><td>{{ item.date }}<small class="report-range">{{ item.number || item.id }}</small></td><td>{{ item.kind }}<small v-if="item.sourceQuoteNumber" class="report-range">Source {{ item.sourceQuoteNumber }}</small><small class="report-range">{{ item.customer || 'Customer not recorded' }}</small></td><td>{{ money(item.total,currency) }}</td><td>{{ money(item.tax,currency) }}</td></tr></tbody></table></div><p v-else class="ed-muted">No sales in this period.</p></section>
        <section class="report-detail-section"><h3>Expenses and payables · {{ details.counts.expenses }}</h3><div v-if="details.expenses.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date / reference</th><th>Description / payee</th><th>Category</th><th>Cash status</th><th>Amount</th></tr></thead><tbody><tr v-for="item in details.expenses" :key="item.id"><td>{{ item.date }}<small v-if="item.number" class="report-range">{{ item.number }}</small></td><td>{{ item.description }}<small v-if="item.payee" class="report-range">{{ item.payee }}</small></td><td>{{ item.category }}</td><td>{{ item.cashImpact ? 'Cash out recorded' : 'Pending · no cash movement' }}</td><td>{{ money(item.amount,currency) }}</td></tr></tbody></table></div><p v-else class="ed-muted">No expenses in this period.</p></section>
        <section class="report-detail-section"><h3>Cash receipts · {{ details.counts.receipts }}</h3><div v-if="details.receipts.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date / number</th><th>Source</th><th>Amount received</th></tr></thead><tbody><tr v-for="item in details.receipts" :key="item.id"><td>{{ item.date }}<small class="report-range">{{ item.number || item.id }}</small></td><td>{{ item.kind }}</td><td>{{ money(item.amount,currency) }}</td></tr></tbody></table></div><p v-else class="ed-muted">No receipts in this period.</p></section>
        <section class="report-detail-section"><h3>Quotations · {{ details.counts.quotes }}</h3><p class="ed-muted">Open pipeline {{ money(details.totals.quoted,currency) }} · converted {{ money(details.totals.convertedQuoted,currency) }}</p><div v-if="details.quotes.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date / number</th><th>Customer</th><th>Status</th><th>Quoted value</th></tr></thead><tbody><tr v-for="item in details.quotes" :key="item.id"><td>{{ item.date }}<small class="report-range">{{ item.number || item.id }}</small></td><td>{{ item.customer || 'Customer not recorded' }}</td><td>{{ item.status }}</td><td>{{ money(item.total,currency) }}</td></tr></tbody></table></div><p v-else class="ed-muted">No issued quotations in this period.</p></section>
        <p class="ed-muted">{{ details.basis }}</p>
      </template>
    </Modal>
  </div>
  <div v-else class="ed-notice">Connect with an authorized owner or manager account to view reports.</div>
</template>

<style scoped>
.report-presets{margin:-8px 0 18px;flex-wrap:wrap}.report-controls{align-items:end;gap:16px}.report-controls .ed-field{min-width:160px}.report-interval{border:0;padding:0;margin:0}.report-interval legend{font-size:12px;margin-bottom:8px}.report-controls>.ed-btn{min-height:42px}.report-chart-section{margin-bottom:26px}.report-chart-scroll{overflow-x:auto;border-bottom:1px solid var(--ed-line)}.report-chart{display:flex;gap:6px;min-width:max-content;padding:100px 4px 16px}.report-column{position:relative;display:flex;flex-direction:column;align-items:center;gap:7px;min-width:74px;width:74px;padding:0 3px 4px;background:transparent;color:var(--ed-ink);border:0;cursor:pointer}.report-column:hover,.report-column:focus-visible{color:var(--ed-accent)}.report-plot{position:relative;display:block;width:100%;height:190px;background:linear-gradient(transparent calc(50% - .5px),var(--ed-line) calc(50% - .5px),var(--ed-line) calc(50% + .5px),transparent calc(50% + .5px))}.report-bar{position:absolute;left:21%;width:58%;border-radius:2px 2px 0 0}.report-label{font-size:11px;white-space:nowrap}.report-column small{font-size:10px;white-space:nowrap}.report-tooltip{display:none;position:absolute;z-index:2;bottom:calc(100% - 94px);left:50%;transform:translateX(-50%);min-width:190px;padding:11px;background:var(--ed-paper);border:1px solid var(--ed-line);box-shadow:0 8px 26px #172c2630;text-align:left;color:var(--ed-ink);font-size:11px;pointer-events:none}.report-column:first-child .report-tooltip{left:0;transform:none}.report-column:last-child .report-tooltip{left:auto;right:0;transform:none}.report-tooltip strong,.report-tooltip span{display:block;margin-bottom:4px}.report-column:hover .report-tooltip,.report-column:focus-visible .report-tooltip{display:block}.report-range{display:block;color:var(--ed-muted);margin-top:4px;white-space:normal}.report-detail-totals{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0}.report-detail-totals>div{padding:12px;border:1px solid var(--ed-line)}.report-detail-totals span,.report-detail-totals strong{display:block}.report-detail-totals span{font-size:11px;color:var(--ed-muted)}.report-detail-totals strong{margin-top:6px;font-size:15px}.report-detail-section{margin-top:26px}.report-detail-section h3{font-size:17px;font-weight:600;margin-bottom:10px}@media(max-width:720px){.report-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.report-interval{grid-column:1/-1}.report-controls .ed-field{min-width:0}.report-controls>.ed-btn{grid-column:1/-1}.report-detail-totals{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
