<script setup>
import { computed, ref, watch } from 'vue';
import { Store } from '../../store';
import { api, companyPath } from '../../services/api';
import { money } from '../../domain/pos';
import {
  forecastPresentation, newReportSchedule, reportDimensions, reportRunLabel,
  reportScheduleDescription, reportSchedulePayload,
} from '../../domain/reportAutomation';

const schedules = ref([]), runs = ref([]), selected = ref(null), form = ref(newReportSchedule());
const loading = ref(false), saving = ref(false), error = ref('');
let request = 0;
const company = computed(() => Store.state.selectedCompany || {});
const owner = computed(() => Store.can('owner'));
const currency = computed(() => company.value.preferences?.currency || 'RM');
const editing = computed(() => Boolean(form.value.id));
const forecast = computed(() => forecastPresentation(selected.value?.result?.forecast?.sales));
const path = suffix => companyPath(Store, suffix);

async function load() {
  const epoch = ++request, companyId = company.value.id;
  if (!companyId || !Store.can('financialReports') || !Store.state.online) return;
  loading.value = true; error.value = '';
  try {
    const [scheduleResult,runResult] = await Promise.all([
      api(path('/report-schedules')),api(path('/report-runs?limit=50')),
    ]);
    if (epoch === request && company.value.id === companyId) {
      schedules.value = scheduleResult.schedules || [];
      runs.value = runResult.runs || [];
    }
  } catch { if (epoch === request) error.value = 'Scheduled reports could not be loaded.'; }
  finally { if (epoch === request) loading.value = false; }
}

function edit(schedule) { form.value = JSON.parse(JSON.stringify(schedule)); }
function reset() { form.value = newReportSchedule(); }
function toggleDimension(value) {
  const set = new Set(form.value.dimensions || []);
  if (set.has(value) && set.size > 1) set.delete(value); else set.add(value);
  form.value.dimensions = [...set];
}
async function save() {
  if (!owner.value || saving.value) return;
  saving.value = true; error.value = '';
  try {
    const suffix = editing.value ? `/report-schedules/${encodeURIComponent(form.value.id)}` : '/report-schedules';
    await api(path(suffix), { method:editing.value?'PUT':'POST',body:reportSchedulePayload(form.value) });
    reset(); await load();
  } catch (failure) { error.value = failure.message || 'The report schedule could not be saved.'; }
  finally { saving.value = false; }
}
async function review(run) {
  error.value = '';
  try { selected.value = await api(path(`/report-runs/${encodeURIComponent(run.id)}`)); }
  catch { error.value = 'The saved report could not be opened.'; }
}
watch(() => [company.value.id,Store.state.currentUser?.role,Store.state.online], () => {
  selected.value = null; reset(); load();
}, { immediate:true });
</script>

