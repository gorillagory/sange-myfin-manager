<script setup>
import { computed, ref, watch } from 'vue';
import { Store } from '../../store';
import { api, companyPath } from '../../services/api';
import {
  advancedAnalyticsQuery, basisPointPercent, cohortPresentation, costCoveragePresentation,
  formatMilliQuantity, formatSen,
} from '../../domain/advancedAnalytics';

const props = defineProps({ from:{type:String,required:true},to:{type:String,required:true} });
const operations = ref(null), costs = ref(null), loading = ref(false), error = ref('');
let generation = 0;
const company = computed(() => Store.state.selectedCompany || {});
const currency = computed(() => company.value.preferences?.currency || 'RM');
const owner = computed(() => Store.can('costsRead'));
const costCoverage = computed(() => costCoveragePresentation(costs.value || {}));
const studentEnrollment = computed(() => cohortPresentation(operations.value?.student?.enrollment));
const studentActivity = computed(() => cohortPresentation(operations.value?.student?.activity));
const statusRows = computed(() => Object.entries(operations.value?.orders?.statuses || {}).map(([key,value]) => ({
  key,label:key.replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase()),value,
})));

async function load() {
  const epoch = ++generation, companyId = company.value.id;
  if (!companyId || !Store.can('financialReports') || !Store.state.online) return;
  loading.value = true; error.value = '';
  try {
    const query = advancedAnalyticsQuery(props.from,props.to).toString();
    const requests = [api(companyPath(Store,`/analytics/operations?${query}`))];
    if (owner.value) requests.push(api(companyPath(Store,`/analytics/cost-performance?${query}`)));
    const [nextOperations,nextCosts] = await Promise.all(requests);
    if (epoch === generation && company.value.id === companyId) {
      operations.value = nextOperations; costs.value = owner.value ? nextCosts : null;
    }
  } catch (failure) {
    if (epoch === generation) error.value = failure.message || 'Advanced analytics could not be loaded.';
  } finally { if (epoch === generation) loading.value = false; }
}

watch(() => [company.value.id,Store.state.currentUser?.role,Store.state.online,props.from,props.to], () => {
  operations.value = null; costs.value = null; load();
}, { immediate:true });
</script>

