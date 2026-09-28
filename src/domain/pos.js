import { validEmail } from './inventoryCsv.js';
// Shared, framework-free contracts for checkout, receipts and reporting.
export const cents = value => Math.round((Number(value) + Number.EPSILON) * 100);
export const lineTotal = item => Math.round(cents(item.price) * Number(item.qty)) / 100;
export const money = (value, currency = 'RM') => `${currency} ${Number(value || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const isPaid = tx => tx.type === 'Invoice' && ['Paid', 'Cleared'].includes(tx.status);
export const expenseRecords = state => [...state.expenses.map(e => ({ ...e, origin: 'expenses' })), ...state.transactions.filter(t => ['Expense', 'Payment Voucher'].includes(t.type)).map(t => ({ ...t, amount: t.amount ?? t.total ?? 0, description: t.description || t.payee || t.number || t.type, origin: 'transactions' }))];
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function businessDate(value = new Date(), timeZone = 'Asia/Kuala_Lumpur') {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function normalizeProduct(product) {
  const variants = (product.variants || []).map((v, i) => ({ ...v, id: v.id || `legacy-${i}`, price: Number(v.price || 0), cost: Number(v.cost || 0), stock: Number(v.stock || 0) }));
  const hasStock = product.stock != null || (product.variants || []).some(v => v.stock != null);
  return { ...product, sku: product.sku || product.code || '', price: Number(product.price || 0), cost: Number(product.cost || 0), stock: Number(product.stock || 0), unit: product.unit || 'pcs', variants, trackStock: product.category !== 'Service' && (product.trackStock ?? hasStock) };
}
export function cartItem(product, variant) {
  const p = normalizeProduct(product), v = variant && p.variants.find(v => v.id === variant.id);
  if (variant && !v) throw new Error('This option is no longer available.');
  return { productId: p.id, variantId: v?.id || '', variant: v?.name || '', sku: v?.sku || p.sku, desc: p.name + (v ? ` (${v.name})` : ''), price: v?.price ?? p.price, cost: v?.cost ?? p.cost, unit: p.unit, qty: 1 };
}
export function totalsFor(items, taxRate = 0, discount = 0) {
  const rate = Number(taxRate), off = Number(discount);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100 || !Number.isFinite(off) || off < 0 || off > 100) throw new Error('Check the tax and discount percentages.');
  const subtotalCents = items.reduce((sum, i) => {
    if (!Number.isFinite(Number(i.qty)) || Number(i.qty) <= 0 || !Number.isFinite(Number(i.price)) || Number(i.price) < 0) throw new Error('Every item needs a valid quantity and price.');
    return sum + Math.round(cents(i.price) * Number(i.qty));
  }, 0);
  const discountCents = Math.round(subtotalCents * off / 100);
  const taxCents = Math.round((subtotalCents - discountCents) * rate / 100);
  return { subtotal: subtotalCents / 100, discountAmount: discountCents / 100, tax: taxCents / 100, total: (subtotalCents - discountCents + taxCents) / 100, taxRate: rate, discount: off };
}
export function createSale({ id, items, company, user, method, received, confirmed, customer, offline = false, discount = 0, overrideReason = "" }) {
  if (!items.length) throw new Error('Add an item to this order first.');
  if (overrideReason.trim() && (overrideReason.trim().length < 3 || overrideReason.trim().length > 1000)) throw new Error('Use 3 to 1,000 characters for the manager override reason.');
  if (!company?.id || !user?.uid) throw new Error('Sign in and choose a store first.');
  if (!['Cash', 'QR Pay', 'Card'].includes(method)) throw new Error('Choose a payment method.');
  const totals = totalsFor(items, company.preferences?.taxRate ?? company.preferences?.tax ?? 0, discount);
  if (totals.total <= 0) throw new Error('The order total must be greater than zero.');
  const tender = method === 'Cash' ? cents(received) : cents(totals.total);
  if (!Number.isFinite(tender) || tender < cents(totals.total)) throw new Error('Enter enough cash to cover this order.');
  if (method !== 'Cash' && !confirmed) throw new Error('Confirm the payment on your merchant device first.');
  const customerEmail = String(customer?.email || '').trim();
  if (!validEmail(customerEmail)) throw new Error('Enter a valid customer email.');
  const customerId = customer?.id || (customerEmail ? `pos-${id}` : '');
  const date = new Date().toISOString();
  return { id, schemaVersion: 2, source: 'pos', company_id: company.id, cashierId: user.uid, cashierName: user.username || user.email, date, businessDate: businessDate(date), type: 'Invoice', number: `POS-${id.toUpperCase()}`, status: 'Paid', items: JSON.parse(JSON.stringify(items)), ...totals, paymentMethod: method, received: tender / 100, change: (tender - cents(totals.total)) / 100, client_id: customerId, customerName: customer?.name || customerEmail || 'Walk-in customer', customerEmail, offline, receiptTemplateId:company.receiptTemplate?.id||'', receiptTemplateVersion:Number(company.receiptTemplate?.version||0), ...(overrideReason.trim()?{overrideReason:overrideReason.trim()}:{}), storeSnapshot: { name: company.name || '', address: company.address || '', phone: company.phone || '', registration: company.registration || '', currency: company.preferences?.currency || 'RM', footer: company.preferences?.receiptFooter || 'Thank you for shopping with us.', paperWidth: company.preferences?.paperWidth || '80' } };
}
export function deductItems(products, items, allowShortage = false) {
  const updates = new Map(), movements = [];
  for (const item of items) {
    if (!item.productId || !Number.isFinite(Number(item.qty)) || Number(item.qty) <= 0) throw new Error('An item is missing a valid product or quantity.');
    const original = products.find(p => p.id === item.productId);
    if (!original) throw new Error(`${item.desc}: product no longer exists. Review this order.`);
    const product = updates.get(item.productId) || normalizeProduct(structuredClone(original));
    const variant = item.variantId ? product.variants.find(v => v.id === item.variantId) : null;
    if (item.variantId && !variant) throw new Error(`${item.desc}: option no longer exists. Review this order.`);
    if (product.variants.length && !variant) throw new Error(`${item.desc}: choose an option.`);
    if (!product.trackStock) continue;
    const target = variant || product;
    const nextStock = Math.round((target.stock - Number(item.qty)) * 1000) / 1000;
    if (nextStock < 0 && !allowShortage) throw new Error(`${item.desc}: only ${target.stock} ${product.unit} available.`);
    target.stock = nextStock;
    updates.set(product.id, product);
    movements.push({ productId: product.id, variantId: item.variantId || '', quantity: -Number(item.qty), stockAfter: nextStock });
  }
  return { updates: [...updates.values()], movements, shortage: movements.some(m => m.stockAfter < 0) };
}
