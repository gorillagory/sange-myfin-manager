import { api, companyPath } from './api.js';
import { normalizeShiftList, normalizeStoreNetwork } from '../domain/storeNetwork.js';
import { terminalDeviceProfile } from './terminalIdentity.js';

const networkPath = store => companyPath(store, '/store-network');
export function networkRecordBody(value = {}) {
  const { id, ...body }=value;
  if(!id){delete body.status;delete body.version;}
  return body;
}
export const loadStoreNetwork = async store => normalizeStoreNetwork(await api(networkPath(store)));
export const saveStoreNetworkPolicy = async (store, policy) => normalizeStoreNetwork(await api(networkPath(store), { method:'PUT', body:policy }));
export const saveNetworkRecord = async (store, kind, value) => {
  const plural = kind === 'store' ? 'stores' : kind === 'location' ? 'locations' : 'terminals';
  const suffix = `/${plural}${value.id ? `/${encodeURIComponent(value.id)}` : ''}`;
  const { id }=value,body=networkRecordBody(value);
  return api(networkPath(store) + suffix, { method:id ? 'PATCH' : 'POST', body });
};
export const issueTerminalEnrollment = (store, terminalId, expiresInMinutes = 15) => api(`${networkPath(store)}/terminals/${encodeURIComponent(terminalId)}/enrollment`, { method:'POST', body:{expiresInMinutes} });
export const saveStaffAssignments = (store, identityId, locationIds) => api(`${networkPath(store)}/staff/${encodeURIComponent(identityId)}/assignments`, { method:'PUT', body:{locationIds} });

export async function claimTerminal(token) {
  return api('/terminal-enrollment/claim', { method:'POST', body:{token:String(token).trim(), device:terminalDeviceProfile()}, skipSessionExpiry:true });
}

export async function loadTerminalContext() {
  return api('/terminal-context', { skipSessionExpiry:true });
}

export async function sendTerminalHeartbeat() {
  const profile = terminalDeviceProfile();
  return api('/terminal-context/heartbeat', { method:'POST', body:{appVersion:profile.appVersion, state:'online', connectivity:'online'}, skipSessionExpiry:true });
}

export const signOutTerminalStaff = () => api('/terminal-context/staff-sign-out', {
  method:'POST', body:{}, skipSessionExpiry:true,
});

const shiftsPath = store => companyPath(store, '/register-shifts');
export const loadRegisterShifts = async store => normalizeShiftList(await api(shiftsPath(store)));
export const openRegisterShift = (store, body) => api(shiftsPath(store) + '/open', { method:'POST', body });
export const joinRegisterShift = (store, registerShiftId) => api(shiftsPath(store) + '/join', { method:'POST', body:{registerShiftId} });
export const recordRegisterCash = (store, body) => api(shiftsPath(store) + '/cash-entry', { method:'POST', body });
export const closeRegisterShift = (store, body) => api(shiftsPath(store) + '/close', { method:'POST', body });
export const updateStaffShift = (store, action, body = {}) => api(companyPath(store, `/staff-shifts/${action}`), { method:'POST', body });
