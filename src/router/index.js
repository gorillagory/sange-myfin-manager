import { watch } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { Store } from '../store';

const routes = [
    { path: '/', redirect: '/overview' },
    { path: '/:pathMatch(.*)*', redirect: '/overview' },
    { path: '/overview', component: () => import('../components/dashboard/OverviewTab.vue') },
    { path: '/pos', component: () => import('../components/dashboard/PosTab.vue') },
    { path: '/analytics', component: () => import('../components/dashboard/AnalyticsTab.vue') },
    { path: '/contacts', component: () => import('../components/dashboard/ContactsTab.vue') },
    { path: '/sales', component: () => import('../components/dashboard/finance/SalesTab.vue') },
    { path: '/expenses', component: () => import('../components/dashboard/ExpensesTab.vue') },
    { path: '/products', component: () => import('../components/dashboard/ProductsTab.vue') },
    { path: '/profile', component: () => import('../components/dashboard/UserProfile.vue') },
    
    // Protected Admin Routes
    { path: '/companies', component: () => import('../components/dashboard/CompanyManager.vue'), meta: { requiresAdmin: true } },
    { path: '/users', component: () => import('../components/dashboard/UserManager.vue'), meta: { requiresAdmin: true } },
    { path: '/activity', component: () => import('../components/dashboard/ActivityTab.vue'), meta: { requiresAdmin: true } },
    { path: '/templates', component: () => import('../components/dashboard/TemplateStudio.vue'), meta: { requiresAdmin: true } },
    { path: '/settings', component: () => import('../components/dashboard/SettingsTab.vue'), meta: { requiresAdmin: true } }
];

const router = createRouter({
    history: createWebHistory(),
    routes,
    scrollBehavior: () => ({ top: 0 })
});

// Guard to prevent standard users from forcing their way into Admin routes via URL
router.beforeEach(async (to, from, next) => {
    if (Store.state.isLoading) await new Promise(resolve => { const unwatch=watch(() => Store.state.isLoading, loading => { if(!loading){unwatch();resolve();} }); });
    const isAdmin = ['super', 'company_admin'].includes(Store.state.currentUser?.role);
    if (to.meta.requiresAdmin && !isAdmin) {
        Store.notify("Unauthorized Access", "error");
        next('/overview');
    } else {
        next();
    }
});

export default router;