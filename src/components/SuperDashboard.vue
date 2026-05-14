<script setup>
import { ref, computed } from 'vue';
import { Store } from '../store';
import CompanyModal from './super/CompanyModal.vue';
import UserModal from './super/UserModal.vue';
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
    if (editingUser.value) await Store.updateUser(data);
    else await Store.addUser(data);
    showUserModal.value = false;
}

function enterCompany(c) { Store.selectCompany(c); }
</script>

<template>
    <div class="min-h-screen bg-slate-900 text-white font-sans flex flex-col lg:flex-row">
        
        <div class="flex-grow p-6 sm:p-10 overflow-y-auto">
            <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 sm:mb-12 gap-4">
                <div>
                    <h1 class="text-3xl sm:text-4xl font-bold text-emerald-400 tracking-tight">COMMAND CENTER</h1>
                    <p class="text-slate-400 mt-2">Overseer: <span class="text-white font-bold">{{ currentUser?.username }}</span></p>
                </div>
                <div class="flex flex-wrap gap-2 sm:gap-4 items-center w-full sm:w-auto">
                    <button @click="showProfileModal = true" class="text-slate-400 hover:text-white font-bold mr-0 sm:mr-2 transition flex-1 sm:flex-none text-left sm:text-center">
                        <i class="fas fa-user-circle mr-2"></i> Profile
                    </button>
                    
                    <button @click="openCreateCompany" class="bg-emerald-600 hover:bg-emerald-500 text-white px-4 sm:px-6 py-2 sm:py-3 rounded-lg font-bold shadow-lg shadow-emerald-900/40 transition flex items-center justify-center gap-2 flex-1 sm:flex-none">
                        <i class="fas fa-rocket"></i> Launch Entity
                    </button>
                    <button @click="Store.logout()" class="border border-slate-600 hover:bg-slate-800 text-slate-400 px-3 sm:px-4 py-2 sm:py-3 rounded-lg font-bold transition">Sign Out</button>
                </div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6 mb-8 sm:mb-12">
                <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700/50 shadow-xl relative overflow-hidden group">
                    <div class="absolute right-0 top-0 p-4 opacity-10 group-hover:opacity-20 transition transform group-hover:scale-110"><i class="fas fa-building text-6xl sm:text-8xl"></i></div>
                    <div class="text-slate-400 text-xs font-bold uppercase tracking-wider mb-2">Active Entities</div>
                    <div class="text-4xl font-bold">{{ companies.length }}</div>
                </div>
                <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700/50 shadow-xl relative overflow-hidden group">
                     <div class="absolute right-0 top-0 p-4 opacity-10 group-hover:opacity-20 transition transform group-hover:scale-110"><i class="fas fa-users text-6xl sm:text-8xl"></i></div>
                    <div class="text-slate-400 text-xs font-bold uppercase tracking-wider mb-2">Total Operators</div>
                    <div class="text-4xl font-bold">{{ users.length }}</div>
                </div>
                <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700/50 shadow-xl sm:col-span-2 lg:col-span-1">
                    <div class="text-slate-400 text-xs font-bold uppercase tracking-wider mb-2">System Health</div>
                    <div class="text-4xl font-bold text-emerald-400 flex items-center gap-2"><div class="w-3 h-3 bg-emerald-400 rounded-full animate-pulse"></div> Online</div>
                </div>
            </div>

            <h2 class="text-xl sm:text-2xl font-bold mb-6 text-slate-200">Conglomerate Overview</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                <div v-for="c in companies" :key="c.id" class="bg-slate-800 rounded-xl overflow-hidden border border-slate-700 hover:border-emerald-500/50 hover:shadow-2xl transition group relative">
                    <div class="h-40 bg-slate-700/30 flex items-center justify-center p-6 relative">
                        <img v-if="c.logo" :src="c.logo" class="h-full object-contain filter grayscale group-hover:grayscale-0 transition duration-500 drop-shadow-lg">
                        <i v-else class="fas fa-building text-5xl text-slate-600 group-hover:text-white transition"></i>
                        <button @click.stop="openEditCompany(c)" class="absolute top-4 right-4 bg-slate-900/80 hover:bg-blue-600 text-white w-8 h-8 rounded-full flex items-center justify-center lg:opacity-0 group-hover:opacity-100 transition shadow-lg"><i class="fas fa-cog text-xs"></i></button>
                    </div>
                    <div class="p-6">
                        <div class="flex justify-between items-start mb-4">
                            <div>
                                <h3 class="font-bold text-xl leading-tight">{{ c.name }}</h3>
                                <div class="text-xs text-slate-500 font-mono mt-1">{{ c.preferences?.currency || 'RM' }} • Tax {{ c.preferences?.tax || 0 }}%</div>
                            </div>
                            <div v-if="c.qrCode" class="text-emerald-400" title="QR Payment Ready"><i class="fas fa-qrcode"></i></div>
                        </div>
                        <button @click="enterCompany(c)" class="w-full bg-slate-700 hover:bg-emerald-600 text-white py-3 rounded-lg font-bold transition flex justify-center items-center gap-2 lg:group-hover:translate-y-0 lg:translate-y-0">
                            ENTER CONSOLE <i class="fas fa-arrow-right opacity-50 group-hover:opacity-100 transition"></i>
                        </button>
                    </div>
                </div>
                <button v-if="companies.length === 0" @click="openCreateCompany" class="border-2 border-dashed border-slate-700 rounded-xl flex flex-col items-center justify-center text-slate-500 hover:text-emerald-400 hover:border-emerald-500/50 transition h-64">
                    <i class="fas fa-plus-circle text-4xl mb-4"></i>
                    <span class="font-bold">Initialize First Company</span>
                </button>
            </div>
        </div>

        <div class="w-full lg:w-80 bg-slate-800 border-t lg:border-t-0 lg:border-l border-slate-700 flex flex-col h-[50vh] lg:h-auto">
            <div class="p-6 border-b border-slate-700 flex justify-between items-center bg-slate-800">
                <h3 class="font-bold text-slate-300">Operators</h3>
                <button @click="openCreateUser" class="text-blue-400 hover:text-blue-300 text-sm font-bold uppercase"><i class="fas fa-plus mr-1"></i> Add</button>
            </div>
            
            <div class="flex-grow overflow-y-auto p-4 space-y-3">
                <div v-for="u in users" :key="u.id" class="bg-slate-900 p-4 rounded-lg border border-slate-700 flex items-start gap-3 group">
                    <div class="w-8 h-8 rounded-full bg-blue-900 text-blue-400 flex items-center justify-center font-bold text-xs shrink-0">
                        {{ u.username.substring(0,2).toUpperCase() }}
                    </div>
                    <div class="min-w-0 flex-grow">
                        <div class="font-bold text-sm truncate">{{ u.username }}</div>
                        <div class="text-xs text-slate-500 truncate">{{ u.email }}</div>
                        <div class="mt-2 text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-slate-800 inline-block text-slate-400">
                            {{ companies.find(c => c.id === u.company_id)?.name || 'Unassigned' }}
                        </div>
                    </div>
                    <div class="flex lg:flex-col gap-3 lg:gap-2 lg:opacity-0 group-hover:opacity-100 transition items-center">
                         <button @click="openEditUser(u)" class="text-slate-600 hover:text-blue-400"><i class="fas fa-edit"></i></button>
                         <button @click="Store.deleteUser(u.id)" class="text-slate-600 hover:text-red-500"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            </div>
        </div>

        <CompanyModal :show="showCoModal" :company="editingCompany" @close="showCoModal=false" @save="handleSaveCompany" />
        <UserModal :show="showUserModal" :companies="companies" :user="editingUser" @close="showUserModal=false" @save="handleSaveUser" />
        
        <div v-if="showProfileModal" class="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-[100] backdrop-blur-sm p-4">
            <div class="bg-slate-900 w-full max-w-2xl rounded-xl overflow-hidden relative border border-slate-700 shadow-2xl">
                <button @click="showProfileModal = false" class="absolute top-4 right-4 text-slate-400 hover:text-white z-10"><i class="fas fa-times text-2xl"></i></button>
                <div class="max-h-[85vh] overflow-y-auto">
                    <UserProfile />
                </div>
            </div>
        </div>

    </div>
</template>