<script setup>
import { computed, ref, onMounted, onBeforeUnmount, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Store } from '../store';
import Icon from './ui/EditionIcon.vue';
import Modal from './ui/EditionModal.vue';
import { money } from '../domain/pos';
import { needsReceiptReview } from '../domain/offlinePolicy';
import { canVisit } from '../domain/viewAccess';
import { applyThemeVariables, DEFAULT_THEME_COLOR } from '../domain/theme';
const route = useRoute(), router = useRouter();
const menu = ref(false), search = ref(false), query = ref(''), pending = ref(false), switcher = ref(false);
const company = computed(() => Store.state.selectedCompany || {});
const user = computed(() => Store.state.currentUser || {});
const navSections = computed(() => [
  { label:'Workspace', items:[['/pos','Checkout / POS','bag'],['/orders','Sales Orders','clock']] },
  { label:'Inventory', items:[['/products','Inventory','box'],['/stock','Stock Record','truck']] },
  { label:'Finance', items:[['/finance-sales','Sales & Receivables','receipt'],['/documents','Quotes & Invoices','edit'],['/cashbook','Cash Book','wallet'],['/expenses','Expenses','wallet'],['/receipt-reviews','Payment reviews','clock']] },
  { label:'Analytics', items:[['/analytics','Financial Analysis','chart'],['/consolidation','Consolidation','grid']] },
  { label:'Administration', items:[['/contacts','Customers / Suppliers','people'],['/companies','Company Profile','building'],['/activity','Activity','clock']] },
  { label:'Settings', items:[['/settings','Device / Printing','settings'],['/templates','Templates','edit']] },
  { label:'User Administration', items:[['/users','Team and Access','shield']] },
].map(section => ({...section,items:section.items.filter(item => canVisit(Store.state.currentUser,item[0]))})).filter(section => section.items.length));
const allPages = computed(() => navSections.value.flatMap(section => section.items));
const page = computed(() => route.path === '/overview' ? 'Overview' : route.path === '/profile' ? 'My profile' : allPages.value.find(n => route.path === n[0])?.[1] || 'Workspace');
const matches = computed(() => allPages.value.filter(n => n[1].toLowerCase().includes(query.value.toLowerCase())));
const initials = value => (value || 'MF').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
function go(path) { search.value = false; menu.value = false; router.push(path); }
function shortcut(event) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); query.value = ''; search.value = !search.value; } if (event.key === 'Escape') menu.value = false; }
function exportPending() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(Store.state.pendingSales, null, 2)], {type:'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = 'myfin-unsynced-receipts.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
onMounted(() => window.addEventListener('keydown', shortcut));
watchEffect(() => {
  if (typeof document !== 'undefined') applyThemeVariables(document.documentElement, Store.state.preferences.primaryColor || company.value.preferences?.primaryColor);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', shortcut);
  if (typeof document !== 'undefined') applyThemeVariables(document.documentElement, DEFAULT_THEME_COLOR);
});
</script>
<template>
  <div class="ed-shell" :class="{'ed-compact':Store.state.preferences.density==='compact','ed-reduce-motion':Store.state.preferences.reduceMotion}">
    <a class="ed-skip" href="#workspace-main">Skip to workspace</a>
    <button v-if="menu" class="ed-scrim" aria-label="Close navigation" @click="menu=false"></button>
    <aside class="ed-sidebar" :class="{open:menu}" aria-label="Main navigation">
      <router-link to="/overview" class="ed-brand"><span class="ed-brandmark"><i></i><i></i><i></i><i></i></span>myfin<small>edition</small></router-link>
      <button class="ed-icon-button ed-drawer-close" aria-label="Close menu" @click="menu=false"><Icon name="close" /></button>
      <button class="ed-store" :disabled="!['super_admin','workspace_owner'].includes(user.role)" @click="switcher=true"><span class="ed-avatar solid">{{ initials(company.name) }}</span><span><strong>{{ company.name }}</strong><small>{{ ['super_admin','workspace_owner'].includes(user.role)?'Switch company':'Your company' }}</small></span><Icon v-if="['super_admin','workspace_owner'].includes(user.role)" name="down" /></button>
      <nav class="ed-nav" aria-label="Workspace navigation"><div v-for="section in navSections" :key="section.label" class="ed-nav-section" role="group" :aria-label="section.label"><div class="ed-nav-label">{{ section.label }}</div><router-link v-for="item in section.items" :key="item[0]" :to="item[0]" @click="menu=false"><Icon :name="item[2]" />{{ item[1] }}</router-link></div></nav>
      <div class="ed-sidebar-bottom"><div class="ed-actions" style="justify-content:space-between;margin-bottom:17px"><span class="ed-status" :class="{offline:!Store.state.online||Store.state.fromCache}">{{ !Store.state.online?'Offline':Store.state.fromCache?'Cached data':'Connected' }}</span><button class="ed-icon-button" aria-label="Sign out" title="Sign out" @click="Store.logout()"><Icon name="logout" /></button></div><router-link to="/profile" class="ed-profile" @click="menu=false"><span class="ed-avatar">{{ initials(user.username) }}</span><span><strong>{{ user.username || user.email }}</strong><small>{{ user.role==='super_admin'?'SuperAdmin':user.role==='workspace_owner'?'Workspace owner':user.role==='manager'?'Manager':'Operator' }} · {{ user.authLevel==='pos_code'?'POS code':'Password' }}</small></span><Icon name="settings" /></router-link></div>
    </aside>
    <div class="ed-workspace"><header class="ed-topbar"><div class="ed-breadcrumb"><button class="ed-icon-button ed-menu-toggle" aria-label="Open navigation" @click="menu=true"><Icon name="menu" /></button><span>Workspace</span><span>/</span><strong>{{ page }}</strong></div><div class="ed-top-actions"><button class="ed-search-trigger" aria-label="Search workspace" @click="query='';search=true"><Icon name="search" /><span>Find your next step</span><kbd>Ctrl K</kbd></button><button v-if="Store.state.pendingSales.length" class="ed-pill warning" @click="pending=true">{{ Store.state.pendingSales.length }} to sync</button><span v-else class="ed-status" :class="{offline:Store.state.fromCache || !Store.state.online}">{{ !Store.state.online?'Offline':Store.state.fromCache?'Cached data':'Live data' }}</span></div></header>
      <main id="workspace-main" class="ed-main" tabindex="-1">
        <div v-if="Store.state.dataError" class="ed-notice error" role="alert"><Icon name="alert" /><div><strong>Some data could not be loaded</strong>{{ Store.state.dataError }} <button class="ed-link" @click="Store.selectCompany(null)">Return to store selection</button></div></div>
        <div v-if="Store.state.dataLoading" class="ed-notice" role="status">Loading your store records…</div>
        <router-view v-slot="{ Component }"><component v-if="canVisit(user,route.path)" :is="Component" :key="company.id+user.role" :class="{'ed-legacy':!['/overview','/pos','/orders','/finance-sales','/consolidation','/settings','/activity','/expenses','/products','/stock','/contacts','/users','/companies'].includes(route.path)}" /></router-view>
        <footer class="ed-footer"><span>MYFIN / EDITION<span v-if="Store.state.offlineStatus"> · {{ Store.state.offlineStatus }}</span></span><span>{{ company.name }} · {{ !Store.state.online||Store.state.fromCache?'Working from this device':'Connected to your workspace' }}</span></footer>
      </main>
    </div>
    <Modal v-if="search" title="Find your next step" @close="search=false"><label class="ed-field"><span>Search pages</span><input v-model="query" placeholder="Checkout, inventory, settings…" autofocus></label><div style="margin-top:16px"><button v-for="item in matches" :key="item[0]" class="ed-row" style="width:100%;text-align:left;background:none" @click="go(item[0])"><span class="ed-actions"><Icon :name="item[2]" />{{ item[1] }}</span><Icon name="arrow" /></button><p v-if="!matches.length" class="ed-muted">No matching pages.</p></div></Modal>
    <Modal v-if="pending" title="Receipts waiting to sync" wide @close="pending=false"><div class="ed-notice warning"><Icon name="cloud" /><div>These payments are saved on this device. Keep this browser's data until every receipt is synced. Do not take payment again.</div></div><div v-for="sale in Store.state.pendingSales" :key="sale.id" class="ed-row"><div><strong>{{ sale.number }}</strong><small>{{ sale.customerName }} · {{ money(sale.total, sale.storeSnapshot.currency) }}</small><small v-if="sale.syncError" class="ed-alert">{{ needsReceiptReview(sale.syncError)?'The original payment needs manager review. Keep this receipt queued; do not take payment again.':sale.syncError }}</small></div></div><p v-if="!Store.state.pendingSales.length">All receipts are synced.</p><template #actions><button class="ed-btn" @click="pending=false;go('/receipt-reviews')">Payment reviews</button><button class="ed-btn" @click="exportPending"><Icon name="download" />Export recovery copy</button><button class="ed-btn primary" :disabled="!Store.state.online || Store.state.syncing" @click="Store.syncSales()">{{ Store.state.syncing?'Syncing…':'Retry sync' }}</button></template></Modal>
    <Modal v-if="switcher" title="Switch company" @close="switcher=false"><button v-for="item in Store.state.companies" :key="item.id" class="ed-row" style="width:100%;text-align:left;background:none" @click="switcher=false;Store.switchCompany(item)"><span><strong>{{ item.name }}</strong><small>{{ item.hostname||item.slug }}</small></span><Icon name="arrow"/></button><template #actions><button v-if="user.role==='super_admin'" class="ed-btn" @click="switcher=false;Store.selectCompany(null)">Global administration</button><button class="ed-btn" @click="switcher=false">Cancel</button></template></Modal>
  </div>
</template>
