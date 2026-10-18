<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { Store } from '../../store';
import { api, companyPath } from '../../services/api';
import { businessDate, money } from '../../domain/pos';
import { reportBuckets, reportBucketLabel, reportRange } from '../../domain/financialReport';
import { analyticsFilterLabels, analyticsReportQuery, analyticsSubcategoryOptions } from '../../domain/analyticsFilters';
import { recentAnalyticsRange } from '../../domain/advancedAnalytics';
import Modal from '../ui/EditionModal.vue';
import ReportAutomationTab from './ReportAutomationTab.vue';
import AdvancedAnalyticsPanel from './AdvancedAnalyticsPanel.vue';

const today = businessDate();
const initialRange = recentAnalyticsRange(today);
const from = ref(initialRange.from);
const to = ref(initialRange.to);
const cadence = ref('day');
const channel = ref(''), paymentMethod = ref(''), category = ref(''), subcategory = ref('');
const report = ref(null), loading = ref(false), error = ref('');
const selected = ref(null), details = ref(null), detailLoading = ref(false), detailError = ref('');
let generation = 0, detailGeneration = 0;
const currency = computed(() => Store.state.selectedCompany?.preferences?.currency || 'RM');
const buckets = computed(() => reportBuckets(report.value?.daily || [], cadence.value));
const filterOptions = computed(() => report.value?.filterOptions || { channels: [], paymentMethods: [], categories: [], subcategories: [] });
const subcategoryOptions = computed(() => analyticsSubcategoryOptions(filterOptions.value, category.value));
const appliedFilters = computed(() => analyticsFilterLabels(report.value?.filters || {}, filterOptions.value));
const detailFilters = computed(() => analyticsFilterLabels(details.value?.filters || {}, details.value?.filterOptions || filterOptions.value));
const filtered = computed(() => !!report.value?.filterActive);
const breakdownGroups = computed(() => [
  { key: 'channel', title: 'Sales by channel', rows: report.value?.breakdowns?.channel || [] },
  { key: 'paymentMethod', title: 'Sales and collections by payment', rows: report.value?.breakdowns?.paymentMethod || [] },
  { key: 'category', title: 'Sales by product category', rows: report.value?.breakdowns?.category || [] },
]);
const largest = computed(() => Math.max(1, ...buckets.value.map(row => Math.abs(row.cashFlow))));
const label = bucket => reportBucketLabel(bucket, cadence.value);
const barStyle = bucket => {
  const height = Math.max(.6, Math.abs(bucket.cashFlow) / largest.value * 47);
  return { height: `${height}%`, top: bucket.cashFlow < 0 ? '50%' : `${50 - height}%`, background: bucket.cashFlow < 0 ? '#b97459' : 'var(--ed-accent)' };
};
const channelLabel = item => item.channel === 'manual' ? 'Recorded later'
  : item.channel === 'pos' ? 'POS' : 'Invoice';
const selectedFilters = () => ({ channel: channel.value, paymentMethod: paymentMethod.value,
  category: category.value, subcategory: subcategory.value });
const queryFor = (start, end) => analyticsReportQuery(start, end, selectedFilters());
function clearFilters() {
  channel.value = ''; paymentMethod.value = ''; category.value = ''; subcategory.value = '';
  refresh();
}
function applyPreset(name) {
  const end = businessDate(), year = end.slice(0, 4), month = end.slice(0, 7);
  to.value = end;
  if (name === 'week') from.value = businessDate(new Date(Date.now() - 6 * 86400000));
  if (name === 'thirty') from.value = recentAnalyticsRange(end).from;
  if (name === 'month') from.value = `${month}-01`;
  if (name === 'year') from.value = `${year}-01-01`;
  if (name === 'twelve') from.value = businessDate(new Date(Date.now() - 365 * 86400000));
  cadence.value = ['week','thirty','month'].includes(name) ? 'day' : 'month';
  refresh();
}

