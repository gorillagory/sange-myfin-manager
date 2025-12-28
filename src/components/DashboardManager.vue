<script setup>
import { ref, computed, onMounted } from 'vue';
import { Store } from '../store';

// ... imports (Keep existing imports)
import OverviewTab from './dashboard/OverviewTab.vue';
import ExpensesTab from './dashboard/ExpensesTab.vue';
import SalesTab from './dashboard/SalesTab.vue';
import ContactsTab from './dashboard/ContactsTab.vue';
import TemplateStudio from './dashboard/TemplateStudio.vue';
import ActivityTab from './dashboard/ActivityTab.vue';
import UserManager from './dashboard/UserManager.vue';
import CompanyManager from './dashboard/CompanyManager.vue';
import ProductsTab from './dashboard/ProductsTab.vue';

const currentTab = ref('overview');
const tempPrefs = ref({ theme: 'light', docTemplate: 'clean' });

const currentUser = computed(() => Store.state.currentUser);
const isSuperUser = computed(() => currentUser.value && currentUser.value.role === 'super');
// NEW: Check if user is Staff
const isStaff = computed(() => currentUser.value && currentUser.value.role === 'company_user');
const activeCompany = computed(() => Store.state.selectedCompany || {});

// ... methods (logout, etc)
function logoutToMenu() { Store.selectCompany(null); }
function fullLogout() { Store.logout(); }
function switchTab(tab) { currentTab.value = tab; }

function saveSettings() { 
    Store.updatePreferences(tempPrefs.value); 
    applyTheme(tempPrefs.value.theme); 
    Store.notify("Settings Saved!"); 
}
function applyTheme(theme) {
    const html = document.documentElement;
    const isDark = theme === 'dark' || (theme === 'auto' && new Date().getHours() >= 19) || (theme === 'auto' && new Date().getHours() < 7);
    if (isDark) html.classList.add('dark'); else html.classList.remove('dark');
}
onMounted(() => { 
    tempPrefs.value = { ...Store.state.preferences }; 
    applyTheme(tempPrefs.value.theme); 
});
</script>

