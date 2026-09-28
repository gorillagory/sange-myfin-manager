import { reactive } from 'vue';

export const state = reactive({
    companies: [],
    selectedCompany: null,
    transactions: [],
    expenses: [],
    clients: [],
    products: [],
    users: [],
    currentUser: null,
    tenantContext: null,
    tenantInvalid: false,
    sessionVerified: false,
    activities: [],
    stock_movements: [],
    notification: { show: false, message: '', type: 'success' },
    preferences: { theme: 'light' },
    isLoading: true,
    online: true,
    fromCache: true,
    dataLoading: false,
    dataError: '',
    offlineStatus: '',
    pendingSales: [],
    receiptReviews: [],
    syncing: false
});
