<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';

const activeCompany = computed(() => Store.state.selectedCompany || {});
const clients = computed(() => Store.state.clients.filter(c => c.company_id === activeCompany.value.id));

const clientModal = ref(false);
const clientForm = ref({});
const isEditing = computed(() => !!clientForm.value.id);

function openModal(client = null) {
    if (client) {
        // Edit Mode: Create a copy so we don't edit the table directly until saved
        clientForm.value = JSON.parse(JSON.stringify(client));
    } else {
        // Create Mode: Reset form
        clientForm.value = { 
            id: null, 
            company_id: activeCompany.value.id, 
            name: '', 
            phone: '', 
            type: 'Client' 
        };
    }
    clientModal.value = true;
}

function saveClient() {
    if (!clientForm.value.name) return Store.notify("Name Required", "error");
    
    // Store.addClient uses .set() which creates OR overwrites, so it handles both Add and Edit
    Store.addClient(JSON.parse(JSON.stringify(clientForm.value)));
    
    clientModal.value = false;
    Store.notify(isEditing.value ? "Contact Updated" : "Contact Saved");
}

function deleteClient(id) {
    if (confirm("Delete this contact?")) {
        Store.deleteClient(id);
        Store.notify("Contact Deleted");
    }
}
</script>

<template>
    <div class="no-print">
        <div class="flex justify-between items-center mb-4">
            <h2 class="text-2xl font-bold text-slate-800 dark:text-white">Contacts</h2>
            <button @click="openModal()" class="bg-emerald-600 text-white px-3 py-1 rounded text-sm hover:bg-emerald-700 shadow transition">
                <i class="fas fa-plus mr-2"></i>New Contact
            </button>
        </div>
        
        <div class="bg-white dark:bg-slate-800 shadow rounded overflow-hidden border dark:border-slate-700">
            <table class="w-full text-sm text-left text-gray-600 dark:text-gray-300">
                <thead class="bg-gray-50 dark:bg-slate-700 uppercase text-xs font-bold">
                    <tr>
                        <th class="p-4">Name</th>
                        <th class="p-4">Type</th>
                        <th class="p-4">Phone</th>
                        <th class="p-4 text-right">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="cl in clients" :key="cl.id" class="border-b dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700 transition">
                        <td class="p-4 font-bold">{{ cl.name }}</td>
                        <td class="p-4">
                            <span :class="cl.type === 'Supplier' ? 'bg-orange-100 text-orange-800' : 'bg-blue-100 text-blue-800'" class="px-2 py-1 rounded-full text-xs font-bold">
                                {{ cl.type }}
                            </span>
                        </td>
                        <td class="p-4">{{ cl.phone }}</td>
                        <td class="p-4 text-right">
                            <button @click="openModal(cl)" class="text-blue-500 hover:text-blue-700 mr-3 transition" title="Edit">
                                <i class="fas fa-edit"></i>
                            </button>
                            <button @click="deleteClient(cl.id)" class="text-red-400 hover:text-red-600 transition" title="Delete">
                                <i class="fas fa-trash"></i>
                            </button>
                        </td>
                    </tr>
                    <tr v-if="clients.length === 0">
                        <td colspan="4" class="p-8 text-center text-gray-400 italic">No contacts found. Add one to get started.</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div v-if="clientModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999] backdrop-blur-sm">
             <div class="bg-white dark:bg-slate-800 p-6 rounded-lg w-96 space-y-4 shadow-2xl border dark:border-slate-600 transform transition-all scale-100">
                <h3 class="font-bold dark:text-white text-lg border-b pb-2 dark:border-slate-700">
                    {{ isEditing ? 'Edit' : 'New' }} Contact
                </h3>
                
                <div class="grid grid-cols-2 gap-2">
                    <label class="block p-2 border rounded text-center cursor-pointer transition" :class="clientForm.type === 'Client' ? 'bg-blue-50 border-blue-500 text-blue-800' : 'dark:border-slate-600 dark:text-white hover:bg-gray-50 dark:hover:bg-slate-700'">
                        <input type="radio" v-model="clientForm.type" value="Client" class="hidden"> 
                        <i class="fas fa-user mr-1"></i> Client
                    </label>
                    <label class="block p-2 border rounded text-center cursor-pointer transition" :class="clientForm.type === 'Supplier' ? 'bg-orange-50 border-orange-500 text-orange-800' : 'dark:border-slate-600 dark:text-white hover:bg-gray-50 dark:hover:bg-slate-700'">
                        <input type="radio" v-model="clientForm.type" value="Supplier" class="hidden"> 
                        <i class="fas fa-truck mr-1"></i> Supplier
                    </label>
                </div>

                <div>
                    <label class="block text-xs font-bold text-gray-500 mb-1 uppercase">Name</label>
                    <input v-model="clientForm.name" placeholder="Company or Person Name" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white focus:outline-none focus:border-emerald-500">
                </div>
                
                <div>
                    <label class="block text-xs font-bold text-gray-500 mb-1 uppercase">Phone / Contact</label>
                    <input v-model="clientForm.phone" placeholder="+60..." class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white focus:outline-none focus:border-emerald-500">
                </div>

                <div class="flex justify-end gap-2 pt-2">
                    <button @click="clientModal=false" class="px-4 py-2 rounded text-sm font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700 transition">Cancel</button>
                    <button @click="saveClient" class="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2 rounded text-sm font-bold shadow transition">
                        {{ isEditing ? 'Update' : 'Save' }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>