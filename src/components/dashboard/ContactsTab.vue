<script setup>
import { computed, ref } from 'vue';
import { Store } from '../../store';
import Modal from '../ui/EditionModal.vue';
import RegisteredCustomerProfiles from './RegisteredCustomerProfiles.vue';
import { validEmail } from '../../domain/inventoryCsv';
import { canCreateDirectoryContact, canManageDirectoryContact, contactKind, contactTabsFor, filterDirectoryContacts } from '../../domain/contactDirectory';

const search = ref(''), tab = ref('customers'), form = ref(null), busy = ref(false), deleting = ref(null), error = ref(''), registeredCount = ref(0);
const permissions = computed(() => Store.permissions());
const tabs = computed(() => [...contactTabsFor(permissions.value), ...((permissions.value.owner || permissions.value.manager) ? [{ id:'registered', label:'Registered profiles' }] : [])]);
const contacts = computed(() => filterDirectoryContacts(Store.state.clients, { tab:tab.value, query:search.value }));
const customerCount = computed(() => Store.state.clients.filter(contact => contactKind(contact) === 'customers').length);
const supplierCount = computed(() => Store.state.clients.filter(contact => contactKind(contact) === 'suppliers').length);
const canCreate = computed(() => tab.value !== 'registered' && canCreateDirectoryContact(permissions.value, tab.value));
const activeLabel = computed(() => tab.value === 'suppliers' ? 'supplier' : tab.value === 'registered' ? 'registered customer' : 'customer');

function canManage(contact) {
  return canManageDirectoryContact(permissions.value, contact);
}

function focusTab(index, event) {
  tab.value = tabs.value[index].id;
  event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[index]?.focus();
}

function moveTab(offset, event) {
  const current = tabs.value.findIndex(item => item.id === tab.value);
  focusTab((current + offset + tabs.value.length) % tabs.value.length, event);
}

function edit(contact = null) {
  if (contact ? !canManage(contact) : !canCreate.value) return;
  form.value = contact ? JSON.parse(JSON.stringify(contact)) : {
    name: '', email: '', phone: '', registration: '', address: '', notes: '',
    type: tab.value === 'suppliers' ? 'Supplier' : 'Customer',
  };
  form.value.type = contactKind(form.value) === 'suppliers' ? 'Supplier' : 'Customer';
  error.value = '';
}

async function save() {
  if (busy.value) return;
  error.value = '';
  try {
    if (form.value.id ? !canManage(form.value) : !canCreateDirectoryContact(permissions.value, contactKind(form.value)))
      throw new Error(`You cannot save this ${contactKind(form.value) === 'suppliers' ? 'supplier' : 'customer'}.`);
    form.value.name = form.value.name.trim();
    form.value.email = (form.value.email || '').trim();
    if (!form.value.name) throw new Error('Name is required.');
    if (!validEmail(form.value.email)) throw new Error('Enter a valid email address.');
    busy.value = true;
    await Store.addClient(form.value);
    form.value = null;
    Store.notify(`${activeLabel.value[0].toUpperCase() + activeLabel.value.slice(1)} saved.`);
  } catch (saveError) {
    error.value = saveError.message;
  } finally {
    busy.value = false;
  }
}

