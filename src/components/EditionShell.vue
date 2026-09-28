<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Store } from '../store';
import Icon from './ui/EditionIcon.vue';
import Modal from './ui/EditionModal.vue';
import { money } from '../domain/pos';
import { needsReceiptReview } from '../domain/offlinePolicy';
import { canVisit } from '../domain/viewAccess';
const route = useRoute(), router = useRouter();
const menu = ref(false), search = ref(false), query = ref(''), pending = ref(false);
const admin = computed(() => Store.can('usersManage'));
const company = computed(() => Store.state.selectedCompany || {});
const user = computed(() => Store.state.currentUser || {});
const nav = computed(() => [
  ['/overview','Overview','grid'], ['/pos','Checkout','bag'], ['/sales',Store.permissions().staff?'My documents':'Sales & documents','receipt'], ['/products','Inventory','box'],
  ['/receipt-reviews','Payment reviews','clock'], ['/contacts','Contacts','people'], ['/expenses','Expenses','wallet'], ['/analytics','Financial reports','chart'],
  ...(admin.value ? [['/users','Team & access','shield'], ['/companies','Company profile','building'], ['/settings','Settings','settings'], ['/templates','Templates','edit'], ['/activity','Activity','clock']] : [])
].filter(item => canVisit(Store.state.currentUser,item[0])));
const allPages = computed(() => nav.value);
const page = computed(() => allPages.value.find(n => route.path === n[0])?.[1] || 'My profile');
const matches = computed(() => allPages.value.filter(n => n[1].toLowerCase().includes(query.value.toLowerCase())));
const initials = value => (value || 'MF').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
function go(path) { search.value = false; menu.value = false; router.push(path); }
function shortcut(event) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); query.value = ''; search.value = !search.value; } if (event.key === 'Escape') menu.value = false; }
function exportPending() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(Store.state.pendingSales, null, 2)], {type:'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = 'myfin-unsynced-receipts.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
onMounted(() => window.addEventListener('keydown', shortcut));
onBeforeUnmount(() => window.removeEventListener('keydown', shortcut));
</script>
<template>
  <div class="ed-shell" :class="{'ed-compact':Store.state.preferences.density==='compact','ed-reduce-motion':Store.state.preferences.reduceMotion}">
    <a class="ed-skip" href="#workspace-main">Skip to workspace</a>
    <button v-if="menu" class="ed-scrim" aria-label="Close navigation" @click="menu=false"></button>
    <aside class="ed-sidebar" :class="{open:menu}" aria-label="Main navigation">
      <router-link to="/overview" class="ed-brand"><span class="ed-brandmark"><i></i><i></i><i></i><i></i></span>myfin<small>edition</small></router-link>
      <button class="ed-icon-button ed-drawer-close" aria-label="Close menu" @click="menu=false"><Icon name="close" /></button>
      <button class="ed-store" :disabled="user.role!=='super'" @click="Store.selectCompany(null)"><span class="ed-avatar solid">{{ initials(company.name) }}</span><span><strong>{{ company.name }}</strong><small>{{ user.role==='super'?'Switch workspace':'Your workspace' }}</small></span><Icon v-if="user.role==='super'" name="down" /></button>
      <div class="ed-nav-label">WORKSPACE</div>
      <nav class="ed-nav"><template v-for="(item,index) in nav" :key="item[0]"><div v-if="index===7" class="ed-nav-label">ADMINISTRATION</div><router-link :to="item[0]" @click="menu=false"><Icon :name="item[2]" />{{ item[1] }}</router-link></template></nav>
      <div class="ed-sidebar-bottom"><div class="ed-actions" style="justify-content:space-between;margin-bottom:17px"><span class="ed-status" :class="{offline:!Store.state.online||Store.state.fromCache}">{{ !Store.state.online?'Offline':Store.state.fromCache?'Cached data':'Connected' }}</span><button class="ed-icon-button" aria-label="Sign out" title="Sign out" @click="Store.logout()"><Icon name="logout" /></button></div><router-link to="/profile" class="ed-profile" @click="menu=false"><span class="ed-avatar">{{ initials(user.username) }}</span><span><strong>{{ user.username || user.email }}</strong><small>{{ user.role==='super'?'Workspace owner':user.role==='company_admin'?'Store manager':'Team member' }}</small></span><Icon name="settings" /></router-link></div>
    </aside>
    <div class="ed-workspace"><header class="ed-topbar"><div class="ed-breadcrumb"><button class="ed-icon-button ed-menu-toggle" aria-label="Open navigation" @click="menu=true"><Icon name="menu" /></button><span>Workspace</span><span>/</span><strong>{{ page }}</strong></div><div class="ed-top-actions"><button class="ed-search-trigger" aria-label="Search workspace" @click="query='';search=true"><Icon name="search" /><span>Find your next step</span><kbd>Ctrl K</kbd></button><button v-if="Store.state.pendingSales.length" class="ed-pill warning" @click="pending=true">{{ Store.state.pendingSales.length }} to sync</button><span v-else class="ed-status" :class="{offline:Store.state.fromCache || !Store.state.online}">{{ !Store.state.online?'Offline':Store.state.fromCache?'Cached data':'Live data' }}</span></div></header>
      <main id="workspace-main" class="ed-main" tabindex="-1">
        <div v-if="Store.state.dataError" class="ed-notice error" role="alert"><Icon name="alert" /><div><strong>Some data could not be loaded</strong>{{ Store.state.dataError }} <button class="ed-link" @click="Store.selectCompany(null)">Return to store selection</button></div></div>
        <div v-if="Store.state.dataLoading" class="ed-notice" role="status">Loading your store records…</div>
        <router-view v-slot="{ Component }"><component v-if="canVisit(user,route.path)" :is="Component" :key="company.id+user.role" :class="{'ed-legacy':!['/overview','/pos','/settings','/activity','/expenses','/products','/contacts','/users','/companies'].includes(route.path)}" /></router-view>
        <footer class="ed-footer"><span>MYFIN / EDITION<span v-if="Store.state.offlineStatus"> · {{ Store.state.offlineStatus }}</span></span><span>{{ company.name }} · {{ !Store.state.online||Store.state.fromCache?'Working from this device':'Connected to your workspace' }}</span></footer>
      </main>
    </div>
    <Modal v-if="search" title="Find your next step" @close="search=false"><label class="ed-field"><span>Search pages</span><input v-model="query" placeholder="Checkout, inventory, settings…" autofocus></label><div style="margin-top:16px"><button v-for="item in matches" :key="item[0]" class="ed-row" style="width:100%;text-align:left;background:none" @click="go(item[0])"><span class="ed-actions"><Icon :name="item[2]" />{{ item[1] }}</span><Icon name="arrow" /></button><p v-if="!matches.length" class="ed-muted">No matching pages.</p></div></Modal>
    <Modal v-if="pending" title="Receipts waiting to sync" wide @close="pending=false"><div class="ed-notice warning"><Icon name="cloud" /><div>These payments are saved on this device. Keep this browser's data until every receipt is synced. Do not take payment again.</div></div><div v-for="sale in Store.state.pendingSales" :key="sale.id" class="ed-row"><div><strong>{{ sale.number }}</strong><small>{{ sale.customerName }} · {{ money(sale.total, sale.storeSnapshot.currency) }}</small><small v-if="sale.syncError" class="ed-alert">{{ needsReceiptReview(sale.syncError)?'The original payment needs manager review. Keep this receipt queued; do not take payment again.':sale.syncError }}</small></div></div><p v-if="!Store.state.pendingSales.length">All receipts are synced.</p><template #actions><button class="ed-btn" @click="pending=false;go('/receipt-reviews')">Payment reviews</button><button class="ed-btn" @click="exportPending"><Icon name="download" />Export recovery copy</button><button class="ed-btn primary" :disabled="!Store.state.online || Store.state.syncing" @click="Store.syncSales()">{{ Store.state.syncing?'Syncing…':'Retry sync' }}</button></template></Modal>
  </div>
</template>
