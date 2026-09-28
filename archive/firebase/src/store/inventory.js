import { collection, addDoc, deleteDoc, doc, updateDoc, writeBatch, getDocsFromServer, query, where } from "firebase/firestore";
import { db } from '../firebase';
import { normalizeProduct } from '../domain/pos';
import { validateProduct } from '../domain/inventoryCsv';

export const inventoryModule = {
    async importProducts(store, products) {
        if (!navigator.onLine) throw new Error('Connect to the internet to import products.');
        if (!products.length || products.length > 300) throw new Error('Import between 1 and 300 products.');
        const companyId = store.state.selectedCompany.id;
        const snapshot = await getDocsFromServer(query(collection(db, 'products'), where('company_id','==',companyId)));
        const existing = snapshot.docs.map(d => ({...d.data(),id:d.id}));
        const batch = writeBatch(db);
        for (const p of products) {
            validateProduct(p, existing);
            existing.push(p);
            const data = normalizeProduct(JSON.parse(JSON.stringify(p)));
            delete data.id;
            batch.set(doc(collection(db,'products')), {...data, company_id:companyId});
        }
        if (store.state.selectedCompany.id !== companyId) throw new Error('Store changed. Select your CSV again.');
        await batch.commit();
    },
    // --- PRODUCT MANAGEMENT ---
    async addProduct(store, product) {
        try {
            const cleanProd = normalizeProduct(JSON.parse(JSON.stringify(product)));
            delete cleanProd.id;
            cleanProd.company_id = store.state.selectedCompany?.id;
            
            // Standardize Numbers
            if (!cleanProd.variants || cleanProd.variants.length === 0) {
                cleanProd.price = Number(cleanProd.price);
                cleanProd.cost = Number(cleanProd.cost);
                cleanProd.stock = Number(cleanProd.stock);
            } else {
                // Ensure variant numbers are numbers
                cleanProd.variants = cleanProd.variants.map(v => ({
                    ...v,
                    price: Number(v.price),
                    cost: Number(v.cost),
                    stock: Number(v.stock)
                }));
            }

            await addDoc(collection(db, "products"), cleanProd);
            store.notify("Product Added");
        } catch (e) {
            store.notify("Error: " + e.message, "error");
            throw e;
        }
    },

    async updateProduct(store, product) {
        try {
            const { id, ...data } = normalizeProduct(JSON.parse(JSON.stringify(product)));
            // Standardize Numbers again before save
             if (data.variants && data.variants.length > 0) {
                data.variants = data.variants.map(v => ({...v, price: Number(v.price), cost: Number(v.cost), stock: Number(v.stock)}));
            } else {
                data.price = Number(data.price);
                data.cost = Number(data.cost);
                data.stock = Number(data.stock);
            }

            await updateDoc(doc(db, "products", id), data);
            store.notify("Product Updated");
        } catch (e) {
            store.notify("Update failed: " + e.message, "error");
            throw e;
        }
    },

    async deleteProduct(store, id) {
        if (!store.canDelete()) return store.notify("Access Denied", "error");
        await deleteDoc(doc(db, "products", id));
        store.notify("Product Deleted");
    },

};
