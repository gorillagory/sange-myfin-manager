<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Store } from '../../../store';
import { businessDate } from '../../../domain/pos.js';
import { buildExpenseClaimReport, buildExpenseReport } from '../../../domain/expenseReport.js';
import { downloadExpenseClaimPdf, downloadExpenseReportPdf } from '../../../services/expenseReportPdf.js';
import {
  expenseInsightsSnapshot, expenseInsightsSnapshotKey, getExpenseClaimReport, getExpenseInsights,
} from '../../../services/expenseAnalytics.js';
import Icon from '../../ui/EditionIcon.vue';

const today = businessDate();
const from = ref(`${today.slice(0, 4)}-01-01`), to = ref(today), grain = ref('month');
const insights = ref(null), appliedSnapshot = ref(null), loading = ref(false), error = ref(''), reportBusy = ref(false), claimBusy = ref('');
let generation = 0, claimGeneration = 0, reportGeneration = 0;

const currency = computed(() => Store.state.selectedCompany?.preferences?.currency || 'RM');
const summary = computed(() => insights.value?.summary || {});
const periods = computed(() => insights.value?.periods || []);
const ageing = computed(() => insights.value?.ageing || []);
const categories = computed(() => insights.value?.categories || []);
const claimants = computed(() => insights.value?.claimants || []);
const paymentSources = computed(() => insights.value?.paymentSources || []);
const pettyCash = computed(() => insights.value?.pettyCash || { restricted:true, claimDisbursementSen:0 });
const oldestOutstanding = computed(() => insights.value?.oldestOutstanding || []);
const companyScope = computed(() => insights.value?.scope?.mode
  ? insights.value.scope.mode === 'company' : Boolean(Store.permissions().owner || Store.permissions().manager));
const rangeInvalid = computed(() => !/^\d{4}-\d{2}-\d{2}$/.test(from.value)
  || !/^\d{4}-\d{2}-\d{2}$/.test(to.value) || from.value > to.value);
const evidenceRate = computed(() => summary.value.claimCount
  ? Math.round(Number(summary.value.evidenceCount || 0) / Number(summary.value.claimCount) * 100) : 0);
const periodMax = computed(() => Math.max(1, ...periods.value.flatMap(row => [Number(row.totalSen || 0), Number(row.cashOutSen || 0)])));
const categoryMax = computed(() => Math.max(1, ...categories.value.map(row => Number(row.totalSen || 0))));
const currentSnapshot = computed(() => expenseInsightsSnapshot(Store, { from:from.value, to:to.value, grain:grain.value }));
const contextKey = computed(() => {
  const snapshot=currentSnapshot.value;
  return [snapshot.companyId,snapshot.actorId,snapshot.role,snapshot.moduleGrants,snapshot.reportAccess?'1':'0',Store.state.online?'1':'0'].join('\u0000');
});
const reportDirty = computed(() => !appliedSnapshot.value
  || expenseInsightsSnapshotKey(currentSnapshot.value) !== expenseInsightsSnapshotKey(appliedSnapshot.value));
const reportReady = computed(() => Boolean(insights.value && !loading.value && !reportDirty.value));

const moneySen = value => `${currency.value} ${(Number(value || 0) / 100).toLocaleString('en-MY', {
  minimumFractionDigits:2, maximumFractionDigits:2,
})}`;
const percent = (value, total) => `${Math.max(0, Math.min(100, total ? Number(value || 0) / Number(total) * 100 : 0))}%`;
const plural = (count, singular, many = `${singular}s`) => `${Number(count || 0).toLocaleString('en-MY')} ${Number(count) === 1 ? singular : many}`;
const workspace = () => Store.state.tenantContext?.workspace
  || { id:Store.state.selectedCompany?.workspace_id, name:Store.state.selectedCompany?.workspaceName };

function dateOffset(value, mutate) {
  const date = new Date(`${value}T00:00:00.000Z`); mutate(date); return date.toISOString().slice(0, 10);
}
function applyPreset(name) {
  const year = today.slice(0, 4), month = today.slice(5, 7), quarter = Math.floor((Number(month) - 1) / 3) * 3 + 1;
  to.value = today;
  if (name === 'month') { from.value = `${today.slice(0, 7)}-01`; grain.value = 'month'; }
  if (name === 'quarter') { from.value = `${year}-${String(quarter).padStart(2, '0')}-01`; grain.value = 'month'; }
  if (name === 'year') { from.value = `${year}-01-01`; grain.value = 'month'; }
  if (name === 'twelve') { from.value = dateOffset(today, date => { date.setUTCFullYear(date.getUTCFullYear() - 1); date.setUTCDate(date.getUTCDate() + 1); }); grain.value = 'month'; }
  load();
}