async function remove() {
  if (busy.value || !canManage(deleting.value)) return;
  busy.value = true;
  try {
    await Store.deleteClient(deleting.value.id);
    deleting.value = null;
    Store.notify('Contact deleted.');
  } catch (removeError) {
    Store.notify(removeError.message, 'error');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="ed-page">
    <header class="ed-page-head">
      <div><div class="ed-eyebrow">ADMINISTRATION / CONTACTS</div><h1>Customers and suppliers.</h1><p>Keep sales contacts and purchasing relationships clearly separated.</p></div>
      <button v-if="canCreate" class="ed-btn primary" @click="edit()">+ New {{ activeLabel }}</button>
    </header>
    <div class="ed-tabs" role="tablist" aria-label="Contact directory type">
      <button v-for="item in tabs" :id="`contact-tab-${item.id}`" :key="item.id" role="tab" :class="{active:tab===item.id}" :aria-controls="`contact-panel-${item.id}`" :aria-selected="tab===item.id" :tabindex="tab===item.id ? 0 : -1" @click="tab=item.id" @keydown.left.prevent="moveTab(-1,$event)" @keydown.right.prevent="moveTab(1,$event)" @keydown.home.prevent="focusTab(0,$event)" @keydown.end.prevent="focusTab(tabs.length-1,$event)">
        {{ item.label }} <span class="ed-tab-count">{{ item.id === 'suppliers' ? supplierCount : item.id === 'registered' ? registeredCount : customerCount }}</span>
      </button>
    </div>
    <RegisteredCustomerProfiles v-if="tab==='registered'" :id="`contact-panel-${tab}`" role="tabpanel" :aria-labelledby="`contact-tab-${tab}`" @count="registeredCount=$event" />
    <section v-else :id="`contact-panel-${tab}`" role="tabpanel" :aria-labelledby="`contact-tab-${tab}`">
      <div class="ed-filters ed-contact-filters">
        <input v-model="search" class="ed-input" :aria-label="`Search ${activeLabel}s`" :placeholder="`Search ${activeLabel} name, phone, email or registration`">
        <span class="ed-muted">{{ contacts.length }} {{ contacts.length === 1 ? activeLabel : activeLabel + 's' }}</span>
      </div>
      <div class="ed-table-wrap"><table class="ed-table">
        <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Registration</th><th>Actions</th></tr></thead>
        <tbody><tr v-for="contact in contacts" :key="contact.id">
          <td><strong>{{ contact.name }}</strong><small v-if="contact.address">{{ contact.address }}</small></td><td>{{ contact.email || '—' }}</td><td>{{ contact.phone || '—' }}</td><td>{{ contact.registration || '—' }}</td>
          <td><div v-if="canManage(contact)" class="ed-actions"><button class="ed-btn" :aria-label="`Edit ${contact.name}`" @click="edit(contact)">Edit</button><button class="ed-btn danger" :aria-label="`Delete ${contact.name}`" @click="deleting=contact">Delete</button></div><span v-else class="ed-muted">View only</span></td>
        </tr><tr v-if="!contacts.length"><td colspan="5" class="ed-empty">No matching {{ activeLabel }}s.</td></tr></tbody>
      </table></div>
    </section>
    <Modal v-if="form" :title="form.id ? `Edit ${activeLabel}` : `New ${activeLabel}`" :busy="busy" @close="form=null">
      <form id="contact-editor" @submit.prevent="save"><fieldset :disabled="busy" class="ed-form-grid">
        <div class="ed-notice wide"><div><strong>{{ form.type === 'Supplier' ? 'Supplier record' : 'Customer record' }}</strong>{{ form.type === 'Supplier' ? 'Available for purchasing and expense links.' : 'Available at checkout and on sales documents.' }}</div></div>
        <label class="ed-field wide"><span>{{ form.type === 'Supplier' ? 'Supplier / business name' : 'Customer name' }} *</span><input v-model="form.name" required maxlength="120" autocomplete="organization"></label>
        <label class="ed-field wide"><span>Email</span><input v-model.trim="form.email" type="email" maxlength="254" autocomplete="email" inputmode="email"></label>
        <label class="ed-field"><span>Phone</span><input v-model="form.phone" type="tel" maxlength="500" autocomplete="tel"></label>
        <label class="ed-field"><span>Registration / reference</span><input v-model="form.registration" maxlength="500"></label>
        <label class="ed-field wide"><span>Address</span><textarea v-model="form.address" maxlength="500" rows="3" autocomplete="street-address"></textarea></label>
        <label class="ed-field wide"><span>Notes</span><textarea v-model="form.notes" maxlength="500" rows="3"></textarea></label>
      </fieldset><p v-if="error" role="alert" class="ed-alert">{{ error }}</p></form>
      <template #actions><button class="ed-btn" :disabled="busy" @click="form=null">Cancel</button><button class="ed-btn primary" form="contact-editor" type="submit" :disabled="busy">{{ busy ? 'Saving…' : `Save ${activeLabel}` }}</button></template>
    </Modal>
    <Modal v-if="deleting" :title="`Delete ${contactKind(deleting)==='suppliers' ? 'supplier' : 'customer'}?`" :busy="busy" @close="deleting=null">
      <p>Delete {{ deleting.name }} from this company directory?</p>
      <template #actions><button class="ed-btn" :disabled="busy" @click="deleting=null">Keep contact</button><button class="ed-btn danger" :disabled="busy" @click="remove">Delete contact</button></template>
    </Modal>
  </div>
</template>
