import { db } from '../firebase';
import { collection, addDoc, updateDoc, deleteDoc, doc } from "firebase/firestore";

export const companiesModule = {
    async addCompany(store, company) {
        const cleanCo = JSON.parse(JSON.stringify(company));
        delete cleanCo.id;
        await addDoc(collection(db, "companies"), cleanCo);
        store.logActivity('Create Company', `Registered: ${company.name}`);
    },

    async updateCompany(store, company) {
        const cleanCo = JSON.parse(JSON.stringify(company));
        const id = cleanCo.id;
        delete cleanCo.id;
        await updateDoc(doc(db, "companies", id), cleanCo);
        store.logActivity('Update Company', `Updated: ${company.name}`);
    },

    async deleteCompany(store, id) {
        await deleteDoc(doc(db, "companies", id));
    },

    selectCompany(store, co) {
        store.state.selectedCompany = co;
        store.startListeners(); // Refresh data for new company
    },

    updatePreferences(store, prefs) {
        store.state.preferences = prefs;
        if (store.state.selectedCompany) {
             const coRef = doc(db, "companies", store.state.selectedCompany.id);
             updateDoc(coRef, { preferences: prefs });
        }
    }
};