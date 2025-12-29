<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { Store } from '../../store';
import jsQR from 'jsqr';
import QRCode from 'qrcode';

// We only care about the Active Company now
const activeCompany = computed(() => Store.state.selectedCompany);
const currentUser = computed(() => Store.state.currentUser);

const showModal = ref(false);

const companyForm = ref({ 
    id: null, name: '', registration: '', address: '', phone: '', email: '', logo: null, qrCode: null, 
    preferences: { currency: 'RM', tax: 0 } 
});

// Load the active company data into the form modal when needed
function prepareEdit() {
    if (!activeCompany.value) return;
    companyForm.value = JSON.parse(JSON.stringify(activeCompany.value));
    if (!companyForm.value.preferences) companyForm.value.preferences = { currency: 'RM', tax: 0 };
    showModal.value = true;
}

// --- IMAGE ENGINE ---
function processImage(file, isLogo = false) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const MAX_SIZE = 400;
                let w = img.width, h = img.height;
                if (w > h) { if (w > MAX_SIZE) { h *= MAX_SIZE / w; w = MAX_SIZE; } } 
                else { if (h > MAX_SIZE) { w *= MAX_SIZE / h; h = MAX_SIZE; } }
                canvas.width = w; canvas.height = h;
                ctx.drawImage(img, 0, 0, w, h);
                const outputFormat = isLogo ? 'image/jpeg' : 'image/png';
                resolve(canvas.toDataURL(outputFormat, 0.8));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

async function handleFileUpload(event, field) {
    const file = event.target.files[0];
    if (!file) return;

    if (field === 'logo') {
        try {
            companyForm.value.logo = await processImage(file, true);
            Store.notify("Logo optimized!");
        } catch (e) { Store.notify("Error processing logo", "error"); }
    }

    if (field === 'qrCode') {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const cvs = document.createElement('canvas');
                const ctx = cvs.getContext('2d');
                cvs.width = img.width; cvs.height = img.height;
                ctx.drawImage(img, 0, 0);
                const code = jsQR(ctx.getImageData(0, 0, img.width, img.height).data, img.width, img.height);
                if (code) {
                    QRCode.toDataURL(code.data, { width: 400, margin: 1 }, (err, url) => {
                        if (!err) { companyForm.value.qrCode = url; Store.notify("QR Code extracted!"); }
                        else processImage(file).then(res => companyForm.value.qrCode = res);
                    });
                } else {
                    processImage(file).then(res => { companyForm.value.qrCode = res; Store.notify("Using optimized image.", "warning"); });
                }
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }
}

async function saveCompany() {
    if (!companyForm.value.name) return Store.notify("Name required", "error");
    if (companyForm.value.logo && companyForm.value.logo.length > 800000) return Store.notify("Logo too big", "error");

    try {
        await Store.updateCompany(companyForm.value);
        showModal.value = false;
        Store.notify("Company Profile Updated");
    } catch (e) { Store.notify("Save failed: " + e.message, "error"); }
}

async function deleteCompany() {
    // Only Super Admin should see the button to invoke this
    if (confirm("WARNING: This will delete the company and access for all its staff. Continue?")) { 
        await Store.deleteCompany(activeCompany.value.id); 
        Store.notify("Company Deleted");
        // Logic to redirect Super Admin back to HQ is handled by store listener reacting to deletion
    }
}
</script>

