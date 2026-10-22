export const STORE_TYPES = Object.freeze([
  Object.freeze({ value:'branch', label:'Branch' }),
  Object.freeze({ value:'outlet', label:'Outlet' }),
  Object.freeze({ value:'kiosk', label:'Kiosk' }),
  Object.freeze({ value:'warehouse', label:'Warehouse' }),
  Object.freeze({ value:'office', label:'Office' }),
  Object.freeze({ value:'pop_up', label:'Pop-up' }),
]);

export const LOCATION_TYPES = Object.freeze([
  Object.freeze({ value:'front_counter', label:'Front counter' }),
  Object.freeze({ value:'kitchen', label:'Kitchen' }),
  Object.freeze({ value:'stockroom', label:'Stockroom' }),
  Object.freeze({ value:'office', label:'Office' }),
  Object.freeze({ value:'service_area', label:'Service area' }),
  Object.freeze({ value:'other', label:'Other area' }),
]);

export const TERMINAL_TYPES = Object.freeze([
  Object.freeze({ value:'pos', label:'POS terminal' }),
  Object.freeze({ value:'kitchen_display', label:'Kitchen display' }),
  Object.freeze({ value:'customer_display', label:'Customer display' }),
  Object.freeze({ value:'back_office', label:'Back office' }),
  Object.freeze({ value:'print_connector', label:'Print connector' }),
  Object.freeze({ value:'stock', label:'Stock terminal' }),
  Object.freeze({ value:'multi_use', label:'Multi-use terminal' }),
]);

export const TERMINAL_CAPABILITIES = Object.freeze([
  Object.freeze({ value:'pos', label:'Point of sale' }),
  Object.freeze({ value:'kitchen', label:'Kitchen display' }),
  Object.freeze({ value:'label_printing', label:'Label printing' }),
  Object.freeze({ value:'customer_display', label:'Customer display' }),
  Object.freeze({ value:'stock', label:'Stock operations' }),
  Object.freeze({ value:'admin', label:'Administration' }),
]);

const TERMINAL_TYPE_CAPABILITIES = Object.freeze({
  pos:Object.freeze(['pos']),kitchen_display:Object.freeze(['kitchen']),
  customer_display:Object.freeze(['customer_display']),back_office:Object.freeze(['admin']),
  print_connector:Object.freeze(['label_printing']),stock:Object.freeze(['stock']),multi_use:Object.freeze([]),
});
export const terminalCapabilitiesForType = type => [...(TERMINAL_TYPE_CAPABILITIES[type] || [])];

export const defaultNetworkPolicy = () => ({ terminalEnforcement:false, requireOpenRegisterForPos:false });
export const emptyNetwork = () => ({ policy:defaultNetworkPolicy(), stores:[], locations:[], terminals:[], staffAssignments:[] });

const rows = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? '').trim();
const code = value => text(value).toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

export function normalizeStoreNetwork(value = {}) {
  const network = emptyNetwork();
  network.policy = { ...network.policy, ...(value.policy || {}) };
  network.stores = rows(value.stores).map(store => ({ ...store, id:text(store.id), code:text(store.code), name:text(store.name), type:store.type || 'branch', status:store.status || 'active' }));
  network.locations = rows(value.locations).map(location => ({ ...location, id:text(location.id), storeId:text(location.storeId || location.store_id), code:text(location.code), name:text(location.name), type:location.type || 'front_counter', status:location.status || 'active' }));
  network.terminals = rows(value.terminals).map(terminal => ({ ...terminal, id:text(terminal.id), storeId:text(terminal.storeId || terminal.store_id), locationId:text(terminal.locationId || terminal.location_id), code:text(terminal.code), name:text(terminal.name), type:terminal.type || 'pos', status:terminal.status || 'pending', capabilities:rows(terminal.capabilities), lastSeenAt:terminal.lastSeenAt || terminal.last_seen_at || null, enrolledAt:terminal.enrolledAt || terminal.enrolled_at || null }));
  const assignments=new Map();
  for(const assignment of rows(value.staffAssignments || value.staff_assignments)){
    const identityId=text(assignment.identityId || assignment.identity_id);if(!identityId)continue;
    const current=assignments.get(identityId) || { ...assignment, identityId, locationIds:[] };
    const ids=[...rows(assignment.locationIds || assignment.location_ids),assignment.locationId || assignment.location_id].map(text).filter(Boolean);
    current.locationIds=[...new Set([...current.locationIds,...ids])];assignments.set(identityId,current);
  }
  network.staffAssignments=[...assignments.values()];
  return network;
}

