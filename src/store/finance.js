import { db } from '../firebase';
import { collection, addDoc, updateDoc, deleteDoc, doc } from "firebase/firestore";

export const financeModule = {
    async addTransaction(store, tx) {
        try {
            const cleanTx = JSON.parse(JSON.stringify(tx));
            delete cleanTx.id;
            cleanTx.company_id = store.state.selectedCompany?.id; // Security Tag
            await addDoc(collection(db, "transactions"), cleanTx);
            store.logActivity('Create', `Created ${tx.type} ${tx.number}`);
        } catch (e) { store.notify("Error: " + e.message, "error"); }
    },

    async updateTransaction(store, tx) {
        try {
            const cleanTx = JSON.parse(JSON.stringify(tx));
            const id = cleanTx.id;
            delete cleanTx.id;
            await updateDoc(doc(db, "transactions", id), cleanTx);
            store.logActivity('Update', `Updated ${tx.type} ${tx.number}`);
        } catch (e) { store.notify("Error: " + e.message, "error"); }
    },

    async deleteTransaction(store, id) {
        if (!store.canDelete()) return store.notify("Access Denied", "error");
        await deleteDoc(doc(db, "transactions", id));
        store.notify("Deleted successfully");
    },

    async addClient(store, client) {
        const cleanClient = JSON.parse(JSON.stringify(client));
        delete cleanClient.id;
        cleanClient.company_id = store.state.selectedCompany?.id;
        await addDoc(collection(db, "clients"), cleanClient);
    },

    async deleteClient(store, id) {
        if (!store.canDelete()) return store.notify("Access Denied", "error");
        await deleteDoc(doc(db, "clients", id));
    }
};