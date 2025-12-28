<script setup>
import { ref, computed } from 'vue';
import { Store } from '../../store';
import jsQR from 'jsqr';
import QRCode from 'qrcode';

const showModal = ref(false);
const isEdit = ref(false);

const companyForm = ref({ 
    id: null, 
    name: '', 
    registration: '', 
    address: '', 
    phone: '', 
    email: '', 
    logo: null, 
    qrCode: null, 
    preferences: { currency: 'RM', tax: 0 } 
});

const companies = computed(() => Store.state.companies);
const currentUser = computed(() => Store.state.currentUser);

// --- ACTIONS ---
function openAddModal() {
    isEdit.value = false;
    companyForm.value = { id: null, name: '', registration: '', address: '', phone: '', email: '', logo: null, qrCode: null, preferences: { currency: 'RM', tax: 0 } };
    showModal.value = true;
}

function openEditModal(company) {
    isEdit.value = true;
    companyForm.value = JSON.parse(JSON.stringify(company));
    if (!companyForm.value.preferences) companyForm.value.preferences = { currency: 'RM', tax: 0 };
    showModal.value = true;
}

// --- NEW: INTELLIGENT UPLOAD HANDLER ---
function handleFileUpload(event, field) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    
    reader.onload = (e) => {
        // A. If it's the LOGO, just save it directly
        if (field === 'logo') {
            companyForm.value.logo = e.target.result;
            return;
        }

        // B. If it's the QR CODE, try to "Read & Regenerate"
        if (field === 'qrCode') {
            const img = new Image();
            img.onload = () => {
                // 1. Draw image to invisible canvas to read pixels
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                canvas.width = img.width;
                canvas.height = img.height;
                context.drawImage(img, 0, 0);
                
                const imageData = context.getImageData(0, 0, img.width, img.height);
                
                // 2. Scan for QR Code
                const code = jsQR(imageData.data, img.width, img.height);
                
                if (code) {
                    // 3. SUCCESS: Found data! Regenerate a clean version
                    QRCode.toDataURL(code.data, { width: 400, margin: 2, color: { dark: '#000000', light: '#ffffff' } }, (err, url) => {
                        if (!err) {
                            companyForm.value.qrCode = url;
                            Store.notify("QR Code detected & optimized!", "success");
                        } else {
                            // Fallback if generation fails
                            companyForm.value.qrCode = e.target.result; 
                        }
                    });
                } else {
                    // 4. FAIL: No QR found (maybe low qual), keep original
                    companyForm.value.qrCode = e.target.result;
                    Store.notify("QR not detected. Using original image.", "warning");
                }
            };
            img.src = e.target.result;
        }
    };
    reader.readAsDataURL(file);
}

async function saveCompany() {
    if (!companyForm.value.name) return Store.notify("Company Name is required", "error");
    if (isEdit.value) await Store.updateCompany(companyForm.value);
    else await Store.addCompany(companyForm.value);
    showModal.value = false;
    Store.notify(isEdit.value ? "Company Updated" : "Company Created");
}

async function deleteCompany(id) {
    if (confirm("Are you sure?")) {
        await Store.deleteCompany(id);
        Store.notify("Company Deleted");
    }
}
</script>

