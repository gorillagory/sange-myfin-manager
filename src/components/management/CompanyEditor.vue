<script setup>
import { ref, computed, nextTick } from 'vue';
import { Store } from '../../store';
import { api } from '../../services/api';
import { companyPayload, eligibleAdministrators, managementError } from '../../domain/management';
import Modal from '../ui/EditionModal.vue';
import CompanyFields from './CompanyFields.vue';
const props = defineProps({ company: Object, users: { type: Array, default: () => [] } });
const emit = defineEmits(['close','saved','open']);
const editing = !!props.company;
const form = ref(companyPayload(props.company)), admin = ref({ mode: 'self', user: { username: '', email: '', password: '' }, userId: '' });
const slugify=value=>(value||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,54)||'workspace';
const routing=ref({workspaceName:props.company?.workspace_name||'',workspaceSlug:props.company?.workspace_slug||'',companySlug:props.company?.slug||''});
if(!editing){routing.value.workspaceName='';routing.value.workspaceSlug='';routing.value.companySlug='';}
const stage = ref('details'), busy = ref(false), imageBusy = ref(false), error = ref(''), created = ref(null), request = ref(null), uncertain = ref(false);
const reviewPanel = ref(null);
const eligible = computed(() => eligibleAdministrators(props.users));
const administratorName = computed(() => admin.value.mode === 'self' ? 'You — workspace owner' : admin.value.mode === 'new' ? admin.value.user.username : eligible.value.find(user => user.id === admin.value.userId)?.username || 'Selected manager');
function review() {
  error.value = '';
  if (!form.value.name.trim() || !form.value.preferences.currency.trim()) { error.value = 'Company name and currency are required.'; return; }
  if(!editing){routing.value.workspaceName=routing.value.workspaceName.trim()||form.value.name.trim();routing.value.workspaceSlug=routing.value.workspaceSlug.trim()||slugify(routing.value.workspaceName);routing.value.companySlug=routing.value.companySlug.trim()||slugify(form.value.name);if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(routing.value.workspaceSlug)||!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(routing.value.companySlug)||`${routing.value.workspaceSlug}-${routing.value.companySlug}`.length>63){error.value='Use short lowercase workspace and company slugs. Their combined label must be 63 characters or fewer.';return;}}
  if (!editing && admin.value.mode === 'new' && !admin.value.user.username.trim()) { error.value = 'Enter the workspace owner’s name.'; return; }
  stage.value = 'review'; nextTick(() => reviewPanel.value?.focus());
}
async function save() {
  if (busy.value || !Store.state.online) return;
  error.value = ''; busy.value = true;
  try {
    if (editing) {
      const result = await api('/companies/' + encodeURIComponent(props.company.id), { method: 'PUT', body: companyPayload(form.value) });
      if(routing.value.companySlug&&routing.value.companySlug!==props.company.slug&&props.company.workspace_id)await api(`/workspaces/${encodeURIComponent(props.company.workspace_id)}/companies/${encodeURIComponent(props.company.id)}/routing`,{method:'PUT',body:{slug:routing.value.companySlug}});
      emit('saved', result); emit('close');
    } else {
      if (!request.value) request.value = {
        enrollmentId: crypto.randomUUID(),
        workspace:{name:routing.value.workspaceName,slug:routing.value.workspaceSlug},
        companySlug:routing.value.companySlug,
        company: companyPayload(form.value),
        administrator: admin.value.mode === 'new' ? { mode: 'new', user: { username: admin.value.user.username.trim(), email: admin.value.user.email.trim().toLowerCase(), password: admin.value.user.password } } : admin.value.mode === 'existing' ? { mode: 'existing', userId: admin.value.userId } : { mode: 'self' },
      };
      const result = await api('/companies/enroll', { method: 'POST', body: request.value });
      created.value = result.company; admin.value.user.password = ''; request.value = null; uncertain.value = false; stage.value = 'complete'; emit('saved', result.company);
    }
  } catch (failure) {
    error.value = managementError(failure);
    uncertain.value = !editing && (failure.network || failure.status >= 500);
    if (!uncertain.value) request.value = null;
  } finally { busy.value = false; }
}
</script>
<template>
  <Modal :title="editing ? 'Edit company' : stage === 'complete' ? 'Your company is ready' : 'Enroll a company'" :busy="busy || imageBusy || uncertain" wide @close="$emit('close')">
    <div v-if="!Store.state.online" class="ed-notice warning" role="status">Connect to the internet to save company changes. Your form stays on this page.</div>
    <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
    <template v-if="stage === 'complete'">
      <div class="ed-success"><h3>{{ created.name }}</h3><p>The workspace and its access settings were created together.</p></div>
      <p class="ed-muted">{{ admin.mode === 'self' ? 'You can open this workspace as its owner and add teammates whenever you are ready.' : 'The manager can now sign in with their account. Share any initial password through your own private channel; no email has been sent.' }}</p>
    </template>
    <form v-else-if="stage === 'details'" id="company-editor-form" @submit.prevent="review">
      <p class="ed-muted ed-management-intro">{{ editing ? 'Update brand details and routing. Existing financial records keep their original receipt snapshots.' : 'Create a workspace and its first company/brand together.' }} Fields marked * are required.</p>
      <fieldset class="ed-management-fields ed-editor-section" :disabled="busy"><h3>Workspace & address</h3><template v-if="!editing"><label class="ed-field"><span>Workspace name *</span><input v-model="routing.workspaceName" maxlength="160" placeholder="Bayam Food Services Sdn Bhd"></label><label class="ed-field"><span>Workspace slug *</span><input v-model="routing.workspaceSlug" maxlength="63" placeholder="bfsb"><small>Lowercase letters, numbers and hyphens.</small></label></template><label class="ed-field"><span>Company / brand slug *</span><input v-model="routing.companySlug" maxlength="63" placeholder="bali"><small v-if="!editing">Production preview: {{ (routing.workspaceSlug||'workspace')+'-'+(routing.companySlug||'brand')+'.finn3.com' }}</small><small v-else-if="company.hostname">Current address: {{ company.hostname }}</small></label></fieldset>
      <CompanyFields :model-value="form" :disabled="busy" @busy="imageBusy=$event"/>
      <fieldset v-if="!editing" class="ed-management-fields ed-editor-section" :disabled="busy">
        <h3>First workspace owner</h3>
        <label class="ed-field"><span>Who will own this workspace?</span><select v-model="admin.mode"><option value="self">I will manage it as SuperAdmin</option><option value="new">Create a new workspace owner</option><option value="existing" :disabled="!eligible.length">Assign an existing unassigned account</option></select></label>
        <p v-if="admin.mode === 'self'" class="ed-muted">Your owner account keeps access to all companies. No additional account will be created.</p>
        <div v-else-if="admin.mode === 'new'" class="ed-form-grid ed-management-space">
          <label class="ed-field"><span>Owner name *</span><input v-model="admin.user.username" required maxlength="120" autocomplete="name"></label>
          <label class="ed-field"><span>Owner email *</span><input v-model="admin.user.email" type="email" required maxlength="254" autocomplete="username"></label>
          <label class="ed-field wide"><span>Initial password *</span><input v-model="admin.user.password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"><small class="ed-muted">Use 12–128 characters. The manager can change it in My profile. No email will be sent.</small></label>
        </div>
        <label v-else class="ed-field ed-management-space"><span>Unassigned account *</span><select v-model="admin.userId" required><option value="" disabled>Select an account</option><option v-for="user in eligible" :key="user.id" :value="user.id">{{ user.username }} · {{ user.email }}</option></select><small class="ed-muted">Only active accounts without a company assignment are available. Their role will become Manager.</small></label>
      </fieldset>
    </form>
    <div v-else class="ed-management-review" ref="reviewPanel" tabindex="-1">
      <p class="ed-eyebrow">REVIEW BEFORE {{ editing ? 'SAVING' : 'ENROLLMENT' }}</p>
      <h3>{{ form.name }}</h3>
      <dl class="ed-management-details"><div v-if="!editing"><dt>Workspace</dt><dd>{{ routing.workspaceName }} · {{ routing.workspaceSlug }}</dd></div><div><dt>Company route</dt><dd>{{ routing.companySlug }}<br><span v-if="!editing">{{ routing.workspaceSlug+'-'+routing.companySlug+'.finn3.com' }}</span></dd></div><div><dt>Registration</dt><dd>{{ form.registration || 'Not provided' }}</dd></div><div><dt>Contact</dt><dd>{{ form.email || 'No email' }}<br>{{ form.phone || 'No phone' }}</dd></div><div><dt>Address</dt><dd>{{ form.address || 'Not provided' }}</dd></div><div><dt>Financial settings</dt><dd>{{ form.preferences.currency }} · {{ form.preferences.taxRate }}% default tax</dd></div><div v-if="!editing"><dt>Owner</dt><dd>{{ administratorName }}<br v-if="admin.mode === 'new'"><span v-if="admin.mode === 'new'">{{ admin.user.email }}</span></dd></div></dl>
      <p v-if="uncertain" class="ed-notice warning">The response was interrupted. Retry this enrollment to confirm its result without creating a second company. Closing is paused until this request is resolved.</p>
    </div>
    <template #actions>
      <template v-if="stage === 'complete'"><button class="ed-btn" @click="$emit('close')">Done</button><button class="ed-btn primary" @click="$emit('open',created);$emit('close')">Open workspace</button></template>
      <template v-else-if="stage === 'details'"><button class="ed-btn" :disabled="busy || imageBusy" @click="$emit('close')">Cancel</button><button class="ed-btn primary" type="submit" form="company-editor-form" :disabled="busy || imageBusy || !Store.state.online">Review details</button></template>
      <template v-else><button class="ed-btn" :disabled="busy || uncertain" @click="stage='details'">Back</button><button class="ed-btn primary" :disabled="busy || !Store.state.online" @click="save">{{ busy ? 'Saving…' : uncertain ? 'Retry enrollment' : editing ? 'Save company' : 'Enroll company' }}</button></template>
    </template>
  </Modal>
</template>
