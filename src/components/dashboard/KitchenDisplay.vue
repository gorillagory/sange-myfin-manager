<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Store } from '../../store';
import { api } from '../../services/api';
import { codeImage } from '../../services/printing';
import {
  KITCHEN_LANES,
  findKitchenTicket,
  kitchenLabelCode,
  kitchenStations,
  kitchenStickerLines,
  kitchenTickets,
} from '../../domain/kitchenOrders';
import Icon from '../ui/EditionIcon.vue';
import Modal from '../ui/EditionModal.vue';

const requests = ref([]), paid = ref([]), loading = ref(false), actionBusy = ref('');
const error = ref(''), query = ref(''), station = ref(''), highlighted = ref('');
const lastUpdated = ref(null), transitionRetry = ref(null);
const printTicket = ref(null), printMode = ref('order'), printQr = ref('');
const camera = ref(false), video = ref(null);
const truncated = ref(false);
const companyId = computed(() => Store.state.selectedCompany?.id || '');
const sources = computed(() => ({ requests:requests.value, paid:paid.value, products:Store.state.products || [] }));
const stations = computed(() => kitchenStations(sources.value));
const allTickets = computed(() => kitchenTickets(sources.value));
const tickets = computed(() => kitchenTickets({ ...sources.value,station:station.value,query:query.value }));
const lanes = computed(() => Object.fromEntries(KITCHEN_LANES.map(lane => [lane,tickets.value.filter(ticket => ticket.lane === lane)])));
const stickerLines = computed(() => printTicket.value ? kitchenStickerLines(printTicket.value) : []);
const laneCopy = {
  pending:{ title:'Pending',description:'Accepted and ready to start',empty:'No accepted orders waiting.' },
  preparing:{ title:'Preparing',description:'Being prepared now',empty:'Nothing is being prepared.' },
  ready:{ title:'Ready',description:'Awaiting collection or completion',empty:'No orders are waiting for collection.' },
};
let timer, refreshTask = null, generation = 0, highlightTimer, scanControls = null, scanRequest = 0;