async function load() {
  if (!Store.can('expenseReportsRead') || !Store.state.online || !Store.state.selectedCompany?.id) {
    ++generation; insights.value = null; appliedSnapshot.value = null; error.value = ''; loading.value = false; return;
  }
  if (rangeInvalid.value) { error.value = 'Choose a valid date range with the start on or before the end.'; return; }
  const request = ++generation, snapshot = currentSnapshot.value;
  loading.value = true; error.value = '';
  try {
    const result = await getExpenseInsights(Store, snapshot);
    if (request === generation && expenseInsightsSnapshotKey(currentSnapshot.value) === expenseInsightsSnapshotKey(snapshot)) {
      insights.value = result; appliedSnapshot.value = snapshot;
    }
  } catch (caught) {
    if (request === generation) error.value = caught.message || 'Expense insights could not be loaded.';
  } finally { if (request === generation) loading.value = false; }
}

async function exportReport() {
  if (!reportReady.value || reportBusy.value) return;
  const request=++reportGeneration,snapshot=appliedSnapshot.value,snapshotKey=expenseInsightsSnapshotKey(snapshot);
  const reportContextCurrent=()=>request===reportGeneration&&snapshotKey===expenseInsightsSnapshotKey(appliedSnapshot.value)
    && snapshotKey===expenseInsightsSnapshotKey(currentSnapshot.value);
  reportBusy.value = true;
  try {
    const company = Store.state.selectedCompany || {},claimsComplete=Array.isArray(insights.value.claims)&&!insights.value.claimsLimited;
    const serverClaims=claimsComplete?insights.value.claims:[];
    const report = buildExpenseReport({
      expenses:serverClaims, detailsAvailable:claimsComplete,
      detailOmission:claimsComplete?null:{reason:insights.value.claimsLimited?'report_limit':'projection_unavailable',
        totalCount:Number(summary.value.claimCount||0)+Number(summary.value.draftCount||0),
        returnedCount:Number(insights.value.claimsReturned||0),limit:Number(insights.value.claimLimit||0)},
      company, workspace:workspace(), actor:Store.state.currentUser,
      filters:{ from:snapshot.from, to:snapshot.to }, analytics:insights.value, serverAnalytics:insights.value,
      generatedAt:new Date().toISOString(),
    });
    const saved=await downloadExpenseReportPdf(report,{shouldSave:reportContextCurrent});
    if(!saved)return;
    Store.notify(`${companyScope.value ? 'Company' : 'Personal'} expense report downloaded.`);
  } catch (caught) { if(reportContextCurrent())Store.notify(caught.message || 'The expense report could not be created.', 'error'); }
  finally { if(request===reportGeneration)reportBusy.value = false; }
}

async function exportClaim(expenseId) {
  if (!expenseId || claimBusy.value) return;
  const request=++claimGeneration,requestContextKey=contextKey.value;
  const contextCurrent=()=>requestContextKey===contextKey.value;
  claimBusy.value = expenseId;
  try {
    const payload = await getExpenseClaimReport(Store, expenseId);
    if(request!==claimGeneration||!contextCurrent())return;
    const report = buildExpenseClaimReport({ ...payload, company:payload.company || Store.state.selectedCompany,
      workspace:payload.workspace || workspace(), actor:Store.state.currentUser, generatedAt:new Date().toISOString() });
    const saved=await downloadExpenseClaimPdf(report,{shouldSave:()=>request===claimGeneration&&contextCurrent()});
    if(saved)Store.notify('Claim report downloaded.');
  } catch (caught) {
    if(request===claimGeneration&&contextCurrent())Store.notify(caught.message || 'The claim report could not be created.', 'error');
  } finally { if(request===claimGeneration&&contextCurrent())claimBusy.value = ''; }
}

watch(contextKey, () => {
  ++generation; ++claimGeneration; ++reportGeneration; insights.value=null; appliedSnapshot.value=null; error.value='';
  loading.value=false; claimBusy.value=''; reportBusy.value=false;
  load();
}, { immediate:true });
onBeforeUnmount(() => { ++generation; ++claimGeneration; ++reportGeneration; });
</script>

