import { watch } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { Store } from '../store';
import { canVisit } from '../domain/viewAccess';

const routes = [
    { path: '/', redirect: '/overview' },
    { path: '/poslog', component: () => import('../components/dashboard/OverviewTab.vue') },
    { path: '/session-handoff', component: () => import('../components/dashboard/OverviewTab.vue') },
    { path: '/overview', component: () => import('../components/dashboard/OverviewTab.vue') },
    { path: '/pos', component: () => import('../components/dashboard/PosTab.vue') },
    { path: '/orders', component: () => import('../components/dashboard/OrdersTab.vue') },
    { path: '/finance-sales', component: () => import('../components/dashboard/finance/FinanceSales.vue') },
    { path: '/analytics', component: () => import('../components/dashboard/AnalyticsTab.vue') },
    { path: '/consolidation', component: () => import('../components/dashboard/ConsolidationTab.vue') },
    { path: '/contacts', component: () => import('../components/dashboard/ContactsTab.vue') },
    { path: '/receipt-reviews', component: () => import('../components/dashboard/ReceiptReviews.vue') },
    { path: '/sales', redirect: to => ({ path: '/documents', query: to.query, hash: to.hash }) },
    { path: '/documents', component: () => import('../components/dashboard/finance/SalesTab.vue') },
    { path: '/expenses', component: () => import('../components/dashboard/ExpensesTab.vue') },
    { path: '/products', component: () => import('../components/dashboard/ProductsTab.vue') },
    { path: '/stock', component: () => import('../components/dashboard/StockTab.vue') },
    { path: '/profile', component: () => import('../components/dashboard/UserProfile.vue') },
    
    // Protected Admin Routes
    { path: '/companies', component: () => import('../components/dashboard/CompanyManager.vue'), meta: { requiresAdmin: true } },
    { path: '/users', component: () => import('../components/dashboard/UserManager.vue'), meta: { requiresAdmin: true } },
    { path: '/activity', component: () => import('../components/dashboard/ActivityTab.vue'), meta: { requiresAdmin: true } },
    { path: '/templates', component: () => import('../components/dashboard/TemplateStudio.vue'), meta: { requiresAdmin: true } },
    { path: '/settings', component: () => import('../components/dashboard/SettingsTab.vue'), meta: { requiresAdmin: true } },
    { path: '/:pathMatch(.*)*', redirect: '/overview' }
];

const router = createRouter({
    history: createWebHistory(),
    routes,
    scrollBehavior: () => ({ top: 0 })
});

// UI routing complements the API's authoritative permission checks.
router.beforeEach(async to => {
    if (Store.state.isLoading) await new Promise(resolve => {
        const unwatch=watch(() => Store.state.isLoading, loading => { if(!loading){unwatch();resolve();} });
    });
    if (Store.state.currentUser && !canVisit(Store.state.currentUser,to.path)) return '/overview';
});
watch(() => [Store.state.currentUser?.role,Store.state.currentUser?.company_id], () => {
    if (Store.state.currentUser && !canVisit(Store.state.currentUser,router.currentRoute.value.path))
        router.replace('/overview');
});
export default router;
