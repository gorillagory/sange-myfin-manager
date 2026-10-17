<script setup>
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { Store } from '../../store';
import { receiptRecoveryBucket } from '../../domain/offlinePolicy';
import { cents, money } from '../../domain/pos';
import { BULK_RECEIPT_REVIEW_LIMIT, canBulkApproveReceipt, receiptBulkApprovalBlock } from '../../domain/receiptReviews';
import Modal from '../ui/EditionModal.vue';

const busy = ref(false), error = ref(''), selected = ref(null), reason = ref(''), inventoryRecipeResolution = ref('');
const bulkApprovalOpen = ref(false), bulkRows = ref([]), bulkExcludedRows = ref([]), bulkReason = ref(''), bulkConfirmed = ref(false), bulkError = ref(''), bulkUncertain = ref(false), bulkOutcome = ref(null);
const recipeResolutions = ['current_recipe', 'captured_recipe'];
const rows = computed(() => Store.state.receiptReviews || []);
const unlistedSales = computed(() => Store.state.pendingSales.filter(sale =>
  sale.cashierId === Store.state.currentUser?.uid &&
  sale.company_id === Store.state.selectedCompany?.id &&
  !rows.value.some(row => row.id === sale.id)
));
const ownNeedsReview = computed(() => unlistedSales.value.filter(sale => receiptRecoveryBucket(sale.syncError) === 'review'));
const ownCanRequestDismissal = computed(() => unlistedSales.value.filter(sale => receiptRecoveryBucket(sale.syncError) === 'dismissal'));
const ownNeedsSync = computed(() => unlistedSales.value.filter(sale => receiptRecoveryBucket(sale.syncError) === 'retry'));
const canResolve = computed(() => Store.can('receiptReviewsResolve'));
const companySelected = computed(() => Boolean(Store.state.selectedCompany?.id));
const pendingRows = computed(() => rows.value.filter(row => row.status === 'pending'));
const bulkEligibleRows = computed(() => pendingRows.value.filter(canBulkApproveReceipt));
const bulkIneligibleRows = computed(() => pendingRows.value.filter(row => !canBulkApproveReceipt(row)));
const bulkTotal = computed(() => bulkRows.value.reduce((total, row) => total + cents(row.sale?.total || 0), 0) / 100);
const bulkExclusionSummary = computed(() => {
  const counts = new Map();
  for (const row of bulkExcludedRows.value) {
    const label = receiptBulkApprovalBlock(row);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts].map(([label, count]) => `${count} × ${label.toLowerCase()}`).join(' · ');
});
const status = computed(() => Store.state.online
  ? 'A confirmed review handoff moves the full paid record to the server and clears the original device queue. Managers and workspace owners can then approve or dismiss it.'
  : 'Reconnect to request or resolve a review. Paid receipts remain saved on the original device.');
const isPosted = row => ['posted', 'approved'].includes(row.status);
const isDismissed = row => row.status === 'dismissed';
const isPending = row => row.status === 'pending';
const isRecipeTimingReview = row => row?.reasonCode === 'receipt_review_required_recipe_timing' || row?.recipeTimingRequired === true;
const approvalBlocked = computed(() => busy.value || reason.value.trim().length < 3 ||
  (isRecipeTimingReview(selected.value) && !recipeResolutions.includes(inventoryRecipeResolution.value)));
const queuedSale = row => Store.state.pendingSales.find(sale => sale.id === row.id && sale.cashierId === Store.state.currentUser?.uid);
const queueConfirmation = sale => Store.state.pendingSales.some(entry => entry.id === sale.id)
  ? ' Retry sync on this device to clear its saved receipt.'
  : ' Its device queue entry is cleared.';
const currency = sale => sale.storeSnapshot?.currency || Store.state.selectedCompany?.preferences?.currency || 'RM';

