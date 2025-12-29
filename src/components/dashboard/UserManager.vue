<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';

const showUserModal = ref(false);
const userForm = ref({ username: '', email: '', password: '', role: 'company_user', company_id: null });

// DATA
const allUsers = computed(() => Store.state.users);
const activeCompany = computed(() => Store.state.selectedCompany);
const currentUser = computed(() => Store.state.currentUser);

// --- CRITICAL FIX: FILTERING ---
// If Super Admin, 'allUsers' might contain everyone. We must filter for the current view.
const displayedUsers = computed(() => {
    if (!activeCompany.value) return [];
    return allUsers.value.filter(u => u.company_id === activeCompany.value.id);
});

function openUserModal() {
    // Lock the ID to the current company
    userForm.value = { 
        username: '', 
        email: '', 
        password: '', 
        role: 'company_user', 
        company_id: activeCompany.value.id 
    };
    showUserModal.value = true;
}

function saveUser() {
    if (!userForm.value.username || !userForm.value.email || !userForm.value.password) {
        return Store.notify("All fields required", 'error');
    }
    
    // Double Check: Ensure company_id is locked
    const newUser = {
        ...userForm.value,
        company_id: activeCompany.value.id 
    };
    
    Store.addUser(newUser);
    showUserModal.value = false;
}

function deleteUser(id) {
    if (confirm("Remove this user from the company?")) Store.deleteUser(id);
}
</script>

<template>
    <div class="h-full overflow-y-auto p-6">
        
        <div class="flex justify-between items-center mb-8">
            <div>
                <h2 class="text-2xl font-bold text-slate-800 dark:text-white">Staff Directory</h2>
                <p class="text-sm text-gray-500">Managing access for <span class="font-bold text-emerald-600">{{ activeCompany?.name }}</span></p>
            </div>
            <button @click="openUserModal()" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 shadow-lg transition font-bold flex items-center gap-2">
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
                                <div class="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold text-xs">
                                    {{ u.username.substring(0,2).toUpperCase() }}
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
                            <button v-if="u.role !== 'super' && u.id !== currentUser.id" @click="deleteUser(u.id)" class="text-red-400 hover:text-red-600 px-2 transition" title="Remove User">
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
                    <h3 class="font-bold text-xl dark:text-white">New Employee</h3>
                    <button @click="showUserModal = false" class="text-gray-400 hover:text-red-500"><i class="fas fa-times"></i></button>
                </div>
                
                <div class="space-y-4">
                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Full Name</label>
                        <input v-model="userForm.username" class="w-full border p-3 rounded-lg dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none focus:ring-2 ring-blue-500">
                    </div>

                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Email Address</label>
                        <input v-model="userForm.email" type="email" class="w-full border p-3 rounded-lg dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none focus:ring-2 ring-blue-500">
                    </div>

                    <div class="bg-yellow-50 dark:bg-yellow-900/20 p-3 rounded border border-yellow-200 dark:border-yellow-700">
                        <label class="block text-xs font-bold text-yellow-600 dark:text-yellow-500 uppercase mb-1">Set Password</label>
                        <input v-model="userForm.password" type="text" class="w-full border p-2 rounded bg-white dark:bg-slate-800 dark:border-slate-600 dark:text-white font-mono">
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
                    <button @click="saveUser" class="w-full bg-blue-600 text-white py-3 rounded-lg font-bold hover:bg-blue-700 shadow-lg transition">Create Profile</button>
                </div>
            </div>
        </div>
    </div>
</template>