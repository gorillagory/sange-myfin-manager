<script setup>
import { ref } from 'vue';
import { Store } from '../store';

const username = ref('');
const password = ref('');
const loading = ref(false);

function handleLogin() {
    loading.value = true;
    setTimeout(() => {
        const success = Store.login(username.value, password.value);
        if (!success) loading.value = false;
    }, 500);
}
</script>

<template>
    <div class="bg-white dark:bg-slate-800 p-8 rounded-2xl shadow-2xl w-full max-w-md border border-slate-700">
        <div class="text-center mb-8">
            <div class="h-16 w-16 bg-emerald-500 rounded-xl mx-auto flex items-center justify-center text-3xl text-white shadow-lg mb-4">
                <i class="fas fa-cube"></i>
            </div>
            <h1 class="text-3xl font-bold text-slate-800 dark:text-white">MyFin Cloud</h1>
            <p class="text-gray-500 mt-2">Sign in to manage your business</p>
        </div>

        <form @submit.prevent="handleLogin" class="space-y-6">
            <div>
                <label class="block text-xs font-bold text-gray-500 uppercase mb-2">Username or Email</label>
                <input v-model="username" type="text" placeholder="admin@myfin.com or username" class="w-full p-3 rounded bg-slate-100 dark:bg-slate-900 border dark:border-slate-600 dark:text-white focus:ring-2 focus:ring-emerald-500 outline-none transition">
            </div>
            
            <div>
                <label class="block text-xs font-bold text-gray-500 uppercase mb-2">Password</label>
                <input v-model="password" type="password" placeholder="••••••••" class="w-full p-3 rounded bg-slate-100 dark:bg-slate-900 border dark:border-slate-600 dark:text-white focus:ring-2 focus:ring-emerald-500 outline-none transition">
            </div>

            <button type="submit" :disabled="loading" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-lg transition transform hover:scale-[1.02] flex justify-center items-center gap-2">
                <i v-if="loading" class="fas fa-circle-notch fa-spin"></i>
                <span>{{ loading ? 'Signing in...' : 'Sign In' }}</span>
            </button>
        </form>
    </div>
</template>