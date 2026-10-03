import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scripts = ['development-feature-smoke.sh', 'production-feature-smoke.sh'];

for (const name of scripts) {
  test(`${name} checks the deployed accounting and manager-visibility contracts`, async () => {
    const source = await readFile(path.join(root, 'scripts', 'deploy', name), 'utf8');

    for (const endpoint of ['/api/me', '/reports/summary?$range', '/reports/details?$range', '/api/reports/consolidation', '/transactions?limit=500', '/documents']) {
      assert.ok(source.includes(endpoint), `${name} does not fetch ${endpoint}`);
    }
    for (const key of ['cashIn', 'cashOut', 'cashFlow', 'sales', 'tax', 'expenses', 'quoted', 'convertedQuoted']) {
      assert.match(source, new RegExp(`['"]${key}['"]`), `${name} does not assert ${key}`);
    }
    for (const collection of ['sales', 'expenses', 'receipts', 'quotes']) {
      assert.match(source, new RegExp(`['"]${collection}['"]`), `${name} does not assert details.${collection}`);
    }
    assert.match(source, /summary_totals==details_totals/);
    assert.match(source, /me\.get\('role'\) in \('super_admin','workspace_owner','manager'\)/);
    assert.match(source, /\('Pending','Partially paid'\)/);
    assert.match(source, /expected<=transaction_ids/);
    assert.match(source, /expected<=document_ids/);
    assert.match(source, /expected\.isdisjoint\(receipt_ids\)/);
    assert.match(source, /manager_visibility_skipped:/);
  });
}

test('production accounting smoke pins the protected Snidect reconciliation without exposing source notes', async () => {
  const source = await readFile(path.join(root, 'scripts', 'deploy', 'production-accounting-smoke.sh'), 'utf8');
  assert.match(source, /snidect-technologies-main\.finn3\.com/);
  for (const [key, value] of Object.entries({ sales:'149782.86', tax:'1380.76', expenses:'22852', cashIn:'78228.75', cashOut:'16352', cashFlow:'61876.75', quoted:'79000', convertedQuoted:'158149.64' })) {
    assert.match(source, new RegExp(`['"]${key}['"]:${value.replace('.', '\\.')}`));
  }
  assert.match(source, /'sales':21,'expenses':5,'receipts':8,'quotes':16/);
  assert.match(source, /'notes' not in serialized\.lower\(\)/);
  assert.match(source, /'history' not in serialized\.lower\(\)/);
});
