<script setup>
import { computed, reactive, ref } from 'vue';
import { Store } from '../../../store';
import { cents, checkoutTotalsFor, money, normalizeProduct } from '../../../domain/pos';
import { businessDateTimeInput, manualSaleEarliestInput, manualSaleOccurredAt } from '../../../domain/manualSales';
import { api, companyPath } from '../../../services/api';
import Modal from '../../ui/EditionModal.vue';

const emit = defineEmits(['close', 'saved']);
const busy = ref(false), error = ref('');
const freshKey = () => globalThis.crypto?.randomUUID?.()
  || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
const currentTaxRate = computed(() => Number(Store.state.selectedCompany?.preferences?.taxRate
  ?? Store.state.selectedCompany?.preferences?.tax ?? 0));
const form = reactive({
  idempotencyKey: freshKey(), occurredAt: businessDateTimeInput(),
  paymentMethod: 'Cash', paymentReference: '', customerId: '', discount: 0,
  taxRate: currentTaxRate.value, pricingOverrideReason: '',
  recordingReason: '', inventoryPolicy: 'deduct_current_stock_and_recipe',
  items: [{ productId: '', variantId: '', quantity: 1, unitPrice: null }],
});
const products = computed(() => [...Store.state.products].map(normalizeProduct)
  .sort((left, right) => left.name.localeCompare(right.name)));
const customers = computed(() => Store.state.clients.filter(row => row.type !== 'Supplier')
  .sort((left, right) => left.name.localeCompare(right.name)));
const currency = computed(() => Store.state.selectedCompany?.preferences?.currency || 'RM');
const maxOccurred = computed(() => businessDateTimeInput(new Date(Date.now() + 5 * 60 * 1000)));
const minOccurred = computed(() => manualSaleEarliestInput());
const selectedProduct = line => products.value.find(product => product.id === line.productId);
const selectedVariant = line => selectedProduct(line)?.variants?.find(variant => variant.id === line.variantId);
const catalogPrice = line => Number(selectedVariant(line)?.price ?? selectedProduct(line)?.price ?? 0);
const previewItems = computed(() => {
  try {
    return form.items.map(line => {
      const product = selectedProduct(line), variant = selectedVariant(line);
      if (!product || (product.variants.length && !variant) || !(Number(line.quantity) > 0) ||
          !Number.isFinite(Number(line.unitPrice)) || Number(line.unitPrice) < 0) throw Error('incomplete');
      return { price: Number(line.unitPrice), qty: Number(line.quantity) };
    });
  } catch { return []; }
});
const totals = computed(() => {
  if (!previewItems.value.length || previewItems.value.length !== form.items.length) return null;
  try { return checkoutTotalsFor(previewItems.value, Number(form.taxRate), Number(form.discount || 0)); }
  catch { return null; }
});
const pricingChanged = computed(() => Math.abs(Number(form.taxRate) - currentTaxRate.value) > 1e-9
  || form.items.some(line => line.productId && line.unitPrice !== null
    && cents(Number(line.unitPrice)) !== cents(catalogPrice(line))));
const canSubmit = computed(() => Store.can('manualSalesCreate') && Store.state.online && !Store.state.fromCache
  && totals.value?.total > 0 && form.recordingReason.trim().length >= 3 && form.occurredAt
  && (!pricingChanged.value || form.pricingOverrideReason.trim().length >= 8));

