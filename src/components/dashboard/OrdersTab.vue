<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Store } from '../../store';
import { api } from '../../services/api';
import { money } from '../../domain/pos';
import { customerOrderActions, customerOrderCounts, customerOrderStatusLabel, isTenderableCustomerOrder } from '../../domain/customerOrders';
import Icon from '../ui/EditionIcon.vue';
import Modal from '../ui/EditionModal.vue';

const queue = ref('requests'), paidView = ref('active'), requestView = ref('active');
const paidRows = ref([]), paidCounts = ref({ active:0, completed:0 }), paidNext = ref(null);
const requestRows = ref([]), requestCounts = ref(customerOrderCounts()), requestNext = ref(null);
const selected = ref(null), selectedKind = ref(''), loading = ref(false), busy = ref(false);
const error = ref(''), note = ref(''), pickupAt = ref(''), retry = ref(null);
const companyId = computed(() => Store.state.selectedCompany?.id || '');
const currency = computed(() => Store.state.selectedCompany?.preferences?.currency || 'RM');
const canReopen = computed(() => Store.permissions().owner || Store.permissions().manager);
const requestActions = order => customerOrderActions(order).filter(status => !['cancelled','expired'].includes(status) || canReopen.value);
let timer, request = 0, detailRequest = 0;
const paidLabels = { pending:'Pending', preparing:'Preparing', ready:'Ready', completed:'Completed' };
const requestActionLabels = { accepted:'Accept request', preparing:'Start preparing', ready:'Mark ready', cancelled:'Cancel request', expired:'Mark expired' };
const stamp = value => value ? new Intl.DateTimeFormat('en-MY', { timeZone:'Asia/Kuala_Lumpur', dateStyle:'medium', timeStyle:'short' }).format(new Date(value)) : '—';
const paidSteps = order => order.status === 'pending' ? ['preparing','ready','completed'] : order.status === 'preparing' ? ['ready','completed'] : order.status === 'ready' ? ['completed'] : [];
const paidPath = suffix => `/companies/${encodeURIComponent(companyId.value)}/orders${suffix}`;
const requestPath = suffix => `/companies/${encodeURIComponent(companyId.value)}/customer-orders${suffix}`;
const requestCode = order => order.code || order.orderCode || order.number || String(order.id || '').slice(0,8).toUpperCase();
const customerName = order => order.customerName || order.guestName || order.checkoutCart?.customer?.name || order.customer?.name || (order.customerId || order.customerAccountId ? 'Signed-in customer' : 'Guest customer');
const itemLabel = item => `${item.quantity ?? item.qty} × ${item.description || item.name || 'Item'}${item.variant || item.variantName ? ` · ${item.variant || item.variantName}` : ''}`;
const requestTotal = order => Number(order.total ?? order.quote?.total ?? 0);
const sourceLabel = order => order.locationName || order.location?.name || (order.serviceMode === 'table' ? 'At premise' : 'Pickup');
const statusClass = order => ({ warning:['awaiting_acceptance','submitted','accepted','preparing'].includes(order.status), ready:order.status === 'ready', error:['cancelled','expired'].includes(order.status) });

