<script setup>
import { computed, nextTick, ref, watch, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
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
const detailTab = ref('sales'), rangeOpen = ref(false), filtersOpen = ref(false);
const financialPanel = ref('summary'), advancedLoading = ref(false);
const advancedPanel = ref(null), sectionNav = ref(null);
const route = useRoute(), router = useRouter();
const views = [
  { id:'overview', label:'Overview', short:'Health and priorities' },
  { id:'financial', label:'Sales & cash', short:'Revenue and movement' },
  { id:'products', label:'Products', short:'Item performance' },
  { id:'inventory', label:'Inventory', short:'Stock and replenishment' },
  { id:'customers', label:'Customers & orders', short:'Demand and retention' },
  { id:'reports', label:'Scheduled reports', short:'Snapshots and forecasts' },
];
const validViews = new Set(views.map(item => item.id));
const queryDate = value => typeof value === 'string' ? value : '';
const routeFrom = queryDate(route.query.from), routeTo = queryDate(route.query.to);
if (routeFrom && routeTo && !reportRange(routeFrom, routeTo, 365)) {
  from.value = routeFrom;
  to.value = routeTo;
}
const applied = ref({
  from:from.value, to:to.value, cadence:cadence.value,
  filters:{ channel:'', paymentMethod:'', category:'', subcategory:'' },
});
let generation = 0, detailGeneration = 0;
const activeView = computed(() => validViews.has(route.query.view) ? route.query.view : 'overview');
const advancedView = computed(() => ['overview','products','inventory','customers'].includes(activeView.value) ? activeView.value : '');
const reportView = computed(() => ['overview','financial'].includes(activeView.value));
const pageLoading = computed(() => loading.value || advancedLoading.value);
const currency = computed(() => Store.state.selectedCompany?.preferences?.currency || 'RM');
const buckets = computed(() => reportBuckets(report.value?.daily || [], applied.value.cadence));
const filterOptions = computed(() => report.value?.filterOptions || { channels: [], paymentMethods: [], categories: [], subcategories: [] });
const subcategoryOptions = computed(() => analyticsSubcategoryOptions(filterOptions.value, category.value));
const appliedFilters = computed(() => analyticsFilterLabels(report.value?.filters || {}, filterOptions.value));
const detailFilters = computed(() => analyticsFilterLabels(details.value?.filters || {}, details.value?.filterOptions || filterOptions.value));
const filtered = computed(() => !!report.value?.filterActive);
const activeFilterCount = computed(() => Object.values(applied.value.filters).filter(Boolean).length);
const hasDraftChanges = computed(() => from.value !== applied.value.from || to.value !== applied.value.to
  || cadence.value !== applied.value.cadence
  || channel.value !== applied.value.filters.channel || paymentMethod.value !== applied.value.filters.paymentMethod
  || category.value !== applied.value.filters.category || subcategory.value !== applied.value.filters.subcategory);
const rangeLabel = computed(() => `${applied.value.from} – ${applied.value.to}`);
const breakdownGroups = computed(() => [
  { key: 'channel', title: 'Sales by channel', rows: report.value?.breakdowns?.channel || [] },
  { key: 'paymentMethod', title: 'Sales and collections by payment', rows: report.value?.breakdowns?.paymentMethod || [] },
  { key: 'category', title: 'Sales by product category', rows: report.value?.breakdowns?.category || [] },
]);
const largest = computed(() => Math.max(1, ...buckets.value.map(row => Math.abs(row.cashFlow))));
const label = bucket => reportBucketLabel(bucket, applied.value.cadence);
const barStyle = bucket => {
  const height = Math.max(.6, Math.abs(bucket.cashFlow) / largest.value * 47);
  return { height: `${height}%`, top: bucket.cashFlow < 0 ? '50%' : `${50 - height}%`, background: bucket.cashFlow < 0 ? '#b97459' : 'var(--ed-accent)' };
};
const channelLabel = item => item.channel === 'manual' ? 'Recorded later'
  : item.channel === 'pos' ? 'POS' : 'Invoice';
const selectedFilters = () => ({ channel: channel.value, paymentMethod: paymentMethod.value,
  category: category.value, subcategory: subcategory.value });
const queryFor = (start, end) => analyticsReportQuery(start, end, applied.value.filters);
const viewTarget = id => ({ path:'/analytics', query:{ ...route.query, view:id,
  from:applied.value.from, to:applied.value.to } });
const detailTabs = computed(() => details.value ? [
  { id:'sales', label:'Sales', count:details.value.counts.sales },
  { id:'expenses', label:'Expenses', count:details.value.counts.expenses },
  { id:'movements', label:'Cash movements', count:details.value.counts.expenseCashMovements },
  { id:'receipts', label:'Receipts', count:details.value.counts.receipts },
  { id:'quotes', label:'Quotations', count:details.value.counts.quotes },
] : []);
function clearFilters() {
  channel.value = ''; paymentMethod.value = ''; category.value = ''; subcategory.value = '';
  applyReport();
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
  applyReport();
}

async function applyReport() {
  const rangeError = reportRange(from.value, to.value, 365);
  if (rangeError) { error.value = rangeError; return; }
  const changed = hasDraftChanges.value;
  applied.value = { from:from.value, to:to.value, cadence:cadence.value, filters:selectedFilters() };
  if (changed) report.value = null;
  rangeOpen.value = false;
  filtersOpen.value = false;
  error.value = '';
  closeBucket();
  await router.replace({ path:'/analytics', query:{ ...route.query, view:activeView.value,
    from:applied.value.from, to:applied.value.to } });
  if (reportView.value) await loadReport();
  else report.value = null;
}

async function loadReport() {
  const request = ++generation;
  error.value = reportRange(applied.value.from, applied.value.to, 365);
  if (error.value) return;
  if (!Store.can('financialReports') || !Store.state.online || !Store.state.selectedCompany) return;
  loading.value = true;
  const companyId = Store.state.selectedCompany.id;
  try {
    const query = queryFor(applied.value.from, applied.value.to);
    query.set('analysis', 'true');
    const value = await api(companyPath(Store, `/reports/summary?${query}`));
    if (request === generation && Store.state.selectedCompany?.id === companyId && Store.can('financialReports') && Store.state.online) report.value = value;
  } catch {
    if (request === generation) error.value = 'The financial report could not be loaded. Reconnect and retry.';
  } finally { if (request === generation) loading.value = false; }
}

async function refresh() {
  if (reportView.value) await loadReport();
  if (advancedView.value) {
    await nextTick();
    await advancedPanel.value?.refresh?.();
  }
}

async function openBucket(bucket) {
  selected.value = bucket;
  detailTab.value = 'sales';
  details.value = null;
  detailError.value = '';
  detailLoading.value = true;
  const request = ++detailGeneration, companyId = Store.state.selectedCompany?.id;
  try {
    const query = queryFor(bucket.from, bucket.to);
    const value = await api(companyPath(Store, `/reports/details?${query}`));
    if (request === detailGeneration && Store.state.selectedCompany?.id === companyId
      && Store.can('financialReports') && Store.state.online) details.value = value;
  } catch {
    if (request === detailGeneration) detailError.value = 'The underlying records could not be loaded. Close this view and try again.';
  } finally { if (request === detailGeneration) detailLoading.value = false; }
}
function closeBucket() { ++detailGeneration; selected.value = null; details.value = null; detailLoading.value = false; }
watch(() => [Store.state.selectedCompany?.id, Store.state.currentUser?.role, Store.state.online], () => {
  closeBucket();
  report.value = null;
  if (reportView.value) loadReport();
}, { immediate: true });
watch(activeView, view => {
  closeBucket();
  if (!['overview','products','inventory','customers'].includes(view)) advancedLoading.value = false;
  rangeOpen.value = false;
  filtersOpen.value = false;
  if (['overview','financial'].includes(view) && !report.value && !loading.value) loadReport();
  nextTick(() => sectionNav.value?.querySelector(`[data-view="${view}"]`)?.scrollIntoView({
    behavior:'auto', block:'nearest', inline:'center',
  }));
}, { immediate:true });
watch(() => [route.query.from, route.query.to], ([nextFrom,nextTo]) => {
  const start = queryDate(nextFrom), end = queryDate(nextTo);
  if (!start || !end) {
    const reset = recentAnalyticsRange(businessDate());
    if (reset.from === applied.value.from && reset.to === applied.value.to) return;
    from.value = reset.from; to.value = reset.to;
    applied.value = { ...applied.value, from:reset.from, to:reset.to };
    closeBucket();
    report.value = null;
    if (reportView.value) loadReport();
    return;
  }
  if (reportRange(start,end,365) || (start === applied.value.from && end === applied.value.to)) return;
  from.value = start; to.value = end;
  applied.value = { ...applied.value, from:start, to:end };
  closeBucket();
  report.value = null;
  if (reportView.value) loadReport();
});
watch(category, () => { subcategory.value = ''; });
onBeforeUnmount(() => { ++generation; ++detailGeneration; });
</script>

<template>
  <div v-if="Store.can('financialReports') && Store.state.online" class="ed-page analytics-workspace">
    <nav ref="sectionNav" class="analytics-workspace-nav" aria-label="Analytics sections">
      <router-link v-for="item in views" :key="item.id" :to="viewTarget(item.id)"
        :data-view="item.id" :aria-current="activeView===item.id?'page':undefined" :class="{active:activeView===item.id}">
        <span>{{ item.label }}</span><small>{{ item.short }}</small>
      </router-link>
    </nav>

    <section v-if="activeView!=='reports'" class="analytics-toolbar" aria-label="Analytics date and filter controls">
      <div class="analytics-toolbar-main">
        <div class="analytics-range-summary">
          <span>Reporting period</span>
          <strong>{{ rangeLabel }}</strong>
          <small>Kuala Lumpur dates</small>
        </div>
        <div class="analytics-presets" aria-label="Date presets">
          <button type="button" @click="applyPreset('week')">7 days</button>
          <button type="button" @click="applyPreset('thirty')">Last 30 days</button>
          <button type="button" @click="applyPreset('month')">This month</button>
          <button type="button" @click="applyPreset('year')">Year to date</button>
          <button type="button" @click="applyPreset('twelve')">12 months</button>
        </div>
        <div class="analytics-toolbar-actions">
          <button class="ed-btn small" type="button" :disabled="pageLoading" @click="refresh">{{ pageLoading ? 'Updating…' : 'Refresh' }}</button>
          <button class="ed-btn small" type="button" :aria-expanded="rangeOpen" @click="rangeOpen=!rangeOpen">
            {{ rangeOpen ? 'Close range' : 'Custom range' }}
          </button>
          <button v-if="activeView==='financial'" class="ed-btn small" type="button"
            :class="{active:filtersOpen||activeFilterCount}" :aria-expanded="filtersOpen" @click="filtersOpen=!filtersOpen">
            Filters<span v-if="activeFilterCount" class="filter-count">{{ activeFilterCount }}</span>
          </button>
        </div>
      </div>

      <form v-if="rangeOpen" class="analytics-control-panel range-panel" @submit.prevent="applyReport">
        <label class="ed-field"><span>Date from</span><input v-model="from" type="date" required></label>
        <label class="ed-field"><span>Date to</span><input v-model="to" type="date" required></label>
        <fieldset class="report-interval">
          <legend>Cash-flow grouping</legend>
          <div class="ed-segmented">
            <button v-for="choice in [{value:'day',title:'Daily'},{value:'week',title:'Weekly'},{value:'month',title:'Monthly'}]"
              :key="choice.value" type="button" :class="{active:cadence===choice.value}"
              :aria-pressed="cadence===choice.value" @click="cadence=choice.value">{{ choice.title }}</button>
          </div>
        </fieldset>
        <div class="control-panel-actions">
          <span v-if="hasDraftChanges">Changes are ready to apply.</span>
          <button class="ed-btn primary" type="submit" :disabled="loading">Apply period</button>
        </div>
      </form>

      <form v-if="activeView==='financial'&&filtersOpen" class="analytics-control-panel filter-panel" @submit.prevent="applyReport">
        <div class="filter-panel-heading">
          <div><strong>Sales & cash filters</strong><small>These dimensions affect sales, tax, quotes, and attributable receipts. Expenses and cash out remain company-wide.</small></div>
          <button v-if="channel||paymentMethod||category||subcategory" class="ed-btn small" type="button" :disabled="loading" @click="clearFilters">Clear all</button>
        </div>
        <div class="filter-fields">
          <label class="ed-field"><span>Sales channel</span><select v-model="channel"><option value="">All channels</option><option v-for="option in filterOptions.channels" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label class="ed-field"><span>Payment method</span><select v-model="paymentMethod"><option value="">All payment methods</option><option v-for="option in filterOptions.paymentMethods" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label class="ed-field"><span>Product category</span><select v-model="category"><option value="">All categories</option><option v-for="option in filterOptions.categories" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label class="ed-field"><span>Product subcategory</span><select v-model="subcategory" :disabled="!subcategoryOptions.length"><option value="">All subcategories</option><option v-for="option in subcategoryOptions" :key="option.category+':'+option.value" :value="option.value">{{ category ? option.label : option.category+' / '+option.label }}</option></select></label>
        </div>
        <div class="control-panel-actions">
          <span v-if="hasDraftChanges">Changes are ready to apply.</span>
          <button class="ed-btn primary" type="submit" :disabled="loading">Apply filters</button>
        </div>
      </form>
    </section>

    <p v-if="reportView&&error" class="ed-notice error" role="alert">{{ error }}</p>
    <p v-if="reportView&&loading&&!report" class="analytics-loading" role="status">Building the financial view…</p>

    <section v-if="activeView==='overview'" class="analytics-section overview-section" aria-labelledby="overview-title">
      <div class="analytics-section-heading">
        <div><span class="section-kicker">BUSINESS PULSE</span><h2 id="overview-title">What matters now</h2><p>A concise view of money movement, sales performance, and decisions that need attention.</p></div>
        <router-link class="section-link" :to="viewTarget('financial')">Open sales & cash <span aria-hidden="true">→</span></router-link>
      </div>
      <template v-if="report">
        <div v-if="appliedFilters.length" class="report-active-filters" aria-label="Applied report filters">
          <span v-for="item in appliedFilters" :key="item" class="ed-pill">{{ item }}</span>
        </div>
        <div class="financial-primary-grid">
          <article><span>{{ filtered?'Filtered issued sales':'Issued sales' }}</span><strong>{{ money(report.sales,currency) }}</strong><small>Accrual value in period</small></article>
          <article><span>{{ filtered?'Filtered cash in':'Cash in' }}</span><strong>{{ money(report.cashIn,currency) }}</strong><small>Collections received</small></article>
          <article><span>Cash out</span><strong>{{ money(report.cashOut,currency) }}</strong><small>Company-wide payments</small></article>
          <article :class="{negative:report.cashFlow<0}"><span>Net cash movement</span><strong>{{ money(report.cashFlow,currency) }}</strong><small>Cash in less cash out</small></article>
        </div>
      </template>
      <div class="analytics-scope-divider"><span>COMPANY-WIDE OPERATIONS</span><p>The sales trend, stock alerts, customer orders, and owner margin below include all channels for the selected period.</p></div>
      <AdvancedAnalyticsPanel ref="advancedPanel" :from="applied.from" :to="applied.to" view="overview" @busy="advancedLoading=$event" embedded />
      <div class="analytics-jump-grid" aria-label="Explore analytics">
        <router-link v-for="item in views.filter(entry=>['products','inventory','customers','reports'].includes(entry.id))"
          :key="item.id" :to="viewTarget(item.id)"><span>{{ item.label }}</span><small>{{ item.short }}</small><b aria-hidden="true">→</b></router-link>
      </div>
    </section>

    <section v-else-if="activeView==='financial'" class="analytics-section financial-section" aria-labelledby="financial-title">
      <div class="analytics-section-heading">
        <div><span class="section-kicker">FINANCIAL PERFORMANCE</span><h2 id="financial-title">Sales & cash</h2><p>Accrual sales, collections, expenses, tax, quotations, and cash movement in one focused view.</p></div>
      </div>
      <nav class="analytics-subnav" aria-label="Sales and cash sections">
        <button v-for="item in [{id:'summary',label:'Summary'},{id:'mix',label:'Sales mix'},{id:'cash',label:'Cash flow'}]"
          :key="item.id" type="button" :class="{active:financialPanel===item.id}" :aria-pressed="financialPanel===item.id" @click="financialPanel=item.id">{{ item.label }}</button>
      </nav>
      <template v-if="report">
        <div class="financial-context">
          <span>{{ report.from }} to {{ report.to }}</span><span>{{ buckets.length }} {{ applied.cadence==='day'?'days':applied.cadence==='week'?'weeks':'months' }}</span>
          <span v-if="filtered">Filtered sales view</span>
        </div>
        <div v-if="appliedFilters.length" class="report-active-filters" aria-label="Applied report filters"><span v-for="item in appliedFilters" :key="item" class="ed-pill">{{ item }}</span></div>
        <p v-if="filtered" class="ed-notice"><strong>Filtered sales view.</strong> {{ report.filterScope }}</p>
        <div v-if="financialPanel==='summary'" class="financial-primary-grid">
          <article><span>{{ filtered?'Filtered issued sales':'Issued sales' }}</span><strong>{{ money(report.sales,currency) }}</strong><small>Accrual value</small></article>
          <article><span>{{ filtered?'Filtered cash in':'Cash in' }}</span><strong>{{ money(report.cashIn,currency) }}</strong><small>Collections received</small></article>
          <article><span>{{ filtered?'All cash out':'Cash out' }}</span><strong>{{ money(report.cashOut,currency) }}</strong><small>Payments made</small></article>
          <article :class="{negative:report.cashFlow<0}"><span>Net cash movement</span><strong>{{ money(report.cashFlow,currency) }}</strong><small>Cash in less cash out</small></article>
        </div>
        <div v-if="financialPanel==='summary'" class="financial-secondary-grid">
          <div><span>Recognized expenses</span><strong>{{ money(report.expenses,currency) }}</strong></div>
          <div><span>Tax on sales</span><strong>{{ money(report.tax,currency) }}</strong></div>
          <div><span>Open quote pipeline</span><strong>{{ money(report.quoted,currency) }}</strong></div>
          <div><span>Converted quote value</span><strong>{{ money(report.convertedQuoted,currency) }}</strong></div>
        </div>

        <section v-if="financialPanel==='mix'" class="report-breakdown-section" aria-labelledby="report-breakdown-title">
          <div class="subsection-heading"><div><span class="section-kicker">REVENUE COMPOSITION</span><h3 id="report-breakdown-title">Sales mix</h3><p>Issued sales remain on their accrual date. Collections remain on their payment date.</p></div></div>
          <div class="report-breakdown-grid">
            <article v-for="group in breakdownGroups" :key="group.key" class="report-breakdown"><h4>{{ group.title }}</h4><div v-if="group.rows.length" class="report-breakdown-rows"><div v-for="row in group.rows.slice(0,8)" :key="(row.category||'')+':'+row.value"><span><strong>{{ row.category ? row.category+' / '+row.label : row.label }}</strong><small>{{ row.salesCount }} sale{{ row.salesCount===1?'':'s' }} · {{ row.receiptCount }} receipt{{ row.receiptCount===1?'':'s' }}</small></span><span><strong>{{ money(row.sales,currency) }}</strong><small>Cash in {{ money(row.cashIn,currency) }}</small></span></div></div><p v-else class="ed-muted">No sales in this selection.</p><small v-if="group.rows.length>8" class="ed-muted">Showing 8 of {{ group.rows.length }} groups.</small></article>
          </div>
        </section>

        <section v-if="financialPanel==='cash'" class="report-chart-section">
          <div class="subsection-heading"><div><span class="section-kicker">MONEY MOVEMENT</span><h3>{{ applied.cadence==='day'?'Daily':applied.cadence==='week'?'Weekly':'Monthly' }} cash flow</h3><p>Select any interval to review its underlying records.</p></div></div>
          <div class="report-chart-scroll"><div class="report-chart" :style="{'--bucket-count':buckets.length}" role="group" aria-label="Cash flow by reporting interval"><button v-for="bucket in buckets" :key="bucket.key" type="button" class="report-column" :aria-label="label(bucket)+': sales '+money(bucket.sales,currency)+', cash in '+money(bucket.cashIn,currency)+', cash out '+money(bucket.cashOut,currency)+', cash flow '+money(bucket.cashFlow,currency)+'. Open details.'" @click="openBucket(bucket)">
            <span class="report-tooltip" role="tooltip"><strong>{{ label(bucket) }}</strong><span>Sales {{ money(bucket.sales,currency) }}</span><span>Cash in {{ money(bucket.cashIn,currency) }}</span><span>Cash out {{ money(bucket.cashOut,currency) }}</span><span>Expenses {{ money(bucket.expenses,currency) }}</span><span>Cash flow {{ money(bucket.cashFlow,currency) }}</span></span>
            <span class="report-plot"><span class="report-bar" :style="barStyle(bucket)"></span></span><strong class="report-label">{{ applied.cadence==='month'?label(bucket):bucket.from.slice(5) }}</strong><small>{{ money(bucket.cashFlow,currency) }}</small>
          </button></div></div>
        </section>

        <div v-if="financialPanel==='cash'" class="ed-table-wrap financial-table"><table class="ed-table"><thead><tr><th>Period</th><th>Sales</th><th>Cash in</th><th>Cash out</th><th>Expenses</th><th>Net cash</th><th><span class="sr-only">Details</span></th></tr></thead><tbody><tr v-for="bucket in buckets" :key="bucket.key"><td>{{ label(bucket) }}<small v-if="bucket.from!==bucket.to" class="report-range">{{ bucket.from }}–{{ bucket.to }}</small></td><td>{{ money(bucket.sales,currency) }}</td><td>{{ money(bucket.cashIn,currency) }}</td><td>{{ money(bucket.cashOut,currency) }}</td><td>{{ money(bucket.expenses,currency) }}</td><td>{{ money(bucket.cashFlow,currency) }}</td><td><button class="ed-btn small" @click="openBucket(bucket)">Review</button></td></tr></tbody><tfoot><tr><th>Period total</th><td>{{ money(report.sales,currency) }}</td><td>{{ money(report.cashIn,currency) }}</td><td>{{ money(report.cashOut,currency) }}</td><td>{{ money(report.expenses,currency) }}</td><td>{{ money(report.cashFlow,currency) }}</td><td></td></tr></tfoot></table></div>
        <p class="method-note">{{ report.basis }} Acquisition cost, margin, valuation, and profit are excluded.</p>
      </template>
    </section>

    <section v-else-if="advancedView" class="analytics-section">
      <AdvancedAnalyticsPanel ref="advancedPanel" :from="applied.from" :to="applied.to" :view="activeView" @busy="advancedLoading=$event" embedded />
    </section>

    <section v-else-if="activeView==='reports'" class="analytics-section reports-section" aria-label="Scheduled reports">
      <ReportAutomationTab />
    </section>
    <Modal v-if="selected" :title="`${label(selected)} · financial detail`" wide @close="closeBucket">
      <p class="ed-muted">{{ selected.from }} to {{ selected.to }} · Kuala Lumpur dates</p>
      <div v-if="detailFilters.length" class="report-active-filters"><span v-for="item in detailFilters" :key="item" class="ed-pill">{{ item }}</span></div>
      <div class="report-detail-totals"><div><span>Sales</span><strong>{{ money(selected.sales,currency) }}</strong></div><div><span>Cash in</span><strong>{{ money(selected.cashIn,currency) }}</strong></div><div><span>Cash out</span><strong>{{ money(selected.cashOut,currency) }}</strong></div><div><span>Expenses</span><strong>{{ money(selected.expenses,currency) }}</strong></div><div><span>Tax</span><strong>{{ money(selected.tax,currency) }}</strong></div><div><span>Net cash</span><strong>{{ money(selected.cashFlow,currency) }}</strong></div></div>
      <p v-if="detailLoading" role="status">Loading sales, expenses and receipt details…</p><p v-if="detailError" class="ed-notice error" role="alert">{{ detailError }}</p>
      <template v-if="details"><p v-if="details.filterActive" class="ed-notice"><strong>Filtered detail.</strong> {{ details.filterScope }}</p><p v-if="details.limited" class="ed-notice warning">This period has many records. The totals include all records; each list below shows the first 250.</p>
        <nav class="detail-tabs" aria-label="Financial detail categories"><button v-for="tab in detailTabs" :key="tab.id" type="button" :class="{active:detailTab===tab.id}" :aria-pressed="detailTab===tab.id" @click="detailTab=tab.id"><span>{{ tab.label }}</span><small>{{ tab.count }}</small></button></nav>
        <section v-if="detailTab==='sales'" class="report-detail-section"><h3>Sales · {{ details.counts.sales }}</h3><div v-if="details.sales.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date / number</th><th>Kind / customer</th><th>Dimensions</th><th>Sales</th><th>Tax</th></tr></thead><tbody><tr v-for="item in details.sales" :key="item.id"><td>{{ item.date }}<small class="report-range">{{ item.number || item.id }}</small></td><td>{{ item.kind }}<small v-if="item.sourceQuoteNumber" class="report-range">Source {{ item.sourceQuoteNumber }}</small><small class="report-range">{{ item.customer || 'Customer not recorded' }}</small></td><td>{{ channelLabel(item) }} · {{ item.paymentMethod }}<small class="report-range">{{ item.categories.join(', ') }}<template v-if="item.subcategories.length"> / {{ item.subcategories.join(', ') }}</template></small></td><td>{{ money(item.total,currency) }}<small v-if="item.documentTotal!==undefined" class="report-range">of {{ money(item.documentTotal,currency) }} document total</small></td><td>{{ money(item.tax,currency) }}</td></tr></tbody></table></div><p v-else class="ed-muted">No sales in this period.</p></section>
        <section v-else-if="detailTab==='expenses'" class="report-detail-section"><h3>Expenses and payables · {{ details.counts.expenses }}</h3><div v-if="details.expenses.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date / reference</th><th>Description / payee</th><th>Category</th><th>Cash status</th><th>Amount</th></tr></thead><tbody><tr v-for="item in details.expenses" :key="item.id"><td>{{ item.date }}<small v-if="item.number" class="report-range">{{ item.number }}</small></td><td>{{ item.description }}<small v-if="item.payee" class="report-range">{{ item.payee }}</small></td><td>{{ item.category }}</td><td>{{ item.cashImpact?`Cash out ${item.cashDate}`:item.status==='paid'?`Paid ${item.cashDate} · outside period`:'Pending · no cash movement' }}</td><td>{{ money(item.amount,currency) }}</td></tr></tbody></table></div><p v-else class="ed-muted">No expenses in this period.</p></section>
        <section v-else-if="detailTab==='movements'" class="report-detail-section"><h3>Expense cash movements · {{ details.counts.expenseCashMovements }}</h3><div v-if="details.expenseCashMovements.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date</th><th>Movement</th><th>Description / payee</th><th>Category</th><th>Cash out</th></tr></thead><tbody><tr v-for="item in details.expenseCashMovements" :key="item.id"><td>{{ item.cashDate || item.date }}</td><td>{{ item.kind }}</td><td>{{ item.description || item.expenseId || item.id }}<small v-if="item.payee" class="report-range">{{ item.payee }}</small></td><td>{{ item.category }}</td><td>{{ money(item.amount,currency) }}</td></tr></tbody></table></div><p v-else class="ed-muted">No expense payments or reversals in this period.</p></section>
        <section v-else-if="detailTab==='receipts'" class="report-detail-section"><h3>Cash receipts · {{ details.counts.receipts }}</h3><div v-if="details.receipts.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date / number</th><th>Source</th><th>Dimensions</th><th>Amount received</th></tr></thead><tbody><tr v-for="item in details.receipts" :key="item.id"><td>{{ item.date }}<small class="report-range">{{ item.number || item.id }}</small></td><td>{{ item.kind }}</td><td>{{ channelLabel(item) }} · {{ item.paymentMethod }}<small class="report-range">{{ item.categories.join(', ') }}</small></td><td>{{ money(item.amount,currency) }}<small v-if="item.documentAmount!==undefined" class="report-range">of {{ money(item.documentAmount,currency) }} receipt</small></td></tr></tbody></table></div><p v-else class="ed-muted">No receipts in this period.</p></section>
        <section v-else class="report-detail-section"><h3>Quotations · {{ details.counts.quotes }}</h3><p class="ed-muted">Open pipeline {{ money(details.totals.quoted,currency) }} · converted {{ money(details.totals.convertedQuoted,currency) }}</p><div v-if="details.quotes.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date / number</th><th>Customer</th><th>Category</th><th>Status</th><th>Quoted value</th></tr></thead><tbody><tr v-for="item in details.quotes" :key="item.id"><td>{{ item.date }}<small class="report-range">{{ item.number || item.id }}</small></td><td>{{ item.customer || 'Customer not recorded' }}</td><td>{{ item.categories.join(', ') }}</td><td>{{ item.status }}</td><td>{{ money(item.total,currency) }}<small v-if="item.documentTotal!==undefined" class="report-range">of {{ money(item.documentTotal,currency) }} quote</small></td></tr></tbody></table></div><p v-else class="ed-muted">No issued quotations in this period.</p></section>
        <p class="ed-muted">{{ details.basis }}</p>
      </template>
    </Modal>
  </div>
  <div v-else class="ed-notice">Connect with an authorized owner or manager account to view reports.</div>
</template>

<style scoped>
.analytics-workspace{--analytics-radius:16px;display:grid;gap:0;max-width:1540px;margin:0 auto;padding-bottom:56px}
.analytics-workspace-nav{position:sticky;top:66px;z-index:20;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));padding:5px;border:1px solid var(--ed-line);background:color-mix(in srgb,var(--ed-paper) 94%,transparent);box-shadow:0 10px 26px color-mix(in srgb,var(--ed-ink) 7%,transparent);backdrop-filter:blur(16px)}
.analytics-workspace-nav a{display:grid;gap:3px;min-width:0;min-height:58px;padding:11px 13px;border-radius:10px;color:var(--ed-muted);text-decoration:none;transition:background .16s ease,color .16s ease,transform .16s ease}
.analytics-workspace-nav a:hover{background:var(--ed-wash);color:var(--ed-ink)}
.analytics-workspace-nav a:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}
.analytics-workspace-nav a.active{background:var(--ed-ink);color:var(--ed-paper);box-shadow:0 5px 14px color-mix(in srgb,var(--ed-ink) 18%,transparent)}
.analytics-workspace-nav span{overflow:hidden;font-size:13px;font-weight:700;line-height:1.2;text-overflow:ellipsis;white-space:nowrap}
.analytics-workspace-nav small{overflow:hidden;color:inherit;font-size:11px;line-height:1.3;opacity:1;text-overflow:ellipsis;white-space:nowrap}
.analytics-workspace-nav a.active small{opacity:.82}