const base = suffix => `/companies/${encodeURIComponent(companyId.value)}${suffix}`;
const stamp = value => value ? new Intl.DateTimeFormat('en-MY', { timeZone:'Asia/Kuala_Lumpur',hour:'numeric',minute:'2-digit' }).format(new Date(value)) : '—';
function age(value) {
  if (!value) return '—';
  const minutes = Math.max(0,Math.floor((Date.now()-new Date(value).getTime())/60000));
  return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes/60)}h ${minutes%60}m`;
}
const itemText = item => `${item.quantity} × ${item.description}${item.variant ? ` · ${item.variant}` : ''}`;
const actionLabel = ticket => ticket.nextStatus === 'preparing' ? 'Start preparing'
  : ticket.nextStatus === 'ready' ? 'Mark ready' : ticket.nextStatus === 'completed' ? 'Complete' : '';
const domId = ticket => `kitchen-${ticket.kind}-${ticket.id}`;

async function refresh({ announce=false } = {}) {
  if (!companyId.value || !Store.can('checkout') || !Store.state.online) return;
  if (refreshTask) return refreshTask;
  const company = companyId.value, epoch = ++generation;
  if (!requests.value.length && !paid.value.length) loading.value = true;
  const task = (async () => {
    try {
      const [requestPage,paidPage] = await Promise.all([
        api(base('/customer-orders?view=active&limit=200')),
        api(base('/orders?view=active&limit=200')),
      ]);
      if (epoch !== generation || company !== companyId.value) return;
      requests.value = requestPage.rows || [];
      paid.value = paidPage.rows || [];
      truncated.value = Number(requestPage.counts?.active || 0) > requests.value.length ||
        Number(paidPage.counts?.active || 0) > paid.value.length;
      lastUpdated.value = new Date();
      error.value = '';
      if (announce) Store.notify('Kitchen display refreshed.');
    } catch (caught) {
      if (epoch === generation) error.value = caught.message || 'The kitchen queue could not be refreshed.';
    } finally {
      if (epoch === generation) loading.value = false;
    }
  })();
  refreshTask = task;
  try { await task; } finally { if (refreshTask === task) refreshTask = null; }
  return task;
}

function foreground() {
  if (document.visibilityState === 'visible') refresh();
}

async function move(ticket) {
  if (!ticket.nextStatus || actionBusy.value || !Store.state.online) return;
  const saved = transitionRetry.value;
  const change = saved?.key === ticket.key && saved?.status === ticket.nextStatus
    ? saved : { key:ticket.key,status:ticket.nextStatus,requestId:crypto.randomUUID(),expectedVersion:ticket.version };
  actionBusy.value = ticket.key; transitionRetry.value = change; error.value = '';
  const collection = ticket.kind === 'request' ? 'customer-orders' : 'orders';
  try {
    await api(base(`/${collection}/${encodeURIComponent(ticket.id)}/transitions`), {
      method:'POST',body:{ requestId:change.requestId,expectedVersion:change.expectedVersion,status:change.status,note:'Kitchen display' },
    });
    transitionRetry.value = null;
    if (refreshTask) await refreshTask;
    await refresh();
    Store.notify(`${ticket.code} · ${change.status === 'completed' ? 'completed' : change.status}.`);
  } catch (caught) {
    if (caught.status === 409) {
      transitionRetry.value = null;
      if (refreshTask) await refreshTask;
      await refresh();
      error.value = `${ticket.code} changed on another device. The kitchen board now shows its latest state.`;
    } else error.value = 'The status change was not confirmed. Retry the same action; it will not be recorded twice.';
  } finally { actionBusy.value = ''; }
}

function scan() {
  const ticket = findKitchenTicket(allTickets.value,query.value);
  if (!ticket) { error.value = 'No active kitchen order matches that scanned code.'; return; }
  error.value = ''; station.value = ''; query.value = ticket.code; highlighted.value = ticket.key;
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => { highlighted.value = ''; },6000);
  nextTick(() => document.getElementById(domId(ticket))?.scrollIntoView({ behavior:'smooth',block:'center' }));
}

async function startCamera() {
  if (camera.value) return;
  const request = ++scanRequest;
  error.value = ''; camera.value = true;
  await nextTick();
  try {
    // Keep the decoder out of the normal kitchen bundle until a tablet camera is opened.
    const { BrowserMultiFormatReader } = await import('@zxing/browser');
    if (!camera.value || request !== scanRequest) return;
    const reader = new BrowserMultiFormatReader();
    const controls = await reader.decodeFromConstraints({ video:{ facingMode:{ ideal:'environment' } } },video.value,result => {
      const code = result?.getText?.()?.trim();
      if (!code || !camera.value || request !== scanRequest) return;
      stopCamera(); query.value = code; scan();
    });
    if (!camera.value || request !== scanRequest) controls.stop(); else scanControls = controls;
  } catch {
    if (request !== scanRequest) return;
    stopCamera();
    error.value = 'Camera scanning is unavailable. Use a USB/Bluetooth scanner or enter the order code manually.';
  }
}
function stopCamera() {
  scanRequest++; camera.value = false; scanControls?.stop(); scanControls = null;
  for (const track of video.value?.srcObject?.getTracks?.() || []) track.stop();
  if (video.value) video.value.srcObject = null;
}

async function openPrint(ticket) {
  error.value = '';
  try {
    printQr.value = await codeImage(kitchenLabelCode(ticket),'qr');
    printTicket.value = ticket; printMode.value = 'order';
  } catch (caught) { error.value = caught.message || 'The order label could not be prepared.'; }
}
function cleanupPrint() { document.body.classList.remove('ed-print-kitchen'); }
async function print() {
  document.body.classList.add('ed-print-kitchen');
  await nextTick();
  window.addEventListener('afterprint',cleanupPrint,{ once:true });
  window.print();
  setTimeout(cleanupPrint,1500);
}
function closePrint() { cleanupPrint(); printTicket.value = null; printQr.value = ''; }

watch(companyId, () => {
  generation++; refreshTask = null; requests.value = []; paid.value = []; truncated.value = false; station.value = ''; query.value = '';
  if (document.visibilityState === 'visible') refresh();
});
watch(stations, values => { if (station.value && !values.includes(station.value)) station.value = ''; });
onMounted(() => {
  refresh();
  timer = window.setInterval(foreground,7000);
  document.addEventListener('visibilitychange',foreground);
  window.addEventListener('focus',foreground);
});
onBeforeUnmount(() => {
  generation++; window.clearInterval(timer); clearTimeout(highlightTimer); cleanupPrint(); stopCamera();
  document.removeEventListener('visibilitychange',foreground);
  window.removeEventListener('focus',foreground);
});
</script>

<template>
  <div v-if="Store.can('checkout')" class="ed-page mf-kitchen-page">
    <header class="ed-page-head"><div><div class="ed-eyebrow">WORKSPACE / KITCHEN DISPLAY</div><h1>Keep every station moving.</h1><p>Accepted pickup requests and paid counter orders share one live preparation board.</p></div><div class="ed-actions"><span class="ed-status" :class="{offline:!Store.state.online}">{{ Store.state.online?(lastUpdated?`Updated ${stamp(lastUpdated)}`:'Connecting…'):'Offline' }}</span><button class="ed-btn" :disabled="loading||!Store.state.online" @click="refresh({announce:true})"><Icon name="clock"/>Refresh</button><router-link class="ed-btn" to="/orders">Order history</router-link></div></header>
    <div v-if="!Store.state.online" class="ed-notice warning"><Icon name="cloud"/><div><strong>The kitchen board needs a connection.</strong>Open orders remain durable on the server. Reconnect this tablet to refresh or change their status.</div></div>
    <div v-if="truncated" class="ed-notice warning"><Icon name="alert"/><div><strong>The live board reached its 200-order safety limit.</strong>Use Sales Orders to review the overflow before moving kitchen statuses.</div></div>
    <p v-if="error" class="ed-alert" role="alert">{{ error }}</p>
    <div class="mf-kitchen-tools">
      <label class="ed-search"><Icon name="qr"/><input v-model.trim="query" class="ed-input" aria-label="Scan or find an active order" placeholder="Scan order QR or search code, customer, item" @keydown.enter="scan"></label>
      <button class="ed-btn" :disabled="!query" @click="scan"><Icon name="search"/>Find</button><button class="ed-btn" @click="startCamera"><Icon name="qr"/>Camera</button>
      <small>USB and Bluetooth scanners work as keyboard input: scan, then send Enter.</small>
    </div>
    <div v-if="stations.length" class="mf-kitchen-stations" aria-label="Kitchen station filter"><button class="ed-btn small" :class="{primary:!station}" @click="station=''">All stations</button><button v-for="name in stations" :key="name" class="ed-btn small" :class="{primary:station===name}" @click="station=name">{{ name }}</button></div>
    <p v-if="station" class="ed-notice"><strong>{{ station }} station filter.</strong>&nbsp; Status buttons move the whole order because fulfillment is currently tracked per order, not per item.</p>
    <div v-if="loading&&!allTickets.length" class="ed-notice" role="status">Loading the shared kitchen queue…</div>
    <div class="mf-kitchen-board">
      <section v-for="lane in KITCHEN_LANES" :key="lane" class="mf-kitchen-lane" :aria-labelledby="`kitchen-${lane}`">
        <header><div><h2 :id="`kitchen-${lane}`">{{ laneCopy[lane].title }}</h2><small>{{ laneCopy[lane].description }}</small></div><span class="ed-pill" :class="{warning:lane==='pending',ready:lane==='ready'}">{{ lanes[lane].length }}</span></header>
        <article v-for="ticket in lanes[lane]" :id="domId(ticket)" :key="ticket.key" class="mf-kitchen-card" :class="{highlighted:highlighted===ticket.key}">
          <div class="mf-kitchen-card-head"><div><strong>{{ ticket.code }}</strong><small>{{ ticket.customerName }} · {{ ticket.source }}</small></div><div><span class="ed-pill" :class="{warning:ticket.kind==='request'}">{{ ticket.paymentLabel }}</span><small>{{ age(ticket.createdAt) }}</small></div></div>
          <ul><li v-for="(item,index) in ticket.items" :key="`${item.productId}:${item.variantId}:${index}`"><strong>{{ itemText(item) }}</strong><span>{{ item.station }}</span></li></ul>
          <div v-if="ticket.notes" class="mf-kitchen-note"><Icon name="edit"/>{{ ticket.notes }}</div>
          <div class="mf-kitchen-meta"><span v-if="ticket.dueAt">Due {{ stamp(ticket.dueAt) }}</span><span v-for="name in ticket.stations" :key="name">{{ name }}</span></div>
          <footer><button class="ed-btn small" :disabled="actionBusy===ticket.key" @click="openPrint(ticket)"><Icon name="printer"/>Labels</button><button v-if="ticket.nextStatus" class="ed-btn primary" :disabled="!!actionBusy||!Store.state.online" @click="move(ticket)">{{ actionBusy===ticket.key?'Saving…':actionLabel(ticket) }}</button><router-link v-else-if="ticket.kind==='request'" class="ed-btn primary" :to="{path:'/pos',query:{customerOrder:ticket.id}}">Collect payment</router-link></footer>
        </article>
        <div v-if="!loading&&!lanes[lane].length" class="mf-kitchen-empty">{{ laneCopy[lane].empty }}</div>
      </section>
    </div>
    <div v-if="!loading&&!tickets.length&&allTickets.length" class="ed-notice">No active orders match the current station or search.</div>
    <Modal v-if="camera" title="Scan an order label" @close="stopCamera"><video ref="video" class="mf-kitchen-camera" playsinline muted></video><p class="ed-muted">Point the rear camera at a MyFin order QR. Camera access is used only while this window is open.</p><template #actions><button class="ed-btn" @click="stopCamera">Cancel</button></template></Modal>
    <Modal v-if="printTicket" :title="`Print labels · ${printTicket.code}`" wide @close="closePrint">
      <div class="ed-notice"><Icon name="printer"/><div><strong>60 × 40 mm label layout</strong>Select the matching media in the browser print dialog. A normal office printer can scale it for review.</div></div>
      <div class="ed-tabs mf-kitchen-print-tabs" aria-label="Label type"><button :class="{active:printMode==='order'}" @click="printMode='order'">Order sticker</button><button :class="{active:printMode==='items'}" @click="printMode='items'">Item stickers ({{ stickerLines.length }})</button></div>
      <div class="mf-kitchen-print">
        <article v-if="printMode==='order'" class="mf-kitchen-label"><div><div class="mf-kitchen-label-code">{{ printTicket.code }}</div><strong>{{ printTicket.customerName }}</strong><small>{{ printTicket.source }}<template v-if="printTicket.dueAt"> · {{ stamp(printTicket.dueAt) }}</template></small><ul><li v-for="(item,index) in printTicket.items.slice(0,5)" :key="index">{{ itemText(item) }}</li></ul><small v-if="printTicket.items.length>5">+ {{ printTicket.items.length-5 }} more lines</small></div><img :src="printQr" :alt="`Order QR ${printTicket.code}`"></article>
        <article v-for="(item,index) in printMode==='items'?stickerLines:[]" :key="index" class="mf-kitchen-label"><div><div class="mf-kitchen-label-code">{{ printTicket.code }}</div><strong>{{ item.description }}</strong><small v-if="item.variant">{{ item.variant }}</small><small>{{ item.station }}<template v-if="item.copies===1&&item.quantity!==1"> · {{ item.quantity }} {{ item.unit }}</template><template v-else-if="item.copies>1"> · {{ item.copy }}/{{ item.copies }}</template></small></div><img :src="printQr" :alt="`Order QR ${printTicket.code}`"></article>
      </div>
      <p v-if="printMode==='items'&&stickerLines.length===100" class="ed-notice warning">This print is capped at 100 stickers. Split unusually large batches into separate prints.</p>
      <template #actions><button class="ed-btn" @click="closePrint">Cancel</button><button class="ed-btn primary" @click="print"><Icon name="printer"/>Print {{ printMode==='order'?'order sticker':'item stickers' }}</button></template>
    </Modal>
  </div>
</template>