async function refreshPaid({ append=false, epoch=++request } = {}) {
  const company = companyId.value, currentView = paidView.value, cursor = append ? paidNext.value : null;
  if (append && cursor == null) return;
  const page = await api(paidPath(`?view=${currentView}&limit=100${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`));
  if (epoch !== request || company !== companyId.value || currentView !== paidView.value) return;
  paidRows.value = append ? [...new Map([...paidRows.value,...page.rows].map(order => [order.id,order])).values()] : page.rows;
  paidNext.value = page.next; paidCounts.value = page.counts;
}
async function refreshRequests({ append=false, epoch=++request } = {}) {
  const company = companyId.value, currentView = requestView.value, cursor = append ? requestNext.value : null;
  if (append && cursor == null) return;
  const page = await api(requestPath(`?view=${currentView}&limit=100${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`));
  if (epoch !== request || company !== companyId.value || currentView !== requestView.value) return;
  requestRows.value = append ? [...new Map([...requestRows.value,...page.rows].map(order => [order.id,order])).values()] : page.rows;
  requestNext.value = page.next; requestCounts.value = customerOrderCounts(page);
}
async function refresh({ append=false } = {}) {
  if (!companyId.value || !Store.can('checkout') || !Store.state.online) return;
  const epoch = ++request; loading.value = true; if (!append) error.value = '';
  try { if (queue.value === 'requests') await refreshRequests({ append,epoch }); else await refreshPaid({ append,epoch }); }
  catch (caught) { if (epoch === request) error.value = caught.message || 'Orders could not be loaded.'; }
  finally { if (epoch === request) loading.value = false; }
}
async function refreshSummaries() {
  if (!companyId.value || !Store.state.online || document.visibilityState !== 'visible') return;
  const company = companyId.value;
  try {
    const [requests,paid] = await Promise.all([api(requestPath('/summary')),api(paidPath('/summary'))]);
    if (company !== companyId.value) return;
    requestCounts.value = customerOrderCounts(requests); paidCounts.value = paid.counts;
  } catch { /* The active queue displays a complete error when refreshed. */ }
}
async function open(order, kind) {
  const epoch = ++detailRequest, company = companyId.value;
  error.value = ''; note.value = ''; pickupAt.value = ''; retry.value = null;
  try {
    const detail = await api((kind === 'request' ? requestPath : paidPath)(`/${encodeURIComponent(order.id)}`));
    if (epoch === detailRequest && company === companyId.value) { selected.value = detail; selectedKind.value = kind; }
  } catch (caught) { if (epoch === detailRequest) error.value = caught.message || 'Order history could not be loaded.'; }
}
async function transitionPaid(status) {
  if (!selected.value || busy.value || !Store.state.online) return;
  const current = selected.value.order;
  const pending = retry.value?.orderId === current.id && retry.value.status === status ? retry.value : { orderId:current.id,status,requestId:crypto.randomUUID(),expectedVersion:current.version,note:note.value.trim() };
  if (status === 'pending' && pending.note.length < 3) { error.value = 'Give a reason of at least three characters to reopen an order.'; return; }
  busy.value = true; error.value = ''; retry.value = pending;
  try {
    selected.value = await api(paidPath(`/${encodeURIComponent(pending.orderId)}/transitions`), { method:'POST',body:{ requestId:pending.requestId,expectedVersion:pending.expectedVersion,status:pending.status,note:pending.note } });
    retry.value = null; note.value = ''; await refresh(); Store.notify(`Order ${paidLabels[status].toLowerCase()}.`);
  } catch (caught) { await resolveTransitionError(caught,current,'paid'); }
  finally { busy.value = false; }
}
async function transitionRequest(status) {
  if (!selected.value || busy.value || !Store.state.online) return;
  const current = selected.value.order, reason = note.value.trim();
  if (['cancelled','expired'].includes(status) && reason.length < 3) { error.value = 'Add a short reason so the customer and staff history are clear.'; return; }
  const pending = retry.value?.orderId === current.id && retry.value.status === status ? retry.value : { orderId:current.id,status,requestId:crypto.randomUUID(),expectedVersion:current.version,note:reason,...(status === 'accepted' && pickupAt.value ? { pickupAt:new Date(pickupAt.value).toISOString() } : {}) };
  busy.value = true; error.value = ''; retry.value = pending;
  try {
    selected.value = await api(requestPath(`/${encodeURIComponent(pending.orderId)}/transitions`), { method:'POST',body:{ requestId:pending.requestId,expectedVersion:pending.expectedVersion,status:pending.status,note:pending.note,...(pending.pickupAt ? { pickupAt:pending.pickupAt } : {}) } });
    retry.value = null; note.value = ''; pickupAt.value = ''; await refresh(); await refreshSummaries(); Store.notify(`${requestCode(selected.value.order)} · ${customerOrderStatusLabel(status)}.`);
  } catch (caught) { await resolveTransitionError(caught,current,'request'); }
  finally { busy.value = false; }
}
async function resolveTransitionError(caught,current,kind) {
  if (caught.status === 409) { retry.value = null; await refresh(); await open(current,kind); error.value = 'This order changed on another device. Review its latest history.'; }
  else error.value = 'Could not confirm the change. Retry the same action; it will not record twice.';
}
function closeDetail() { selected.value = null; selectedKind.value = ''; retry.value = null; error.value = ''; }
function foreground() { if (document.visibilityState === 'visible') { refresh(); refreshSummaries(); } }
watch([companyId,queue,paidView,requestView], () => {
  request++; detailRequest++; paidRows.value = []; requestRows.value = []; paidNext.value = null; requestNext.value = null; selected.value = null;
  if (document.visibilityState === 'visible') refresh();
});
onMounted(() => { refresh(); refreshSummaries(); timer = setInterval(foreground,20000); document.addEventListener('visibilitychange',foreground); window.addEventListener('focus',foreground); });
onBeforeUnmount(() => { request++; detailRequest++; clearInterval(timer); document.removeEventListener('visibilitychange',foreground); window.removeEventListener('focus',foreground); });
</script>

