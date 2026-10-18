<script setup>
import { computed, ref, watch } from 'vue';
import { Store } from '../../store';
import { api, companyPath } from '../../services/api';
import {
  advancedAnalyticsQuery, analyticsErrorMessage, basisPointPercent, changePresentation, cohortPresentation,
  costCoveragePresentation, formatMilliQuantity, formatSen, ratioPercent,
} from '../../domain/advancedAnalytics';

const props = defineProps({
  from:{type:String,required:true},
  to:{type:String,required:true},
  view:{type:String,default:''},
  embedded:{type:Boolean,default:false},
});
const emit = defineEmits(['busy']);
const operations = ref(null), costs = ref(null), loading = ref(false), error = ref('');
const localView=ref('overview');
const views=[
  {id:'overview',label:'Business overview'},
  {id:'products',label:'Products & categories'},
  {id:'inventory',label:'Inventory health'},
  {id:'customers',label:'Online & customers'},
];
const activeView=computed(()=>views.some(item=>item.id===props.view)?props.view:localView.value);
let generation = 0;
const company = computed(() => Store.state.selectedCompany || {});
const currency = computed(() => company.value.preferences?.currency || 'RM');
const owner = computed(() => Store.can('costsRead'));
const costCoverage = computed(() => costCoveragePresentation(costs.value || {}));
const sales = computed(() => operations.value?.salesPerformance?.current || {});
const changes = computed(() => operations.value?.salesPerformance?.change || {});
const studentEnrollment = computed(() => cohortPresentation(operations.value?.student?.enrollment));
const studentActivity = computed(() => cohortPresentation(operations.value?.student?.activity));
const statusRows = computed(() => Object.entries(operations.value?.orders?.statuses || {}).map(([key,value]) => ({
  key,label:key.replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase()),value,
})));
const dailyPerformance=computed(()=>sales.value.dailyPerformance||[]);
const hasDailyActivity=computed(()=>dailyPerformance.value.some(day=>Number(day.salesCount)>0));
const trendMaximum=computed(()=>dailyPerformance.value.reduce((max,row)=>{
  let value=0n;try{value=BigInt(row.netSalesSen||0);}catch{/* Invalid server data is rendered as zero. */}
  value=value<0n?-value:value;return value>max?value:max;
},0n));
const inventory=computed(()=>operations.value?.inventory||{});
const stockAttention=computed(()=>[
  {label:'Out of stock',value:inventory.value.outOfStockItems||0,tone:'danger'},
  {label:'At or below reorder',value:inventory.value.belowReorderItems||0,tone:'warning'},
  {label:'No movement in period',value:inventory.value.noMovementItems||0,tone:'neutral'},
]);

function trendHeight(value) {
  let amount=0n;try{amount=BigInt(value||0);}catch{/* Render malformed values at the baseline. */}
  amount=amount<0n?-amount:amount;
  if (!amount || !trendMaximum.value) return '0%';
  return `${12+Number(amount*88n/trendMaximum.value)}%`;
}
function amountTone(value) {
  let amount=0n;try{amount=BigInt(value||0);}catch{/* Invalid server data is neutral. */}
  return amount<0n?'negative':amount>0n?'positive':'zero';
}
function shortDay(value) {
  const date=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime())?date.toLocaleDateString('en-MY',{day:'numeric',month:'short',timeZone:'UTC'}):value;
}
function changeFor(key){return changePresentation(changes.value[key]);}
function selectView(view){if(views.some(item=>item.id===view))localView.value=view;}

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
    if (epoch === generation) error.value = analyticsErrorMessage(failure);
  } finally { if (epoch === generation) loading.value = false; }
}

watch(loading, value => emit('busy', value), { immediate:true });
watch(() => [company.value.id,Store.state.currentUser?.role,Store.state.online,props.from,props.to], () => {
  operations.value = null; costs.value = null; load();
}, { immediate:true });
defineExpose({ refresh:load });
</script>

