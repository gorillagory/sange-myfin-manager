import { collection, addDoc, deleteDoc, doc, updateDoc } from "firebase/firestore";
// THE MISSING IMPORT WAS HERE:
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { db, storage } from '../firebase'; 

export const financeModule = {
    async addTransaction(store, transaction) {
        try {
            // Force status if not provided
            if(!transaction.status) transaction.status = 'Paid';
            
            // Force company_id
            transaction.company_id = store.state.selectedCompany?.id;

            await addDoc(collection(db, "transactions"), transaction);
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
            store.notify("Update failed", "error");
        }
    },

    async deleteTransaction(store, id) {
        if (!store.canDelete()) return store.notify("Access Denied", "error");
        await deleteDoc(doc(db, "transactions", id));
        store.notify("Transaction Deleted");
    },

    // --- EXPENSES WITH FILE UPLOAD ---
    async addExpense(store, { file, ...expenseData }) {
        try {
            let receiptData = null;

            // 1. Upload File (if exists)
            if (file) {
                const uniqueName = `receipts/${Date.now()}_${file.name}`;
                // This line caused your error because storageRef wasn't imported
                const fileRef = storageRef(storage, uniqueName);
                
                const snapshot = await uploadBytes(fileRef, file);
                const url = await getDownloadURL(snapshot.ref);

                receiptData = {
                    url: url,
                    path: uniqueName, // Needed for deletion later
                    type: file.type,
                    name: file.name
                };
            }

            // 2. Prepare Data
            const cleanExp = JSON.parse(JSON.stringify(expenseData));
            delete cleanExp.id;
            
            cleanExp.company_id = store.state.selectedCompany?.id;
            cleanExp.receipt = receiptData; // Attach the file metadata

            // 3. Save to Firestore
            await addDoc(collection(db, "expenses"), cleanExp);
            
            store.logActivity('Expense', `Recorded: ${expenseData.description} (${expenseData.amount})`);
            store.notify("Expense Recorded");
        } catch (e) {
            console.error(e);
            store.notify("Error: " + e.message, "error");
        }
    },

    async deleteExpense(store, expense) {
        if (!store.canDelete()) return store.notify("Access Denied", "error");

        try {
            // 1. Delete File from Storage (if exists)
            if (expense.receipt && expense.receipt.path) {
                const fileRef = storageRef(storage, expense.receipt.path);
                await deleteObject(fileRef).catch(err => console.log("File maybe already gone:", err));
            }

            // 2. Delete Record from Firestore
            // Handle both object input and ID input for backward compatibility
            const id = expense.id || expense;
            await deleteDoc(doc(db, "expenses", id));
            store.notify("Expense Removed");
        } catch (e) {
            store.notify("Delete failed: " + e.message, "error");
        }
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