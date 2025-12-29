<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';

const currentUser = computed(() => Store.state.currentUser);
const form = ref({
    username: currentUser.value?.username || '',
    password: '',
    confirmPassword: ''
});

async function save() {
    if (form.value.password && form.value.password !== form.value.confirmPassword) {
        return Store.notify("Passwords do not match", "error");
    }

    const success = await Store.updateSelf({
        username: form.value.username,
        password: form.value.password || null
    });

    if (success) {
        form.value.password = '';
        form.value.confirmPassword = '';
    }
}
</script>

<template>
    <div class="max-w-2xl mx-auto bg-white dark:bg-slate-800 rounded-xl shadow border dark:border-slate-700 p-8 mt-10">
        <h2 class="text-2xl font-bold text-slate-800 dark:text-white mb-6">My Profile</h2>

        <div class="flex items-center gap-6 mb-8 pb-8 border-b dark:border-slate-700">
            <div class="w-20 h-20 rounded-full bg-blue-600 text-white flex items-center justify-center text-2xl font-bold">
                {{ currentUser?.username?.substring(0,2).toUpperCase() }}
            </div>
            <div>
                <div class="font-bold text-lg dark:text-white">{{ currentUser?.username }}</div>
                <div class="text-gray-500">{{ currentUser?.email }}</div>
                <span class="inline-block mt-2 px-2 py-1 bg-gray-100 dark:bg-slate-700 rounded text-xs font-bold uppercase">
                    {{ currentUser?.role.replace('_', ' ') }}
                </span>
            </div>
        </div>

        <div class="space-y-6">
            <div>
                <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Display Name</label>
                <input v-model="form.username" class="w-full border p-3 rounded dark:bg-slate-900 dark:border-slate-600 dark:text-white outline-none focus:ring-2 ring-blue-500">
            </div>

            <div class="bg-yellow-50 dark:bg-yellow-900/10 p-4 rounded border border-yellow-200 dark:border-yellow-800/50">
                <h3 class="font-bold text-yellow-700 dark:text-yellow-500 mb-4 text-sm uppercase">Change Password</h3>
                <div class="space-y-4">
                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">New Password</label>
                        <input v-model="form.password" type="password" placeholder="Leave empty to keep current" class="w-full border p-3 rounded bg-white dark:bg-slate-900 dark:border-slate-600 dark:text-white outline-none focus:ring-2 ring-yellow-500">
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Confirm New Password</label>
                        <input v-model="form.confirmPassword" type="password" class="w-full border p-3 rounded bg-white dark:bg-slate-900 dark:border-slate-600 dark:text-white outline-none focus:ring-2 ring-yellow-500">
                    </div>
                </div>
            </div>
        </div>

        <div class="mt-8 flex justify-end">
            <button @click="save" class="bg-emerald-600 hover:bg-emerald-700 text-white px-8 py-3 rounded-lg font-bold shadow-lg transition">
                Save Changes
            </button>
        </div>
    </div>
</template>