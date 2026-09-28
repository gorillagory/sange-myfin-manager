<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';
import { api } from '../../services/api';
import { userPayload, isArchived, managementError } from '../../domain/management';
import Modal from '../ui/EditionModal.vue';
const props = defineProps({ user: Object, companies: { type: Array, default: () => [] }, companyId: { type: String, default: '' } });
const emit = defineEmits(['close','saved']);
const editing = !!props.user, superUser = Store.state.currentUser?.role === 'super';
const form = ref({ username: '', email: '', password: '', role: 'company_user', company_id: props.companyId, disabled: false, ...(props.user || {}) });
const busy = ref(false), error = ref('');
const choices = computed(() => props.companies.filter(c => !isArchived(c) || c.id === form.value.company_id));
async function save() {
  if (busy.value || !Store.state.online) return;
  if (!superUser && (form.value.role !== 'company_user' || (props.user && props.user.role !== 'company_user'))) { error.value='Only an owner can manage manager accounts.'; return; }
  if (!form.value.username.trim()) { error.value = 'Enter the teammate’s name.'; return; }
  busy.value = true; error.value = '';
  try {
    await api('/users' + (editing ? '/' + encodeURIComponent(props.user.id) : ''), { method: editing ? 'PUT' : 'POST', body: userPayload(form.value, editing) });
    form.value.password = ''; emit('saved'); emit('close');
  } catch (failure) { error.value = managementError(failure); }
  finally { busy.value = false; }
}
</script>
<template>
  <Modal :title="editing ? 'Edit teammate' : 'Add teammate'" :busy="busy" @close="$emit('close')">
    <div v-if="!Store.state.online" class="ed-notice warning">Connect to the internet to manage access.</div>
    <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
    <form id="user-editor-form" class="ed-form-grid" @submit.prevent="save">
      <label class="ed-field wide"><span>Full name *</span><input v-model="form.username" required maxlength="120" autocomplete="name" :disabled="busy"></label>
      <label class="ed-field wide"><span>Sign-in email *</span><input v-model="form.email" type="email" required maxlength="254" autocomplete="username" :readonly="editing" :disabled="busy"><small v-if="editing" class="ed-muted">The sign-in email is fixed for this account.</small></label>
      <label v-if="!editing" class="ed-field wide"><span>Initial password *</span><input v-model="form.password" type="password" required minlength="12" maxlength="128" autocomplete="new-password" :disabled="busy"><small class="ed-muted">12–128 characters. Share it privately. They can change it in My profile; no email will be sent.</small></label>
      <label class="ed-field wide"><span>Role *</span><select v-model="form.role" required :disabled="busy"><option value="" disabled>Select a role</option><option value="company_user">Staff — checkout and assigned document drafts</option><option v-if="superUser" value="company_admin">Manager — operations, documents and staff access</option><option v-if="superUser" value="super">Workspace owner — all companies and accounts</option></select></label>
      <label v-if="form.role !== 'super'" class="ed-field wide"><span>Company *</span><select v-model="form.company_id" required :disabled="busy || !superUser"><option value="" disabled>Select a company</option><option v-for="company in choices" :key="company.id" :value="company.id">{{ company.name }}{{ isArchived(company) ? ' (archived)' : '' }}</option></select></label>
      <p v-else class="ed-notice warning wide">Workspace owners can manage every company and account. Use this role only for trusted administrators.</p>
      <p v-if="editing" class="ed-muted wide">Saving a role or profile change signs this teammate out. Account status stays {{ form.disabled ? 'suspended' : 'active' }}. Use the account’s status action to change access.</p>
    </form>
    <template #actions><button class="ed-btn" :disabled="busy" @click="$emit('close')">Cancel</button><button type="submit" form="user-editor-form" class="ed-btn primary" :disabled="busy || !Store.state.online">{{ busy ? 'Saving…' : editing ? 'Save teammate' : 'Create account' }}</button></template>
  </Modal>
</template>
