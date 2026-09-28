import { stripConfidential } from './permissions.js';
// This is a cache format version, not a grant. Online API projections authorize data.
export const CACHE_POLICY_VERSION = 3;
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
export const safePaidSale = value => stripConfidential(copy(value));
export const safeDraft = value => stripConfidential(copy(value));
export function safeCatalog(value = {}) {
  const data = stripConfidential(copy(value));
  return {
    cachePolicyVersion: CACHE_POLICY_VERSION,
    products: data.products || [],
    clients: (data.clients || []).filter(client => client.type !== 'Supplier'),
  };
}
export function safeCompany(company = {}) {
  const data = stripConfidential(copy(company));
  const allowed = ['id','name','address','phone','email','registration','logo','logoUrl','logoPath','qrCode','qrCodeUrl','qrCodePath','archived','archived_at','receiptTemplate'];
  const preferences = data.preferences || {};
  const preferenceKeys = ['currency','tax','taxRate','staffDiscountLimit','receiptFooter','paperWidth','density','reduceMotion','theme','receiptTemplate','receiptTemplateSnapshot'];
  return {
    ...Object.fromEntries(allowed.filter(key => data[key] !== undefined).map(key => [key,data[key]])),
    preferences: Object.fromEntries(preferenceKeys.filter(key => preferences[key] !== undefined).map(key => [key,preferences[key]])),
  };
}
export function safeProfile(value = {}) {
  const data = stripConfidential(copy(value));
  const user = data.user || {};
  return {
    cachePolicyVersion: CACHE_POLICY_VERSION,
    verifiedAt: data.verifiedAt || null,
    user: Object.fromEntries(['id','uid','username','email','role','company_id'].filter(key => user[key] !== undefined).map(key => [key,user[key]])),
    companies: (data.companies || []).map(safeCompany),
  };
}

export function localReceiptPresentation(sale, company) {
  return safePaidSale({...sale,
    ...(company.receiptTemplate?.settings ? {templateSnapshot:copy(company.receiptTemplate.settings)} : {}),
    companySnapshot:{name:company.name||'',address:company.address||'',phone:company.phone||'',email:company.email||'',registration:company.registration||'',logo:company.logo||company.logoUrl||null,qrCode:company.qrCode||company.qrCodeUrl||null,
      preferences:{currency:company.preferences?.currency||'RM',receiptFooter:company.preferences?.receiptFooter||'',paperWidth:company.preferences?.paperWidth||'80'}},
  });
}

export function needsReceiptReview(error) {
  const code=typeof error==='string'?error:error?.message;
  return typeof code==='string' && (code==='receipt_review_required' || code.startsWith('receipt_review_required_') || ['manager_override_reason_required','stock_unavailable'].includes(code));
}
