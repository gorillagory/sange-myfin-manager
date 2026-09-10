import { collection, addDoc, deleteDoc, doc, updateDoc, writeBatch, setDoc, getDoc, runTransaction } from "firebase/firestore";
import { db } from '../firebase';

export const financeModule = {
    // --- TRANSACTIONS ---
    async addTransaction(store, transaction) {
        try {
            if(!transaction.status) transaction.status = 'Paid';
            transaction.company_id = store.state.selectedCompany?.id;

            if (transaction.id) {
                const { id, ...data } = transaction;
                await setDoc(doc(db, "transactions", id), data);
            } else {
                await addDoc(collection(db, "transactions"), transaction);
            }
            
            store.logActivity('New Sale', `Recorded sale: ${transaction.total}`);
            store.notify("Transaction Added");
            return transaction;
        } catch (error) {
            console.error(error);
            store.notify("Error saving: " + error.message, "error");
            throw error;
        }
    },

    async updateTransaction(store, transaction) {
        try {
            const { id, ...data } = transaction;
            const saved = await getDoc(doc(db, "transactions", id));
            if (saved.data()?.source === "pos") throw new Error("Posted POS sales cannot be edited. Open the receipt instead.");
            await updateDoc(doc(db, "transactions", id), data);
            store.notify("Transaction Updated");
        } catch (error) {
            store.notify("Update failed: " + error.message, "error");
            throw error;
        }
    },

    async deleteTransaction(store, id) {
        if (!store.canDelete()) throw new Error("Access Denied: Only Admins can delete.");
        if (!id) throw new Error("Invalid Transaction ID");
        const saved = await getDoc(doc(db, "transactions", id));
        if (saved.data()?.source === "pos") throw new Error("Posted POS sales cannot be deleted.");
        await deleteDoc(doc(db, "transactions", id));
    },

    async convertQuote(store, quote) {
        const id = crypto.randomUUID().replaceAll('-', '').slice(0, 20);
        return runTransaction(db, async tx => {
            const ref = doc(db, 'transactions', quote.id);
            const snapshot = await tx.get(ref);
            if (!snapshot.exists() || snapshot.data().company_id !== store.state.selectedCompany.id) throw new Error('Quote not found.');
            const data = snapshot.data();
            if (data.status === 'Converted') return data.convertedTo;
            if (data.type !== 'Quote') throw new Error('Only a quote can be converted.');
            tx.set(doc(db, 'transactions', id), { ...data, type: 'Invoice', number: 'INV-' + id.toUpperCase(), status: 'Pending', date: new Date().toISOString(), quoteId: quote.id });
            tx.update(ref, { status: 'Converted', convertedTo: id });
            return id;
        });
    },

    // --- PROJECT BATCHING ---
    // Safe, atomic updates using Firestore writeBatch
    async assignProject(store, { ids, projectName }) {
        if (!ids || !ids.length) return;
        
        try {
            const batch = writeBatch(db);
            ids.forEach(id => {
                const ref = doc(db, "transactions", id);
                batch.update(ref, { project: projectName });
            });
            await batch.commit();
            store.notify(`Assigned ${ids.length} items to "${projectName}"`);
        } catch (e) {
            store.notify("Project assignment failed: " + e.message, "error");
        }
    },

    // --- EXPENSES ---
    // Notice: All Firebase Storage logic has been removed. 
    // The UI handles the upload via useStorage.js and passes the final URL here.
    async addExpense(store, expenseData) {
        try {
            const cleanExp = JSON.parse(JSON.stringify(expenseData));
            const id = cleanExp.id;
            delete cleanExp.id;
            cleanExp.company_id = store.state.selectedCompany?.id;

            if (id) {
                // If ID exists, we are updating an existing expense
                await setDoc(doc(db, "expenses", id), cleanExp);
            } else {
                // Otherwise, create new
                await addDoc(collection(db, "expenses"), cleanExp);
            }
            
            store.logActivity('Expense', `Recorded: ${cleanExp.description} (${cleanExp.amount})`);
            // Notification is handled by the UI component now to prevent double-toasting
        } catch (e) {
            console.error(e);
            store.notify("Error: " + e.message, "error");
            throw e; // Throw so the UI can catch and stop the loading spinner
        }
    },

    async deleteExpense(store, expenseId) {
        if (!store.canDelete()) throw new Error("Access Denied: Only Admins can delete.");
        if (!expenseId) throw new Error("Invalid Expense ID");
        
        // Notice: File deletion is handled by ExpensesTab.vue BEFORE calling this.
        await deleteDoc(doc(db, "expenses", expenseId));
    },

    // --- CLIENTS ---
    async addClient(store, client) {
        try {
            const cleanClient = JSON.parse(JSON.stringify(client));
            const id = cleanClient.id;
            delete cleanClient.id;
            cleanClient.company_id = store.state.selectedCompany?.id;

            if (id) {
                await setDoc(doc(db, "clients", id), cleanClient);
            } else {
                await addDoc(collection(db, "clients"), cleanClient);
            }
        } catch (e) { 
            store.notify("Error: " + e.message, "error"); 
            throw e;
        }
    },

    async deleteClient(store, id) {
        if (!store.canDelete()) throw new Error("Only a manager can delete contacts.");
        await deleteDoc(doc(db, "clients", id));
    }
};