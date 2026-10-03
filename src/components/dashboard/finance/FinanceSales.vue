<script setup>
import { computed, ref } from 'vue';
import { Store } from '../../../store';
import { businessDate, money } from '../../../domain/pos';
import { documentCollectedAmount, documentOutstandingAmount } from '../../../domain/documents';
import Icon from '../../ui/EditionIcon.vue';

const query = ref('');
const refreshing = ref(false);
const currency = computed(() => Store.state.selectedCompany?.preferences?.currency || 'RM');
const sales = computed(() => [...Store.state.transactions]
  .filter(row => row.source === 'pos' || (row.type === 'Invoice' && ['issued', 'legacy'].includes(row.documentState) && !['Voided', 'Corrected'].includes(row.status)))
  .sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))));
const shown = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  if (!needle) return sales.value;
  return sales.value.filter(row => [row.number, row.customerName, row.cashierName, row.paymentMethod, row.status]
    .some(value => String(value || '').toLocaleLowerCase().includes(needle)));
});
const customer = row => row.customerName || Store.state.clients.find(client => client.id === row.client_id)?.name || 'Walk-in customer';
const collected = documentCollectedAmount;
const outstanding = documentOutstandingAmount;
const origin = row => row.source === 'pos' ? 'Checkout' : row.quoteId ? 'Invoice from quote' : row.documentState === 'legacy' ? 'Historical invoice' : 'Invoice';
const totals = computed(() => sales.value.reduce((value, row) => ({ sales: value.sales + Number(row.total || 0), collected: value.collected + collected(row), outstanding: value.outstanding + outstanding(row) }), { sales: 0, collected: 0, outstanding: 0 }));
async function refresh() {
  if (refreshing.value || !Store.state.online) return;
  refreshing.value = true;
  try { await Store.refreshData({ silent: true }); }
  catch { Store.notify('Sales could not be refreshed. Try again.', 'error'); }
  finally { refreshing.value = false; }
}
</script>

<template>
  <div class="ed-page mf-finance-sales">
    <header class="ed-page-head">
      <div><div class="ed-eyebrow">FINANCE / SALES & RECEIVABLES</div><h1>Every sale, paid or due.</h1><p>Checkout receipts and issued invoices share one sales record. Payment changes cash, while an issued invoice remains a sale.</p></div>
      <div class="ed-actions"><router-link :to="{path:'/documents',query:{new:'quote'}}" class="ed-btn">New quote</router-link><router-link :to="{path:'/documents',query:{new:'invoice'}}" class="ed-btn primary"><Icon name="plus" />New invoice</router-link></div>
    </header>
    <div class="ed-metrics"><div class="ed-metric"><label>Issued sales</label><strong>{{ money(totals.sales,currency) }}</strong></div><div class="ed-metric"><label>Collected</label><strong>{{ money(totals.collected,currency) }}</strong></div><div class="ed-metric"><label>Outstanding</label><strong>{{ money(totals.outstanding,currency) }}</strong></div></div>
    <div class="ed-filters">
      <div class="ed-search"><Icon name="search" /><input v-model="query" class="ed-input" type="search" aria-label="Search sales" placeholder="Search number, customer or payment"></div>
      <button class="ed-btn" :disabled="refreshing || !Store.state.online" @click="refresh">{{ refreshing ? 'Refreshing…' : 'Refresh' }}</button>
    </div>
    <p class="ed-muted" role="status">{{ shown.length }} {{ shown.length === 1 ? 'sale' : 'sales' }} shown</p>
    <div v-if="shown.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Number</th><th>Date</th><th>Customer</th><th>Source</th><th>Status</th><th class="num">Sale</th><th class="num">Collected</th><th class="num">Due</th></tr></thead><tbody><tr v-for="row in shown" :key="row.id"><td><strong>{{ row.number || 'Unnumbered' }}</strong></td><td>{{ row.businessDate || businessDate(row.date) }}</td><td>{{ customer(row) }}</td><td>{{ origin(row) }}</td><td><span class="ed-pill">{{ row.status || 'Recorded' }}</span></td><td class="num">{{ money(row.total, currency) }}</td><td class="num">{{ money(collected(row), currency) }}</td><td class="num">{{ money(outstanding(row), currency) }}</td></tr></tbody></table></div>
    <div v-else class="ed-empty"><Icon name="receipt" /><h3>No sales match this view.</h3><p>{{ query ? 'Try another search.' : 'Checkout receipts and issued invoices will appear here.' }}</p></div>
    <div class="ed-row"><div><strong>Quotes, invoices and collections</strong><small>Create a quote, convert it to an invoice, issue it, then record partial or full payment without using Checkout.</small></div><router-link class="ed-link" to="/documents">Open documents<Icon name="arrow" /></router-link></div>
    <div class="ed-row"><div><strong>Need the payment-date breakdown?</strong><small>Financial analysis uses the actual payment dates for invoice collections.</small></div><router-link class="ed-link" to="/analytics">Financial analysis<Icon name="arrow" /></router-link></div>
    <div class="ed-row"><div><strong>Payment needs review?</strong><small>Check receipts waiting for sync or manager resolution.</small></div><router-link class="ed-link" to="/receipt-reviews">Payment reviews<Icon name="arrow" /></router-link></div>
  </div>
</template>