function productChanged(line) {
  line.variantId = '';
  line.unitPrice = selectedProduct(line)?.variants?.length ? null : catalogPrice(line);
}
function variantChanged(line) { line.unitPrice = catalogPrice(line); }
function addLine() { form.items.push({ productId: '', variantId: '', quantity: 1, unitPrice: null }); }
function removeLine(index) { if (form.items.length > 1) form.items.splice(index, 1); }
const messageFor = value => ({
  stock_unavailable: 'Current catalog stock is too low. Record a verified stock correction before entering this sale.',
  recipe_stock_unavailable: 'Current recipe stock is too low. Reconcile ingredient stock before entering this sale.',
  manual_sale_future_date: 'The occurrence time cannot be in the future.',
  manual_sale_backdate_limit: 'Recorded sales are limited to today and the previous seven Malaysia business dates.',
  manual_sale_pricing_reason_required: 'Explain why the historical price or tax differs from today’s catalog.',
  manual_sale_idempotency_key_reused: 'This submission key was already used with different details. Close and reopen this form.',
}[value] || value || 'The sale could not be recorded.');
async function submit() {
  if (busy.value || !canSubmit.value) return;
  busy.value = true; error.value = '';
  try {
    const occurredAt = manualSaleOccurredAt(form.occurredAt);
    const result = await api(companyPath(Store, '/manual-sales'), { method: 'POST', body: {
      idempotencyKey: form.idempotencyKey, occurredAt,
      paymentStatus: 'Paid', paymentMethod: form.paymentMethod,
      paymentReference: form.paymentReference.trim(),
      customerId: form.customerId, discount: Number(form.discount || 0),
      taxRate: Number(form.taxRate),
      pricingOverrideReason: form.pricingOverrideReason.trim(),
      recordingReason: form.recordingReason.trim(), inventoryPolicy: form.inventoryPolicy,
      items: form.items.map(line => ({ productId: line.productId, variantId: line.variantId,
        quantity: Number(line.quantity), unitPrice: Number(line.unitPrice) })),
    }});
    await Store.refreshData({ silent: true });
    Store.notify(`${result.number} was recorded in completed orders and financial reports.`);
    emit('saved', result);
  } catch (cause) { error.value = messageFor(cause.message); }
  finally { busy.value = false; }
}
</script>

