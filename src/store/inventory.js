import { db } from '../firebase';
import { collection, addDoc, deleteDoc, doc } from "firebase/firestore";

export const inventoryModule = {
    async addProduct(store, product) {
        const cleanProd = JSON.parse(JSON.stringify(product));
        delete cleanProd.id;
        cleanProd.company_id = store.state.selectedCompany?.id; // Security Tag
        await addDoc(collection(db, "products"), cleanProd);
    },

    async deleteProduct(store, id) {
        if (!store.canDelete()) return store.notify("Access Denied", "error");
        await deleteDoc(doc(db, "products", id));
    }
};