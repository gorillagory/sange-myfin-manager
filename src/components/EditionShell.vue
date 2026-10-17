<script setup>
import { computed, ref, onMounted, onBeforeUnmount, onBeforeUpdate, watch, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Store } from '../store';
import Icon from './ui/EditionIcon.vue';
import Modal from './ui/EditionModal.vue';
import { money } from '../domain/pos';
import { needsReceiptReview } from '../domain/offlinePolicy';
import { canVisit } from '../domain/viewAccess';
import { applyThemeVariables, DEFAULT_THEME_COLOR } from '../domain/theme';
import { WORKSPACE_MODULES, workspacePageFor } from '../domain/workspaceModules';
const route = useRoute(), router = useRouter();
const menu = ref(false), search = ref(false), query = ref(''), pending = ref(false), switcher = ref(false);
const company = computed(() => Store.state.selectedCompany || {});
const user = computed(() => Store.state.currentUser || {});
const canSwitchCompany = computed(() => ['super_admin','workspace_owner'].includes(user.value.role) || Store.state.companies.length > 1);
const serverReviewCount = computed(() => (Store.state.receiptReviews || []).filter(row => row.status === 'pending').length);
const navSections = computed(() => WORKSPACE_MODULES
  .map(section => ({ ...section, pages: section.pages.filter(page => canVisit(Store.state.currentUser, page.path)) }))
  .filter(section => section.pages.length));
const allPages = computed(() => navSections.value.flatMap(section => section.pages));
const pageMeta = computed(() => workspacePageFor(route.path));
const matches = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return allPages.value.filter(page => `${page.title} ${page.module} ${page.description}`.toLowerCase().includes(needle));
});