<template>
  <Modal title="Record a completed sale" wide :busy="busy" @close="emit('close')">
    <form id="manual-sale-form" class="ed-form-grid manual-sale-form" @submit.prevent="submit">
      <div class="ed-notice wide manual-sale-notice">
        Use this only for a paid sale that happened today or within the previous seven Malaysia business dates but was not entered at checkout.
        Current catalog prices and tax are review defaults; replace them with the values actually charged when the sale occurred.
        Current product stock and the current active recipe are deducted when you save; insufficient stock stops the entry.
        The sale must already be paid. Use Quotes &amp; Invoices for unpaid or on-account sales so payments can be tracked.
        Saving posts an immutable financial and inventory record, so review every value before recording it.
      </div>
      <label class="ed-field"><span>Sale occurred at *</span><input v-model="form.occurredAt" type="datetime-local" :min="minOccurred" :max="maxOccurred" required><small>Malaysia time. This date drives sales and tax reporting.</small></label>
      <label class="ed-field"><span>Customer</span><select v-model="form.customerId"><option value="">Walk-in customer</option><option v-for="customer in customers" :key="customer.id" :value="customer.id">{{ customer.name }}</option></select></label>
      <label class="ed-field"><span>Payment status</span><input value="Paid" disabled><small>Later payments belong in an issued invoice.</small></label>
      <label class="ed-field"><span>Payment method *</span><select v-model="form.paymentMethod" required><option>Cash</option><option>QR Pay</option><option>Card</option><option>Bank Transfer</option><option>E-wallet</option><option>Other</option></select></label>
      <label v-if="form.paymentMethod === 'Other'" class="ed-field"><span>Payment reference *</span><input v-model="form.paymentReference" minlength="2" maxlength="120" required placeholder="Method or reference"></label>

      <div class="wide manual-sale-lines">
        <div class="manual-sale-section"><strong>Products sold</strong><button class="ed-btn" type="button" @click="addLine">Add line</button></div>
        <div v-for="(line,index) in form.items" :key="index" class="manual-sale-line">
          <label class="ed-field"><span>Product *</span><select v-model="line.productId" required @change="productChanged(line)"><option value="" disabled>Select product</option><option v-for="product in products" :key="product.id" :value="product.id">{{ product.name }} · {{ money(product.price,currency) }}</option></select></label>
          <label v-if="selectedProduct(line)?.variants?.length" class="ed-field"><span>Option *</span><select v-model="line.variantId" required @change="variantChanged(line)"><option value="" disabled>Select option</option><option v-for="variant in selectedProduct(line).variants" :key="variant.id" :value="variant.id">{{ variant.name }} · {{ money(variant.price,currency) }}</option></select></label>
          <label class="ed-field manual-sale-price"><span>Actual unit price *</span><input v-model.number="line.unitPrice" type="number" min="0" max="10000000" step="0.01" required><small v-if="line.productId && (!selectedProduct(line)?.variants?.length || line.variantId)">Current catalog: {{ money(catalogPrice(line),currency) }}</small></label>
          <label class="ed-field manual-sale-qty"><span>Quantity *</span><input v-model.number="line.quantity" type="number" min="0.001" max="1000000" step="0.001" required></label>
          <button class="ed-icon-button manual-sale-remove" type="button" aria-label="Remove product line" :disabled="form.items.length === 1" @click="removeLine(index)">×</button>
        </div>
      </div>

      <label class="ed-field"><span>Actual tax rate (%) *</span><input v-model.number="form.taxRate" type="number" min="0" max="100" step="0.01" required><small>Current company tax: {{ currentTaxRate }}%</small></label>
      <label class="ed-field"><span>Discount (%)</span><input v-model.number="form.discount" type="number" min="0" max="100" step="0.01"><small>The late-entry reason below becomes permanent audit evidence.</small></label>
      <label class="ed-field wide"><span>Price or tax difference reason{{ pricingChanged ? ' *' : '' }}</span><textarea v-model="form.pricingOverrideReason" minlength="8" maxlength="1000" :required="pricingChanged" placeholder="Happy-hour price shown on the original till receipt"></textarea><small>Required when an actual price or tax rate differs from the current values. It is stored separately from the late-entry explanation.</small></label>
      <label class="ed-field wide"><span>Why is this being recorded later? *</span><textarea v-model="form.recordingReason" minlength="3" maxlength="1000" required placeholder="Busy counter; sale completed before it could be entered"></textarea></label>
      <div v-if="totals" class="wide manual-sale-totals" aria-live="polite">
        <span>Subtotal <strong>{{ money(totals.subtotal,currency) }}</strong></span>
        <span v-if="totals.discountAmount">Discount <strong>− {{ money(totals.discountAmount,currency) }}</strong></span>
        <span>Tax ({{ totals.taxRate }}%) <strong>{{ money(totals.tax,currency) }}</strong></span>
        <span>Before rounding <strong>{{ money(totals.totalBeforeRounding,currency) }}</strong></span>
        <span>Rounding <strong>{{ totals.rounding >= 0 ? '+' : '−' }} {{ money(Math.abs(totals.rounding),currency) }}</strong></span>
        <span class="manual-sale-total">Total <strong>{{ money(totals.total,currency) }}</strong></span>
      </div>
      <p v-if="error" class="ed-alert wide" role="alert">{{ error }}</p>
    </form>
    <template #actions><button class="ed-btn" :disabled="busy" @click="emit('close')">Cancel</button><button class="ed-btn primary" form="manual-sale-form" type="submit" :disabled="busy || !canSubmit">{{ busy ? 'Recording…' : 'Record completed sale' }}</button></template>
  </Modal>
</template>

<style scoped>
.manual-sale-form{align-items:start}.manual-sale-notice{line-height:1.55}.manual-sale-lines{display:grid;gap:12px}.manual-sale-section{display:flex;align-items:center;justify-content:space-between;gap:12px}.manual-sale-line{display:grid;grid-template-columns:minmax(170px,1fr) minmax(140px,.75fr) minmax(130px,.65fr) 100px 38px;gap:10px;align-items:end;padding:12px;border:1px solid var(--ed-border,#d8ddd8);border-radius:10px}.manual-sale-price,.manual-sale-qty{min-width:0}.manual-sale-remove{margin-bottom:2px}.manual-sale-totals{display:grid;gap:7px;margin-top:4px;padding:14px 16px;background:var(--ed-soft,#f5f6f3);border-radius:10px}.manual-sale-totals span{display:flex;justify-content:space-between;gap:16px}.manual-sale-total{padding-top:8px;border-top:1px solid var(--ed-border,#d8ddd8);font-size:1.05rem}@media(max-width:900px){.manual-sale-line{grid-template-columns:repeat(2,minmax(0,1fr))}.manual-sale-remove{justify-self:end}}@media(max-width:600px){.manual-sale-line{grid-template-columns:1fr}}
</style>
