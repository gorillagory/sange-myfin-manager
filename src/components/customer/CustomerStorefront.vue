<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import CustomerAccountPanel from './CustomerAccountPanel.vue';
import CustomerCart from './CustomerCart.vue';
import {
  addPublicCartLine, cartRequestItems, customerOrderSubmission, formatCustomerMoney, normalizeStorefront,
  publicCartLine, setPublicCartQuantity,
} from '../../domain/customerOrdering';
import { loadCustomerAccount, loadStorefront, quoteCustomerOrder, submitCustomerOrder } from '../../services/customerOrdering';

const route = useRoute(), router = useRouter();
const menu = ref(null), lines = ref([]), quote = ref(null), quoteToken = ref(''), loading = ref(true), busy = ref(false), placing = ref(false);
const error = ref(''), notice = ref(''), category = ref('All'), query = ref(''), selectedLocationId = ref('');
const serviceChoice = ref('pickup');
const reviewing = ref(false), cartOpen = ref(false), online = ref(navigator.onLine), variantChoices = reactive({});
const account = ref({ authenticated: false }), accountOpen = ref(false), accountLoading = ref(true);
const guest = reactive({ name: '', email: '', phone: '' });
const notes = ref('');
const locationToken = computed(() => String(route.query.locationToken || route.query.location || route.query.t || '').trim());
const storefront = computed(() => menu.value?.storefront || {});
const privacy = computed(() => storefront.value.privacy || {});
const locations = computed(() => (menu.value?.locations || []).filter(location => location.fulfillmentMode !== 'table'));
const selectedLocation = computed(() => menu.value?.location || locations.value.find(location => location.id === selectedLocationId.value) || null);
const lockedLocation = computed(() => Boolean(menu.value?.location));
const fulfillmentMode = computed(() => selectedLocation.value?.fulfillmentMode === 'both'
  ? (lockedLocation.value ? serviceChoice.value : 'pickup')
  : selectedLocation.value?.fulfillmentMode || 'pickup');
const categories = computed(() => ['All', ...new Set((menu.value?.products || []).map(product => product.category))]);
const visibleProducts = computed(() => (menu.value?.products || []).filter(product => {
  if (category.value !== 'All' && product.category !== category.value) return false;
  const needle = query.value.trim().toLowerCase();
  return !needle || [product.name, product.description, product.category, product.subcategory].some(value => value.toLowerCase().includes(needle));
}));
const itemCount = computed(() => lines.value.reduce((sum, line) => sum + line.quantity, 0));
const orderBase = computed(() => ({
  ...(locationToken.value ? { locationToken: locationToken.value } : {}),
  ...(!lockedLocation.value && selectedLocationId.value ? { locationId: selectedLocationId.value } : {}),
  serviceMode: fulfillmentMode.value,
  items: cartRequestItems(lines.value),
}));
let loadRequest = 0, retry = null;

function accountContact(value = account.value) {
  return {
    name: value?.profile?.displayName || value?.customer?.displayName || '',
    email: value?.customer?.email || '',
    phone: value?.profile?.phone || '',
  };
}

function applyAccount(next, force = false) {
  const previous = accountContact();
  account.value = next?.authenticated ? next : { authenticated: false };
  if (account.value.authenticated) {
    const contact = accountContact(account.value);
    if (force || !guest.name) guest.name = contact.name;
    if (force || !guest.email) guest.email = contact.email;
    if (force || !guest.phone) guest.phone = contact.phone;
  } else if (force) {
    if (guest.name === previous.name) guest.name = '';
    if (guest.email === previous.email) guest.email = '';
    if (guest.phone === previous.phone) guest.phone = '';
  }
}

async function refreshAccount() {
  accountLoading.value = true;
  try { applyAccount(await loadCustomerAccount()); }
  catch { applyAccount({ authenticated: false }); }
  finally { accountLoading.value = false; }
}

function accountChanged(next) { applyAccount(next, true); }

