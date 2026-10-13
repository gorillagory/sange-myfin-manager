import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { ROUTE_CAPABILITIES } from '../src/domain/viewAccess.js';
import { WORKSPACE_MODULES, WORKSPACE_PAGES, workspacePageFor } from '../src/domain/workspaceModules.js';

test('every staff and administration route has a concise module page identity', () => {
  const paths = WORKSPACE_PAGES.map(page => page.path);
  assert.equal(new Set(paths).size, paths.length, 'page paths must be unique');

  for (const path of Object.keys(ROUTE_CAPABILITIES)) {
    const page = workspacePageFor(path);
    assert.notEqual(page.title, 'Workspace', `${path} must have explicit page metadata`);
    assert.ok(page.module, `${path} must belong to a module`);
    assert.ok(page.description, `${path} must have a short subtitle`);
  }

  for (const page of WORKSPACE_PAGES) {
    assert.ok(page.description.split(/\s+/).length <= 8, `${page.path} subtitle should stay concise`);
    assert.doesNotMatch(page.title, /[.!?]$/, `${page.path} title should be a module name`);
  }

  assert.equal(workspacePageFor('/pos').title, 'POS');
  assert.equal(workspacePageFor('/pos').description, "Make someone's day.");
  assert.equal(workspacePageFor('/products').title, 'Inventory');
  assert.equal(workspacePageFor('/stock').title, 'Stock Records');
  assert.equal(workspacePageFor('/expenses').title, 'Expenses');
  assert.deepEqual(WORKSPACE_MODULES.map(module => module.label), [
    'Workspace', 'Inventory', 'Finance', 'Analytics', 'Administration', 'Settings', 'User Administration',
  ]);
});

test('module navigation is collapsed, route-aware, persistent, and keyboard accessible', async () => {
  const [shell, css] = await Promise.all([
    readFile(new URL('../src/components/EditionShell.vue', import.meta.url), 'utf8'),
    readFile(new URL('../src/edition.css', import.meta.url), 'utf8'),
  ]);

  assert.match(shell, /aria-label="Modules"/);
  assert.match(shell, /v-show="isModuleOpen\(section\)"/);
  assert.match(shell, /:aria-expanded="isModuleOpen\(section\)"/);
  assert.match(shell, /:aria-controls="`module-\$\{section\.id\}-pages`"/);
  assert.match(shell, /:aria-current="route\.path===item\.path\?'page':undefined"/);
  assert.match(shell, /\['ArrowDown'|'ArrowDown'/);
  assert.match(shell, /event\.key === 'Home'/);
  assert.match(shell, /event\.key === 'End'/);
  assert.match(shell, /window\.localStorage\.setItem\(MODULE_STATE_KEY/);
  assert.match(shell, /\[active\.id\]: true/);
  assert.match(shell, /id="workspace-page-title">\{\{ pageMeta\.title \}\}/);
  assert.match(css, /\.ed-nav-module\[aria-expanded=true\]/);
  assert.match(css, /\.ed-route-view>\.ed-page>\.ed-page-head>div:has\(>h1\)/);
  assert.doesNotMatch(css, /\.ed-route-view \.ed-page-head>div:has\(>h1\)/,
    'nested editor and dialog headers must remain visible');

  const parsed = parse(shell, { filename: 'EditionShell.vue' });
  assert.deepEqual(parsed.errors, []);
  const script = compileScript(parsed.descriptor, { id: 'module-navigation' });
  const template = compileTemplate({
    source: parsed.descriptor.template.content,
    filename: 'EditionShell.vue',
    id: 'module-navigation',
    compilerOptions: { bindingMetadata: script.bindings },
  });
  assert.deepEqual(template.errors, []);
});