<template>
  <section v-if="Store.can('financialReports')" class="business-analytics" :class="{embedded}">
    <header v-if="!embedded" class="analytics-heading">
      <div><div class="ed-eyebrow">BUSINESS ANALYTICS</div><h2>See what is selling, what needs attention, and where money is moving.</h2><p class="ed-muted">{{ from }} to {{ to }} · compared with the immediately preceding period of the same length.</p></div>
      <button class="ed-btn" :disabled="loading||!Store.state.online" @click="load">{{ loading?'Refreshing…':'Refresh' }}</button>
    </header>
    <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
    <p v-if="loading&&!operations" class="ed-notice" role="status">Building your business view…</p>
    <template v-if="operations">
      <nav v-if="!embedded" class="analytics-nav" aria-label="Analytics views">
        <button v-for="item in views" :key="item.id" :class="{active:activeView===item.id}" :aria-current="activeView===item.id?'page':undefined" @click="selectView(item.id)">{{ item.label }}</button>
      </nav>

      <section v-if="activeView==='overview'" class="analytics-view">
        <div v-if="!embedded" class="performance-grid">
          <article><span>Recorded sales</span><strong>{{ formatSen(sales.salesSen,currency) }}</strong><small :class="`trend ${changeFor('salesBasisPoints').tone}`">{{ changeFor('salesBasisPoints').label }}</small></article>
          <article><span>Transactions</span><strong>{{ sales.salesCount||0 }}</strong><small :class="`trend ${changeFor('transactionBasisPoints').tone}`">{{ changeFor('transactionBasisPoints').label }}</small></article>
          <article><span>Average sale</span><strong>{{ formatSen(sales.averageSaleSen,currency) }}</strong><small>Across recorded POS and invoices</small></article>
          <article><span>Items sold</span><strong>{{ formatMilliQuantity(sales.unitsSoldMilli) }}</strong><small :class="`trend ${changeFor('unitsBasisPoints').tone}`">{{ changeFor('unitsBasisPoints').label }}</small></article>
        </div>

        <div class="overview-grid">
          <article class="analytics-card sales-trend-card">
            <div class="card-heading"><div><span class="card-kicker">SALES PERFORMANCE</span><h3>Daily recorded sales</h3></div><strong>{{ formatSen(sales.netSalesSen,currency) }} <small>after tax</small></strong></div>
            <p v-if="!hasDailyActivity" class="ed-muted">No recorded sales in this period. The selected dates remain visible as a zero baseline.</p>
            <div v-if="dailyPerformance.length" class="trend-scroll"><div class="trend-bars" :style="{gridTemplateColumns:`repeat(${dailyPerformance.length},minmax(30px,1fr))`}">
              <div v-for="day in dailyPerformance" :key="day.date" :class="['trend-column',amountTone(day.netSalesSen)]" role="img" :aria-label="`${day.date}: ${formatSen(day.netSalesSen,currency)} after tax from ${day.salesCount} transactions`" :title="`${day.date}: ${formatSen(day.netSalesSen,currency)} after tax from ${day.salesCount} transactions`"><span>{{ formatSen(day.netSalesSen,currency) }}</span><i :style="{height:trendHeight(day.netSalesSen)}"></i><small>{{ shortDay(day.date) }}</small></div>
            </div></div>
          </article>

          <aside class="analytics-card attention-card"><span class="card-kicker">OWNER ATTENTION</span><h3>What needs a decision</h3><div class="attention-list"><div v-for="item in stockAttention" :key="item.label"><span :class="`attention-dot ${item.tone}`"></span><p><strong>{{ item.value }}</strong>{{ item.label }}</p></div><div><span class="attention-dot neutral"></span><p><strong>{{ operations.orders.statuses.submitted||0 }}</strong>Online orders awaiting acceptance</p></div></div></aside>
        </div>

        <section v-if="owner&&costs" class="owner-performance">
          <div class="card-heading"><div><span class="card-kicker">OWNER FINANCIAL VIEW</span><h3>Margin and operating contribution</h3></div><span class="coverage-pill" :class="{ready:costCoverage.complete}">{{ costCoverage.percentage }} cost coverage</span></div>
          <div class="owner-metrics"><div><span>Net sales</span><strong>{{ formatSen(costs.netSalesSen,currency) }}</strong></div><div><span>Recognized COGS</span><strong>{{ formatSen(costs.recognizedCogsSen,currency) }}</strong></div><div><span>Recorded expenses</span><strong>{{ formatSen(costs.operatingExpensesSen,currency) }}</strong></div><div><span>Operating contribution</span><strong>{{ costs.operatingContributionSen===null?'Unavailable':formatSen(costs.operatingContributionSen,currency) }}</strong></div></div>
          <p class="coverage-note" :class="{warning:!costCoverage.complete}"><strong>{{ costCoverage.title }}.</strong> {{ costs.limitation }}</p>
        </section>
      </section>

      <section v-else-if="activeView==='products'" class="analytics-view">
        <div class="view-heading"><div><span class="card-kicker">ITEM PERFORMANCE</span><component :is="embedded?'h2':'h3'">Your strongest products and categories</component><p>Product revenue is shown after discounts and excludes tax, delivery fees, and cash rounding. Returns reduce net revenue and are excluded from positive-net share. This is revenue contribution, not profit.</p></div><div class="headline-stat"><span>Products sold</span><strong>{{ sales.distinctProductCount||0 }}</strong></div></div>
        <div v-if="operations.productPerformance?.length" class="ed-table-wrap analytics-table-wrap"><table class="ed-table analytics-table"><thead><tr><th>Rank</th><th>Product</th><th>Units</th><th>Gross lines</th><th>Allocated net sales</th><th>Positive net share</th><th>Transactions</th></tr></thead><tbody><tr v-for="product in operations.productPerformance" :key="product.productId||product.sku||product.description"><td class="rank-cell">{{ product.rank }}</td><td><strong>{{ product.description }}</strong><small class="analytics-subline">{{ [product.category,product.subcategory,product.sku].filter(Boolean).join(' · ') }}</small></td><td>{{ formatMilliQuantity(product.quantityMilli) }}</td><td>{{ formatSen(product.grossLineSalesSen,currency) }}</td><td>{{ formatSen(product.netLineSalesSen,currency) }}</td><td><span v-if="product.contributionType==='return'" class="return-label">Net refund</span><template v-else><span class="share-bar"><i :style="{width:basisPointPercent(product.shareBasisPoints)}"></i></span>{{ basisPointPercent(product.shareBasisPoints) }}</template></td><td>{{ product.saleCount }}</td></tr></tbody></table></div><p v-else class="empty-copy">No issued sale lines in this period.</p>
        <div class="category-grid"><article v-for="category in operations.categoryPerformance||[]" :key="`${category.category}/${category.subcategory}`" class="analytics-card category-card"><span>{{ category.category }}</span><h4>{{ category.subcategory||'All items' }}</h4><strong :class="amountTone(category.netLineSalesSen)">{{ formatSen(category.netLineSalesSen,currency) }}</strong><small>{{ formatMilliQuantity(category.quantityMilli) }} units · {{ category.saleCount }} transactions</small></article></div>
        <p class="method-note">{{ operations.coverage.products }}</p>
      </section>

      <section v-else-if="activeView==='inventory'" class="analytics-view">
        <div class="view-heading"><div><span class="card-kicker">INVENTORY HEALTH</span><component :is="embedded?'h2':'h3'">Availability, movement, and replenishment</component><p>{{ inventory.basis }}</p></div><div class="headline-stat"><span>Active stock items</span><strong>{{ inventory.activeItems||0 }}</strong></div></div>
        <div class="inventory-scope"><span><strong>Current balance</strong> availability and reorder status</span><span><strong>Selected period</strong> movements, consumption, and waste</span></div>
        <div class="performance-grid inventory-kpis"><article><span>Out of stock</span><strong>{{ inventory.outOfStockItems||0 }}</strong><small>Current balance is zero</small></article><article><span>At or below reorder</span><strong>{{ inventory.belowReorderItems||0 }}</strong><small>{{ ratioPercent(inventory.belowReorderItems,inventory.activeItems) }} of active items</small></article><article><span>Stock movements</span><strong>{{ inventory.movementCount||0 }}</strong><small>{{ inventory.movementsByKind?.consume||0 }} recipe deductions</small></article><article><span>Count checks</span><strong>{{ inventory.movementsByKind?.count||0 }}</strong><small>{{ inventory.noMovementItems||0 }} items had no movement</small></article></div>
        <div v-if="inventory.attentionItems?.length" class="analytics-card stock-attention"><div class="card-heading"><div><span class="card-kicker">REPLENISHMENT LIST</span><h3>Stock requiring attention</h3></div><small>{{ inventory.attentionItems.length }} shown</small></div><div class="stock-attention-grid"><div v-for="item in inventory.attentionItems" :key="item.itemId"><span>{{ item.category||'General' }}</span><strong>{{ item.name }}</strong><p>{{ item.onHand }} {{ item.baseUnit }} on hand</p><small>Reorder at {{ item.reorderLevel }} {{ item.baseUnit }}</small></div></div></div>
        <div class="movement-grid"><article class="analytics-card"><h3>Most consumed</h3><div v-if="inventory.consumedItems?.length" class="item-list"><span v-for="item in inventory.consumedItems" :key="`${item.itemId}/${item.baseUnit}`"><strong>{{ item.name }}</strong><small>{{ item.quantity }} {{ item.baseUnit }} · {{ item.movements }} movements</small></span></div><p v-else class="ed-muted">No recipe consumption recorded.</p></article><article class="analytics-card"><h3>Most wasted</h3><div v-if="inventory.wasteItems?.length" class="item-list"><span v-for="item in inventory.wasteItems" :key="`${item.itemId}/${item.baseUnit}`"><strong>{{ item.name }}</strong><small>{{ item.quantity }} {{ item.baseUnit }} · {{ item.movements }} entries</small></span></div><p v-else class="ed-muted">No waste recorded.</p></article><article class="analytics-card"><h3>Most received</h3><div v-if="inventory.receivedItems?.length" class="item-list"><span v-for="item in inventory.receivedItems" :key="`${item.itemId}/${item.baseUnit}`"><strong>{{ item.name }}</strong><small>{{ item.quantity }} {{ item.baseUnit }} · {{ item.movements }} entries</small></span></div><p v-else class="ed-muted">No stock receipts recorded.</p></article></div>
        <article v-if="owner&&costs?.inventoryValue" class="valuation-card"><div><span class="card-kicker">CURRENT INVENTORY VALUE</span><strong>{{ formatSen(costs.inventoryValue.inventoryValueSen,currency) }}</strong><p>{{ costs.inventoryValue.basis }}</p></div><div class="valuation-coverage"><strong>{{ basisPointPercent(costs.inventoryValue.coverageBasisPoints) }}</strong><span>cost coverage</span><small>{{ costs.inventoryValue.costedItems }} of {{ costs.inventoryValue.activeItems }} active items</small></div></article>
      </section>

      <section v-else class="analytics-view">
        <div class="view-heading"><div><span class="card-kicker">ONLINE & CUSTOMERS</span><component :is="embedded?'h2':'h3'">Ordering flow and customer return</component><p>Customer names, contact details, and identities are excluded from this view.</p></div><div class="headline-stat"><span>Online demand</span><strong>{{ formatSen(operations.orders.submittedDemandValueSen??operations.orders.orderValueSen,currency) }}</strong></div></div>
        <div class="performance-grid"><article><span>Online orders</span><strong>{{ operations.orders.total }}</strong><small>{{ operations.customers.guestOrders }} guest orders</small></article><article><span>Paid order value</span><strong>{{ formatSen(operations.orders.paidOrderValueSen??operations.orders.orderValueSen,currency) }}</strong><small>{{ operations.orders.statuses.paid }} paid orders</small></article><article><span>Average paid order</span><strong>{{ formatSen(operations.orders.paidAverageOrderSen??operations.orders.averageOrderSen,currency) }}</strong><small>Paid online orders only</small></article><article><span>Repeat customers</span><strong>{{ operations.customers.repeatCustomers }}</strong><small>{{ basisPointPercent(operations.customers.repeatRateBasisPoints) }} of account customers</small></article></div>
        <div class="movement-grid customer-grid"><article class="analytics-card order-flow"><h3>Order pipeline</h3><div class="status-grid"><span v-for="status in statusRows" :key="status.key"><small>{{ status.label }}</small><strong>{{ status.value }}</strong></span></div><p>Average acceptance: {{ operations.orders.averageAcceptanceMinutes===null?'No accepted orders':`${operations.orders.averageAcceptanceMinutes} minutes` }}</p></article><article class="analytics-card"><h3>Verified customer programmes</h3><p><strong>Verified enrollment:</strong> {{ studentEnrollment.label }}</p><p><strong>Purchasing activity:</strong> {{ studentActivity.label }}</p><template v-if="studentActivity.available"><p>{{ operations.student.activity.pricedOrderCount }} eligible orders · {{ formatSen(operations.student.activity.discountSen,currency) }} discount · {{ operations.student.activity.redemptionCount }} redemptions</p></template><small>Small cohorts are hidden to protect customer privacy.</small></article></div>
        <p class="method-note">{{ operations.coverage.orders }}</p>
      </section>
    </template>
  </section>