function friendlyError(caught, fallback) {
  if (caught?.network) return 'You appear to be offline. Reconnect and try again.';
  const messages = {
    not_found: 'Online ordering is not available at this address.',
    storefront_unavailable: 'This shop is not accepting online orders right now.',
    storefront_not_found: 'This shop is not accepting online orders right now.',
    location_not_found: 'This shop QR is no longer active. Ask a staff member for a current code.',
    invalid_shop_location: 'This shop QR or collection location is no longer active.',
    item_unavailable: 'One of your items is no longer available. Refresh the menu and review your order.',
    menu_item_unavailable: 'One of your items is no longer available. Refresh the menu and review your order.',
    order_item_limit: 'This order has too many different items. Remove a few and try again.',
    item_quantity_limit: 'One of the quantities is above the shop limit.',
    order_value_limit: 'This order is above the shop limit. Reduce it and try again.',
    pickup_contact_required: 'Add an email address or phone number so the shop can contact you.',
    quote_changed: 'The menu changed while you were ordering. Review the updated total before placing it.',
    order_limit: 'This order is above the shop limit. Reduce the quantities and try again.',
    rate_limited: 'There have been too many attempts. Wait a moment and try again.',
  };
  return messages[caught?.message] || fallback;
}

async function load() {
  const epoch = ++loadRequest; loading.value = true; error.value = '';
  try {
    const result = normalizeStorefront(await loadStorefront(locationToken.value));
    if (epoch !== loadRequest) return;
    menu.value = result;
    const publicPickup = result.locations.find(location => location.fulfillmentMode !== 'table');
    selectedLocationId.value = result.location?.id || publicPickup?.id || '';
    serviceChoice.value = result.location?.fulfillmentMode === 'both' ? 'table' : result.location?.fulfillmentMode || 'pickup';
  } catch (caught) { if (epoch === loadRequest) error.value = friendlyError(caught, 'The menu could not be loaded. Try again shortly.'); }
  finally { if (epoch === loadRequest) loading.value = false; }
}

function add(product) {
  error.value = ''; notice.value = '';
  try {
    const chosen = product.variants.length ? variantChoices[product.id] || '' : '';
    lines.value = addPublicCartLine(lines.value, publicCartLine(product, chosen));
    quote.value = null; quoteToken.value = ''; reviewing.value = false;
    notice.value = `${product.name} added to your order.`;
    if (window.innerWidth < 921) cartOpen.value = true;
  } catch (caught) { error.value = caught.message; }
}
function setQuantity(key, value) {
  try { lines.value = setPublicCartQuantity(lines.value, key, value); quote.value = null; quoteToken.value = ''; reviewing.value = false; retry = null; }
  catch (caught) { error.value = caught.message; }
}
async function review() {
  if (!online.value) { error.value = 'Reconnect before reviewing this order.'; return; }
  if (!lines.value.length) return;
  if (locations.value.length && !selectedLocation.value) { error.value = 'Choose where you will collect this order.'; return; }
  busy.value = true; error.value = '';
  try {
    const result = await quoteCustomerOrder(orderBase.value);
    if (!result.quote || !result.quoteToken) throw new Error('invalid_quote_response');
    quote.value = result.quote;
    quoteToken.value = result.quoteToken;
    reviewing.value = true;
    cartOpen.value = false;
  } catch (caught) { error.value = friendlyError(caught, 'The shop could not confirm this order. Review the items and try again.'); }
  finally { busy.value = false; }
}
async function placeOrder() {
  if (placing.value || !quote.value || !quoteToken.value) return;
  let body;
  try { body = customerOrderSubmission({ order: orderBase.value, quoteToken: quoteToken.value, fulfillmentMode: fulfillmentMode.value, guest, notes: notes.value }); }
  catch (caught) { error.value = caught.message; return; }
  const signature = JSON.stringify(body);
  if (!retry || retry.signature !== signature) retry = { signature, requestId: crypto.randomUUID() };
  placing.value = true; error.value = '';
  try {
    const result = await submitCustomerOrder(body, retry.requestId);
    const code = result.order?.code;
    if (!code) throw new Error('invalid_order_response');
    retry = null; lines.value = []; quote.value = null; quoteToken.value = ''; reviewing.value = false;
    await router.replace(`/order/${encodeURIComponent(code)}`);
  } catch (caught) {
    if (caught?.message === 'quote_changed') {
      retry = null;
      try {
        const updated = await quoteCustomerOrder(orderBase.value);
        if (!updated.quote || !updated.quoteToken) throw new Error('invalid_quote_response');
        quote.value = updated.quote; quoteToken.value = updated.quoteToken;
        error.value = 'The menu or total changed. Review the updated quote before placing your order.';
      } catch (refreshError) {
        quote.value = null; quoteToken.value = '';
        error.value = friendlyError(refreshError, 'The updated quote is unavailable. Return to the menu and try again.');
      }
    } else error.value = friendlyError(caught, 'The order was not confirmed. Retry this same order; it will not be placed twice.');
  }
  finally { placing.value = false; }
}
function closeReview() { if (!placing.value) reviewing.value = false; }
function networkChange() { online.value = navigator.onLine; }
watch(locationToken, () => { menu.value = null; lines.value = []; quote.value = null; quoteToken.value = ''; load(); });
watch(selectedLocationId, () => { quote.value = null; quoteToken.value = ''; reviewing.value = false; retry = null; });
watch(serviceChoice, () => { quote.value = null; quoteToken.value = ''; reviewing.value = false; retry = null; });
onMounted(() => { load(); refreshAccount(); window.addEventListener('online', networkChange); window.addEventListener('offline', networkChange); });
onBeforeUnmount(() => { loadRequest++; window.removeEventListener('online', networkChange); window.removeEventListener('offline', networkChange); });
</script>

