<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { formatCustomerMoney, orderProgress } from '../../domain/customerOrdering';
import {
  loadCustomerOrderPayment, loadCustomerOrderStatus, startCustomerOrderPayment,
} from '../../services/customerOrdering';

const route = useRoute();
const code = computed(() => String(route.params.code || '').trim().toUpperCase());
const result = ref(null), loading = ref(true), error = ref('');
const onlinePayment = ref({ available:false, provider:'hitpay', state:'not_started' });
const paymentBusy = ref(false), paymentError = ref('');
const providerConfirmed = computed(() => ['confirmed','confirmed_unposted','finalized','posted'].includes(onlinePayment.value?.state));
const paymentReconciliation = computed(() => onlinePayment.value?.state === 'reconciliation_required');
const paymentInProgress = computed(() => ['creating','pending','reconciliation_required'].includes(onlinePayment.value?.state));
const isPaid = computed(() => providerConfirmed.value || result.value?.order?.paymentState === 'paid' || result.value?.order?.status === 'paid');
const isDelivery = computed(() => result.value?.order?.serviceMode === 'delivery');
const deliveryRegion = computed(() => {
  const address = result.value?.order?.delivery?.address || {};
  return [[address.postcode,address.city].filter(Boolean).join(' '),address.state].filter(Boolean).join(', ');
});
const progress = computed(() => orderProgress(result.value?.order?.status, result.value?.order?.fulfillmentStatus));
const pollingComplete = computed(() => progress.value.terminal || progress.value.current === 'completed');
const statusCopy = computed(() => ({
  submitted: ['Order received', 'The shop will review availability and accept your order.'],
  accepted: ['Order accepted', isDelivery.value ? 'The shop has confirmed your delivery order and timing.' : 'The shop has confirmed your order and pickup estimate.'],
  preparing: ['Being prepared', 'Your order is now being prepared.'],
  ready: [isDelivery.value ? 'Ready for delivery' : 'Ready to collect', isDelivery.value ? 'The shop has prepared your order for delivery.' : isPaid.value ? 'Show this order code when you collect. Your online payment is confirmed.' : paymentInProgress.value ? 'Show this order code when you collect. Do not pay again while the online payment check is open.' : 'Show this order code and pay at the counter.'],
  completed: [isDelivery.value ? 'Delivered' : 'Collected', isDelivery.value ? 'Delivery and payment are complete.' : 'Payment and collection are complete.'],
  cancelled: ['Order cancelled', 'This order will not be prepared. Contact the shop if you need help.'],
  expired: ['Order expired', isDelivery.value ? 'The delivery window has passed. Start a new order when you are ready.' : 'The collection window has passed. Start a new order when you are ready.'],
  declined: ['Order unavailable', 'The shop could not accept this order.'],
})[progress.value.current] || ['Order received', 'Check again shortly for an update.']);
let timer, request = 0;

const canPayOnline = computed(() => onlinePayment.value?.available && ['not_started','pending','failed'].includes(onlinePayment.value?.state) &&
  ['accepted','preparing','ready'].includes(String(result.value?.order?.status || '')) && !isPaid.value);
const paymentCopy = computed(() => ({
  not_started:'Pay securely online', creating:'Preparing secure checkout…', pending:'Continue secure payment',
  failed:'Try online payment again', reconciliation_required:'Payment check in progress',
  confirmed_unposted:'Online payment confirmed', confirmed:'Online payment confirmed', finalized:'Payment recorded', posted:'Payment recorded',
})[onlinePayment.value?.state] || 'Pay securely online');

const timestamp = value => value ? new Intl.DateTimeFormat('en-MY', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(value)) : '';
const eventLabel = event => ({ awaiting_acceptance: 'Order received', accepted: 'Order accepted', preparing: 'Preparation started', ready: isDelivery.value ? 'Ready for delivery' : 'Ready to collect', paid: 'Payment received', completed: isDelivery.value ? 'Order delivered' : 'Order collected', cancelled: 'Order cancelled', expired: 'Order expired' })[event.status || event.toStatus] || event.label || event.action || 'Order updated';
const friendlyError = caught => caught?.status === 401 || caught?.status === 403
  ? 'This private order is not available in this browser. Open it on the device that placed the order.'
  : caught?.status === 404 ? 'This order could not be found at this shop.'
    : 'Order status could not be refreshed. Check your connection and try again.';

