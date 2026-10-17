<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';
import { api, userManagementPath } from '../../services/api';
import { userPayload, isArchived, managementError } from '../../domain/management';
import { MODULE_DEFINITIONS, defaultModulesForRole, effectiveModulesFor, moduleCeilingFor } from '../../domain/permissions';
import Modal from '../ui/EditionModal.vue';
const props = defineProps({ user: Object, companies: { type: Array, default: () => [] }, companyId: { type: String, default: '' } });
const emit = defineEmits(['close','saved']);
const editing=!!props.user,actor=Store.state.currentUser||{},global=actor.role==='super_admin',canManageManagers=Store.can('managersManage');
function delegableDefaults(role){const defaults=defaultModulesForRole(role);if(actor.role!=='manager')return defaults;const delegated=new Set(effectiveModulesFor(actor));return defaults.filter(module=>delegated.has(module));}
const existingAssignments=props.user?.assignments||[];
const initialRole=props.user?.role||'operator';
const initialModuleGrants=Object.fromEntries(existingAssignments.map(assignment=>[
 assignment.company_id,Array.isArray(assignment.modules)?[...assignment.modules]:defaultModulesForRole(assignment.role||initialRole),
]));
const form=ref({username:'',email:'',password:'',role:initialRole,company_id:props.companyId,company_ids:existingAssignments.map(x=>x.company_id),
 module_grants_by_company:initialModuleGrants,workspace_id:props.user?.workspace_id||actor.workspace_id||'',disabled:false,...(props.user||{})});