async function refresh() {
  const request = ++generation;
  loading.value = false;
  error.value = reportRange(from.value, to.value, 365);
  if (error.value) return;
  report.value = null;
  closeBucket();
  if (!Store.can('financialReports') || !Store.state.online || !Store.state.selectedCompany) return;
  loading.value = true;
  const companyId = Store.state.selectedCompany.id;
  try {
    const query = queryFor(from.value, to.value);
    query.set('analysis', 'true');
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
    const query = queryFor(bucket.from, bucket.to);
    const value = await api(companyPath(Store, `/reports/details?${query}`));
    if (request === detailGeneration && Store.state.selectedCompany?.id === companyId) details.value = value;
  } catch {
    if (request === detailGeneration) detailError.value = 'The underlying records could not be loaded. Close this view and try again.';
  } finally { if (request === detailGeneration) detailLoading.value = false; }
}
function closeBucket() { ++detailGeneration; selected.value = null; details.value = null; detailLoading.value = false; }
watch(() => [Store.state.selectedCompany?.id, Store.state.currentUser?.role, Store.state.online], refresh, { immediate: true });
watch(cadence, closeBucket);
watch(category, () => { subcategory.value = ''; });
onBeforeUnmount(() => { ++generation; ++detailGeneration; });
</script>

<template>
  <div v-if="Store.can('financialReports') && Store.state.online" class="ed-page report-page">
    <header class="ed-page-head"><div><div class="ed-eyebrow">ANALYTICS / FINANCIAL ANALYSIS</div><h1>Sales and cash, clearly.</h1><p>Sales, tax, expenses and cash flow for {{ Store.state.selectedCompany?.name || 'this company' }}.</p></div><button class="ed-btn" :disabled="loading" @click="refresh">{{ loading ? 'Loading…' : 'Refresh report' }}</button></header>
    <div class="report-presets ed-actions" aria-label="Report date presets"><button class="ed-btn small" type="button" @click="applyPreset('week')">Last 7 days</button><button class="ed-btn small" type="button" @click="applyPreset('thirty')">Last 30 days</button><button class="ed-btn small" type="button" @click="applyPreset('month')">This month</button><button class="ed-btn small" type="button" @click="applyPreset('year')">Year to date</button><button class="ed-btn small" type="button" @click="applyPreset('twelve')">Last 12 months</button></div>
    <form class="report-controls ed-filters" @submit.prevent="refresh">
      <fieldset class="report-interval"><legend>Group by</legend><div class="ed-segmented"><button v-for="choice in [{ value: 'day', title: 'Daily' }, { value: 'week', title: 'Weekly' }, { value: 'month', title: 'Monthly' }]" :key="choice.value" type="button" :class="{ active: cadence === choice.value }" :aria-pressed="cadence === choice.value" @click="cadence = choice.value">{{ choice.title }}</button></div></fieldset>
      <label class="ed-field"><span>Date from</span><input v-model="from" type="date" required></label>
      <label class="ed-field"><span>Date to</span><input v-model="to" type="date" required></label>
      <label class="ed-field report-dimension"><span>Sales channel</span><select v-model="channel"><option value="">All channels</option><option v-for="option in filterOptions.channels" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
      <label class="ed-field report-dimension"><span>Payment method</span><select v-model="paymentMethod"><option value="">All payment methods</option><option v-for="option in filterOptions.paymentMethods" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
      <label class="ed-field report-dimension"><span>Product category</span><select v-model="category"><option value="">All categories</option><option v-for="option in filterOptions.categories" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
      <label class="ed-field report-dimension"><span>Product subcategory</span><select v-model="subcategory" :disabled="!subcategoryOptions.length"><option value="">All subcategories</option><option v-for="option in subcategoryOptions" :key="`${option.category}:${option.value}`" :value="option.value">{{ category ? option.label : `${option.category} / ${option.label}` }}</option></select></label>
      <div class="ed-actions report-filter-actions"><button class="ed-btn primary" type="submit" :disabled="loading">Apply report</button><button v-if="channel||paymentMethod||category||subcategory" class="ed-btn" type="button" :disabled="loading" @click="clearFilters">Clear filters</button></div>
    </form>
    <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p><p v-if="loading" class="ed-notice" role="status">Loading the financial report…</p>
    <template v-if="report">
      <p class="ed-muted">{{ report.from }} to {{ report.to }} · Kuala Lumpur dates · {{ buckets.length }} {{ cadence === 'day' ? 'days' : cadence === 'week' ? 'weeks' : 'months' }}</p>
      <div v-if="appliedFilters.length" class="report-active-filters" aria-label="Applied report filters"><span v-for="item in appliedFilters" :key="item" class="ed-pill">{{ item }}</span></div>
      <p v-if="filtered" class="ed-notice"><strong>Filtered sales view.</strong> {{ report.filterScope }}</p>
      <div class="ed-metrics"><div class="ed-metric"><label>{{ filtered?'Filtered issued sales':'Issued sales' }}</label><strong>{{ money(report.sales, currency) }}</strong></div><div class="ed-metric"><label>{{ filtered?'Filtered cash in':'Cash in' }}</label><strong>{{ money(report.cashIn, currency) }}</strong></div><div class="ed-metric"><label>{{ filtered?'All cash out':'Cash out' }}</label><strong>{{ money(report.cashOut, currency) }}</strong></div><div class="ed-metric"><label>{{ filtered?'Filtered cash in less all cash out':'Net cash movement' }}</label><strong>{{ money(report.cashFlow, currency) }}</strong></div><div class="ed-metric"><label>{{ filtered?'All recognized expenses':'Recognized expenses' }}</label><strong>{{ money(report.expenses, currency) }}</strong></div><div class="ed-metric"><label>Open quote pipeline</label><strong>{{ money(report.quoted, currency) }}</strong></div><div class="ed-metric"><label>Converted quote value</label><strong>{{ money(report.convertedQuoted, currency) }}</strong></div><div class="ed-metric"><label>{{ filtered?'Tax on filtered sales':'Tax on sales' }}</label><strong>{{ money(report.tax, currency) }}</strong></div></div>
      <section class="report-breakdown-section" aria-labelledby="report-breakdown-title"><div class="ed-section-head"><div><h2 id="report-breakdown-title">Sales mix</h2><p class="ed-muted">Issued sales stay on their accrual date. Collections stay on their payment date.</p></div></div><div class="report-breakdown-grid">
        <article v-for="group in breakdownGroups" :key="group.key" class="report-breakdown"><h3>{{ group.title }}</h3><div v-if="group.rows.length" class="report-breakdown-rows"><div v-for="row in group.rows.slice(0,8)" :key="`${row.category||''}:${row.value}`"><span><strong>{{ row.category ? `${row.category} / ${row.label}` : row.label }}</strong><small>{{ row.salesCount }} sale{{ row.salesCount===1?'':'s' }} · {{ row.receiptCount }} receipt{{ row.receiptCount===1?'':'s' }}</small></span><span><strong>{{ money(row.sales,currency) }}</strong><small>Cash in {{ money(row.cashIn,currency) }}</small></span></div></div><p v-else class="ed-muted">No sales in this selection.</p><small v-if="group.rows.length>8" class="ed-muted">Showing 8 of {{ group.rows.length }} groups.</small></article>
      </div></section>
      <section class="report-chart-section"><div class="ed-section-head"><div><h2>{{ cadence === 'day' ? 'Daily' : cadence === 'week' ? 'Weekly' : 'Monthly' }} cash flow</h2><p class="ed-muted">Hover or focus for a breakdown. Select a bar to review the records.</p></div></div>
        <div class="report-chart-scroll"><div class="report-chart" role="group" aria-label="Cash flow by reporting interval"><button v-for="bucket in buckets" :key="bucket.key" type="button" class="report-column" :aria-label="`${label(bucket)}: sales ${money(bucket.sales,currency)}, cash in ${money(bucket.cashIn,currency)}, cash out ${money(bucket.cashOut,currency)}, cash flow ${money(bucket.cashFlow,currency)}. Open details.`" @click="openBucket(bucket)">
          <span class="report-tooltip" role="tooltip"><strong>{{ label(bucket) }}</strong><span>Sales {{ money(bucket.sales,currency) }}</span><span>Cash in {{ money(bucket.cashIn,currency) }}</span><span>Cash out {{ money(bucket.cashOut,currency) }}</span><span>Expenses {{ money(bucket.expenses,currency) }}</span><span>Cash flow {{ money(bucket.cashFlow,currency) }}</span></span>
          <span class="report-plot"><span class="report-bar" :style="barStyle(bucket)"></span></span><strong class="report-label">{{ cadence === 'month' ? label(bucket) : bucket.from.slice(5) }}</strong><small>{{ money(bucket.cashFlow,currency) }}</small>
        </button></div></div>
      </section>
      <div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Period</th><th>Sales</th><th>Cash in</th><th>Cash out</th><th>Expenses</th><th>Net cash</th><th>Details</th></tr></thead><tbody><tr v-for="bucket in buckets" :key="bucket.key"><td>{{ label(bucket) }}<small v-if="bucket.from !== bucket.to" class="report-range">{{ bucket.from }}–{{ bucket.to }}</small></td><td>{{ money(bucket.sales,currency) }}</td><td>{{ money(bucket.cashIn,currency) }}</td><td>{{ money(bucket.cashOut,currency) }}</td><td>{{ money(bucket.expenses,currency) }}</td><td>{{ money(bucket.cashFlow,currency) }}</td><td><button class="ed-btn small" @click="openBucket(bucket)">Review</button></td></tr></tbody><tfoot><tr><th>Period total</th><td>{{ money(report.sales,currency) }}</td><td>{{ money(report.cashIn,currency) }}</td><td>{{ money(report.cashOut,currency) }}</td><td>{{ money(report.expenses,currency) }}</td><td>{{ money(report.cashFlow,currency) }}</td><td></td></tr></tfoot></table></div>
      <p class="ed-muted">{{ report.basis }} Acquisition cost, margin, valuation and profit are excluded.</p>
    </template>
    <AdvancedAnalyticsPanel :from="from" :to="to" />
    <ReportAutomationTab />
    <Modal v-if="selected" :title="`${label(selected)} · financial detail`" wide @close="closeBucket">
      <p class="ed-muted">{{ selected.from }} to {{ selected.to }} · Kuala Lumpur dates</p>
      <div v-if="detailFilters.length" class="report-active-filters"><span v-for="item in detailFilters" :key="item" class="ed-pill">{{ item }}</span></div>
      <div class="report-detail-totals"><div><span>Sales</span><strong>{{ money(selected.sales,currency) }}</strong></div><div><span>Cash in</span><strong>{{ money(selected.cashIn,currency) }}</strong></div><div><span>Cash out</span><strong>{{ money(selected.cashOut,currency) }}</strong></div><div><span>Expenses</span><strong>{{ money(selected.expenses,currency) }}</strong></div><div><span>Tax</span><strong>{{ money(selected.tax,currency) }}</strong></div><div><span>Net cash</span><strong>{{ money(selected.cashFlow,currency) }}</strong></div></div>
      <p v-if="detailLoading" role="status">Loading sales, expenses and receipt details…</p><p v-if="detailError" class="ed-notice error" role="alert">{{ detailError }}</p>
      <template v-if="details"><p v-if="details.filterActive" class="ed-notice"><strong>Filtered detail.</strong> {{ details.filterScope }}</p><p v-if="details.limited" class="ed-notice warning">This period has many records. The totals include all records; each list below shows the first 250.</p>
        <section class="report-detail-section"><h3>Sales · {{ details.counts.sales }}</h3><div v-if="details.sales.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date / number</th><th>Kind / customer</th><th>Dimensions</th><th>Sales</th><th>Tax</th></tr></thead><tbody><tr v-for="item in details.sales" :key="item.id"><td>{{ item.date }}<small class="report-range">{{ item.number || item.id }}</small></td><td>{{ item.kind }}<small v-if="item.sourceQuoteNumber" class="report-range">Source {{ item.sourceQuoteNumber }}</small><small class="report-range">{{ item.customer || 'Customer not recorded' }}</small></td><td>{{ channelLabel(item) }} · {{ item.paymentMethod }}<small class="report-range">{{ item.categories.join(', ') }}<template v-if="item.subcategories.length"> / {{ item.subcategories.join(', ') }}</template></small></td><td>{{ money(item.total,currency) }}<small v-if="item.documentTotal!==undefined" class="report-range">of {{ money(item.documentTotal,currency) }} document total</small></td><td>{{ money(item.tax,currency) }}</td></tr></tbody></table></div><p v-else class="ed-muted">No sales in this period.</p></section>
        <section class="report-detail-section"><h3>Expenses and payables · {{ details.counts.expenses }}</h3><div v-if="details.expenses.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date / reference</th><th>Description / payee</th><th>Category</th><th>Cash status</th><th>Amount</th></tr></thead><tbody><tr v-for="item in details.expenses" :key="item.id"><td>{{ item.date }}<small v-if="item.number" class="report-range">{{ item.number }}</small></td><td>{{ item.description }}<small v-if="item.payee" class="report-range">{{ item.payee }}</small></td><td>{{ item.category }}</td><td>{{ item.cashImpact?`Cash out ${item.cashDate}`:item.status==='paid'?`Paid ${item.cashDate} · outside period`:'Pending · no cash movement' }}</td><td>{{ money(item.amount,currency) }}</td></tr></tbody></table></div><p v-else class="ed-muted">No expenses in this period.</p></section>
        <section class="report-detail-section"><h3>Expense cash movements · {{ details.counts.expenseCashMovements }}</h3><div v-if="details.expenseCashMovements.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date</th><th>Movement</th><th>Description / payee</th><th>Category</th><th>Cash out</th></tr></thead><tbody><tr v-for="item in details.expenseCashMovements" :key="item.id"><td>{{ item.cashDate || item.date }}</td><td>{{ item.kind }}</td><td>{{ item.description || item.expenseId || item.id }}<small v-if="item.payee" class="report-range">{{ item.payee }}</small></td><td>{{ item.category }}</td><td>{{ money(item.amount,currency) }}</td></tr></tbody></table></div><p v-else class="ed-muted">No expense payments or reversals in this period.</p></section>
        <section class="report-detail-section"><h3>Cash receipts · {{ details.counts.receipts }}</h3><div v-if="details.receipts.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date / number</th><th>Source</th><th>Dimensions</th><th>Amount received</th></tr></thead><tbody><tr v-for="item in details.receipts" :key="item.id"><td>{{ item.date }}<small class="report-range">{{ item.number || item.id }}</small></td><td>{{ item.kind }}</td><td>{{ channelLabel(item) }} · {{ item.paymentMethod }}<small class="report-range">{{ item.categories.join(', ') }}</small></td><td>{{ money(item.amount,currency) }}<small v-if="item.documentAmount!==undefined" class="report-range">of {{ money(item.documentAmount,currency) }} receipt</small></td></tr></tbody></table></div><p v-else class="ed-muted">No receipts in this period.</p></section>
        <section class="report-detail-section"><h3>Quotations · {{ details.counts.quotes }}</h3><p class="ed-muted">Open pipeline {{ money(details.totals.quoted,currency) }} · converted {{ money(details.totals.convertedQuoted,currency) }}</p><div v-if="details.quotes.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date / number</th><th>Customer</th><th>Category</th><th>Status</th><th>Quoted value</th></tr></thead><tbody><tr v-for="item in details.quotes" :key="item.id"><td>{{ item.date }}<small class="report-range">{{ item.number || item.id }}</small></td><td>{{ item.customer || 'Customer not recorded' }}</td><td>{{ item.categories.join(', ') }}</td><td>{{ item.status }}</td><td>{{ money(item.total,currency) }}<small v-if="item.documentTotal!==undefined" class="report-range">of {{ money(item.documentTotal,currency) }} quote</small></td></tr></tbody></table></div><p v-else class="ed-muted">No issued quotations in this period.</p></section>
        <p class="ed-muted">{{ details.basis }}</p>
      </template>
    </Modal>
  </div>
  <div v-else class="ed-notice">Connect with an authorized owner or manager account to view reports.</div>
