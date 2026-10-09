<script setup>
import { computed, ref, watch } from 'vue';
import { Store } from '../../store';
import { api, companyPath } from '../../services/api';
import {
  eligibilityActions, eligibilityStatusLabel, promotionPayload, ringgitFromSen,
  senFromRinggit, studentReviewPayload, voucherPayload,
} from '../../domain/studentPrograms';
import Icon from '../ui/EditionIcon.vue';
import Modal from '../ui/EditionModal.vue';

const tab = ref('students'), data = ref(null), loading = ref(false), busy = ref(false), error = ref('');
const review = ref(null), promotionEditor = ref(null), voucherEditor = ref(null);
let requestVersion = 0;
const company = computed(() => Store.state.selectedCompany || {});
const students = computed(() => data.value?.students || data.value?.eligibilities || []);
const promotions = computed(() => data.value?.promotions || []);
const owner = computed(() => Store.can('promotionsManage'));
const canReviewEligibility = computed(() => Store.can('studentEligibilityReview'));

const stamp = value => {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : new Intl.DateTimeFormat('en-MY', {
    dateStyle:'medium', timeZone:'Asia/Kuala_Lumpur',
  }).format(parsed);
};
const localTime = value => {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const offset = parsed.getTimezoneOffset() * 60000;
  return new Date(parsed.getTime() - offset).toISOString().slice(0, 16);
};
const personId = row => row.customerId || row.customer_id || row.id;
const personName = row => row.displayName || row.customerName || row.customer?.displayName || row.email || 'Registered customer';
const personEmail = row => row.email || row.customerEmail || row.customer?.email || 'No email shown';
const versionOf = row => Number(row.version || row.eligibility?.version || 0);
const statusOf = row => row.status || row.eligibility?.status || '';
const institutionOf = row => row.institutionName || row.institution_name || row.eligibility?.institutionName || '';
const hintOf = row => row.referenceHint || row.reference_hint || row.eligibility?.referenceHint || '';
const expiryOf = row => row.validUntil || row.valid_until || row.eligibility?.validUntil || null;
const promotionVouchers = row => row.vouchers || row.promotionVouchers || [];
const promotionDiscount = row => row.discountType === 'percentage'
  ? `${Number(row.discountBasisPoints || 0) / 100}%`
  : `RM ${ringgitFromSen(row.discountSen || 0)}`;
const promotionScope = row => {
  const pieces = [];
  if (row.requiresStudent) pieces.push('verified students');
  else if (row.requiresCustomer) pieces.push('registered customers');
  else pieces.push('all customers');
  const targets = (row.productTargets?.length || 0) + (row.categoryTargets?.length || 0) + (row.customerTargets?.length || 0);
  if (targets) pieces.push(`${targets} scoped target${targets === 1 ? '' : 's'}`);
  return pieces.join(' · ');
};

