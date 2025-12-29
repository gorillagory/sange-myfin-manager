import { state } from './state';
import { authModule } from './auth';
import { inventoryModule } from './inventory';
import { financeModule } from './finance';
import { companiesModule } from './companies';
import { db } from '../firebase';
import { collection, addDoc, onSnapshot, query, where, orderBy, doc } from "firebase/firestore";

export const Store = {
    state,

    // --- INITIALIZATION ---
    init() { authModule.init(this); },

    // --- REAL-TIME LISTENERS ---
    startListeners() {
        if (!this.state.currentUser) return;
        
        const userCompanyId = this.state.currentUser.company_id;
        const role = this.state.currentUser.role;

        // 1. Companies Logic
        if (role === 'super') {
             // SUPER ADMIN: Load all companies, but DO NOT auto-select one.
             onSnapshot(query(collection(db, "companies")), (snap) => {
                this.state.companies = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                
                // --- DELETED THE AUTO-SELECT LINE HERE ---
                // Previous code: if (!this.state.selectedCompany...) this.state.selectedCompany = ...
                // Now: We leave selectedCompany as null so App.vue shows SuperDashboard
            });
        } else if (userCompanyId) {
            // REGULAR USER: Load only their company and auto-select it.
            onSnapshot(doc(db, "companies", userCompanyId), (snap) => {
                if(snap.exists()) {
                    const co = { id: snap.id, ...snap.data() };
                    this.state.companies = [co];
                    this.state.selectedCompany = co; // Force entry for regular users
                }
            });
        }

        this.startCompanyDataListeners();
    },

    startCompanyDataListeners() {
        const targetId = this.state.selectedCompany?.id || this.state.currentUser?.company_id;
        const isSuper = this.state.currentUser.role === 'super';

        // --- 1. GLOBAL DATA (Super Admin Only) ---
        // Load this IMMEDIATELY, even if no company is selected (Command Center)
        if (isSuper) {
             // Ensure we don't double-subscribe? For MVP, simple overwrite is fine.
             onSnapshot(collection(db, "users"), (snap) => this.state.users = snap.docs.map(d => ({ id: d.id, ...d.data() })));
        }

        // --- 2. SCOPED DATA (Requires a Company Context) ---
        // If we are in Command Center (No targetId), we STOP here for operational data.
        if (!targetId) return;

        const getQuery = (col) => isSuper && !this.state.selectedCompany 
            ? collection(db, col) // This line is technically fallback, but usually we have a selectedCompany by now if we are here
            : query(collection(db, col), where("company_id", "==", targetId));

        // Listeners for Operational Data
        onSnapshot(getQuery("transactions"), (snap) => this.state.transactions = snap.docs.map(d => ({ id: d.id, ...d.data() })));
        onSnapshot(getQuery("clients"), (snap) => this.state.clients = snap.docs.map(d => ({ id: d.id, ...d.data() })));
        onSnapshot(getQuery("products"), (snap) => this.state.products = snap.docs.map(d => ({ id: d.id, ...d.data() })));
        
        // Logs
        onSnapshot(query(collection(db, "activities"), where("company_id", "==", targetId), orderBy("date", "desc")), 
            (snap) => this.state.activities = snap.docs.map(d => ({ id: d.id, ...d.data() })));
        
        // Note: For Company Admins, we load their users here (Scoped)
        if (!isSuper) {
             const qUsers = query(collection(db, "users"), where("company_id", "==", targetId));
             onSnapshot(qUsers, (snap) => this.state.users = snap.docs.map(d => ({ id: d.id, ...d.data() })));
        }
    },

    // --- DELEGATE ACTIONS TO MODULES ---
    login(e, p) { return authModule.login(this, e, p); },
    logout() { return authModule.logout(); },
    addUser(d) { return authModule.addUser(this, d); },
    updateUser(d) { return authModule.updateUser(this, d); },
    deleteUser(id) { return authModule.deleteUser(this, id); },
    updateSelf(data) { return authModule.updateSelf(this, data); },

    addProduct(p) { return inventoryModule.addProduct(this, p); },
    deleteProduct(id) { return inventoryModule.deleteProduct(this, id); },

    addTransaction(t) { return financeModule.addTransaction(this, t); },
    updateTransaction(t) { return financeModule.updateTransaction(this, t); },
    deleteTransaction(id) { return financeModule.deleteTransaction(this, id); },
    addClient(c) { return financeModule.addClient(this, c); },
    deleteClient(id) { return financeModule.deleteClient(this, id); },

    addCompany(c) { return companiesModule.addCompany(this, c); },
    updateCompany(c) { return companiesModule.updateCompany(this, c); },
    deleteCompany(id) { return companiesModule.deleteCompany(this, id); },
    
    // Updated Select Logic
    selectCompany(c) { 
        this.state.selectedCompany = c;
        if (c) {
            this.startListeners(); // Load data for this specific company
        } else {
            // If c is null (Back to HQ), clear the operational data
            this.state.transactions = [];
            this.state.products = [];
            this.state.clients = [];
        }
    },
    
    updatePreferences(p) { return companiesModule.updatePreferences(this, p); },

    // --- HELPERS ---
    notify(msg, type = 'success') {
        this.state.notification = { show: true, message: msg, type };
        setTimeout(() => { this.state.notification.show = false; }, 3000);
    },
    
    canDelete() { return this.state.currentUser?.role === 'super' || this.state.currentUser?.role === 'company_admin'; },

    async logActivity(action, details) {
        await addDoc(collection(db, "activities"), {
             date: new Date().toISOString(),
             action, details,
             user: this.state.currentUser?.username || 'System',
             company_id: this.state.selectedCompany?.id || null,
             company: this.state.selectedCompany?.name || 'Global'
        });
    }
};