</template>

<style scoped>
.report-presets{margin:-8px 0 18px;flex-wrap:wrap}.report-controls{align-items:end;gap:16px}.report-controls .ed-field{min-width:150px}.report-controls .report-dimension{min-width:180px}.report-interval{border:0;padding:0;margin:0}.report-interval legend{font-size:12px;margin-bottom:8px}.report-filter-actions{align-items:end;min-height:42px}.report-active-filters{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}.report-breakdown-section{margin:28px 0}.report-breakdown-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.report-breakdown{min-width:0;padding:16px;border:1px solid var(--ed-line);background:var(--ed-paper)}.report-breakdown h3{font-size:14px;margin:0 0 12px}.report-breakdown-rows>div{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-top:1px solid var(--ed-line)}.report-breakdown-rows>div>span{display:flex;flex-direction:column;gap:3px;min-width:0}.report-breakdown-rows>div>span:last-child{text-align:right}.report-breakdown-rows strong{font-size:11px;overflow-wrap:anywhere}.report-breakdown-rows small{font-size:9px;color:var(--ed-muted)}.report-chart-section{margin-bottom:26px}.report-chart-scroll{overflow-x:auto;border-bottom:1px solid var(--ed-line)}.report-chart{display:flex;gap:6px;min-width:max-content;padding:100px 4px 16px}.report-column{position:relative;display:flex;flex-direction:column;align-items:center;gap:7px;min-width:74px;width:74px;padding:0 3px 4px;background:transparent;color:var(--ed-ink);border:0;cursor:pointer}.report-column:hover,.report-column:focus-visible{color:var(--ed-accent)}.report-plot{position:relative;display:block;width:100%;height:190px;background:linear-gradient(transparent calc(50% - .5px),var(--ed-line) calc(50% - .5px),var(--ed-line) calc(50% + .5px),transparent calc(50% + .5px))}.report-bar{position:absolute;left:21%;width:58%;border-radius:2px 2px 0 0}.report-label{font-size:11px;white-space:nowrap}.report-column small{font-size:10px;white-space:nowrap}.report-tooltip{display:none;position:absolute;z-index:2;bottom:calc(100% - 94px);left:50%;transform:translateX(-50%);min-width:190px;padding:11px;background:var(--ed-paper);border:1px solid var(--ed-line);box-shadow:0 8px 26px #172c2630;text-align:left;color:var(--ed-ink);font-size:11px;pointer-events:none}.report-column:first-child .report-tooltip{left:0;transform:none}.report-column:last-child .report-tooltip{left:auto;right:0;transform:none}.report-tooltip strong,.report-tooltip span{display:block;margin-bottom:4px}.report-column:hover .report-tooltip,.report-column:focus-visible .report-tooltip{display:block}.report-range{display:block;color:var(--ed-muted);margin-top:4px;white-space:normal}.report-detail-totals{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0}.report-detail-totals>div{padding:12px;border:1px solid var(--ed-line)}.report-detail-totals span,.report-detail-totals strong{display:block}.report-detail-totals span{font-size:11px;color:var(--ed-muted)}.report-detail-totals strong{margin-top:6px;font-size:15px}.report-detail-section{margin-top:26px}.report-detail-section h3{font-size:17px;font-weight:600;margin-bottom:10px}@media(max-width:1000px){.report-breakdown-grid{grid-template-columns:1fr}}@media(max-width:720px){.report-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.report-interval{grid-column:1/-1}.report-controls .ed-field,.report-controls .report-dimension{min-width:0}.report-filter-actions{grid-column:1/-1}.report-detail-totals{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