function reasonText(code) {
  return ({
    receipt_review_required_pricing_policy: 'Catalog price, tax or discount policy changed',
    receipt_review_required_merchant_changed: 'Original merchant details differ from current settings',
    receipt_review_required_product_changed: 'The original product option changed; reconcile the catalog before approval',
    receipt_review_required_delayed_sync: 'This payment reached the server later; approval preserves its original sale date',
    receipt_review_required_offline_sync: 'This payment was captured offline and is ready for manager approval',
    receipt_review_required_offline_time: 'The recorded capture time is unusual; verify the original payment date before approval',
    receipt_review_required_recipe_timing: 'The inventory recipe changed after this offline sale was captured',
    receipt_review_required_recipe_stock: 'Recipe ingredients are below the amount required by this paid sale',
    receipt_review_required_record_conflict: 'The server found a conflicting financial or inventory record',
    manager_override_reason_required: 'The recorded discount needs an individual manager reason',
    stock_unavailable: 'Stock needs review',
    price_changed: 'Catalog price changed',
    tax_changed: 'Tax policy changed',
    merchant_changed: 'Receipt details changed',
    receipt_review_required: 'Recorded payment differs from current checkout policy',
    cashier_requested_dismissal: 'Original cashier requested dismissal after reconciliation',
    stock_reserved_or_unavailable: 'Stock is reserved for another order or no longer available',
  })[code] || 'Recorded payment needs review against the current checkout policy';
}

function recipeResolutionText(resolution) {
  return ({
    current_recipe: 'Current recipe',
    captured_recipe: 'Recipe active when the sale was captured',
  })[resolution] || '';
}

function bulkSkipText(item) {
  if (['approved', 'posted'].includes(item?.status)) return 'Already approved by another manager';
  if (item?.status === 'dismissed') return 'Already dismissed';
  const code = item?.error || item?.reasonCode;
  return ({
    not_found: 'Review no longer exists',
    original_cashier_unavailable: 'Original cashier account is unavailable',
    receipt_review_required_recipe_timing: 'Inventory recipe choice is now required',
    receipt_review_required_recipe_stock: 'Recipe ingredients are still unavailable',
    receipt_review_required_product_changed: 'A product or option still needs reconciliation',
    receipt_review_required_record_conflict: 'A financial or inventory conflict remains',
    receipt_dismissed: 'The payment was dismissed',
  })[code] || reasonText(code);
}

