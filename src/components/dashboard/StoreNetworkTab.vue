<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { Store } from '../../store';
import {
  LOCATION_TYPES, STORE_TYPES, TERMINAL_CAPABILITIES, TERMINAL_TYPES, locationPayload,
  storePayload, terminalCapabilitiesForType, terminalPayload, terminalPresence, validateNetworkForm,
} from '../../domain/storeNetwork';
import { issueTerminalEnrollment } from '../../services/storeNetwork';
import Icon from '../ui/EditionIcon.vue';
import Modal from '../ui/EditionModal.vue';

const tab=ref('stores'),loading=ref(false),busy=ref(false),error=ref(''),selectedStoreId=ref('');
const editor=ref(null),form=ref({}),pairing=ref(null),copied=ref(false);
const originalTerminal=ref(null);
const staffEditor=ref(null),staffLocationIds=ref([]);
const network=computed(()=>Store.state.storeNetwork);
const stores=computed(()=>network.value.stores || []);
const locations=computed(()=>network.value.locations || []);
const terminals=computed(()=>network.value.terminals || []);
const selectedStore=computed(()=>stores.value.find(store=>store.id===selectedStoreId.value) || stores.value[0] || null);
const storeLocations=computed(()=>locations.value.filter(location=>location.storeId===selectedStore.value?.id));
const storeTerminals=computed(()=>terminals.value.filter(terminal=>terminal.storeId===selectedStore.value?.id));
const activeTerminals=computed(()=>terminals.value.filter(terminal=>terminal.status==='active').length);
const enrolledTerminals=computed(()=>terminals.value.filter(terminal=>terminal.enrolledAt).length);
const selectedCompanyId=computed(()=>Store.state.selectedCompany?.id);
const terminalSetupUrl=computed(()=>Store.state.selectedCompany?.hostname?`https://${Store.state.selectedCompany.hostname}/terminal-setup`:new URL('/terminal-setup',location.origin).href);
const terminalRelocationLocked=computed(()=>editor.value==='terminal' && Boolean(form.value.id && (originalTerminal.value?.enrolledAt || Number(originalTerminal.value?.credentialVersion)>0)));
const terminalStatusOptions=computed(()=>{
  const current=originalTerminal.value?.status || 'pending',options=[{value:current,label:`Keep ${String(current).replaceAll('_',' ')}`}];
  if(current==='active')options.push({value:'pending',label:'Require re-enrollment'},{value:'suspended',label:'Suspend terminal'},{value:'retired',label:'Retire terminal'});
  else if(current==='pending')options.push({value:'suspended',label:'Suspend terminal'},{value:'retired',label:'Retire terminal'});
  else if(current==='suspended')options.push({value:'pending',label:'Return to pending enrollment'},{value:'retired',label:'Retire terminal'});
  return options;
});
const openShifts=computed(()=>Store.state.registerShifts.filter(shift=>shift.status==='open'));
const activeStaff=computed(()=>(Store.state.users || []).filter(user=>!user.disabled && (user.assignments||[]).some(assignment=>assignment.company_id===selectedCompanyId.value)));

