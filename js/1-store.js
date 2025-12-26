// js/1-store.js
const { reactive } = Vue;

const Store = reactive({
    state: {
        companies: [],
        clients: [],
        transactions: [],
        selectedCompany: null,
        preferences: { theme: 'light', docTemplate: 'clean' },
        
        // NEW: TOAST STATE
        toast: { show: false, message: '', type: 'success', timer: null }
    },

    init() {
        try {
            const co = localStorage.getItem('myfin_companies');
            const cl = localStorage.getItem('myfin_clients');
            const tx = localStorage.getItem('myfin_transactions');
            const pf = localStorage.getItem('myfin_preferences');
            
            if (co) this.state.companies = JSON.parse(co);
            if (cl) this.state.clients = JSON.parse(cl);
            if (tx) this.state.transactions = JSON.parse(tx);
            if (pf) this.state.preferences = JSON.parse(pf);
        } catch (e) {
            console.error("Storage Access Blocked", e);
        }
    },

    save() {
        localStorage.setItem('myfin_companies', JSON.stringify(this.state.companies));
        localStorage.setItem('myfin_clients', JSON.stringify(this.state.clients));
        localStorage.setItem('myfin_transactions', JSON.stringify(this.state.transactions));
        localStorage.setItem('myfin_preferences', JSON.stringify(this.state.preferences));
    },

    // --- ACTIONS ---
    addCompany(data) { data.id = Date.now(); this.state.companies.push(data); this.save(); },
    updateCompany(data) { const i = this.state.companies.findIndex(c => c.id === data.id); if(i!==-1) this.state.companies[i]=data; this.save(); },
    deleteCompany(id) { 
        this.state.companies = this.state.companies.filter(c => c.id !== id); 
        this.state.clients = this.state.clients.filter(c => c.company_id !== id);
        this.state.transactions = this.state.transactions.filter(t => t.company_id !== id);
        this.save(); 
    },
    selectCompany(c) { this.state.selectedCompany = c; },
    logout() { this.state.selectedCompany = null; },
    
    addTransaction(data) { data.id = Date.now(); this.state.transactions.push(data); this.save(); },
    updateTransaction(data) { const i = this.state.transactions.findIndex(t => t.id === data.id); if(i!==-1) this.state.transactions[i]=data; this.save(); },
    deleteTransaction(id) { this.state.transactions = this.state.transactions.filter(t => t.id !== id); this.save(); },

    updatePreferences(newPrefs) { this.state.preferences = newPrefs; this.save(); },

    // --- NEW: TOAST ACTION ---
    notify(message, type = 'success') {
        // Clear existing timer if any
        if (this.state.toast.timer) clearTimeout(this.state.toast.timer);

        this.state.toast.message = message;
        this.state.toast.type = type; // 'success' or 'error'
        this.state.toast.show = true;

        // Auto hide after 3 seconds
        this.state.toast.timer = setTimeout(() => {
            this.state.toast.show = false;
        }, 3000);
    }
});