<script setup>
import { computed } from 'vue';
import { Store } from '../../store';
import { businessDate } from '../../domain/pos';
import Icon from '../ui/EditionIcon.vue';
const lowStock = computed(() => Store.state.products.filter(p => p.trackStock && (p.variants?.length ? p.variants.some(v => v.stock < 5) : p.stock < 5)));
const drafts = computed(() => Store.state.transactions.filter(t => t.documentState === 'draft' || ['Draft','Pending approval'].includes(t.status)));
const recent = computed(() => [...Store.state.transactions].sort((a,b) => String(b.date).localeCompare(String(a.date))).slice(0,6));
const customer = t => t.customerName || Store.state.clients.find(c => c.id === t.client_id)?.name || 'Walk-in customer';
</script>
<template>
<div class="ed-page">
  <header class="ed-page-head"><div><div class="ed-eyebrow">DAILY OPERATIONS / {{ Store.state.selectedCompany?.name }}</div><h1>Your shop, ready for the day.</h1><p>Checkout, available stock and documents that need attention.</p></div><router-link to="/pos" class="ed-btn primary"><Icon name="bag"/>Open checkout</router-link></header>
  <div class="ed-metrics ed-metrics-three">
    <div class="ed-metric"><label>Available catalog</label><strong>{{ Store.state.products.length }}</strong><small>Products and their selling prices</small></div>
    <div class="ed-metric"><label>Low stock</label><strong>{{ lowStock.length }}</strong><small>Products to review before checkout</small></div>
    <div class="ed-metric"><label>Saved payments to sync</label><strong>{{ Store.state.pendingSales.length }}</strong><small>Keep this device's data until confirmed</small></div>
  </div>
  <div class="ed-two-col">
    <section><div class="ed-section-head"><h2>Continue your work</h2></div><div class="ed-row"><div><strong>{{ drafts.length }} documents in progress</strong><small>{{ Store.permissions().staff ? 'Your own or assigned drafts.' : 'Drafts awaiting review or issue.' }}</small></div><router-link to="/sales" class="ed-link">Open documents<Icon name="arrow"/></router-link></div><div class="ed-row"><div><strong>Customer directory</strong><small>Find a customer or save details for their receipt.</small></div><router-link to="/contacts" class="ed-link">Open customers<Icon name="arrow"/></router-link></div><div class="ed-row"><div><strong>Stock availability</strong><small>{{ Store.can('inventoryWrite') ? 'Manage selling prices, variants and stock.' : 'View selling prices and available stock.' }}</small></div><router-link to="/products" class="ed-link">Open inventory<Icon name="arrow"/></router-link></div></section>
    <aside class="ed-side-section"><div class="ed-section-head"><h2>Stock to review</h2></div><div v-for="p in lowStock.slice(0,6)" :key="p.id" class="ed-row"><strong>{{ p.name }}</strong><small>{{ p.variants?.length ? 'A variant is running low' : p.stock+' '+p.unit+' available' }}</small></div><p v-if="!lowStock.length" class="ed-muted">No low-stock products in this catalog.</p><div v-if="!Store.state.online" class="ed-notice warning">Offline access reflects the last verified account. Reconnect to receive permission and catalog changes.</div></aside>
  </div>
  <section class="ed-section"><div class="ed-section-head"><h2>{{ Store.permissions().staff ? 'Your recent receipts and drafts' : 'Recent operational documents' }}</h2><router-link to="/sales" class="ed-link">View documents<Icon name="arrow"/></router-link></div><div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Document</th><th>Customer</th><th>Status</th><th>Date</th></tr></thead><tbody><tr v-for="t in recent" :key="t.id"><td>{{ t.number || t.type }}</td><td>{{ customer(t) }}</td><td>{{ t.status || 'Draft' }}</td><td>{{ businessDate(t.date) }}</td></tr><tr v-if="!recent.length"><td colspan="4" class="ed-muted">Your permitted documents will appear here.</td></tr></tbody></table></div></section>
  <div v-if="Store.can('financialReports')" class="ed-row ed-section"><div><strong>Owner financial reports</strong><small>Company revenue, expenses and financial summaries.</small></div><router-link to="/analytics" class="ed-link">Open reports<Icon name="arrow"/></router-link></div>
</div>
</template>
