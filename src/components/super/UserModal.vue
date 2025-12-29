<script setup>
import { ref, watch } from 'vue';

const props = defineProps(['show', 'companies', 'user']); // Added 'user' prop
const emit = defineEmits(['close', 'save']);

const form = ref({ username: '', email: '', password: '', role: 'company_admin', company_id: '' });
const isEdit = ref(false);

// Watch for when the modal opens to load data
watch(() => props.show, (val) => {
    if (val) {
        if (props.user) {
            // EDIT MODE
            isEdit.value = true;
            // Clone data, but exclude password (cannot read it back)
            form.value = { 
                id: props.user.id,
                username: props.user.username,
                email: props.user.email,
                role: props.user.role,
                company_id: props.user.company_id
            };
        } else {
            // CREATE MODE
            isEdit.value = false;
            form.value = { username: '', email: '', password: '', role: 'company_admin', company_id: '' };
        }
    }
});

function submit() {
    emit('save', form.value);
}
</script>

<template>
    <div v-if="show" class="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 backdrop-blur-sm">
        <div class="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-md text-white overflow-hidden">
            <div class="p-6 border-b border-slate-700 bg-slate-800">
                <h3 class="font-bold text-xl text-blue-400">{{ isEdit ? 'Edit Operator' : 'Deploy New Operator' }}</h3>
            </div>
            
            <div class="p-8 space-y-4">
                <div>
                    <label class="block text-xs font-bold text-slate-400 uppercase mb-1">Full Name / ID</label>
                    <input v-model="form.username" class="w-full bg-slate-800 border border-slate-600 rounded p-3 outline-none focus:border-blue-500">
                </div>
                <div>
                    <label class="block text-xs font-bold text-slate-400 uppercase mb-1">Email Access</label>
                    <input v-model="form.email" type="email" :disabled="isEdit" class="w-full bg-slate-800 border border-slate-600 rounded p-3 outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed">
                    <p v-if="isEdit" class="text-[10px] text-gray-500 mt-1">Email cannot be changed here.</p>
                </div>
                
                <div v-if="!isEdit">
                    <label class="block text-xs font-bold text-slate-400 uppercase mb-1">Temporary Password</label>
                    <input v-model="form.password" type="password" class="w-full bg-slate-800 border border-slate-600 rounded p-3 outline-none focus:border-blue-500">
                </div>

                <div>
                    <label class="block text-xs font-bold text-slate-400 uppercase mb-1">Assignment</label>
                    <select v-model="form.company_id" class="w-full bg-slate-800 border border-slate-600 rounded p-3 outline-none focus:border-blue-500">
                        <option value="" disabled>Select Company...</option>
                        <option v-for="c in companies" :key="c.id" :value="c.id">{{ c.name }}</option>
                    </select>
                </div>
                 <div>
                    <label class="block text-xs font-bold text-slate-400 uppercase mb-1">Role</label>
                    <select v-model="form.role" class="w-full bg-slate-800 border border-slate-600 rounded p-3 outline-none focus:border-blue-500">
                        <option value="company_user">Staff (Restricted)</option>
                        <option value="company_admin">Manager (Full Access)</option>
                        <option value="super">Super Admin</option>
                    </select>
                </div>
            </div>

            <div class="p-6 border-t border-slate-700 flex justify-end gap-3 bg-slate-800">
                <button @click="$emit('close')" class="text-slate-400 hover:text-white font-bold px-4">Cancel</button>
                <button @click="submit" class="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2 rounded font-bold shadow-lg shadow-blue-900/50 transition">
                    {{ isEdit ? 'Update Profile' : 'Create User' }}
                </button>
            </div>
        </div>
    </div>
</template>