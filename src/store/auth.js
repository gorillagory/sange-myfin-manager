import { auth, db } from '../firebase';
import { 
    signInWithEmailAndPassword, signOut, onAuthStateChanged, 
    getAuth, createUserWithEmailAndPassword, updatePassword // <--- Added this
} from "firebase/auth";
import { doc, onSnapshot, setDoc, deleteDoc, updateDoc } from "firebase/firestore"; // Added updateDoc
import { initializeApp, getApp, getApps } from "firebase/app";

export const authModule = {
    init(store) {
        onAuthStateChanged(auth, (user) => {
            if (user) {
                this.fetchUserProfile(store, user.uid);
            } else {
                store.state.currentUser = null;
                store.state.selectedCompany = null;
                store.state.transactions = [];
                store.state.products = [];
            }
        });
    },

    fetchUserProfile(store, uid) {
        onSnapshot(doc(db, "users", uid), (docSnap) => {
            if (docSnap.exists()) {
                store.state.currentUser = { id: docSnap.id, ...docSnap.data() };
                store.startListeners(); // Callback to main store
            }
        });
    },

    async login(store, email, password) {
        try {
            await signInWithEmailAndPassword(auth, email, password);
            store.notify("Welcome back!");
            return true;
        } catch (error) {
            console.error(error);
            store.notify("Login failed: " + error.message, "error");
            return false;
        }
    },

    async logout() {
        await signOut(auth);
        window.location.reload();
    },

    // Admin: Add User (Secondary App Trick)
    async addUser(store, userData) {
        const { password, ...profile } = userData;
        if (!password) { store.notify("Password required", "error"); return false; }

        try {
            let secondaryApp = getApps().length > 1 ? getApps()[1] : initializeApp(getApp().options, "Secondary");
            const secondaryAuth = getAuth(secondaryApp);
            const cred = await createUserWithEmailAndPassword(secondaryAuth, profile.email, password);
            
            const cleanUser = JSON.parse(JSON.stringify(profile));
            delete cleanUser.id;
            await setDoc(doc(db, "users", cred.user.uid), cleanUser);
            await signOut(secondaryAuth);
            
            store.logActivity('Create User', `Created: ${profile.username}`);
            store.notify("User Created!");
            return true;
        } catch (error) {
            store.notify(error.code === 'auth/email-already-in-use' ? "Email taken" : error.message, "error");
            return false;
        }
    },

    async updateUser(store, user) {
        try {
            const { id, password, email, ...data } = user; // Separate ID and sensitive fields
            // We DO NOT update email/password here (requires re-auth). 
            // We only update the profile data in Firestore.
            
            await updateDoc(doc(db, "users", id), data);
            
            store.logActivity('Update User', `Updated profile: ${data.username}`);
            store.notify("User Profile Updated");
            return true;
        } catch (error) {
            store.notify("Update failed: " + error.message, "error");
            return false;
        }
    },
    async updateSelf(store, { username, password }) {
        const user = auth.currentUser;
        if (!user) return;

        try {
            // 1. Update Password (if provided)
            if (password) {
                await updatePassword(user, password);
            }

            // 2. Update Firestore Profile
            if (username) {
                await updateDoc(doc(db, "users", user.uid), { username });
                store.state.currentUser.username = username; // Local update
            }

            store.notify("Profile Updated Successfully");
            return true;
        } catch (error) {
            console.error(error);
            // Re-auth might be required if session is old
            if (error.code === 'auth/requires-recent-login') {
                store.notify("Please logout and login again to change password.", "error");
            } else {
                store.notify(error.message, "error");
            }
            return false;
        }
    },
    async deleteUser(store, id) {
        await deleteDoc(doc(db, "users", id));
    }
};