export function storePayload(form = {}) {
  const formattedAddress=typeof form.address==='object' ? text(form.address?.formatted || form.address?.label) : text(form.address);
  return {
    code:code(form.code || form.name), name:text(form.name), type:form.type || 'branch',
    status:form.status || 'active', timeZone:text(form.timeZone || 'Asia/Kuala_Lumpur'), address:formattedAddress ? { formatted:formattedAddress } : {},
  };
}

export function locationPayload(form = {}) {
  return {
    storeId:text(form.storeId), code:code(form.code || form.name), name:text(form.name),
    type:form.type || 'front_counter', status:form.status || 'active',
  };
}

export function terminalPayload(form = {}) {
  return {
    storeId:text(form.storeId), locationId:text(form.locationId), code:code(form.code || form.name),
    name:text(form.name), type:form.type || 'pos', status:form.status || 'pending',
    capabilities:[...new Set(rows(form.capabilities).map(text).filter(Boolean))],
  };
}

export function validateNetworkForm(kind, form) {
  const payload = kind === 'store' ? storePayload(form) : kind === 'location' ? locationPayload(form) : terminalPayload(form);
  if (!payload.name) return 'Name is required.';
  if (!payload.code) return 'Code is required.';
  if (kind !== 'store' && !payload.storeId) return 'Choose a store.';
  if (kind === 'terminal' && !payload.locationId) return 'Choose a location.';
  return '';
}

export function terminalPresence(terminal, now = Date.now()) {
  if (!terminal?.enrolledAt) return { state:'pending', label:'Not enrolled', detail:'Pair this browser to activate the terminal.' };
  if (terminal.status !== 'active') return { state:'offline', label:terminal.status || 'Unavailable', detail:'This terminal is not available for staff access.' };
  const seen = Date.parse(terminal.lastSeenAt || '');
  if (!Number.isFinite(seen)) return { state:'offline', label:'No heartbeat yet', detail:'The browser has not reported its status.' };
  const age = Math.max(0, now - seen);
  if (age < 2 * 60 * 1000) return { state:'online', label:'Recently active', detail:'Reported less than two minutes ago.' };
  if (age < 15 * 60 * 1000) return { state:'recent', label:'Seen recently', detail:`Last report ${Math.max(2, Math.round(age / 60000))} minutes ago.` };
  return { state:'offline', label:'Last seen earlier', detail:`Last browser report ${new Date(seen).toLocaleString()}.` };
}

export function cashSen(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round((number + Number.EPSILON) * 100);
}

export function formatCashSen(value, currency = 'MYR') {
  const amount = Number(value || 0) / 100;
  const code=currency==='RM'?'MYR':/^[A-Z]{3}$/.test(String(currency||'').toUpperCase())?String(currency).toUpperCase():'MYR';
  return new Intl.NumberFormat('en-MY', { style:'currency', currency:code }).format(amount);
}

export function normalizeShiftList(value) {
  if (Array.isArray(value)) return value;
  return rows(value?.rows || value?.shifts || value?.registerShifts);
}

export function mergeShiftContext(previous = {}, value = {}) {
  const has=key=>Object.prototype.hasOwnProperty.call(value,key);
  return {
    staffSession:has('staffSession') ? value.staffSession : previous.staffSession ?? null,
    workShift:has('workShift') ? value.workShift : has('staffShift') ? value.staffShift : previous.workShift ?? null,
    registerShift:has('registerShift') ? value.registerShift : previous.registerShift ?? null,
  };
}