.analytics-toolbar{margin:18px 0 30px;border:1px solid var(--ed-line);border-radius:var(--analytics-radius);background:color-mix(in srgb,var(--ed-paper) 88%,var(--ed-wash))}
.analytics-toolbar-main{display:grid;grid-template-columns:auto minmax(320px,1fr) auto;align-items:center;gap:22px;padding:13px 14px}
.analytics-range-summary{display:grid;gap:2px;min-width:190px}
.analytics-range-summary span,.section-kicker{color:var(--ed-muted);font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.analytics-range-summary strong{font-size:13px;font-variant-numeric:tabular-nums}
.analytics-range-summary small{color:var(--ed-muted);font-size:11px}
.analytics-presets{display:flex;align-items:center;justify-content:center;gap:4px;min-width:0}
.analytics-presets button{min-height:36px;padding:8px 10px;border:0;border-radius:9px;background:transparent;color:var(--ed-muted);font:600 12px var(--ed-font-sans);white-space:nowrap;cursor:pointer}
.analytics-presets button:hover,.analytics-presets button:focus-visible{background:var(--ed-paper);color:var(--ed-ink)}
.analytics-toolbar-actions{display:flex;justify-content:flex-end;gap:7px}
.analytics-toolbar-actions .ed-btn{min-height:38px}
.analytics-toolbar-actions .ed-btn.active{border-color:var(--ed-accent);color:var(--ed-accent)}
.filter-count{display:inline-grid;place-items:center;min-width:20px;height:20px;margin-left:7px;padding:0 5px;border-radius:999px;background:var(--ed-accent);color:#fff;font-size:11px}

.analytics-control-panel{display:grid;gap:14px;padding:17px;border-top:1px solid var(--ed-line);background:var(--ed-paper)}
.range-panel{grid-template-columns:minmax(150px,220px) minmax(150px,220px) auto 1fr;align-items:end}
.report-interval{min-width:240px;margin:0;padding:0;border:0}
.report-interval legend{margin-bottom:8px;font-size:12px;font-weight:650}
.filter-panel-heading{display:flex;grid-column:1/-1;align-items:flex-start;justify-content:space-between;gap:20px}
.filter-panel-heading div{display:grid;gap:4px}
.filter-panel-heading small{max-width:780px;color:var(--ed-muted);font-size:12px;line-height:1.45}
.filter-fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.control-panel-actions{display:flex;align-items:center;justify-content:flex-end;gap:14px}
.control-panel-actions span{color:var(--ed-muted);font-size:12px}

.analytics-loading{min-height:120px;margin:0;padding:38px;border:1px dashed var(--ed-line);border-radius:var(--analytics-radius);color:var(--ed-muted);text-align:center}
.analytics-section{display:grid;gap:24px;min-width:0}
.analytics-section-heading,.subsection-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}
.analytics-section-heading h2{margin:5px 0 7px;font-size:clamp(26px,3vw,36px);letter-spacing:-.04em}
.analytics-section-heading p,.subsection-heading p{max-width:760px;margin:0;color:var(--ed-muted);font-size:13px;line-height:1.55}
.subsection-heading h3{margin:5px 0 6px;font-size:23px;letter-spacing:-.03em}
.section-link{align-self:center;color:var(--ed-accent);font-size:13px;font-weight:700;text-decoration:none;white-space:nowrap}
.section-link:hover{text-decoration:underline}
.analytics-subnav{display:flex;width:max-content;max-width:100%;gap:5px;overflow-x:auto;padding:5px;border:1px solid var(--ed-line);border-radius:12px;background:var(--ed-wash)}
.analytics-subnav button{min-height:40px;padding:8px 15px;border:0;border-radius:8px;background:transparent;color:var(--ed-muted);font:650 12px var(--ed-font-sans);white-space:nowrap;cursor:pointer}
.analytics-subnav button.active{background:var(--ed-paper);color:var(--ed-ink);box-shadow:0 2px 8px color-mix(in srgb,var(--ed-ink) 9%,transparent)}
.analytics-scope-divider{display:grid;gap:3px;margin-top:5px;padding-top:22px;border-top:1px solid var(--ed-line)}
.analytics-scope-divider span{color:var(--ed-muted);font-size:11px;font-weight:700;letter-spacing:.1em}
.analytics-scope-divider p{margin:0;color:var(--ed-muted);font-size:12px}

.financial-primary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));overflow:hidden;border:1px solid var(--ed-line);border-radius:var(--analytics-radius);background:var(--ed-paper)}
.financial-primary-grid article{display:grid;align-content:start;gap:7px;min-height:132px;padding:20px;border-right:1px solid var(--ed-line)}
.financial-primary-grid article:last-child{border-right:0}
.financial-primary-grid article.negative strong{color:#a63b2b}
.financial-primary-grid span,.financial-secondary-grid span{color:var(--ed-muted);font-size:11px;font-weight:650;letter-spacing:.06em;text-transform:uppercase}
.financial-primary-grid strong{min-width:0;overflow-wrap:anywhere;font-size:clamp(24px,2.5vw,34px);font-variant-numeric:tabular-nums;letter-spacing:-.045em;line-height:1.12}
.financial-primary-grid small{color:var(--ed-muted);font-size:12px}
.financial-secondary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));overflow:hidden;border:1px solid var(--ed-line);border-radius:12px;background:color-mix(in srgb,var(--ed-paper) 86%,var(--ed-wash))}
.financial-secondary-grid>div{display:grid;gap:6px;padding:14px 17px;border-right:1px solid var(--ed-line)}
.financial-secondary-grid>div:last-child{border-right:0}
.financial-secondary-grid strong{font-size:17px;font-variant-numeric:tabular-nums}
.financial-context{display:flex;flex-wrap:wrap;gap:8px}
.financial-context span{padding:6px 9px;border-radius:999px;background:var(--ed-wash);color:var(--ed-muted);font-size:11px;font-weight:650}
.report-active-filters{display:flex;flex-wrap:wrap;gap:7px;margin:-10px 0 0}

