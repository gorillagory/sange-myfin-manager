<script setup>
import { ref, computed } from 'vue';
import { Store } from '../store';

const companies = computed(() => Store.state.companies);
const showCreate = ref(false);
const newCo = ref({ name: '', address1: '', phone: '', email: '' });

function select(co) { Store.selectCompany(co); }
function logout() { Store.logout(); }

function createCompany() {
    if (!newCo.value.name) return alert("Name Required");
    const co = { id: Date.now(), ...newCo.value, logo: null };
    if (!Store.state.companies) Store.state.companies = [];
    Store.state.companies.push(co);
    Store.selectCompany(co);
}
</script>

<template>
    <div class="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6">
        <div class="w-full max-w-4xl flex justify-between items-center mb-8 text-white">
            <h1 class="text-2xl font-bold">Select Workspace</h1>
            <button @click="logout" class="text-sm text-gray-400 hover:text-white">Logout</button>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 w-full max-w-4xl">
            <div v-for="co in companies" :key="co.id" @click="select(co)" class="bg-slate-800 p-6 rounded-xl border border-slate-700 hover:border-emerald-500 cursor-pointer transition hover:shadow-xl">
                <h3 class="font-bold text-white text-lg">{{ co.name }}</h3>
                <p class="text-gray-500 text-sm mt-1 truncate">{{ co.address1 || 'No address' }}</p>
            </div>
            <button @click="showCreate = true" class="bg-slate-800/50 border-2 border-dashed border-slate-700 p-6 rounded-xl text-gray-500 hover:text-white hover:border-emerald-500">
                <span class="font-bold">+ Create New</span>
            </button>
        </div>

        <div v-if="showCreate" class="fixed inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm">
            <div class="bg-white dark:bg-slate-800 p-8 rounded-xl w-full max-w-md border border-slate-600">
                <h2 class="text-2xl font-bold text-white mb-6">New Business</h2>
                <input v-model="newCo.name" placeholder="Company Name" class="w-full bg-slate-900 border border-slate-600 rounded p-3 text-white mb-4">
                <div class="flex justify-end gap-3">
                    <button @click="showCreate = false" class="px-4 py-2 text-gray-400 hover:text-white">Cancel</button>
                    <button @click="createCompany" class="px-6 py-2 bg-emerald-600 text-white font-bold rounded">Launch</button>
                </div>
            </div>
        </div>
    </div>
</template>