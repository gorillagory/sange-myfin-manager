<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { formatCustomerMoney, orderProgress } from '../../domain/customerOrdering';
import { loadCustomerOrderStatus } from '../../services/customerOrdering';

const route = useRoute();
const code = computed(() => String(route.params.code || '').trim().toUpperCase());
const result = ref(null), loading = ref(true), error = ref('');
const isPaid = computed(() => result.value?.order?.paymentState === 'paid' || result.value?.order?.status === 'paid');
const progress = computed(() => orderProgress(result.value?.order?.status, result.value?.order?.fulfillmentStatus));
const pollingComplete = computed(() => progress.value.terminal || progress.value.current === 'completed');
const statusCopy = computed(() => ({
  submitted: ['Order received', 'The shop will review availability and accept your order.'],
  accepted: ['Order accepted', 'The shop has confirmed your order and pickup estimate.'],
  preparing: ['Being prepared', 'Your order is now being prepared.'],
  ready: ['Ready to collect', 'Show this order code and pay at the counter.'],
  completed: ['Collected', 'Payment and collection are complete.'],
  cancelled: ['Order cancelled', 'This order will not be prepared. Contact the shop if you need help.'],
  expired: ['Order expired', 'The collection window has passed. Start a new order when you are ready.'],
  declined: ['Order unavailable', 'The shop could not accept this order.'],
})[progress.value.current] || ['Order received', 'Check again shortly for an update.']);
let timer, request = 0;

const timestamp = value => value ? new Intl.DateTimeFormat('en-MY', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(value)) : '';
const eventLabel = event => ({ awaiting_acceptance: 'Order received', accepted: 'Order accepted', preparing: 'Preparation started', ready: 'Ready to collect', paid: 'Payment received', completed: 'Order collected', cancelled: 'Order cancelled', expired: 'Order expired' })[event.status || event.toStatus] || event.label || event.action || 'Order updated';
const friendlyError = caught => caught?.status === 401 || caught?.status === 403
  ? 'This private order is not available in this browser. Open it on the device that placed the order.'
  : caught?.status === 404 ? 'This order could not be found at this shop.'
    : 'Order status could not be refreshed. Check your connection and try again.';

async function refresh() {
  if (!/^[A-Z0-9]{8}$/.test(code.value)) { loading.value = false; error.value = 'This order code is not valid.'; return; }
  const epoch = ++request; loading.value = !result.value; error.value = '';
  try {
    const next = await loadCustomerOrderStatus(code.value);
    if (epoch === request) result.value = next;
  } catch (caught) { if (epoch === request) error.value = friendlyError(caught); }
  finally { if (epoch === request) loading.value = false; }
}
function onVisibility() { if (!pollingComplete.value && document.visibilityState === 'visible') refresh(); }
onMounted(() => {
  refresh();
  timer = setInterval(onVisibility, 15000);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onVisibility);
});
onBeforeUnmount(() => { request++; clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('focus', onVisibility); });
</script>

