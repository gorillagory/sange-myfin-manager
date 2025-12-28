import { reactive } from 'vue';
import { db, auth } from './firebase'; // Imports your secure connection
import { initializeApp, deleteApp, getApp, getApps } from "firebase/app";
import { 
    collection, setDoc, addDoc, updateDoc, deleteDoc, doc, 
    onSnapshot, query, orderBy, where 
} from "firebase/firestore";
import { getAuth, createUserWithEmailAndPassword,
    signInWithEmailAndPassword, signOut, onAuthStateChanged 
} from "firebase/auth";

export const Store = {
    // --- STATE ---
    state: reactive({
        companies: [],
        selectedCompany: null,
        transactions: [],
        clients: [],
        products: [],
        users: [],
        currentUser: null,
        activities: [],
        notification: { show: false, message: '', type: 'success' },
        preferences: { theme: 'light' }
    }),

    // --- INITIALIZATION ---
    // Call Store.init() in main.js
    init() {
        onAuthStateChanged(auth, (user) => {
            if (user) {
                this.fetchUserProfile(user.uid);
            } else {
                this.state.currentUser = null;
                this.state.selectedCompany = null;
                this.state.transactions = []; // Clear sensitive data
            }
        });
    },

    // --- REAL-TIME DATA SYNC ---
    startListeners() {
        if (!this.state.currentUser) return;

        // 1. Companies
        onSnapshot(query(collection(db, "companies")), (snap) => {
            this.state.companies = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            
            // Auto-select company if assigned
            if (this.state.currentUser.company_id && !this.state.selectedCompany) {
                this.state.selectedCompany = this.state.companies.find(c => c.id === this.state.currentUser.company_id);
            }
        });

        // 2. Transactions
        onSnapshot(query(collection(db, "transactions")), (snap) => {
            this.state.transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        });

        // 3. Clients
        onSnapshot(collection(db, "clients"), (snap) => {
            this.state.clients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        });

        // 4. Products
        onSnapshot(collection(db, "products"), (snap) => {
            this.state.products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        });
        
        // 5. Activities (Logs)
        const qLogs = query(collection(db, "activities"), orderBy("date", "desc"));
        onSnapshot(qLogs, (snap) => {
             this.state.activities = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        });

        // 6. Users (Super Admin Only)
        if (this.state.currentUser.role === 'super') {
             onSnapshot(collection(db, "users"), (snap) => {
                this.state.users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            });
        }
    },

    // --- AUTHENTICATION ---
    async login(email, password) {
        try {
            await signInWithEmailAndPassword(auth, email, password);
            this.notify("Welcome back!");
            return true;
        } catch (error) {
            console.error(error);
            this.notify("Login failed: " + error.message, "error");
            return false;
        }
    },

    async logout() {
        await signOut(auth);
        window.location.reload(); // Hard refresh to clear memory
    },

    fetchUserProfile(uid) {
        const userRef = doc(db, "users", uid);
        onSnapshot(userRef, (docSnap) => {
            if (docSnap.exists()) {
                this.state.currentUser = { id: docSnap.id, ...docSnap.data() };
                this.startListeners(); // Start syncing data
            }
        });
    },

    // --- CRUD ACTIONS (Cloud Connected) ---
    
    // Transactions (Invoices/Expenses)
    async addTransaction(tx) {
        try {
            const cleanTx = JSON.parse(JSON.stringify(tx));
            delete cleanTx.id; // Cloud creates its own ID
            await addDoc(collection(db, "transactions"), cleanTx);
            this.logActivity('Create', `Created ${tx.type} ${tx.number}`);
        } catch (e) { this.notify("Error: " + e.message, "error"); }
    },

    async updateTransaction(tx) {
        try {
            const cleanTx = JSON.parse(JSON.stringify(tx));
            const id = cleanTx.id;
            delete cleanTx.id;
            await updateDoc(doc(db, "transactions", id), cleanTx);
            this.logActivity('Update', `Updated ${tx.type} ${tx.number}`);
        } catch (e) { this.notify("Error: " + e.message, "error"); }
    },

    async deleteTransaction(id) {
        if (!this.canDelete()) return this.notify("Access Denied", "error");
        await deleteDoc(doc(db, "transactions", id));
        this.notify("Deleted successfully");
    },

    // Products
    async addProduct(product) {
        const cleanProd = JSON.parse(JSON.stringify(product));
        delete cleanProd.id;
        await addDoc(collection(db, "products"), cleanProd);
    },
    
    async deleteProduct(id) {
        if (!this.canDelete()) return this.notify("Access Denied", "error");
        await deleteDoc(doc(db, "products", id));
    },

    // Clients
    async addClient(client) {
         const cleanClient = JSON.parse(JSON.stringify(client));
         delete cleanClient.id;
         await addDoc(collection(db, "clients"), cleanClient);
    },

    async deleteClient(id) {
        if (!this.canDelete()) return this.notify("Access Denied", "error");
        await deleteDoc(doc(db, "clients", id));
    },

    // Companies & Users (Admin)
    async addCompany(company) {
        const cleanCo = JSON.parse(JSON.stringify(company));
        delete cleanCo.id;
        await addDoc(collection(db, "companies"), cleanCo);
        this.logActivity('Create Company', `Registered: ${company.name}`);
    },

    async updateCompany(company) {
        const cleanCo = JSON.parse(JSON.stringify(company));
        const id = cleanCo.id;
        delete cleanCo.id;
        await updateDoc(doc(db, "companies", id), cleanCo);
        this.logActivity('Update Company', `Updated: ${company.name}`);
    },

    async deleteCompany(id) {
        await deleteDoc(doc(db, "companies", id));
    },

    // --- ADMIN: USER MANAGEMENT ---
    async addUser(userData) {
        // 1. Separate Password from Profile Data
        const { password, ...profile } = userData;
        
        if (!password) {
            this.notify("Password required to create account", "error");
            return false;
        }

        try {
            // 2. Create Secondary App (To avoid logging out admin)
            let secondaryApp;
            if (getApps().length > 1) {
                secondaryApp = getApps()[1];
            } else {
                secondaryApp = initializeApp(getApp().options, "Secondary");
            }
            
            const secondaryAuth = getAuth(secondaryApp);

            // 3. Create Auth User
            const userCredential = await createUserWithEmailAndPassword(secondaryAuth, profile.email, password);
            const uid = userCredential.user.uid;

            // 4. Create Database Profile
            const cleanUser = JSON.parse(JSON.stringify(profile));
            delete cleanUser.id; 
            
            // Use setDoc to force the UID to match
            await setDoc(doc(db, "users", uid), cleanUser);

            // 5. Cleanup
            await signOut(secondaryAuth);
            
            this.logActivity('Create User', `Created user: ${profile.username} (${profile.role})`);
            this.notify("User Account & Profile Created Successfully!");
            return true;

        } catch (error) {
            console.error(error);
            // --- NEW: HANDLE EXISTING USER ERROR ---
            if (error.code === 'auth/email-already-in-use') {
                this.notify("Error: Email is already registered. Delete user in Firebase Console first.", "error");
            } else {
                this.notify("Error creating user: " + error.message, "error");
            }
            return false;
        }
    },
    
    async deleteUser(id) {
        await deleteDoc(doc(db, "users", id));
    },

    // --- HELPERS ---
    notify(msg, type = 'success') {
        this.state.notification = { show: true, message: msg, type };
        setTimeout(() => { this.state.notification.show = false; }, 3000);
    },
    
    canDelete() {
        return this.state.currentUser?.role === 'super' || this.state.currentUser?.role === 'company_admin';
    },

    selectCompany(co) {
        this.state.selectedCompany = co;
    },
    
    updatePreferences(prefs) {
        this.state.preferences = prefs;
        if (this.state.selectedCompany) {
             // Save to Cloud
             const coRef = doc(db, "companies", this.state.selectedCompany.id);
             updateDoc(coRef, { preferences: prefs });
        }
    },

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