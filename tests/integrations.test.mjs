import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { permissionsFor } from '../src/domain/permissions.js';
import { canVisit, ROUTE_CAPABILITIES } from '../src/domain/viewAccess.js';

test('Integration Center is owner-only in the shared permission and route matrix', () => {
  for (const role of ['super','super_admin','workspace_owner']) {
    assert.equal(permissionsFor({ role }).integrationsRead, true);
    assert.equal(canVisit({ role }, '/integrations'), true);
  }
  for (const role of ['manager','company_admin','operator','company_user']) {
    assert.equal(permissionsFor({ role }).integrationsRead, false);
    assert.equal(canVisit({ role }, '/integrations'), false);
  }
  assert.equal(ROUTE_CAPABILITIES['/integrations'], 'integrationsRead');
});

test('Integration Center presents an unconfirmed candidate and no credential form or activation action', async () => {
  const component = await readFile(new URL('../src/components/dashboard/IntegrationsTab.vue', import.meta.url), 'utf8');
  assert.match(component, /Candidate awaiting confirmation/);
  assert.match(component, /Blocked by readiness gates/);
  assert.match(component, /No outbound provider calls, public webhook, credential capture, cash recognition, order changes or stock changes/);
  assert.match(component, /Payment gateway/);
  assert.doesNotMatch(component, /<input|<textarea|Connect now|Activate integration|method:\s*['"]PUT/);
});

test('router and navigation expose Integration Center without changing existing defaults', async () => {
  const router = await readFile(new URL('../src/router/index.js', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/components/EditionShell.vue', import.meta.url), 'utf8');
  assert.match(router, /path: '\/integrations'.*IntegrationsTab\.vue/);
  assert.match(shell, /\['\/integrations','Integration Center','grid'\]/);
  assert.match(router, /path: '\/', redirect: \(\) => isStorefrontHostname\(location\.hostname\) \? '\/shop' : '\/overview'/);
});