function label(options,value){return options.find(option=>option.value===value)?.label || String(value || '—').replaceAll('_',' ');}
function failureMessage(failure){return ({
  active_pos_terminal_required:'Pair and activate at least one POS terminal before enabling enforcement.',
  last_active_pos_terminal_required:'Keep at least one paired POS-capable terminal active while enforcement is enabled.',
  terminal_activation_requires_enrollment:'Use a pairing code on the terminal browser to activate it.',
  enrolled_terminal_cannot_be_relocated:'Create a new terminal in the new area, then retire this enrolled record.',
  terminal_register_shift_open:'Close this terminal’s register before changing its lifecycle or pairing.',
  terminal_has_active_operations:'Sign staff out and close this terminal’s register before rotating its pairing.',
  terminal_not_enrollable:'Only pending or active terminals can receive a pairing code.',
  record_conflict:'This record changed elsewhere. Refresh Store Network and try again.',
  staff_member_not_found:'This person is no longer an active manager or operator in the company.',
  store_location_not_found:'One of the selected work areas is no longer active.',
  password_session_required:'Sign in with email and password to manage Store Network.',
  access_denied:'Your current role cannot make this change.',
})[failure?.message] || failure?.message || 'Store Network could not be updated.';}
function addressLabel(value){return typeof value==='string'?value:value?.formatted || value?.label || 'Address not recorded';}
function shiftFor(terminal){return openShifts.value.find(shift=>(shift.terminalId||shift.terminal_id)===terminal.id);}
function staffName(terminal,shift){return terminal.currentStaff?.name || shift?.operatorName || shift?.staffName || shift?.userName || shift?.openedByName || 'No current operator';}
function personId(person){return person.id || person.uid;}
function personRole(person){return (person.assignments||[]).find(item=>item.company_id===selectedCompanyId.value)?.role || person.role;}
function canAssignPerson(person){return Store.can('usersManage') && (personRole(person)!=='manager' || Store.can('managersManage'));}
function terminalForPerson(person){return terminals.value.find(terminal=>terminal.currentStaff?.id===personId(person));}
function assignmentFor(person){return network.value.staffAssignments?.find(assignment=>assignment.identityId===personId(person));}
function assignmentLabel(person){const ids=assignmentFor(person)?.locationIds || [];if(!ids.length)return 'All company stores';const storeIds=new Set(locations.value.filter(location=>ids.includes(location.id)).map(location=>location.storeId));return `${ids.length} area${ids.length===1?'':'s'} across ${storeIds.size} store${storeIds.size===1?'':'s'}`;}
function editStaff(person){staffEditor.value=person;staffLocationIds.value=[...(assignmentFor(person)?.locationIds || [])];error.value='';}
function toggleStaffLocation(id){const set=new Set(staffLocationIds.value);set.has(id)?set.delete(id):set.add(id);staffLocationIds.value=[...set];}
function chooseStore(store){selectedStoreId.value=store.id;}
function blank(kind){
  if(kind==='store')return {name:'',code:'',type:'branch',status:'active',timeZone:'Asia/Kuala_Lumpur',address:''};
  if(kind==='location')return {storeId:selectedStore.value?.id||'',name:'',code:'',type:'front_counter',status:'active'};
  return {storeId:selectedStore.value?.id||'',locationId:storeLocations.value[0]?.id||'',name:'',code:'',type:'pos',status:'pending',capabilities:terminalCapabilitiesForType('pos')};
}
function edit(kind,value=null){editor.value=kind;originalTerminal.value=kind==='terminal'&&value?{...value}:null;form.value=value?{...value,address:kind==='store'?addressLabel(value.address)==='Address not recorded'?'':addressLabel(value.address):value.address,capabilities:[...(value.capabilities||[])]}:blank(kind);error.value='';}
function closeEditor(){if(!busy.value){editor.value=null;originalTerminal.value=null;form.value={};error.value='';}}
function toggleCapability(value){const set=new Set(form.value.capabilities||[]);set.has(value)?set.delete(value):set.add(value);form.value.capabilities=[...set];}
async function load(){
  if(!selectedCompanyId.value)return;
  loading.value=true;error.value='';
  try{await Promise.all([Store.refreshStoreNetwork(),Store.refreshRegisterShifts().catch(()=>[])]);if(!stores.value.some(store=>store.id===selectedStoreId.value))selectedStoreId.value=stores.value[0]?.id||'';}
  catch(failure){error.value=failure.message==='api_unavailable'?'Store Network is not available in this release yet.':failureMessage(failure);}
  finally{loading.value=false;}
}
async function save(){
  const message=validateNetworkForm(editor.value,form.value);if(message){error.value=message;return;}
  busy.value=true;error.value='';
  try{
    const payload=editor.value==='store'?storePayload(form.value):editor.value==='location'?locationPayload(form.value):terminalPayload(form.value);
    if(editor.value==='terminal'&&form.value.id){
      if(form.value.status===originalTerminal.value?.status)delete payload.status;
      if(terminalRelocationLocked.value){delete payload.storeId;delete payload.locationId;}
    }
    const result=await Store.saveNetworkRecord(editor.value,{...(form.value.id?{id:form.value.id,version:Number(form.value.version)}:{}),...payload});
    if(editor.value==='store'&&result?.store?.id)selectedStoreId.value=result.store.id;
    Store.notify(`${editor.value[0].toUpperCase()+editor.value.slice(1)} saved.`);editor.value=null;originalTerminal.value=null;form.value={};error.value='';
  }catch(failure){error.value=failureMessage(failure);}finally{busy.value=false;}
}
async function createPairing(terminal){busy.value=true;error.value='';
  try{const result=await issueTerminalEnrollment(Store,terminal.id);pairing.value={...result,terminal};copied.value=false;}
  catch(failure){error.value=failureMessage(failure);}finally{busy.value=false;}
}
async function copyPairing(){try{await navigator.clipboard.writeText(pairing.value.token);copied.value=true;}catch{copied.value=false;}}
async function savePolicy(){busy.value=true;error.value='';try{await Store.saveNetworkPolicy({terminalEnforcement:Boolean(network.value.policy.terminalEnforcement),requireOpenRegisterForPos:Boolean(network.value.policy.requireOpenRegisterForPos)});Store.notify('Terminal policy updated.');}catch(failure){error.value=failureMessage(failure);}finally{busy.value=false;}}
async function saveStaffScope(){if(!Store.can('usersManage'))return;busy.value=true;error.value='';try{await Store.saveStaffAssignments(personId(staffEditor.value),staffLocationIds.value);Store.notify(staffLocationIds.value.length?'Staff area access updated.':'Staff member can work across all company stores.');staffEditor.value=null;}catch(failure){error.value=failureMessage(failure);}finally{busy.value=false;}}

