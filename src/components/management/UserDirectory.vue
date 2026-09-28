<script setup>
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { Store } from '../../store';
import { manageableAccount } from '../../domain/viewAccess';
import { api } from '../../services/api';
import { matchesPeople, roleLabel, userPayload, managementError, isArchived } from '../../domain/management';
import Icon from '../ui/EditionIcon.vue';
import Modal from '../ui/EditionModal.vue';
import UserEditor from './UserEditor.vue';
const props = defineProps({ companies: { type: Array, default: () => [] }, companyId: { type: String, default: '' }, global: Boolean });
const emit = defineEmits(['profile','refresh']);
const router = useRouter();
const query = ref(''), role = ref(''), status = ref(''), companyFilter = ref(''), editor = ref(false), editing = ref(null), pending = ref(null), busy = ref(false), error = ref('');
const people = computed(() => Store.state.users.filter(user => !props.companyId || (user.assignments||[]).some(x=>x.company_id===props.companyId) || user.role==='workspace_owner'));
const filtered = computed(() => matchesPeople(people.value, { query: query.value, role: role.value, status: status.value, companyId: companyFilter.value }));
const activeCount = computed(() => people.value.filter(user => !user.disabled && user.login_available).length);
const companyName = user => ['super_admin','workspace_owner'].includes(user.role) ? (user.role==='super_admin'?'All workspaces':'All workspace companies') : (user.assignments||[]).map(x=>props.companies.find(c=>c.id===x.company_id)?.name).filter(Boolean).join(', ') || 'Unassigned';
const archivedAssignment = user => (user.assignments||[]).some(x=>isArchived(props.companies.find(company => company.id === x.company_id)));
function edit(user = null) {
  if (user?.id === Store.state.currentUser?.id) { if (props.global) emit('profile'); else router.push('/profile'); return; }
  if(!manageableAccount(Store.state.currentUser,user))return;
  editing.value = user; editor.value = true;
}
async function refresh() {
  try { await Store.startListeners(); emit('refresh'); }
  catch (failure) { error.value = managementError(failure); }
}
function confirmAction(user, action) { if(!manageableAccount(Store.state.currentUser,user))return; error.value = ''; pending.value = { user: { ...user }, action }; }
async function applyAction() {
  if (busy.value || !Store.state.online) return;
  busy.value = true; error.value = '';
  const { user, action } = pending.value;
  try {
    if (!manageableAccount(Store.state.currentUser,user)) throw new Error("access_denied");
    if (action === 'revoke') await api('/users/' + encodeURIComponent(user.id) + '/revoke-sessions', { method: 'POST', body: {} });
    else if (action === 'suspend') await api('/users/' + encodeURIComponent(user.id), { method: 'DELETE' });
    else await api('/users/' + encodeURIComponent(user.id), { method: 'PUT', body: userPayload({ ...user, disabled: false }, true) });
    pending.value = null;
    Store.notify(action === 'revoke' ? 'Sessions revoked. The teammate must sign in again.' : action === 'suspend' ? 'Account suspended. Assignment and history retained.' : 'Account reactivated.');
    await refresh();
  } catch (failure) { error.value = managementError(failure); }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="ed-page ed-management">
    <header class="ed-page-head"><div><div class="ed-eyebrow">{{ global ? 'WORKSPACE ADMINISTRATION' : 'COMPANY ADMINISTRATION' }}</div><h1>People & access.</h1><p>Assign each person to one or more companies with an explicit role.</p></div><button class="ed-btn primary" :disabled="!Store.state.online" @click="edit()"><Icon name="plus"/>Add person</button></header>
    <div class="ed-management-stats"><span><strong>{{ people.length }}</strong> accounts</span><span><strong>{{ activeCount }}</strong> active</span><span><strong>{{ people.filter(user => user.disabled).length }}</strong> suspended</span></div>
    <div v-if="!Store.state.online" class="ed-notice warning">Access changes require an internet connection. Reconnect to create or update accounts.</div>
    <p v-if="error && !pending" class="ed-notice error" role="alert">{{ error }} <button class="ed-link" @click="error='';refresh()">Refresh</button></p>
    <div class="ed-filters ed-management-filters">
      <label class="ed-field ed-management-search"><span>Search people</span><input v-model="query" type="search" placeholder="Name or email"></label>
      <label class="ed-field"><span>Role</span><select v-model="role"><option value="">All roles</option><option v-if="global" value="super_admin">SuperAdmin</option><option v-if="Store.can('managersManage')" value="workspace_owner">Workspace owner</option><option v-if="Store.can('managersManage')" value="manager">Manager</option><option value="operator">Operator</option><option v-if="global" value="unassigned">Unassigned</option></select></label>
      <label class="ed-field"><span>Status</span><select v-model="status"><option value="">All statuses</option><option value="active">Active</option><option value="disabled">Suspended</option></select></label>
      <label v-if="global" class="ed-field"><span>Company</span><select v-model="companyFilter"><option value="">All companies</option><option value="unassigned">Unassigned accounts</option><option v-for="company in companies" :key="company.id" :value="company.id">{{ company.name }}{{ isArchived(company) ? ' (archived)' : '' }}</option></select></label>
    </div>
    <div class="ed-section-head"><small class="ed-muted" role="status">Showing {{ filtered.length }} of {{ people.length }} accounts</small><button v-if="query || role || status || companyFilter" class="ed-link" @click="query='';role='';status='';companyFilter=''">Clear filters</button></div>
    <div v-if="filtered.length" class="ed-table-wrap">
      <table class="ed-table ed-management-table"><thead><tr><th scope="col">Teammate</th><th scope="col">Role & company</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
        <tbody><tr v-for="user in filtered" :key="user.id">
          <td><strong>{{ user.username }}</strong><small>{{ user.email }}</small><small v-if="user.id === Store.state.currentUser?.id">You</small></td>
          <td>{{ roleLabel(user.role) }}<small>{{ companyName(user) }}{{ archivedAssignment(user) ? ' · Archived' : '' }}</small></td>
          <td><span class="ed-pill" :class="{warning:user.disabled}">{{ !user.login_available ? 'No sign-in account' : user.disabled ? 'Suspended' : 'Active' }}</span><small v-if="archivedAssignment(user)">Company access paused</small></td>
          <td><div class="ed-actions">
            <button v-if="user.login_available && (user.id === Store.state.currentUser?.id || manageableAccount(Store.state.currentUser,user))" class="ed-btn small" :disabled="!Store.state.online" @click="edit(user)">{{ user.id === Store.state.currentUser?.id ? 'My profile' : 'Edit' }}</button>
            <template v-if="user.login_available && user.id !== Store.state.currentUser?.id && manageableAccount(Store.state.currentUser,user)">
              <button v-if="!user.disabled" class="ed-btn small" :disabled="!Store.state.online" @click="confirmAction(user,'revoke')">Sign out sessions</button>
              <button v-if="!user.disabled" class="ed-btn small danger" :disabled="!Store.state.online" @click="confirmAction(user,'suspend')">Suspend</button>
              <button v-else class="ed-btn small" :disabled="!Store.state.online || archivedAssignment(user) || (!(user.assignments||[]).length && !['super_admin','workspace_owner'].includes(user.role))" @click="confirmAction(user,'reactivate')">Reactivate</button>
            </template>
          </div><small v-if="!user.login_available">Historical records retained. This person has no sign-in account.</small><small v-else-if="user.disabled && !(user.assignments||[]).length && !['super_admin','workspace_owner'].includes(user.role)">Assign a company and role before reactivating.</small><small v-else-if="user.disabled && archivedAssignment(user)">Restore the company or reassign this account first.</small></td>
        </tr></tbody>
      </table>
    </div>
    <div v-else class="ed-empty"><Icon name="people"/><h3>{{ people.length ? 'No people match these filters.' : 'Your team starts here.' }}</h3><p>{{ people.length ? 'Try a different name, role, company or status.' : 'Create an account and choose a role to get your team connected.' }}</p></div>
    <UserEditor v-if="editor" :user="editing" :companies="companies" :company-id="companyId" @close="editor=false;editing=null" @saved="refresh"/>
    <Modal v-if="pending" :title="pending.action === 'suspend' ? 'Suspend this account?' : pending.action === 'reactivate' ? 'Reactivate this account?' : 'Sign out all sessions?'" :busy="busy" @close="pending=null">
      <h3>{{ pending.user.username }}</h3><p class="ed-muted">{{ pending.user.email }}</p>
      <p v-if="pending.action === 'suspend'">This person will be signed out and unable to sign in. Their company assignment and financial history will stay intact. You can reactivate them later.</p>
      <p v-else-if="pending.action === 'reactivate'">This person can sign in again using their existing password and assigned role. Previous sessions remain signed out.</p>
      <p v-else>This person will be signed out on every device. Their account stays active and they can sign in again.</p>
      <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
      <template #actions><button class="ed-btn" :disabled="busy" @click="pending=null">Cancel</button><button class="ed-btn" :class="pending.action === 'suspend' ? 'danger' : 'primary'" :disabled="busy || !Store.state.online" @click="applyAction">{{ busy ? 'Updating…' : pending.action === 'suspend' ? 'Suspend account' : pending.action === 'reactivate' ? 'Reactivate account' : 'Sign out sessions' }}</button></template>
    </Modal>
  </section>
</template>