async function loadPage(after = '', append = false) {
  const current = ++requestVersion;
  if (!company.value.id) { data.value = null; return; }
  loading.value = true; error.value = '';
  try {
    const query = `?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const result = await api(companyPath(Store, `/student-programs${query}`));
    if (current === requestVersion) data.value = append
      ? { ...result, students:[...(data.value?.students || []), ...(result.students || [])] }
      : result;
  } catch (caught) {
    if (current === requestVersion) error.value = caught.message || 'Student programs could not be loaded.';
  } finally { if (current === requestVersion) loading.value = false; }
}
const load = () => loadPage();
const loadMore = () => data.value?.next && loadPage(data.value.next, true);

function openReview(row, status) {
  if (!canReviewEligibility.value) return;
  review.value = {
    row, expectedVersion:versionOf(row), status,
    institutionName:institutionOf(row), referenceHint:hintOf(row),
    validUntil:status === 'verified' ? localTime(expiryOf(row) || Date.now() + 365 * 86400000) : '', reason:'',
  };
  error.value = '';
}

async function saveReview() {
  busy.value = true; error.value = '';
  try {
    const payload = studentReviewPayload(review.value);
    await api(companyPath(Store, `/student-eligibilities/${encodeURIComponent(personId(review.value.row))}`), {
      method:'PUT', body:payload,
    });
    review.value = null;
    await load();
  } catch (caught) { error.value = caught.message || 'The student review could not be saved.'; }
  finally { busy.value = false; }
}

const emptyPromotion = () => ({
  expectedVersion:0, name:'', enabled:false, redemptionMode:'automatic',
  validFrom:localTime(new Date()), validUntil:'', discountType:'percentage', discountAmount:'10.00',
  maxDiscount:'', minimumSpend:'0.00', maxTotalRedemptions:'', perCustomerLimit:'',
  requiresCustomer:false, requiresStudent:false, stackable:false, priority:0,
  productTargets:'', categoryTargets:'', customerTargets:'',
});
const targetsText = (targets, fields) => (targets || []).map(row => typeof row === 'string' ? row :
  fields.map(field => row[field]).filter(Boolean).join('/')).join(', ');
function editPromotion(row = null) {
  if (!row) promotionEditor.value = { ...emptyPromotion(), _new:true };
  else promotionEditor.value = {
    ...emptyPromotion(), ...row, _new:false, expectedVersion:Number(row.version),
    validFrom:localTime(row.validFrom), validUntil:localTime(row.validUntil),
    discountAmount:row.discountType === 'percentage'
      ? String(Number(row.discountBasisPoints) / 100) : ringgitFromSen(row.discountSen),
    maxDiscount:ringgitFromSen(row.maxDiscountSen), minimumSpend:ringgitFromSen(row.minSubtotalSen || 0),
    maxTotalRedemptions:row.maxTotalRedemptions ?? '', perCustomerLimit:row.perCustomerLimit ?? '',
    productTargets:targetsText(row.productTargets, ['productId', 'variantId']),
    categoryTargets:targetsText(row.categoryTargets, ['category', 'subcategory']),
    customerTargets:targetsText(row.customerTargets, ['customerId']),
  };
  error.value = '';
}
function promotionRequest(form) {
  const discountSen = form.discountType === 'fixed' ? senFromRinggit(form.discountAmount, 'Discount') : null;
  const discountBasisPoints = form.discountType === 'percentage' ? senFromRinggit(form.discountAmount, 'Discount percentage') : null;
  return promotionPayload({
    ...form, discountSen, discountBasisPoints,
    maxDiscountSen:senFromRinggit(form.maxDiscount, 'Maximum discount', { nullable:true }),
    minSubtotalSen:senFromRinggit(form.minimumSpend || '0', 'Minimum spend'),
  });
}
async function savePromotion() {
  busy.value = true; error.value = '';
  try {
    const payload = promotionRequest(promotionEditor.value);
    const suffix = promotionEditor.value._new ? '/student-promotions'
      : `/student-promotions/${encodeURIComponent(promotionEditor.value.id)}`;
    await api(companyPath(Store, suffix), { method:promotionEditor.value._new ? 'POST' : 'PUT', body:payload });
    promotionEditor.value = null;
    await load();
  } catch (caught) { error.value = caught.message || 'The promotion could not be saved.'; }
  finally { busy.value = false; }
}

function editVoucher(promotion, voucher = null) {
  voucherEditor.value = voucher ? {
    ...voucher, promotion, _new:false, expectedVersion:Number(voucher.version), code:'',
    validFrom:localTime(voucher.validFrom), validUntil:localTime(voucher.validUntil),
    maxRedemptions:voucher.maxRedemptions ?? '', perCustomerLimit:voucher.perCustomerLimit ?? '',
  } : {
    promotion, _new:true, expectedVersion:0, code:'', enabled:false,
    validFrom:localTime(new Date()), validUntil:'', maxRedemptions:'', perCustomerLimit:'',
  };
  error.value = '';
}
async function saveVoucher() {
  busy.value = true; error.value = '';
  try {
    const form = voucherEditor.value;
    const payload = voucherPayload(form, { creating:form._new });
    const base = `/student-promotions/${encodeURIComponent(form.promotion.id)}/vouchers`;
    const suffix = form._new ? base : `${base}/${encodeURIComponent(form.id)}`;
    await api(companyPath(Store, suffix), { method:form._new ? 'POST' : 'PUT', body:payload });
    voucherEditor.value = null;
    await load();
  } catch (caught) { error.value = caught.message || 'The voucher could not be saved.'; }
  finally { busy.value = false; }
}

watch(() => company.value.id, load, { immediate:true });
</script>

<template>
  <section class="ed-page mf-student-programs">
    <header class="ed-page-head"><div><div class="ed-eyebrow">ADMINISTRATION / STUDENT PROGRAMS</div><h1>Student access and offers.</h1><p>Review student eligibility for this workspace and configure controlled promotion versions for {{ company.name }}.</p></div><button class="ed-btn" :disabled="loading || !Store.state.online" @click="load"><Icon name="clock"/>{{ loading?'Loading…':'Refresh' }}</button></header>
    <div class="ed-notice warning"><Icon name="alert"/><div><strong>Configured foundation</strong>Promotion and voucher rules on this page are not applied to live checkout or the public storefront yet. Prices stay unchanged until the shared pricing path is connected and verified.</div></div>
    <p v-if="error && !review && !promotionEditor && !voucherEditor" class="ed-notice error" role="alert">{{ error }}</p>
    <div class="ed-tabs" role="tablist" aria-label="Student program administration">
      <button role="tab" :aria-selected="tab==='students'" :class="{active:tab==='students'}" @click="tab='students'">Student verification</button>
      <button role="tab" :aria-selected="tab==='promotions'" :class="{active:tab==='promotions'}" @click="tab='promotions'">Promotions &amp; vouchers</button>
    </div>

    <section v-if="tab==='students'" class="mf-program-section" aria-labelledby="student-verification-title">
      <div class="ed-section-head"><div><h2 id="student-verification-title">Student verification</h2><small>Managers can view eligibility. Workspace owners and super administrators control reviews across the workspace.</small></div><span class="ed-pill">{{ students.length }} customer{{ students.length===1?'':'s' }}</span></div>
      <div v-if="!canReviewEligibility" class="ed-notice"><Icon name="shield"/><div><strong>Read-only for managers</strong>A workspace owner must start, verify, reject, renew or revoke student eligibility.</div></div>
      <div class="ed-notice"><Icon name="shield"/><div><strong>Minimal verification record</strong>Check evidence outside MyFin. Never enter or upload student ID numbers, identity documents, scans or photos. Save only the institution, decision, expiry and an optional masked hint such as ***1234.</div></div>
      <div v-if="loading && !data" class="ed-empty" role="status">Loading student eligibility…</div>
      <div v-else class="ed-table-wrap"><table class="ed-table">
        <thead><tr><th>Customer</th><th>Eligibility</th><th>Institution</th><th>Reference / expiry</th><th>Review</th></tr></thead>
        <tbody>
          <tr v-for="row in students" :key="personId(row)"><td><strong>{{ personName(row) }}</strong><small>{{ personEmail(row) }}</small></td><td><span class="ed-pill" :class="{ready:statusOf(row)==='verified',warning:statusOf(row)==='pending'}">{{ eligibilityStatusLabel(statusOf(row)) }}</span><small v-if="versionOf(row)">Version {{ versionOf(row) }}</small></td><td>{{ institutionOf(row) || 'Not supplied' }}</td><td><strong>{{ hintOf(row) || 'No hint saved' }}</strong><small>{{ expiryOf(row) ? `Expires ${stamp(expiryOf(row))}` : 'No active expiry' }}</small></td><td><div v-if="canReviewEligibility" class="ed-actions"><button v-for="action in eligibilityActions({status:statusOf(row)})" :key="action" class="ed-btn small" :disabled="!Store.state.online" @click="openReview(row,action)">{{ action==='pending'?'Start review':action==='verified'?(statusOf(row)==='verified'?'Renew':'Verify'):action==='rejected'?'Reject':'Revoke' }}</button></div><span v-else class="ed-muted">Read only</span></td></tr>
          <tr v-if="!students.length"><td colspan="5" class="ed-empty">No registered customer is available for student review in this workspace.</td></tr>
        </tbody>
      </table></div><div v-if="data?.next" class="ed-actions"><button class="ed-btn" :disabled="loading" @click="loadMore">{{ loading?'Loading…':'Load more customers' }}</button></div>
    </section>

    <section v-else class="mf-program-section" aria-labelledby="promotion-title">
      <div class="ed-section-head"><div><h2 id="promotion-title">Promotions &amp; vouchers</h2><small>Every save creates an immutable rule version. Managers can review; workspace owners control configuration.</small></div><button v-if="Store.can('promotionsManage')" class="ed-btn primary" :disabled="!Store.state.online" @click="editPromotion()"><Icon name="plus"/>New promotion</button></div>
      <div v-if="!owner" class="ed-notice"><Icon name="shield"/><div><strong>Read-only for managers</strong>A workspace owner controls promotion rules and voucher creation.</div></div>
      <div v-for="row in promotions" :key="row.id" class="mf-promotion-card">
        <header><div><div class="ed-eyebrow">VERSION {{ row.version }}</div><h3>{{ row.name }}</h3><p>{{ promotionDiscount(row) }} · {{ row.redemptionMode==='voucher'?'Voucher code':'Automatic' }} · {{ promotionScope(row) }}</p></div><div class="ed-actions"><span class="ed-pill" :class="{ready:row.enabled,warning:!row.enabled}">{{ row.enabled?'Configured':'Disabled' }}</span><button v-if="owner" class="ed-btn small" @click="editPromotion(row)">Create new version</button></div></header>
        <dl class="mf-program-details"><div><dt>Validity</dt><dd>{{ stamp(row.validFrom) }} – {{ row.validUntil?stamp(row.validUntil):'No expiry' }}</dd></div><div><dt>Usage</dt><dd>{{ row.redeemedCount || row.redemptionCount || row.totalRedemptions || 0 }} redeemed<template v-if="row.maxTotalRedemptions"> / {{ row.maxTotalRedemptions }}</template></dd></div><div><dt>Stacking</dt><dd>{{ row.stackable?'May stack':'Does not stack' }} · priority {{ row.priority || 0 }}</dd></div></dl>
        <section v-if="row.redemptionMode==='voucher'" class="mf-voucher-section"><div class="ed-section-head"><div><h4>Voucher codes</h4><small>Codes are shown only as safe hints after creation.</small></div><button v-if="owner" class="ed-btn small" @click="editVoucher(row)"><Icon name="plus"/>New voucher</button></div><div v-for="voucher in promotionVouchers(row)" :key="voucher.id" class="ed-row"><div><strong>{{ voucher.codeHint || voucher.code_hint || 'Masked code' }}</strong><small>{{ stamp(voucher.validFrom) }} – {{ voucher.validUntil?stamp(voucher.validUntil):'No expiry' }} · version {{ voucher.version }}</small></div><span class="ed-pill" :class="{ready:voucher.enabled}">{{ voucher.enabled?'Configured':'Disabled' }}</span><span>{{ voucher.redeemedCount || voucher.redemptionCount || voucher.totalRedemptions || 0 }} used</span><button v-if="owner" class="ed-btn small" @click="editVoucher(row,voucher)">New version</button></div><p v-if="!promotionVouchers(row).length" class="ed-muted">No voucher has been created for this promotion.</p></section>
      </div>
      <div v-if="!loading && !promotions.length" class="ed-empty"><Icon name="spark"/><h3>No promotion rules configured.</h3><p>Create a disabled rule first, review its scope, then enable a new version when ready.</p></div>
    </section>

    <Modal v-if="review&&canReviewEligibility" :title="`${eligibilityStatusLabel(review.status)} · ${personName(review.row)}`" :busy="busy" @close="review=null;error=''">
      <div class="ed-notice"><Icon name="shield"/><div>Review evidence outside MyFin. Never enter or upload an ID number or document here.</div></div>
      <form id="student-review-form" class="ed-form-grid" @submit.prevent="saveReview">
        <label class="ed-field wide"><span>Institution name</span><input v-model="review.institutionName" required minlength="2" maxlength="160" autocomplete="organization"></label>
        <template v-if="review.status==='verified'"><label class="ed-field"><span>Masked reference hint · optional</span><input v-model="review.referenceHint" maxlength="11" pattern="\*{3}[A-Za-z0-9._-]{1,8}" placeholder="***1234"><small>Only *** and the final few safe characters.</small></label><label class="ed-field"><span>Valid until</span><input v-model="review.validUntil" type="datetime-local" required></label></template>
        <label v-if="['rejected','revoked'].includes(review.status)" class="ed-field wide"><span>Reason</span><textarea v-model="review.reason" required minlength="3" maxlength="500" rows="3"></textarea></label>
      </form>
      <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
      <template #actions><button class="ed-btn" :disabled="busy" @click="review=null;error=''">Cancel</button><button class="ed-btn primary" :disabled="busy||!Store.state.online" type="submit" form="student-review-form">{{ busy?'Saving…':'Save immutable review event' }}</button></template>
    </Modal>

    <Modal v-if="promotionEditor" :title="promotionEditor._new?'Create promotion':'Create promotion version'" wide :busy="busy" @close="promotionEditor=null;error=''">
      <div class="ed-notice warning"><Icon name="alert"/><div>This saves configuration only. It does not change prices in checkout or online ordering.</div></div>
      <form id="promotion-form" class="mf-promotion-form" @submit.prevent="savePromotion"><div class="ed-form-grid">
        <label class="ed-field wide"><span>Promotion name</span><input v-model="promotionEditor.name" required maxlength="160"></label><label class="mf-check"><input v-model="promotionEditor.enabled" type="checkbox">Configured as enabled</label>
        <label class="ed-field"><span>Redemption</span><select v-model="promotionEditor.redemptionMode"><option value="automatic">Automatic</option><option value="voucher">Voucher code</option></select></label><label class="ed-field"><span>Discount type</span><select v-model="promotionEditor.discountType"><option value="percentage">Percentage</option><option value="fixed">Fixed amount</option></select></label>
        <label class="ed-field"><span>{{ promotionEditor.discountType==='percentage'?'Discount (%)':'Discount (RM)' }}</span><input v-model="promotionEditor.discountAmount" required inputmode="decimal" pattern="\d+(\.\d{1,2})?"></label><label class="ed-field"><span>Maximum discount (RM) · optional</span><input v-model="promotionEditor.maxDiscount" inputmode="decimal" pattern="\d+(\.\d{1,2})?"></label>
        <label class="ed-field"><span>Minimum spend (RM)</span><input v-model="promotionEditor.minimumSpend" required inputmode="decimal" pattern="\d+(\.\d{1,2})?"></label><label class="ed-field"><span>Priority</span><input v-model.number="promotionEditor.priority" type="number" min="-1000000" max="1000000" step="1"></label>
        <label class="ed-field"><span>Starts</span><input v-model="promotionEditor.validFrom" type="datetime-local" required></label><label class="ed-field"><span>Expires · optional</span><input v-model="promotionEditor.validUntil" type="datetime-local"></label>
        <label class="ed-field"><span>Maximum redemptions · optional</span><input v-model="promotionEditor.maxTotalRedemptions" type="number" min="1" step="1"></label><label class="ed-field"><span>Per-customer limit · optional</span><input v-model="promotionEditor.perCustomerLimit" type="number" min="1" step="1"></label>
      </div><fieldset class="mf-rule-checks"><legend>Eligibility</legend><label><input v-model="promotionEditor.requiresCustomer" type="checkbox" :disabled="promotionEditor.requiresStudent">Requires a registered customer</label><label><input v-model="promotionEditor.requiresStudent" type="checkbox">Requires a verified student</label><label><input v-model="promotionEditor.stackable" type="checkbox">May stack with another rule</label></fieldset><div class="ed-form-grid">
        <label class="ed-field wide"><span>Category targets · optional</span><input v-model="promotionEditor.categoryTargets" placeholder="beverages/coffee, pastry"><small>Comma-separated category or category/subcategory keys.</small></label><label class="ed-field wide"><span>Product targets · optional</span><input v-model="promotionEditor.productTargets" placeholder="product-id, product-id/variant-id"></label><label class="ed-field wide"><span>Customer targets · optional</span><input v-model="promotionEditor.customerTargets" placeholder="customer-id, customer-id"></label>
      </div></form>
      <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
      <template #actions><button class="ed-btn" :disabled="busy" @click="promotionEditor=null;error=''">Cancel</button><button class="ed-btn primary" :disabled="busy||!Store.state.online" type="submit" form="promotion-form">{{ busy?'Saving…':'Save immutable version' }}</button></template>
    </Modal>

    <Modal v-if="voucherEditor" :title="voucherEditor._new?'Create voucher':'Create voucher version'" :busy="busy" @close="voucherEditor=null;error=''">
      <p><strong>{{ voucherEditor.promotion.name }}</strong></p><div class="ed-notice"><Icon name="shield"/><div><strong>{{ voucherEditor._new?'The code is accepted once.':'The code cannot be viewed or changed.' }}</strong>After creation, MyFin returns only a masked hint. Create a new voucher to rotate a code.</div></div>
      <form id="voucher-form" class="ed-form-grid" @submit.prevent="saveVoucher">
        <label v-if="voucherEditor._new" class="ed-field wide"><span>New voucher code</span><input v-model="voucherEditor.code" type="password" required minlength="6" maxlength="32" pattern="[A-Za-z0-9-]+" autocomplete="new-password"></label><div v-else class="ed-field wide"><span>Code hint</span><strong>{{ voucherEditor.codeHint || voucherEditor.code_hint || 'Masked code' }}</strong></div>
        <label class="mf-check"><input v-model="voucherEditor.enabled" type="checkbox">Configured as enabled</label><span></span><label class="ed-field"><span>Starts</span><input v-model="voucherEditor.validFrom" type="datetime-local" required></label><label class="ed-field"><span>Expires · optional</span><input v-model="voucherEditor.validUntil" type="datetime-local"></label><label class="ed-field"><span>Maximum uses · optional</span><input v-model="voucherEditor.maxRedemptions" type="number" min="1" step="1"></label><label class="ed-field"><span>Per-customer limit · optional</span><input v-model="voucherEditor.perCustomerLimit" type="number" min="1" step="1"></label>
      </form>
      <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
      <template #actions><button class="ed-btn" :disabled="busy" @click="voucherEditor=null;error=''">Cancel</button><button class="ed-btn primary" :disabled="busy||!Store.state.online" type="submit" form="voucher-form">{{ busy?'Saving…':'Save voucher version' }}</button></template>
    </Modal>
  </section>
</template>

<style scoped>
.mf-student-programs>.ed-tabs{margin:28px 0}.mf-program-section{display:grid;gap:18px}.mf-program-section>.ed-section-head{margin:0}.ed-table small{display:block;margin-top:5px}.mf-promotion-card{border:1px solid var(--ed-line);background:var(--ed-paper);padding:22px;display:grid;gap:18px}.mf-promotion-card>header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.mf-promotion-card h3{font:400 25px Georgia,serif;margin:5px 0}.mf-promotion-card header p{color:var(--ed-muted);margin:0;font-size:12px}.mf-program-details{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:0}.mf-program-details div{border-top:1px solid var(--ed-line);padding-top:12px}.mf-program-details dt{color:var(--ed-muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.mf-program-details dd{font-size:12px;margin:5px 0 0}.mf-voucher-section{border-top:1px solid var(--ed-line);padding-top:17px}.mf-voucher-section h4{margin:0}.mf-promotion-form{display:grid;gap:20px}.mf-rule-checks{border:1px solid var(--ed-line);padding:15px;display:flex;flex-wrap:wrap;gap:16px}.mf-rule-checks legend{font-size:11px;padding:0 7px;text-transform:uppercase;letter-spacing:.08em}.mf-rule-checks label,.mf-check{display:flex;align-items:center;gap:8px;font-size:12px}.mf-rule-checks input,.mf-check input{width:17px;height:17px;accent-color:var(--ed-accent)}@media(max-width:760px){.mf-promotion-card>header{display:grid}.mf-program-details{grid-template-columns:1fr}.mf-rule-checks{display:grid}.ed-form-grid{grid-template-columns:1fr}.ed-table{min-width:820px}}
</style>
