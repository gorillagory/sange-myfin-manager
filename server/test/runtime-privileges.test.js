import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  REQUIRED_RUNTIME_MIGRATION, RUNTIME_PRIVILEGES, runtimePrivilegeCheck,
} from '../src/runtime-privileges.js';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(serverRoot);
const sourceRoot = join(serverRoot, 'src');

const runtimeEntries = ['index.js', 'report-worker.js', 'receipt-email-worker.js'];
const implicitTablePrivileges = Object.freeze({
  // business.js registers generic CRUD handlers for these tables.
  products: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  clients: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  transactions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  expenses: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  activities: ['SELECT', 'INSERT'],
  stock_movements: ['SELECT', 'INSERT'],
  // files.js checks these generic business records before deleting an upload.
  files: ['SELECT', 'INSERT', 'DELETE'],
  // Marketing lifecycle changes copy the selected target rows into a new version.
  promotion_version_products: ['SELECT', 'INSERT'],
  promotion_version_categories: ['SELECT', 'INSERT'],
  promotion_version_customers: ['SELECT', 'INSERT'],
  // Better Auth owns the query text for these models, so it is absent from src/.
  auth_user: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  auth_session: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  auth_account: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  auth_verification: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
});

// SELECT ... FOR UPDATE/SHARE takes an UPDATE ACL even when the locked row is
// only used as immutable evidence. These were verified under the runtime role.
const rowLockUpdateTables = Object.freeze([
  'inventory_source_effects', 'goods_receipts', 'goods_receipt_lines',
  'purchase_order_lines', 'pricing_snapshots', 'promotion_redemptions',
  'loyalty_point_events', 'loyalty_sale_award_batches',
  // The recipe reservation validation trigger runs as the caller and locks these rows.
  'customer_order_lines', 'inventory_recipe_versions', 'inventory_recipe_components',
  'petty_cash_entries', 'expense_payment_events',
]);

function addPrivilege(inventory, object, privilege) {
  if (!inventory.has(object)) inventory.set(object, new Set());
  inventory.get(object).add(privilege);
}

async function runtimeSourceGraph() {
  const pending = runtimeEntries.map(entry => join(sourceRoot, entry));
  const graph = new Map();
  while (pending.length) {
    const filename = pending.pop();
    if (graph.has(filename)) continue;
    const source = await readFile(filename, 'utf8');
    graph.set(filename, source);
    for (const match of source.matchAll(/(?:import|export)\s+[\s\S]*?\sfrom\s+['"](\.[^'"]+)['"]/g)) {
      const dependency = resolve(dirname(filename), match[1]);
      if (dependency.startsWith(sourceRoot) && dependency.endsWith('.js')) pending.push(dependency);
    }
  }
  return graph;
}