<template>
  <main class="customer-status-shell">
    <nav class="customer-status-nav"><RouterLink to="/shop" class="customer-wordmark"><i aria-hidden="true"></i> myfin <small>order</small></RouterLink>
      <button type="button" :disabled="loading" @click="refresh">Refresh status</button></nav>
    <section v-if="loading && !result" class="customer-status-card customer-status-empty" role="status"><span class="customer-loader"></span><p>Checking your order…</p></section>
    <section v-else-if="!result" class="customer-status-card customer-status-empty"><span class="customer-status-symbol">!</span><h1>Status unavailable</h1><p>{{ error }}</p><RouterLink to="/shop" class="customer-status-action">Return to menu</RouterLink></section>
    <section v-else class="customer-status-card">
      <header><div><span class="customer-kicker">ORDER {{ result.order.code || code }}</span><h1>{{ statusCopy[0] }}</h1><p>{{ statusCopy[1] }}</p></div>
        <span class="customer-payment" :class="{paid:isPaid}">{{ isPaid ? 'Paid' : 'Pay at counter' }}</span></header>
      <div v-if="error" class="customer-status-warning" role="alert">{{ error }}</div>
      <ol v-if="!progress.terminal" class="customer-progress">
        <li v-for="(step,index) in progress.steps" :key="step" :class="{done:index<=progress.currentIndex,current:index===progress.currentIndex}"><i></i><span>{{ {submitted:'Received',accepted:'Accepted',preparing:'Preparing',ready:'Ready',completed:'Collected'}[step] }}</span></li>
      </ol>
      <div v-else class="customer-terminal">{{ statusCopy[0] }}</div>
      <div class="customer-status-grid">
        <section><span class="customer-kicker">COLLECTION</span><strong>{{ result.order.location?.tableLabel || result.order.location?.name || (result.order.location?.fulfillmentMode === 'table' ? 'At your table' : 'Shop counter') }}</strong><p v-if="result.order.location?.pickupInstructions">{{ result.order.location.pickupInstructions }}</p><p v-if="result.order.pickupAt">Estimated ready {{ timestamp(result.order.pickupAt) }}</p><p v-if="result.order.expiresAt">Collect before {{ timestamp(result.order.expiresAt) }}</p></section>
        <section><span class="customer-kicker">TOTAL</span><strong>{{ formatCustomerMoney(result.order.total, result.order.currency) }}</strong><p>{{ isPaid ? 'Payment received' : 'Payment is due when you collect.' }}</p></section>
      </div>
      <section class="customer-status-items"><span class="customer-kicker">ORDER DETAILS</span>
        <div v-for="(item,index) in result.order.items || []" :key="item.id || index"><span>{{ item.quantity }} × {{ item.name || item.description }}<small v-if="item.variantName || item.variant">{{ item.variantName || item.variant }}</small></span><strong>{{ formatCustomerMoney(item.lineTotal ?? item.total ?? item.unitPrice * item.quantity, result.order.currency) }}</strong></div>
      </section>
      <section v-if="result.events?.length" class="customer-timeline"><span class="customer-kicker">HISTORY</span>
        <div v-for="event in result.events" :key="event.id || event.version"><i></i><p><strong>{{ eventLabel(event) }}</strong><small>{{ timestamp(event.createdAt) }}<template v-if="event.note"> · {{ event.note }}</template></small></p></div>
      </section>
      <footer><p>This browser holds a private, secure order session. The short order code alone does not reveal your details.</p><RouterLink to="/shop">Order something else →</RouterLink></footer>
    </section>
  </main>
</template>

