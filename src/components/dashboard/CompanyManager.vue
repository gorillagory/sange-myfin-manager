<script setup>
import { computed, ref } from 'vue';
import { Store } from '../../store';
import { managementError } from '../../domain/management';
import Icon from '../ui/EditionIcon.vue';
import CompanyEditor from '../management/CompanyEditor.vue';
const company = computed(() => Store.state.selectedCompany);
const editor = ref(false), error = ref('');
const managers = computed(() => Store.state.users.filter(user => (user.assignments||[]).some(x=>x.company_id===company.value?.id&&x.role==='manager') && !user.disabled).length);
async function saved() { try { await Store.startListeners(); Store.notify('Company profile updated.'); } catch (failure) { error.value = managementError(failure); } }
</script>
<template>
  <section v-if="company" class="ed-page ed-management">
    <header class="ed-page-head"><div><div class="ed-eyebrow">COMPANY ADMINISTRATION</div><h1>Your company profile.</h1><p>Business details that carry through your workspace and new receipts.</p></div><button class="ed-btn primary" :disabled="!Store.state.online" @click="editor=true"><Icon name="edit"/>Edit company</button></header>
    <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
    <p v-if="!Store.state.online" class="ed-notice warning">You are viewing saved company details. Connect to the internet to make changes.</p>
    <div class="ed-management-profile">
      <div class="ed-management-profile-head"><img v-if="company.logo" :src="company.logo" :alt="company.name" class="ed-management-logo"><span v-else class="ed-avatar solid"><Icon name="building"/></span><div><h2>{{ company.name }}</h2><p class="ed-muted">{{ company.registration || 'Registration not provided' }}</p></div></div>
      <dl class="ed-management-details"><div><dt>Company email</dt><dd>{{ company.email || 'Not provided' }}</dd></div><div><dt>Phone</dt><dd>{{ company.phone || 'Not provided' }}</dd></div><div><dt>Business address</dt><dd>{{ company.address || 'Not provided' }}</dd></div><div><dt>Checkout settings</dt><dd>{{ company.preferences?.currency || 'RM' }} · {{ company.preferences?.taxRate ?? company.preferences?.tax ?? 0 }}% default tax</dd></div><div><dt>Payment QR</dt><dd>{{ company.qrCode || company.qrCodeUrl ? 'Configured' : 'Not configured' }}</dd></div><div><dt>Company managers</dt><dd>{{ managers || 'Managed by workspace owners' }}</dd></div></dl>
      <div class="ed-actions ed-management-space"><router-link class="ed-btn" to="/users"><Icon name="people"/>Manage teammates</router-link><button v-if="Store.state.currentUser?.role === 'super_admin'" class="ed-btn" @click="Store.selectCompany(null)">All workspaces & companies</button></div>
    </div>
    <CompanyEditor v-if="editor" :company="company" @close="editor=false" @saved="saved"/>
  </section>
</template>