<template>
  <div class="customer-shell">
    <header class="customer-nav"><a href="/shop" class="customer-wordmark"><i aria-hidden="true"></i> myfin <small>order</small></a>
      <div class="customer-nav-actions"><button type="button" class="customer-account" :aria-expanded="accountOpen" @click="accountOpen=true"><span aria-hidden="true">◎</span> {{ account.authenticated ? (account.profile?.displayName || account.customer?.displayName || 'Account') : 'Sign in' }} <small v-if="account.authenticated && account.loyalty?.enabled">{{ account.loyalty.stampBalance || 0 }} stamps</small></button>
        <button type="button" class="customer-mobile-cart" :aria-expanded="cartOpen" @click="cartOpen=!cartOpen">Order <b>{{ itemCount }}</b></button></div></header>

    <main v-if="loading" class="customer-state" role="status"><span class="customer-loader"></span><h1>Opening the menu…</h1></main>
    <main v-else-if="!menu" class="customer-state"><span class="customer-state-mark">!</span><h1>Menu unavailable</h1><p>{{ error }}</p><button type="button" @click="load">Try again</button></main>
    <main v-else class="customer-main">
      <section class="customer-hero"><div><span class="customer-kicker">ORDER AHEAD / PAY AT THE COUNTER</span><h1>{{ storefront.name }}</h1><p>{{ storefront.description || 'Choose your favourites, then collect and pay at the shop.' }}</p></div>
        <div class="customer-context"><span class="customer-kicker">COLLECT FROM</span>
          <strong v-if="lockedLocation">{{ selectedLocation?.name }}</strong>
          <select v-else-if="locations.length" v-model="selectedLocationId" aria-label="Collection location"><option v-for="place in locations" :key="place.id" :value="place.id">{{ place.name }} · Pickup</option></select>
          <strong v-else>Shop counter</strong>
          <div v-if="lockedLocation && selectedLocation?.fulfillmentMode === 'both'" class="customer-service-choice" aria-label="How would you like this order?">
            <button type="button" :class="{active:serviceChoice==='table'}" :aria-pressed="serviceChoice==='table'" @click="serviceChoice='table'">At this table</button>
            <button type="button" :class="{active:serviceChoice==='pickup'}" :aria-pressed="serviceChoice==='pickup'" @click="serviceChoice='pickup'">Collect at counter</button>
          </div>
          <small>{{ fulfillmentMode === 'table' ? 'We will bring the accepted order to this table.' : 'Staff will prepare after accepting your order.' }}</small></div>
      </section>

      <div v-if="!online" class="customer-banner warning">You are offline. The menu remains visible, but an order cannot be placed until you reconnect.</div>
      <div v-if="error" class="customer-banner error" role="alert">{{ error }} <button type="button" aria-label="Dismiss" @click="error=''">×</button></div>
      <div v-else-if="notice" class="customer-sr-status" role="status">{{ notice }}</div>

      <section class="customer-tools"><label><span aria-hidden="true">⌕</span><input v-model="query" type="search" placeholder="Search the menu" aria-label="Search the menu"></label>
        <div class="customer-categories" aria-label="Menu categories"><button v-for="item in categories" :key="item" type="button" :class="{active:category===item}" :aria-pressed="category===item" @click="category=item">{{ item }}</button></div></section>

      <div class="customer-order-layout">
        <section class="customer-products" aria-live="polite">
          <article v-for="product in visibleProducts" :key="product.id" class="customer-product" :class="{unavailable:!product.available}">
            <div v-if="product.imageUrl" class="customer-product-image"><img :src="product.imageUrl" :alt="product.name" referrerpolicy="no-referrer"></div>
            <div class="customer-product-copy"><div><span>{{ product.subcategory || product.category }}</span><h2>{{ product.name }}</h2><p v-if="product.description">{{ product.description }}</p></div>
              <div class="customer-product-buy"><strong>{{ product.variants.length ? `From ${formatCustomerMoney(Math.min(...product.variants.map(item=>item.price)), storefront.currency)}` : formatCustomerMoney(product.price, storefront.currency) }}</strong>
                <template v-if="product.available">
                  <select v-if="product.variants.length" v-model="variantChoices[product.id]" :aria-label="`Choose an option for ${product.name}`"><option value="" disabled>Choose an option</option><option v-for="option in product.variants" :key="option.id" :value="option.id" :disabled="!option.available">{{ option.name }} · {{ formatCustomerMoney(option.price, storefront.currency) }}{{ option.available ? '' : ' · Sold out' }}</option></select>
                  <button type="button" @click="add(product)">Add <span aria-hidden="true">+</span></button>
                </template><span v-else class="customer-sold-out">Sold out</span>
              </div></div>
          </article>
          <div v-if="!visibleProducts.length" class="customer-no-results"><strong>No menu items found</strong><p>Try another search or category.</p></div>
        </section>
        <div class="customer-cart-wrap" :class="{open:cartOpen}"><button type="button" class="customer-cart-close" aria-label="Close order" @click="cartOpen=false">×</button><CustomerCart :lines="lines" :currency="storefront.currency" :quote="quote" :busy="busy" @quantity="setQuantity" @review="review" /></div>
      </div>
      <footer class="customer-footer"><p>{{ storefront.pickupInstructions || 'Payment is collected at the counter. Placing an order does not charge you.' }}</p><p>Order as a guest or use one MyFin customer account across participating finn3 shops. Each workspace keeps its own loyalty balance. <RouterLink to="/privacy">Privacy notice</RouterLink></p></footer>
    </main>

    <div v-if="reviewing" class="customer-review-backdrop" role="presentation" @mousedown.self="closeReview">
      <section class="customer-review" role="dialog" aria-modal="true" aria-labelledby="customer-review-title">
        <header><div><span class="customer-kicker">REVIEW</span><h2 id="customer-review-title">Place your order</h2></div><button type="button" aria-label="Close" :disabled="placing" @click="closeReview">×</button></header>
        <div class="customer-review-body">
          <div class="customer-review-location"><span>Collection</span><strong>{{ selectedLocation?.name || 'Shop counter' }}</strong><small>{{ fulfillmentMode === 'table' ? 'Table service after staff acceptance' : 'Prepare after staff acceptance · pay on collection' }}</small></div>
          <div class="customer-review-lines"><div v-for="item in quote?.items || []" :key="`${item.productId}:${item.variantId || ''}`"><span>{{ item.quantity }} × {{ item.name || item.description }}<small v-if="item.variantName || item.variant">{{ item.variantName || item.variant }}</small></span><strong>{{ formatCustomerMoney(item.lineTotal ?? item.total ?? item.unitPrice * item.quantity, quote.currency) }}</strong></div></div>
          <dl class="customer-review-totals"><div><dt>Subtotal</dt><dd>{{ formatCustomerMoney(quote.subtotal, quote.currency) }}</dd></div><div v-if="quote.tax"><dt>Tax</dt><dd>{{ formatCustomerMoney(quote.tax, quote.currency) }}</dd></div><div v-if="quote.rounding"><dt>Rounding</dt><dd>{{ formatCustomerMoney(quote.rounding, quote.currency) }}</dd></div><div class="total"><dt>Total due at counter</dt><dd>{{ formatCustomerMoney(quote.total, quote.currency) }}</dd></div></dl>
          <div class="customer-form-grid"><label><span>Name {{ fulfillmentMode === 'table' ? '(optional)' : '*' }}</span><input v-model="guest.name" autocomplete="name" maxlength="120" placeholder="Name for the order"></label><label><span>Phone <small>{{ fulfillmentMode === 'table' ? 'optional' : 'phone or email *' }}</small></span><input v-model="guest.phone" type="tel" autocomplete="tel" maxlength="30" placeholder="+60…"></label><label><span>Email <small>{{ fulfillmentMode === 'table' ? 'optional' : 'phone or email *' }}</small></span><input v-model="guest.email" type="email" autocomplete="email" maxlength="254" placeholder="you@example.com"></label><label class="wide"><span>Order notes (optional)</span><textarea v-model="notes" maxlength="500" placeholder="Preparation notes for the shop"></textarea></label></div>
          <p v-if="fulfillmentMode !== 'table'" class="customer-contact-note">For pickup orders, add a phone number or email so the shop can contact you about availability. This does not opt you into marketing.<template v-if="account.authenticated"> Your account profile has prefilled these details.</template></p>
          <p v-else class="customer-contact-note">Contact details are optional for this table order. They are not used for marketing.</p>
          <section v-if="privacy.noticeEn && privacy.noticeMs" class="customer-privacy-notice" aria-labelledby="order-privacy-title">
            <h3 id="order-privacy-title">Your order information / Maklumat pesanan anda</h3>
            <p><strong>{{ privacy.controllerName }}</strong> · {{ privacy.controllerContact }}</p>
            <p lang="en">{{ privacy.noticeEn }}</p><p lang="ms">{{ privacy.noticeMs }}</p>
            <p v-if="privacy.guestContactRetentionDays" lang="en">Contact details and freeform order notes are removed {{ privacy.guestContactRetentionDays }} days after the order closes.</p>
            <p v-if="privacy.guestContactRetentionDays" lang="ms">Butiran hubungan dan nota pesanan bebas dipadam {{ privacy.guestContactRetentionDays }} hari selepas pesanan ditutup.</p>
            <a :href="privacy.noticeUrl" target="_blank" rel="noopener noreferrer">Read the full privacy notice / Baca notis privasi penuh ↗</a>
          </section>
          <div v-if="error" class="customer-banner error" role="alert">{{ error }}</div>
        </div>
        <footer><button type="button" :disabled="placing" @click="closeReview">Back to menu</button><button type="button" class="customer-primary" :disabled="placing || !online || !quoteToken" @click="placeOrder">{{ placing ? 'Placing order…' : 'Place order · pay later' }} <span aria-hidden="true">→</span></button></footer>
      </section>
    </div>
    <CustomerAccountPanel :open="accountOpen" :account="account" :loading="accountLoading || loading" :privacy="privacy" @close="accountOpen=false" @account-change="accountChanged" />
  </div>