function tableRequirements(graph) {
  const inventory = new Map();
  const operations = [
    // A set-returning stored function can appear in FROM. The word boundary
    // plus call lookahead keeps that function out of the table ACL inventory.
    ['SELECT', /\b(?:FROM|JOIN)\s+myfin\.([a-z_][a-z0-9_]*)\b(?!\s*\()/gi],
    ['INSERT', /\bINSERT\s+INTO\s+myfin\.([a-z_][a-z0-9_]*)/gi],
    ['UPDATE', /\bUPDATE\s+myfin\.([a-z_][a-z0-9_]*)/gi],
    ['DELETE', /\bDELETE\s+FROM\s+myfin\.([a-z_][a-z0-9_]*)/gi],
  ];
  for (const source of graph.values()) {
    for (const [privilege, pattern] of operations)
      for (const match of source.matchAll(pattern)) addPrivilege(inventory, match[1], privilege);
  }
  for (const [table, privileges] of Object.entries(implicitTablePrivileges))
    for (const privilege of privileges) addPrivilege(inventory, table, privilege);
  for (const table of rowLockUpdateTables) addPrivilege(inventory, table, 'UPDATE');
  return inventory;
}

function directlyCalledFunctions(graph) {
  const names = new Set();
  for (const source of graph.values())
    for (const match of source.matchAll(/\b(?:SELECT|FROM)\s+myfin\.([a-z_][a-z0-9_]*)\s*\(/gi))
      names.add(match[1]);
  return [...names].sort();
}

function parseGrantManifest(source, role) {
  const tables = new Map(), sequences = new Map(), functions = new Map();
  const privilegeList = '(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|USAGE|EXECUTE)';
  const pattern = new RegExp(
    `GRANT\\s+(${privilegeList}(?:\\s*,\\s*${privilegeList})*)\\s+ON\\s+(?:(TABLE|SEQUENCE|FUNCTION)\\s+)?([\\s\\S]*?)\\s+TO\\s+${role}\\s*;`,
    'gi',
  );
  for (const match of source.matchAll(pattern)) {
    const privileges = match[1].toUpperCase().split(/\s*,\s*/);
    const kind = (match[2] || 'TABLE').toUpperCase();
    const target = kind === 'SEQUENCE' ? sequences : kind === 'FUNCTION' ? functions : tables;
    const objects = kind === 'FUNCTION'
      ? [...match[3].matchAll(/myfin\.([a-z_][a-z0-9_]*\([^)]*\))/gi)].map(item => item[1].replace(/\s+/g, ''))
      : [...match[3].matchAll(/myfin\.([a-z_][a-z0-9_]*)/gi)].map(item => item[1]);
    for (const object of objects)
      for (const privilege of privileges) addPrivilege(target, object, privilege);
  }
  return { tables, sequences, functions };
}

function missingPrivileges(required, granted, kind) {
  const missing = [];
  for (const [object, privileges] of [...required].sort(([left], [right]) => left.localeCompare(right)))
    for (const privilege of [...privileges].sort())
      if (!granted.get(object)?.has(privilege)) missing.push(`${kind} myfin.${object}: ${privilege}`);
  return missing;
}

async function identitySequences() {
  const directory = join(repositoryRoot, 'db', 'migrations');
  const migrations = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  const sequences = new Map();
  for (const migration of migrations) {
    const source = await readFile(join(directory, migration), 'utf8');
    for (const table of source.matchAll(/CREATE TABLE myfin\.([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\);/gi)) {
      for (const column of table[2].matchAll(/^\s*([a-z_][a-z0-9_]*)\s+[^,\n]*GENERATED\s+ALWAYS\s+AS\s+IDENTITY/gim))
        sequences.set(table[1], `${table[1]}_${column[1]}_seq`);
    }
  }
  return sequences;
}

const graph = await runtimeSourceGraph();
const requirements = tableRequirements(graph);
const calledFunctions = directlyCalledFunctions(graph);
const [developmentSql, productionSql, developmentProvision, productionProvision, identities] = await Promise.all([
  readFile(join(repositoryRoot, 'db', 'grant-development-runtime.sql'), 'utf8'),
  readFile(join(repositoryRoot, 'db', 'grant-production-runtime.sql'), 'utf8'),
  readFile(join(repositoryRoot, 'db', 'provision-development.sql'), 'utf8'),
  readFile(join(repositoryRoot, 'db', 'provision-production.sql'), 'utf8'),
  identitySequences(),
]);
const manifests = [
  ['development', parseGrantManifest(developmentSql, 'myfin_dev_runtime'), developmentProvision, 'myfin_dev_runtime'],
  ['production', parseGrantManifest(productionSql, 'myfin_prod_runtime'), productionProvision, 'myfin_prod_runtime'],
];
const expected = Object.fromEntries(Object.entries(RUNTIME_PRIVILEGES)
  .map(([kind, objects]) => [kind, new Map(Object.entries(objects).map(([object, privileges]) => [object, new Set(privileges)]))]));

test('the runtime privilege manifest covers the API and report-worker SQL graph', () => {
  assert.ok(graph.size >= 40, `runtime import graph unexpectedly shrank to ${graph.size} modules`);
  assert.ok(requirements.size >= 85, `runtime table inventory unexpectedly shrank to ${requirements.size} tables`);
  assert.deepEqual(missingPrivileges(requirements, expected.tables, 'table'), [],
    'the shared runtime manifest does not cover the server SQL graph');
});

test('direct identity inserts and stored-function calls have runtime privileges', () => {
  const inserted = new Set([...requirements].filter(([, privileges]) => privileges.has('INSERT')).map(([table]) => table));
  const requiredSequences = new Map(
    [...identities].filter(([table]) => inserted.has(table)).map(([, sequence]) => [sequence, new Set(['USAGE'])]),
  );
  assert.deepEqual([...requiredSequences.keys()], ['marketing_campaign_events_sequence_seq'],
    'review new identity-backed runtime inserts and grant only their specific sequences');
  assert.deepEqual(missingPrivileges(requiredSequences, expected.sequences, 'sequence'), [],
    'the shared runtime manifest omits an identity sequence');
  assert.deepEqual(Object.keys(RUNTIME_PRIVILEGES.sequences).sort(), [...requiredSequences.keys()].sort(),
    'the shared runtime manifest contains a sequence outside the direct identity-insert graph');
  const manifestFunctions = Object.keys(RUNTIME_PRIVILEGES.functions)
    .map(signature => signature.slice(0, signature.indexOf('('))).sort();
  assert.deepEqual(manifestFunctions, calledFunctions,
    'the shared runtime manifest and directly called stored functions have drifted');
  for (const privileges of Object.values(RUNTIME_PRIVILEGES.functions))
    assert.deepEqual(privileges, ['EXECUTE']);
});

test('provisioning and grants cover the exhaustive shared runtime manifest', () => {
  for (const [environment, granted, provision, role] of manifests) {
    assert.match(provision, new RegExp(`GRANT\\s+USAGE\\s+ON\\s+SCHEMA\\s+myfin\\s+TO\\s+${role}`, 'i'),
      `${environment} runtime role needs schema USAGE`);
    for (const kind of ['tables', 'sequences', 'functions'])
      assert.deepEqual(missingPrivileges(expected[kind], granted[kind], kind.slice(0, -1)), [],
        `${environment} grants do not cover the shared ${kind} manifest`);
  }
});

test('development and production runtime ACL manifests stay equivalent', () => {
  const serialize = inventory => [...inventory]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([object, privileges]) => [object, [...privileges].sort()]);
  for (const kind of ['tables', 'sequences', 'functions'])
    assert.deepEqual(serialize(manifests[0][1][kind]), serialize(manifests[1][1][kind]),
      `${kind} grants drifted between development and production`);
});

test('startup readiness consumes every parameterized shared-manifest predicate', async () => {
  const databaseSource = await readFile(join(sourceRoot, 'database.js'), 'utf8');
  assert.match(databaseSource, /REQUIRED_RUNTIME_MIGRATION/);
  assert.match(databaseSource, /runtimePrivilegeCheck\(2\)/);
  assert.match(databaseSource, /runtimeAcl\.predicate/);
  assert.match(databaseSource, /\[REQUIRED_RUNTIME_MIGRATION, \.\.\.runtimeAcl\.parameters\]/);
  assert.match(databaseSource, /catch\s*\{\s*return false;\s*\}/);
  const check = runtimePrivilegeCheck(2);
  const expectedPredicateCount = Object.values(RUNTIME_PRIVILEGES)
    .flatMap(objects => Object.values(objects)).reduce((total, privileges) => total + privileges.length, 0);
  assert.equal((check.predicate.match(/has_(?:schema|table|sequence|function)_privilege/g) || []).length,
    expectedPredicateCount);
  assert.equal(check.parameters.length, expectedPredicateCount * 2);
  assert.equal(REQUIRED_RUNTIME_MIGRATION, '0051_staff_register_shifts.sql');
});

test('the dynamic SQL allowlist stays narrow and reviewable', () => {
  const unresolved = new Map();
  for (const [filename, source] of graph) {
    if (filename.endsWith('runtime-privileges.js')) continue;
    const count = [...source.matchAll(/myfin\.\$\{/g)].length;
    if (count) unresolved.set(relative(serverRoot, filename).replaceAll('\\', '/'), count);
  }
  assert.deepEqual(Object.fromEntries([...unresolved].sort()), {
    'src/business.js': 4,
    'src/files.js': 1,
    'src/marketing-campaigns.js': 4,
  });
});
