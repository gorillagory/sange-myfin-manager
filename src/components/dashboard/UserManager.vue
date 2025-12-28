<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';

const showUserModal = ref(false);
const userForm = ref({ username: '', email: '', password: '', role: 'company_user', company_id: null });

const users = computed(() => Store.state.users);
const companies = computed(() => Store.state.companies);
const currentUser = computed(() => Store.state.currentUser);

function getCompanyName(id) { 
    if (!id) return 'All (Super)';
    const c = companies.value.find(x => x.id === id); 
    return c ? c.name : 'Unknown'; 
}

function openUserModal() {
    userForm.value = { 
        username: '', 
        email: '', 
        password: '', // Only for display/copying
        role: 'company_user', 
        company_id: companies.value.length > 0 ? companies.value[0].id : null 
    };
    showUserModal.value = true;
}

function saveUser() {
    // 1. Validation
    if (!userForm.value.username || !userForm.value.email || !userForm.value.password) {
        return Store.notify("Username, Email, and Password required", 'error');
    }

    // 2. Prepare Data (INCLUDE Password now)
    const newUser = {
        username: userForm.value.username,
        email: userForm.value.email,
        password: userForm.value.password, // <--- We send this to Store now
        role: userForm.value.role,
        company_id: userForm.value.company_id,
        createdAt: new Date().toISOString()
    };
    
    // 3. Save (Store handles the complex Auth logic)
    Store.addUser(newUser);
    
    showUserModal.value = false;
}

function deleteUser(id) {
    if (confirm("Delete this user profile? (You must also delete them from Firebase Auth manually)")) {
        Store.deleteUser(id);
    }
}
</script>

<template>
    <div class="bg-white dark:bg-slate-800 rounded-lg shadow p-6">
        <div class="flex justify-between items-center mb-6">
            <h2 class="text-2xl font-bold text-slate-800 dark:text-white"><i class="fas fa-users-cog mr-2"></i> User Access Control</h2>
            <button @click="openUserModal()" class="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700 shadow transition">
                + Add User
            </button>
        </div>

        <table class="w-full text-sm text-left text-gray-600 dark:text-gray-300">
            <thead class="bg-gray-100 dark:bg-slate-700 uppercase text-xs font-bold">
                <tr>
                    <th class="p-3">User Profile</th>
                    <th class="p-3">Role</th>
                    <th class="p-3">Assigned Company</th>
                    <th class="p-3 text-right">Action</th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="u in users" :key="u.id" class="border-b dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50">
                    <td class="p-3">
                        <div class="font-bold text-slate-800 dark:text-white">{{ u.username }}</div>
                        <div class="text-xs text-gray-500">{{ u.email }}</div>
                    </td>
                    <td class="p-3">
                        <span :class="{
                            'bg-purple-100 text-purple-800': u.role === 'super',
                            'bg-blue-100 text-blue-800': u.role === 'company_admin',
                            'bg-gray-100 text-gray-800': u.role === 'company_user'
                        }" class="px-2 py-1 rounded-full text-xs font-bold uppercase">
                            {{ u.role === 'company_user' ? 'Staff' : (u.role === 'company_admin' ? 'Admin' : 'Super') }}
                        </span>
                    </td>
                    <td class="p-3">{{ getCompanyName(u.company_id) }}</td>
                    <td class="p-3 text-right">
                        <button v-if="u.email !== 'admin@myfin.com' && u.id !== currentUser.id" @click="deleteUser(u.id)" class="text-red-500 hover:text-red-700 px-2">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
                <tr v-if="users.length === 0">
                    <td colspan="4" class="p-4 text-center text-gray-400 italic">No users found.</td>
                </tr>
            </tbody>
        </table>

        <div v-if="showUserModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] backdrop-blur-sm">
            <div class="bg-white dark:bg-slate-800 rounded-xl p-8 w-full max-w-md shadow-2xl border dark:border-slate-600">
                <h3 class="font-bold text-xl mb-6 dark:text-white">Add New User</h3>
                
                <div class="space-y-4">
                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Display Name</label>
                        <input v-model="userForm.username" placeholder="e.g. John Doe" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
                    </div>

                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Email (Login ID)</label>
                        <input v-model="userForm.email" placeholder="john@company.com" type="email" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
                    </div>

                    <div class="bg-yellow-50 dark:bg-yellow-900/20 p-3 rounded border border-yellow-200 dark:border-yellow-700">
                        <label class="block text-xs font-bold text-yellow-600 dark:text-yellow-500 uppercase mb-1">Temporary Password</label>
                        <input v-model="userForm.password" placeholder="Create a password..." type="text" class="w-full border p-2 rounded bg-white dark:bg-slate-800 dark:border-slate-600 dark:text-white font-mono">
                        <p class="text-[10px] text-yellow-600 dark:text-yellow-400 mt-2 leading-tight">
                            <i class="fas fa-info-circle mr-1"></i> 
                            <b>Note:</b> This password is NOT saved automatically. You must copy this and create the user in the Firebase Console manually.
                        </p>
                    </div>
                    
                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Role</label>
                        <select v-model="userForm.role" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white">
                            <option value="company_user">Staff (Restricted)</option>
                            <option value="company_admin">Company Admin (Full Control)</option>
                            <option value="super">Super Admin</option>
                        </select>
                    </div>

                    <div v-if="userForm.role !== 'super'">
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Assign to Company</label>
                        <select v-model="userForm.company_id" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white">
                            <option v-for="c in companies" :value="c.id">{{ c.name }}</option>
                        </select>
                    </div>
                </div>

                <div class="flex justify-end gap-3 mt-8">
                    <button @click="showUserModal = false" class="px-4 py-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700 rounded transition">Cancel</button>
                    <button @click="saveUser" class="bg-blue-600 text-white px-6 py-2 rounded font-bold hover:bg-blue-700 shadow-lg transition">Create Profile</button>
                </div>
            </div>
        </div>
    </div>
</template>