// js/4-app.js
const { createApp } = Vue;

const app = createApp({
    components: {
        'company-manager': CompanyManager,
        'dashboard-manager': DashboardManager
    },
    computed: {
        selectedCompany() { return Store.state.selectedCompany; },
        // Expose Toast State to the main App wrapper
        toast() { return Store.state.toast; }
    },
    created() {
        Store.init();
    }
});

app.mount('#app');