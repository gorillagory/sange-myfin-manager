import { reactive } from 'vue';
import { auth, db } from '../firebase';
import { 
    signInWithEmailAndPassword, 
    signOut, 
    onAuthStateChanged 
} from "firebase/auth";
import { 
    collection, 
    getDocs, 
    doc, 
    onSnapshot, 
    query, 
    where 
} from "firebase/firestore";

// --- IMPORT MODULES ---
import { state } from './state';
import { financeModule } from './finance';
import { inventoryModule } from './inventory';
import { companiesModule } from './companies'; // <--- NEW IMPORT
import { authModule } from './auth';           // <--- NEW IMPORT

// --- MAIN STORE OBJECT ---
export const Store = reactive({
    state,
    
    // --- EXPOSE MODULES ---
    financeModule,
    inventoryModule,
    companiesModule,
    authModule,

    // --- AUTHENTICATION (Core) ---
    async login(email, password) {
        try {
            this.state.isLoading = true;
            await signInWithEmailAndPassword(auth, email, password);
            this.notify("Welcome back!", "success");
            return true;
        } catch (error) {
            this.state.isLoading = false;
            this.notify("Login failed: " + error.message, "error");
            return false;
        }
    },

    async logout() {
        await signOut(auth);
        this.state.currentUser = null;
        this.state.selectedCompany = null;
        this.state.transactions = [];
        this.state.expenses = [];
        this.state.clients = [];
    },

    // --- INITIALIZATION ---
    init() {
        onAuthStateChanged(auth, async (user) => {
            if (user) {
                const userDoc = await getDocs(query(collection(db, "users"), where("email", "==", user.email)));
                if (!userDoc.empty) {
                    this.state.currentUser = { id: userDoc.docs[0].id, ...userDoc.docs[0].data() };
                    if(this.state.currentUser.preferences) {
                        this.state.preferences = this.state.currentUser.preferences;
                    }
                    this.startListeners();
                }
            } else {
                this.state.currentUser = null;
            }
            setTimeout(() => { this.state.isLoading = false; }, 800);
        });
    },

    startListeners() {
        // Listen for Companies
        onSnapshot(collection(db, "companies"), (snap) => {
            this.state.companies = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            
            // Auto-select company if user is restricted
            if (this.state.currentUser?.role === 'company_user' || this.state.currentUser?.role === 'company_admin') {
                const myCo = this.state.companies.find(c => c.id === this.state.currentUser.company_id);
                if (myCo) this.selectCompany(myCo);
            }
        });
        
        // Listen for Users
        onSnapshot(collection(db, "users"), (snap) => {
            this.state.users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        });
    },

    selectCompany(company) {
        this.state.selectedCompany = company;
        if (company) {
            this.startCompanyDataListeners(company.id);
        }
    },

    startCompanyDataListeners(companyId) {
        const getQuery = (col) => query(collection(db, col), where("company_id", "==", companyId));
        
        onSnapshot(getQuery("products"), (snap) => {
            this.state.products = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        });
        onSnapshot(getQuery("transactions"), (snap) => {
            this.state.transactions = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        });
        onSnapshot(getQuery("expenses"), (snap) => {
            this.state.expenses = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        });
        onSnapshot(getQuery("clients"), (snap) => {
            this.state.clients = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        });
    },

    // --- SHORTCUT WRAPPERS ---
    
    // 1. Transactions
    addTransaction(t) { return financeModule.addTransaction(this, t); },
    updateTransaction(t) { return financeModule.updateTransaction(this, t); },
    deleteTransaction(id) { return financeModule.deleteTransaction(this, id); },
    assignProject(data) { return financeModule.assignProject(this, data); },

    // 2. Inventory
    addProduct(p) { return inventoryModule.addProduct(this, p); },
    updateProduct(p) { return inventoryModule.updateProduct(this, p); },
    deleteProduct(id) { return inventoryModule.deleteProduct(this, id); },
    
    // 3. Expenses
    addExpense(e) { return financeModule.addExpense(this, e); },
    deleteExpense(data) { return financeModule.deleteExpense(this, data); },

    // 4. Clients
    addClient(c) { return financeModule.addClient(this, c); },
    deleteClient(id) { return financeModule.deleteClient(this, id); },

    // 5. Companies (THE FIX)
    addCompany(c) { return companiesModule.addCompany(this, c); },
    updateCompany(c) { return companiesModule.updateCompany(this, c); },
    deleteCompany(id) { return companiesModule.deleteCompany(this, id); },

    // 6. Users (Auth Module)
    addUser(u) { return authModule.addUser(this, u); },
    updateUser(u) { return authModule.updateUser(this, u); },
    deleteUser(id) { return authModule.deleteUser(this, id); },
    updateSelf(data) { return authModule.updateSelf(this, data); },

    // --- UTILS ---
    notify(msg, type = 'success') {
        this.state.notification = { show: true, message: msg, type };
        setTimeout(() => this.state.notification.show = false, 3000);
    },

    logActivity(action, details) {
        console.log(`[ACTIVITY] ${action}: ${details}`);
        // Optional: Save to Firestore 'activities' collection here
    },

    canDelete() {
        return ['super', 'company_admin'].includes(this.state.currentUser?.role);
    },

    updatePreferences(prefs) {
        // Use the module version to ensure it saves to Firestore
        return companiesModule.updatePreferences(this, prefs);
    },
    
    saveCompanyStyle(style) {
        // Alias for updatePreferences specifically for template studio
        return this.updatePreferences(style);
    }
});