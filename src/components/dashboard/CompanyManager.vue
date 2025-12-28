<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';

const showModal = ref(false);
const isEditing = ref(false);
const form = ref(getEmptyForm());

const companies = computed(() => Store.state.companies);

function getEmptyForm() {
    return {
        id: null,
        systemId: 'CMP-' + Math.floor(Math.random() * 10000),
        name: '', regNo: '', phone: '',
        address1: '', postcode: '', state: 'Selangor', country: 'Malaysia',
        bankName: 'Maybank', accNo: '', logo: null
    };
}

function openModal(company = null) {
    isEditing.value = !!company;
    form.value = company ? JSON.parse(JSON.stringify(company)) : getEmptyForm();
    showModal.value = true;
}

function save() {
    if (!form.value.name) return alert("Company Name Required");
    
    if (isEditing.value) Store.updateCompany(form.value);
    else Store.addCompany(form.value);
    
    showModal.value = false;
}

function remove(id) {
    if (confirm("Delete this company and all its data?")) Store.deleteCompany(id);
}

function select(company) {
    Store.selectCompany(company);
}

function handleLogo(e) {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (res) => { form.value.logo = res.target.result; };
        reader.readAsDataURL(file);
    }
}
</script>

<template>
    <div class="w-full">
        <div class="flex justify-between items-center mb-8">
            <h1 class="text-3xl font-bold text-slate-800 dark:text-white">Company<span class="text-emerald-500">List</span></h1>
            <button @click="openModal()" class="bg-slate-800 dark:bg-emerald-600 text-white px-6 py-2 rounded shadow hover:bg-slate-700">
                <i class="fas fa-plus mr-2"></i>New Company
            </button>
        </div>
        
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div v-for="c in companies" :key="c.id" class="bg-white dark:bg-slate-800 rounded-lg shadow hover:shadow-xl transition overflow-hidden group border dark:border-slate-700">
                <div class="h-32 bg-slate-100 dark:bg-slate-900 flex items-center justify-center relative">
                    <img v-if="c.logo" :src="c.logo" class="h-24 object-contain">
                    <div v-else class="text-3xl text-slate-300"><i class="fas fa-building"></i></div>
                    <div class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition">
                        <button @click.stop="openModal(c)" class="bg-blue-500 text-white p-1.5 rounded text-xs"><i class="fas fa-edit"></i></button>
                        <button @click.stop="remove(c.id)" class="bg-red-500 text-white p-1.5 rounded text-xs ml-1"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
                <div class="p-5">
                    <h3 class="font-bold text-lg text-slate-800 dark:text-white">{{ c.name }}</h3>
                    <button @click="select(c)" class="w-full bg-emerald-600 text-white py-2 rounded hover:bg-emerald-700 font-bold text-sm mt-4">Manage</button>
                </div>
            </div>
        </div>

        <div v-if="showModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
            <div class="bg-white dark:bg-slate-800 rounded w-full max-w-xl p-6">
                <h2 class="text-xl font-bold mb-4 dark:text-white">{{ isEditing ? 'Edit' : 'Create' }} Company</h2>
                <div class="grid grid-cols-2 gap-4">
                     <div class="col-span-2 border border-dashed p-2 text-center bg-gray-50 dark:bg-slate-900 rounded">
                        <input type="file" @change="handleLogo" class="text-sm dark:text-gray-400">
                    </div>
                    <input v-model="form.name" placeholder="Company Name" class="border p-2 rounded col-span-2 dark:bg-slate-700 dark:border-slate-600 dark:text-white">
                    <input v-model="form.regNo" placeholder="Reg No" class="border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white">
                    <textarea v-model="form.address1" placeholder="Address" class="border p-2 rounded col-span-2 dark:bg-slate-700 dark:border-slate-600 dark:text-white"></textarea>
                </div>
                <div class="flex justify-end gap-2 mt-4">
                    <button @click="showModal = false" class="bg-gray-200 dark:bg-slate-700 dark:text-white px-4 py-2 rounded">Cancel</button>
                    <button @click="save" class="bg-emerald-600 text-white px-4 py-2 rounded">Save</button>
                </div>
            </div>
        </div>
    </div>
</template>