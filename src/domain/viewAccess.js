import { hasModuleAccess, permissionsFor } from './permissions.js';
export const ROUTE_CAPABILITIES = {
  '/overview':'active', '/pos':'checkout', '/orders':'checkout', '/storefront':'storefrontManage', '/kitchen':'checkout', '/sales':'documentsRead', '/documents':'documentsRead',
  '/receipt-reviews':'receiptReviewsRead', '/products':'inventoryRead', '/stock':'inventoryRead', '/procurement':'inventoryRead', '/contacts':'clientsRead', '/profile':'active',
  '/analytics':'analyticsRead', '/consolidation':'analyticsRead', '/finance-sales':'financialReports', '/payment-operations':'paymentOperationsRead', '/cashbook':'financialReports', '/expenses':'expensesRead',
  '/companies':'companyWrite', '/users':'usersManage', '/activity':'activityRead', '/marketing':'marketingRead', '/student-programs':'studentProgramsRead',
  '/templates':'templatesWrite', '/settings':'deviceSettingsWrite', '/integrations':'integrationsRead',
};
export const ROUTE_MODULES = Object.freeze({
  '/pos':'workspace','/orders':'workspace','/storefront':'workspace','/kitchen':'workspace',
  '/products':'inventory','/stock':'inventory','/procurement':'inventory',
  '/finance-sales':'finance','/payment-operations':'finance','/cashbook':'finance','/documents':'finance','/sales':'finance','/expenses':'finance','/receipt-reviews':'finance',
  '/analytics':'analytics','/consolidation':'analytics','/marketing':'analytics','/student-programs':'analytics',
  '/contacts':'administration','/companies':'administration','/activity':'administration',
  '/settings':'settings','/templates':'settings','/integrations':'settings','/users':'access',
});
export function canVisit(user,path) {
  if (path === '/consolidation' && user?.authLevel === 'pos_code') return false;
  const module=ROUTE_MODULES[path];
  if(module&&!hasModuleAccess(user,module))return false;
  return permissionsFor(user)[ROUTE_CAPABILITIES[path] || 'active'] === true;
}
export function hydrationCollections(user) {
  const p = permissionsFor(user);
  if (!p.active) return [];
  return [...(p.catalogRead ? ['products'] : []),...(p.transactionsRead ? ['transactions'] : []),...((p.clientsRead||p.suppliersRead) ? ['clients'] : []),
    ...(p.expensesRead ? ['expenses'] : []),
    ...(p.activityRead ? ['activities'] : []),
    ...(p.inventoryRead ? ['stock_items'] : []),
    ...(p.stockHistoryRead ? ['stock_movements','stock_ledger'] : []),
  ];
}
export function manageableAccount(actor,target) {
  const p = permissionsFor(actor);
  return p.usersManage && (!target || p.owner ||
    ((target.assignments||[{company_id:target.company_id,role:target.role}]).some(x=>['operator','company_user'].includes(x.role)&&x.company_id===actor.company_id)));
}
