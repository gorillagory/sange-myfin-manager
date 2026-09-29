import test from 'node:test';
import assert from 'node:assert/strict';
import { applyThemeVariables, contrastRatio, DEFAULT_THEME_COLOR, normalizeThemeColor, themeVariables } from '../src/domain/theme.js';
import { canCreateDirectoryContact, canManageDirectoryContact, contactKind, contactTabsFor, filterDirectoryContacts } from '../src/domain/contactDirectory.js';

test('company theme colors normalize and keep accent text readable', () => {
  assert.equal(normalizeThemeColor(' #ABC '), '#aabbcc');
  assert.equal(normalizeThemeColor('not-a-color'), DEFAULT_THEME_COLOR);
  for (const color of ['#ffffff', '#fff200', '#73d7ff', '#164e42', '#000000']) {
    const variables = themeVariables(color);
    assert.ok(contrastRatio(variables['--ed-accent'], '#ffffff') >= 4.5);
    assert.ok(contrastRatio(variables['--ed-accent'], variables['--ed-accent-text']) >= 4.5);
    assert.match(variables['--ed-tint'], /^#[0-9a-f]{6}$/);
  }
});

test('theme variables apply through CSS custom properties', () => {
  const values = new Map();
  const target = { style:{ setProperty:(property, value) => values.set(property, value) } };
  const result = applyThemeVariables(target, '#4338ca');
  assert.equal(values.get('--ed-accent'), result['--ed-accent']);
  assert.equal(values.get('--ed-accent-text'), result['--ed-accent-text']);
  assert.equal(values.size, Object.keys(result).length);
});

test('contact tabs, filtering and actions preserve customer and supplier boundaries', () => {
  const contacts = [
    { id:'legacy', type:'Client', name:'Legacy Buyer', email:'buyer@example.test' },
    { id:'customer', type:'Customer', name:'Cafe Customer', phone:'0123' },
    { id:'supplier', type:'Supplier', name:'Bean Supplier', registration:'SSM-42' },
  ];
  assert.equal(contactKind(contacts[0]), 'customers');
  assert.deepEqual(contactTabsFor({ suppliersRead:false }).map(tab => tab.id), ['customers']);
  assert.deepEqual(contactTabsFor({ suppliersRead:true }).map(tab => tab.id), ['customers','suppliers']);
  assert.deepEqual(filterDirectoryContacts(contacts, { tab:'customers', query:'buyer' }).map(contact => contact.id), ['legacy']);
  assert.deepEqual(filterDirectoryContacts(contacts, { tab:'suppliers', query:'ssm' }).map(contact => contact.id), ['supplier']);
  const manager = { clientsCreate:true, clientsWrite:true, suppliersRead:false, suppliersWrite:false };
  const owner = { ...manager, suppliersRead:true, suppliersWrite:true };
  assert.equal(canCreateDirectoryContact(manager, 'customers'), true);
  assert.equal(canCreateDirectoryContact(manager, 'suppliers'), false);
  assert.equal(canManageDirectoryContact(manager, contacts[2]), false);
  assert.equal(canManageDirectoryContact(owner, contacts[2]), true);
});
