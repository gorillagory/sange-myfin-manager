<script setup>
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { Store } from '../../store';
import { receiptRecoveryBucket } from '../../domain/offlinePolicy';
import { money } from '../../domain/pos';
import Modal from '../ui/EditionModal.vue';

const busy = ref(false), error = ref(''), selected = ref(null), reason = ref(''), inventoryRecipeResolution = ref('');
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
    receipt_review_required_offline_time: 'The offline capture time is unusual; verify the original payment date before approval',
    receipt_review_required_recipe_timing: 'The inventory recipe changed after this offline sale was captured',
    receipt_review_required_recipe_stock: 'Recipe ingredients are below the amount required by this paid sale',
    receipt_review_required_record_conflict: 'The server found a conflicting financial or inventory record',
    stock_unavailable: 'Stock needs review',
    price_changed: 'Catalog price changed',
    tax_changed: 'Tax policy changed',
    merchant_changed: 'Receipt details changed',
    receipt_review_required: 'Recorded payment differs from current checkout policy',
    cashier_requested_dismissal: 'Original cashier requested dismissal after reconciliation',
  })[code] || 'Recorded payment needs review against the current checkout policy';
}

function recipeResolutionText(resolution) {
  return ({
    current_recipe: 'Current recipe',
    captured_recipe: 'Recipe active when the sale was captured',
  })[resolution] || '';
}

async function refresh({ verifyActor = true, quiet = false } = {}) {
  if (!companySelected.value) return;
  if (!quiet) error.value = '';
  try {
    if (verifyActor) await Store.refreshActor();
    // Re-read the durable device outbox whenever this module refreshes. A
    // receipt may have been queued in another tab or restored after initial
    // company hydration, and server reviews alone cannot reveal that row.
    await Store.refreshPending();
    await Store.refreshReceiptReviews();
  } catch (e) {
    if (!quiet) error.value = e.message;
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
watch(() => Store.state.selectedCompany?.id, () => { selected.value = null; refresh(); });
</script>

<template>
  <div v-if="Store.can('checkout')" class="ed-page">
    <header class="ed-page-head">
      <div>
        <div class="ed-eyebrow">WORKSPACE / PAYMENT REVIEWS</div>
        <h1>Resolve recorded payments.</h1>
        <p>{{ canResolve ? 'Check the original payment before approving or dismissing it.' : 'Track saved paid receipts that need a manager decision.' }}</p>
      </div>
      <button class="ed-btn" :disabled="busy || !Store.state.online || !companySelected" @click="refresh()">Refresh reviews</button>
    </header>
    <div v-if="!companySelected" class="ed-empty">
      <h3>Choose a company to review payments.</h3>
      <p>Open the company switcher and select the workspace whose recorded payments you want to review.</p>
    </div>
    <template v-else>
      <div class="ed-notice warning">{{ status }}</div>
      <p v-if="error" class="ed-alert" role="alert">{{ error }}</p>

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
      <div class="ed-notice warning">Approval records the saved amount once and deducts stock once; it does not charge the customer. Dismissal marks the payment reviewed but not recorded. The original cashier’s device keeps its queued receipt until the server decision is confirmed there.</div>
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
    </template>
  </div>
</template>