<template>
  <section v-if="Store.can('financialReports')" class="advanced-analytics">
    <header class="ed-section-head"><div><div class="ed-eyebrow">ADVANCED ANALYTICS</div><h2>Orders, customers, stock and product movement.</h2><p class="ed-muted">Aggregate operating signals for {{ from }} to {{ to }}. Customer identities and contact details are never included.</p></div><button class="ed-btn" :disabled="loading||!Store.state.online" @click="load">{{ loading?'Loading…':'Refresh analytics' }}</button></header>
    <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
    <p v-if="loading&&!operations" class="ed-notice" role="status">Loading operating analytics…</p>
    <template v-if="operations">
      <div class="ed-metrics advanced-metrics"><div class="ed-metric"><label>Online orders</label><strong>{{ operations.orders.total }}</strong></div><div class="ed-metric"><label>Paid orders</label><strong>{{ operations.orders.statuses.paid }}</strong></div><div class="ed-metric"><label>Submitted demand</label><strong>{{ formatSen(operations.orders.submittedDemandValueSen??operations.orders.orderValueSen,currency) }}</strong></div><div class="ed-metric"><label>Paid order value</label><strong>{{ formatSen(operations.orders.paidOrderValueSen??operations.orders.orderValueSen,currency) }}</strong></div><div class="ed-metric"><label>Guest orders</label><strong>{{ operations.customers.guestOrders }}</strong></div><div class="ed-metric"><label>Repeat account customers</label><strong>{{ operations.customers.repeatCustomers }}</strong><small>{{ basisPointPercent(operations.customers.repeatRateBasisPoints) }} of account customers</small></div><div class="ed-metric"><label>Open low-stock alerts</label><strong>{{ operations.inventory.lowStock.open }}</strong></div></div>

      <div class="advanced-grid">
        <article class="analytics-card"><h3>Online order flow</h3><div class="status-grid"><span v-for="status in statusRows" :key="status.key"><small>{{ status.label }}</small><strong>{{ status.value }}</strong></span></div><p class="ed-muted">Average acceptance: {{ operations.orders.averageAcceptanceMinutes===null?'No accepted orders':`${operations.orders.averageAcceptanceMinutes} minutes` }} · submitted average {{ formatSen(operations.orders.submittedAverageOrderSen??operations.orders.averageOrderSen,currency) }} · paid average {{ formatSen(operations.orders.paidAverageOrderSen??operations.orders.averageOrderSen,currency) }}</p><small class="ed-muted">{{ operations.coverage.orders }}</small></article>
        <article class="analytics-card"><h3>Student participation</h3><p><strong>Verified enrollment:</strong> {{ studentEnrollment.label }}</p><p><strong>Purchasing activity:</strong> {{ studentActivity.label }}</p><template v-if="studentActivity.available"><p>{{ operations.student.activity.pricedOrderCount }} priced orders · {{ formatSen(operations.student.activity.discountSen,currency) }} discount · {{ operations.student.activity.redemptionCount }} redemptions</p></template><p class="ed-muted">Small cohorts are hidden to protect student privacy.</p></article>
      </div>

      <section class="analytics-section"><div class="ed-section-head"><div><h3>Product performance</h3><p class="ed-muted">Gross line value before document-level discounts, tax and counter rounding.</p></div></div><div v-if="operations.productPerformance.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Product</th><th>Quantity</th><th>Sales</th><th>Receipts / invoices</th></tr></thead><tbody><tr v-for="product in operations.productPerformance" :key="product.productId||product.sku||product.description"><td>{{ product.description }}<small v-if="product.sku" class="analytics-subline">{{ product.sku }}</small></td><td>{{ formatMilliQuantity(product.quantityMilli) }}</td><td>{{ formatSen(product.grossLineSalesSen,currency) }}</td><td>{{ product.saleCount }}</td></tr></tbody></table></div><p v-else class="ed-muted">No issued sale lines in this range.</p><small class="ed-muted">{{ operations.coverage.products }}</small></section>

      <section class="analytics-section"><div class="ed-section-head"><div><h3>Stock activity</h3><p class="ed-muted">{{ operations.inventory.basis }}</p></div></div><div class="inventory-summary"><span><small>Movements</small><strong>{{ operations.inventory.movementCount }}</strong></span><span><small>Waste entries</small><strong>{{ operations.inventory.movementsByKind.waste }}</strong></span><span><small>Procurement receipts</small><strong>{{ operations.inventory.procurementReceipts }}</strong></span><span><small>Reversed receipts</small><strong>{{ operations.inventory.reversedProcurementReceipts }}</strong></span></div><div class="advanced-grid"><article class="analytics-card"><h4>Most wasted</h4><div v-if="operations.inventory.wasteItems.length" class="item-list"><span v-for="item in operations.inventory.wasteItems" :key="item.itemId"><strong>{{ item.name }}</strong><small>{{ item.quantity }} {{ item.baseUnit }} · {{ item.movements }} entries</small></span></div><p v-else class="ed-muted">No waste recorded.</p></article><article class="analytics-card"><h4>Most received</h4><div v-if="operations.inventory.receivedItems.length" class="item-list"><span v-for="item in operations.inventory.receivedItems" :key="item.itemId"><strong>{{ item.name }}</strong><small>{{ item.quantity }} {{ item.baseUnit }} · {{ item.movements }} entries</small></span></div><p v-else class="ed-muted">No stock receipts recorded.</p></article></div></section>

      <section v-if="owner&&costs" class="analytics-section owner-costs"><div class="ed-section-head"><div><div class="ed-eyebrow">OWNER COST VIEW</div><h3>Recognized margin coverage</h3><p class="ed-muted">{{ costs.accountingBasis }}</p></div><span class="ed-pill" :class="{ready:costCoverage.complete}">{{ costCoverage.percentage }} covered</span></div><div class="ed-metrics advanced-metrics"><div class="ed-metric"><label>Net sales</label><strong>{{ formatSen(costs.netSalesSen,currency) }}</strong></div><div class="ed-metric"><label>Recognized COGS</label><strong>{{ formatSen(costs.recognizedCogsSen,currency) }}</strong></div><div class="ed-metric"><label>Margin on costed lines</label><strong>{{ formatSen(costs.recognizedGrossMarginSen,currency) }}</strong></div><div class="ed-metric"><label>Recorded expenses</label><strong>{{ formatSen(costs.operatingExpensesSen,currency) }}</strong></div><div class="ed-metric"><label>Complete gross margin</label><strong>{{ costs.grossMarginSen===null?'Unavailable':formatSen(costs.grossMarginSen,currency) }}</strong></div><div class="ed-metric"><label>Operating contribution</label><strong>{{ costs.operatingContributionSen===null?'Unavailable':formatSen(costs.operatingContributionSen,currency) }}</strong></div></div><p class="ed-notice" :class="{warning:!costCoverage.complete}"><strong>{{ costCoverage.title }}.</strong> {{ costs.limitation }}</p></section>
    </template>
  </section>
</template>

<style scoped>
.advanced-analytics{margin-top:42px;border-top:1px solid var(--ed-line);padding-top:32px}.advanced-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.ed-metric small,.analytics-subline{display:block;margin-top:4px;color:var(--ed-muted)}.advanced-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:20px 0}.analytics-card{border:1px solid var(--ed-line);padding:18px;background:var(--ed-paper);min-width:0}.analytics-card h3,.analytics-card h4{margin:0 0 14px}.status-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.status-grid span,.inventory-summary span{display:grid;gap:4px;padding:10px;border:1px solid var(--ed-line)}.status-grid small,.inventory-summary small{color:var(--ed-muted)}.analytics-section{margin-top:30px}.inventory-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.item-list{display:grid}.item-list span{display:grid;gap:3px;padding:9px 0;border-top:1px solid var(--ed-line)}.item-list small{color:var(--ed-muted)}.owner-costs{border-top:1px solid var(--ed-line);padding-top:28px}@media(max-width:900px){.advanced-metrics,.inventory-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.advanced-grid{grid-template-columns:1fr}.status-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.advanced-metrics,.inventory-summary{grid-template-columns:1fr}}
</style>
