<script setup>
import { ref, watch } from 'vue';
import jsQR from 'jsqr';
import QRCode from 'qrcode';

const props = defineProps(['show', 'company']);
const emit = defineEmits(['close', 'save']);

const form = ref({});
const isEdit = ref(false);

watch(() => props.show, (val) => {
    if (val) {
        // Clone or Reset
        if (props.company) {
            form.value = JSON.parse(JSON.stringify(props.company));
            isEdit.value = true;
        } else {
            form.value = { name: '', registration: '', address: '', email: '', logo: null, qrCode: null, preferences: { currency: 'RM', tax: 0 } };
            isEdit.value = false;
        }
    }
});

// --- IMAGE ENGINE (Reused) ---
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
                resolve(canvas.toDataURL(isLogo ? 'image/jpeg' : 'image/png', 0.8));
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
        form.value.logo = await processImage(file, true);
    } else if (field === 'qrCode') {
        // QR Logic
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const cvs = document.createElement('canvas');
                const ctx = cvs.getContext('2d');
                cvs.width = img.width; cvs.height = img.height;
                ctx.drawImage(img, 0, 0);
                const code = jsQR(ctx.getImageData(0,0,img.width,img.height).data, img.width, img.height);
                if(code) {
                    QRCode.toDataURL(code.data, {width:400, margin:1}, (err, url) => !err ? form.value.qrCode = url : null);
                } else {
                    processImage(file).then(u => form.value.qrCode = u);
                }
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }
}
</script>

<template>
    <div v-if="show" class="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 backdrop-blur-sm">
        <div class="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-2xl text-white overflow-hidden">
            <div class="p-6 border-b border-slate-700 flex justify-between items-center bg-slate-800">
                <h3 class="font-bold text-xl text-emerald-400">{{ isEdit ? 'Edit Entity' : 'Launch New Entity' }}</h3>
                <button @click="$emit('close')" class="text-slate-400 hover:text-white"><i class="fas fa-times"></i></button>
            </div>
            
            <div class="p-8 space-y-6 max-h-[70vh] overflow-y-auto">
                <div class="grid grid-cols-2 gap-4">
                    <div class="col-span-2">
                        <label class="block text-xs font-bold text-slate-400 uppercase mb-1">Entity Name</label>
                        <input v-model="form.name" class="w-full bg-slate-800 border border-slate-600 rounded p-3 focus:border-emerald-500 outline-none text-white font-bold">
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-slate-400 uppercase mb-1">Reg. No</label>
                        <input v-model="form.registration" class="w-full bg-slate-800 border border-slate-600 rounded p-3 outline-none">
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-slate-400 uppercase mb-1">Currency</label>
                        <input v-model="form.preferences.currency" class="w-full bg-slate-800 border border-slate-600 rounded p-3 outline-none font-mono text-yellow-400">
                    </div>
                </div>

                <div class="grid grid-cols-2 gap-6 bg-slate-800 p-4 rounded border border-slate-700">
                    <div>
                        <div class="text-xs font-bold text-slate-400 uppercase mb-2">Brand Logo</div>
                        <label class="cursor-pointer block h-20 border border-dashed border-slate-600 rounded hover:bg-slate-700 flex items-center justify-center relative overflow-hidden group">
                            <img v-if="form.logo" :src="form.logo" class="h-full object-contain">
                            <span v-else class="text-slate-500 text-xs">Click to Upload</span>
                            <input type="file" class="hidden" accept="image/*" @change="e=>handleFileUpload(e,'logo')">
                        </label>
                    </div>
                    <div>
                        <div class="text-xs font-bold text-slate-400 uppercase mb-2">DuitNow QR</div>
                        <label class="cursor-pointer block h-20 border border-dashed border-slate-600 rounded hover:bg-slate-700 flex items-center justify-center relative overflow-hidden group">
                            <img v-if="form.qrCode" :src="form.qrCode" class="h-full object-contain">
                            <span v-else class="text-slate-500 text-xs">Upload Screenshot</span>
                            <input type="file" class="hidden" accept="image/*" @change="e=>handleFileUpload(e,'qrCode')">
                        </label>
                    </div>
                </div>
            </div>

            <div class="p-6 border-t border-slate-700 flex justify-end gap-3 bg-slate-800">
                <button @click="$emit('save', form)" class="bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2 rounded font-bold shadow-lg shadow-emerald-900/50 transition">
                    {{ isEdit ? 'Update Systems' : 'Launch System' }}
                </button>
            </div>
        </div>
    </div>
</template>