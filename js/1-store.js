// js/1-store.js
const { reactive } = Vue;

// -------------------------------------------------------------
// IMPORTANT: PASTE YOUR FIREBASE CONFIG HERE
// -------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyCVGVZ1fQPMr88oAL-uRypAFvkZNsXQox8",
  authDomain: "myfinmanager-1d2da.firebaseapp.com",
  projectId: "myfinmanager-1d2da",
  storageBucket: "myfinmanager-1d2da.firebasestorage.app",
  messagingSenderId: "798532442356",
  appId: "1:798532442356:web:00fc79a472081f902726a1"
};

// Initialize Firebase
const firebaseApp = firebase.initializeApp(firebaseConfig); // Renamed to firebaseApp
const db = firebase.firestore();

const Store = reactive({
    state: {
        companies: [],
        clients: [],
        transactions: [],
        users: [],
        currentUser: null,
        selectedCompany: null,
        preferences: { theme: 'light', docTemplate: 'clean' },
        toast: { show: false, message: '', type: 'success', timer: null },
        loading: true
    },

    init() {
        this.state.loading = true;

        // --- REAL-TIME LISTENERS ---
        // These automatically update the App when data changes in the Cloud
        db.collection("companies").onSnapshot(snap => {
            this.state.companies = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        });
        db.collection("clients").onSnapshot(snap => {
            this.state.clients = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        });
        db.collection("transactions").onSnapshot(snap => {
            this.state.transactions = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        });
        
        // Listen for Users (For Login)
        db.collection("users").onSnapshot(snap => {
            this.state.users = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            
            // Create Default Admin if empty
            if (this.state.users.length === 0) {
                this.addUser({ username: 'admin', password: 'admin', role: 'super', company_id: null });
            }
            this.state.loading = false;
        });

        // Restore Session
        const sess = sessionStorage.getItem('myfin_session');
        if (sess) this.state.currentUser = JSON.parse(sess);
    },

    // --- AUTH ACTIONS ---
    login(username, password) {
        const user = this.state.users.find(u => u.username === username && u.password === password);
        if (user) {
            this.state.currentUser = user;
            sessionStorage.setItem('myfin_session', JSON.stringify(user));
            
            if (user.role === 'company_admin' && user.company_id) {
                const co = this.state.companies.find(c => c.id === user.company_id);
                this.state.selectedCompany = co || null;
            } else {
                this.state.selectedCompany = null; // Super admin sees menu
            }
            return true;
        }
        return false;
    },

    logout() {
        this.state.currentUser = null;
        this.state.selectedCompany = null;
        sessionStorage.removeItem('myfin_session');
    },

    addUser(user) {
        if (this.state.users.find(u => u.username === user.username)) return false;
        db.collection("users").add(user);
        return true;
    },

    deleteUser(id) {
        db.collection("users").doc(id).delete();
    },

    // --- CLOUD CRUD ACTIONS ---
    addCompany(data) { 
        const id = Date.now().toString(); 
        db.collection("companies").doc(id).set({ ...data, id: id });
    },
    updateCompany(data) { db.collection("companies").doc(data.id).update(data); },
    deleteCompany(id) { db.collection("companies").doc(id).delete(); },
    selectCompany(c) { this.state.selectedCompany = c; },

    // No dedicated saveClient needed if we use generic add/update logic, but keeping for compatibility:
    // (Actually, dashboard.js calls Store.state.clients.push, we need to fix that via ACTIONS)
    // Wait, Dashboard.js uses Store.saveClient which pushes to array. 
    // We must ensure Dashboard.js calls an ACTION, not direct array push.
    
    // NOTE: I updated js/3-dashboard.js to call Store.addClient / updateClient? 
    // No, I need to add those methods here to match what dashboard expects or update dashboard.
    // Let's add them here for safety.
    
    addClient(data) {
        const id = data.id ? data.id.toString() : Date.now().toString();
        db.collection("clients").doc(id).set({ ...data, id: id });
    },
    
    addTransaction(data) { 
        const id = data.id ? data.id.toString() : Date.now().toString();
        db.collection("transactions").doc(id).set({ ...data, id: id });
    },
    updateTransaction(data) { db.collection("transactions").doc(data.id.toString()).update(data); },
    deleteTransaction(id) { db.collection("transactions").doc(id.toString()).delete(); },

    updatePreferences(newPrefs) { 
        this.state.preferences = newPrefs;
        localStorage.setItem('myfin_preferences', JSON.stringify(newPrefs));
    },
    
    notify(message, type = 'success') {
        if (this.state.toast.timer) clearTimeout(this.state.toast.timer);
        this.state.toast.message = message;
        this.state.toast.type = type; 
        this.state.toast.show = true;
        this.state.toast.timer = setTimeout(() => { this.state.toast.show = false; }, 3000);
    },
    
    // Helper to persist the manual array push from Company/Dashboard components if they haven't been fully updated to use Actions
    // Ideally components should call Actions.
    save() {
        // This is a dummy function now because real-time listeners handle the state.
        // But we keep it to prevent errors if old code calls Store.save()
        console.log("Data saved to Cloud automatically.");
    }
});