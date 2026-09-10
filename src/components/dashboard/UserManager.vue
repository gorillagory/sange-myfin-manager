<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';

const showUserModal = ref(false);
// Added 'isEditing' state
const isEditing = ref(false);
const userForm = ref({ id: null, username: '', email: '', password: '', role: 'company_user', company_id: null });

// DATA
const allUsers = computed(() => Store.state.users);
const activeCompany = computed(() => Store.state.selectedCompany);
const currentUser = computed(() => Store.state.currentUser);

// Filter users for this company
const displayedUsers = computed(() => {
    if (!activeCompany.value) return [];
    return allUsers.value.filter(u => u.company_id === activeCompany.value.id);
});

// --- ACTIONS ---

function openCreateModal() {
    isEditing.value = false;
    userForm.value = { 
        id: null,
        username: '', 
        email: '', 
        password: '', 
        role: 'company_user', 
        company_id: activeCompany.value.id 
    };
    showUserModal.value = true;
}

function openEditModal(user) {
    isEditing.value = true;
    // Clone user data
    userForm.value = { 
        id: user.id,
        username: user.username, 
        email: user.email, 
        password: '', // Password not needed for edit (handled via reset)
        role: user.role, 
        company_id: user.company_id 
    };
    showUserModal.value = true;
}

async function handleSave() {
    if (!userForm.value.username || !userForm.value.email) {
        return Store.notify("Name and Email required", 'error');
    }

    if (isEditing.value) {
        // UPDATE EXISTING
        await Store.updateUser(userForm.value);
    } else {
        // CREATE NEW
        if (!userForm.value.password) return Store.notify("Password required for new users", 'error');
        await Store.addUser(userForm.value);
    }
    
    showUserModal.value = false;
}

function handleDelete(id) {
    if (confirm("Revoke access for this user? (They will no longer be able to login)")) {
        Store.deleteUser(id);
    }
}

function sendReset() {
    if(confirm(`Send password reset email to ${userForm.value.email}?`)) {
        Store.resetUserPassword(userForm.value.email);
    }
}
</script>

<template>
    <div class="h-full overflow-y-auto p-6">
        
        <div class="flex justify-between items-center mb-8">
            <div>
                <h2 class="text-2xl font-bold text-slate-800 dark:text-white">Staff Directory</h2>
                <p class="text-sm text-gray-500">Managing access for <span class="font-bold text-emerald-600">{{ activeCompany?.name }}</span></p>
            </div>
            <button @click="openCreateModal()" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 shadow-lg transition font-bold flex items-center gap-2">
                <i class="fas fa-user-plus"></i> Recruit Staff
            </button>
        </div>

        <div class="bg-white dark:bg-slate-800 rounded-xl shadow border dark:border-slate-700 overflow-hidden">
            <table class="w-full text-sm text-left text-gray-600 dark:text-gray-300">
                <thead class="bg-gray-100 dark:bg-slate-700 uppercase text-xs font-bold text-gray-500 dark:text-gray-400">
                    <tr>
                        <th class="p-4">Employee</th>
                        <th class="p-4">Position</th>
                        <th class="p-4">Login ID</th>
                        <th class="p-4 text-right">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="u in displayedUsers" :key="u.id" class="border-b dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50 transition">
                        <td class="p-4">
                            <div class="flex items-center gap-3">
                                <div class="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold text-xs uppercase">
                                    {{ u.username.substring(0,2) }}
                                </div>
                                <div class="font-bold text-slate-800 dark:text-white">{{ u.username }}</div>
                            </div>
                        </td>
                        <td class="p-4">
                            <span :class="{
                                'bg-purple-100 text-purple-800': u.role === 'company_admin',
                                'bg-emerald-100 text-emerald-800': u.role === 'company_user'
                            }" class="px-2 py-1 rounded text-xs font-bold uppercase tracking-wide">
                                {{ u.role === 'company_user' ? 'Staff' : 'Manager' }}
                            </span>
                        </td>
                        <td class="p-4 font-mono text-xs">{{ u.email }}</td>
                        <td class="p-4 text-right">
                            <button v-if="u.role !== 'super'" @click="openEditModal(u)" class="text-blue-500 hover:text-blue-700 px-2 transition" title="Edit User">
                                <i class="fas fa-edit"></i>
                            </button>
                            <button v-if="u.role !== 'super' && u.id !== currentUser.id" @click="handleDelete(u.id)" class="text-red-400 hover:text-red-600 px-2 transition" title="Revoke Access">
                                <i class="fas fa-trash-alt"></i>
                            </button>
                        </td>
                    </tr>
                    <tr v-if="displayedUsers.length === 0">
                        <td colspan="4" class="p-10 text-center text-gray-400 italic">
                            <i class="fas fa-users-slash text-4xl mb-2 opacity-30"></i>
                            <p>No staff assigned to this company yet.</p>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div v-if="showUserModal" class="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-[60] backdrop-blur-sm">
            <div class="bg-white dark:bg-slate-800 rounded-xl p-8 w-full max-w-md shadow-2xl border dark:border-slate-600 animate-fade-in">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="font-bold text-xl dark:text-white">{{ isEditing ? 'Edit Profile' : 'New Employee' }}</h3>
                    <button @click="showUserModal = false" class="text-gray-400 hover:text-red-500"><i class="fas fa-times"></i></button>
                </div>

                <div class="space-y-4">
                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Full Name</label>
                        <input v-model="userForm.username" class="w-full border p-3 rounded-lg dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none focus:ring-2 ring-blue-500">
                    </div>

                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Email Address</label>
                        <input v-model="userForm.email" type="email" :disabled="isEditing" class="w-full border p-3 rounded-lg dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none focus:ring-2 ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed">
                        <p v-if="isEditing" class="text-[10px] text-gray-400 mt-1">Email cannot be changed.</p>
                    </div>

                    <div v-if="!isEditing" class="bg-yellow-50 dark:bg-yellow-900/20 p-3 rounded border border-yellow-200 dark:border-yellow-700">
                        <label class="block text-xs font-bold text-yellow-600 dark:text-yellow-500 uppercase mb-1">Set Password</label>
                        <input v-model="userForm.password" type="text" class="w-full border p-2 rounded bg-white dark:bg-slate-800 dark:border-slate-600 dark:text-white font-mono">
                    </div>
                    
                    <div v-if="isEditing" class="bg-blue-50 dark:bg-blue-900/20 p-3 rounded border border-blue-200 dark:border-blue-800">
                        <label class="block text-xs font-bold text-blue-600 dark:text-blue-400 uppercase mb-2">Security</label>
                        <button @click="sendReset" class="text-xs bg-white dark:bg-slate-800 border dark:border-slate-600 px-3 py-2 rounded shadow-sm hover:bg-gray-100 dark:hover:bg-slate-700 w-full font-bold text-slate-600 dark:text-white">
                            <i class="fas fa-envelope mr-1"></i> Send Password Reset Email
                        </button>
                    </div>
                    
                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Role / Permissions</label>
                        <select v-model="userForm.role" class="w-full border p-3 rounded-lg dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none">
                            <option value="company_user">Staff (POS & Orders Only)</option>
                            <option value="company_admin">Manager (Full Company Access)</option>
                        </select>
                    </div>
                </div>

                <div class="flex justify-end gap-3 mt-8">
                    <button @click="handleSave" class="w-full bg-blue-600 text-white py-3 rounded-lg font-bold hover:bg-blue-700 shadow-lg transition">
                        {{ isEditing ? 'Update Profile' : 'Create Account' }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>