<template>
    <div class="h-full overflow-y-auto p-6">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h2 class="text-2xl font-bold text-slate-800 dark:text-white">Company Management</h2>
                <p class="text-gray-500 text-sm">Manage your business entities and settings.</p>
            </div>
            <button v-if="currentUser?.role === 'super'" @click="openAddModal" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-bold shadow transition flex items-center gap-2">
                <i class="fas fa-plus"></i> New Company
            </button>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div v-for="c in companies" :key="c.id" class="bg-white dark:bg-slate-800 rounded-xl shadow border dark:border-slate-700 overflow-hidden hover:shadow-lg transition group">
                <div class="h-32 bg-gray-100 dark:bg-slate-700 flex items-center justify-center relative">
                    <img v-if="c.logo" :src="c.logo" class="h-24 object-contain">
                    <div v-else class="text-gray-400 text-4xl"><i class="fas fa-building"></i></div>
                    <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                        <button @click="openEditModal(c)" class="bg-white text-slate-800 px-3 py-1 rounded-full text-sm font-bold shadow hover:bg-gray-50">Edit Settings</button>
                    </div>
                </div>
                <div class="p-5">
                    <h3 class="font-bold text-lg text-slate-800 dark:text-white mb-1">{{ c.name }}</h3>
                    <p class="text-xs text-gray-500 uppercase font-bold mb-4">{{ c.registration || 'No Reg. ID' }}</p>
                    <div class="space-y-2 text-sm text-gray-600 dark:text-gray-300">
                        <div class="flex items-start gap-2"><i class="fas fa-map-marker-alt mt-1 text-gray-400"></i><span class="line-clamp-2">{{ c.address || 'No Address' }}</span></div>
                        <div class="flex items-center gap-2"><i class="fas fa-envelope text-gray-400"></i><span class="truncate">{{ c.email || 'No Email' }}</span></div>
                        <div class="flex items-center gap-2"><i class="fas fa-qrcode text-gray-400"></i><span :class="c.qrCode ? 'text-emerald-600 font-bold' : 'text-gray-400'">{{ c.qrCode ? 'DuitNow QR Active' : 'No QR Setup' }}</span></div>
                    </div>
                </div>
            </div>
            <div v-if="companies.length === 0" class="col-span-full text-center py-20 text-gray-400"><i class="fas fa-city text-6xl mb-4 opacity-50"></i><p>No companies found. Create one to get started.</p></div>
        </div>

        <div v-if="showModal" class="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 backdrop-blur-sm">
            <div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-2xl h-[90vh] overflow-hidden flex flex-col">
                <div class="p-6 border-b dark:border-slate-700 flex justify-between items-center bg-gray-50 dark:bg-slate-900"><h3 class="font-bold text-xl text-slate-800 dark:text-white">{{ isEdit ? 'Edit Company' : 'New Company' }}</h3><button @click="showModal = false" class="text-gray-400 hover:text-red-500 text-xl"><i class="fas fa-times"></i></button></div>
                <div class="flex-grow overflow-y-auto p-8 space-y-6">
                    <div class="grid grid-cols-2 gap-4">
                        <div class="col-span-2"><label class="block text-xs font-bold text-gray-500 uppercase mb-1">Company Name</label><input v-model="companyForm.name" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"></div>
                        <div><label class="block text-xs font-bold text-gray-500 uppercase mb-1">Registration No.</label><input v-model="companyForm.registration" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none"></div>
                        <div><label class="block text-xs font-bold text-gray-500 uppercase mb-1">Phone</label><input v-model="companyForm.phone" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none"></div>
                    </div>

                    <div class="grid grid-cols-2 gap-6 bg-gray-50 dark:bg-slate-900 p-4 rounded-lg border dark:border-slate-700">
                        <div>
                            <label class="block text-xs font-bold text-gray-500 uppercase mb-2">Company Logo</label>
                            <div class="flex items-center gap-3">
                                <div class="h-16 w-16 border rounded bg-white flex items-center justify-center overflow-hidden"><img v-if="companyForm.logo" :src="companyForm.logo" class="h-full w-full object-contain"><i v-else class="fas fa-image text-gray-300"></i></div>
                                <label class="cursor-pointer bg-white dark:bg-slate-700 border dark:border-slate-600 hover:bg-gray-100 px-3 py-1 rounded text-xs font-bold shadow-sm">Change<input type="file" accept="image/*" class="hidden" @change="(e) => handleFileUpload(e, 'logo')"></label>
                            </div>
                        </div>

                        <div>
                            <label class="block text-xs font-bold text-gray-500 uppercase mb-2 text-emerald-600">DuitNow QR Image</label>
                            <div class="flex items-center gap-3">
                                <div class="h-16 w-16 border rounded bg-white flex items-center justify-center overflow-hidden relative group">
                                    <img v-if="companyForm.qrCode" :src="companyForm.qrCode" class="h-full w-full object-cover">
                                    <i v-else class="fas fa-qrcode text-gray-300"></i>
                                    <button v-if="companyForm.qrCode" @click="companyForm.qrCode = null" class="absolute inset-0 bg-black bg-opacity-50 text-white opacity-0 group-hover:opacity-100 flex items-center justify-center transition"><i class="fas fa-trash"></i></button>
                                </div>
                                <label class="cursor-pointer bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100 px-3 py-1 rounded text-xs font-bold shadow-sm text-emerald-700 dark:text-emerald-400">
                                    Upload Screenshot
                                    <input type="file" accept="image/*" class="hidden" @change="(e) => handleFileUpload(e, 'qrCode')">
                                </label>
                            </div>
                            <p class="text-[10px] text-gray-400 mt-2"><b>Auto-Crop:</b> Upload full bank screenshot; we will extract the QR automatically.</p>
                        </div>
                    </div>

                    <div><label class="block text-xs font-bold text-gray-500 uppercase mb-1">Email</label><input v-model="companyForm.email" type="email" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none"></div>
                    <div><label class="block text-xs font-bold text-gray-500 uppercase mb-1">Address</label><textarea v-model="companyForm.address" rows="3" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none"></textarea></div>
                    <div class="grid grid-cols-2 gap-4 border-t pt-4 dark:border-slate-700">
                        <div><label class="block text-xs font-bold text-gray-500 uppercase mb-1">Currency Symbol</label><input v-model="companyForm.preferences.currency" placeholder="e.g. RM" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none font-bold"></div>
                        <div><label class="block text-xs font-bold text-gray-500 uppercase mb-1">Default Tax (%)</label><input v-model="companyForm.preferences.tax" type="number" class="w-full border p-2 rounded dark:bg-slate-700 dark:border-slate-600 dark:text-white outline-none"></div>
                    </div>
                </div>
                <div class="p-6 bg-gray-50 dark:bg-slate-900 border-t dark:border-slate-700 flex justify-between">
                    <button v-if="isEdit" @click="deleteCompany(companyForm.id)" class="text-red-500 font-bold text-sm hover:underline">Delete Company</button><div v-else></div>
                    <div class="flex gap-3"><button @click="showModal = false" class="px-4 py-2 text-gray-500 font-bold hover:bg-gray-200 rounded transition">Cancel</button><button @click="saveCompany" class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded font-bold shadow-lg transition">Save Details</button></div>
                </div>
            </div>
        </div>
    </div>
</template>