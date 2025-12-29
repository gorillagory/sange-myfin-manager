import { collection, addDoc, deleteDoc, doc, updateDoc } from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { db, storage } from '../firebase'; 

export const financeModule = {
    // --- TRANSACTIONS ---
    async addTransaction(store, transaction) {
        try {
            if(!transaction.status) transaction.status = 'Paid';
            transaction.company_id = store.state.selectedCompany?.id;

            // Use the ID if provided (for overwrites), otherwise auto-gen
            if (transaction.id) {
                // Ensure we don't overwrite if it doesn't exist, or use setDoc logic if you prefer
                // For now, let's treat add as unique. 
                // If you want to force specific IDs, use setDoc from firestore import
                const { id, ...data } = transaction;
                await import("firebase/firestore").then(({ setDoc }) => 
                    setDoc(doc(db, "transactions", id), data)
                );
            } else {
                await addDoc(collection(db, "transactions"), transaction);
            }
            
            store.logActivity('New Sale', `Recorded sale: ${transaction.total}`);
            store.notify("Transaction Added");
        } catch (error) {
            console.error(error);
            store.notify("Error saving: " + error.message, "error");
        }
    },

    async updateTransaction(store, transaction) {
        try {
            const { id, ...data } = transaction;
            await updateDoc(doc(db, "transactions", id), data);
            store.notify("Transaction Updated");
        } catch (error) {
            store.notify("Update failed: " + error.message, "error");
        }
    },

    // CRITICAL FIX: Delete Logic
    async deleteTransaction(store, id) {
        // 1. Permission Check
        if (!store.canDelete()) {
            throw new Error("Access Denied: Only Admins can delete.");
        }

        // 2. Validation
        if (!id) {
            throw new Error("Invalid Transaction ID");
        }

        // 3. Perform Delete
        // We do NOT catch errors here. We let them bubble up to the Component.
        await deleteDoc(doc(db, "transactions", id));
        
        // 4. Success (Component will handle notification)
    },

    // --- EXPENSES ---
    async addExpense(store, { file, ...expenseData }) {
        try {
            let receiptData = null;

            if (file) {
                const uniqueName = `receipts/${Date.now()}_${file.name}`;
                const fileRef = storageRef(storage, uniqueName);
                
                const snapshot = await uploadBytes(fileRef, file);
                const url = await getDownloadURL(snapshot.ref);

                receiptData = {
                    url: url,
                    path: uniqueName,
                    type: file.type,
                    name: file.name
                };
            }

            const cleanExp = JSON.parse(JSON.stringify(expenseData));
            delete cleanExp.id; // Let Firestore gen ID
            
            cleanExp.company_id = store.state.selectedCompany?.id;
            cleanExp.receipt = receiptData;

            await addDoc(collection(db, "expenses"), cleanExp);
            
            store.logActivity('Expense', `Recorded: ${expenseData.description} (${expenseData.amount})`);
            store.notify("Expense Recorded");
        } catch (e) {
            console.error(e);
            store.notify("Error: " + e.message, "error");
        }
    },

    async deleteExpense(store, expense) {
        if (!store.canDelete()) {
            throw new Error("Access Denied: Only Admins can delete.");
        }

        const id = expense.id || expense;
        if (!id) throw new Error("Invalid Expense ID");

        // 1. Delete File (Best effort)
        if (expense.receipt && expense.receipt.path) {
            try {
                const fileRef = storageRef(storage, expense.receipt.path);
                await deleteObject(fileRef);
            } catch (err) {
                console.warn("Receipt file not found or already deleted");
            }
        }

        // 2. Delete Doc
        await deleteDoc(doc(db, "expenses", id));
    },

    // --- CLIENTS ---
    async addClient(store, client) {
        try {
            client.company_id = store.state.selectedCompany?.id;
            await addDoc(collection(db, "clients"), client);
            store.notify("Client Added");
        } catch (e) { store.notify("Error: " + e.message, "error"); }
    },

    async deleteClient(store, id) {
        if (!store.canDelete()) return store.notify("Access Denied", "error");
        await deleteDoc(doc(db, "clients", id));
        store.notify("Client Removed");
    }
};