async function refresh({ verifyActor = true, quiet = false } = {}) {
  if (!companySelected.value) return false;
  if (!quiet) error.value = '';
  try {
    if (verifyActor) await Store.refreshActor();
    // Re-read the durable device outbox whenever this module refreshes. A
    // receipt may have been queued in another tab or restored after initial
    // company hydration, and server reviews alone cannot reveal that row.
    await Store.refreshPending();
    await Store.refreshReceiptReviews();
    return true;
  } catch (e) {
    if (!quiet) error.value = e.message;
    return false;
  }
}
async function request(sale) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await Store.requestReceiptReview(sale);
    if (result.status === 'posted') Store.notify('The server confirmed this receipt was recorded.' + queueConfirmation(sale));
    else if (result.status === 'dismissed') Store.notify('The server confirmed this receipt was dismissed.' + queueConfirmation(sale));
    else Store.notify('Payment secured on the server and awaiting manager review. The original device queue is clear.');
  } catch {
    error.value = 'Review could not be confirmed. The original payment is still queued; retry safely when connected.';
  } finally { busy.value = false; }
}
async function requestDismissal(sale) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await Store.requestReceiptDismissal(sale);
    if (result.status === 'posted') Store.notify('The server confirmed this receipt was already recorded.' + queueConfirmation(sale));
    else if (result.status === 'dismissed') Store.notify('The server confirmed dismissal.' + queueConfirmation(sale));
    else Store.notify('Dismissal review requested. Keep the original receipt queued until the server confirms a decision.');
  } catch (e) {
    error.value = e.message || 'Dismissal could not be confirmed. The original payment remains queued.';
  } finally { busy.value = false; }
}
function choose(row) { selected.value = row; reason.value = ''; inventoryRecipeResolution.value = ''; error.value = ''; }
async function openBulkApproval() {
  if (busy.value || !canResolve.value || !Store.state.online) return;
  busy.value = true;
  bulkOutcome.value = null;
  const refreshed = await refresh();
  busy.value = false;
  if (!refreshed) return;
  if (!canResolve.value) {
    error.value = 'Your account no longer has permission to approve payment reviews.';
    return;
  }
  if (!bulkEligibleRows.value.length) {
    error.value = 'No pending payments are currently eligible for bulk approval.';
    return;
  }
  if (bulkEligibleRows.value.length > BULK_RECEIPT_REVIEW_LIMIT) {
    error.value = `The queue is too large to approve at once. Refresh after resolving some payments individually.`;
    return;
  }
  bulkRows.value = bulkEligibleRows.value.map(row => ({ ...row, sale: { ...row.sale } }));
  bulkExcludedRows.value = bulkIneligibleRows.value.map(row => ({ ...row }));
  bulkReason.value = '';
  bulkConfirmed.value = false;
  bulkError.value = '';
  bulkUncertain.value = false;
  bulkApprovalOpen.value = true;
}
function closeBulkApproval() {
  if (!busy.value) bulkApprovalOpen.value = false;
}
async function approveAllEligible() {
  if (busy.value) return;
  const explanation = bulkReason.value.trim();
  if (explanation.length < 3) {
    bulkError.value = 'Enter one approval reason of at least 3 characters for this batch.';
    return;
  }
  if (!bulkConfirmed.value) {
    bulkError.value = 'Confirm that you reviewed the eligible payment total before approving.';
    return;
  }
  busy.value = true;
  bulkError.value = '';
  try {
    const result = await Store.approveAllEligibleReceiptReviews(bulkRows.value.map(row => row.id), explanation);
    const approved = result.approved.length, skipped = result.skipped.length;
    const pending = result.skipped.filter(row => row?.status === 'pending').length;
    const noLongerPending = skipped - pending;
    const skippedReasons = [...new Set(result.skipped.filter(row => row?.status === 'pending').map(bulkSkipText))].slice(0, 3);
    bulkOutcome.value = { approved, skipped, pending, noLongerPending, skippedReasons };
    bulkApprovalOpen.value = false;
    const outcome = [`${approved} approved`];
    if (pending) outcome.push(`${pending} still pending`);
    if (noLongerPending) outcome.push(`${noLongerPending} already resolved or unavailable`);
    Store.notify(outcome.join('; ') + '.', pending ? 'warning' : 'success');
  } catch (e) {
    bulkUncertain.value = Boolean(e.network);
    bulkError.value = e.network
      ? 'The server response was interrupted. Refresh reviews before retrying so you can see which payments were posted.'
      : e.message || 'Bulk approval could not be confirmed. Refresh the queue before trying again.';
  } finally { busy.value = false; }
}
async function reconcileBulkStatus() {
  if (busy.value) return;
  bulkApprovalOpen.value = false;
  bulkUncertain.value = false;
  await refresh();
}
async function resolve(decision) {
  if (busy.value || !selected.value) return;
  error.value = '';
  const explanation = reason.value.trim();
  if (explanation.length < 3) {
    error.value = 'Enter a ' + (decision === 'approve' ? 'approval' : 'dismissal') + ' reason of at least 3 characters.';
    return;
  }
  if (decision === 'approve' && isRecipeTimingReview(selected.value) &&
      !recipeResolutions.includes(inventoryRecipeResolution.value)) {
    error.value = 'Choose which inventory recipe should be used for this sale.';
    return;
  }
  busy.value = true;
  try {
    if (decision === 'approve') {
      await Store.approveReceiptReview(selected.value.id, explanation, inventoryRecipeResolution.value);
      Store.notify('Original payment approved and posted.');
    } else {
      await Store.dismissReceiptReview(selected.value.id, explanation);
      Store.notify('Payment reviewed and not recorded.');
    }
    selected.value = null;
  } catch (e) {
    if (decision === 'approve' && e.message === 'receipt_review_required_recipe_timing') {
      // A recipe can change while another review cause (for example an
      // ingredient shortage) is pending. Preserve the server's original cause
      // and reveal the explicit manager reconciliation required on retry.
      selected.value = { ...selected.value, recipeTimingRequired: true };
      inventoryRecipeResolution.value = '';
      error.value = 'The inventory recipe changed while this payment was waiting. Choose which recipe to use, then approve again.';
    } else error.value = e.message;
  }
  finally { busy.value = false; }
}

let pollTimer;
const refreshVisible = () => {
  if (document.visibilityState === 'visible' && Store.state.online && companySelected.value)
    refresh({ verifyActor: false, quiet: true });
};
const visibilityChanged = () => refreshVisible();
onMounted(() => {
  refresh();
  window.addEventListener('focus', refreshVisible);
  document.addEventListener('visibilitychange', visibilityChanged);
  pollTimer = window.setInterval(refreshVisible, 10000);
});
onBeforeUnmount(() => {
  window.removeEventListener('focus', refreshVisible);
  document.removeEventListener('visibilitychange', visibilityChanged);
  window.clearInterval(pollTimer);
});
watch(() => Store.state.selectedCompany?.id, () => { selected.value = null; bulkApprovalOpen.value = false; bulkOutcome.value = null; refresh(); });
</script>

