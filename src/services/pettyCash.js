import { api, companyPath } from './api.js';

const path = (store, suffix) => companyPath(store, `/petty-cash${suffix}`);

export const listPettyCashFunds = store => api(path(store, '/funds'));

export const createPettyCashFund = (store, value) => api(path(store, '/funds'), {
  method: 'POST', body: value,
});

export const updatePettyCashFund = (store, fundId, value) => api(path(store, `/funds/${encodeURIComponent(fundId)}`), {
  method: 'PATCH', body: value,
});

export const listPettyCashEntries = (store, fundId, { after = '', limit = 100 } = {}) => {
  const query = new URLSearchParams({ limit: String(limit) });
  if (after) query.set('after', after);
  return api(path(store, `/funds/${encodeURIComponent(fundId)}/entries?${query}`));
};

export const postPettyCashEntry = (store, fundId, value) => api(path(store, `/funds/${encodeURIComponent(fundId)}/entries`), {
  method: 'POST', body: value,
});

export const listExpensePayments = (store, expenseId) => api(companyPath(store, `/expenses/${encodeURIComponent(expenseId)}/payments`));

export const postExpensePayment = (store, expenseId, value) => api(companyPath(store, `/expenses/${encodeURIComponent(expenseId)}/payments`), {
  method: 'POST', body: value,
});

export const reverseExpensePayment = (store, expenseId, paymentId, value) => api(companyPath(store, `/expenses/${encodeURIComponent(expenseId)}/payments/${encodeURIComponent(paymentId)}/reverse`), {
  method: 'POST', body: value,
});
