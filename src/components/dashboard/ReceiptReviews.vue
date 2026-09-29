<script setup>
import { computed, ref, onMounted, watch } from 'vue';
import { Store } from '../../store';
import { needsReceiptReview } from '../../domain/offlinePolicy';
import { money } from '../../domain/pos';
import Modal from '../ui/EditionModal.vue';

const busy = ref(false), error = ref(''), selected = ref(null), reason = ref('');
const rows = computed(() => Store.state.receiptReviews || []);
const unlistedSales = computed(() => Store.state.pendingSales.filter(sale =>
  sale.cashierId === Store.state.currentUser?.uid &&
  sale.company_id === Store.state.selectedCompany?.id &&
  !rows.value.some(row => row.id === sale.id)
));
const ownNeedsReview = computed(() => unlistedSales.value.filter(sale => needsReceiptReview(sale.syncError)));
const ownCanRequestDismissal = computed(() => unlistedSales.value.filter(sale => sale.syncError && !needsReceiptReview(sale.syncError)));
const ownNeedsSync = computed(() => unlistedSales.value.filter(sale => !sale.syncError));
const canResolve = computed(() => Store.can('receiptReviewsResolve'));
const status = computed(() => Store.state.online
  ? 'Saved payments stay on the original cashier’s device until the server confirms they were posted or dismissed. Reconcile that device after a manager decision.'
  : 'Reconnect to request or resolve a review. Paid receipts remain saved on the original device.');
const isPosted = row => ['posted', 'approved'].includes(row.status);
const isDismissed = row => row.status === 'dismissed';
const isPending = row => row.status === 'pending';
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
    stock_unavailable: 'Stock needs review',
    price_changed: 'Catalog price changed',
    tax_changed: 'Tax policy changed',
    merchant_changed: 'Receipt details changed',
    receipt_review_required: 'Recorded payment differs from current checkout policy',
    cashier_requested_dismissal: 'Original cashier requested dismissal after reconciliation',
  })[code] || 'Recorded payment needs review against the current checkout policy';
}

async function refresh() {
  error.value = '';
  try { await Store.refreshActor(); await Store.refreshReceiptReviews(); }
  catch (e) { error.value = e.message; }
}
async function request(sale) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await Store.requestReceiptReview(sale);
    if (result.status === 'posted') Store.notify('The server confirmed this receipt was recorded.' + queueConfirmation(sale));
    else if (result.status === 'dismissed') Store.notify('The server confirmed this receipt was dismissed.' + queueConfirmation(sale));
    else Store.notify('Payment review requested. Keep the original receipt queued until the server confirms its outcome.');
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
function choose(row) { selected.value = row; reason.value = ''; error.value = ''; }
async function resolve(decision) {
  if (busy.value || !selected.value) return;
  error.value = '';
  const explanation = reason.value.trim();
  if (explanation.length < 3) {
    error.value = 'Enter a ' + (decision === 'approve' ? 'approval' : 'dismissal') + ' reason of at least 3 characters.';
    return;
  }
  busy.value = true;
  try {
    if (decision === 'approve') {
      await Store.approveReceiptReview(selected.value.id, explanation);
      Store.notify('Original payment approved and posted. The cashier can now reconcile the device queue.');
    } else {
      await Store.dismissReceiptReview(selected.value.id, explanation);
      Store.notify('Payment reviewed and not recorded. The original cashier can now reconcile the device queue.');
    }
    selected.value = null;
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}

onMounted(refresh);
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
      <button class="ed-btn" :disabled="busy || !Store.state.online" @click="refresh">Refresh reviews</button>
    </header>
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
      <h2>Saved on this device</h2>
      <p>Try syncing these receipts first. A dismissal review becomes available only if the server cannot confirm the original payment.</p>
      <div v-for="sale in ownNeedsSync" :key="sale.id" class="ed-row"><div><strong>{{ sale.number }}</strong><small>{{ money(sale.total,currency(sale)) }} · Original cashier: {{ sale.cashierId }}</small></div><button class="ed-btn" :disabled="busy||Store.state.syncing||!Store.state.online" @click="Store.syncSales()">Retry sync</button></div>
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
      <label class="ed-field"><span>Reason for this decision</span><textarea v-model="reason" rows="3" maxlength="500" :disabled="busy" placeholder="Explain why this payment should be approved or dismissed."></textarea></label>
      <p v-if="error" class="ed-alert" role="alert">{{ error }}</p>
      <template #actions>
        <button class="ed-btn" :disabled="busy" @click="selected = null">Cancel</button>
        <button class="ed-btn" :disabled="busy || reason.trim().length < 3" @click="resolve('dismiss')">{{ busy ? 'Confirming…' : 'Dismiss · not recorded' }}</button>
        <button class="ed-btn primary" :disabled="busy || reason.trim().length < 3" @click="resolve('approve')">{{ busy ? 'Confirming…' : 'Approve original payment' }}</button>
      </template>
    </Modal>
  </div>
</template>