<template>
  <div v-if="Store.can('receiptReviewsRead')" class="ed-page">
    <header class="ed-page-head">
      <div>
        <div class="ed-eyebrow">WORKSPACE / PAYMENT REVIEWS</div>
        <h1>Resolve recorded payments.</h1>
        <p>{{ canResolve ? 'Check the original payment before approving or dismissing it.' : 'Track saved paid receipts that need a manager decision.' }}</p>
      </div>
      <div class="ed-actions">
        <button v-if="canResolve" class="ed-btn primary" :aria-label="`Approve all ${bulkEligibleRows.length} eligible payments`" :disabled="busy || !Store.state.online || !companySelected || !bulkEligibleRows.length" @click="openBulkApproval">
          Approve all eligible<span v-if="bulkEligibleRows.length" class="ed-pill">{{ bulkEligibleRows.length }}</span>
        </button>
        <button class="ed-btn" :disabled="busy || !Store.state.online || !companySelected" @click="refresh()">Refresh reviews</button>
      </div>
    </header>
    <div v-if="!companySelected" class="ed-empty">
      <h3>Choose a company to review payments.</h3>
      <p>Open the company switcher and select the workspace whose recorded payments you want to review.</p>
    </div>
    <template v-else>
      <div class="ed-notice warning">{{ status }}</div>
      <p v-if="error" class="ed-alert" role="alert">{{ error }}</p>
      <div v-if="bulkOutcome" class="ed-notice" :class="{ warning: bulkOutcome.pending }" role="status">
        <div class="mf-review-bulk-outcome">
          <strong v-if="bulkOutcome.approved">{{ bulkOutcome.approved }} {{ bulkOutcome.approved === 1 ? 'payment was' : 'payments were' }} approved and posted.</strong>
          <strong v-else>No payments were approved.</strong>
          <span v-if="bulkOutcome.pending">{{ bulkOutcome.pending }} {{ bulkOutcome.pending === 1 ? 'payment remains' : 'payments remain' }} pending{{ bulkOutcome.skippedReasons.length ? ': ' + bulkOutcome.skippedReasons.join('; ') : '' }}. Review those payments individually.</span>
          <span v-if="bulkOutcome.noLongerPending">{{ bulkOutcome.noLongerPending }} {{ bulkOutcome.noLongerPending === 1 ? 'payment was' : 'payments were' }} already resolved or no longer available.</span>
          <span v-if="!bulkOutcome.skipped">The server rechecked every payment before recording it.</span>
        </div>
      </div>

    <section v-if="ownNeedsReview.length">
      <h2>Ready to request review</h2>
      <div v-for="sale in ownNeedsReview" :key="sale.id" class="ed-row">
        <div>
          <strong>{{ sale.number }}</strong>
          <small>{{ money(sale.total, currency(sale)) }} · Original cashier: {{ sale.cashierId }}</small>
          <small>{{ reasonText(sale.syncError) }}</small>
        </div>
        <button class="ed-btn" :disabled="busy || Store.state.syncing || !Store.state.online" @click="request(sale)">Request review</button>
      </div>
    </section>

    <section v-if="ownCanRequestDismissal.length">
      <h2>Saved payments awaiting confirmation</h2>
      <p>The server will first check whether each payment was already recorded. If it was not, a manager can review a dismissal request.</p>
      <div v-for="sale in ownCanRequestDismissal" :key="sale.id" class="ed-row">
        <div>
          <strong>{{ sale.number }}</strong>
          <small>{{ money(sale.total, currency(sale)) }} · Original cashier: {{ sale.cashierId }}</small>
          <small v-if="sale.syncError">Last sync: {{ sale.syncError }}</small>
        </div>
        <button class="ed-btn" :disabled="busy || Store.state.syncing || !Store.state.online" @click="requestDismissal(sale)">Request dismissal review</button>
      </div>
    </section>

    <section v-if="ownNeedsSync.length">
      <h2>Retry sync</h2>
      <p>The server has not confirmed an outcome for these receipts. Retry syncing while the saved payment remains on this device.</p>
      <div v-for="sale in ownNeedsSync" :key="sale.id" class="ed-row"><div><strong>{{ sale.number }}</strong><small>{{ money(sale.total,currency(sale)) }} · Original cashier: {{ sale.cashierId }}</small><small v-if="sale.syncError">Last sync: {{ sale.syncError }}</small></div><button class="ed-btn" :disabled="busy||Store.state.syncing||!Store.state.online" @click="Store.syncSales()">Retry sync</button></div>
    </section>

    <div class="ed-table-wrap">
      <table class="ed-table">
        <thead><tr><th>Original receipt</th><th>Cashier</th><th>Recorded amount</th><th>Review</th><th>Action</th></tr></thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td><strong>{{ row.sale.number || row.id }}</strong><small>{{ row.sale.customerName || 'Walk-in customer' }}</small><small>{{ row.sale.date }}</small></td>
            <td>{{ row.sale.cashierId }}</td>
            <td>{{ money(row.sale.total, currency(row.sale)) }}</td>
            <td>
              <span class="ed-pill">{{ isPosted(row) ? 'Approved and posted' : isDismissed(row) ? 'Reviewed · not recorded' : 'Awaiting review' }}</span>
              <small>{{ reasonText(row.reasonCode) }}</small>
              <small v-if="isPending(row) && canResolve && !canBulkApproveReceipt(row)">Excluded from bulk approval · {{ receiptBulkApprovalBlock(row) }}</small>
              <small v-if="row.inventoryRecipeResolution">Inventory recipe: {{ recipeResolutionText(row.inventoryRecipeResolution) }}</small>
              <small v-if="isDismissed(row) && row.dismissalReason">Dismissal reason: {{ row.dismissalReason }}</small>
            </td>
            <td>
              <button v-if="isPending(row) && canResolve" class="ed-btn small" :disabled="busy || !Store.state.online" @click="choose(row)">Review payment</button>
              <button v-else-if="isDismissed(row) && queuedSale(row)" class="ed-btn small" :disabled="busy || Store.state.syncing || !Store.state.online" @click="requestDismissal(queuedSale(row))">Confirm dismissal on this device</button>
              <button v-else-if="isPosted(row) && queuedSale(row)" class="ed-btn small" :disabled="busy || Store.state.syncing || !Store.state.online" @click="Store.syncSales()">Retry sync</button>
              <span v-else class="ed-muted">{{ isPending(row) ? 'Awaiting manager decision' : 'Review complete' }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="!rows.length && !unlistedSales.length" class="ed-empty">
      <h3>No payments awaiting review.</h3>
      <p>Saved payments that cannot sync or need a decision will appear here.</p>
    </div>

    <Modal v-if="selected" title="Review original payment" :busy="busy" @close="selected = null">
      <div class="ed-notice warning">Approval records the saved amount once and deducts available catalog stock once; it does not charge the customer. If stock is now short, the sale records that shortage without consuming stock reserved for another order. Recipe shortages are posted as a financial-only inventory exception for reconciliation. Dismissal marks the payment reviewed but not recorded. The original cashier’s device keeps its queued receipt until the server decision is confirmed there.</div>
      <dl>
        <dt>Receipt</dt><dd>{{ selected.sale.number || selected.id }}</dd>
        <dt>Original cashier</dt><dd>{{ selected.sale.cashierId }}</dd>
        <dt>Recorded amount</dt><dd>{{ money(selected.sale.total, currency(selected.sale)) }}</dd>
        <dt>Payment method</dt><dd>{{ selected.sale.paymentMethod }}</dd>
      </dl>
      <div v-for="(item, i) in selected.sale.items" :key="i" class="ed-row"><span>{{ item.desc }} × {{ item.qty }}</span><strong>{{ money(item.price, currency(selected.sale)) }} each</strong></div>
      <label v-if="isRecipeTimingReview(selected)" class="ed-field">
        <span>Inventory recipe for stock deduction</span>
        <select v-model="inventoryRecipeResolution" :disabled="busy" required>
          <option disabled value="">Choose which recipe to use</option>
          <option value="current_recipe">Current recipe</option>
          <option value="captured_recipe">Recipe active when the sale was captured</option>
        </select>
        <small>The current recipe uses today’s recipe configuration. The captured recipe uses the configuration active at the recorded sale time.</small>
      </label>
      <label class="ed-field"><span>Reason for this decision</span><textarea v-model="reason" rows="3" maxlength="500" :disabled="busy" placeholder="Explain why this payment should be approved or dismissed."></textarea></label>
      <p v-if="error" class="ed-alert" role="alert">{{ error }}</p>
      <template #actions>
        <button class="ed-btn" :disabled="busy" @click="selected = null">Cancel</button>
        <button class="ed-btn" :disabled="busy || reason.trim().length < 3" @click="resolve('dismiss')">{{ busy ? 'Confirming…' : 'Dismiss · not recorded' }}</button>
        <button class="ed-btn primary" :disabled="approvalBlocked" @click="resolve('approve')">{{ busy ? 'Confirming…' : 'Approve original payment' }}</button>
      </template>
    </Modal>

    <Modal v-if="bulkApprovalOpen" title="Approve all eligible payments" :busy="busy" wide @close="closeBulkApproval">
      <div class="ed-notice warning">
        <div><strong>This records each saved payment and deducts its stock once.</strong>No customer is charged. Only routine offline or delayed sync receipts are eligible. The server rechecks every receipt and leaves any payment that now needs an individual decision pending.</div>
      </div>
      <div class="mf-review-bulk-summary" aria-live="polite">
        <div><span>Eligible payments</span><strong>{{ bulkRows.length }}</strong></div>
        <div><span>Recorded total</span><strong>{{ money(bulkTotal, currency(bulkRows[0]?.sale || {})) }}</strong></div>
        <div><span>Excluded</span><strong>{{ bulkExcludedRows.length }}</strong></div>
      </div>
      <p v-if="bulkExcludedRows.length" class="ed-muted mf-review-bulk-exclusions">Excluded from this batch: {{ bulkExclusionSummary }}. Resolve these one at a time.</p>
      <label class="ed-field">
        <span>Reason for approving this batch</span>
        <textarea v-model="bulkReason" rows="3" maxlength="1000" :disabled="busy" placeholder="Explain why these original payments can be posted together."></textarea>
        <small>This reason is recorded against every payment approved in this batch.</small>
      </label>
      <label class="ed-check mf-review-bulk-confirm">
        <input v-model="bulkConfirmed" type="checkbox" :disabled="busy">
        <span>I reviewed the {{ bulkRows.length }} eligible payments and their total of {{ money(bulkTotal, currency(bulkRows[0]?.sale || {})) }}.</span>
      </label>
      <p v-if="bulkError" class="ed-alert" role="alert">{{ bulkError }}</p>
      <template #actions>
        <button class="ed-btn" :disabled="busy" @click="closeBulkApproval">Cancel</button>
        <button v-if="bulkUncertain" class="ed-btn primary" :disabled="busy || !Store.state.online" @click="reconcileBulkStatus">Refresh approval status</button>
        <button v-else class="ed-btn primary" :disabled="busy || bulkReason.trim().length < 3 || !bulkConfirmed" @click="approveAllEligible">
          {{ busy ? 'Approving payments…' : `Approve ${bulkRows.length} eligible ${bulkRows.length === 1 ? 'payment' : 'payments'}` }}
        </button>
      </template>
    </Modal>
    </template>
  </div>
</template>

<style scoped>
.mf-review-bulk-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-block:1px solid var(--ed-line);margin:22px 0}
.mf-review-bulk-summary>div{display:flex;flex-direction:column;gap:5px;padding:18px}
.mf-review-bulk-summary>div+div{border-left:1px solid var(--ed-line)}
.mf-review-bulk-summary span{color:var(--ed-muted);font-size:11px}
.mf-review-bulk-summary strong{font-size:24px;font-weight:500}
.mf-review-bulk-exclusions{font-size:11px;margin:-7px 0 22px}
.mf-review-bulk-confirm{align-items:flex-start;margin-top:18px}
.mf-review-bulk-confirm span{padding-top:3px;font-size:12px;line-height:1.5}
.mf-review-bulk-outcome span{display:block}
@media(max-width:600px){.mf-review-bulk-summary{grid-template-columns:1fr}.mf-review-bulk-summary>div{padding:13px 0}.mf-review-bulk-summary>div+div{border-left:0;border-top:1px solid var(--ed-line)}}
</style>
