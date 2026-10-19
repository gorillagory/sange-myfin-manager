<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import CustomerAccountPanel from './CustomerAccountPanel.vue';
import CustomerCart from './CustomerCart.vue';
import {
  addPublicCartLine, cartRequestItems, customerOrderSubmission, formatCustomerMoney, normalizeStorefront,
  accessibleStorefrontText, customerProductDisplayPrice, deliveryOrderDetails, publicCartLine, publicCartSummary,
  setPublicCartQuantity, storefrontFontStack,
} from '../../domain/customerOrdering';
import { loadCustomerAccount, loadStorefront, quoteCustomerOrder, submitCustomerOrder } from '../../services/customerOrdering';

const route = useRoute(), router = useRouter();
const menu = ref(null), lines = ref([]), quote = ref(null), quoteToken = ref(''), loading = ref(true), busy = ref(false), placing = ref(false);
const error = ref(''), notice = ref(''), category = ref('All'), query = ref(''), selectedLocationId = ref('');
const serviceChoice = ref('pickup');
const reviewing = ref(false), cartOpen = ref(false), online = ref(navigator.onLine), variantChoices = reactive({});
const cartDialog = ref(null), cartClose = ref(null), reviewDialog = ref(null), reviewClose = ref(null);
const account = ref({ authenticated: false }), accountOpen = ref(false), accountLoading = ref(true);
const failedImages = ref(new Set());
const accountLoyaltyBalance = computed(() => Number(account.value.loyalty?.pointBalance ?? account.value.loyalty?.balance ?? account.value.loyalty?.stampBalance ?? 0));
const accountLoyaltyUnit = computed(() => account.value.loyalty?.unitLabel || (account.value.loyalty?.stampBalance != null ? 'stamps' : 'points'));
const guest = reactive({ name: '', email: '', phone: '' });
const delivery = reactive({ addressLine1:'', addressLine2:'', postcode:'', city:'', state:'', instructions:'' });
const deliveryZoneId = ref('');
const notes = ref('');
const voucherCode = ref('');
const locationToken = computed(() => String(route.query.locationToken || route.query.location || route.query.t || '').trim());
const routePromoCode = computed(() => {
  const code=String(route.query.promo||'').trim().toUpperCase();
  return /^[A-Z0-9](?:[A-Z0-9-]{1,30}[A-Z0-9])$/.test(code)?code:'';
});
const storefront = computed(() => menu.value?.storefront || {});
const slides = computed(() => menu.value?.slides || []);
const activeSlideIndex = ref(0);
const mobileMedia=globalThis.matchMedia?.('(max-width: 920px)');
const mobileViewport=ref(mobileMedia?.matches??false);
const carouselPaused = ref((globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  || mobileViewport.value);
const activeSlide = computed(() => slides.value[activeSlideIndex.value] || null);
const themeStyle = computed(() => {
  const theme = storefront.value.theme || {};
  const background=theme.backgroundColor || '#fbfcf8',primary=theme.primaryColor || '#17624d';
  return { '--customer-page-ink':accessibleStorefrontText(background,theme.textColor || '#15382c'),
    '--customer-ink':accessibleStorefrontText('#ffffff',theme.textColor || '#15382c'),
    '--customer-accent-ink':accessibleStorefrontText(primary,'#ffffff'), '--customer-accent':primary,
    '--customer-accent-dark':theme.primaryColor || '#104d3c', '--customer-highlight':theme.accentColor || '#d7a43b',
    '--customer-background':background, '--customer-font':storefrontFontStack(theme.fontFamily) };
});
const privacy = computed(() => storefront.value.privacy || {});
const locations = computed(() => (menu.value?.locations || []).filter(location => location.fulfillmentMode !== 'table'));
const deliveryZones = computed(() => menu.value?.deliveryZones || []);
const selectedLocation = computed(() => menu.value?.location || locations.value.find(location => location.id === selectedLocationId.value) || null);
const lockedLocation = computed(() => Boolean(menu.value?.location));
const deliveryAvailable = computed(() => !lockedLocation.value && Boolean(selectedLocation.value) && deliveryZones.value.length > 0);
const fulfillmentLabel = computed(() => deliveryAvailable.value ? 'PICKUP OR DELIVERY' : 'PICKUP');
const fulfillmentMode = computed(() => serviceChoice.value === 'delivery' && deliveryAvailable.value ? 'delivery' : selectedLocation.value?.fulfillmentMode === 'both'
  ? (lockedLocation.value ? serviceChoice.value : 'pickup')
  : selectedLocation.value?.fulfillmentMode || 'pickup');
const products = computed(() => (menu.value?.products || []).filter(product=>product.active!==false));
const categories = computed(() => ['All', ...new Set(products.value.map(product => product.category))]);
const visibleProducts = computed(() => products.value.filter(product => {
  const needle = query.value.trim().toLowerCase();
  return !needle || [product.name, product.description, product.category, product.subcategory].some(value => value.toLowerCase().includes(needle));
}));
const categoryDetails=computed(()=>categories.value.map(name=>({name,count:name==='All'?visibleProducts.value.length:visibleProducts.value.filter(product=>product.category===name).length})).filter(item=>item.name==='All'||item.count));
const menuGroups=computed(()=>{
  const groups=[];
  for(const product of visibleProducts.value){
    const label=product.category||'Other';let group=groups.find(item=>item.label===label);
    if(!group){group={label,products:[]};groups.push(group);}
    group.products.push(product);
  }
  return groups;
});
const cartSummary = computed(() => publicCartSummary(lines.value));
const itemCount = computed(() => cartSummary.value.itemCount);
const orderBase = computed(() => ({
  ...(locationToken.value ? { locationToken: locationToken.value } : {}),
  ...(!lockedLocation.value && selectedLocationId.value ? { locationId: selectedLocationId.value } : {}),
  serviceMode: fulfillmentMode.value,
  ...(fulfillmentMode.value === 'delivery' ? { delivery: { zoneId:deliveryZoneId.value, address:{ ...delivery, countryCode:'MY' } } } : {}),
  items: cartRequestItems(lines.value),
}));
let loadRequest = 0, retry = null, slideTimer = null;
let cartReturnFocus = null, reviewReturnFocus = null, previousBodyOverflow = '', bodyLocked = false;

function imageKey(scope, url) { return `${scope}:${String(url || '')}`; }
function imageAvailable(scope, url) { return Boolean(url) && !failedImages.value.has(imageKey(scope, url)); }
function imageFailed(scope, url) {
  const next = new Set(failedImages.value);
  next.add(imageKey(scope, url));
  failedImages.value = next;
}

function resetSlideTimer() {
  if (slideTimer) clearInterval(slideTimer);
  slideTimer = null;
  if (activeSlideIndex.value >= slides.value.length) activeSlideIndex.value = 0;
  if (slides.value.length > 1 && !carouselPaused.value) slideTimer = setInterval(() => {
    activeSlideIndex.value = (activeSlideIndex.value + 1) % slides.value.length;
  }, Number(storefront.value.carouselIntervalSeconds || 7) * 1000);
}
function toggleCarousel() { carouselPaused.value = !carouselPaused.value; resetSlideTimer(); }
function viewportChanged(event){mobileViewport.value=event.matches;if(!event.matches&&cartOpen.value)closeCart();}
function openCart(event) { cartReturnFocus = event?.currentTarget || document.activeElement; cartOpen.value = true; }
function closeCart() { cartOpen.value = false; }
function updateBodyLock() {
  const shouldLock = reviewing.value || (cartOpen.value && mobileViewport.value);
  if (shouldLock && !bodyLocked) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    bodyLocked = true;
  } else if (!shouldLock && bodyLocked) {
    document.body.style.overflow = previousBodyOverflow;
    bodyLocked = false;
  }
}
function handleCartKeydown(event) {
  if (!mobileViewport.value) return;
  if (event.key === 'Escape') { event.preventDefault(); closeCart(); return; }
  if (event.key !== 'Tab') return;
  const focusable = [...(cartDialog.value?.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]') || [])]
    .filter(element => element.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
function handleReviewKeydown(event) {
  if (event.key === 'Escape' && !placing.value) { event.preventDefault(); closeReview(); return; }
  if (event.key !== 'Tab') return;
  const focusable = [...(reviewDialog.value?.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]') || [])]
    .filter(element => element.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function displayPrice(product, key) {
  return customerProductDisplayPrice(product,key);
}
function hasOnlineSaving(product) { return displayPrice(product, 'onlinePrice') < displayPrice(product, 'storePrice'); }
function hasChannelPriceDifference(product) { return displayPrice(product, 'onlinePrice') !== displayPrice(product, 'storePrice'); }
function onlineSavingLabel(product) {
  const storePrice = displayPrice(product, 'storePrice');
  const onlinePrice = displayPrice(product, 'onlinePrice');
  if (!(storePrice > onlinePrice)) return '';
  const percentage = Math.round(((storePrice - onlinePrice) / storePrice) * 100);
  return percentage > 0 ? `Save ${percentage}% online` : 'Online offer';
}
function productCartCount(productId) {
  return lines.value.filter(line => line.productId === productId).reduce((sum, line) => sum + line.quantity, 0);
}
function scrollToMenu() {
  document.querySelector('#customer-menu')?.scrollIntoView({ behavior:'smooth', block:'start' });
}
function menuSectionId(label){return `customer-menu-${String(label||'other').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'')||'other'}`;}
async function chooseCategory(label){
  category.value=label;await nextTick();
  document.querySelector(label==='All'?'#customer-menu':`#${menuSectionId(label)}`)?.scrollIntoView({behavior:'smooth',block:'start'});
}
function scrollToFulfillment(){document.querySelector('#customer-fulfillment')?.scrollIntoView({behavior:'smooth',block:'center'});}
function optionPriceLabel(option) {
  const online = formatCustomerMoney(option.onlinePrice, storefront.value.currency);
  return option.onlinePrice !== option.storePrice
    ? `${online} online · ${formatCustomerMoney(option.storePrice, storefront.value.currency)} store` : online;
}

function currentOrder(includeVoucher = false) {
  const request = { ...orderBase.value };
  if (fulfillmentMode.value === 'delivery') request.delivery = deliveryOrderDetails(deliveryZoneId.value, delivery, deliveryZones.value);
  const voucher = voucherCode.value.trim();
  if (includeVoucher && voucher) request.voucherCode = voucher;
  return request;
}

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
    delivery_details_required: 'Add a delivery address before reviewing this order.',
    delivery_unavailable: 'That delivery zone is no longer available. Choose another option.',
    delivery_minimum_not_met: 'Add more items to reach the minimum for this delivery zone.',
    voucher_invalid_or_unavailable: 'This voucher cannot be applied to this order.',
    promotion_unavailable: 'A promotion or voucher changed. Refresh the quote and review the updated total.',
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
    deliveryZoneId.value = result.deliveryZones[0]?.id || '';
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
    notice.value = `${product.name} added. Your order now has ${itemCount.value} ${itemCount.value === 1 ? 'item' : 'items'}.`;
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
    const result = await quoteCustomerOrder(currentOrder(true));
    if (!result.quote || !result.quoteToken) throw new Error('invalid_quote_response');
    quote.value = result.quote;
    quoteToken.value = result.quoteToken;
    reviewReturnFocus = cartReturnFocus || document.activeElement;
    reviewing.value = true;
    cartOpen.value = false;
  } catch (caught) { error.value = friendlyError(caught, 'The shop could not confirm this order. Review the items and try again.'); }
  finally { busy.value = false; }
}
async function placeOrder() {
  if (placing.value || !quote.value || !quoteToken.value) return;
  let body;
  try { body = customerOrderSubmission({ order: currentOrder(), quoteToken: quoteToken.value, fulfillmentMode: fulfillmentMode.value, guest, notes: notes.value }); }
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
    if (['quote_changed','promotion_unavailable'].includes(caught?.message)) {
      retry = null; quote.value = null; quoteToken.value = '';
      try {
        const updated = await quoteCustomerOrder(currentOrder(true));
        if (!updated.quote || !updated.quoteToken) throw new Error('invalid_quote_response');
        quote.value = updated.quote; quoteToken.value = updated.quoteToken;
        error.value = caught.message === 'promotion_unavailable'
          ? 'A promotion or voucher changed. Review the refreshed total before placing your order.'
          : 'The menu or total changed. Review the updated quote before placing your order.';
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
watch([deliveryZoneId,delivery], () => { quote.value = null; quoteToken.value = ''; reviewing.value = false; retry = null; }, { deep:true });
watch(voucherCode, () => { quote.value = null; quoteToken.value = ''; reviewing.value = false; retry = null; });
watch(routePromoCode, code => {if(code){voucherCode.value=code;notice.value=`Promo code ${code} is ready. Its discount will be confirmed when you review the order.`;}},{immediate:true});
watch([() => slides.value.length, () => storefront.value.carouselIntervalSeconds], resetSlideTimer);
watch([cartOpen,reviewing,mobileViewport],updateBodyLock);
watch(cartOpen, async open => {
  if (open&&mobileViewport.value) {
    await nextTick();
    cartClose.value?.focus();
  } else if (!open&&!reviewing.value) {
    await nextTick();
    cartReturnFocus?.focus?.();
    cartReturnFocus = null;
  }
});
watch(reviewing, async open => {
  await nextTick();
  if (open) {
    reviewClose.value?.focus();
    return;
  }
  const target = reviewReturnFocus;
  reviewReturnFocus = null;
  if (target?.isConnected && target.getClientRects().length) target.focus();
  else cartReturnFocus?.focus?.();
  cartReturnFocus = null;
});
onMounted(() => { load(); refreshAccount(); mobileMedia?.addEventListener?.('change',viewportChanged);window.addEventListener('online', networkChange); window.addEventListener('offline', networkChange); });
onBeforeUnmount(() => { loadRequest++; if(slideTimer)clearInterval(slideTimer);if(bodyLocked)document.body.style.overflow=previousBodyOverflow;mobileMedia?.removeEventListener?.('change',viewportChanged); window.removeEventListener('online', networkChange); window.removeEventListener('offline', networkChange); });
</script>

<template>
  <div class="customer-shell" :style="themeStyle">
    <header class="customer-nav"><a href="/shop" class="customer-wordmark"><img v-if="imageAvailable('logo',storefront.logoUrl)" :src="storefront.logoUrl" alt="" referrerpolicy="no-referrer" @error="imageFailed('logo',storefront.logoUrl)"><i v-else aria-hidden="true"></i><b>{{ storefront.name || 'myfin' }}</b><small>order</small></a>
      <nav class="customer-quick-nav" aria-label="Shop"><button type="button" @click="scrollToMenu">Menu</button><button type="button" @click="scrollToFulfillment">{{ fulfillmentMode==='delivery'?'Delivery':fulfillmentMode==='table'?'Table order':'Pickup' }}</button></nav>
      <div class="customer-nav-actions"><button type="button" class="customer-account" :aria-expanded="accountOpen" @click="accountOpen=true"><span aria-hidden="true">◎</span> {{ account.authenticated ? (account.profile?.displayName || account.customer?.displayName || 'Account') : 'Sign in' }} <small v-if="account.authenticated && account.loyalty?.enabled">{{ accountLoyaltyBalance }} {{ accountLoyaltyUnit }}</small></button>
        <button type="button" class="customer-mobile-cart" :aria-expanded="cartOpen" aria-controls="customer-cart-dialog" @click="cartOpen?closeCart():openCart($event)">Order <b>{{ itemCount }}</b></button></div></header>

    <main v-if="loading" class="customer-state" role="status"><span class="customer-loader"></span><h1>Opening the menu…</h1></main>
    <main v-else-if="!menu" class="customer-state"><span class="customer-state-mark">!</span><h1>Menu unavailable</h1><p>{{ error }}</p><button type="button" @click="load">Try again</button></main>
    <main v-else class="customer-main">
      <section class="customer-hero" :class="{'with-image':imageAvailable('hero',storefront.hero?.imageUrl)}"><div class="customer-hero-copy"><span class="customer-kicker">{{ storefront.hero?.eyebrow || `ORDER ONLINE / ${fulfillmentLabel}` }}</span><h1>{{ storefront.hero?.title || storefront.name }}</h1><p>{{ storefront.hero?.description || storefront.description || (deliveryAvailable ? 'Choose your favourites for pickup or delivery. Payment options appear after the shop accepts your order.' : 'Choose your favourites for pickup. Payment options appear after the shop accepts your order.') }}</p><div class="customer-hero-actions"><button type="button" class="customer-browse-menu" @click="scrollToMenu">Start your order <span aria-hidden="true">↓</span></button><div class="customer-auth-choice"><span>No account needed.</span><button v-if="!account.authenticated" type="button" @click="accountOpen=true">Sign in for loyalty</button><button v-else type="button" @click="accountOpen=true">Account & loyalty</button></div></div></div>
        <img v-if="imageAvailable('hero',storefront.hero?.imageUrl)" class="customer-hero-image" :src="storefront.hero.imageUrl" alt="" decoding="async" fetchpriority="high" referrerpolicy="no-referrer" @error="imageFailed('hero',storefront.hero?.imageUrl)">
      </section>

      <section id="customer-fulfillment" class="customer-order-context" aria-labelledby="customer-fulfillment-title"><div class="customer-context-heading"><span class="customer-kicker">HOW TO GET YOUR ORDER</span><h2 id="customer-fulfillment-title">{{ fulfillmentMode==='delivery'?'Delivery':fulfillmentMode==='table'?'Order to this table':'Pickup' }}</h2><p>{{ fulfillmentMode === 'table' ? 'We will bring the accepted order to this table.' : fulfillmentMode === 'delivery' ? 'Choose your area now. The shop confirms timing before preparation.' : 'Choose your collection point. Preparation starts after the shop accepts.' }}</p></div><div class="customer-context"><span class="customer-kicker">{{ fulfillmentMode==='delivery'?'DISPATCHED FROM':'COLLECT FROM' }}</span>
          <strong v-if="lockedLocation">{{ selectedLocation?.name }}</strong>
          <select v-else-if="locations.length" v-model="selectedLocationId" aria-label="Collection location"><option v-for="place in locations" :key="place.id" :value="place.id">{{ place.name }} · Pickup</option></select>
          <strong v-else>Shop counter</strong>
          <div v-if="lockedLocation && selectedLocation?.fulfillmentMode === 'both'" class="customer-service-choice" aria-label="How would you like this order?">
            <button type="button" :class="{active:serviceChoice==='table'}" :aria-pressed="serviceChoice==='table'" @click="serviceChoice='table'">At this table</button>
            <button type="button" :class="{active:serviceChoice==='pickup'}" :aria-pressed="serviceChoice==='pickup'" @click="serviceChoice='pickup'">Collect at counter</button>
          </div>
          <div v-if="deliveryAvailable" class="customer-service-choice" aria-label="Pickup or delivery">
            <button type="button" :class="{active:serviceChoice!=='delivery'}" :aria-pressed="serviceChoice!=='delivery'" @click="serviceChoice='pickup'">Pickup</button>
            <button type="button" :class="{active:serviceChoice==='delivery'}" :aria-pressed="serviceChoice==='delivery'" @click="serviceChoice='delivery'">Delivery</button>
          </div>
          </div>
      </section>

      <section v-if="activeSlide" class="customer-promotion" :class="{'without-image':!imageAvailable(`slide:${activeSlide.id}`,activeSlide.imageUrl)}" :style="{backgroundColor:activeSlide.backgroundColor}" aria-roledescription="carousel" aria-label="Shop promotions">
        <div><span v-if="activeSlide.badge">{{ activeSlide.badge }}</span><h2>{{ activeSlide.title }}</h2><p v-if="activeSlide.description">{{ activeSlide.description }}</p><a v-if="activeSlide.ctaUrl" :href="activeSlide.ctaUrl">{{ activeSlide.ctaLabel }} <b aria-hidden="true">→</b></a></div>
        <img v-if="imageAvailable(`slide:${activeSlide.id}`,activeSlide.imageUrl)" :src="activeSlide.imageUrl" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error="imageFailed(`slide:${activeSlide.id}`,activeSlide.imageUrl)">
        <nav v-if="slides.length>1" aria-label="Promotion slides"><button type="button" class="customer-carousel-toggle" :aria-label="carouselPaused ? 'Resume promotion carousel' : 'Pause promotion carousel'" @click="toggleCarousel">{{ carouselPaused ? 'Play' : 'Pause' }}</button><button v-for="(slide,index) in slides" :key="slide.id" type="button" :class="{active:index===activeSlideIndex}" :aria-label="`Show ${slide.title}`" @click="activeSlideIndex=index;resetSlideTimer()"></button></nav>
      </section>

      <section v-if="fulfillmentMode==='delivery'" class="customer-delivery-panel" aria-labelledby="delivery-details-title">
        <div><span class="customer-kicker">DELIVERY DETAILS</span><h2 id="delivery-details-title">Where should we send it?</h2><p>The shop will confirm arrangements after accepting your order. You can then choose secure online payment when available or follow the shop's payment instructions.</p></div>
        <div class="customer-delivery-fields">
          <label><span>Delivery zone</span><select v-model="deliveryZoneId"><option v-for="zone in deliveryZones" :key="zone.id" :value="zone.id">{{ zone.name }} · {{ formatCustomerMoney(zone.fee,storefront.currency) }} fee · {{ zone.leadTimeMinutes }} min</option></select></label>
          <label class="wide"><span>Address line 1 *</span><input v-model="delivery.addressLine1" maxlength="160" autocomplete="address-line1"></label>
          <label class="wide"><span>Address line 2</span><input v-model="delivery.addressLine2" maxlength="160" autocomplete="address-line2"></label>
          <label><span>Postcode *</span><input v-model="delivery.postcode" maxlength="20" autocomplete="postal-code" inputmode="numeric"></label>
          <label><span>City *</span><input v-model="delivery.city" maxlength="120" autocomplete="address-level2"></label>
          <label><span>State *</span><input v-model="delivery.state" maxlength="120" autocomplete="address-level1"></label>
          <label class="wide"><span>Delivery instructions</span><textarea v-model="delivery.instructions" maxlength="500" rows="2" placeholder="Gate, floor, landmark, or handoff instructions"></textarea></label>
          <small v-if="deliveryZones.find(zone=>zone.id===deliveryZoneId)?.serviceInstructions" class="wide">{{ deliveryZones.find(zone=>zone.id===deliveryZoneId)?.serviceInstructions }}</small>
        </div>
      </section>

      <div v-if="!online" class="customer-banner warning">You are offline. The menu remains visible, but an order cannot be placed until you reconnect.</div>
      <div v-if="error" class="customer-banner error" role="alert">{{ error }} <button type="button" aria-label="Dismiss" @click="error=''">×</button></div>
      <div v-else-if="notice" class="customer-sr-status" role="status">{{ notice }}</div>
      <div v-if="routePromoCode" class="customer-promo-ready"><span aria-hidden="true">%</span><div><strong>{{ routePromoCode }} is ready</strong><small>Build your order and we will confirm the discount at review.</small></div></div>

      <section id="customer-menu" class="customer-tools"><div class="customer-menu-heading"><span class="customer-kicker">MENU</span><strong>{{ visibleProducts.length }} {{ visibleProducts.length===1?'item':'items' }}</strong></div><label><span aria-hidden="true">⌕</span><input v-model="query" type="search" placeholder="Search the menu" aria-label="Search the menu"></label><button type="button" class="customer-fulfillment-summary" @click="scrollToFulfillment"><span>{{ fulfillmentMode==='delivery'?'Delivery':fulfillmentMode==='table'?'At this table':'Pickup' }}</span><strong>{{ selectedLocation?.name||'Shop counter' }}</strong></button>
        <div class="customer-categories" aria-label="Menu categories"><button v-for="item in categoryDetails" :key="item.name" type="button" :class="{active:category===item.name}" :aria-pressed="category===item.name" @click="chooseCategory(item.name)">{{ item.name==='All'?'All menu':item.name }} <small>{{ item.count }}</small></button></div></section>

      <div class="customer-order-layout">
        <section class="customer-products" aria-live="polite">
          <section v-for="group in menuGroups" :id="menuSectionId(group.label)" :key="group.label" class="customer-menu-group"><header><div><span class="customer-kicker">MENU SECTION</span><h2>{{ group.label }}</h2></div><span>{{ group.products.length }} {{ group.products.length===1?'item':'items' }}</span></header><div class="customer-product-grid">
            <article v-for="product in group.products" :key="product.id" class="customer-product" :class="{unavailable:!product.available,'without-image':!imageAvailable(`product:${product.id}`,product.imageUrl)}">
              <div v-if="imageAvailable(`product:${product.id}`,product.imageUrl)" class="customer-product-image"><img :src="product.imageUrl" :alt="product.name" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error="imageFailed(`product:${product.id}`,product.imageUrl)"></div>
              <div class="customer-product-copy"><div><span>{{ product.subcategory || product.category }}</span><h3>{{ product.name }}</h3><p v-if="product.description">{{ product.description }}</p></div>
                <div class="customer-product-buy"><div class="customer-price"><s v-if="hasOnlineSaving(product)">{{ product.variants.length?'From ':'' }}{{ formatCustomerMoney(displayPrice(product,'storePrice'), storefront.currency) }}</s><span v-else-if="hasChannelPriceDifference(product)">In store {{ formatCustomerMoney(displayPrice(product,'storePrice'), storefront.currency) }}</span><strong>{{ product.variants.length?'From ':'' }}{{ formatCustomerMoney(displayPrice(product,'onlinePrice'), storefront.currency) }}</strong><small v-if="hasChannelPriceDifference(product)">{{ onlineSavingLabel(product) || 'Online price' }}</small></div>
                  <template v-if="product.available">
                    <select v-if="product.variants.length" v-model="variantChoices[product.id]" :aria-label="`Choose an option for ${product.name}`"><option value="" disabled>Choose an option</option><option v-for="option in product.variants" :key="option.id" :value="option.id" :disabled="!option.available">{{ option.name }} · {{ optionPriceLabel(option) }}{{ option.available ? '' : ' · Sold out' }}</option></select>
                    <button type="button" :aria-label="`Add ${product.name} to order`" @click="add(product)"><span v-if="productCartCount(product.id)" class="customer-product-count">{{ productCartCount(product.id) }}</span>{{ productCartCount(product.id) ? 'Add another' : 'Add' }} <span aria-hidden="true">+</span></button>
                  </template><span v-else class="customer-sold-out">Sold out</span>
                </div></div>
            </article>
          </div></section>
          <div v-if="!visibleProducts.length" class="customer-no-results"><strong>No menu items found</strong><p>Try another search or category.</p></div>
        </section>
        <div id="customer-cart-dialog" ref="cartDialog" class="customer-cart-wrap" :class="{open:cartOpen}" :role="mobileViewport?'dialog':undefined" :aria-modal="mobileViewport?'true':undefined" aria-label="Your order" :aria-hidden="mobileViewport&&!cartOpen?'true':undefined" @keydown="handleCartKeydown" @click.self="closeCart"><button ref="cartClose" type="button" class="customer-cart-close" aria-label="Close order" @click="closeCart">×</button><div class="customer-cart-panel"><div class="customer-voucher"><label for="customer-voucher-code">Have a voucher?</label><input id="customer-voucher-code" v-model.trim="voucherCode" maxlength="32" autocomplete="off" autocapitalize="characters" placeholder="Enter voucher code"><small>We confirm the discount when you review the order.</small></div><CustomerCart :lines="lines" :currency="storefront.currency" :quote="quote" :busy="busy" @quantity="setQuantity" @review="review" /></div></div>
      </div>
      <footer class="customer-footer"><p>{{ storefront.pickupInstructions || "The shop confirms your order first. Then choose secure online payment when available or follow the shop's payment instructions." }}</p><p>Order as a guest or sign in for order history and loyalty. <RouterLink to="/privacy">Privacy notice</RouterLink></p></footer>
      <button v-if="itemCount" type="button" class="customer-mobile-order-bar" :aria-expanded="cartOpen" aria-controls="customer-cart-dialog" @click="openCart($event)"><span><small>Your order · {{ itemCount }} {{ itemCount===1?'item':'items' }}</small><strong>{{ formatCustomerMoney(cartSummary.estimatedTotal,storefront.currency) }}</strong></span><b>View order <span aria-hidden="true">→</span></b></button>
    </main>

    <div v-if="reviewing" class="customer-review-backdrop" role="presentation" @mousedown.self="closeReview">
      <section ref="reviewDialog" class="customer-review" role="dialog" aria-modal="true" aria-labelledby="customer-review-title" @keydown="handleReviewKeydown">
        <header><div><span class="customer-kicker">REVIEW</span><h2 id="customer-review-title">Place your order</h2></div><button ref="reviewClose" type="button" aria-label="Close" :disabled="placing" @click="closeReview">×</button></header>
        <div class="customer-review-body">
          <div class="customer-review-location"><span>{{ fulfillmentMode==='delivery'?'Dispatch shop':'Collection' }}</span><strong>{{ selectedLocation?.name || 'Shop counter' }}</strong><small>{{ fulfillmentMode === 'table' ? 'Table service after staff acceptance · choose payment next' : fulfillmentMode==='delivery' ? `${quote?.delivery?.zoneName || ''} · about ${quote?.delivery?.leadTimeMinutes || 0} minutes after acceptance · choose payment next` : 'Preparation starts after staff acceptance · choose payment next' }}</small></div>
          <div v-if="fulfillmentMode==='delivery'" class="customer-review-location customer-delivery-summary"><span>Deliver to</span><strong>{{ delivery.postcode }} {{ delivery.city }}, {{ delivery.state }}</strong><small>{{ delivery.addressLine1 }}<template v-if="delivery.addressLine2"> · {{ delivery.addressLine2 }}</template></small></div>
          <div class="customer-review-lines"><div v-for="item in quote?.items || []" :key="`${item.productId}:${item.variantId || ''}`"><span>{{ item.quantity }} × {{ item.name || item.description }}<small v-if="item.variantName || item.variant">{{ item.variantName || item.variant }}</small></span><strong>{{ formatCustomerMoney(item.lineTotal ?? item.total ?? item.unitPrice * item.quantity, quote.currency) }}</strong></div></div>
          <dl class="customer-review-totals"><div><dt>Subtotal</dt><dd>{{ formatCustomerMoney(quote.subtotal, quote.currency) }}</dd></div><div v-for="(item,index) in quote.discounts || []" :key="`${item.name}:${index}`"><dt>{{ item.name }}</dt><dd>−{{ formatCustomerMoney(item.amount, quote.currency) }}</dd></div><div v-if="quote.tax"><dt>Tax</dt><dd>{{ formatCustomerMoney(quote.tax, quote.currency) }}</dd></div><div v-if="quote.deliveryFee!==undefined"><dt>Delivery</dt><dd>{{ formatCustomerMoney(quote.deliveryFee, quote.currency) }}</dd></div><div v-if="quote.rounding"><dt>Rounding</dt><dd>{{ formatCustomerMoney(quote.rounding, quote.currency) }}</dd></div><div class="total"><dt>Order total</dt><dd>{{ formatCustomerMoney(quote.total, quote.currency) }}</dd></div></dl>
          <div class="customer-form-grid"><label><span>Name {{ fulfillmentMode === 'table' ? '(optional)' : '*' }}</span><input v-model="guest.name" autocomplete="name" maxlength="120" placeholder="Name for the order"></label><label><span>Phone <small>{{ fulfillmentMode === 'table' ? 'optional' : 'phone or email *' }}</small></span><input v-model="guest.phone" type="tel" autocomplete="tel" maxlength="30" placeholder="+60…"></label><label><span>Email <small>{{ fulfillmentMode === 'table' ? 'optional' : 'phone or email *' }}</small></span><input v-model="guest.email" type="email" autocomplete="email" maxlength="254" placeholder="you@example.com"></label><label class="wide"><span>Order notes (optional)</span><textarea v-model="notes" maxlength="500" placeholder="Preparation notes for the shop"></textarea></label></div>
          <p v-if="fulfillmentMode !== 'table'" class="customer-contact-note">For {{ fulfillmentMode==='delivery'?'delivery':'pickup' }} orders, add a phone number or email so the shop can contact you about fulfillment. This does not opt you into marketing.<template v-if="account.authenticated"> Your account profile has prefilled these details.</template></p>
          <p v-else class="customer-contact-note">Contact details are optional for this table order. They are not used for marketing.</p>
          <section v-if="privacy.noticeEn && privacy.noticeMs" class="customer-privacy-notice" aria-labelledby="order-privacy-title">
            <h3 id="order-privacy-title">Your order information / Maklumat pesanan anda</h3>
            <p><strong>{{ privacy.controllerName }}</strong> · {{ privacy.controllerContact }}</p>
            <p lang="en">{{ privacy.noticeEn }}</p><p lang="ms">{{ privacy.noticeMs }}</p>
            <p v-if="privacy.guestContactRetentionDays" lang="en">Contact details, delivery address, and freeform order notes are removed {{ privacy.guestContactRetentionDays }} days after the order closes.</p>
            <p v-if="privacy.guestContactRetentionDays" lang="ms">Butiran hubungan, alamat penghantaran dan nota pesanan bebas dipadam {{ privacy.guestContactRetentionDays }} hari selepas pesanan ditutup.</p>
            <a :href="privacy.noticeUrl" target="_blank" rel="noopener noreferrer">Read the full privacy notice / Baca notis privasi penuh ↗</a>
          </section>
          <div v-if="error" class="customer-banner error" role="alert">{{ error }}</div>
        </div>
        <footer><button type="button" :disabled="placing" @click="closeReview">Back to menu</button><button type="button" class="customer-primary" :disabled="placing || !online || !quoteToken" @click="placeOrder">{{ placing ? 'Placing order…' : 'Place order' }} <span aria-hidden="true">→</span></button></footer>
      </section>
    </div>
    <CustomerAccountPanel :open="accountOpen" :account="account" :loading="accountLoading || loading" :privacy="privacy" :font-family="storefrontFontStack(storefront.theme?.fontFamily)" @close="accountOpen=false" @account-change="accountChanged" />
  </div>
</template>

<style scoped>
.customer-shell{--customer-page-ink:#15382c;--customer-ink:#15382c;--customer-muted:#68776f;--customer-line:#d8dfd8;--customer-line-strong:#aebbb2;--customer-tint:#f1f5ed;--customer-accent:#17624d;--customer-accent-ink:#fff;--customer-accent-dark:#104d3c;--customer-highlight:#d7a43b;--customer-background:#fbfcf8;--customer-font:var(--ed-font-sans);min-height:100dvh;background:var(--customer-background);color:var(--customer-page-ink);font-family:var(--customer-font)}.customer-nav{height:78px;display:flex;align-items:center;justify-content:space-between;max-width:1440px;margin:auto;padding:0 42px;border-bottom:1px solid var(--customer-line)}.customer-wordmark{display:flex;align-items:center;gap:8px;color:var(--customer-page-ink);text-decoration:none;font:bold 21px var(--customer-font);min-width:0}.customer-wordmark b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.customer-wordmark img{width:34px;height:34px;object-fit:contain;border-radius:6px}.customer-wordmark i{flex:0 0 auto;width:13px;height:13px;background:var(--customer-accent);box-shadow:6px -6px 0 var(--customer-highlight)}.customer-wordmark small{font:500 10px var(--customer-font);letter-spacing:.15em}.customer-nav-actions{display:flex;align-items:center;gap:10px}.customer-account,.customer-mobile-cart{border:1px solid var(--customer-line);background:white;color:var(--customer-ink);border-radius:999px;min-height:38px;padding:0 14px;font-size:11px;font-weight:650}.customer-account:disabled{opacity:.65}.customer-account small{margin-left:6px;color:var(--customer-muted);font-size:8px;text-transform:uppercase;letter-spacing:.1em}.customer-mobile-cart{display:none}.customer-mobile-cart b{display:inline-grid;place-items:center;background:var(--customer-accent);color:var(--customer-accent-ink);border-radius:50%;min-width:20px;height:20px;margin-left:6px}.customer-main{max-width:1440px;margin:auto;padding:0 42px}.customer-hero{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(260px,.55fr);gap:40px;align-items:end;padding:54px 0 40px}.customer-hero.with-image{grid-template-columns:minmax(0,1.15fr) minmax(220px,.65fr) minmax(240px,.55fr)}.customer-hero-image{width:100%;height:260px;object-fit:cover;border-radius:18px}.customer-kicker{font-size:10px;letter-spacing:.18em;font-weight:750;color:var(--customer-muted)}.customer-hero h1{font:500 clamp(48px,7vw,88px)/.95 var(--customer-font);margin:12px 0 18px;letter-spacing:-.035em}.customer-hero-copy>p{max-width:650px;color:currentColor;font-size:14px;line-height:1.65;margin:0}.customer-auth-choice{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:22px;color:currentColor;font-size:10px}.customer-auth-choice button{border:1px solid var(--customer-accent);background:var(--customer-accent);color:var(--customer-accent-ink);border-radius:999px;padding:8px 12px;font:700 10px var(--customer-font)}.customer-context{border-left:1px solid currentColor;padding:8px 0 8px 28px;display:flex;flex-direction:column;align-items:start;gap:8px}.customer-context strong{font:500 22px var(--customer-font)}.customer-context select{width:100%;min-height:42px;border:1px solid var(--customer-line);background:white;border-radius:7px;padding:0 11px;color:var(--customer-ink)}.customer-context small{font-size:10px;line-height:1.5;color:currentColor}.customer-promotion{position:relative;min-height:230px;display:grid;grid-template-columns:minmax(0,1.2fr) minmax(220px,.8fr);align-items:center;overflow:hidden;border-radius:20px;margin:0 0 28px;color:#fff;box-shadow:0 15px 40px #102b231c}.customer-promotion.without-image{grid-template-columns:1fr}.customer-promotion>div{padding:38px 44px;z-index:1}.customer-promotion>div>span{font-size:10px;letter-spacing:.16em;font-weight:800;text-transform:uppercase;opacity:.82}.customer-promotion h2{max-width:680px;margin:10px 0;font:600 clamp(30px,4vw,54px)/1 var(--customer-font);letter-spacing:-.03em}.customer-promotion p{max-width:600px;margin:0 0 18px;font-size:12px;line-height:1.55;opacity:.88}.customer-promotion a{display:inline-flex;gap:18px;align-items:center;border-radius:999px;padding:10px 15px;background:#fff;color:#17251f;text-decoration:none;font-size:10px;font-weight:800}.customer-promotion>img{width:100%;height:100%;min-height:230px;object-fit:cover}.customer-promotion nav{position:absolute;left:44px;bottom:16px;display:flex;gap:6px}.customer-promotion nav button{width:20px;height:4px;padding:0;border:0;border-radius:4px;background:#ffffff66}.customer-promotion nav button.active{width:36px;background:#fff}.customer-promotion nav .customer-carousel-toggle{width:auto;height:auto;padding:2px 7px;border:1px solid #ffffff99;background:#102b2388;color:#fff;font:700 8px var(--customer-font);letter-spacing:.06em;text-transform:uppercase}.customer-banner{position:relative;padding:13px 42px 13px 15px;margin-bottom:18px;border-radius:8px;font-size:12px;border:1px solid}.customer-banner.warning{background:#fff9e9;border-color:#ead695;color:#6d5318}.customer-banner.error{background:#fff2ee;border-color:#e7c5bb;color:#813b29}.customer-banner button{position:absolute;right:12px;top:7px;border:0;background:none;color:inherit;font-size:22px}.customer-tools{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 0;border-block:1px solid var(--customer-line)}.customer-tools>label{position:relative;display:flex;align-items:center;min-width:240px}.customer-tools>label span{position:absolute;left:13px;color:var(--customer-muted);font-size:18px}.customer-tools input{width:100%;height:42px;border:1px solid var(--customer-line);border-radius:999px;padding:0 16px 0 38px;background:white;color:var(--customer-ink)}.customer-categories{display:flex;gap:7px;overflow:auto;padding:3px}.customer-categories button{white-space:nowrap;border:1px solid var(--customer-line);background:white;color:var(--customer-muted);border-radius:999px;padding:9px 14px;font-size:11px}.customer-categories button.active{border-color:var(--customer-accent);background:var(--customer-accent);color:var(--customer-accent-ink)}.customer-order-layout{display:grid;grid-template-columns:minmax(0,1fr) 355px;gap:30px;padding:30px 0 55px}.customer-products{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-content:start}.customer-product{color:var(--customer-ink);min-height:205px;display:grid;grid-template-columns:130px minmax(0,1fr);background:white;border:1px solid var(--customer-line);border-radius:14px;overflow:hidden;transition:border-color .15s,transform .15s}.customer-product:hover{border-color:var(--customer-line-strong);transform:translateY(-1px)}.customer-product-image{background:var(--customer-tint);min-height:205px}.customer-product-image img{width:100%;height:100%;object-fit:cover}.customer-product-copy{display:flex;flex-direction:column;justify-content:space-between;padding:19px;min-width:0}.customer-product-copy>div:first-child>span{font-size:9px;text-transform:uppercase;letter-spacing:.12em;color:var(--customer-muted)}.customer-product h3{font:500 23px/1.05 var(--customer-font);margin:7px 0 8px}.customer-product p{font-size:11px;line-height:1.5;color:var(--customer-muted);margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.customer-product-buy{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;margin-top:18px}.customer-price{grid-column:1/-1;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.customer-price strong{font-size:13px}.customer-price s,.customer-price>span{font-size:10px;color:var(--customer-muted)}.customer-price small{font-size:8px;text-transform:uppercase;letter-spacing:.1em;color:var(--customer-accent);font-weight:800}.customer-product-buy select{min-width:0;width:100%;height:36px;border:1px solid var(--customer-line);background:#fff;border-radius:6px;padding:0 8px;color:var(--customer-ink);font-size:11px}.customer-product-buy button{display:flex;align-items:center;gap:12px;height:36px;border:0;background:var(--customer-accent);color:var(--customer-accent-ink);border-radius:6px;padding:0 12px;font-size:11px;font-weight:700}.customer-product-buy button:hover{filter:brightness(.88)}.customer-sold-out{grid-column:1/-1;font-size:11px;font-weight:700;color:#9a4936}.customer-product.unavailable{background:#f7f7f3}.customer-product.unavailable .customer-product-copy>div:first-child{opacity:.6}.customer-no-results{grid-column:1/-1;min-height:250px;display:grid;place-content:center;justify-items:center;border:1px dashed currentColor;border-radius:14px;color:var(--customer-page-ink)}.customer-no-results p{font-size:12px}.customer-cart-close{display:none}.customer-footer{display:flex;justify-content:space-between;gap:30px;padding:24px 0 45px;border-top:1px solid currentColor;color:var(--customer-page-ink);font-size:10px}.customer-footer p{max-width:530px}.customer-state{min-height:calc(100dvh - 78px);display:grid;place-content:center;justify-items:center;text-align:center;padding:30px}.customer-state h1{font:500 40px var(--customer-font);margin:18px 0 8px}.customer-state p{color:var(--customer-page-ink);max-width:420px}.customer-state button{border:0;background:var(--customer-accent);color:var(--customer-accent-ink);border-radius:7px;padding:11px 17px}.customer-state-mark{display:grid;place-items:center;width:46px;height:46px;border-radius:50%;background:#fff0eb;color:#923d29;font-size:22px}.customer-loader{width:34px;height:34px;border:3px solid var(--customer-line);border-top-color:var(--customer-accent);border-radius:50%;animation:customer-spin .7s linear infinite}.customer-sr-status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.customer-review-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:18px;background:#102b23a8;backdrop-filter:blur(4px)}.customer-review{color:var(--customer-ink);width:min(680px,100%);max-height:calc(100dvh - 36px);display:flex;flex-direction:column;background:#fff;border-radius:18px;box-shadow:0 30px 100px #102b2355;overflow:hidden}.customer-review>header{display:flex;align-items:start;justify-content:space-between;padding:25px 28px;border-bottom:1px solid var(--customer-line)}.customer-review h2{font:500 31px var(--customer-font);margin:6px 0 0}.customer-review>header button{border:0;background:none;font-size:28px;color:var(--customer-muted)}.customer-review-body{overflow:auto;padding:25px 28px}.customer-review-location{display:grid;grid-template-columns:1fr auto;gap:4px 20px;padding:15px;background:var(--customer-tint);border-radius:8px;font-size:11px}.customer-review-location strong{font-size:13px}.customer-review-location small{grid-column:1/-1;color:var(--customer-muted)}.customer-review-lines{margin-top:18px}.customer-review-lines>div{display:flex;justify-content:space-between;gap:20px;padding:10px 0;font-size:12px}.customer-review-lines small{display:block;color:var(--customer-muted);margin-top:3px}.customer-review-totals{border-top:1px solid var(--customer-line);padding-top:13px;margin:8px 0 23px}.customer-review-totals>div{display:flex;justify-content:space-between;padding:5px 0;font-size:11px;color:var(--customer-muted)}.customer-review-totals dd{margin:0}.customer-review-totals .total{font-size:17px;color:var(--customer-ink);font-weight:700;padding-top:11px}.customer-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.customer-form-grid label{display:flex;flex-direction:column;gap:6px;font-size:11px;font-weight:650}.customer-form-grid label:first-child{grid-column:1/-1}.customer-form-grid .wide{grid-column:1/-1}.customer-form-grid :is(input,textarea){width:100%;border:1px solid var(--customer-line);border-radius:7px;background:#fff;padding:11px 12px;color:var(--customer-ink);font-size:16px}.customer-form-grid textarea{min-height:72px;resize:vertical}.customer-contact-note{font-size:10px;line-height:1.5;color:var(--customer-muted);margin:13px 0 0}.customer-review>footer{display:flex;justify-content:flex-end;gap:10px;padding:18px 28px;border-top:1px solid var(--customer-line);background:var(--customer-tint)}.customer-review>footer button{min-height:46px;border:1px solid var(--customer-line);border-radius:7px;background:#fff;color:var(--customer-ink);padding:0 16px;font-weight:650}.customer-review>footer .customer-primary{width:auto;min-width:220px;background:var(--customer-accent);color:var(--customer-accent-ink);border-color:var(--customer-accent);display:flex;align-items:center;justify-content:space-between}.customer-review>footer button:disabled{opacity:.5}@keyframes customer-spin{to{transform:rotate(360deg)}}
.customer-footer a{color:var(--customer-accent);font-weight:700}.customer-service-choice{display:flex;gap:6px;width:100%}.customer-service-choice button{flex:1;border:1px solid var(--customer-line);background:#fff;color:var(--customer-ink);border-radius:999px;padding:8px 10px;font-size:10px;font-weight:700}.customer-service-choice button.active{border-color:var(--customer-accent);background:var(--customer-accent);color:var(--customer-accent-ink)}
.customer-voucher{display:flex;flex-direction:column;gap:6px;margin-bottom:10px;padding:13px;border:1px solid var(--customer-line);border-radius:10px;background:white}.customer-voucher label{font-size:10px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.customer-voucher input{width:100%;height:40px;border:1px solid var(--customer-line);border-radius:7px;padding:0 11px;color:var(--customer-ink);text-transform:uppercase}.customer-voucher small{font-size:9px;color:var(--customer-muted);line-height:1.4}
.customer-delivery-panel{color:var(--customer-ink);display:grid;grid-template-columns:minmax(220px,.55fr) minmax(0,1.45fr);gap:32px;padding:24px;margin-bottom:18px;border:1px solid var(--customer-line);border-radius:12px;background:var(--customer-tint)}.customer-delivery-panel h2{font:400 28px var(--customer-font);margin:8px 0}.customer-delivery-panel p{font-size:11px;line-height:1.55;color:var(--customer-muted);margin:0}.customer-delivery-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.customer-delivery-fields label{display:flex;flex-direction:column;gap:6px;font-size:10px;font-weight:700}.customer-delivery-fields .wide{grid-column:1/-1}.customer-delivery-fields :is(input,select,textarea){width:100%;min-height:42px;border:1px solid var(--customer-line);border-radius:7px;background:#fff;padding:9px 11px;color:var(--customer-ink);font:inherit}.customer-delivery-fields small{color:var(--customer-muted);font-size:9px;line-height:1.5}.customer-delivery-summary{margin-top:8px}
.customer-form-grid label>span{display:flex;justify-content:space-between;gap:10px}.customer-form-grid label>span small{color:var(--customer-muted);font-size:9px;font-weight:500}.customer-privacy-notice{margin-top:16px;padding:14px;border:1px solid var(--customer-line);border-radius:8px;background:#f8faf6}.customer-privacy-notice h3{font:650 12px var(--customer-font);margin:0 0 8px}.customer-privacy-notice p{font-size:9px;line-height:1.5;color:var(--customer-muted);margin:5px 0}.customer-privacy-notice a{display:inline-block;margin-top:5px;color:var(--customer-accent);font-size:9px;font-weight:700}
@media(max-width:1150px){.customer-products{grid-template-columns:1fr}.customer-product{min-height:180px}.customer-product-image{min-height:180px}.customer-order-layout{grid-template-columns:minmax(0,1fr) 330px}}
@media(max-width:920px){.customer-nav,.customer-main{padding-inline:20px}.customer-mobile-cart{display:block}.customer-account{max-width:170px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.customer-account small{display:none}.customer-hero,.customer-hero.with-image{grid-template-columns:1fr;padding-top:38px}.customer-hero-image{height:220px}.customer-context{border-left:0;border-top:1px solid var(--customer-line);padding:20px 0 0}.customer-promotion{grid-template-columns:1fr}.customer-promotion>img{max-height:220px}.customer-delivery-panel{grid-template-columns:1fr}.customer-tools{align-items:stretch;flex-direction:column}.customer-tools>label{width:100%}.customer-order-layout{display:block}.customer-cart-wrap{position:fixed;inset:0;z-index:500;background:#102b2399;padding:70px 14px 14px;visibility:hidden;opacity:0;transition:opacity .15s}.customer-cart-wrap.open{visibility:visible;opacity:1}.customer-cart-wrap :deep(.customer-cart){max-height:calc(100dvh - 84px);overflow:auto}.customer-cart-close{display:grid;position:absolute;right:22px;top:20px;width:40px;height:40px;place-items:center;border:1px solid #ffffff55;border-radius:50%;background:#102b23;color:white;font-size:25px}.customer-footer{flex-direction:column}}
@media(max-width:600px){.customer-nav{height:68px;padding-inline:14px}.customer-wordmark{flex:1;max-width:none;font-size:17px}.customer-wordmark small{display:none}.customer-nav-actions{gap:6px}.customer-account,.customer-mobile-cart{padding-inline:10px}.customer-account{max-width:115px}.customer-main{padding-inline:14px}.customer-hero h1{font-size:50px}.customer-promotion{border-radius:14px}.customer-promotion>div{padding:28px 22px 42px}.customer-promotion nav{left:22px}.customer-delivery-panel{padding:17px}.customer-delivery-fields{grid-template-columns:1fr}.customer-delivery-fields .wide{grid-column:auto}.customer-products{gap:10px}.customer-product{grid-template-columns:1fr;min-height:0}.customer-product-image{height:170px;min-height:0}.customer-product-copy{padding:17px}.customer-footer{padding-bottom:95px}.customer-review-backdrop{padding:0;align-items:end}.customer-review{max-height:94dvh;border-radius:18px 18px 0 0}.customer-review>header,.customer-review-body,.customer-review>footer{padding-inline:20px}.customer-review>footer{display:grid;grid-template-columns:1fr 1.6fr}.customer-review>footer button,.customer-review>footer .customer-primary{min-width:0;width:100%;padding-inline:10px}.customer-form-grid{grid-template-columns:1fr}.customer-form-grid label:first-child,.customer-form-grid .wide{grid-column:auto}.customer-context select{font-size:16px}}

.customer-hero-actions{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:22px}.customer-hero-actions .customer-auth-choice{margin:0}.customer-browse-menu{min-height:42px;border:0;border-radius:999px;padding:0 17px;background:var(--customer-accent);color:var(--customer-accent-ink);font:750 11px var(--customer-font)}.customer-browse-menu span{margin-left:8px}.customer-product-count{display:grid;place-items:center;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:var(--customer-accent-ink);color:var(--customer-accent);font-size:9px}.customer-mobile-order-bar{display:none}
@media(max-width:920px){
  .customer-nav{position:sticky;top:0;z-index:120;height:68px;background:color-mix(in srgb,var(--customer-background) 94%,transparent);backdrop-filter:blur(14px)}
  .customer-account,.customer-mobile-cart,.customer-service-choice button,.customer-categories button{min-height:44px}
  .customer-hero,.customer-hero.with-image{gap:20px;padding:25px 0 23px}.customer-hero h1{font-size:clamp(38px,10vw,58px);margin-block:8px 12px}.customer-hero-copy>p{font-size:13px;line-height:1.5}.customer-hero-actions{margin-top:16px}.customer-browse-menu{min-height:44px}
  .customer-context{padding-top:16px}.customer-context strong{font-size:19px}.customer-service-choice button{font-size:11px}
  .customer-promotion{min-height:170px;margin-bottom:14px}.customer-promotion>div{padding:25px 25px 42px}.customer-promotion h2{font-size:30px}.customer-promotion>img{min-height:170px}
  .customer-tools{position:sticky;top:68px;z-index:100;gap:9px;margin-inline:-20px;padding:10px 20px 9px;background:color-mix(in srgb,var(--customer-background) 96%,transparent);border-top:1px solid var(--customer-line);box-shadow:0 8px 20px #183d2a0d;backdrop-filter:blur(14px);scroll-margin-top:68px}.customer-tools input{height:46px;font-size:16px}.customer-categories{width:100%;margin-inline:-3px;scrollbar-width:none}.customer-categories::-webkit-scrollbar{display:none}.customer-categories button{padding-inline:16px}
  .customer-order-layout{padding-top:18px}.customer-cart-wrap{display:flex;align-items:flex-end;padding:0;background:#102b23aa}.customer-cart-panel{width:100%;max-height:92dvh;overflow:auto;background:white;border-radius:22px 22px 0 0;padding-top:12px;padding-bottom:env(safe-area-inset-bottom)}.customer-cart-wrap :deep(.customer-cart){max-height:none;overflow:visible}.customer-cart-close{z-index:3;right:18px;top:max(14px,env(safe-area-inset-top));width:44px;height:44px}.customer-voucher{margin:0 20px 10px;padding:12px}.customer-voucher input{height:44px;font-size:16px}
  .customer-mobile-order-bar{position:fixed;z-index:400;left:12px;right:12px;bottom:calc(10px + env(safe-area-inset-bottom));display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:66px;border:0;border-radius:18px;padding:10px 12px 10px 17px;background:var(--customer-accent);color:var(--customer-accent-ink);box-shadow:0 18px 50px #102b2355;text-align:left}.customer-mobile-order-bar span{display:grid;gap:2px}.customer-mobile-order-bar small{font-size:10px;opacity:.82}.customer-mobile-order-bar strong{font-size:16px}.customer-mobile-order-bar b{display:flex;align-items:center;gap:12px;min-height:44px;padding:0 13px;border-radius:12px;background:var(--customer-accent-ink);color:var(--customer-accent);font-size:12px}.customer-footer{padding-bottom:115px}
}
@media(max-width:600px){
  .customer-main{padding-inline:12px}.customer-wordmark{max-width:none}.customer-account{max-width:105px}.customer-mobile-cart{font-size:0}.customer-mobile-cart::before{content:'Cart';font-size:11px}.customer-mobile-cart b{font-size:10px}
  .customer-hero,.customer-hero.with-image{gap:14px}.customer-hero h1{font-size:38px}.customer-hero-copy>p{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.customer-hero-image{height:150px}.customer-auth-choice>span{display:none}.customer-context{gap:6px}.customer-context small{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .customer-promotion{display:grid;grid-template-columns:minmax(0,1fr) 92px;min-height:145px;border-radius:14px}.customer-promotion>div{min-height:145px;padding:21px 20px 38px}.customer-promotion h2{font-size:26px;margin-block:7px}.customer-promotion p{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:10px}.customer-promotion>img{display:block;min-height:145px;height:100%}.customer-promotion nav{left:20px;bottom:12px}
  .customer-tools{margin-inline:-12px;padding-inline:12px}.customer-products{gap:9px}.customer-product{grid-template-columns:104px minmax(0,1fr);min-height:148px;border-radius:13px}.customer-product.without-image{grid-template-columns:1fr}.customer-product-image{height:auto;min-height:148px}.customer-product-copy{padding:13px}.customer-product h3{font-size:18px;margin:5px 0 6px}.customer-product p{-webkit-line-clamp:1}.customer-product-buy{margin-top:11px}.customer-product-buy select{grid-column:1/-1;height:44px;font-size:16px}.customer-product-buy button{height:44px;padding-inline:13px;border-radius:10px}.customer-price{gap:6px}.customer-price strong{font-size:14px}.customer-price small{font-size:7px}.customer-sold-out{min-height:44px;display:flex;align-items:center}
}
.customer-quick-nav{display:flex;align-items:center;gap:4px;margin-left:auto;margin-right:16px}.customer-quick-nav button{min-height:38px;border:0;border-radius:999px;padding:0 12px;background:transparent;color:var(--customer-page-ink);font:700 10px var(--customer-font)}.customer-quick-nav button:hover{background:var(--customer-tint)}
.customer-hero{grid-template-columns:minmax(0,760px);align-items:center;padding-block:46px 28px}.customer-hero.with-image{grid-template-columns:minmax(0,1fr) minmax(300px,.72fr)}.customer-hero-image{height:clamp(240px,30vw,390px)}
.customer-order-context{scroll-margin-top:86px;display:grid;grid-template-columns:minmax(260px,.75fr) minmax(320px,1.25fr);gap:34px;align-items:center;margin-bottom:28px;padding:24px 28px;border:1px solid var(--customer-line);border-radius:16px;background:#fff;color:var(--customer-ink);box-shadow:0 12px 36px #102b230d}.customer-context-heading h2{margin:6px 0 7px;font:600 25px/1.1 var(--customer-font)}.customer-context-heading p{max-width:470px;margin:0;color:var(--customer-muted);font-size:10px;line-height:1.55}.customer-order-context .customer-context{padding-left:28px;border-color:var(--customer-line)}
.customer-promo-ready{display:flex;align-items:center;gap:12px;margin-bottom:14px;padding:12px 15px;border:1px solid color-mix(in srgb,var(--customer-accent) 35%,var(--customer-line));border-radius:12px;background:color-mix(in srgb,var(--customer-accent) 7%,white);color:var(--customer-ink)}.customer-promo-ready>span{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:var(--customer-accent);color:var(--customer-accent-ink);font-weight:800}.customer-promo-ready>div{display:grid;gap:2px}.customer-promo-ready strong{font-size:11px}.customer-promo-ready small{color:var(--customer-muted);font-size:9px}
.customer-tools{display:grid;grid-template-columns:auto minmax(240px,420px) auto;grid-template-areas:'heading search fulfillment' 'categories categories categories';gap:12px 18px}.customer-menu-heading{grid-area:heading;display:flex;align-items:baseline;gap:8px}.customer-menu-heading strong{font-size:11px}.customer-tools>label{grid-area:search}.customer-fulfillment-summary{grid-area:fulfillment;display:grid;gap:2px;min-width:150px;min-height:42px;padding:6px 12px;border:1px solid var(--customer-line);border-radius:9px;background:white;color:var(--customer-ink);text-align:left}.customer-fulfillment-summary span{color:var(--customer-muted);font-size:8px;text-transform:uppercase;letter-spacing:.09em}.customer-fulfillment-summary strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.customer-categories{grid-area:categories}.customer-categories button{display:flex;align-items:center;gap:8px}.customer-categories button small{display:grid;place-items:center;min-width:18px;height:18px;border-radius:999px;background:var(--customer-tint);color:var(--customer-muted);font-size:8px}.customer-categories button.active small{background:var(--customer-accent-ink);color:var(--customer-accent)}
.customer-products{display:grid;grid-template-columns:1fr;gap:34px}.customer-menu-group{scroll-margin-top:176px}.customer-menu-group>header{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:12px;padding:0 3px}.customer-menu-group>header h2{margin:5px 0 0;font:600 28px/1 var(--customer-font);letter-spacing:-.025em}.customer-menu-group>header>span{color:var(--customer-muted);font-size:9px}.customer-product-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.customer-product h3{font:600 21px/1.08 var(--customer-font);margin:7px 0 8px;letter-spacing:-.015em}
@media(max-width:1150px){.customer-product-grid{grid-template-columns:1fr}}
@media(max-width:920px){.customer-quick-nav{display:none}.customer-order-context{grid-template-columns:1fr;gap:15px;padding:19px 20px}.customer-order-context .customer-context{padding:15px 0 0;border-top:1px solid var(--customer-line);border-left:0}.customer-tools{grid-template-columns:1fr auto;grid-template-areas:'heading fulfillment' 'search search' 'categories categories';top:68px}.customer-menu-heading{display:none}.customer-fulfillment-summary{min-width:0}.customer-menu-group{scroll-margin-top:190px}}
@media(max-width:600px){.customer-hero.with-image{grid-template-columns:1fr}.customer-hero-image{grid-row:1;height:176px}.customer-order-context{margin-bottom:14px;padding:16px;border-radius:13px}.customer-context-heading h2{font-size:21px}.customer-tools{grid-template-columns:minmax(0,1fr) 112px;margin-inline:-12px}.customer-fulfillment-summary{min-width:0}.customer-product-grid{gap:8px}.customer-menu-group{scroll-margin-top:198px}.customer-menu-group>header{margin-bottom:9px}.customer-menu-group>header h2{font-size:23px}.customer-product h3{font-size:18px;margin:5px 0 6px}}
@media(prefers-reduced-motion:reduce){.customer-product,.customer-cart-wrap{transition:none}.customer-product:hover{transform:none}}
</style>