</template>

<style scoped>
.customer-shell{--customer-ink:#15382c;--customer-muted:#68776f;--customer-line:#d8dfd8;--customer-line-strong:#aebbb2;--customer-tint:#f1f5ed;--customer-accent:#17624d;--customer-accent-dark:#104d3c;min-height:100dvh;background:#fbfcf8;color:var(--customer-ink);font-family:Inter,ui-sans-serif,system-ui,sans-serif}.customer-nav{height:78px;display:flex;align-items:center;justify-content:space-between;max-width:1440px;margin:auto;padding:0 42px;border-bottom:1px solid var(--customer-line)}.customer-wordmark{display:flex;align-items:center;gap:8px;color:var(--customer-ink);text-decoration:none;font:bold 21px Georgia,serif}.customer-wordmark i{width:13px;height:13px;background:var(--customer-accent);box-shadow:6px -6px 0 #8dad9c}.customer-wordmark small{font:500 10px Inter,sans-serif;letter-spacing:.15em}.customer-nav-actions{display:flex;align-items:center;gap:10px}.customer-account,.customer-mobile-cart{border:1px solid var(--customer-line);background:white;color:var(--customer-ink);border-radius:999px;min-height:38px;padding:0 14px;font-size:11px;font-weight:650}.customer-account:disabled{opacity:.65}.customer-account small{margin-left:6px;color:var(--customer-muted);font-size:8px;text-transform:uppercase;letter-spacing:.1em}.customer-mobile-cart{display:none}.customer-mobile-cart b{display:inline-grid;place-items:center;background:var(--customer-accent);color:#fff;border-radius:50%;min-width:20px;height:20px;margin-left:6px}.customer-main{max-width:1440px;margin:auto;padding:0 42px}.customer-hero{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(260px,.55fr);gap:40px;align-items:end;padding:54px 0 40px}.customer-kicker{font-size:10px;letter-spacing:.18em;font-weight:750;color:var(--customer-muted)}.customer-hero h1{font:400 clamp(48px,7vw,88px)/.95 Georgia,serif;margin:12px 0 18px;letter-spacing:-.035em}.customer-hero>div:first-child p{max-width:650px;color:var(--customer-muted);font-size:14px;line-height:1.65;margin:0}.customer-context{border-left:1px solid var(--customer-line);padding:8px 0 8px 28px;display:flex;flex-direction:column;align-items:start;gap:8px}.customer-context strong{font:400 22px Georgia,serif}.customer-context select{width:100%;min-height:42px;border:1px solid var(--customer-line);background:white;border-radius:7px;padding:0 11px;color:var(--customer-ink)}.customer-context small{font-size:10px;line-height:1.5;color:var(--customer-muted)}.customer-banner{position:relative;padding:13px 42px 13px 15px;margin-bottom:18px;border-radius:8px;font-size:12px;border:1px solid}.customer-banner.warning{background:#fff9e9;border-color:#ead695;color:#6d5318}.customer-banner.error{background:#fff2ee;border-color:#e7c5bb;color:#813b29}.customer-banner button{position:absolute;right:12px;top:7px;border:0;background:none;color:inherit;font-size:22px}.customer-tools{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 0;border-block:1px solid var(--customer-line)}.customer-tools>label{position:relative;display:flex;align-items:center;min-width:240px}.customer-tools>label span{position:absolute;left:13px;color:var(--customer-muted);font-size:18px}.customer-tools input{width:100%;height:42px;border:1px solid var(--customer-line);border-radius:999px;padding:0 16px 0 38px;background:white;color:var(--customer-ink)}.customer-categories{display:flex;gap:7px;overflow:auto;padding:3px}.customer-categories button{white-space:nowrap;border:1px solid var(--customer-line);background:white;color:var(--customer-muted);border-radius:999px;padding:9px 14px;font-size:11px}.customer-categories button.active{border-color:var(--customer-accent);background:var(--customer-accent);color:#fff}.customer-order-layout{display:grid;grid-template-columns:minmax(0,1fr) 355px;gap:30px;padding:30px 0 55px}.customer-products{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-content:start}.customer-product{min-height:205px;display:grid;grid-template-columns:130px minmax(0,1fr);background:white;border:1px solid var(--customer-line);border-radius:14px;overflow:hidden;transition:border-color .15s,transform .15s}.customer-product:hover{border-color:var(--customer-line-strong);transform:translateY(-1px)}.customer-product-image{background:var(--customer-tint);min-height:205px}.customer-product-image img{width:100%;height:100%;object-fit:cover}.customer-product-copy{display:flex;flex-direction:column;justify-content:space-between;padding:19px;min-width:0}.customer-product-copy>div:first-child>span{font-size:9px;text-transform:uppercase;letter-spacing:.12em;color:var(--customer-muted)}.customer-product h2{font:400 23px/1.05 Georgia,serif;margin:7px 0 8px}.customer-product p{font-size:11px;line-height:1.5;color:var(--customer-muted);margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.customer-product-buy{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;margin-top:18px}.customer-product-buy strong{grid-column:1/-1;font-size:12px}.customer-product-buy select{min-width:0;width:100%;height:36px;border:1px solid var(--customer-line);background:#fff;border-radius:6px;padding:0 8px;color:var(--customer-ink);font-size:11px}.customer-product-buy button{display:flex;align-items:center;gap:12px;height:36px;border:0;background:var(--customer-accent);color:#fff;border-radius:6px;padding:0 12px;font-size:11px;font-weight:700}.customer-product-buy button:hover{background:var(--customer-accent-dark)}.customer-sold-out{grid-column:1/-1;font-size:11px;font-weight:700;color:#9a4936}.customer-product.unavailable{background:#f7f7f3}.customer-product.unavailable .customer-product-copy>div:first-child{opacity:.6}.customer-no-results{grid-column:1/-1;min-height:250px;display:grid;place-content:center;justify-items:center;border:1px dashed var(--customer-line);border-radius:14px;color:var(--customer-muted)}.customer-no-results p{font-size:12px}.customer-cart-close{display:none}.customer-footer{display:flex;justify-content:space-between;gap:30px;padding:24px 0 45px;border-top:1px solid var(--customer-line);color:var(--customer-muted);font-size:10px}.customer-footer p{max-width:530px}.customer-state{min-height:calc(100dvh - 78px);display:grid;place-content:center;justify-items:center;text-align:center;padding:30px}.customer-state h1{font:400 40px Georgia,serif;margin:18px 0 8px}.customer-state p{color:var(--customer-muted);max-width:420px}.customer-state button{border:0;background:var(--customer-accent);color:#fff;border-radius:7px;padding:11px 17px}.customer-state-mark{display:grid;place-items:center;width:46px;height:46px;border-radius:50%;background:#fff0eb;color:#923d29;font-size:22px}.customer-loader{width:34px;height:34px;border:3px solid var(--customer-line);border-top-color:var(--customer-accent);border-radius:50%;animation:customer-spin .7s linear infinite}.customer-sr-status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.customer-review-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:18px;background:#102b23a8;backdrop-filter:blur(4px)}.customer-review{width:min(680px,100%);max-height:calc(100dvh - 36px);display:flex;flex-direction:column;background:#fff;border-radius:18px;box-shadow:0 30px 100px #102b2355;overflow:hidden}.customer-review>header{display:flex;align-items:start;justify-content:space-between;padding:25px 28px;border-bottom:1px solid var(--customer-line)}.customer-review h2{font:400 31px Georgia,serif;margin:6px 0 0}.customer-review>header button{border:0;background:none;font-size:28px;color:var(--customer-muted)}.customer-review-body{overflow:auto;padding:25px 28px}.customer-review-location{display:grid;grid-template-columns:1fr auto;gap:4px 20px;padding:15px;background:var(--customer-tint);border-radius:8px;font-size:11px}.customer-review-location strong{font-size:13px}.customer-review-location small{grid-column:1/-1;color:var(--customer-muted)}.customer-review-lines{margin-top:18px}.customer-review-lines>div{display:flex;justify-content:space-between;gap:20px;padding:10px 0;font-size:12px}.customer-review-lines small{display:block;color:var(--customer-muted);margin-top:3px}.customer-review-totals{border-top:1px solid var(--customer-line);padding-top:13px;margin:8px 0 23px}.customer-review-totals>div{display:flex;justify-content:space-between;padding:5px 0;font-size:11px;color:var(--customer-muted)}.customer-review-totals dd{margin:0}.customer-review-totals .total{font-size:17px;color:var(--customer-ink);font-weight:700;padding-top:11px}.customer-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.customer-form-grid label{display:flex;flex-direction:column;gap:6px;font-size:11px;font-weight:650}.customer-form-grid label:first-child{grid-column:1/-1}.customer-form-grid .wide{grid-column:1/-1}.customer-form-grid :is(input,textarea){width:100%;border:1px solid var(--customer-line);border-radius:7px;background:#fff;padding:11px 12px;color:var(--customer-ink);font-size:16px}.customer-form-grid textarea{min-height:72px;resize:vertical}.customer-contact-note{font-size:10px;line-height:1.5;color:var(--customer-muted);margin:13px 0 0}.customer-review>footer{display:flex;justify-content:flex-end;gap:10px;padding:18px 28px;border-top:1px solid var(--customer-line);background:var(--customer-tint)}.customer-review>footer button{min-height:46px;border:1px solid var(--customer-line);border-radius:7px;background:#fff;color:var(--customer-ink);padding:0 16px;font-weight:650}.customer-review>footer .customer-primary{width:auto;min-width:220px;background:var(--customer-accent);color:#fff;border-color:var(--customer-accent);display:flex;align-items:center;justify-content:space-between}.customer-review>footer button:disabled{opacity:.5}@keyframes customer-spin{to{transform:rotate(360deg)}}
.customer-footer a{color:var(--customer-accent);font-weight:700}.customer-service-choice{display:flex;gap:6px;width:100%}.customer-service-choice button{flex:1;border:1px solid var(--customer-line);background:#fff;color:var(--customer-ink);border-radius:999px;padding:8px 10px;font-size:10px;font-weight:700}.customer-service-choice button.active{border-color:var(--customer-accent);background:var(--customer-accent);color:#fff}
.customer-form-grid label>span{display:flex;justify-content:space-between;gap:10px}.customer-form-grid label>span small{color:var(--customer-muted);font-size:9px;font-weight:500}.customer-privacy-notice{margin-top:16px;padding:14px;border:1px solid var(--customer-line);border-radius:8px;background:#f8faf6}.customer-privacy-notice h3{font:650 12px Inter,sans-serif;margin:0 0 8px}.customer-privacy-notice p{font-size:9px;line-height:1.5;color:var(--customer-muted);margin:5px 0}.customer-privacy-notice a{display:inline-block;margin-top:5px;color:var(--customer-accent);font-size:9px;font-weight:700}
@media(max-width:1150px){.customer-products{grid-template-columns:1fr}.customer-product{min-height:180px}.customer-product-image{min-height:180px}.customer-order-layout{grid-template-columns:minmax(0,1fr) 330px}}
@media(max-width:920px){.customer-nav,.customer-main{padding-inline:20px}.customer-mobile-cart{display:block}.customer-account{max-width:170px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.customer-account small{display:none}.customer-hero{grid-template-columns:1fr;padding-top:38px}.customer-context{border-left:0;border-top:1px solid var(--customer-line);padding:20px 0 0}.customer-tools{align-items:stretch;flex-direction:column}.customer-tools>label{width:100%}.customer-order-layout{display:block}.customer-cart-wrap{position:fixed;inset:0;z-index:500;background:#102b2399;padding:70px 14px 14px;visibility:hidden;opacity:0;transition:opacity .15s}.customer-cart-wrap.open{visibility:visible;opacity:1}.customer-cart-wrap :deep(.customer-cart){max-height:calc(100dvh - 84px);overflow:auto}.customer-cart-close{display:grid;position:absolute;right:22px;top:20px;width:40px;height:40px;place-items:center;border:1px solid #ffffff55;border-radius:50%;background:#102b23;color:white;font-size:25px}.customer-footer{flex-direction:column}}
@media(max-width:600px){.customer-nav{height:68px;padding-inline:14px}.customer-wordmark small{display:none}.customer-nav-actions{gap:6px}.customer-account,.customer-mobile-cart{padding-inline:10px}.customer-account{max-width:115px}.customer-main{padding-inline:14px}.customer-hero h1{font-size:50px}.customer-products{gap:10px}.customer-product{grid-template-columns:1fr;min-height:0}.customer-product-image{height:170px;min-height:0}.customer-product-copy{padding:17px}.customer-footer{padding-bottom:95px}.customer-review-backdrop{padding:0;align-items:end}.customer-review{max-height:94dvh;border-radius:18px 18px 0 0}.customer-review>header,.customer-review-body,.customer-review>footer{padding-inline:20px}.customer-review>footer{display:grid;grid-template-columns:1fr 1.6fr}.customer-review>footer button,.customer-review>footer .customer-primary{min-width:0;width:100%;padding-inline:10px}.customer-form-grid{grid-template-columns:1fr}.customer-form-grid label:first-child,.customer-form-grid .wide{grid-column:auto}.customer-context select{font-size:16px}}
</style>
