<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { Store } from '../../store';
import { api } from '../../services/api';
import { isArchived, managementError } from '../../domain/management';
import Icon from '../ui/EditionIcon.vue';
import Modal from '../ui/EditionModal.vue';
import CompanyEditor from './CompanyEditor.vue';
const emit = defineEmits(['loaded']);
const companies = ref([...Store.state.companies]), query = ref(''), status = ref('active'), loading = ref(false), error = ref(''), editor = ref(false), editing = ref(null), pending = ref(null), busy = ref(false);
const filtered = computed(() => companies.value.filter(company => {
  const term = query.value.trim().toLowerCase();
  return (!term || [company.name,company.registration,company.email].some(value => (value || '').toLowerCase().includes(term))) && (!status.value || (status.value === 'archived' ? isArchived(company) : !isArchived(company)));
}));
const activeCount = computed(() => companies.value.filter(company => !isArchived(company)).length);
const managers = company => Store.state.users.filter(user => (user.assignments||[]).some(x=>x.company_id===company.id&&x.role==='manager') && !user.disabled).length;
const teammates = company => Store.state.users.filter(user => (user.assignments||[]).some(x=>x.company_id===company.id) && !user.disabled).length;
let refreshGeneration = 0;
async function refresh() {
  const generation = ++refreshGeneration;
  loading.value = true; error.value = '';
  try {
    const loaded = await api('/companies?includeArchived=true');
    if (generation !== refreshGeneration) return;
    companies.value = loaded; emit('loaded', companies.value);
  } catch (failure) {
    if (generation === refreshGeneration) error.value = managementError(failure);
  } finally {
    if (generation === refreshGeneration) loading.value = false;
  }
}
onBeforeUnmount(() => { refreshGeneration++; });

