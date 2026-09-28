export const roleLabel = role => ({ super_admin:'SuperAdmin', workspace_owner:'Workspace owner', manager:'Manager', operator:'Operator', super:'SuperAdmin', company_admin:'Manager', company_user:'Operator' }[role] || 'Unassigned');
const normalizedRole=role=>({super:'super_admin',company_admin:'manager',company_user:'operator'}[role]||role);
export const isArchived = company => !!(company?.archived || company?.archived_at);
export const eligibleAdministrators = users => users.filter(user => !user.disabled && user.login_available === true && normalizedRole(user.role) !== 'super_admin' && !(user.assignments||[]).length && !(user.workspace_ids||[]).length && !user.company_id);
export function companyPayload(company = {}) {
  company = company || {};
  const preferences = { ...(company.preferences || {}) };
  const tax = Number(preferences.taxRate ?? preferences.tax ?? 0);
  return {
    ...(company.id ? { id: company.id } : {}),
    name: (company.name || '').trim(),
    registration: (company.registration || '').trim(),
    address: (company.address || '').trim(),
    phone: (company.phone || '').trim(),
    email: (company.email || '').trim(),
    logo: company.logo || null,
    qrCode: company.qrCode || company.qrCodeUrl || null,
    preferences: { ...preferences, currency: (preferences.currency || 'RM').trim(), tax, taxRate: tax },
  };
}
export function userPayload(user, editing = false) {
  const role=normalizedRole(user.role);
  const companyIds=user.company_ids?.length?user.company_ids:(user.company_id?[user.company_id]:[]);
  return {
    username: user.username.trim(),
    email: user.email.trim().toLowerCase(),
    role,
    company_id: ['super_admin','workspace_owner'].includes(role) ? '' : (companyIds[0] || ''),
    workspace_id:role==='workspace_owner'?(user.workspace_id||''):'',
    assignments:['manager','operator'].includes(role)?companyIds.map(company_id=>({company_id,role})):[],
    ...(editing ? { disabled: !!user.disabled } : { password: user.password }),
  };
}
export function managementError(error) {
  if (error.network) return 'Connection lost. Reconnect and retry. Your form is still here.';
  return ({
    invalid_input: 'Check the required fields, email address and number ranges.',
    record_conflict: 'A record with these details already exists. Check the email or company and try again.',
    access_denied: 'Your role does not allow this change.',
    use_self_profile: 'Use My profile to change your own account.',
    origin_required: 'This page cannot submit the change. Reload the workspace and try again.',
    session_required: 'Your session has expired. Sign in again.',
    email_immutable: 'The sign-in email cannot be changed here.',
    last_active_workspace_owner: 'Assign another active workspace owner before suspending or changing this owner.',
    last_active_super: 'Keep at least one active SuperAdmin.',
    email_change_not_supported: 'The sign-in email cannot be changed here.',
    administrator_not_eligible: 'Choose an active account that is not already assigned to a company.',
    enrollment_payload_changed: 'This enrollment was submitted with different details. Refresh the companies list to check its result.',
    super_scope_not_allowed: 'SuperAdmins use global access and cannot have a company assignment.',
    enrollment_conflict: 'This enrollment has already been submitted with different details.',
    internal_error: 'The server could not complete the request. Please retry.',
  })[error.message] || (error.status >= 500 ? 'The server could not complete the request. Please retry.' : 'The change could not be completed. Check the details and try again.');
}
export function matchesPeople(users, { query = '', role = '', status = '', companyId = '' } = {}) {
  const term = query.trim().toLowerCase();
  return users.filter(user =>
    (!term || [user.username, user.email].some(value => (value || '').toLowerCase().includes(term))) &&
    (!role || (role === 'unassigned' ? !user.role : normalizedRole(user.role) === normalizedRole(role))) &&
    (!status || (status === 'disabled' ? !!user.disabled : !user.disabled)) &&
    (!companyId || (companyId === 'unassigned' ? !(user.assignments||[]).length && !user.company_id && normalizedRole(user.role) !== 'super_admin' : (user.assignments||[]).some(x=>x.company_id===companyId)||user.company_id===companyId))
  );
}