<style scoped>
.customer-status-shell{--customer-ink:#15382c;--customer-muted:#68776f;--customer-line:#d8dfd8;--customer-tint:#f1f5ed;--customer-accent:#17624d;min-height:100dvh;background:#f7f8f3;color:var(--customer-ink);padding:0 20px 70px;font-family:Inter,ui-sans-serif,system-ui,sans-serif}.customer-status-nav{height:76px;max-width:900px;margin:auto;display:flex;align-items:center;justify-content:space-between}.customer-wordmark{display:flex;align-items:center;gap:8px;color:var(--customer-ink);text-decoration:none;font:bold 21px Georgia,serif}.customer-wordmark i{width:13px;height:13px;background:var(--customer-accent);box-shadow:6px -6px 0 #8dad9c}.customer-wordmark small{font:500 10px Inter,sans-serif;letter-spacing:.15em}.customer-status-nav button{border:1px solid var(--customer-line);background:white;border-radius:999px;padding:9px 14px;color:var(--customer-ink)}.customer-status-nav button:disabled{opacity:.45}.customer-status-card{max-width:900px;margin:22px auto 0;background:white;border:1px solid var(--customer-line);border-radius:22px;box-shadow:0 24px 80px #173d2b0e;overflow:hidden}.customer-status-card>header{padding:44px;display:flex;align-items:start;justify-content:space-between;gap:25px;background:linear-gradient(145deg,#f0f5ed,#fff)}.customer-status-card h1{font:400 clamp(34px,6vw,58px)/1 Georgia,serif;margin:11px 0 13px}.customer-status-card header p{margin:0;color:var(--customer-muted);font-size:13px}.customer-kicker{font-size:10px;letter-spacing:.18em;font-weight:750;color:var(--customer-muted)}.customer-payment{border-radius:999px;padding:9px 13px;background:#fff4d4;color:#735315;border:1px solid #ead695;font-size:11px;font-weight:750;white-space:nowrap}.customer-payment.paid{background:#e3f2e8;border-color:#b7d9c2;color:#17603b}.customer-progress{display:grid;grid-template-columns:repeat(5,1fr);list-style:none;margin:0;padding:32px 44px;border-block:1px solid var(--customer-line)}.customer-progress li{position:relative;display:grid;justify-items:center;gap:9px;color:#9aa59f;font-size:10px;font-weight:650}.customer-progress li:not(:first-child):before{content:'';position:absolute;right:50%;top:6px;width:100%;height:2px;background:var(--customer-line)}.customer-progress li.done:not(:first-child):before{background:var(--customer-accent)}.customer-progress i{position:relative;z-index:1;width:14px;height:14px;border-radius:50%;border:2px solid var(--customer-line);background:white}.customer-progress .done{color:var(--customer-ink)}.customer-progress .done i{border-color:var(--customer-accent);background:var(--customer-accent)}.customer-progress .current i{box-shadow:0 0 0 5px #dcece5}.customer-terminal{margin:28px 44px 0;border:1px solid #e6c9c0;background:#fff2ee;color:#873e2c;border-radius:8px;padding:14px;font-weight:700}.customer-status-grid{display:grid;grid-template-columns:1fr 1fr;gap:0;padding:32px 44px}.customer-status-grid section{padding-right:30px}.customer-status-grid section+section{border-left:1px solid var(--customer-line);padding-left:30px}.customer-status-grid strong{display:block;font:400 23px Georgia,serif;margin:9px 0}.customer-status-grid p{margin:4px 0;color:var(--customer-muted);font-size:11px}.customer-status-items,.customer-timeline{margin:0 44px;padding:26px 0;border-top:1px solid var(--customer-line)}.customer-status-items>div{display:flex;justify-content:space-between;gap:20px;padding:12px 0;font-size:13px}.customer-status-items small{display:block;color:var(--customer-muted);margin-top:3px}.customer-timeline>div{display:flex;gap:14px;padding:12px 0}.customer-timeline i{width:9px;height:9px;margin-top:4px;border-radius:50%;background:var(--customer-accent)}.customer-timeline p{margin:0;font-size:12px}.customer-timeline small{display:block;color:var(--customer-muted);margin-top:3px}.customer-status-card>footer{display:flex;justify-content:space-between;align-items:center;gap:25px;padding:22px 44px;background:var(--customer-tint);font-size:11px;color:var(--customer-muted)}.customer-status-card>footer p{margin:0}.customer-status-card>footer a,.customer-status-action{color:var(--customer-accent);font-weight:700;text-decoration:none;white-space:nowrap}.customer-status-empty{min-height:470px;display:grid;place-content:center;justify-items:center;text-align:center;padding:30px}.customer-status-empty h1{margin-bottom:12px}.customer-status-empty p{color:var(--customer-muted);max-width:390px}.customer-status-symbol{display:grid;place-items:center;width:45px;height:45px;border-radius:50%;background:#fff0eb;color:#953a25;font-size:22px}.customer-loader{width:32px;height:32px;border:3px solid var(--customer-line);border-top-color:var(--customer-accent);border-radius:50%;animation:customer-spin .7s linear infinite}.customer-status-warning{margin:22px 44px 0;padding:12px;border:1px solid #ead695;background:#fff9e9;font-size:12px;border-radius:7px}@keyframes customer-spin{to{transform:rotate(360deg)}}
@media(max-width:620px){.customer-status-shell{padding-inline:12px}.customer-status-card>header{padding:30px 22px;display:block}.customer-payment{display:inline-block;margin-top:20px}.customer-progress{padding:26px 14px}.customer-progress span{font-size:9px}.customer-status-grid{grid-template-columns:1fr;padding:25px 22px}.customer-status-grid section{padding:0}.customer-status-grid section+section{border-left:0;border-top:1px solid var(--customer-line);padding:22px 0 0;margin-top:22px}.customer-status-items,.customer-timeline{margin-inline:22px}.customer-status-card>footer{padding:20px 22px;align-items:start;flex-direction:column}}
</style>