<template>
    <div class="h-full overflow-y-auto p-6">
        
        <div class="flex justify-between items-center mb-8">
            <div>
                <h2 class="text-2xl font-bold text-slate-800 dark:text-white">Settings & Configuration</h2>
                <p class="text-gray-500 text-sm">Manage profile for <span class="font-bold text-emerald-600">{{ activeCompany?.name }}</span></p>
            </div>
            </div>

        <div class="max-w-4xl mx-auto bg-white dark:bg-slate-800 rounded-xl shadow border dark:border-slate-700 p-8">
             
             <div class="text-center py-6 border-b dark:border-slate-700 mb-6">
                 <div class="mb-4 relative inline-block group">
                     <div class="h-32 w-32 mx-auto rounded-full bg-gray-100 dark:bg-slate-700 flex items-center justify-center overflow-hidden border-4 border-white dark:border-slate-600 shadow-lg">
                         <img v-if="activeCompany?.logo" :src="activeCompany.logo" class="h-full w-full object-contain">
                         <i v-else class="fas fa-building text-4xl text-gray-300"></i>
                     </div>
                 </div>
                 
                 <h3 class="text-3xl font-bold text-slate-800 dark:text-white mb-2">{{ activeCompany?.name }}</h3>
                 <p class="text-gray-500 font-mono text-sm bg-gray-100 dark:bg-slate-900 inline-block px-3 py-1 rounded">Reg: {{ activeCompany?.registration || 'N/A' }}</p>
             </div>

             <div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                 <div>
                     <h4 class="font-bold text-gray-400 text-xs uppercase mb-4 border-b dark:border-slate-700 pb-2">Contact Details</h4>
                     <div class="space-y-4">
                         <div class="flex gap-3">
                             <div class="w-8 text-center"><i class="fas fa-map-marker-alt text-gray-400"></i></div>
                             <div class="text-slate-700 dark:text-gray-300 text-sm">{{ activeCompany?.address || 'No Address Provided' }}</div>
                         </div>
                         <div class="flex gap-3">
                             <div class="w-8 text-center"><i class="fas fa-phone text-gray-400"></i></div>
                             <div class="text-slate-700 dark:text-gray-300 text-sm">{{ activeCompany?.phone || 'No Phone' }}</div>
                         </div>
                         <div class="flex gap-3">
                             <div class="w-8 text-center"><i class="fas fa-envelope text-gray-400"></i></div>
                             <div class="text-slate-700 dark:text-gray-300 text-sm">{{ activeCompany?.email || 'No Email' }}</div>
                         </div>
                     </div>
                 </div>

                 <div>
                     <h4 class="font-bold text-gray-400 text-xs uppercase mb-4 border-b dark:border-slate-700 pb-2">Financial Settings</h4>
                     <div class="space-y-4">
                         <div class="flex gap-3 items-center">
                             <div class="w-8 text-center"><i class="fas fa-coins text-gray-400"></i></div>
                             <div class="text-slate-700 dark:text-gray-300 text-sm">Currency: <span class="font-bold">{{ activeCompany?.preferences?.currency || 'RM' }}</span></div>
                         </div>
                         <div class="flex gap-3 items-center">
                             <div class="w-8 text-center"><i class="fas fa-percent text-gray-400"></i></div>
                             <div class="text-slate-700 dark:text-gray-300 text-sm">Tax Rate: <span class="font-bold">{{ activeCompany?.preferences?.tax || 0 }}%</span></div>
                         </div>
                         <div class="flex gap-3 items-start">
                             <div class="w-8 text-center"><i class="fas fa-qrcode text-gray-400"></i></div>
                             <div>
                                 <div class="text-slate-700 dark:text-gray-300 text-sm mb-1">DuitNow QR:</div>
                                 <span v-if="activeCompany?.qrCode" class="text-emerald-600 font-bold text-xs"><i class="fas fa-check-circle mr-1"></i> Active</span>
                                 <span v-else class="text-gray-400 text-xs">Not Configured</span>
                             </div>
                         </div>
                     </div>
                 </div>
             </div>

             <div class="flex justify-center">
                 <button @click="prepareEdit" class="bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-lg font-bold shadow-lg transition flex items-center gap-2">
                     <i class="fas fa-edit"></i> Edit Configuration
                 </button>
             </div>
        </div>

        <div v-if="showModal" class="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 backdrop-blur-sm">
            <div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-2xl h-[90vh] overflow-hidden flex flex-col">
                <div class="p-6 border-b dark:border-slate-700 flex justify-between items-center bg-gray-50 dark:bg-slate-900"><h3 class="font-bold text-xl text-slate-800 dark:text-white">Edit Company</h3><button @click="showModal = false" class="text-gray-400 hover:text-red-500 text-xl"><i class="fas fa-times"></i></button></div>
                
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
                                <label class="cursor-pointer bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100 px-3 py-1 rounded text-xs font-bold shadow-sm text-emerald-700 dark:text-emerald-400">Upload Screenshot<input type="file" accept="image/*" class="hidden" @change="(e) => handleFileUpload(e, 'qrCode')"></label>
                            </div>
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
                    <button v-if="currentUser.role === 'super'" @click="deleteCompany" class="text-red-500 font-bold text-sm hover:underline">Delete Company</button>
                    <div v-else></div>
                    <div class="flex gap-3"><button @click="showModal = false" class="px-4 py-2 text-gray-500 font-bold hover:bg-gray-200 rounded transition">Cancel</button><button @click="saveCompany" class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded font-bold shadow-lg transition">Save Details</button></div>
                </div>
            </div>
        </div>
    </div>
</template>