.analytics-jump-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.analytics-jump-grid a{position:relative;display:grid;gap:4px;min-height:92px;padding:17px 42px 17px 17px;border:1px solid var(--ed-line);border-radius:13px;background:var(--ed-paper);color:var(--ed-ink);text-decoration:none;transition:border-color .16s ease,transform .16s ease,box-shadow .16s ease}
.analytics-jump-grid a:hover{transform:translateY(-2px);border-color:var(--ed-accent);box-shadow:0 10px 22px color-mix(in srgb,var(--ed-ink) 7%,transparent)}
.analytics-jump-grid span{font-size:14px;font-weight:700}
.analytics-jump-grid small{color:var(--ed-muted);font-size:12px}
.analytics-jump-grid b{position:absolute;right:17px;top:17px;color:var(--ed-accent);font-size:18px}

.report-breakdown-section{display:grid;gap:15px;margin-top:10px}
.report-breakdown-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.report-breakdown{min-width:0;padding:17px;border:1px solid var(--ed-line);border-radius:13px;background:var(--ed-paper)}
.report-breakdown h4{margin:0 0 12px;font-size:14px}
.report-breakdown-rows>div{display:flex;justify-content:space-between;gap:14px;padding:10px 0;border-top:1px solid var(--ed-line)}
.report-breakdown-rows>div>span{display:flex;flex-direction:column;gap:3px;min-width:0}
.report-breakdown-rows>div>span:last-child{text-align:right}
.report-breakdown-rows strong{overflow-wrap:anywhere;font-size:12px}
.report-breakdown-rows small{color:var(--ed-muted);font-size:11px;line-height:1.35}

