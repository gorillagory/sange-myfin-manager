<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Store } from '../../store';
import { api } from '../../services/api';
import Icon from '../ui/EditionIcon.vue';
import Modal from '../ui/EditionModal.vue';

const view = ref('active'), rows = ref([]), counts = ref({ active: 0, completed: 0 });
const next = ref(null), selected = ref(null), loading = ref(false), busy = ref(false);
const error = ref(''), note = ref(''), retry = ref(null);
const companyId = computed(() => Store.state.selectedCompany?.id || '');
const canReopen = computed(() => Store.permissions().owner || Store.permissions().manager);
let timer, request = 0, detailRequest = 0;
const labels = { pending: 'Pending', preparing: 'Preparing', ready: 'Ready', completed: 'Completed' };
const stamp = value => value ? new Intl.DateTimeFormat('en-MY', {
  timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value)) : '—';
const steps = order => order.status === 'pending' ? ['preparing', 'ready', 'completed']
  : order.status === 'preparing' ? ['ready', 'completed']
  : order.status === 'ready' ? ['completed'] : [];
const path = suffix => `/companies/${encodeURIComponent(companyId.value)}/orders${suffix}`;

async function refresh({ append = false } = {}) {
  if (!companyId.value || !Store.can('checkout') || !Store.state.online) return;
  const epoch = ++request, company = companyId.value, currentView = view.value;
  loading.value = true;
  if (!append) error.value = '';
  try {
    const cursor = append ? next.value : null;
    if (append && cursor == null) return;
    const page = await api(path(`?view=${currentView}&limit=100${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`));
    if (epoch !== request || company !== companyId.value || currentView !== view.value) return;
    rows.value = append ? [...new Map([...rows.value, ...page.rows].map(order => [order.id, order])).values()] : page.rows;
    next.value = page.next;
    counts.value = page.counts;
  } catch (caught) {
    if (epoch === request) error.value = caught.message || 'Orders could not be loaded.';
  } finally { if (epoch === request) loading.value = false; }
}
async function open(order) {
  const epoch = ++detailRequest, company = companyId.value, currentView = view.value;
  error.value = ''; note.value = ''; retry.value = null;
  try {
    const detail = await api(path(`/${encodeURIComponent(order.id)}`));
    if (epoch === detailRequest && company === companyId.value && currentView === view.value) selected.value = detail;
  } catch (caught) {
    if (epoch === detailRequest) error.value = caught.message || 'Order history could not be loaded.';
  }
}
async function transition(status) {
  if (!selected.value || busy.value || !Store.state.online) return;
  const current = selected.value.order;
  const pending = retry.value?.orderId === current.id && retry.value.status === status
    ? retry.value
    : { orderId: current.id, status, requestId: crypto.randomUUID(),
        expectedVersion: current.version, note: note.value.trim() };
  if (status === 'pending' && pending.note.length < 3) {
    error.value = 'Give a reason of at least three characters to reopen an order.';
    return;
  }
  busy.value = true; error.value = ''; retry.value = pending;
  try {
    selected.value = await api(path(`/${encodeURIComponent(pending.orderId)}/transitions`), {
      method: 'POST', body: { requestId: pending.requestId,
        expectedVersion: pending.expectedVersion, status: pending.status, note: pending.note },
    });
    retry.value = null; note.value = '';
    await refresh();
    Store.notify(`Order ${labels[status].toLowerCase()}.`);
  } catch (caught) {
    if (caught.status === 409) {
      retry.value = null;
      await refresh();
      await open(current);
      error.value = 'This order changed on another device. Review its latest history.';
    } else {
      error.value = 'Could not confirm the change. Retry the same action; it will not record twice.';
    }
  } finally { busy.value = false; }
}
function foreground() { if (document.visibilityState === 'visible') refresh(); }
watch([companyId, view], () => {
  request++; detailRequest++; rows.value = []; next.value = null; selected.value = null;
  if (document.visibilityState === 'visible') refresh();
}, { immediate: true });
onMounted(() => {
  timer = setInterval(foreground, 20000);
  document.addEventListener('visibilitychange', foreground);
  window.addEventListener('focus', foreground);
});
onBeforeUnmount(() => {
  request++; detailRequest++;
  clearInterval(timer);
  document.removeEventListener('visibilitychange', foreground);
  window.removeEventListener('focus', foreground);
});
</script>

