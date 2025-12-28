<script setup>
import { computed } from 'vue';
import { Store } from './store';
import AuthManager from './components/AuthManager.vue';
import CompanySelector from './components/CompanySelector.vue';
import DashboardManager from './components/DashboardManager.vue';

const currentUser = computed(() => Store.state.currentUser);
const selectedCompany = computed(() => Store.state.selectedCompany);
const toast = computed(() => Store.state.notification);
</script>

<template>
  <div class="font-sans text-gray-900 bg-gray-50 min-h-screen">
    
    <div v-if="!currentUser" class="flex items-center justify-center h-screen bg-gradient-to-br from-slate-900 to-slate-800">
      <AuthManager />
    </div>

    <div v-else-if="!selectedCompany">
      <CompanySelector />
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