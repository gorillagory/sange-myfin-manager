<script setup>
import { ref, computed } from 'vue';
import { Store } from '../store';
import CompanyModal from './super/CompanyModal.vue';
import UserModal from './super/UserModal.vue';
import Icon from './ui/EditionIcon.vue';
import Modal from './ui/EditionModal.vue';
import UserProfile from './dashboard/UserProfile.vue';

const companies = computed(() => Store.state.companies);
const users = computed(() => Store.state.users);
const currentUser = computed(() => Store.state.currentUser);

// Modal States
const showCoModal = ref(false);
const showUserModal = ref(false);
const showProfileModal = ref(false);

const editingCompany = ref(null);
const editingUser = ref(null);

// --- COMPANY ACTIONS ---
function openCreateCompany() { editingCompany.value = null; showCoModal.value = true; }
function openEditCompany(c) { editingCompany.value = c; showCoModal.value = true; }

async function handleSaveCompany(data) {
    if (editingCompany.value) await Store.updateCompany({ id: editingCompany.value.id, ...data });
    else await Store.addCompany(data);
    showCoModal.value = false;
}

// --- USER ACTIONS ---
function openCreateUser() { editingUser.value = null; showUserModal.value = true; }

function openEditUser(u) {
    editingUser.value = u;
    showUserModal.value = true;
}

async function handleSaveUser(data) {
    if (editingUser.value) { if (!await Store.updateUser(data)) return; }
    else if (!await Store.addUser(data)) return;
    showUserModal.value = false;
}

function enterCompany(c) { Store.selectCompany(c); }
</script>

<template><div class="edition-app" style="min-height:100dvh"><header class="ed-topbar"><div class="ed-brand"><span class="ed-brandmark"><i></i><i></i><i></i><i></i></span>myfin<small>edition</small></div><div class="ed-actions"><button class="ed-btn" @click="showProfileModal=true">My profile</button><button class="ed-icon-button" aria-label="Sign out" @click="Store.logout()"><Icon name="logout"/></button></div></header><main class="ed-main" style="max-width:1400px"><header class="ed-page-head"><div><div class="ed-eyebrow">YOUR WORKSPACES</div><h1>A place for every business.</h1><p>Welcome back, {{ currentUser?.username }}. Choose a store to get to work.</p></div><button class="ed-btn primary" @click="openCreateCompany"><Icon name="plus"/>Add company</button></header><div class="ed-two-col" style="grid-template-columns:minmax(0,1fr) 290px"><section><div class="ed-section-head"><h2>Your companies</h2><span class="ed-muted">{{ companies.length }} workspaces</span></div><div class="ed-company-grid"><article v-for="c in companies" :key="c.id" class="ed-company-tile"><div class="ed-actions" style="justify-content:space-between"><img v-if="c.logo" :src="c.logo" :alt="c.name" style="height:48px;max-width:110px;object-fit:contain"><span v-else class="ed-avatar solid"><Icon name="box"/></span><button class="ed-icon-button" :aria-label="'Edit '+c.name" @click="openEditCompany(c)"><Icon name="settings"/></button></div><h2>{{ c.name }}</h2><p>{{ c.registration || 'Company workspace' }}</p><div class="ed-row"><span class="ed-muted">{{ c.preferences?.currency||'RM' }} · Tax {{ c.preferences?.taxRate??c.preferences?.tax??0 }}%</span><button class="ed-link" @click="enterCompany(c)">Open store<Icon name="arrow"/></button></div></article></div><div v-if="!companies.length" class="ed-empty"><h3>Your first workspace starts here.</h3><button class="ed-link" @click="openCreateCompany">Add your company</button></div></section><aside class="ed-side-section"><div class="ed-section-head"><h2>Your people</h2><button class="ed-link" @click="openCreateUser"><Icon name="plus"/>Add</button></div><div v-for="u in users" :key="u.id" class="ed-row"><span class="ed-avatar">{{ (u.username||'').slice(0,2).toUpperCase() }}</span><div style="flex:1"><strong>{{ u.username }}</strong><small>{{ companies.find(c=>c.id===u.company_id)?.name || 'Workspace administrator' }}</small></div><button class="ed-icon-button" :aria-label="'Edit '+u.username" @click="openEditUser(u)"><Icon name="edit"/></button></div></aside></div><footer class="ed-footer"><span>MYFIN / EDITION</span><span>Your connected business workspace</span></footer></main><div class="ed-legacy"><CompanyModal :show="showCoModal" :company="editingCompany" @close="showCoModal=false" @save="handleSaveCompany"/><UserModal :show="showUserModal" :companies="companies" :user="editingUser" @close="showUserModal=false" @save="handleSaveUser"/></div><Modal v-if="showProfileModal" title="Your profile" wide @close="showProfileModal=false"><div class="ed-legacy"><UserProfile/></div></Modal></div></template>
