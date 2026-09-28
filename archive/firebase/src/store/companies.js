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
        if (cleanCo.preferences && Object.hasOwn(cleanCo.preferences, 'tax')) cleanCo.preferences.taxRate = Number(cleanCo.preferences.tax);
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

    async updatePreferences(store, prefs) {
        if (!store.state.selectedCompany) throw new Error('Choose a store first.');
        const clean = JSON.parse(JSON.stringify(prefs));
        const fields = Object.fromEntries(Object.entries(clean).map(([key, value]) => [`preferences.${key}`, value]));
        await updateDoc(doc(db, 'companies', store.state.selectedCompany.id), fields);
        store.state.preferences = { ...store.state.selectedCompany.preferences, ...clean };
        store.logActivity('Update preferences', 'Updated store preferences');
    }
};
