// js/4-app.js
const { createApp } = Vue;

const app = createApp({
    components: {
        'company-manager': CompanyManager,
        'dashboard-manager': DashboardManager,
        'user-manager': UserManager
    },
    data() {
        return {
            loginForm: { username: '', password: '' }
        };
    },
    computed: {
        selectedCompany() { return Store.state.selectedCompany; },
        currentUser() { return Store.state.currentUser; },
        isSuperUser() { return this.currentUser && this.currentUser.role === 'super'; },
        toast() { return Store.state.toast; },
        loading() { return Store.state.loading; }
    },
    methods: {
        handleLogin() {
            const success = Store.login(this.loginForm.username, this.loginForm.password);
            if (success) {
                Store.notify("Welcome back!");
                this.loginForm = { username: '', password: '' };
            } else {
                Store.notify("Invalid Credentials", 'error');
            }
        },
        logout() { Store.logout(); }
    },
    created() {
        Store.init();
    }
});

app.mount('#app');