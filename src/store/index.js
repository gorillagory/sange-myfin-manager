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

// --- MAIN STORE OBJECT ---
export const Store = reactive({
    state,
    
    // --- EXPOSE MODULES (So PosTab can find them) ---
    financeModule,
    inventoryModule,

    // --- AUTHENTICATION ---
    async login(email, password) {
        try {
            this.state.isLoading = true; // Show spinner during login
            await signInWithEmailAndPassword(auth, email, password);
            this.notify("Welcome back!", "success");
            return true;
        } catch (error) {
            this.state.isLoading = false; // Stop spinner on error
            this.notify("Login failed: " + error.message, "error");
            return false;
        }
    },

    async logout() {
        await signOut(auth);
        
        // SMOOTH RESET (Instead of window.reload)
        this.state.currentUser = null;
        this.state.selectedCompany = null;
        
        // Clear sensitive data arrays
        this.state.transactions = [];
        this.state.expenses = [];
        this.state.clients = [];
        
        // Optional: Redirect to login if using router, but v-if in App.vue handles it
    },

    // --- INITIALIZATION ---
    init() {
        onAuthStateChanged(auth, async (user) => {
            if (user) {
                // 1. Fetch User Profile
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
            
            // CRITICAL: Stop loading once Auth Check is done (Logged in OR Logged out)
            setTimeout(() => { this.state.isLoading = false; }, 800); // Small delay for smoothness
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

        // Listen for Users (Global list, filtered later)
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

        // Listen for Products
        onSnapshot(getQuery("products"), (snap) => {
            // FIX: Spread data first, then overwrite ID with Firestore Key
            this.state.products = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        });

        // Listen for Transactions
        onSnapshot(getQuery("transactions"), (snap) => {
            // FIX: Spread data first, then overwrite ID with Firestore Key
            this.state.transactions = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        });

        // Listen for Expenses
        onSnapshot(getQuery("expenses"), (snap) => {
            // FIX: Spread data first, then overwrite ID with Firestore Key
            this.state.expenses = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        });

        // Listen for Clients
        onSnapshot(getQuery("clients"), (snap) => {
            // FIX: Spread data first, then overwrite ID with Firestore Key
            this.state.clients = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        });
    },

    // --- SHORTCUT WRAPPERS ---
    
    // Transactions (Invoices/Quotes)
    addTransaction(t) { return financeModule.addTransaction(this, t); },
    updateTransaction(t) { return financeModule.updateTransaction(this, t); }, // <--- ADDED THIS
    deleteTransaction(id) { return financeModule.deleteTransaction(this, id); }, // <--- ADDED THIS

    // Inventory
    addProduct(p) { return inventoryModule.addProduct(this, p); },
    updateProduct(p) { return inventoryModule.updateProduct(this, p); },
    deleteProduct(id) { return inventoryModule.deleteProduct(this, id); },
    
    // Expenses (Added these to ensure Expense Tab works too)
    addExpense(e) { return financeModule.addExpense(this, e); },
    deleteExpense(data) { return financeModule.deleteExpense(this, data); },
    
    // --- UTILS ---
    notify(msg, type = 'success') {
        this.state.notification = { show: true, message: msg, type };
        setTimeout(() => this.state.notification.show = false, 3000);
    },

    logActivity(action, details) {
        // Simple console log for now, can be expanded to Firestore later
        console.log(`[ACTIVITY] ${action}: ${details}`);
    },

    canDelete() {
        return ['super', 'company_admin'].includes(this.state.currentUser?.role);
    },

    updatePreferences(prefs) {
        this.state.preferences = { ...this.state.preferences, ...prefs };
        // Ideally save to Firestore user profile here
    }
});