<template>
  <div v-if="Store.can('checkout')" class="ed-page mf-orders-page">
    <header class="ed-page-head"><div><div class="ed-eyebrow">WORKSPACE / SALES ORDERS</div><h1>Keep every order moving.</h1><p>Review unpaid customer requests separately from paid fulfillment. Every staff action stays in the order history.</p></div><div class="ed-actions"><button class="ed-btn" :disabled="loading || !Store.state.online" @click="refresh();refreshSummaries()"><Icon name="clock"/>Refresh</button></div></header>
    <div v-if="!Store.state.online" class="ed-notice warning">Reconnect to view and update the shared order queues. Payments awaiting sync remain on their original device.</div>
    <p v-if="error && !selected" class="ed-alert" role="alert">{{ error }}</p>
    <div class="mf-order-queue-tabs" role="tablist" aria-label="Order queue">
      <button role="tab" :aria-selected="queue==='requests'" :class="{active:queue==='requests'}" @click="queue='requests'"><Icon name="cloud"/><span><strong>Customer requests</strong><small>Unpaid · review before preparation</small></span><span v-if="requestCounts.active" class="ed-pill warning">{{ requestCounts.active }}</span></button>
      <button role="tab" :aria-selected="queue==='paid'" :class="{active:queue==='paid'}" @click="queue='paid'"><Icon name="receipt"/><span><strong>Paid fulfillment</strong><small>Counter payment confirmed</small></span><span v-if="paidCounts.active" class="ed-pill">{{ paidCounts.active }}</span></button>
    </div>
    <template v-if="queue==='requests'">
      <div class="ed-tabs mf-order-status-tabs" aria-label="Customer request status"><button :class="{active:requestView==='active'}" :aria-pressed="requestView==='active'" @click="requestView='active'">Needs attention <span class="ed-tab-count">{{ requestCounts.active }}</span></button><button :class="{active:requestView==='all'}" :aria-pressed="requestView==='all'" @click="requestView='all'">All requests</button></div>
      <div v-if="loading && !requestRows.length" class="ed-notice" role="status">Loading customer requests…</div>
      <div v-for="order in requestRows" :key="order.id" class="ed-row mf-order-row"><span class="ed-avatar"><Icon name="bag"/></span><div class="mf-order-row-main"><strong>{{ requestCode(order) }}</strong><small>{{ customerName(order) }} · {{ (order.items||[]).length }} {{ (order.items||[]).length===1?'line':'lines' }} · {{ stamp(order.createdAt) }}</small><small>{{ (order.items||[]).map(itemLabel).join(', ') }}</small><small>{{ sourceLabel(order) }}<template v-if="order.pickupAt"> · Due {{ stamp(order.pickupAt) }}</template> · {{ money(requestTotal(order),currency) }}</small></div><div class="mf-order-payment-state"><span class="ed-pill" :class="statusClass(order)">{{ customerOrderStatusLabel(order.status) }}</span><small>Unpaid</small></div><button class="ed-btn small" @click="open(order,'request')">Review</button></div>
      <div v-if="!loading && !requestRows.length && Store.state.online" class="ed-empty"><Icon name="cloud"/><h3>No customer requests need attention.</h3><p>New QR and online orders will appear here before payment.</p></div>
      <div v-if="requestNext!==null" class="ed-actions mf-order-load"><button class="ed-btn" :disabled="loading" @click="refresh({append:true})">Load more</button></div>
    </template>
    <template v-else>
      <div class="ed-tabs mf-order-status-tabs" aria-label="Paid fulfillment status"><button :class="{active:paidView==='active'}" :aria-pressed="paidView==='active'" @click="paidView='active'">In progress <span class="ed-tab-count">{{ paidCounts.active }}</span></button><button :class="{active:paidView==='completed'}" :aria-pressed="paidView==='completed'" @click="paidView='completed'">Completed <span class="ed-tab-count">{{ paidCounts.completed }}</span></button></div>
      <div v-if="loading && !paidRows.length" class="ed-notice" role="status">Loading paid orders…</div>
      <div v-for="order in paidRows" :key="order.id" class="ed-row mf-order-row"><span class="ed-avatar"><Icon name="receipt"/></span><div class="mf-order-row-main"><strong>{{ order.number }}</strong><small>{{ order.customerName }} · {{ order.items.length }} {{ order.items.length===1?'line':'lines' }} · {{ stamp(order.saleDate || order.createdAt) }}</small><small>{{ order.items.map(item => `${item.quantity} × ${item.description}${item.variant?' · '+item.variant:''}`).join(', ') }}</small><small v-if="order.clientId">Linked customer</small></div><div class="mf-order-payment-state"><span class="ed-pill" :class="{warning:order.status!=='completed'}">{{ paidLabels[order.status] }}</span><small>Paid</small></div><button class="ed-btn small" @click="open(order,'paid')">Open history</button></div>
      <div v-if="!loading && !paidRows.length && Store.state.online" class="ed-empty"><Icon name="clock"/><h3>{{ paidView==='active'?'No paid orders in progress.':'No completed orders yet.' }}</h3><p>Orders enter this queue after a successful counter transaction.</p></div>
      <div v-if="paidNext!==null" class="ed-actions mf-order-load"><button class="ed-btn" :disabled="loading" @click="refresh({append:true})">Load more</button></div>
    </template>
    <Modal v-if="selected && selectedKind==='request'" :title="`Request ${requestCode(selected.order)}`" wide :busy="busy" @close="closeDetail">
      <div class="mf-order-detail-head"><div><div class="ed-eyebrow">UNPAID CUSTOMER ORDER</div><h3>{{ customerName(selected.order) }}</h3><p>{{ sourceLabel(selected.order) }} · Received {{ stamp(selected.order.createdAt) }}</p></div><div class="mf-order-payment-state"><span class="ed-pill" :class="statusClass(selected.order)">{{ customerOrderStatusLabel(selected.order.status) }}</span><small>Payment at counter</small></div></div>
      <div class="ed-notice warning"><Icon name="wallet"/><div><strong>{{ money(requestTotal(selected.order),currency) }} has not been paid.</strong>Accept only after checking availability. Preparation can begin before arrival; payment is recorded once at Checkout.</div></div>
      <div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Item</th><th>Option</th><th>Quantity</th><th class="num">Price</th></tr></thead><tbody><tr v-for="(item,index) in selected.order.items" :key="index"><td>{{ item.description || item.name }}</td><td>{{ item.variant || item.variantName || '—' }}</td><td>{{ item.quantity ?? item.qty }} {{ item.unit }}</td><td class="num">{{ money(Number(item.lineTotal ?? item.total ?? (item.unitPrice ?? item.price)*(item.quantity ?? item.qty)),currency) }}</td></tr></tbody></table></div>
      <div v-if="selected.order.notes || selected.order.note || selected.order.customerNote" class="ed-notice"><Icon name="edit"/><div><strong>Customer note</strong>{{ selected.order.notes || selected.order.note || selected.order.customerNote }}</div></div>
      <section class="ed-editor-section"><h3>Request history</h3><div v-for="event in selected.events" :key="event.id" class="ed-row"><div><strong>{{ event.actionLabel || customerOrderStatusLabel(event.toStatus || event.status) }}</strong><small>{{ event.actorName || 'Customer' }} · {{ stamp(event.createdAt) }}</small><small v-if="event.note">{{ event.note }}</small></div></div></section>
      <label v-if="['awaiting_acceptance','submitted'].includes(selected.order.status)" class="ed-field"><span>Promised pickup time (optional)</span><input v-model="pickupAt" type="datetime-local" :disabled="busy"></label>
      <label v-if="requestActions(selected.order).some(status=>['cancelled','expired'].includes(status))" class="ed-field mf-order-note"><span>Staff note / cancellation reason</span><input v-model.trim="note" maxlength="1000" :disabled="busy" placeholder="Required when cancelling or expiring"></label>
      <p v-if="error" class="ed-alert" role="alert">{{ error }}</p>
      <template #actions><button class="ed-btn" :disabled="busy" @click="closeDetail">Close</button><button v-for="action in requestActions(selected.order)" :key="action" class="ed-btn" :class="{primary:action==='accepted'||action==='ready',danger:action==='cancelled'||action==='expired'}" :disabled="busy || !Store.state.online" @click="transitionRequest(action)">{{ requestActionLabels[action] }}</button><router-link v-if="isTenderableCustomerOrder(selected.order)" class="ed-btn primary" :to="{path:'/pos',query:{customerOrder:selected.order.id}}"><Icon name="wallet"/>Load into checkout</router-link></template>
    </Modal>
    <Modal v-if="selected && selectedKind==='paid'" :title="`Order ${selected.order.number}`" wide :busy="busy" @close="closeDetail">
      <div class="ed-row"><div style="flex:1"><strong>{{ selected.order.customerName }}</strong><small>{{ stamp(selected.order.saleDate || selected.order.createdAt) }} · {{ selected.order.clientId?'Linked customer':'Walk-in' }}</small></div><span class="ed-pill" :class="{warning:selected.order.status!=='completed'}">{{ paidLabels[selected.order.status] }}</span></div>
      <div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Item</th><th>Option</th><th>Quantity</th></tr></thead><tbody><tr v-for="(item,index) in selected.order.items" :key="index"><td>{{ item.description }}</td><td>{{ item.variant || '—' }}</td><td>{{ item.quantity }} {{ item.unit }}</td></tr></tbody></table></div>
      <section class="ed-editor-section"><h3>Order history</h3><div v-for="event in selected.events" :key="event.id" class="ed-row"><div><strong>{{ event.action==='imported'?'Historical sale imported':event.action==='created'?'Order created':`${paidLabels[event.fromStatus]} → ${paidLabels[event.toStatus]}` }}</strong><small>{{ event.actorName }} · {{ stamp(event.createdAt) }}</small><small v-if="event.note">{{ event.note }}</small></div></div></section>
      <label v-if="selected.order.status==='completed' && canReopen" class="ed-field"><span>Reason to reopen</span><input v-model="note" maxlength="1000" placeholder="What still needs attention?"></label><p v-if="error" class="ed-alert" role="alert">{{ error }}</p>
      <template #actions><button class="ed-btn" :disabled="busy" @click="closeDetail">Close</button><button v-for="step in paidSteps(selected.order)" :key="step" class="ed-btn" :class="{primary:step==='completed'}" :disabled="busy || !Store.state.online" @click="transitionPaid(step)">{{ step==='completed'?'Complete order':`Mark ${paidLabels[step].toLowerCase()}` }}</button><button v-if="selected.order.status==='completed' && canReopen" class="ed-btn" :disabled="busy || !Store.state.online" @click="transitionPaid('pending')">Reopen</button></template>
    </Modal>
  </div>
</template>
