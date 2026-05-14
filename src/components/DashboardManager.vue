<script setup>
import { ref, computed, onMounted } from 'vue';
import { Store } from '../store';

const currentUser = computed(() => Store.state.currentUser);
const activeCompany = computed(() => Store.state.selectedCompany || {});

// Mobile Menu State
const mobileMenuOpen = ref(false);

// PERMISSIONS
const isSuperUser = computed(() => currentUser.value && currentUser.value.role === 'super');
const isAdmin = computed(() => ['super', 'company_admin'].includes(currentUser.value?.role));

function logoutToMenu() { Store.selectCompany(null); }
function fullLogout() { Store.logout(); }
function closeMobileMenu() { mobileMenuOpen.value = false; }

function applyTheme(theme) {
    const html = document.documentElement;
    const isDark = theme === 'dark' || (theme === 'auto' && new Date().getHours() >= 19) ||
    (theme === 'auto' && new Date().getHours() < 7);
    if (isDark) html.classList.add('dark');
    else html.classList.remove('dark');
}

onMounted(() => { 
    if(Store.state.preferences) {
        applyTheme(Store.state.preferences.theme || 'light'); 
    }
});
</script>

<template>
    <div class="flex flex-col h-screen overflow-hidden">
        
        <transition name="fade">
            <div v-if="mobileMenuOpen" @click="closeMobileMenu" class="fixed inset-0 bg-black/60 z-[90] md:hidden backdrop-blur-sm"></div>
        </transition>

        <nav class="bg-slate-900 text-white px-4 sm:px-6 py-3 flex justify-between items-center shadow-lg no-print flex-shrink-0 relative z-[80]">
            <div class="flex items-center gap-3">
                <button @click="mobileMenuOpen = !mobileMenuOpen" class="md:hidden text-slate-300 hover:text-white p-1">
                    <i class="fas fa-bars text-xl"></i>
                </button>

                <div class="font-bold text-lg sm:text-xl text-emerald-400 truncate max-w-[150px] sm:max-w-xs">
                    MyFin <span class="text-white text-xs sm:text-sm font-normal opacity-70 hidden sm:inline">| {{ activeCompany.name }}</span>
                </div>
                
                <button v-if="isSuperUser" @click="logoutToMenu" class="bg-slate-700 hover:bg-slate-600 text-[10px] sm:text-xs px-2 py-1 rounded transition whitespace-nowrap">
                    <i class="fas fa-exchange-alt sm:mr-1"></i> <span class="hidden sm:inline">Switch</span>
                </button>
            </div>
            <div class="flex items-center gap-3">
                <div class="text-right hidden sm:block">
                    <div class="text-xs font-bold text-emerald-500 uppercase">{{ currentUser?.role === 'company_user' ? 'Staff' : currentUser?.role }}</div>
                    <div class="text-xs opacity-50">{{ currentUser?.username }}</div>
                </div>
                <button @click="fullLogout" class="text-red-400 hover:text-red-300 text-xs px-3 py-1.5 border border-red-900 rounded bg-red-900 bg-opacity-20 transition whitespace-nowrap">Logout</button>
            </div>
        </nav>

        <div class="flex flex-grow overflow-hidden relative">
            
            <aside 
                :class="mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'"
                class="absolute md:relative z-[100] md:z-0 w-64 h-full bg-slate-800 text-slate-300 flex flex-col no-print border-r border-slate-700 transition-transform duration-300 ease-in-out md:translate-x-0">
                
                <div class="p-4 flex justify-between items-center md:hidden border-b border-slate-700">
                    <span class="font-bold text-white truncate">{{ activeCompany.name }}</span>
                    <button @click="closeMobileMenu" class="text-slate-400 hover:text-white"><i class="fas fa-times text-xl"></i></button>
                </div>

                <nav class="p-4 space-y-2 flex-grow overflow-y-auto">
                    
                    <router-link to="/overview" @click="closeMobileMenu" class="block px-4 py-2 rounded transition hover:bg-slate-700" active-class="bg-slate-700 text-white font-bold">
                        <i class="fas fa-chart-pie w-6"></i> Dashboard
                    </router-link>
                    <router-link to="/pos" @click="closeMobileMenu" class="block px-4 py-2 rounded transition hover:bg-slate-700" active-class="bg-slate-700 text-white font-bold">
                        <i class="fas fa-cash-register w-6"></i> POS Terminal
                    </router-link>
                    <router-link to="/analytics" @click="closeMobileMenu" class="block px-4 py-2 rounded transition hover:bg-slate-700" active-class="bg-slate-700 text-white font-bold">
                        <i class="fas fa-chart-line w-6"></i> Analytics
                    </router-link>
                    <router-link to="/contacts" @click="closeMobileMenu" class="block px-4 py-2 rounded transition hover:bg-slate-700" active-class="bg-slate-700 text-white font-bold">
                        <i class="fas fa-address-book w-6"></i> Contacts
                    </router-link>
                    
                    <div class="text-xs uppercase font-bold text-slate-500 mt-4 mb-2 px-4">Finance</div>
                    
                    <router-link to="/sales" @click="closeMobileMenu" class="block px-4 py-2 rounded transition hover:bg-slate-700" active-class="bg-slate-700 text-white font-bold">
                        <i class="fas fa-file-invoice-dollar w-6"></i> Sales
                    </router-link>
                    <router-link to="/expenses" @click="closeMobileMenu" class="block px-4 py-2 rounded transition hover:bg-slate-700" active-class="bg-slate-700 text-white font-bold">
                        <i class="fas fa-receipt w-6"></i> Expenses
                    </router-link>
                    <router-link to="/products" @click="closeMobileMenu" class="block px-4 py-2 rounded transition hover:bg-slate-700" active-class="bg-slate-700 text-white font-bold">
                        <i class="fas fa-box w-6"></i> Products
                    </router-link>
                    
                    <div v-if="isAdmin">
                        <div class="text-xs uppercase font-bold text-slate-500 mt-4 mb-2 px-4">Administration</div>
                        
                        <router-link to="/companies" @click="closeMobileMenu" class="block px-4 py-2 rounded transition hover:bg-slate-700" active-class="bg-slate-700 text-white font-bold">
                            <i class="fas fa-building w-6"></i> Settings
                        </router-link>
                        <router-link to="/users" @click="closeMobileMenu" class="block px-4 py-2 rounded transition hover:bg-slate-700" active-class="bg-slate-700 text-white font-bold">
                            <i class="fas fa-users-cog w-6"></i> Staff
                        </router-link>
                        <router-link to="/activity" @click="closeMobileMenu" class="block px-4 py-2 rounded transition hover:bg-slate-700" active-class="bg-slate-700 text-white font-bold">
                            <i class="fas fa-shield-alt w-6"></i> Audit Log
                        </router-link>
                        <router-link to="/templates" @click="closeMobileMenu" class="block px-4 py-2 rounded transition hover:bg-slate-700" active-class="bg-slate-700 text-white font-bold">
                            <i class="fas fa-paint-brush w-6"></i> Templates
                        </router-link>
                        <router-link to="/settings" @click="closeMobileMenu" class="block px-4 py-2 rounded transition hover:bg-slate-700" active-class="bg-slate-700 text-white font-bold">
                            <i class="fas fa-cog w-6"></i> Preferences
                        </router-link>
                    </div>
                </nav>

                <div class="mt-auto border-t border-slate-700 p-4">
                    <router-link to="/profile" @click="closeMobileMenu" class="block px-4 py-2 rounded transition hover:bg-slate-700 mb-2" active-class="bg-slate-700 text-white font-bold">
                        <i class="fas fa-user-circle w-6"></i> My Profile
                    </router-link>
                </div>
            </aside>
            
            <main class="flex-grow overflow-y-auto overflow-x-hidden bg-gray-100 dark:bg-slate-900 transition-colors duration-300 relative w-full">
                <router-view v-slot="{ Component }">
                    <transition name="fade" mode="out-in">
                        <component :is="Component" />
                    </transition>
                </router-view>
            </main>
        </div>
    </div>
</template>