if(!form.value.company_ids.length&&form.value.company_id)form.value.company_ids=[form.value.company_id];
for(const companyId of form.value.company_ids)if(!Object.hasOwn(form.value.module_grants_by_company,companyId))form.value.module_grants_by_company[companyId]=delegableDefaults(initialRole);
const busy=ref(false),error=ref(''),revealedCode=ref(''),posCompany=ref(form.value.company_ids[0]||props.companyId||'');
const choices=computed(()=>props.companies.filter(c=>!isArchived(c)||form.value.company_ids.includes(c.id)));
const workspaces=computed(()=>[...new Map(props.companies.filter(c=>c.workspace_id).map(c=>[c.workspace_id,{id:c.workspace_id,name:c.workspace_name||c.name}])).values()]);
const moduleChoices=computed(()=>{const allowed=new Set(moduleCeilingFor(form.value.role)),delegable=actor.role==='manager'?new Set(effectiveModulesFor(actor)):null;return MODULE_DEFINITIONS.filter(module=>allowed.has(module.id)&&(!delegable||delegable.has(module.id)));});
const assignedChoices=computed(()=>choices.value.filter(company=>form.value.company_ids.includes(company.id)));
function toggleCompany(id){const values=new Set(form.value.company_ids);if(values.has(id))values.delete(id);else{values.add(id);form.value.module_grants_by_company[id]=delegableDefaults(form.value.role);}form.value.company_ids=[...values];if(!posCompany.value)posCompany.value=form.value.company_ids[0]||'';}
function modulesForCompany(id){const allowed=new Set(moduleCeilingFor(form.value.role));return (form.value.module_grants_by_company[id]||[]).filter(module=>allowed.has(module));}
function toggleModule(companyId,moduleId){const values=new Set(modulesForCompany(companyId));values.has(moduleId)?values.delete(moduleId):values.add(moduleId);form.value.module_grants_by_company[companyId]=[...values];}
function setAllModules(companyId,enabled){form.value.module_grants_by_company[companyId]=enabled?moduleChoices.value.map(module=>module.id):[];}
function hasAllModules(companyId){return moduleChoices.value.every(module=>modulesForCompany(companyId).includes(module.id));}
async function save(){
 if(busy.value||!Store.state.online)return;
 if(!canManageManagers&&form.value.role!=='operator'){error.value='Managers can create and edit operators only.';return;}
 if(!form.value.username.trim()){error.value='Enter the teammate’s name.';return;}
 if(['manager','operator'].includes(form.value.role)&&!form.value.company_ids.length){error.value='Assign at least one company.';return;}
 if(form.value.role==='workspace_owner'&&!form.value.workspace_id){error.value='Choose the owner workspace.';return;}
 busy.value=true;error.value='';try{await api(userManagementPath(props.companyId||Store.state.selectedCompany?.id,editing?'/'+encodeURIComponent(props.user.id):''),{method:editing?'PUT':'POST',body:userPayload(form.value,editing)});form.value.password='';emit('saved');emit('close');}catch(failure){error.value=managementError(failure);}finally{busy.value=false;}
}
async function generateCode(){if(!editing||!posCompany.value||busy.value)return;busy.value=true;error.value='';revealedCode.value='';try{const result=await api(`/companies/${encodeURIComponent(posCompany.value)}/users/${encodeURIComponent(props.user.id)}/pos-code`,{method:'POST',body:{}});revealedCode.value=result.code;}catch(failure){error.value=managementError(failure);}finally{busy.value=false;}}
</script>
<template><Modal :title="editing?'Edit person':'Add person'" :busy="busy" @close="$emit('close')">
 <div v-if="!Store.state.online" class="ed-notice warning">Connect to the internet to manage access.</div><p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
 <form id="user-editor-form" class="ed-form-grid" @submit.prevent="save">
  <label class="ed-field wide"><span>Full name *</span><input v-model="form.username" required maxlength="120" autocomplete="name" :readonly="editing&&actor.role==='manager'" :disabled="busy"><small v-if="editing&&actor.role==='manager'">A workspace owner manages identity profile details.</small></label>
  <label class="ed-field wide"><span>Sign-in email *</span><input v-model="form.email" type="email" required maxlength="254" autocomplete="username" :readonly="editing" :disabled="busy"><small v-if="editing">The sign-in email is fixed.</small></label>
  <label v-if="!editing" class="ed-field wide"><span>Initial password *</span><input v-model="form.password" type="password" required minlength="12" maxlength="128" autocomplete="new-password" :disabled="busy"><small>12–128 characters. Share it privately.</small></label>
  <label class="ed-field wide"><span>Role *</span><select v-model="form.role" :disabled="busy"><option value="operator">Operator — sales, expense entry and inventory transactions</option><option v-if="canManageManagers" value="manager">Manager — assigned-company operations and approved reports</option><option v-if="canManageManagers" value="workspace_owner">Workspace owner — every company in one workspace</option><option v-if="global" value="super_admin">SuperAdmin — global access</option></select></label>
  <label v-if="form.role==='workspace_owner'" class="ed-field wide"><span>Workspace *</span><select v-model="form.workspace_id"><option value="" disabled>Select workspace</option><option v-for="workspace in workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name }}</option></select></label>
  <fieldset v-if="['manager','operator'].includes(form.role)" class="ed-field wide"><legend>Assigned companies *</legend><label v-for="company in choices" :key="company.id" class="ed-check"><input type="checkbox" :checked="form.company_ids.includes(company.id)" :disabled="busy||(!canManageManagers&&company.id!==actor.company_id)" @change="toggleCompany(company.id)"><span>{{ company.name }}{{ isArchived(company)?' (archived)':'' }}</span></label></fieldset>
  <fieldset v-if="['manager','operator'].includes(form.role)&&form.company_ids.length" class="ed-field wide"><legend>Module access by company</legend><small>Role permissions still apply inside every enabled module. Removing every module leaves profile access only.</small>
   <section v-for="company in assignedChoices" :key="`modules-${company.id}`" class="ed-card ed-access-scope">
    <div class="ed-section-head"><strong>{{ company.name }}</strong><button type="button" class="ed-link" :disabled="busy" @click="setAllModules(company.id,!hasAllModules(company.id))">{{ hasAllModules(company.id)?'Clear all':'Enable all available' }}</button></div>
    <div class="ed-access-module-grid"><label v-for="module in moduleChoices" :key="module.id" class="ed-check"><input type="checkbox" :checked="modulesForCompany(company.id).includes(module.id)" :disabled="busy" @change="toggleModule(company.id,module.id)"><span><strong>{{ module.label }}</strong><small>{{ module.description }}</small></span></label></div>
   </section>
  </fieldset>
  <p v-if="form.role==='super_admin'" class="ed-notice warning wide">SuperAdmin has global access to every workspace, person and transaction.</p>
  <p v-if="editing" class="ed-muted wide">{{ actor.role==='manager'?'Saving changes signs this person out of this company’s handoff and POS-code sessions.':'Saving profile, assignment or role changes revokes all password, handoff and POS-code sessions.' }}</p>
 </form>
 <section v-if="editing&&['manager','operator'].includes(form.role)" class="ed-card wide"><h3>Six-digit POS access</h3><p class="ed-muted">Rotating the code revokes existing POS sessions. The new code is shown once.</p><label class="ed-field"><span>Company</span><select v-model="posCompany"><option v-for="company in choices.filter(c=>form.company_ids.includes(c.id))" :key="company.id" :value="company.id">{{ company.name }}</option></select></label><button class="ed-btn" :disabled="busy||!posCompany" @click="generateCode">Generate new code</button><p v-if="revealedCode" class="ed-notice"><strong>New code: {{ revealedCode }}</strong><br>Store it securely; it cannot be shown again.</p></section>
 <template #actions><button class="ed-btn" :disabled="busy" @click="$emit('close')">Cancel</button><button type="submit" form="user-editor-form" class="ed-btn primary" :disabled="busy||!Store.state.online">{{ busy?'Saving…':editing?'Save person':'Create account' }}</button></template>
</Modal></template>