async function refresh() {
  if (!/^[A-Z0-9]{8}$/.test(code.value)) { loading.value = false; error.value = 'This order code is not valid.'; return; }
  const epoch = ++request; loading.value = !result.value; error.value = '';
  try {
    const [status,payment] = await Promise.allSettled([
      loadCustomerOrderStatus(code.value), loadCustomerOrderPayment(code.value),
    ]);
    if (status.status === 'rejected') throw status.reason;
    if (epoch === request) {
      result.value = status.value;
      if (payment.status === 'fulfilled') { onlinePayment.value = payment.value.onlinePayment || onlinePayment.value; paymentError.value = ''; }
      else if (![404,503].includes(payment.reason?.status)) paymentError.value = friendlyError(payment.reason);
    }
  } catch (caught) { if (epoch === request) error.value = friendlyError(caught); }
  finally { if (epoch === request) loading.value = false; }
}
const paymentRequestKey = () => `myfin-payment:${code.value}`;
function safeCheckoutUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && ['securecheckout.hit-pay.com','securecheckout.sandbox.hit-pay.com'].includes(url.hostname) ? url.toString() : '';
  } catch { return ''; }
}
async function payOnline() {
  if (!canPayOnline.value || paymentBusy.value) return;
  paymentBusy.value = true; paymentError.value = '';
  try {
    if (onlinePayment.value.state === 'pending') {
      const existing = safeCheckoutUrl(onlinePayment.value.checkoutUrl);
      if (!existing) throw new Error('payment_checkout_unavailable');
      window.location.assign(existing); return;
    }
    if (onlinePayment.value.state === 'failed') sessionStorage.removeItem(paymentRequestKey());
    let requestId = sessionStorage.getItem(paymentRequestKey());
    if (!requestId) { requestId = crypto.randomUUID(); sessionStorage.setItem(paymentRequestKey(), requestId); }
    const response = await startCustomerOrderPayment(code.value, requestId);
    onlinePayment.value = response.onlinePayment || onlinePayment.value;
    const checkout = safeCheckoutUrl(onlinePayment.value.checkoutUrl);
    if (checkout) { window.location.assign(checkout); return; }
    if (onlinePayment.value.state === 'failed') sessionStorage.removeItem(paymentRequestKey());
    paymentError.value = 'Secure checkout could not be opened. Try again.';
  } catch (caught) {
    if (caught?.network || caught?.status === 503 || caught?.message === 'online_payment_reconciliation_required') {
      try {
        const current = await loadCustomerOrderPayment(code.value);
        onlinePayment.value = current.onlinePayment || onlinePayment.value;
      } catch { /* Keep the stable request key and require a later status refresh. */ }
    }
    paymentError.value = onlinePayment.value?.state === 'reconciliation_required'
      ? 'The provider may have created this payment request, but its checkout response was interrupted. Do not pay again or pay at the counter. The shop can reconcile the provider record safely.'
      : caught?.network ? 'The payment request may still be processing. Keep this page and refresh payment status before trying again or paying another way.'
        : caught?.message === 'order_not_payable' ? 'This order is no longer eligible for online payment.'
          : 'Online payment is temporarily unavailable. Refresh payment status before choosing another way to pay.';
  } finally { paymentBusy.value = false; }
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
        <span class="customer-payment" :class="{paid:isPaid}">{{ isPaid ? (providerConfirmed?'Paid online':'Paid') : paymentReconciliation ? 'Payment check required' : paymentInProgress ? 'Online payment pending' : isDelivery ? 'Payment pending' : 'Pay at counter or online' }}</span></header>
      <div v-if="error" class="customer-status-warning" role="alert">{{ error }}</div>
      <div v-if="route.query.payment==='return' && !providerConfirmed" class="customer-status-warning" role="status">We are waiting for secure confirmation from the payment provider. Refreshing or returning to this page cannot mark the order paid.</div>
      <ol v-if="!progress.terminal" class="customer-progress">
        <li v-for="(step,index) in progress.steps" :key="step" :class="{done:index<=progress.currentIndex,current:index===progress.currentIndex}"><i></i><span>{{ {submitted:'Received',accepted:'Accepted',preparing:'Preparing',ready:'Ready',completed:isDelivery?'Delivered':'Collected'}[step] }}</span></li>
      </ol>
      <div v-else class="customer-terminal">{{ statusCopy[0] }}</div>
      <div class="customer-status-grid">
        <section><span class="customer-kicker">{{ isDelivery ? 'DELIVERY' : 'COLLECTION' }}</span><strong>{{ isDelivery ? (result.order.delivery?.zoneName || 'Delivery') : result.order.location?.tableLabel || result.order.location?.name || (result.order.location?.fulfillmentMode === 'table' ? 'At your table' : 'Shop counter') }}</strong><template v-if="isDelivery"><p v-if="deliveryRegion">{{ deliveryRegion }}</p><p v-if="result.order.delivery?.serviceInstructions">{{ result.order.delivery.serviceInstructions }}</p><p v-if="result.order.delivery?.addressRedacted">The saved delivery address has been removed.</p></template><p v-else-if="result.order.location?.pickupInstructions">{{ result.order.location.pickupInstructions }}</p><p v-if="result.order.pickupAt">Estimated {{ isDelivery?'delivery':'ready' }} {{ timestamp(result.order.pickupAt) }}</p><p v-if="result.order.expiresAt">{{ isDelivery?'Order window ends':'Collect before' }} {{ timestamp(result.order.expiresAt) }}</p></section>
        <section><span class="customer-kicker">TOTAL</span><strong>{{ formatCustomerMoney(result.order.total, result.order.currency) }}</strong><p>{{ isPaid ? (providerConfirmed?'Secure online payment confirmed by the provider. Do not pay again at the counter.':'Payment received') : paymentReconciliation?'The checkout response was interrupted. Do not start another payment or pay at the counter while the provider record is being reconciled.':onlinePayment.state==='creating'?'Secure checkout is being prepared. Refresh in a moment; do not pay another way yet.':onlinePayment.state==='pending'?'Secure checkout started; this order stays unpaid until provider confirmation. Do not pay again at the counter.':isDelivery ? 'Pay online when the shop accepts this order, or follow the shop’s delivery instructions.' : 'Pay securely online after acceptance, or at the counter when you collect.' }}</p><button v-if="canPayOnline" type="button" class="customer-pay-action" :disabled="paymentBusy" @click="payOnline">{{ paymentBusy?'Opening secure checkout…':paymentCopy }}</button><p v-if="paymentError" class="customer-payment-error" role="alert">{{ paymentError }}</p><small v-if="canPayOnline" class="customer-payment-note">Hosted by HitPay. MyFin never receives your card or bank credentials.</small></section>
      </div>
      <section class="customer-status-items"><span class="customer-kicker">ORDER DETAILS</span>
        <div v-for="(item,index) in result.order.items || []" :key="item.id || index"><span>{{ item.quantity }} × {{ item.name || item.description }}<small v-if="item.variantName || item.variant">{{ item.variantName || item.variant }}</small></span><strong>{{ formatCustomerMoney(item.lineTotal ?? item.total ?? item.unitPrice * item.quantity, result.order.currency) }}</strong></div>
        <div v-if="isDelivery"><span>Delivery fee</span><strong>{{ formatCustomerMoney(result.order.deliveryFee||0, result.order.currency) }}</strong></div>
      </section>
      <section v-if="result.events?.length" class="customer-timeline"><span class="customer-kicker">HISTORY</span>
        <div v-for="event in result.events" :key="event.id || event.version"><i></i><p><strong>{{ eventLabel(event) }}</strong><small>{{ timestamp(event.createdAt) }}<template v-if="event.note"> · {{ event.note }}</template></small></p></div>
      </section>
      <footer><p>This browser holds a private, secure order session. The short order code alone does not reveal your details.</p><RouterLink to="/shop">Order something else →</RouterLink></footer>
    </section>
  </main>
</template>

<style scoped>
.customer-status-shell{--customer-ink:#15382c;--customer-muted:#68776f;--customer-line:#d8dfd8;--customer-tint:#f1f5ed;--customer-accent:#17624d;min-height:100dvh;background:#f7f8f3;color:var(--customer-ink);padding:0 20px 70px;font-family:var(--ed-font-sans)}.customer-status-nav{height:76px;max-width:900px;margin:auto;display:flex;align-items:center;justify-content:space-between}.customer-wordmark{display:flex;align-items:center;gap:8px;color:var(--customer-ink);text-decoration:none;font:bold 21px var(--ed-font-sans)}.customer-wordmark i{width:13px;height:13px;background:var(--customer-accent);box-shadow:6px -6px 0 #8dad9c}.customer-wordmark small{font:500 10px var(--ed-font-sans);letter-spacing:.15em}.customer-status-nav button{border:1px solid var(--customer-line);background:white;border-radius:999px;padding:9px 14px;color:var(--customer-ink)}.customer-status-nav button:disabled{opacity:.45}.customer-status-card{max-width:900px;margin:22px auto 0;background:white;border:1px solid var(--customer-line);border-radius:22px;box-shadow:0 24px 80px #173d2b0e;overflow:hidden}.customer-status-card>header{padding:44px;display:flex;align-items:start;justify-content:space-between;gap:25px;background:linear-gradient(145deg,#f0f5ed,#fff)}.customer-status-card h1{font:400 clamp(34px,6vw,58px)/1 var(--ed-font-sans);margin:11px 0 13px}.customer-status-card header p{margin:0;color:var(--customer-muted);font-size:13px}.customer-kicker{font-size:10px;letter-spacing:.18em;font-weight:750;color:var(--customer-muted)}.customer-payment{border-radius:999px;padding:9px 13px;background:#fff4d4;color:#735315;border:1px solid #ead695;font-size:11px;font-weight:750;white-space:nowrap}.customer-payment.paid{background:#e3f2e8;border-color:#b7d9c2;color:#17603b}.customer-progress{display:grid;grid-template-columns:repeat(5,1fr);list-style:none;margin:0;padding:32px 44px;border-block:1px solid var(--customer-line)}.customer-progress li{position:relative;display:grid;justify-items:center;gap:9px;color:#9aa59f;font-size:10px;font-weight:650}.customer-progress li:not(:first-child):before{content:'';position:absolute;right:50%;top:6px;width:100%;height:2px;background:var(--customer-line)}.customer-progress li.done:not(:first-child):before{background:var(--customer-accent)}.customer-progress i{position:relative;z-index:1;width:14px;height:14px;border-radius:50%;border:2px solid var(--customer-line);background:white}.customer-progress .done{color:var(--customer-ink)}.customer-progress .done i{border-color:var(--customer-accent);background:var(--customer-accent)}.customer-progress .current i{box-shadow:0 0 0 5px #dcece5}.customer-terminal{margin:28px 44px 0;border:1px solid #e6c9c0;background:#fff2ee;color:#873e2c;border-radius:8px;padding:14px;font-weight:700}.customer-status-grid{display:grid;grid-template-columns:1fr 1fr;gap:0;padding:32px 44px}.customer-status-grid section{padding-right:30px}.customer-status-grid section+section{border-left:1px solid var(--customer-line);padding-left:30px}.customer-status-grid strong{display:block;font:400 23px var(--ed-font-sans);margin:9px 0}.customer-status-grid p{margin:4px 0;color:var(--customer-muted);font-size:11px}.customer-status-items,.customer-timeline{margin:0 44px;padding:26px 0;border-top:1px solid var(--customer-line)}.customer-status-items>div{display:flex;justify-content:space-between;gap:20px;padding:12px 0;font-size:13px}.customer-status-items small{display:block;color:var(--customer-muted);margin-top:3px}.customer-timeline>div{display:flex;gap:14px;padding:12px 0}.customer-timeline i{width:9px;height:9px;margin-top:4px;border-radius:50%;background:var(--customer-accent)}.customer-timeline p{margin:0;font-size:12px}.customer-timeline small{display:block;color:var(--customer-muted);margin-top:3px}.customer-status-card>footer{display:flex;justify-content:space-between;align-items:center;gap:25px;padding:22px 44px;background:var(--customer-tint);font-size:11px;color:var(--customer-muted)}.customer-status-card>footer p{margin:0}.customer-status-card>footer a,.customer-status-action{color:var(--customer-accent);font-weight:700;text-decoration:none;white-space:nowrap}.customer-status-empty{min-height:470px;display:grid;place-content:center;justify-items:center;text-align:center;padding:30px}.customer-status-empty h1{margin-bottom:12px}.customer-status-empty p{color:var(--customer-muted);max-width:390px}.customer-status-symbol{display:grid;place-items:center;width:45px;height:45px;border-radius:50%;background:#fff0eb;color:#953a25;font-size:22px}.customer-loader{width:32px;height:32px;border:3px solid var(--customer-line);border-top-color:var(--customer-accent);border-radius:50%;animation:customer-spin .7s linear infinite}.customer-status-warning{margin:22px 44px 0;padding:12px;border:1px solid #ead695;background:#fff9e9;font-size:12px;border-radius:7px}@keyframes customer-spin{to{transform:rotate(360deg)}}
.customer-pay-action{width:100%;min-height:44px;margin-top:14px;border:0;border-radius:9px;background:var(--customer-accent);color:#fff;font-weight:750}.customer-pay-action:disabled{opacity:.55}.customer-payment-note{display:block;margin-top:8px;color:var(--customer-muted);font-size:9px;line-height:1.45}.customer-payment-error{color:#873e2c!important;font-weight:650}
@media(max-width:620px){.customer-status-shell{padding-inline:12px}.customer-status-card>header{padding:30px 22px;display:block}.customer-payment{display:inline-block;margin-top:20px}.customer-progress{padding:26px 14px}.customer-progress span{font-size:9px}.customer-status-grid{grid-template-columns:1fr;padding:25px 22px}.customer-status-grid section{padding:0}.customer-status-grid section+section{border-left:0;border-top:1px solid var(--customer-line);padding:22px 0 0;margin-top:22px}.customer-status-items,.customer-timeline{margin-inline:22px}.customer-status-card>footer{padding:20px 22px;align-items:start;flex-direction:column}}
</style>
