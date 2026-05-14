<script setup>
import { ref, onMounted } from 'vue';
import { Store } from '../../store';

const tempPrefs = ref({ theme: 'light', docTemplate: 'clean' });

function applyTheme(theme) {
    const html = document.documentElement;
    const isDark = theme === 'dark' || (theme === 'auto' && new Date().getHours() >= 19) || (theme === 'auto' && new Date().getHours() < 7);
    if (isDark) html.classList.add('dark');
    else html.classList.remove('dark');
}

function saveSettings() { 
    Store.updatePreferences(tempPrefs.value); 
    applyTheme(tempPrefs.value.theme);
    Store.notify("Settings Saved!"); 
}

onMounted(() => { 
    if(Store.state.preferences) {
        tempPrefs.value = { ...Store.state.preferences }; 
    }
});
</script>

<template>
    <div class="no-print max-w-4xl mx-auto">
        <h2 class="text-3xl font-bold text-slate-800 dark:text-white mb-8 border-b dark:border-slate-700 pb-4">System Preferences</h2>
        
        <div class="bg-white dark:bg-slate-800 p-6 rounded-lg shadow-lg border dark:border-slate-700">
            <h3 class="font-bold text-lg mb-4 dark:text-white">
                <i class="fas fa-moon text-indigo-500 mr-2"></i> App Appearance
            </h3>
            <div class="space-y-3">
                <label class="flex items-center gap-3 dark:text-gray-300">
                    <input type="radio" v-model="tempPrefs.theme" value="light" class="accent-emerald-500"> Light Mode
                </label>
                <label class="flex items-center gap-3 dark:text-gray-300">
                    <input type="radio" v-model="tempPrefs.theme" value="dark" class="accent-emerald-500"> Dark Mode
                </label>
                <label class="flex items-center gap-3 dark:text-gray-300">
                    <input type="radio" v-model="tempPrefs.theme" value="auto" class="accent-emerald-500"> Auto (System)
                </label>
            </div>
        </div>
        
        <button @click="saveSettings" class="mt-6 bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2 rounded font-bold shadow transition">
            Save Preferences
        </button>
    </div>
</template>