<template>
    <div class="flex flex-col h-screen">
        <nav class="bg-slate-900 text-white px-6 py-3 flex justify-between items-center shadow-lg no-print">
            <div class="flex items-center gap-4">
                <div class="font-bold text-xl text-emerald-400">MyFin <span class="text-white text-sm font-normal opacity-70">| {{ activeCompany.name }}</span></div>
                <button v-if="isSuperUser" @click="logoutToMenu" class="bg-slate-700 hover:bg-slate-600 text-xs px-3 py-1 rounded transition"><i class="fas fa-exchange-alt mr-1"></i> Switch</button>
            </div>
            <div class="flex items-center gap-3">
                <div class="text-right hidden sm:block">
                    <div class="text-xs font-bold text-emerald-500 uppercase">{{ currentUser.role === 'company_user' ? 'Staff' : currentUser.role }}</div>
                    <div class="text-xs opacity-50">{{ currentUser.username }}</div>
                </div>
                <button @click="fullLogout" class="text-red-400 hover:text-red-300 text-xs px-3 py-1 border border-red-900 rounded bg-red-900 bg-opacity-20 transition">Logout</button>
            </div>
        </nav>

        <div class="flex flex-grow overflow-hidden">
            <aside class="w-64 bg-slate-800 text-slate-300 hidden md:flex flex-col no-print border-r border-slate-700">
                <nav class="p-4 space-y-2">
                    <a @click="switchTab('overview')" :class="{'bg-slate-700 text-white': currentTab === 'overview'}" class="block px-4 py-2 rounded cursor-pointer hover:bg-slate-700 transition"><i class="fas fa-chart-pie w-6"></i> Dashboard</a>
                    <a @click="switchTab('contacts')" :class="{'bg-slate-700 text-white': currentTab === 'contacts'}" class="block px-4 py-2 rounded cursor-pointer hover:bg-slate-700 transition"><i class="fas fa-address-book w-6"></i> Contacts</a>
                    
                    <div class="text-xs uppercase font-bold text-slate-500 mt-4 mb-2 px-4">Finance</div>
                    <a @click="switchTab('sales')" :class="{'bg-slate-700 text-white': currentTab === 'sales'}" class="block px-4 py-2 rounded cursor-pointer hover:bg-slate-700 transition"><i class="fas fa-file-invoice-dollar w-6"></i> Sales</a>
                    <a @click="switchTab('expenses')" :class="{'bg-slate-700 text-white': currentTab === 'expenses'}" class="block px-4 py-2 rounded cursor-pointer hover:bg-slate-700 transition"><i class="fas fa-receipt w-6"></i> Expenses</a>
                    <a @click="switchTab('products')" :class="{'bg-slate-700 text-white': currentTab === 'products'}" class="block px-4 py-2 rounded cursor-pointer hover:bg-slate-700 transition"><i class="fas fa-box w-6"></i> Products</a>
                    
                    <div v-if="!isStaff">
                        <div v-if="isSuperUser">
                            <div class="text-xs uppercase font-bold text-slate-500 mt-4 mb-2 px-4">Administration</div>
                            <a @click="switchTab('companies')" :class="{'bg-slate-700 text-white': currentTab === 'companies'}" class="block px-4 py-2 rounded cursor-pointer hover:bg-slate-700 transition"><i class="fas fa-building w-6"></i> Companies</a>
                            <a @click="switchTab('users')" :class="{'bg-slate-700 text-white': currentTab === 'users'}" class="block px-4 py-2 rounded cursor-pointer hover:bg-slate-700 transition"><i class="fas fa-users-cog w-6"></i> Users</a>
                        </div>

                        <div class="h-px bg-slate-700 my-2"></div>
                        <a @click="switchTab('activity')" :class="{'bg-slate-700 text-white': currentTab === 'activity'}" class="block px-4 py-2 rounded cursor-pointer hover:bg-slate-700 transition"><i class="fas fa-shield-alt w-6"></i> Audit Log</a>
                        <a @click="switchTab('settings')" :class="{'bg-slate-700 text-white': currentTab === 'settings'}" class="block px-4 py-2 rounded cursor-pointer hover:bg-slate-700 transition"><i class="fas fa-cog w-6"></i> Settings</a>
                        <a @click="switchTab('templates')" :class="{'bg-slate-700 text-white': currentTab === 'templates'}" class="block px-4 py-2 rounded cursor-pointer hover:bg-slate-700 transition"><i class="fas fa-paint-brush w-6"></i> Templates</a>
                    </div>
                </nav>
            </aside>
            
            <main class="flex-grow p-6 overflow-y-auto bg-gray-100 dark:bg-slate-900 transition-colors duration-300">
                <OverviewTab v-if="currentTab === 'overview'" />
                <ContactsTab v-if="currentTab === 'contacts'" />
                <SalesTab    v-if="currentTab === 'sales'" />
                <ExpensesTab v-if="currentTab === 'expenses'" />
                <ProductsTab v-if="currentTab === 'products'" />
                
                <CompanyManager v-if="currentTab === 'companies' && isSuperUser" />
                <UserManager    v-if="currentTab === 'users' && isSuperUser" />
                
                <ActivityTab v-if="currentTab === 'activity' && !isStaff" />
                <TemplateStudio v-if="currentTab === 'templates' && !isStaff" />

                <div v-if="currentTab === 'settings' && !isStaff" class="no-print max-w-4xl mx-auto">
                    <h2 class="text-3xl font-bold text-slate-800 dark:text-white mb-8 border-b dark:border-slate-700 pb-4">System Preferences</h2>
                     <div class="bg-white dark:bg-slate-800 p-6 rounded-lg shadow-lg border dark:border-slate-700">
                        <h3 class="font-bold text-lg mb-4 dark:text-white"><i class="fas fa-moon text-indigo-500"></i> App Appearance</h3>
                        <div class="space-y-3">
                            <label class="flex items-center gap-3 dark:text-gray-300"><input type="radio" v-model="tempPrefs.theme" value="light"> Light Mode</label>
                            <label class="flex items-center gap-3 dark:text-gray-300"><input type="radio" v-model="tempPrefs.theme" value="dark"> Dark Mode</label>
                            <label class="flex items-center gap-3 dark:text-gray-300"><input type="radio" v-model="tempPrefs.theme" value="auto"> Auto (System)</label>
                        </div>
                     </div>
                     <button @click="saveSettings" class="mt-4 bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2 rounded">Save Preferences</button>
                </div>

            </main>
        </div>
    </div>
</template>