.report-chart-section{display:grid;gap:14px;margin-top:8px}
.report-chart-scroll{overflow-x:auto;border:1px solid var(--ed-line);border-radius:14px;background:var(--ed-paper)}
.report-chart{display:grid;grid-template-columns:repeat(var(--bucket-count),minmax(38px,1fr));gap:4px;min-width:calc(var(--bucket-count) * 38px);padding:88px 12px 15px}
.report-column{position:relative;display:flex;min-width:0;flex-direction:column;align-items:center;gap:7px;padding:0 2px 4px;border:0;background:transparent;color:var(--ed-ink);cursor:pointer}
.report-column:hover,.report-column:focus-visible{color:var(--ed-accent)}
.report-plot{position:relative;display:block;width:100%;height:176px;background:linear-gradient(transparent calc(50% - .5px),var(--ed-line) calc(50% - .5px),var(--ed-line) calc(50% + .5px),transparent calc(50% + .5px))}
.report-bar{position:absolute;left:24%;width:52%;border-radius:3px 3px 0 0}
.report-label{max-width:100%;overflow:hidden;font-size:10px;text-overflow:ellipsis;white-space:nowrap}
.report-column>small{max-width:100%;overflow:hidden;font-size:9px;text-overflow:ellipsis;white-space:nowrap}
.report-tooltip{display:none;position:absolute;z-index:3;bottom:calc(100% - 82px);left:50%;min-width:190px;padding:11px;transform:translateX(-50%);border:1px solid var(--ed-line);border-radius:10px;background:var(--ed-paper);box-shadow:0 12px 28px #172c2630;color:var(--ed-ink);font-size:11px;text-align:left;pointer-events:none}
.report-column:first-child .report-tooltip{left:0;transform:none}.report-column:last-child .report-tooltip{right:0;left:auto;transform:none}
.report-tooltip strong,.report-tooltip span{display:block;margin-bottom:4px}
.report-column:hover .report-tooltip,.report-column:focus-visible .report-tooltip{display:block}
.financial-table{border-radius:13px}
.financial-table table{font-variant-numeric:tabular-nums}
.report-range{display:block;margin-top:4px;color:var(--ed-muted);white-space:normal}
.method-note{margin:0;color:var(--ed-muted);font-size:11px;line-height:1.5}

.report-detail-totals{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin:18px 0}
.report-detail-totals>div{padding:11px;border:1px solid var(--ed-line);border-radius:10px}
.report-detail-totals span,.report-detail-totals strong{display:block}
.report-detail-totals span{color:var(--ed-muted);font-size:11px}
.report-detail-totals strong{margin-top:6px;font-size:14px;font-variant-numeric:tabular-nums}
.detail-tabs{display:flex;gap:5px;overflow-x:auto;margin:18px 0 0;padding:5px;border:1px solid var(--ed-line);border-radius:12px;background:var(--ed-wash)}
.detail-tabs button{display:flex;align-items:center;gap:8px;min-height:40px;padding:8px 12px;border:0;border-radius:8px;background:transparent;color:var(--ed-muted);font:650 12px var(--ed-font-sans);white-space:nowrap;cursor:pointer}
.detail-tabs button.active{background:var(--ed-paper);color:var(--ed-ink);box-shadow:0 2px 8px color-mix(in srgb,var(--ed-ink) 9%,transparent)}
.detail-tabs small{display:grid;place-items:center;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:var(--ed-line);color:inherit;font-size:10px}
.report-detail-section{margin-top:18px}.report-detail-section h3{margin-bottom:10px;font-size:17px;font-weight:650}
.reports-section :deep(.report-automation){margin-top:0;border-top:0;padding-top:0}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

@media(max-width:1180px){
  .analytics-workspace-nav{display:flex;overflow-x:auto;scroll-snap-type:x proximity}
  .analytics-workspace-nav a{flex:0 0 168px;scroll-snap-align:start}
  .analytics-toolbar-main{grid-template-columns:auto 1fr}.analytics-toolbar-actions{grid-column:1/-1}
  .filter-fields{grid-template-columns:repeat(2,minmax(0,1fr))}
  .financial-primary-grid,.financial-secondary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .financial-primary-grid article:nth-child(2),.financial-secondary-grid>div:nth-child(2){border-right:0}
  .financial-primary-grid article:nth-child(-n+2),.financial-secondary-grid>div:nth-child(-n+2){border-bottom:1px solid var(--ed-line)}
  .analytics-jump-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .report-detail-totals{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media(max-width:900px){
  .analytics-workspace-nav{top:62px}
  .analytics-toolbar-main{grid-template-columns:1fr}
  .analytics-presets{justify-content:flex-start;overflow-x:auto}
  .analytics-toolbar-actions{grid-column:auto;justify-content:flex-start}
  .range-panel{grid-template-columns:repeat(2,minmax(0,1fr))}
  .report-interval,.control-panel-actions{grid-column:1/-1}
  .report-breakdown-grid{grid-template-columns:1fr}
}
@media(max-width:600px){
  .analytics-workspace{padding-bottom:34px}
  .analytics-workspace-nav{margin-right:-12px;margin-left:-12px;border-right:0;border-left:0}
  .analytics-toolbar{margin:14px 0 24px;border-radius:12px}
  .analytics-presets button{min-height:44px}
  .analytics-toolbar-actions .ed-btn{min-height:44px}
  .analytics-control-panel,.range-panel,.filter-fields{grid-template-columns:1fr}
  .report-interval,.control-panel-actions{grid-column:auto}.control-panel-actions{align-items:stretch;flex-direction:column}.control-panel-actions .ed-btn{width:100%}
  .filter-panel-heading{align-items:stretch;flex-direction:column}.filter-panel-heading .ed-btn{width:100%}
  .analytics-section-heading,.subsection-heading{align-items:stretch;flex-direction:column;gap:12px}.section-link{align-self:flex-start}
  .financial-primary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .financial-primary-grid article{min-height:116px;padding:15px}
  .financial-primary-grid strong{font-size:clamp(20px,6vw,27px)}
  .financial-secondary-grid{grid-template-columns:1fr}
  .financial-secondary-grid>div{border-right:0;border-bottom:1px solid var(--ed-line)}
  .financial-secondary-grid>div:last-child{border-bottom:0}
  .analytics-jump-grid{grid-template-columns:1fr}
  .report-chart{grid-template-columns:repeat(var(--bucket-count),minmax(44px,1fr));min-width:calc(var(--bucket-count) * 44px)}
  .report-detail-totals{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(pointer:coarse){
  .analytics-presets button,.analytics-subnav button,.detail-tabs button{min-height:46px}
  .analytics-toolbar-actions .ed-btn,.report-column{min-height:46px}
  .report-interval :deep(button){min-height:46px}
}
@media(max-width:380px){
  .financial-primary-grid{grid-template-columns:1fr}
  .financial-primary-grid article{border-right:0;border-bottom:1px solid var(--ed-line)}
  .financial-primary-grid article:last-child{border-bottom:0}
}
</style>
