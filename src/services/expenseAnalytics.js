import { api, companyPath } from './api.js';

const date = value => String(value || '').trim();

export function expenseInsightsSnapshot(store, { from, to, grain = 'month' } = {}) {
  const user = store?.state?.currentUser || {};
  const moduleGrants = Array.isArray(user.module_grants)
    ? [...new Set(user.module_grants.map(date).filter(Boolean))].sort().join(',')
    : user.module_grants === null ? '*' : '';
  return Object.freeze({
    companyId:date(store?.state?.selectedCompany?.id),
    actorId:date(user.id || user.uid),
    role:date(user.role),
    moduleGrants,
    reportAccess:Boolean(store?.can?.('expenseReportsRead')),
    from:date(from),
    to:date(to),
    grain:date(grain || 'month'),
  });
}

export const expenseInsightsSnapshotKey = value => [
  value?.companyId,value?.actorId,value?.role,value?.moduleGrants,value?.reportAccess ? '1' : '0',
  value?.from,value?.to,value?.grain,
].map(date).join('\u0000');

export function getExpenseInsights(store, { from, to, grain = 'month' } = {}) {
  const query = new URLSearchParams({ from:date(from), to:date(to), grain:String(grain || 'month') });
  return api(companyPath(store, `/expense-insights?${query}`));
}

export function getExpenseClaimReport(store, expenseId) {
  return api(companyPath(store, `/expenses/${encodeURIComponent(expenseId)}/claim-report`));
}