<template>
  <div v-if="Store.can('checkout')" class="ed-page">
    <header class="ed-page-head"><div><div class="ed-eyebrow">WORKSPACE / SALES ORDERS</div>
      <h1>Keep every order moving.</h1>
      <p>Paid orders appear here when the server confirms checkout. Changes stay visible to every signed-in device.</p>
    </div><div class="ed-actions"><button class="ed-btn" :disabled="loading || !Store.state.online" @click="refresh()"><Icon name="clock"/>Refresh</button></div></header>
    <div v-if="!Store.state.online" class="ed-notice warning">Reconnect to view and update the shared order queue. Payments awaiting sync remain on their original device.</div>
    <p v-if="error" class="ed-alert" role="alert">{{ error }}</p>
    <div class="ed-tabs" aria-label="Order status">
      <button :class="{active:view==='active'}" :aria-pressed="view==='active'" @click="view='active'">In progress <span class="ed-pill">{{ counts.active }}</span></button>
      <button :class="{active:view==='completed'}" :aria-pressed="view==='completed'" @click="view='completed'">Completed <span class="ed-pill">{{ counts.completed }}</span></button>
    </div>
    <div v-if="loading && !rows.length" class="ed-notice" role="status">Loading orders…</div>
    <div v-for="order in rows" :key="order.id" class="ed-row" style="gap:16px;align-items:start">
      <span class="ed-avatar"><Icon name="bag"/></span>
      <div style="flex:1;min-width:0"><strong>{{ order.number }}</strong>
        <small>{{ order.customerName }} · {{ order.items.length }} {{ order.items.length===1?'line':'lines' }} · {{ stamp(order.saleDate || order.createdAt) }}</small>
        <small>{{ order.items.map(item => `${item.quantity} × ${item.description}${item.variant?' · '+item.variant:''}`).join(', ') }}</small>
        <small v-if="order.clientId">Linked customer</small>
      </div>
      <span class="ed-pill" :class="{warning:order.status!=='completed'}">{{ labels[order.status] }}</span>
      <button class="ed-btn small" @click="open(order)">Open history</button>
    </div>
    <div v-if="!loading && !rows.length && Store.state.online" class="ed-empty"><Icon name="clock"/><h3>{{ view==='active'?'No orders in progress.':'No completed orders yet.' }}</h3><p>Orders enter this queue after a successful POS transaction.</p></div>
    <div v-if="next!==null" class="ed-actions" style="justify-content:center;margin-top:18px"><button class="ed-btn" :disabled="loading" @click="refresh({append:true})">Load more</button></div>

    <Modal v-if="selected" :title="`Order ${selected.order.number}`" wide :busy="busy" @close="selected=null;retry=null;error=''">
      <div class="ed-row"><div style="flex:1"><strong>{{ selected.order.customerName }}</strong>
        <small>{{ stamp(selected.order.saleDate || selected.order.createdAt) }} · {{ selected.order.clientId?'Linked customer':'Walk-in' }}</small></div>
        <span class="ed-pill" :class="{warning:selected.order.status!=='completed'}">{{ labels[selected.order.status] }}</span></div>
      <div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Item</th><th>Option</th><th>Quantity</th></tr></thead>
        <tbody><tr v-for="(item,index) in selected.order.items" :key="index"><td>{{ item.description }}</td><td>{{ item.variant || '—' }}</td><td>{{ item.quantity }} {{ item.unit }}</td></tr></tbody></table></div>
      <section class="ed-editor-section"><h3>Order history</h3>
        <div v-for="event in selected.events" :key="event.id" class="ed-row"><div><strong>{{ event.action==='imported'?'Historical sale imported':event.action==='created'?'Order created':`${labels[event.fromStatus]} → ${labels[event.toStatus]}` }}</strong>
          <small>{{ event.actorName }} · {{ stamp(event.createdAt) }}</small><small v-if="event.note">{{ event.note }}</small></div></div>
      </section>
      <label v-if="selected.order.status==='completed' && canReopen" class="ed-field"><span>Reason to reopen</span><input v-model="note" maxlength="1000" placeholder="What still needs attention?"></label>
      <p v-if="error" class="ed-alert" role="alert">{{ error }}</p>
      <template #actions><button class="ed-btn" :disabled="busy" @click="selected=null;retry=null;error=''">Close</button>
        <button v-for="step in steps(selected.order)" :key="step" class="ed-btn" :class="{primary:step==='completed'}" :disabled="busy || !Store.state.online" @click="transition(step)">{{ step==='completed'?'Complete order':`Mark ${labels[step].toLowerCase()}` }}</button>
        <button v-if="selected.order.status==='completed' && canReopen" class="ed-btn" :disabled="busy || !Store.state.online" @click="transition('pending')">Reopen</button>
      </template>
    </Modal>
  </div>
</template>
