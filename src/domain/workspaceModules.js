const modules = [
  {
    id: 'workspace',
    label: 'Workspace',
    pages: [
      { path: '/pos', title: 'POS', description: "Make someone's day.", icon: 'bag' },
      { path: '/orders', title: 'Sales Orders', description: 'Keep every order moving.', icon: 'clock' },
      { path: '/storefront', title: 'Online Storefront', description: 'Publish, promote, and take orders.', icon: 'spark' },
      { path: '/kitchen', title: 'Kitchen Display', description: 'Keep every station moving.', icon: 'printer' },
    ],
  },
  {
    id: 'inventory',
    label: 'Inventory',
    pages: [
      { path: '/products', title: 'Inventory', description: 'A place for every product.', icon: 'box' },
      { path: '/stock', title: 'Stock Records', description: 'Know what is on the shelf.', icon: 'truck' },
      { path: '/procurement', title: 'Procurement', description: 'Receive what you ordered.', icon: 'receipt' },
    ],
  },
  {
    id: 'finance',
    label: 'Finance',
    pages: [
      { path: '/finance-sales', title: 'Sales & Receivables', description: 'Every sale, paid or due.', icon: 'receipt' },
      { path: '/payment-operations', title: 'Payment Operations', description: 'Payments, matched.', icon: 'wallet' },
      { path: '/documents', title: 'Quotes & Invoices', description: 'Every document, clearly handled.', icon: 'edit' },
      { path: '/cashbook', title: 'Cash Book', description: 'Money in and money out.', icon: 'wallet' },
      { path: '/expenses', title: 'Expenses', description: 'Keep the outgoings in view.', icon: 'wallet' },
      { path: '/receipt-reviews', title: 'Payment Reviews', description: 'Resolve recorded payments.', icon: 'clock' },
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    pages: [
      { path: '/analytics', title: 'Financial Analysis', description: 'Sales and cash, clearly.', icon: 'chart' },
      { path: '/consolidation', title: 'Consolidation', description: 'Your companies, together.', icon: 'grid' },
      { path: '/marketing', title: 'Marketing', description: 'Turn offers into learning.', icon: 'spark' },
    ],
  },
  {
    id: 'administration',
    label: 'Administration',
    pages: [
      { path: '/contacts', title: 'Contacts', description: 'Customers and suppliers.', icon: 'people' },
      { path: '/companies', title: 'Company', description: 'Maintain your business details.', icon: 'building' },
      { path: '/activity', title: 'Activity', description: 'A clear trail of the day.', icon: 'clock' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    pages: [
      { path: '/settings', title: 'Device & Printing', description: 'Make this counter your own.', icon: 'settings' },
      { path: '/templates', title: 'Templates', description: 'Documents that feel like your business.', icon: 'edit' },
      { path: '/integrations', title: 'Integrations', description: 'Review connected channels and providers.', icon: 'grid' },
    ],
  },
  {
    id: 'access',
    label: 'User Administration',
    pages: [
      { path: '/users', title: 'Team & Access', description: 'Manage people, company assignments, and roles.', icon: 'shield' },
    ],
  },
];

function freezeModule(module) {
  return Object.freeze({ ...module, pages: Object.freeze(module.pages.map(page => Object.freeze({ ...page, moduleId: module.id, module: module.label }))) });
}

export const WORKSPACE_MODULES = Object.freeze(modules.map(freezeModule));
export const STANDALONE_PAGES = Object.freeze([
  Object.freeze({ path: '/overview', title: 'Overview', description: 'Your shop, ready for the day.', icon: 'grid', moduleId: 'workspace', module: 'Workspace' }),
  Object.freeze({ path: '/profile', title: 'My Profile', description: 'Review your account and company access.', icon: 'people', moduleId: 'account', module: 'Account' }),
]);
export const WORKSPACE_PAGES = Object.freeze([
  ...STANDALONE_PAGES,
  ...WORKSPACE_MODULES.flatMap(module => module.pages),
]);

const aliases = Object.freeze({
  '/': '/overview',
  '/poslog': '/overview',
  '/session-handoff': '/overview',
  '/sales': '/documents',
  '/student-programs': '/marketing',
});

export function workspacePageFor(path = '') {
  const normalized = aliases[path] || path;
  return WORKSPACE_PAGES.find(page => page.path === normalized) || Object.freeze({
    path: normalized,
    title: 'Workspace',
    description: 'Manage company operations and records.',
    icon: 'grid',
    moduleId: 'workspace',
    module: 'Workspace',
  });
}
