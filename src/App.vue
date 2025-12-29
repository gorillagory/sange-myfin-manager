<script setup>
import { computed, onMounted } from 'vue';
import { Store } from './store';

// Components
import AuthManager from './components/AuthManager.vue'; // Kept your original component name
import DashboardManager from './components/DashboardManager.vue';
import SuperDashboard from './components/SuperDashboard.vue'; // The new Command Center

const currentUser = computed(() => Store.state.currentUser);
const selectedCompany = computed(() => Store.state.selectedCompany);
const toast = computed(() => Store.state.notification);

// --- VIEW LOGIC ---
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
    
    <div v-if="currentView === 'auth'" class="flex items-center justify-center h-screen bg-gradient-to-br from-slate-900 to-slate-800">
      <AuthManager />
    </div>

    <div v-else-if="currentView === 'super'">
      <SuperDashboard />
    </div>

    <div v-else>
      <DashboardManager />
    </div>

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
/* Toast Animation */
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(20px);
}
</style>