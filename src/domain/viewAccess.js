import { permissionsFor } from './permissions.js';
export const ROUTE_CAPABILITIES = {
  '/overview':'checkout', '/pos':'checkout', '/orders':'checkout', '/sales':'documentsRead', '/documents':'documentsRead',
  '/receipt-reviews':'checkout', '/products':'inventoryRead', '/contacts':'clientsRead', '/profile':'active',
  '/analytics':'financialReports', '/consolidation':'financialReports', '/finance-sales':'financialReports', '/expenses':'expensesRead', '/stock':'inventoryRead',
  '/companies':'companyWrite', '/users':'usersManage', '/activity':'activityRead',
  '/templates':'templatesWrite', '/settings':'deviceSettingsWrite',
};
export function canVisit(user,path) {
  if (path === '/consolidation' && user?.authLevel === 'pos_code') return false;
  return permissionsFor(user)[ROUTE_CAPABILITIES[path] || 'active'] === true;
}
export function hydrationCollections(user) {
  const p = permissionsFor(user);
  if (!p.active) return [];
  return ['products','transactions','clients',
    ...(p.expensesRead ? ['expenses'] : []),
    ...(p.activityRead ? ['activities'] : []),
    'stock_items',
    ...(p.stockHistoryRead ? ['stock_movements','stock_ledger'] : []),
  ];
}
export function manageableAccount(actor,target) {
  const p = permissionsFor(actor);
  return p.usersManage && (!target || p.owner ||
    ((target.assignments||[{company_id:target.company_id,role:target.role}]).some(x=>['operator','company_user'].includes(x.role)&&x.company_id===actor.company_id)));
}
