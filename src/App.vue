<script setup>
import { computed, onMounted } from 'vue';
import { Store } from './store';

// Components
import AuthManager from './components/AuthManager.vue'; 
import DashboardManager from './components/DashboardManager.vue';
import SuperDashboard from './components/SuperDashboard.vue'; 

const currentUser = computed(() => Store.state.currentUser);
const selectedCompany = computed(() => Store.state.selectedCompany);
const toast = computed(() => Store.state.notification);

// --- VIEW LOGIC (Returning strings to match your original structure) ---
const currentView = computed(() => {
    // 1. Not Logged In -> Show Login Screen
    if (!currentUser.value) return 'auth';
    
    // 2. Super Admin + No Company Selected -> Show Command Center
    if (currentUser.value.role === 'super' && !selectedCompany.value) {
        return 'super';
    }
    
    // 3. Regular User OR Company Selected -> Show Workspace
    return 'dashboard';
});

onMounted(() => {
    Store.init();
});
</script>

<template>
  <div class="font-sans text-gray-900 bg-gray-50 min-h-screen">
    
    <Transition name="fade">
        <div v-if="Store.state.isLoading" class="spinner-overlay">
            <div class="spinner mb-4"></div>
            <div class="text-slate-400 font-bold tracking-widest text-sm animate-pulse">LOADING</div>
        </div>
    </Transition>

    <Transition name="page-fade" mode="out-in">
        
        <div v-if="currentView === 'auth'" key="auth" class="flex items-center justify-center h-screen bg-gradient-to-br from-slate-900 to-slate-800">
            <AuthManager />
        </div>

        <div v-else-if="currentView === 'super'" key="super">
            <SuperDashboard />
        </div>

        <div v-else key="dashboard">
            <DashboardManager />
        </div>

    </Transition>

    <Transition name="toast">
      <div v-if="toast && toast.show" 
           class="fixed bottom-6 right-6 px-6 py-4 rounded-lg shadow-xl z-[9999] flex items-center gap-3 text-white transform transition-all duration-300"
           :class="toast.type === 'error' ? 'bg-red-600' : 'bg-slate-800'">
           
           <i class="fas" :class="toast.type === 'error' ? 'fa-exclamation-circle' : 'fa-check-circle'"></i>
           <div>
             <div class="font-bold text-sm uppercase opacity-75">{{ toast.type === 'error' ? 'Error' : 'Success' }}</div>
             <div class="font-bold">{{ toast.message }}</div>
           </div>
      </div>
    </Transition>

  </div>
</template>

<style>
/* --- PAGE TRANSITIONS --- */
.page-fade-enter-active,
.page-fade-leave-active {
    transition: opacity 0.3s ease, transform 0.3s ease;
}
.page-fade-enter-from,
.page-fade-leave-to {
    opacity: 0;
    transform: translateY(10px);
}

/* --- TOAST ANIMATION --- */
.toast-enter-active,
.toast-leave-active { transition: all 0.3s ease; }
.toast-enter-from,
.toast-leave-to { opacity: 0; transform: translateY(20px); }

/* --- SPINNER & FADE --- */
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.spinner-overlay {
    position: fixed;
    inset: 0;
    background: #ffffff;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
}
.spinner {
    width: 50px;
    height: 50px;
    border: 4px solid #e2e8f0;
    border-top-color: #10b981;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>