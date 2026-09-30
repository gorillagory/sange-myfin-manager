<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { formatCustomerMoney } from '../../domain/customerOrdering';
import {
  loadCustomerOrders,
  registerCustomerAccount,
  signInCustomerAccount,
  signOutCustomerAccount,
  updateCustomerMarketingConsent,
  updateCustomerProfile,
} from '../../services/customerOrdering';

const props = defineProps({
  open: { type: Boolean, default: false },
  account: { type: Object, default: () => ({ authenticated: false }) },
  loading: { type: Boolean, default: false },
  privacy: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['close', 'account-change']);

const authMode = ref('sign-in');
const section = ref('overview');
const submitting = ref(false);
const signingOut = ref(false);
const actionError = ref('');
const success = ref('');
const orders = ref([]);
const ordersLoading = ref(false);
const ordersError = ref('');
const signIn = reactive({ email: '', password: '' });
const registration = reactive({ displayName: '', email: '', phone: '', password: '', adultConfirmed: false });
const profile = reactive({ displayName: '', phone: '' });
const consent = reactive({ email: false, sms: false, whatsapp: false });
const consentBusy = reactive({ email: false, sms: false, whatsapp: false });

const authenticated = computed(() => Boolean(props.account?.authenticated));
const customer = computed(() => props.account?.customer || {});
const loyalty = computed(() => props.account?.loyalty || {});
const privacyReady = computed(() => Boolean(props.privacy?.controllerName && props.privacy?.controllerContact &&
  /^https:\/\//i.test(props.privacy?.noticeUrl || '') && props.privacy?.noticeEn && props.privacy?.noticeMs));
const loyaltyProgress = computed(() => {
  const required = Math.max(1, Number(loyalty.value.stampsRequired) || 10);
  const balance = Math.max(0, Number(loyalty.value.stampBalance) || 0);
  return { required, balance, percent: Math.min(100, (balance / required) * 100) };
});

function hydrateAccount() {
  const source = props.account || {};
  profile.displayName = source.profile?.displayName || source.customer?.displayName || '';
  profile.phone = source.profile?.phone || '';
  for (const channel of ['email', 'sms', 'whatsapp']) consent[channel] = Boolean(source.marketingConsent?.[channel]?.granted);
}

function friendlyError(caught, fallback) {
  const messages = {
    customer_account_unavailable: 'An account already uses this email. Sign in instead.',
    customer_authentication_failed: 'The email or password is incorrect. Repeated attempts may temporarily lock the account.',
    customer_authentication_busy: 'Sign-in is busy right now. Wait a moment and try again.',
    customer_session_required: 'Your session has ended. Sign in again.',
    storefront_privacy_notice_unavailable: 'Account changes are paused until this shop publishes its privacy notice.',
    invalid_input: 'Check the highlighted details and try again.',
    rate_limited: 'There have been too many attempts. Wait a moment and try again.',
  };
  if (caught?.network) return 'You appear to be offline. Reconnect and try again.';
  return messages[caught?.message] || fallback;
}

async function authenticate(kind) {
  if (submitting.value) return;
  submitting.value = true; actionError.value = ''; success.value = '';
  try {
    const result = kind === 'register'
      ? await registerCustomerAccount({
        displayName: registration.displayName.trim(), email: registration.email.trim().toLowerCase(),
        phone: registration.phone.trim(), password: registration.password, adultConfirmed: registration.adultConfirmed,
      })
      : await signInCustomerAccount({ email: signIn.email.trim().toLowerCase(), password: signIn.password });
    emit('account-change', result);
    section.value = 'overview';
    success.value = kind === 'register' ? 'Your account is ready on this device.' : 'Signed in successfully.';
    signIn.password = ''; registration.password = '';
    await refreshOrders();
  } catch (caught) { actionError.value = friendlyError(caught, 'The account request could not be completed. Try again.'); }
  finally { submitting.value = false; }
}

async function saveProfile() {
  if (submitting.value) return;
  submitting.value = true; actionError.value = ''; success.value = '';
  try {
    const result = await updateCustomerProfile({ displayName: profile.displayName.trim(), phone: profile.phone.trim() });
    emit('account-change', result);
    success.value = 'Profile saved for this workspace.';
  } catch (caught) { actionError.value = friendlyError(caught, 'Your profile could not be saved.'); }
  finally { submitting.value = false; }
}

async function changeConsent(channel, granted) {
  if (consentBusy[channel]) return;
  const previous = !granted;
  consent[channel] = granted;
  consentBusy[channel] = true; actionError.value = ''; success.value = '';
  try {
    const result = await updateCustomerMarketingConsent(channel, granted);
    emit('account-change', result);
    success.value = granted ? `${channelLabel(channel)} marketing choice recorded.` : `${channelLabel(channel)} marketing withdrawn.`;
  } catch (caught) {
    consent[channel] = previous;
    actionError.value = friendlyError(caught, 'Your marketing choice could not be saved.');
  } finally { consentBusy[channel] = false; }
}

async function logout() {
  if (signingOut.value) return;
  signingOut.value = true; actionError.value = ''; success.value = '';
  try {
    await signOutCustomerAccount();
    orders.value = [];
    emit('account-change', { authenticated: false });
    authMode.value = 'sign-in';
    success.value = 'Signed out. You can continue ordering as a guest.';
  } catch (caught) { actionError.value = friendlyError(caught, 'Sign-out could not be completed.'); }
  finally { signingOut.value = false; }
}

async function refreshOrders() {
  ordersLoading.value = true; ordersError.value = '';
  try { orders.value = (await loadCustomerOrders(20)).rows || []; }
  catch (caught) {
    orders.value = [];
    ordersError.value = friendlyError(caught, 'Recent orders could not be loaded.');
  } finally { ordersLoading.value = false; }
}

const channelLabel = channel => ({ email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' })[channel] || channel;
const statusLabel = status => ({
  submitted: 'Awaiting acceptance', accepted: 'Accepted', preparing: 'Preparing', ready: 'Ready to collect',
  paid: 'Paid', completed: 'Collected', cancelled: 'Cancelled', expired: 'Expired', declined: 'Unavailable',
})[String(status || '').toLowerCase()] || 'Received';
const orderDate = value => value ? new Intl.DateTimeFormat('en-MY', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur',
}).format(new Date(value)) : '';
const close = () => emit('close');
function onKeydown(event) { if (event.key === 'Escape' && props.open && !submitting.value) close(); }

watch(() => props.account, hydrateAccount, { immediate: true, deep: true });
watch(() => [props.open, props.account?.authenticated, props.account?.customer?.id], ([open, signedIn]) => {
  actionError.value = ''; success.value = '';
  if (open && signedIn) refreshOrders();
});
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="account-backdrop" role="presentation" @mousedown.self="close">
      <aside class="account-panel" role="dialog" aria-modal="true" aria-labelledby="account-title">
        <header class="account-header">
          <div><span class="account-kicker">MYFIN CUSTOMER</span><h2 id="account-title">{{ authenticated ? 'Your account' : 'Sign in or join' }}</h2></div>
          <button type="button" class="account-close" aria-label="Close customer account" @click="close">×</button>
        </header>

        <div v-if="loading" class="account-loading" role="status"><i></i><span>Checking your account…</span></div>

        <div v-else-if="!authenticated" class="account-body auth-body">
          <div class="account-auth-tabs" role="tablist" aria-label="Customer account">
            <button type="button" role="tab" :aria-selected="authMode==='sign-in'" :class="{active:authMode==='sign-in'}" @click="authMode='sign-in'; actionError=''; success=''">Sign in</button>
            <button type="button" role="tab" :aria-selected="authMode==='register'" :class="{active:authMode==='register'}" @click="authMode='register'; actionError=''; success=''">Create account</button>
          </div>

          <div class="account-intro">
            <strong>One login for participating finn3 shops</strong>
            <p>Your customer login travels with you. Loyalty balances and marketing choices remain separate for each workspace.</p>
          </div>

          <form v-if="authMode==='sign-in'" class="account-form" @submit.prevent="authenticate('sign-in')">
            <label><span>Email address</span><input v-model="signIn.email" type="email" autocomplete="email" maxlength="254" required placeholder="you@example.com"></label>
            <label><span>Password</span><input v-model="signIn.password" type="password" autocomplete="current-password" minlength="12" maxlength="128" required></label>
            <button class="account-primary" type="submit" :disabled="submitting">{{ submitting ? 'Signing in…' : 'Sign in' }}</button>
          </form>

          <form v-else class="account-form" @submit.prevent="authenticate('register')">
            <label><span>Name</span><input v-model="registration.displayName" autocomplete="name" maxlength="120" required placeholder="Name for orders"></label>
            <label><span>Email address</span><input v-model="registration.email" type="email" autocomplete="email" maxlength="254" required placeholder="you@example.com"></label>
            <label><span>Phone <small>optional</small></span><input v-model="registration.phone" type="tel" autocomplete="tel" maxlength="80" placeholder="+60…"></label>
            <label><span>Password <small>at least 12 characters</small></span><input v-model="registration.password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
            <label class="adult-confirm"><input v-model="registration.adultConfirmed" type="checkbox" required><span>I confirm I am 18 or older.</span></label>
            <section v-if="privacy.noticeEn && privacy.noticeMs" class="account-privacy" aria-labelledby="account-privacy-title">
              <h3 id="account-privacy-title">Your account information / Maklumat akaun anda</h3>
              <p><strong>{{ privacy.controllerName }}</strong> · {{ privacy.controllerContact }}</p>
              <p lang="en">{{ privacy.noticeEn }}</p><p lang="ms">{{ privacy.noticeMs }}</p>
              <a :href="privacy.noticeUrl" target="_blank" rel="noopener noreferrer">Read the full privacy notice / Baca notis privasi penuh ↗</a>
            </section>
            <div v-else class="account-message error" role="alert">Account registration is paused while this shop's privacy notice is unavailable.</div>
            <button class="account-primary" type="submit" :disabled="submitting || !privacyReady">{{ submitting ? 'Creating account…' : 'Create account' }}</button>
          </form>

          <p class="account-identity-note"><strong>Email is not verified yet.</strong> External SSO is prepared for future integration but is not active. Use your email and password to sign in.</p>
          <div v-if="actionError" class="account-message error" role="alert">{{ actionError }}</div>
          <div v-if="success" class="account-message success" role="status">{{ success }}</div>
          <button type="button" class="account-guest" @click="close">Continue as guest</button>
        </div>

        <template v-else>
          <div class="account-identity">
            <div class="account-avatar" aria-hidden="true">{{ (customer.displayName || customer.email || '?').slice(0,1).toUpperCase() }}</div>
            <div><strong>{{ customer.displayName || 'Customer' }}</strong><span>{{ customer.email }}</span></div>
            <span class="account-verification" :class="{verified:customer.emailVerified}">{{ customer.emailVerified ? 'Verified email' : 'Unverified email' }}</span>
          </div>
          <nav class="account-sections" aria-label="Customer account sections">
            <button v-for="item in [{id:'overview',label:'Overview'},{id:'profile',label:'Profile'},{id:'marketing',label:'Marketing'}]" :key="item.id" type="button" :class="{active:section===item.id}" @click="section=item.id; actionError=''; success=''">{{ item.label }}</button>
          </nav>

          <div class="account-body signed-in-body">
            <template v-if="section==='overview'">
              <section v-if="loyalty.enabled" class="loyalty-card">
                <span class="account-kicker">THIS WORKSPACE</span>
                <div><strong>{{ loyaltyProgress.balance }} <small>/ {{ loyaltyProgress.required }} stamps</small></strong><span>{{ loyalty.rewardLabel || 'Reward' }}</span></div>
                <div class="loyalty-track"><i :style="{width:`${loyaltyProgress.percent}%`}"></i></div>
                <p>Earn one stamp after each eligible paid order here. Other workspaces keep their own balance.</p>
              </section>
              <section v-else class="loyalty-card disabled"><span class="account-kicker">THIS WORKSPACE</span><strong>Loyalty is not active here</strong><p>Your account still keeps your profile and order history for this shop.</p></section>

              <section class="recent-orders">
                <header><div><span class="account-kicker">THIS SHOP</span><h3>Recent orders</h3></div><button type="button" :disabled="ordersLoading" @click="refreshOrders">Refresh</button></header>
                <p v-if="ordersLoading" class="account-muted" role="status">Loading recent orders…</p>
                <div v-else-if="ordersError" class="account-message error" role="alert">{{ ordersError }}</div>
                <div v-else-if="!orders.length" class="account-empty"><strong>No account orders here yet</strong><span>Orders placed while signed in will appear here.</span></div>
                <template v-else><RouterLink v-for="order in orders" :key="order.id || order.code" class="order-row" :to="`/order/${encodeURIComponent(order.code)}`" @click="close">
                  <span><strong>#{{ order.code }}</strong><small>{{ orderDate(order.createdAt) }} · {{ order.location?.name || 'Shop counter' }}</small></span>
                  <span><strong>{{ formatCustomerMoney(order.total, order.currency) }}</strong><small>{{ statusLabel(order.status) }}</small></span>
                </RouterLink></template>
              </section>
            </template>

            <form v-else-if="section==='profile'" class="account-form" @submit.prevent="saveProfile">
              <div class="account-section-copy"><h3>Workspace profile</h3><p>This name and phone prefill checkout in this workspace. Your login email remains the same across participating shops.</p></div>
              <label><span>Name</span><input v-model="profile.displayName" autocomplete="name" maxlength="120" required></label>
              <label><span>Phone <small>optional</small></span><input v-model="profile.phone" type="tel" autocomplete="tel" maxlength="80" placeholder="+60…"></label>
              <label><span>Login email</span><input :value="customer.email" type="email" disabled></label>
              <p v-if="!customer.emailVerified" class="account-identity-note"><strong>Email is unverified.</strong> Verification and external SSO are not active yet.</p>
              <button class="account-primary" type="submit" :disabled="submitting || !privacyReady">{{ submitting ? 'Saving…' : 'Save profile' }}</button>
            </form>

            <section v-else class="marketing-section">
              <div class="account-section-copy"><h3>Marketing choices</h3><p>Choose each channel separately for this workspace. Leave every choice off to receive no marketing, or switch a channel off later to withdraw it.</p></div>
              <label v-for="channel in ['email','sms','whatsapp']" :key="channel" class="consent-row">
                <span><strong>{{ channelLabel(channel) }}</strong><small>{{ consent[channel] ? 'Choice recorded' : 'No marketing on this channel' }}</small></span>
                <input :checked="consent[channel]" type="checkbox" role="switch" :disabled="consentBusy[channel]" @change="changeConsent(channel,$event.target.checked)">
              </label>
              <p class="account-identity-note"><strong>No marketing messages are sent until the contact channel is verified and a messaging integration is enabled.</strong> Recording a choice here does not start messaging by itself, and you can withdraw it at any time.</p>
            </section>

            <div v-if="actionError" class="account-message error" role="alert">{{ actionError }}</div>
            <div v-if="success" class="account-message success" role="status">{{ success }}</div>
          </div>
          <footer class="account-footer"><span>You can still order as a guest after signing out.</span><button type="button" :disabled="signingOut" @click="logout">{{ signingOut ? 'Signing out…' : 'Sign out' }}</button></footer>
        </template>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.account-backdrop{--ink:#15382c;--muted:#68776f;--line:#d8dfd8;--tint:#f1f5ed;--accent:#17624d;position:fixed;inset:0;z-index:1400;background:#102b238f;backdrop-filter:blur(4px);display:flex;justify-content:flex-end;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:var(--ink)}
.account-panel{width:min(520px,100%);height:100dvh;background:#fff;box-shadow:-24px 0 80px #102b2340;display:flex;flex-direction:column;overflow:hidden}.account-header{display:flex;align-items:start;justify-content:space-between;padding:28px 30px 22px;border-bottom:1px solid var(--line)}.account-kicker{font-size:9px;letter-spacing:.18em;font-weight:750;color:var(--muted)}.account-header h2{font:400 34px/1 Georgia,serif;margin:8px 0 0}.account-close{border:0;background:none;color:var(--muted);font-size:29px;line-height:1;padding:0 3px}.account-loading{display:flex;align-items:center;justify-content:center;gap:12px;min-height:280px;color:var(--muted);font-size:12px}.account-loading i{width:22px;height:22px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:account-spin .7s linear infinite}.account-body{padding:25px 30px;overflow:auto}.auth-body{display:flex;flex-direction:column;gap:18px}.account-auth-tabs,.account-sections{display:flex;border-bottom:1px solid var(--line)}.account-auth-tabs button,.account-sections button{flex:1;border:0;border-bottom:2px solid transparent;background:none;color:var(--muted);padding:11px 8px;font-size:11px;font-weight:700}.account-auth-tabs button.active,.account-sections button.active{border-color:var(--accent);color:var(--ink)}.account-intro{padding:15px;background:var(--tint);border-radius:9px}.account-intro strong{font-size:13px}.account-intro p,.account-section-copy p{font-size:11px;line-height:1.55;color:var(--muted);margin:6px 0 0}.account-form{display:flex;flex-direction:column;gap:15px}.account-form label{display:flex;flex-direction:column;gap:6px;font-size:11px;font-weight:700}.account-form label span{display:flex;justify-content:space-between}.account-form label small{color:var(--muted);font-weight:500}.account-form input{width:100%;min-height:44px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--ink);padding:9px 11px;font-size:16px}.account-form input:disabled{background:#f4f5f2;color:var(--muted)}.account-primary{border:0;border-radius:7px;background:var(--accent);color:#fff;min-height:46px;padding:0 18px;font-weight:750}.account-primary:disabled{opacity:.55}.account-identity-note{font-size:10px;line-height:1.55;color:var(--muted);margin:0;padding:12px;border-left:3px solid #d2bd7c;background:#fff9e9}.account-identity-note strong{color:#695018}.account-message{border:1px solid;border-radius:7px;padding:11px 13px;font-size:11px;line-height:1.45}.account-message.error{border-color:#e7c5bb;background:#fff2ee;color:#813b29}.account-message.success{border-color:#b7d9c2;background:#eaf6ee;color:#17603b}.account-guest{border:0;background:none;color:var(--accent);font-size:11px;font-weight:750;text-decoration:underline;text-underline-offset:3px}.account-identity{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:center;padding:18px 30px;background:var(--tint)}.account-avatar{width:42px;height:42px;display:grid;place-items:center;border-radius:50%;background:var(--accent);color:#fff;font:400 20px Georgia,serif}.account-identity>div:nth-child(2){display:flex;flex-direction:column;min-width:0}.account-identity strong{font-size:12px}.account-identity span{font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.account-verification{border:1px solid #e1c778;background:#fff9e9;color:#745918!important;border-radius:999px;padding:6px 8px;font-size:8px!important;font-weight:750;text-transform:uppercase;letter-spacing:.08em}.account-verification.verified{border-color:#afd5bc;background:#e8f5ec;color:#17603b!important}.signed-in-body{display:flex;flex-direction:column;gap:20px}.loyalty-card{padding:20px;border-radius:12px;background:linear-gradient(145deg,#183c30,#0f5945);color:#fff}.loyalty-card>.account-kicker{color:#a9c7b8}.loyalty-card>div:nth-child(2){display:flex;justify-content:space-between;align-items:end;margin:15px 0 12px}.loyalty-card strong{font:400 32px Georgia,serif}.loyalty-card strong small{font:500 11px Inter,sans-serif;opacity:.75}.loyalty-card>div:nth-child(2)>span{font-size:11px;font-weight:700}.loyalty-track{height:6px;background:#ffffff30;border-radius:999px;overflow:hidden}.loyalty-track i{display:block;height:100%;background:#e0c86e;border-radius:999px}.loyalty-card p{font-size:10px;line-height:1.5;color:#c8d9d1;margin:11px 0 0}.loyalty-card.disabled{background:var(--tint);color:var(--ink)}.loyalty-card.disabled>.account-kicker,.loyalty-card.disabled p{color:var(--muted)}.loyalty-card.disabled strong{display:block;font:400 22px Georgia,serif;margin-top:12px}.recent-orders>header{display:flex;align-items:end;justify-content:space-between;margin-bottom:9px}.recent-orders h3,.account-section-copy h3{font:400 25px Georgia,serif;margin:5px 0 0}.recent-orders header button{border:0;background:none;color:var(--accent);font-size:10px;font-weight:700}.order-row{display:flex;justify-content:space-between;gap:15px;padding:13px 3px;border-top:1px solid var(--line);color:var(--ink);text-decoration:none}.order-row>span{display:flex;flex-direction:column;gap:4px}.order-row>span:last-child{text-align:right}.order-row strong{font-size:11px}.order-row small{font-size:9px;color:var(--muted)}.order-row:hover strong{color:var(--accent)}.account-muted{font-size:11px;color:var(--muted)}.account-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:5px;padding:28px;border:1px dashed var(--line);border-radius:9px}.account-empty strong{font-size:12px}.account-empty span{font-size:10px;color:var(--muted)}.account-section-copy{padding-bottom:5px}.marketing-section{display:flex;flex-direction:column;gap:0}.consent-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:15px 2px;border-top:1px solid var(--line)}.consent-row>span{display:flex;flex-direction:column;gap:4px}.consent-row strong{font-size:12px}.consent-row small{font-size:9px;color:var(--muted)}.consent-row input{appearance:none;width:40px;height:22px;padding:2px;border:1px solid var(--line);background:#dfe3df;border-radius:999px;transition:.15s}.consent-row input:before{content:'';display:block;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 4px #0002;transition:.15s}.consent-row input:checked{background:var(--accent);border-color:var(--accent)}.consent-row input:checked:before{transform:translateX(18px)}.consent-row input:disabled{opacity:.5}.account-footer{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:16px 30px;border-top:1px solid var(--line);background:var(--tint)}.account-footer span{font-size:9px;color:var(--muted)}.account-footer button{border:1px solid var(--line);border-radius:999px;background:#fff;color:var(--ink);padding:8px 13px;font-size:10px;font-weight:700}@keyframes account-spin{to{transform:rotate(360deg)}}
.account-form .adult-confirm{display:flex;flex-direction:row;align-items:flex-start;justify-content:flex-start;gap:9px;font-weight:600;line-height:1.4}.account-form .adult-confirm input{width:17px;min-height:17px;height:17px;flex:0 0 17px;margin:1px 0 0;padding:0;accent-color:var(--accent)}.account-form .adult-confirm span{display:block}.account-privacy{padding:14px;border:1px solid var(--line);border-radius:8px;background:#f8faf6}.account-privacy h3{font:600 12px Inter,sans-serif;margin:0 0 8px}.account-privacy p{font-size:9px;line-height:1.5;color:var(--muted);margin:5px 0}.account-privacy a{display:inline-block;margin-top:5px;color:var(--accent);font-size:9px;font-weight:700}
@media(max-width:560px){.account-backdrop{align-items:end}.account-panel{width:100%;height:min(94dvh,850px);border-radius:18px 18px 0 0}.account-header,.account-body{padding-inline:20px}.account-identity{padding-inline:20px;grid-template-columns:auto minmax(0,1fr)}.account-verification{grid-column:2;justify-self:start}.account-footer{padding-inline:20px}}
</style>
