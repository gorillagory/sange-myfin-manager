import { validEmail } from './inventoryCsv.js';
// Shared, framework-free contracts for checkout, receipts and reporting.
export const cents = value => Math.round((Number(value) + Number.EPSILON) * 100);
export const lineTotal = item => Math.round(cents(item.price) * Number(item.qty)) / 100;
export const money = (value, currency = 'RM') => `${currency} ${Number(value || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const isPaid = tx => tx.type === 'Invoice' && ['Paid', 'Cleared'].includes(tx.status);
export const expenseRecords = state => [...state.expenses.map(e => ({ ...e, origin: 'expenses' })), ...state.transactions.filter(t => ['Expense', 'Payment Voucher'].includes(t.type) && String(t.status || '').toLowerCase() !== 'voided').map(t => ({ ...t, amount: t.amount ?? t.total ?? 0, description: t.description || t.payee || t.number || t.type, origin: 'transactions' }))];
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
export function roundToFiveSen(value) {
  const totalCents = cents(value);
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new Error('The counter total must be a valid amount.');
  const remainder = totalCents % 5;
  const adjustmentCents = remainder === 0 ? 0 : remainder <= 2 ? -remainder : 5 - remainder;
  return { totalBeforeRounding: totalCents / 100, rounding: adjustmentCents / 100, total: (totalCents + adjustmentCents) / 100 };
}
function deliveryFeeCents(value) {
  const amount = value === undefined ? 0 : Number(value), amountCents = cents(amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1000000 ||
      !Number.isSafeInteger(amountCents) || Math.abs(amount * 100 - amountCents) >= 1e-6)
    throw new Error('The delivery fee must be an exact amount in sen.');
  return amountCents;
}
function exactDecimalUnits(value, scale) {
  const match = String(value ?? '').trim().match(/^(\d+)(?:\.(\d+))?$/);
  const fraction = match?.[2] || '';
  if (!match || fraction.length > scale) throw new Error('The accepted quote totals are invalid.');
  return BigInt(match[1]) * (10n ** BigInt(scale)) + BigInt(fraction.padEnd(scale, '0') || '0');
}
function lockedSubtotalCents(items) {
  const total = items.reduce((sum, item) => {
    const priceSen = exactDecimalUnits(item.price, 2);
    const quantityMilli = exactDecimalUnits(item.qty, 3);
    if (quantityMilli <= 0n) throw new Error('The accepted quote totals are invalid.');
    return sum + ((priceSen * quantityMilli + 500n) / 1000n);
  }, 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The accepted quote totals are invalid.');
  return Number(total);
}
export function checkoutTotalsFor(items, taxRate = 0, discount = 0, deliveryFee) {
  const totals = totalsFor(items, taxRate, discount), feeCents = deliveryFeeCents(deliveryFee);
  return { ...totals, ...(deliveryFee !== undefined ? { deliveryFee: feeCents / 100 } : {}),
    ...roundToFiveSen((cents(totals.total) + feeCents) / 100) };
}
export function saleTotalsFor(sale = {}) {
  const hasBefore=sale.totalBeforeRounding!==undefined,hasAdjustment=sale.rounding!==undefined,hasDeliveryFee=sale.deliveryFee!==undefined;
  if(sale.schemaVersion===2){if(hasBefore||hasAdjustment||hasDeliveryFee)throw new Error('Legacy receipts cannot contain counter-rounding or delivery-fee fields.');return totalsFor(sale.items,sale.taxRate,sale.discount);}
  if(sale.schemaVersion===3){if(!hasBefore||!hasAdjustment)throw new Error('Counter-rounding fields are required.');if(sale.pricingSnapshotId)return lockedCheckoutTotals(sale.items,sale);return checkoutTotalsFor(sale.items,sale.taxRate,sale.discount,hasDeliveryFee?sale.deliveryFee:undefined);}
  throw new Error('The receipt version is not supported.');
}
function lockedCheckoutTotals(items, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The accepted quote is incomplete.');
  const required = ['subtotal','discountAmount','tax','taxRate','totalBeforeRounding','rounding','total'];
  const totals = Object.fromEntries(required.map(key => [key, Number(value[key])]));
  if (required.some(key => !Number.isFinite(totals[key])) || totals.subtotal < 0 || totals.discountAmount < 0 ||
      totals.discountAmount > totals.subtotal || totals.tax < 0 || totals.taxRate < 0 || totals.taxRate > 100 ||
      totals.totalBeforeRounding < 0 || totals.total <= 0 || Math.abs(totals.rounding) > 0.02)
    throw new Error('The accepted quote totals are invalid.');
  const moneyFields = ['subtotal','discountAmount','tax','totalBeforeRounding','rounding','total'];
  if (moneyFields.some(key => Math.abs(totals[key] * 100 - cents(totals[key])) >= 1e-6))
    throw new Error('The accepted quote totals are invalid.');
  const deliveryFee = value.deliveryFee === undefined ? undefined : Number(value.deliveryFee);
  const feeCents = deliveryFeeCents(deliveryFee);
  const subtotalCents = lockedSubtotalCents(items);
  if (subtotalCents !== cents(totals.subtotal) ||
      cents(totals.subtotal) - cents(totals.discountAmount) + cents(totals.tax) + feeCents !== cents(totals.totalBeforeRounding) ||
      cents(totals.totalBeforeRounding) + cents(totals.rounding) !== cents(totals.total))
    throw new Error('The accepted quote totals are invalid.');
  return { ...totals, discount: 0, ...(deliveryFee === undefined ? {} : { deliveryFee }) };
}
export function createSale({ id, items, company, user, method, received, confirmed, customer, offline = false, discount = 0, deliveryFee, lockedTotals, pricingSnapshotId = '', overrideReason = "" }) {
  if (!items.length) throw new Error('Add an item to this order first.');
  if (overrideReason.trim() && (overrideReason.trim().length < 3 || overrideReason.trim().length > 1000)) throw new Error('Use 3 to 1,000 characters for the manager override reason.');
  if (!company?.id || !user?.uid) throw new Error('Sign in and choose a store first.');
  if (!['Cash', 'QR Pay', 'Card'].includes(method)) throw new Error('Choose a payment method.');
  if (Boolean(lockedTotals) !== Boolean(pricingSnapshotId)) throw new Error('The accepted quote is incomplete.');
  const totals = lockedTotals
    ? lockedCheckoutTotals(items, lockedTotals)
    : checkoutTotalsFor(items, company.preferences?.taxRate ?? company.preferences?.tax ?? 0, discount, deliveryFee);
  if (totals.total <= 0) throw new Error('The order total must be greater than zero.');
  const tender = method === 'Cash' ? cents(received) : cents(totals.total);
  if (!Number.isFinite(tender) || tender < cents(totals.total)) throw new Error('Enter enough cash to cover this order.');
  if (method !== 'Cash' && !confirmed) throw new Error('Confirm the payment on your merchant device first.');
  const customerEmail = String(customer?.email || '').trim();
  if (!validEmail(customerEmail)) throw new Error('Enter a valid customer email.');
  const customerId = customer?.id || (customerEmail ? `pos-${id}` : '');
  const date = new Date().toISOString();
  return { id, schemaVersion: 3, source: 'pos', company_id: company.id, cashierId: user.uid, cashierName: user.username || user.email, date, businessDate: businessDate(date), type: 'Invoice', number: `POS-${id.toUpperCase()}`, status: 'Paid', items: JSON.parse(JSON.stringify(items)), ...totals, ...(pricingSnapshotId ? { pricingSnapshotId } : {}), paymentMethod: method, received: tender / 100, change: (tender - cents(totals.total)) / 100, client_id: customerId, customerName: customer?.name || customerEmail || 'Walk-in customer', customerEmail, offline, receiptTemplateId:company.receiptTemplate?.id||'', receiptTemplateVersion:Number(company.receiptTemplate?.version||0), ...(overrideReason.trim()?{overrideReason:overrideReason.trim()}:{}), storeSnapshot: { name: company.name || '', address: company.address || '', phone: company.phone || '', registration: company.registration || '', currency: company.preferences?.currency || 'RM', footer: company.preferences?.receiptFooter || 'Thank you for shopping with us.', paperWidth: company.preferences?.paperWidth || '80' } };
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