async function saved() {
  await Promise.all([refresh(), Store.startListeners().catch(failure => { error.value = managementError(failure); })]);
}
async function open(company) {
  try { await Store.startListeners(); const current = Store.state.companies.find(c => c.id === company.id); if (current) await Store.switchCompany(current); else error.value = 'This company is unavailable. Refresh the list and try again.'; }
  catch (failure) { error.value = managementError(failure); }
}
function edit(company = null) { editing.value = company; editor.value = true; }
async function applyAction() {
  if (busy.value || !Store.state.online) return;
  busy.value = true; error.value = '';
  const company = pending.value, restore = isArchived(company);
  try {
    await api('/companies/' + encodeURIComponent(company.id) + (restore ? '/restore' : ''), { method: restore ? 'POST' : 'DELETE', ...(restore ? { body: {} } : {}) });
    pending.value = null; Store.notify(restore ? 'Company restored. Assigned active teammates can sign in again.' : 'Company archived. Records and assignments retained.'); await saved();
  } catch (failure) { error.value = managementError(failure); }
  finally { busy.value = false; }
}
onMounted(refresh);
defineExpose({ refresh });
</script>
<template>
  <section class="ed-page ed-management">
    <header class="ed-page-head"><div><div class="ed-eyebrow">YOUR WORKSPACES</div><h1>A place for every business.</h1><p>Company details, access and enrollment, all in one place.</p></div><button class="ed-btn primary" :disabled="!Store.state.online" @click="edit()"><Icon name="plus"/>Enroll company</button></header>
    <div class="ed-management-stats"><span><strong>{{ activeCount }}</strong> active companies</span><span><strong>{{ companies.length-activeCount }}</strong> archived</span><span><strong>{{ Store.state.users.filter(user => !user.disabled).length }}</strong> active accounts</span></div>
    <div v-if="!Store.state.online" class="ed-notice warning">Connect to the internet to manage companies and enroll a new business.</div>
    <p v-if="error && !pending" class="ed-notice error" role="alert">{{ error }} <button class="ed-link" @click="refresh">Try again</button></p>
    <div class="ed-filters ed-management-filters">
      <label class="ed-field ed-management-search"><span>Search companies</span><input v-model="query" type="search" placeholder="Name, registration or email"></label>
      <label class="ed-field"><span>Status</span><select v-model="status"><option value="active">Active companies</option><option value="archived">Archived companies</option><option value="">All companies</option></select></label>
      <button class="ed-btn" :disabled="loading || !Store.state.online" @click="refresh">Refresh</button>
    </div>
    <div class="ed-section-head"><small class="ed-muted" role="status">{{ loading ? 'Loading companies…' : 'Showing '+filtered.length+' of '+companies.length+' companies' }}</small><button v-if="query || status !== 'active'" class="ed-link" @click="query='';status='active'">Reset filters</button></div>
    <div v-if="filtered.length" class="ed-company-grid">
      <article v-for="company in filtered" :key="company.id" class="ed-company-tile" :class="{'ed-company-archived':isArchived(company)}">
        <div class="ed-actions" style="justify-content:space-between"><img v-if="company.logo" :src="company.logo" :alt="company.name" class="ed-management-logo"><span v-else class="ed-avatar solid"><Icon name="building"/></span><span class="ed-pill" :class="{warning:isArchived(company)}">{{ isArchived(company) ? 'Archived' : 'Active' }}</span></div>
        <h2>{{ company.name }}</h2><p>{{ company.registration || 'Registration not provided' }}</p>
        <p>{{ company.email || 'No company email' }}</p>
        <div class="ed-management-company-meta"><span>{{ company.preferences?.currency || 'RM' }} · {{ company.preferences?.taxRate ?? company.preferences?.tax ?? 0 }}% tax</span><span>{{ teammates(company) }} active teammates · {{ managers(company) }} managers</span></div>
        <p v-if="!managers(company) && !isArchived(company)" class="ed-muted">Managed by workspace owners.</p>
        <div class="ed-actions ed-management-space"><template v-if="!isArchived(company)"><button class="ed-btn primary small" :disabled="!Store.state.online" @click="open(company)">Open workspace<Icon name="arrow"/></button><button class="ed-btn small" :disabled="!Store.state.online" @click="edit(company)">Edit</button></template><button class="ed-btn small" :class="{danger:!isArchived(company)}" :disabled="!Store.state.online" @click="error='';pending=company">{{ isArchived(company) ? 'Restore company' : 'Archive' }}</button></div>
      </article>
    </div>
    <div v-else-if="!loading" class="ed-empty"><Icon name="building"/><h3>{{ companies.length ? 'No companies match these filters.' : 'Your first workspace starts here.' }}</h3><p>{{ companies.length ? 'Choose another status or search term.' : 'Enroll a company and choose its first administrator.' }}</p><button v-if="!companies.length" class="ed-link" :disabled="!Store.state.online" @click="edit()">Enroll your first company</button></div>
    <CompanyEditor v-if="editor" :company="editing" :users="Store.state.users" @close="editor=false;editing=null" @saved="saved" @open="open"/>
    <Modal v-if="pending" :title="isArchived(pending) ? 'Restore this company?' : 'Archive this company?'" :busy="busy" @close="pending=null">
      <h3>{{ pending.name }}</h3>
      <p v-if="isArchived(pending)">The workspace will become available again. Active teammates with retained assignments can sign in with their existing credentials. Suspended accounts remain suspended.</p>
      <template v-else><p>The workspace will be hidden from active companies and its teammates will be signed out. Financial records, private files and company assignments will be retained.</p><p>Restore the company later to make it available to its assigned active teammates again.</p></template>
      <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
      <template #actions><button class="ed-btn" :disabled="busy" @click="pending=null">Cancel</button><button class="ed-btn" :class="isArchived(pending) ? 'primary' : 'danger'" :disabled="busy || !Store.state.online" @click="applyAction">{{ busy ? 'Updating…' : isArchived(pending) ? 'Restore company' : 'Archive company' }}</button></template>
    </Modal>
  </section>
</template>