watch(selectedCompanyId,load);
watch(()=>form.value.storeId,storeId=>{if(editor.value==='terminal'&&!locations.value.some(location=>location.id===form.value.locationId&&location.storeId===storeId))form.value.locationId=locations.value.find(location=>location.storeId===storeId)?.id||'';});
watch(()=>form.value.type,(type,previous)=>{
  if(editor.value!=='terminal'||form.value.id||type===previous)return;
  const current=form.value.capabilities||[],priorDefaults=terminalCapabilitiesForType(previous);
  if(current.length===priorDefaults.length&&current.every(value=>priorDefaults.includes(value)))
    form.value.capabilities=terminalCapabilitiesForType(type);
});
onMounted(load);
</script>

<template>
  <section class="ed-page mf-network-page">
    <header class="ed-page-head"><div><div class="ed-eyebrow">PHYSICAL OPERATIONS</div><h1>Company → stores → areas → terminals.</h1><p>Assign every staff screen to a reviewed operating place.</p></div><div class="ed-actions"><router-link class="ed-btn" to="/terminal-setup"><Icon name="link"/>Pair this browser</router-link><button class="ed-btn primary" :disabled="loading" @click="edit('store')"><Icon name="plus"/>New store</button></div></header>
    <p v-if="error && !editor" class="ed-notice error" role="alert"><Icon name="alert"/><span>{{ error }}</span></p>
    <div class="ed-notice"><Icon name="info"/><div><strong>Physical operations and public ordering stay distinct.</strong>Stores and areas locate staff, terminals, shifts, and future stock. Storefront pickup points and table QR codes remain customer-facing service points.</div></div>
    <div class="ed-metrics mf-network-metrics"><div class="ed-metric"><label>Stores</label><strong>{{ stores.length }}</strong><small>{{ stores.filter(item=>item.status==='active').length }} active</small></div><div class="ed-metric"><label>Work areas</label><strong>{{ locations.length }}</strong><small>Across this company</small></div><div class="ed-metric"><label>Enrolled terminals</label><strong>{{ enrolledTerminals }}/{{ terminals.length }}</strong><small>{{ activeTerminals }} active</small></div><div class="ed-metric"><label>Open registers</label><strong>{{ openShifts.length }}</strong><small>Current cash sessions</small></div></div>
    <div class="ed-tabs" role="tablist" aria-label="Store Network sections"><button :class="{active:tab==='stores'}" @click="tab='stores'">Stores &amp; areas</button><button :class="{active:tab==='terminals'}" @click="tab='terminals'">Terminals <span class="ed-tab-count">{{ terminals.length }}</span></button><button :class="{active:tab==='staff'}" @click="tab='staff'">Staff coverage</button><button :class="{active:tab==='policy'}" @click="tab='policy'">Policy</button></div>

    <div v-if="loading" class="ed-empty" role="status">Loading Store Network…</div>
    <template v-else-if="tab==='stores'">
      <div v-if="stores.length" class="mf-network-layout">
        <aside class="mf-network-store-list" aria-label="Stores"><button v-for="store in stores" :key="store.id" :class="{active:selectedStore?.id===store.id}" @click="chooseStore(store)"><span class="ed-avatar solid"><Icon name="building"/></span><span><strong>{{ store.name }}</strong><small>{{ store.code }} · {{ label(STORE_TYPES,store.type) }}</small></span><span class="ed-pill" :class="{warning:store.status!=='active'}">{{ store.status }}</span></button></aside>
        <div v-if="selectedStore" class="mf-network-detail">
          <header class="ed-section-head"><div><h2>{{ selectedStore.name }}</h2><small>{{ addressLabel(selectedStore.address) }} · {{ selectedStore.timeZone }}</small></div><div class="ed-actions"><button class="ed-btn small" @click="edit('store',selectedStore)"><Icon name="edit"/>Edit store</button><button class="ed-btn small primary" @click="edit('location')"><Icon name="plus"/>Add area</button></div></header>
          <div class="mf-area-grid"><article v-for="location in storeLocations" :key="location.id" class="mf-area-card"><header><span class="ed-avatar"><Icon name="pin"/></span><div><h3>{{ location.name }}</h3><p>{{ location.code }} · {{ label(LOCATION_TYPES,location.type) }}</p></div><button class="ed-icon-button" :aria-label="`Edit ${location.name}`" @click="edit('location',location)"><Icon name="edit"/></button></header><div><span>{{ terminals.filter(item=>item.locationId===location.id).length }} terminals</span><span class="ed-pill" :class="{warning:location.status!=='active'}">{{ location.status }}</span></div></article><button class="mf-area-card mf-area-add" @click="edit('location')"><Icon name="plus"/><strong>Add a work area</strong><span>Front counter, kitchen, stockroom, or office</span></button></div>
        </div>
      </div>
      <div v-else class="ed-empty"><Icon name="building"/><h3>Create the first physical store.</h3><p>A store can be a branch, outlet, kiosk, warehouse, or office.</p><button class="ed-btn primary" @click="edit('store')"><Icon name="plus"/>New store</button></div>
    </template>

    <template v-else-if="tab==='terminals'">
      <div class="ed-section-head"><div><h2>Registered terminals</h2><small>Enrollment proves this browser was paired; last-seen is only its latest report.</small></div><button class="ed-btn primary" :disabled="!locations.length" @click="edit('terminal')"><Icon name="plus"/>New terminal</button></div>
      <div v-if="terminals.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Terminal</th><th>Assignment</th><th>Operator / shift</th><th>Last report</th><th>Status</th><th></th></tr></thead><tbody><tr v-for="terminal in terminals" :key="terminal.id"><td><strong>{{ terminal.name }}</strong><small>{{ terminal.code }} · {{ label(TERMINAL_TYPES,terminal.type) }}</small></td><td>{{ stores.find(item=>item.id===terminal.storeId)?.name || 'Unknown store' }}<small>{{ locations.find(item=>item.id===terminal.locationId)?.name || 'Unknown area' }}</small></td><td>{{ staffName(terminal,shiftFor(terminal)) }}<small>{{ shiftFor(terminal)?'Register open':terminal.currentStaff?'Staff signed in':'No open register' }}</small></td><td><strong>{{ terminalPresence(terminal).label }}</strong><small>{{ terminalPresence(terminal).detail }}</small></td><td><span class="ed-pill" :class="{warning:terminal.status!=='active'}">{{ terminal.status }}</span></td><td><div class="ed-actions"><button class="ed-btn small" @click="edit('terminal',terminal)">Edit</button><button class="ed-btn small" :disabled="busy||!['pending','active'].includes(terminal.status)" @click="createPairing(terminal)">{{ terminal.enrolledAt?'Rotate pairing':'Create pairing code' }}</button></div></td></tr></tbody></table></div>
      <div v-else class="ed-empty"><Icon name="settings"/><h3>No terminals yet.</h3><p>Create a store and area first, then add each POS, kitchen screen, display, or print connector.</p></div>
    </template>

    <template v-else-if="tab==='staff'">
      <div class="ed-section-head"><div><h2>Staff coverage</h2><small>Existing company members retain all-store access. Current operator attribution comes from terminal sessions and register shifts.</small></div><router-link class="ed-btn" to="/users"><Icon name="people"/>Team &amp; Access</router-link></div>
      <div v-if="activeStaff.length" class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Staff member</th><th>Role</th><th>Store scope</th><th>Current terminal</th><th></th></tr></thead><tbody><tr v-for="person in activeStaff" :key="personId(person)"><td><strong>{{ person.username || person.name || person.email }}</strong><small>{{ person.email }}</small></td><td>{{ personRole(person) }}</td><td>{{ assignmentLabel(person) }}<small>{{ assignmentFor(person)?.locationIds?.length?'POS sign-in and clock-in are limited to these areas.':'Backward-compatible unrestricted access.' }}</small></td><td>{{ terminalForPerson(person)?.name || 'Not signed in to a terminal' }}<small v-if="terminalForPerson(person)">{{ stores.find(store=>store.id===terminalForPerson(person).storeId)?.name }} · {{ locations.find(location=>location.id===terminalForPerson(person).locationId)?.name }}</small></td><td><button v-if="canAssignPerson(person)" class="ed-btn small" @click="editStaff(person)">Assign areas</button></td></tr></tbody></table></div><div v-else class="ed-empty"><Icon name="people"/><h3>No active staff assignment.</h3><p>{{ Store.can('usersManage')?'Add the team member to this company before creating their personal POS code.':'Team details require User Administration access.' }}</p></div>
    </template>

    <template v-else>
      <div class="mf-policy-grid"><article class="ed-card"><div class="ed-section-head"><div><h2>Registered terminal enforcement</h2><small>Require every new POS-code session to come from an enrolled browser.</small></div><label class="mf-switch"><input v-model="network.policy.terminalEnforcement" type="checkbox" :disabled="!Store.can('networkPolicyManage')"><span></span></label></div><p>Leave this off until every active till has been created, paired, and accepted. Historical and already-captured receipt recovery remains separate.</p></article><article class="ed-card"><div class="ed-section-head"><div><h2>Open register requirement</h2><small>Require an open register shift before a new POS sale.</small></div><label class="mf-switch"><input v-model="network.policy.requireOpenRegisterForPos" type="checkbox" :disabled="!Store.can('networkPolicyManage')"><span></span></label></div><p>Enable after staff have tested opening float, cash entries, handover, and closing counts on each till.</p></article></div>
      <div class="ed-actions mf-policy-actions"><button class="ed-btn primary" :disabled="busy||!Store.can('networkPolicyManage')" @click="savePolicy">{{ busy?'Saving…':'Save policy' }}</button></div>
    </template>

    <Modal v-if="editor" :title="`${form.id?'Edit':'New'} ${editor}`" :busy="busy" wide @close="closeEditor">
      <div class="ed-form-grid">
        <label class="ed-field"><span>Name</span><input v-model="form.name" required></label>
        <label class="ed-field"><span>Code</span><input v-model="form.code" placeholder="Generated from name"></label>
        <template v-if="editor==='store'">
          <label class="ed-field"><span>Store type</span><select v-model="form.type"><option v-for="option in STORE_TYPES" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label class="ed-field"><span>Status</span><select v-model="form.status"><option value="active">Active</option><option value="suspended">Suspended</option><option value="closed">Closed</option></select></label>
          <label class="ed-field"><span>Time zone</span><input v-model="form.timeZone"></label>
          <label class="ed-field wide"><span>Address</span><textarea v-model="form.address"></textarea></label>
        </template>
        <template v-else>
          <label class="ed-field"><span>Store</span><select v-model="form.storeId" :disabled="terminalRelocationLocked"><option v-for="store in stores" :key="store.id" :value="store.id">{{ store.name }}</option></select></label>
          <label v-if="editor==='location'" class="ed-field"><span>Area type</span><select v-model="form.type"><option v-for="option in LOCATION_TYPES" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <template v-else>
            <label class="ed-field"><span>Work area</span><select v-model="form.locationId" :disabled="terminalRelocationLocked"><option v-for="location in locations.filter(item=>item.storeId===form.storeId)" :key="location.id" :value="location.id">{{ location.name }}</option></select></label>
            <label class="ed-field"><span>Terminal type</span><select v-model="form.type"><option v-for="option in TERMINAL_TYPES" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
            <fieldset class="mf-capabilities wide"><legend>Capabilities</legend><label v-for="capability in TERMINAL_CAPABILITIES" :key="capability.value"><input type="checkbox" :checked="form.capabilities?.includes(capability.value)" @change="toggleCapability(capability.value)">{{ capability.label }}</label></fieldset>
            <p v-if="terminalRelocationLocked" class="ed-notice warning wide"><Icon name="alert"/><span>An enrolled terminal keeps its historical store and area. Create a new terminal to move this screen, then retire this record.</span></p>
          </template>
          <label v-if="editor!=='terminal' || form.id" class="ed-field"><span>{{ editor==='terminal'?'Lifecycle action':'Status' }}</span><select v-model="form.status"><template v-if="editor==='terminal'"><option v-for="option in terminalStatusOptions" :key="option.value" :value="option.value">{{ option.label }}</option></template><template v-else><option value="active">Active</option><option value="suspended">Suspended</option><option value="closed">Closed</option></template></select><small v-if="editor==='terminal'">Pairing is the only way a pending terminal becomes active. Changing an active terminal to another state signs staff out and revokes its pairing.</small></label>
        </template>
      </div>
      <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
      <template #actions><button class="ed-btn" :disabled="busy" @click="closeEditor">Cancel</button><button class="ed-btn primary" :disabled="busy" @click="save">{{ busy?'Saving…':'Save' }}</button></template>
    </Modal>
    <Modal v-if="pairing" title="Pair this terminal" @close="pairing=null"><div class="mf-pairing"><div class="ed-eyebrow">{{ pairing.terminal.name }}</div><strong class="mf-pairing-code">{{ pairing.token }}</strong><p>Open <a class="ed-link" :href="terminalSetupUrl" target="_blank" rel="noopener">{{ terminalSetupUrl }}</a> on the target browser and enter this code. Pairing works only on that canonical company host. The code is single-use and expires {{ new Date(pairing.expiresAt).toLocaleString() }}.</p><div class="ed-notice warning"><Icon name="alert"/><span>This code authorizes terminal enrollment. Share it only with the person setting up that physical screen.</span></div></div><template #actions><button class="ed-btn" @click="pairing=null">Done</button><button class="ed-btn primary" @click="copyPairing"><Icon name="copy"/>{{ copied?'Copied':'Copy code' }}</button></template></Modal>
    <Modal v-if="staffEditor" title="Assign work areas" :busy="busy" wide @close="staffEditor=null"><p><strong>{{ staffEditor.username || staffEditor.name || staffEditor.email }}</strong></p><p class="ed-muted">Select one or more permitted work areas. Leave every area clear to preserve all-store access.</p><div class="mf-staff-scope"><section v-for="store in stores" :key="store.id"><h3>{{ store.name }}</h3><label v-for="location in locations.filter(item=>item.storeId===store.id)" :key="location.id"><input type="checkbox" :checked="staffLocationIds.includes(location.id)" @change="toggleStaffLocation(location.id)"><span><strong>{{ location.name }}</strong><small>{{ label(LOCATION_TYPES,location.type) }}</small></span></label></section></div><p v-if="!staffLocationIds.length" class="ed-notice"><Icon name="info"/><span>This staff member will be allowed to sign in and clock in at every active area in the company.</span></p><p v-if="error" class="ed-notice error">{{ error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="staffEditor=null">Cancel</button><button class="ed-btn primary" :disabled="busy" @click="saveStaffScope">{{ busy?'Saving…':'Save area access' }}</button></template></Modal>
  </section>
</template>
