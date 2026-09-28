import { doc, runTransaction } from 'firebase/firestore';
import { deductItems, totalsFor, canonical } from '../domain/pos.js';

// The sale and all inventory changes commit together. Retrying a stable ID
// returns the original sale, including after a lost commit response.
export async function postSaleTo(db, sale) {
  const { syncError, syncStatus, ...clean } = sale;
  return runTransaction(db, async tx => {
    const ref = doc(db, 'transactions', sale.id);
    const existing = await tx.get(ref);
    if (existing.exists()) {
      const saved = existing.data();
      if (saved.company_id !== sale.company_id || saved.cashierId !== sale.cashierId || JSON.stringify(canonical(saved.items)) !== JSON.stringify(canonical(sale.items)) || saved.total !== sale.total || saved.paymentMethod !== sale.paymentMethod || saved.received !== sale.received || saved.client_id !== sale.client_id || (saved.customerEmail || '') !== (sale.customerEmail || '')) throw new Error('This receipt ID belongs to another order. Contact the store manager.');
      return { id: existing.id, ...saved };
    }
    const ids = [...new Set(sale.items.map(i => i.productId))];
    if (ids.length > 100) throw new Error('Split this order into fewer than 100 different products.');
    const products = [];
    for (const id of ids) {
      const snapshot = await tx.get(doc(db, 'products', id));
      if (!snapshot.exists() || snapshot.data().company_id !== sale.company_id) throw new Error('A product is no longer available in this store.');
      products.push({ ...snapshot.data(), id });
    }
    const totals = totalsFor(sale.items, sale.taxRate, sale.discount);
    if (totals.total !== sale.total) throw new Error('Order totals do not match.');
    const { updates, movements, shortage } = deductItems(products, sale.items, sale.offline === true);
    // Save customer details in the same commit; offline sales carry the email
    // in their durable outbox and create the contact when they sync.
    let customerRef, customer;
    if (sale.customerEmail && sale.client_id) {
      customerRef = doc(db, 'clients', sale.client_id);
      const snapshot = await tx.get(customerRef);
      customer = snapshot.exists() ? snapshot.data() : null;
      if (customer && customer.company_id !== sale.company_id) throw new Error('Customer belongs to another store.');
    }
    const saved = { ...clean, stockShortage: shortage };
    delete saved.id;
    tx.set(ref, saved);
    if (customerRef) tx.set(customerRef, { ...(customer || {name:sale.customerName,type:'Client'}), company_id:sale.company_id, email:sale.customerEmail }, {merge:true});
    for (const product of updates) tx.update(doc(db, 'products', product.id), { stock: product.stock, variants: product.variants });
    tx.set(doc(db, 'stock_movements', sale.id), { company_id: sale.company_id, saleId: sale.id, date: sale.date, cashierId: sale.cashierId, movements, shortage });
    tx.set(doc(db, 'activities', sale.id), { company_id: sale.company_id, date: sale.date, action: 'POS sale', details: `${sale.number} · ${sale.paymentMethod} · ${sale.total.toFixed(2)}${shortage ? ' · Stock needs review' : ''}`, user: sale.cashierName, actorId: sale.cashierId });
    return { id: sale.id, ...saved };
  });
}
