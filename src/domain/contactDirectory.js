export const contactKind = contact => contact?.type === 'Supplier' ? 'suppliers' : 'customers';

export function contactTabsFor(permissions = {}) {
  return [
    { id: 'customers', label: 'Customers' },
    ...(permissions.suppliersRead ? [{ id: 'suppliers', label: 'Suppliers' }] : []),
  ];
}

export function filterDirectoryContacts(contacts = [], { tab = 'customers', query = '' } = {}) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  return contacts.filter(contact => contactKind(contact) === tab && (
    !needle || [contact.name, contact.email, contact.phone, contact.registration]
      .some(value => String(value || '').toLocaleLowerCase().includes(needle))
  ));
}

export function canCreateDirectoryContact(permissions = {}, tab = 'customers') {
  return tab === 'suppliers' ? permissions.suppliersWrite === true : permissions.clientsCreate === true;
}

export function canManageDirectoryContact(permissions = {}, contact) {
  return contactKind(contact) === 'suppliers' ? permissions.suppliersWrite === true : permissions.clientsWrite === true;
}
