export const roleLabel = role => ({ super: 'Workspace owner', company_admin: 'Manager', company_user: 'Staff' }[role] || 'Unassigned');
export const isArchived = company => !!(company?.archived || company?.archived_at);
export const eligibleAdministrators = users => users.filter(user => !user.disabled && user.login_available === true && user.role !== 'super' && !user.company_id);
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
  return {
    username: user.username.trim(),
    email: user.email.trim().toLowerCase(),
    role: user.role,
    company_id: user.role === 'super' ? '' : (user.company_id || ''),
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
    last_company_admin: 'Keep at least one active manager assigned to this company.',
    last_active_company_admin: 'Assign another active manager before suspending, moving or demoting this manager.',
    last_active_super: 'Keep at least one active workspace owner.',
    email_change_not_supported: 'The sign-in email cannot be changed here.',
    administrator_not_eligible: 'Choose an active account that is not already assigned to a company.',
    enrollment_payload_changed: 'This enrollment was submitted with different details. Refresh the companies list to check its result.',
    super_company_not_allowed: 'Workspace owners have access to all companies and do not need an individual assignment.',
    enrollment_conflict: 'This enrollment has already been submitted with different details.',
    internal_error: 'The server could not complete the request. Please retry.',
  })[error.message] || (error.status >= 500 ? 'The server could not complete the request. Please retry.' : 'The change could not be completed. Check the details and try again.');
}
export function matchesPeople(users, { query = '', role = '', status = '', companyId = '' } = {}) {
  const term = query.trim().toLowerCase();
  return users.filter(user =>
    (!term || [user.username, user.email].some(value => (value || '').toLowerCase().includes(term))) &&
    (!role || (role === 'unassigned' ? !user.role : user.role === role)) &&
    (!status || (status === 'disabled' ? !!user.disabled : !user.disabled)) &&
    (!companyId || (companyId === 'unassigned' ? !user.company_id && user.role !== 'super' : user.company_id === companyId))
  );
}