</template>

<style scoped>
.business-analytics{margin-top:42px;border-top:1px solid var(--ed-line);padding-top:34px}.business-analytics.embedded{margin-top:0;border-top:0;padding-top:0}.analytics-heading,.view-heading,.card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}.analytics-heading h2{max-width:780px;margin:7px 0 8px;font-size:clamp(24px,3vw,38px);letter-spacing:-.035em}.analytics-nav{display:flex;gap:4px;margin:26px 0 24px;padding:4px;border:1px solid var(--ed-line);background:color-mix(in srgb,var(--ed-paper) 84%,var(--ed-wash));width:max-content;max-width:100%;overflow-x:auto}.analytics-nav button{appearance:none;border:0;background:transparent;padding:10px 14px;color:var(--ed-muted);font:600 12px var(--ed-font-sans);white-space:nowrap;cursor:pointer}.analytics-nav button.active{background:var(--ed-ink);color:var(--ed-paper)}.analytics-view{display:grid;gap:22px}.performance-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--ed-line);background:var(--ed-paper)}.performance-grid article{display:grid;align-content:start;gap:7px;min-height:126px;padding:20px;border-right:1px solid var(--ed-line)}.performance-grid article:last-child{border-right:0}.performance-grid span,.headline-stat span,.owner-metrics span{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--ed-muted)}.performance-grid strong{font-size:clamp(22px,2.5vw,32px);letter-spacing:-.04em}.performance-grid small{color:var(--ed-muted);line-height:1.35}.trend.positive{color:#167447}.trend.negative{color:#a63b2b}.overview-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:16px}.analytics-card{min-width:0;border:1px solid var(--ed-line);padding:20px;background:var(--ed-paper)}.card-kicker{display:block;font-size:9px;font-weight:700;letter-spacing:.12em;color:var(--ed-muted)}.analytics-card h3,.view-heading :is(h2,h3),.owner-performance h3{margin:5px 0 8px;font-size:20px;letter-spacing:-.02em}.card-heading>strong{font-size:20px;text-align:right}.card-heading>strong small{display:block;font-size:10px;font-weight:500;color:var(--ed-muted)}.trend-scroll{overflow-x:auto;padding:12px 0 2px}.trend-bars{display:grid;align-items:end;gap:7px;height:205px;min-width:520px}.trend-column{height:100%;display:grid;grid-template-rows:32px 1fr 24px;align-items:end;text-align:center}.trend-column>span{overflow:hidden;color:transparent;font-size:8px}.trend-column:hover>span{color:var(--ed-muted)}.trend-column i{display:block;min-height:8px;background:var(--ed-accent);opacity:.82}.trend-column small{align-self:end;padding-top:6px;color:var(--ed-muted);font-size:9px;white-space:nowrap}.attention-list{display:grid;margin-top:13px}.attention-list>div{display:grid;grid-template-columns:9px 1fr;gap:11px;align-items:center;padding:13px 0;border-top:1px solid var(--ed-line)}.attention-list p{display:flex;align-items:baseline;gap:9px;margin:0;color:var(--ed-muted)}.attention-list p strong{font-size:22px;color:var(--ed-ink)}.attention-dot{width:8px;height:8px;border-radius:50%;background:#8c9690}.attention-dot.danger{background:#b74835}.attention-dot.warning{background:#c28a22}.owner-performance{border:1px solid var(--ed-line);padding:22px;background:color-mix(in srgb,var(--ed-paper) 88%,var(--ed-accent) 12%)}.coverage-pill{padding:7px 10px;border:1px solid currentColor;color:#9a6c1b;font-size:10px;font-weight:700}.coverage-pill.ready{color:#167447}.owner-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:19px;border-top:1px solid var(--ed-line);border-left:1px solid var(--ed-line)}.owner-metrics>div{display:grid;gap:7px;padding:16px;border-right:1px solid var(--ed-line);border-bottom:1px solid var(--ed-line)}.owner-metrics strong{font-size:20px}.coverage-note{margin:14px 0 0;color:var(--ed-muted);font-size:11px}.coverage-note.warning{color:#8a5d13}.view-heading{padding:4px 0 2px}.view-heading :is(h2,h3){font-size:27px}.view-heading p{max-width:700px;margin:0;color:var(--ed-muted)}.headline-stat{min-width:170px;display:grid;gap:4px;text-align:right}.headline-stat strong{font-size:28px}.analytics-table-wrap{border:1px solid var(--ed-line)}.analytics-table{min-width:880px}.analytics-table td{vertical-align:middle}.analytics-table td strong{font-weight:650}.analytics-subline{display:block;margin-top:4px;color:var(--ed-muted);font-size:9px}.rank-cell{font-weight:700;color:var(--ed-muted)}.share-bar{display:inline-block;width:52px;height:5px;margin-right:8px;background:var(--ed-wash);vertical-align:middle}.share-bar i{display:block;height:100%;background:var(--ed-accent)}.category-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.category-card{display:grid;gap:4px}.category-card>span{font-size:9px;text-transform:uppercase;color:var(--ed-muted)}.category-card h4{margin:0}.category-card>strong{font-size:22px;margin-top:9px}.category-card small,.method-note{color:var(--ed-muted)}.method-note{margin:0;font-size:10px}.inventory-kpis{margin-bottom:0}.stock-attention-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;border-top:1px solid var(--ed-line);border-left:1px solid var(--ed-line);margin-top:16px}.stock-attention-grid>div{display:grid;gap:3px;padding:15px;border-right:1px solid var(--ed-line);border-bottom:1px solid var(--ed-line)}.stock-attention-grid span,.stock-attention-grid small{color:var(--ed-muted);font-size:9px}.stock-attention-grid p{margin:6px 0 0}.movement-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.item-list{display:grid}.item-list>span{display:grid;gap:3px;padding:11px 0;border-top:1px solid var(--ed-line)}.item-list small,.customer-grid small{color:var(--ed-muted)}.valuation-card{display:grid;grid-template-columns:1fr auto;gap:32px;align-items:center;padding:24px;border:1px solid var(--ed-line);background:var(--ed-ink);color:var(--ed-paper)}.valuation-card>div:first-child>strong{display:block;font-size:34px;margin:8px 0}.valuation-card p{max-width:650px;margin:0;color:color-mix(in srgb,var(--ed-paper) 70%,transparent);font-size:10px}.valuation-coverage{display:grid;min-width:150px;text-align:right}.valuation-coverage strong{font-size:27px}.valuation-coverage span,.valuation-coverage small{color:color-mix(in srgb,var(--ed-paper) 70%,transparent)}.customer-grid{grid-template-columns:1.6fr 1fr}.status-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-top:16px}.status-grid span{display:grid;gap:4px;padding:10px;border:1px solid var(--ed-line)}.status-grid small{color:var(--ed-muted)}.status-grid strong{font-size:19px}.order-flow>p{margin-bottom:0;color:var(--ed-muted)}.empty-copy{padding:28px;border:1px solid var(--ed-line);color:var(--ed-muted)}
.trend-column.negative i{background:#a63b2b}.trend-column.zero i{min-height:0;background:transparent}.return-label,.category-card>strong.negative{color:#a63b2b}.return-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
.business-analytics.embedded :is(.performance-grid,.analytics-card,.owner-performance,.analytics-table-wrap,.valuation-card,.empty-copy){overflow:hidden;border-radius:14px}.business-analytics.embedded .category-card{border-radius:12px}.business-analytics.embedded :is(.card-kicker,.analytics-subline,.category-card>span,.method-note,.stock-attention-grid span,.stock-attention-grid small){font-size:11px}.business-analytics.embedded :is(.performance-grid span,.headline-stat span,.owner-metrics span,.coverage-note,.valuation-card p){font-size:12px}.inventory-scope{display:flex;flex-wrap:wrap;gap:8px;margin-top:-10px}.inventory-scope span{padding:7px 10px;border-radius:999px;background:var(--ed-wash);color:var(--ed-muted);font-size:11px}.inventory-scope strong{color:var(--ed-ink)}
@media(max-width:1050px){.performance-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.performance-grid article:nth-child(2){border-right:0}.performance-grid article:nth-child(-n+2){border-bottom:1px solid var(--ed-line)}.overview-grid{grid-template-columns:1fr}.owner-metrics,.movement-grid,.category-grid,.stock-attention-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.customer-grid{grid-template-columns:1fr}}
@media(max-width:680px){.business-analytics{margin-top:30px;padding-top:26px}.analytics-heading,.view-heading,.card-heading{align-items:stretch;flex-direction:column;gap:12px}.analytics-heading .ed-btn{width:100%}.analytics-nav{width:100%;margin:20px 0}.analytics-nav button{flex:0 0 auto}.performance-grid{grid-template-columns:1fr}.performance-grid article{min-height:105px;border-right:0;border-bottom:1px solid var(--ed-line)!important}.performance-grid article:last-child{border-bottom:0!important}.owner-metrics,.movement-grid,.category-grid,.stock-attention-grid{grid-template-columns:1fr}.headline-stat{text-align:left}.card-heading>strong{text-align:left}.valuation-card{grid-template-columns:1fr}.valuation-coverage{text-align:left}.status-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.analytics-card,.owner-performance{padding:16px}.trend-bars{height:180px}.view-heading :is(h2,h3){font-size:23px}}
</style>