<template>
  <section class="expense-insights" aria-labelledby="expense-insights-title">
    <div class="insights-head">
      <div><div class="ed-eyebrow">EXPENSE INTELLIGENCE</div><h2 id="expense-insights-title">{{ companyScope ? 'Company expenses' : 'My claims' }}</h2><p>{{ companyScope ? 'Review spending, settlement risk, staff claims, and petty-cash usage.' : 'Review your own claims, evidence, payments, and outstanding balances.' }}</p></div>
      <div class="ed-actions"><button class="ed-btn" :disabled="loading||!Store.state.online||!Store.can('expenseReportsRead')" @click="load"><Icon name="clock"/>{{ loading?'Updating…':'Refresh' }}</button><button class="ed-btn primary" :disabled="!reportReady||reportBusy" :title="reportDirty?'Apply the current filters before downloading.':''" @click="exportReport"><Icon name="download"/>{{ reportBusy?'Preparing…':'Download PDF' }}</button></div>
    </div>

    <form class="insights-toolbar" @submit.prevent="load">
      <div class="insights-presets" aria-label="Expense period presets"><button type="button" @click="applyPreset('month')">This month</button><button type="button" @click="applyPreset('quarter')">This quarter</button><button type="button" @click="applyPreset('year')">Year to date</button><button type="button" @click="applyPreset('twelve')">Last 12 months</button></div>
      <label class="ed-field"><span>From</span><input v-model="from" type="date" required></label>
      <label class="ed-field"><span>To</span><input v-model="to" type="date" required></label>
      <fieldset class="grain-picker"><legend>Group by</legend><div class="ed-segmented"><button v-for="item in [{id:'month',label:'Month'},{id:'quarter',label:'Quarter'},{id:'year',label:'Year'}]" :key="item.id" type="button" :class="{active:grain===item.id}" :aria-pressed="grain===item.id" @click="grain=item.id">{{ item.label }}</button></div></fieldset>
      <button class="ed-btn" type="submit" :disabled="loading||rangeInvalid">Apply</button>
    </form>
    <p v-if="!Store.state.online" class="ed-notice warning">Expense insights need a live connection. Existing expense records remain available in the Expenses &amp; claims tab.</p>
    <p v-else-if="!Store.can('expenseReportsRead')" class="ed-notice warning">Your expense-report access is not enabled for this company.</p>
    <p v-else-if="insights&&reportDirty" class="ed-notice" role="status">Filters have changed. Apply them before downloading this report.</p>
    <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
    <p v-if="loading&&!insights" class="insights-loading" role="status">Building the expense report…</p>

    <template v-if="insights">
      <div class="scope-note"><span class="ed-pill">{{ companyScope?'Company scope':'Personal scope' }}</span><span>{{ insights.from }} to {{ insights.to }} · grouped by {{ insights.grain }}</span></div>
      <div class="insight-kpis">
        <article><span>Claims</span><strong>{{ (Number(summary.claimCount||0)+Number(summary.draftCount||0)).toLocaleString('en-MY') }}</strong><small>{{ Number(summary.draftCount||0)>0?`${Number(summary.claimCount||0)} posted · ${summary.draftCount} draft${Number(summary.draftCount)===1?'':'s'} · ${moneySen(summary.draftSen)} not posted`:(companyScope?'Visible company records':'Only records assigned to you') }}</small></article>
        <article><span>Recorded</span><strong>{{ moneySen(summary.totalSen) }}</strong><small>Accrued in the period</small></article>
        <article><span>Paid</span><strong>{{ moneySen(summary.paidSen) }}</strong><small>Cash settled against claims</small></article>
        <article :class="{attention:Number(summary.outstandingSen)>0}"><span>Outstanding</span><strong>{{ moneySen(summary.outstandingSen) }}</strong><small>{{ plural(summary.overdueCount,'overdue claim') }}</small></article>
        <article :class="{danger:Number(summary.overdueSen)>0}"><span>Overdue</span><strong>{{ moneySen(summary.overdueSen) }}</strong><small>Needs payment attention</small></article>
        <article><span>Receipt coverage</span><strong>{{ evidenceRate }}%</strong><small>{{ summary.evidenceCount||0 }} of {{ summary.claimCount||0 }} with evidence</small></article>
      </div>

      <div class="insight-grid wide-first">
        <section class="insight-card period-card">
          <div class="card-head"><div><span class="ed-eyebrow">CASH &amp; ACCRUAL</span><h3>Expense movement</h3></div><small>{{ insights.grain }} view</small></div>
          <div v-if="periods.length" class="ed-table-wrap"><table class="ed-table period-table"><thead><tr><th>Period</th><th>Claims</th><th>Recorded</th><th>Paid</th><th>Cash out</th><th>Outstanding</th></tr></thead><tbody><tr v-for="row in periods" :key="row.key"><td><strong>{{ row.label }}</strong><small>{{ row.from }}<template v-if="row.to!==row.from"> – {{ row.to }}</template></small></td><td>{{ row.claimCount }}<small v-if="row.draftCount">{{ row.draftCount }} draft{{ Number(row.draftCount)===1?'':'s' }}</small></td><td><span class="bar-value">{{ moneySen(row.totalSen) }}<small v-if="row.draftCount">{{ moneySen(row.draftSen) }} not posted</small><i :style="{width:percent(row.totalSen,periodMax)}"></i></span></td><td>{{ moneySen(row.paidSen) }}</td><td>{{ moneySen(row.cashOutSen) }}</td><td>{{ moneySen(row.outstandingSen) }}</td></tr></tbody></table></div>
          <p v-else class="empty-copy">No expense movement in this period.</p>
        </section>

        <section class="insight-card ageing-card">
          <div class="card-head"><div><span class="ed-eyebrow">PAYMENT AGE</span><h3>Outstanding ageing</h3></div><strong>{{ moneySen(summary.outstandingSen) }}</strong></div>
          <div v-if="ageing.length" class="distribution-list"><div v-for="row in ageing" :key="row.key"><span><strong>{{ row.label }}</strong><small>{{ plural(row.claimCount,'claim') }}</small></span><span class="distribution-amount"><strong>{{ moneySen(row.outstandingSen) }}</strong><i><b :style="{width:percent(row.outstandingSen,summary.outstandingSen)}"></b></i></span></div></div><p v-else class="empty-copy">No outstanding claims.</p>
        </section>
      </div>

      <div class="insight-grid">
        <section class="insight-card">
          <div class="card-head"><div><span class="ed-eyebrow">SPEND MIX</span><h3>Expenses by category</h3></div></div>
          <div v-if="categories.length" class="distribution-list"><div v-for="row in categories" :key="row.key"><span><strong>{{ row.label }}</strong><small>{{ plural(row.claimCount,'posted claim') }}<template v-if="row.draftCount"> · {{ row.draftCount }} draft{{ Number(row.draftCount)===1?'':'s' }}</template></small></span><span class="distribution-amount"><strong>{{ moneySen(row.totalSen) }}</strong><i><b :style="{width:percent(row.totalSen,categoryMax)}"></b></i><small>{{ moneySen(row.outstandingSen) }} outstanding<template v-if="row.draftCount"> · {{ moneySen(row.draftSen) }} not posted</template></small></span></div></div><p v-else class="empty-copy">No categorized expenses in this period.</p>
        </section>

        <section class="insight-card">
          <div class="card-head"><div><span class="ed-eyebrow">SETTLEMENT MIX</span><h3>Payment sources</h3></div></div>
          <div v-if="paymentSources.length" class="compact-list"><div v-for="row in paymentSources" :key="row.key"><span><strong>{{ row.label }}</strong><small>{{ plural(row.paymentCount,'payment') }}</small></span><strong>{{ moneySen(row.netSen) }}</strong></div></div><p v-else class="empty-copy">No payments in this period.</p>
        </section>
      </div>

      <section v-if="companyScope&&claimants.length" class="insight-card claimant-card">
        <div class="card-head"><div><span class="ed-eyebrow">ACCOUNTABILITY</span><h3>Claims by person</h3><p>Recorded user attribution stays separate from who ultimately paid.</p></div></div>
        <div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Claimant</th><th>Claims</th><th>Recorded</th><th>Paid</th><th>Outstanding</th></tr></thead><tbody><tr v-for="row in claimants" :key="row.id"><td><strong>{{ row.name }}</strong><small v-if="row.attribution==='imported_unattributed'">Imported / unattributed</small></td><td>{{ row.claimCount }}<small v-if="row.draftCount">{{ row.draftCount }} draft{{ Number(row.draftCount)===1?'':'s' }}</small></td><td>{{ moneySen(row.totalSen) }}<small v-if="row.draftCount">{{ moneySen(row.draftSen) }} not posted</small></td><td>{{ moneySen(row.paidSen) }}</td><td>{{ moneySen(row.outstandingSen) }}</td></tr></tbody></table></div>
      </section>

      <section class="insight-card petty-card">
        <div class="card-head"><div><span class="ed-eyebrow">PETTY CASH</span><h3>Usage and control</h3><p>{{ pettyCash.restricted?'Your claims paid from petty cash are shown without exposing fund balances.':'Fund balances and movement for the selected period.' }}</p></div><strong>{{ moneySen(pettyCash.claimDisbursementSen) }}<small>Claim disbursements</small></strong></div>
        <p v-if="pettyCash.restricted" class="ed-notice">Fund-level balances are available to managers and workspace owners.</p>
        <div v-else-if="pettyCash.funds?.length" class="fund-grid"><article v-for="fund in pettyCash.funds" :key="fund.id"><div><strong>{{ fund.name }}</strong><small>Balance at period end</small></div><b>{{ moneySen(fund.balanceSen) }}</b><dl><div><dt>Replenished</dt><dd>{{ moneySen(fund.replenishmentSen) }}</dd></div><div><dt>Spent</dt><dd>{{ moneySen(fund.disbursementSen) }}</dd></div><div><dt>Adjustments</dt><dd>{{ moneySen(fund.adjustmentSen) }}</dd></div><div><dt>Counts / reversals</dt><dd>{{ moneySen(Number(fund.countSen||0)+Number(fund.reversalSen||0)) }}</dd></div></dl></article></div>
        <p v-else class="empty-copy">No petty-cash activity in this period.</p>
      </section>

      <section v-if="oldestOutstanding.length" class="insight-card outstanding-card">
        <div class="card-head"><div><span class="ed-eyebrow">ACTION QUEUE</span><h3>Oldest outstanding claims</h3><p>Resolve the oldest liabilities first or download a claim pack for review.</p></div></div>
        <div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Expense</th><th v-if="companyScope">Claimant</th><th>Age</th><th>Due</th><th>Outstanding</th><th>Report</th></tr></thead><tbody><tr v-for="row in oldestOutstanding" :key="row.expenseId"><td><strong>{{ row.reference }}</strong><small>{{ row.category }} · {{ row.date }}</small></td><td v-if="companyScope">{{ row.claimantName }}</td><td><span class="ed-pill" :class="{warning:row.ageDays>30,error:row.ageDays>60}">{{ row.ageDays }} days</span></td><td>{{ row.dueDate||'Not set' }}</td><td>{{ moneySen(row.outstandingSen) }}</td><td><button v-if="row.claimReportAvailable!==false" class="ed-btn small" :disabled="claimBusy===row.expenseId" @click="exportClaim(row.expenseId)"><Icon name="download"/>{{ claimBusy===row.expenseId?'Preparing…':'Claim PDF' }}</button><span v-else class="ed-muted">{{ row.recordType==='legacy_transaction'?'Legacy summary only':'Current claim report unavailable' }}</span></td></tr></tbody></table></div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.expense-insights{display:grid;gap:18px}.insights-head,.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.insights-head h2,.card-head h3{margin:3px 0 4px}.insights-head h2{font-size:26px}.insights-head p,.card-head p{margin:0;color:var(--ed-muted)}.insights-toolbar{display:grid;grid-template-columns:minmax(270px,1fr) minmax(130px,.35fr) minmax(130px,.35fr) auto auto;align-items:end;gap:10px;padding:14px;border:1px solid var(--ed-line);border-radius:var(--ed-radius);background:var(--ed-paper)}.insights-presets{display:flex;flex-wrap:wrap;gap:6px;align-self:center}.insights-presets button{border:0;background:transparent;color:var(--ed-muted);padding:8px 10px;border-radius:8px;cursor:pointer}.insights-presets button:hover{background:var(--ed-wash);color:var(--ed-ink)}.grain-picker{margin:0;padding:0;border:0}.grain-picker legend{margin-bottom:5px;color:var(--ed-muted);font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase}.scope-note{display:flex;align-items:center;gap:10px;color:var(--ed-muted)}.insights-loading{padding:36px;border:1px solid var(--ed-line);text-align:center;color:var(--ed-muted)}.insight-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--ed-line);border-radius:var(--ed-radius);overflow:hidden}.insight-kpis article{display:grid;gap:4px;min-height:112px;padding:17px;border-right:1px solid var(--ed-line);border-bottom:1px solid var(--ed-line);background:var(--ed-paper)}.insight-kpis article:nth-child(3n){border-right:0}.insight-kpis article:nth-last-child(-n+3){border-bottom:0}.insight-kpis article.attention{background:color-mix(in srgb,#cf8c27 7%,var(--ed-paper))}.insight-kpis article.danger{background:color-mix(in srgb,var(--ed-error) 7%,var(--ed-paper))}.insight-kpis span,.insight-kpis small{color:var(--ed-muted)}.insight-kpis span{font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase}.insight-kpis strong{font-size:22px;font-weight:620}.insight-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.insight-grid.wide-first{grid-template-columns:minmax(0,1.55fr) minmax(300px,.7fr)}.insight-card{min-width:0;padding:18px;border:1px solid var(--ed-line);border-radius:var(--ed-radius);background:var(--ed-paper)}.card-head{margin-bottom:14px}.card-head>strong{text-align:right;font-size:19px}.card-head>strong small{display:block;color:var(--ed-muted);font-size:10px;font-weight:500}.period-table{min-width:760px}.period-table td{vertical-align:middle}.period-table td small,.claimant-card td small,.outstanding-card td small{display:block;color:var(--ed-muted)}.bar-value{display:grid;gap:5px}.bar-value i,.distribution-amount i{display:block;height:4px;border-radius:99px;background:var(--ed-wash);overflow:hidden}.bar-value i{background:var(--ed-accent)}.distribution-list,.compact-list{display:grid}.distribution-list>div,.compact-list>div{display:grid;grid-template-columns:minmax(0,1fr) minmax(130px,.55fr);align-items:center;gap:14px;padding:12px 0;border-top:1px solid var(--ed-line)}.distribution-list>div:first-child,.compact-list>div:first-child{border-top:0}.distribution-list span,.compact-list span{display:grid;gap:3px}.distribution-list small,.compact-list small{color:var(--ed-muted)}.distribution-amount{text-align:right}.distribution-amount i{margin:6px 0 3px}.distribution-amount i b{display:block;height:100%;border-radius:inherit;background:var(--ed-accent)}.compact-list>div>strong{text-align:right}.empty-copy{margin:0;padding:22px;text-align:center;color:var(--ed-muted);background:var(--ed-wash);border-radius:10px}.fund-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.fund-grid article{display:grid;grid-template-columns:1fr auto;gap:12px;padding:15px;border:1px solid var(--ed-line);border-radius:10px}.fund-grid article>div{display:grid}.fund-grid article small{color:var(--ed-muted)}.fund-grid article>b{font-size:18px}.fund-grid dl{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0;padding-top:10px;border-top:1px solid var(--ed-line)}.fund-grid dl div{display:grid;gap:2px}.fund-grid dt{color:var(--ed-muted);font-size:10px}.fund-grid dd{margin:0}.ed-pill.warning{color:#8a5d13}.ed-pill.error{color:var(--ed-error)}
@media(max-width:1050px){.insights-toolbar{grid-template-columns:1fr 1fr 1fr}.insights-presets{grid-column:1/-1}.insight-grid.wide-first{grid-template-columns:1fr}.insight-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.insight-kpis article:nth-child(3n){border-right:1px solid var(--ed-line)}.insight-kpis article:nth-child(2n){border-right:0}.insight-kpis article:nth-last-child(-n+3){border-bottom:1px solid var(--ed-line)}.insight-kpis article:nth-last-child(-n+2){border-bottom:0}}
@media(max-width:720px){.insights-head,.card-head{align-items:stretch;flex-direction:column}.insights-head .ed-actions{width:100%}.insights-head .ed-actions .ed-btn{flex:1}.insights-toolbar,.insight-grid,.insight-kpis,.fund-grid{grid-template-columns:1fr}.insights-presets{grid-column:auto}.insight-kpis article{border-right:0!important;border-bottom:1px solid var(--ed-line)!important}.insight-kpis article:last-child{border-bottom:0!important}.scope-note{align-items:flex-start;flex-direction:column}.distribution-list>div,.compact-list>div{grid-template-columns:1fr}.distribution-amount,.compact-list>div>strong{text-align:left}.fund-grid dl{grid-template-columns:1fr 1fr}}
</style>