<template>
  <section v-if="Store.can('financialReports')" class="report-automation">
    <header class="ed-section-head"><div><div class="ed-eyebrow">AUTOMATED REPORTING</div><h2>Reports waiting when you need them.</h2><p class="ed-muted">Daily, weekly or monthly snapshots stay inside MyFin. Forecasts are advisory and never place stock orders.</p></div><button class="ed-btn" :disabled="loading||!Store.state.online" @click="load">{{ loading?'Loading…':'Refresh' }}</button></header>
    <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
    <div class="report-automation-grid">
      <section>
        <div class="ed-section-head"><div><h3>Schedules</h3><p class="ed-muted">Managers can review. Workspace owners control the schedule.</p></div><button v-if="owner" class="ed-btn small" @click="reset">New schedule</button></div>
        <div v-if="schedules.length" class="schedule-list"><article v-for="schedule in schedules" :key="schedule.id" class="schedule-card"><div><strong>{{ schedule.name }}</strong><small>{{ reportScheduleDescription(schedule) }}</small><small>Next {{ new Date(schedule.nextRunAt).toLocaleString('en-MY',{timeZone:'Asia/Kuala_Lumpur'}) }} · version {{ schedule.version }}</small></div><span class="ed-pill" :class="{ready:schedule.enabled}">{{ schedule.enabled?'Enabled':'Disabled' }}</span><button v-if="owner" class="ed-btn small" @click="edit(schedule)">Edit</button></article></div>
        <p v-else class="ed-muted">No reporting schedules yet.</p>
        <form v-if="owner" class="schedule-form" @submit.prevent="save">
          <h3>{{ editing?'Edit schedule':'New schedule' }}</h3>
          <label class="ed-field"><span>Name</span><input v-model.trim="form.name" maxlength="160" required></label>
          <div class="schedule-fields"><label class="ed-field"><span>Cadence</span><select v-model="form.cadence"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label><label class="ed-field"><span>Run time (MYT)</span><input v-model="form.localTime" type="time" required></label><label v-if="form.cadence==='weekly'" class="ed-field"><span>Weekday</span><select v-model.number="form.weekday" required><option v-for="(day,index) in ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']" :key="day" :value="index+1">{{ day }}</option></select></label><label v-if="form.cadence==='monthly'" class="ed-field"><span>Day of month</span><input v-model.number="form.monthDay" type="number" min="1" max="28" required></label></div>
          <fieldset><legend>Breakdowns in the snapshot</legend><label v-for="dimension in reportDimensions" :key="dimension.value" class="dimension-check"><input type="checkbox" :checked="form.dimensions.includes(dimension.value)" @change="toggleDimension(dimension.value)">{{ dimension.label }}</label></fieldset>
          <div class="schedule-fields"><label class="ed-field"><span>Sales channel filter</span><select v-model="form.filters.channel"><option value="">All channels</option><option value="pos">POS</option><option value="invoice">Invoice</option></select></label><label class="ed-field"><span>Payment method filter</span><input v-model.trim="form.filters.paymentMethod" maxlength="120" placeholder="All payment methods"></label><label class="ed-field"><span>Category filter</span><input v-model.trim="form.filters.category" maxlength="120" placeholder="All categories"></label><label class="ed-field"><span>Subcategory filter</span><input v-model.trim="form.filters.subcategory" maxlength="120" placeholder="All subcategories"></label><label class="ed-field"><span>Forecast history (days)</span><input v-model.number="form.historyDays" type="number" min="28" max="366" required></label><label class="ed-field"><span>Forecast horizon (days)</span><input v-model.number="form.forecastHorizon" type="number" min="1" max="31" required></label></div>
          <label class="dimension-check"><input v-model="form.enabled" type="checkbox">Enable future runs</label>
          <div class="ed-actions"><button class="ed-btn primary" :disabled="saving">{{ saving?'Saving…':editing?'Save schedule':'Create schedule' }}</button><button v-if="editing" class="ed-btn" type="button" @click="reset">Cancel</button></div>
        </form>
      </section>
      <section>
        <h3>Saved reports</h3>
        <div v-if="runs.length" class="run-list"><button v-for="run in runs" :key="run.id" class="run-card" :disabled="run.status!=='completed'" @click="review(run)"><strong>{{ reportRunLabel(run) }}</strong><small>{{ new Date(run.scheduledFor).toLocaleString('en-MY',{timeZone:'Asia/Kuala_Lumpur'}) }} MYT · attempt {{ run.attemptCount }}/{{ run.maxAttempts }}</small></button></div><p v-else class="ed-muted">Completed runs will appear here.</p>
        <article v-if="selected?.result" class="snapshot"><div class="ed-eyebrow">IMMUTABLE SNAPSHOT</div><h3>{{ selected.result.definition.name }}</h3><p class="ed-muted">{{ selected.result.period.from }} to {{ selected.result.period.to }} · generated {{ new Date(selected.result.generatedAt).toLocaleString('en-MY',{timeZone:'Asia/Kuala_Lumpur'}) }} MYT</p><div class="ed-metrics"><div class="ed-metric"><label>Sales</label><strong>{{ money(selected.result.totals.sales,currency) }}</strong></div><div class="ed-metric"><label>Cash flow</label><strong>{{ money(selected.result.totals.cashFlow,currency) }}</strong></div><div class="ed-metric"><label>Expenses</label><strong>{{ money(selected.result.totals.expenses,currency) }}</strong></div><div class="ed-metric"><label>Transactions</label><strong>{{ selected.result.counts.sales }}</strong></div></div><div class="forecast"><strong>{{ forecast.title }}</strong><p>{{ forecast.detail }}</p><div v-if="forecast.ready" class="forecast-points"><span v-for="point in forecast.points.slice(0,7)" :key="point.date"><small>{{ point.date }}</small><strong>{{ money(point.value,currency) }}</strong><small>{{ money(point.lower,currency) }}–{{ money(point.upper,currency) }}</small></span></div><p class="ed-muted">Advisory weekday baseline. Promotions, closures, stock-outs and external events are not modeled.</p></div></article>
      </section>
    </div>
  </section>
</template>

<style scoped>
.report-automation{margin-top:42px;border-top:1px solid var(--ed-line);padding-top:32px}.report-automation-grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(320px,.9fr);gap:32px}.schedule-list,.run-list{display:grid;gap:10px}.schedule-card{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:12px;border:1px solid var(--ed-line);padding:14px;background:var(--ed-paper)}.schedule-card div,.run-card{display:grid;gap:4px}.schedule-card small,.run-card small{color:var(--ed-muted)}.schedule-form,.snapshot{border:1px solid var(--ed-line);padding:20px;margin-top:20px;background:var(--ed-paper)}.schedule-form{display:grid;gap:16px}.schedule-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.schedule-form fieldset{border:0;padding:0;margin:0}.schedule-form legend{font-size:12px;margin-bottom:8px}.dimension-check{display:inline-flex;align-items:center;gap:7px;margin:0 14px 8px 0;font-size:13px}.run-card{width:100%;text-align:left;border:1px solid var(--ed-line);background:var(--ed-paper);padding:14px;cursor:pointer}.run-card:disabled{cursor:default;opacity:.68}.snapshot .ed-metrics{grid-template-columns:repeat(2,1fr)}.forecast{border-top:1px solid var(--ed-line);margin-top:18px;padding-top:18px}.forecast-points{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.forecast-points span{display:grid;border:1px solid var(--ed-line);padding:9px}.forecast-points small{color:var(--ed-muted)}@media(max-width:900px){.report-automation-grid{grid-template-columns:1fr}.schedule-fields{grid-template-columns:1fr}}@media(max-width:560px){.schedule-card{grid-template-columns:1fr}.snapshot .ed-metrics{grid-template-columns:1fr}}
</style>
