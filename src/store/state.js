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
    activities: [],
    notification: { show: false, message: '', type: 'success' },
    preferences: { theme: 'light' }
});