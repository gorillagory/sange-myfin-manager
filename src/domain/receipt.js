import { validEmail } from './inventoryCsv.js';
import { presentReceipt, documentTextLines } from './documentPresentation.js';
export function receiptLines(sale) { return documentTextLines(presentReceipt(sale)); }
export function receiptMailto(sale,email) {
  email=email.trim();if(!email||!validEmail(email))throw new Error('Enter a valid customer email.');
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(`Receipt ${sale.number} — ${sale.companySnapshot?.name||sale.storeSnapshot?.name||'MyFin'}`)}&body=${encodeURIComponent(receiptLines(sale).join('\r\n'))}`;
}
export function receiptPrintJob(sale,paperWidth='80') {
  return {version:2,type:'receipt',paperWidthMm:paperWidth==='58'?58:80,saleId:sale.id,number:sale.number,lines:receiptLines(sale)};
}