const MODULE_STATE_KEY = 'myfin.workspace.expanded-modules';
const SIDEBAR_STATE_KEY = 'myfin.workspace.sidebar-collapsed';
function savedModuleState() {
  if (typeof window === 'undefined') return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(MODULE_STATE_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function savedSidebarState() {
  if (typeof window === 'undefined') return false;
  try {
    const value = window.localStorage.getItem(SIDEBAR_STATE_KEY);
    if (value === 'true' || value === 'false') return value === 'true';
  } catch { /* Storage may be unavailable. */ }
  return window.matchMedia?.('(max-width: 1280px)').matches ?? false;
}
const expandedModules = ref(savedModuleState());
const sidebarCollapsed = ref(savedSidebarState());
const desktopSidebar = ref(typeof window === 'undefined' ? true : window.matchMedia('(min-width: 961px)').matches);
const sidebarRail = computed(() => sidebarCollapsed.value && desktopSidebar.value);
const moduleButtons = ref([]);
const isActiveModule = section => section.pages.some(page => page.path === route.path);
const isModuleOpen = section => expandedModules.value[section.id] === true;
function toggleModule(section) {
  if (sidebarRail.value) {
    sidebarCollapsed.value = false;
    expandedModules.value = { ...expandedModules.value, [section.id]: true };
    return;
  }
  expandedModules.value = { ...expandedModules.value, [section.id]: !isModuleOpen(section) };
}
function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  if (!sidebarCollapsed.value) {
    const active = WORKSPACE_MODULES.find(section => section.pages.some(page => page.path === route.path));
    if (active) expandedModules.value = { ...expandedModules.value, [active.id]: true };
  }
}
function setModuleButton(element, index) {
  if (element) moduleButtons.value[index] = element;
}
function focusModule(index) {
  const buttons = moduleButtons.value.filter(Boolean);
  if (!buttons.length) return;
  buttons[(index + buttons.length) % buttons.length]?.focus();
}
function moduleKeydown(event, index, section) {
  if (event.key === 'ArrowDown') { event.preventDefault(); focusModule(index + 1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); focusModule(index - 1); }
  else if (event.key === 'Home') { event.preventDefault(); focusModule(0); }
  else if (event.key === 'End') { event.preventDefault(); focusModule(moduleButtons.value.length - 1); }
  else if (event.key === 'ArrowRight' && !isModuleOpen(section)) { event.preventDefault(); toggleModule(section); }
  else if (event.key === 'ArrowLeft' && isModuleOpen(section)) { event.preventDefault(); toggleModule(section); }
}
const initials = value => (value || 'MF').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
function go(path) { search.value = false; menu.value = false; router.push(path); }
function shortcut(event) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); query.value = ''; search.value = !search.value; } if (event.key === 'Escape') menu.value = false; }
function exportPending() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(Store.state.pendingSales, null, 2)], {type:'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = 'myfin-unsynced-receipts.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
let reviewPollTimer;
let sidebarMedia;
function syncSidebarMedia(event) { desktopSidebar.value = event.matches; }
function refreshServerReviews() {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible' && Store.state.online &&
      company.value.id && Store.can('receiptReviewsResolve'))
    Store.refreshReceiptReviews().catch(() => {});
}
watch(() => route.path, path => {
  const active = WORKSPACE_MODULES.find(section => section.pages.some(page => page.path === path));
  if (active) expandedModules.value = { ...expandedModules.value, [active.id]: true };
}, { immediate: true });
watch(expandedModules, value => {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(MODULE_STATE_KEY, JSON.stringify(value)); } catch { /* Storage may be unavailable. */ }
}, { deep: true });
watch(sidebarCollapsed, value => {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(SIDEBAR_STATE_KEY, String(value)); } catch { /* Storage may be unavailable. */ }
});
onBeforeUpdate(() => { moduleButtons.value = []; });
onMounted(() => {
  sidebarMedia = window.matchMedia('(min-width: 961px)');
  desktopSidebar.value = sidebarMedia.matches;
  sidebarMedia.addEventListener('change', syncSidebarMedia);
  window.addEventListener('keydown', shortcut);
  window.addEventListener('focus', refreshServerReviews);
  document.addEventListener('visibilitychange', refreshServerReviews);
  reviewPollTimer = window.setInterval(refreshServerReviews, 30000);
});
watchEffect(() => {
  if (typeof document !== 'undefined') applyThemeVariables(document.documentElement, Store.state.preferences.primaryColor || company.value.preferences?.primaryColor);
});
onBeforeUnmount(() => {
  sidebarMedia?.removeEventListener('change', syncSidebarMedia);
  window.removeEventListener('keydown', shortcut);
  window.removeEventListener('focus', refreshServerReviews);
  document.removeEventListener('visibilitychange', refreshServerReviews);
  window.clearInterval(reviewPollTimer);
  if (typeof document !== 'undefined') applyThemeVariables(document.documentElement, DEFAULT_THEME_COLOR);
});
</script>
<template>
  <div class="ed-shell" :class="{'ed-compact':Store.state.preferences.density==='compact','ed-reduce-motion':Store.state.preferences.reduceMotion,'ed-sidebar-collapsed':sidebarRail}">
    <a class="ed-skip" href="#workspace-main">Skip to workspace</a>
    <button v-if="menu" class="ed-scrim" aria-label="Close navigation" @click="menu=false"></button>
    <aside id="workspace-navigation" class="ed-sidebar" :class="{open:menu}" aria-label="Main navigation">
      <div class="ed-sidebar-head">
        <router-link to="/overview" class="ed-brand" aria-label="MyFin overview" title="MyFin overview" @click="menu=false"><span class="ed-brandmark"><i></i><i></i><i></i><i></i></span><span class="ed-brand-name">myfin<small>edition</small></span></router-link>
        <button class="ed-icon-button ed-sidebar-collapse" type="button" :aria-label="sidebarCollapsed?'Expand navigation':'Collapse navigation'" :aria-expanded="!sidebarCollapsed" aria-controls="workspace-navigation" :title="sidebarCollapsed?'Expand navigation':'Collapse navigation'" @click="toggleSidebar"><Icon name="arrow-left" /></button>
      </div>
      <button class="ed-icon-button ed-drawer-close" aria-label="Close menu" @click="menu=false"><Icon name="close" /></button>
      <button class="ed-store" :disabled="!canSwitchCompany" :aria-label="`${company.name || 'Company'}. ${canSwitchCompany?'Switch company':'Current company'}`" :title="sidebarRail?(company.name || 'Current company'):undefined" @click="switcher=true"><span class="ed-avatar solid">{{ initials(company.name) }}</span><span class="ed-store-copy"><strong>{{ company.name }}</strong><small>{{ canSwitchCompany?'Switch company':'Your company' }}</small></span><Icon v-if="canSwitchCompany" name="down" /></button>
      <nav class="ed-nav" aria-label="Modules">
        <div class="ed-nav-heading">Modules</div>
        <section v-for="(section,index) in navSections" :key="section.id" class="ed-nav-section" :class="{active:isActiveModule(section)}">
          <button
            :id="`module-${section.id}-button`"
            :ref="element => setModuleButton(element,index)"
            type="button"
            class="ed-nav-module"
            :class="{active:isActiveModule(section)}"
            :aria-expanded="!sidebarRail && isModuleOpen(section)"
            :aria-controls="`module-${section.id}-pages`"
            :aria-current="isActiveModule(section)?'true':undefined"
            :aria-label="sidebarRail?`${section.label}${isActiveModule(section)?', current module':''}`:undefined"
            :title="sidebarRail?section.label:undefined"
            @click="toggleModule(section)"
            @keydown="moduleKeydown($event,index,section)"
          >
            <Icon :name="section.pages[0]?.icon || 'grid'" class="ed-nav-module-symbol" aria-hidden="true" />
            <span class="ed-nav-module-label">{{ section.label }}</span>
            <span v-if="isActiveModule(section)" class="ed-nav-current">Current</span>
            <Icon name="down" class="ed-nav-module-icon" aria-hidden="true" />
          </button>
          <div
            v-show="isModuleOpen(section)"
            :id="`module-${section.id}-pages`"
            class="ed-nav-pages"
            role="group"
            :aria-labelledby="`module-${section.id}-button`"
          >
            <router-link
              v-for="item in section.pages"
              :key="item.path"
              :to="item.path"
              :aria-current="route.path===item.path?'page':undefined"
              @click="menu=false"
            ><Icon :name="item.icon" />{{ item.title }}<span v-if="item.path==='/receipt-reviews' && serverReviewCount" class="ed-pill warning ed-nav-badge" :aria-label="`${serverReviewCount} pending payment reviews`">{{ serverReviewCount }}</span></router-link>
          </div>
        </section>
      </nav>
      <div class="ed-sidebar-bottom">
        <div class="ed-sidebar-session"><span class="ed-status" :class="{offline:!Store.state.online||Store.state.fromCache}" role="status" :title="!Store.state.online?'Offline':Store.state.fromCache?'Cached data':'Connected'"><span class="ed-status-label">{{ !Store.state.online?'Offline':Store.state.fromCache?'Cached data':'Connected' }}</span></span><button class="ed-icon-button" aria-label="Sign out" title="Sign out" @click="Store.logout()"><Icon name="logout" /></button></div>
        <router-link to="/profile" class="ed-profile" aria-label="Open my profile" :title="sidebarRail?(user.username || user.email || 'My profile'):undefined" @click="menu=false"><span class="ed-avatar">{{ initials(user.username) }}</span><span class="ed-profile-copy"><strong>{{ user.username || user.email }}</strong><small>{{ user.role==='super_admin'?'SuperAdmin':user.role==='workspace_owner'?'Workspace owner':user.role==='manager'?'Manager':'Operator' }} · {{ user.authLevel==='pos_code'?'POS code':'Password' }}</small></span><Icon name="settings" /></router-link>
      </div>
    </aside>
    <div class="ed-workspace"><header class="ed-topbar"><div class="ed-breadcrumb"><button class="ed-icon-button ed-menu-toggle" aria-label="Open navigation" @click="menu=true"><Icon name="menu" /></button><span>{{ pageMeta.module }}</span><span aria-hidden="true">/</span><strong>{{ pageMeta.title }}</strong></div><div class="ed-top-actions"><button class="ed-search-trigger" aria-label="Search workspace" @click="query='';search=true"><Icon name="search" /><span>Find a module</span><kbd>Ctrl K</kbd></button><button v-if="Store.state.pendingSales.length" class="ed-pill warning" @click="pending=true">{{ Store.state.pendingSales.length }} to sync</button><span v-else class="ed-status" :class="{offline:Store.state.fromCache || !Store.state.online}">{{ !Store.state.online?'Offline':Store.state.fromCache?'Cached data':'Live data' }}</span></div></header>
      <main id="workspace-main" class="ed-main" tabindex="-1">
        <div v-if="Store.state.dataError" class="ed-notice error" role="alert"><Icon name="alert" /><div><strong>Some data could not be loaded</strong>{{ Store.state.dataError }} <button class="ed-link" @click="Store.selectCompany(null)">Return to store selection</button></div></div>
        <div v-if="Store.state.dataLoading" class="ed-notice" role="status">Loading your store records…</div>
        <header class="ed-module-page-head" aria-labelledby="workspace-page-title">
          <div class="ed-eyebrow">{{ pageMeta.module }}</div>
          <h1 id="workspace-page-title">{{ pageMeta.title }}</h1>
          <p>{{ pageMeta.description }}</p>
        </header>
        <div class="ed-route-view"><router-view v-slot="{ Component }"><component v-if="canVisit(user,route.path)" :is="Component" :key="`${company.id}:${user.role}:${(user.module_grants||[]).join(',')}`" :class="{'ed-legacy':!['/overview','/pos','/orders','/storefront','/kitchen','/finance-sales','/payment-operations','/consolidation','/settings','/integrations','/activity','/marketing','/expenses','/products','/stock','/procurement','/contacts','/users','/companies'].includes(route.path)}" /></router-view></div>
        <footer class="ed-footer"><span>MYFIN / EDITION<span v-if="Store.state.offlineStatus"> · {{ Store.state.offlineStatus }}</span></span><span>{{ company.name }} · {{ !Store.state.online||Store.state.fromCache?'Working from this device':'Connected to your workspace' }}</span></footer>
      </main>
    </div>
    <Modal v-if="search" title="Find a module" @close="search=false"><label class="ed-field"><span>Search modules</span><input v-model="query" placeholder="POS, inventory, settings…" autofocus></label><div style="margin-top:16px"><button v-for="item in matches" :key="item.path" class="ed-row" style="width:100%;text-align:left;background:none" @click="go(item.path)"><span class="ed-actions"><Icon :name="item.icon" />{{ item.title }}</span><Icon name="arrow" /></button><p v-if="!matches.length" class="ed-muted">No matching modules.</p></div></Modal>
    <Modal v-if="pending" title="Receipts waiting to sync" wide @close="pending=false"><div class="ed-notice warning"><Icon name="cloud" /><div>These payments are saved on this device. Keep this browser's data until every receipt is synced. Do not take payment again.</div></div><div v-for="sale in Store.state.pendingSales" :key="sale.id" class="ed-row"><div><strong>{{ sale.number }}</strong><small>{{ sale.customerName }} · {{ money(sale.total, sale.storeSnapshot.currency) }}</small><small v-if="sale.syncError" class="ed-alert">{{ needsReceiptReview(sale.syncError)?'The original payment needs manager review. Keep this receipt queued; do not take payment again.':sale.syncError }}</small></div></div><p v-if="!Store.state.pendingSales.length">All receipts are synced.</p><template #actions><button class="ed-btn" @click="pending=false;go('/receipt-reviews')">Payment reviews</button><button class="ed-btn" @click="exportPending"><Icon name="download" />Export recovery copy</button><button class="ed-btn primary" :disabled="!Store.state.online || Store.state.syncing" @click="Store.syncSales()">{{ Store.state.syncing?'Syncing…':'Retry sync' }}</button></template></Modal>
    <Modal v-if="switcher" title="Switch company" @close="switcher=false"><button v-for="item in Store.state.companies" :key="item.id" class="ed-row" style="width:100%;text-align:left;background:none" @click="switcher=false;Store.switchCompany(item)"><span><strong>{{ item.name }}</strong><small>{{ item.hostname||item.slug }}</small></span><Icon name="arrow"/></button><template #actions><button v-if="user.role==='super_admin'" class="ed-btn" @click="switcher=false;Store.selectCompany(null)">Global administration</button><button class="ed-btn" @click="switcher=false">Cancel</button></template></Modal>
  </div>
</template>
