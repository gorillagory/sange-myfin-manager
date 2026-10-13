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
  assert.match(shell, /:aria-expanded="!sidebarRail && isModuleOpen\(section\)"/);
  assert.match(shell, /:aria-controls="`module-\$\{section\.id\}-pages`"/);
  assert.match(shell, /:aria-current="route\.path===item\.path\?'page':undefined"/);
  assert.match(shell, /\['ArrowDown'|'ArrowDown'/);
  assert.match(shell, /event\.key === 'Home'/);
  assert.match(shell, /event\.key === 'End'/);
  assert.match(shell, /window\.localStorage\.setItem\(MODULE_STATE_KEY/);
  assert.match(shell, /\[active\.id\]: true/);
  assert.match(shell, /SIDEBAR_STATE_KEY = 'myfin\.workspace\.sidebar-collapsed'/);
  assert.match(shell, /matchMedia\?\.\('\(max-width: 1280px\)'\)/,
    'first-use tablet layouts should preserve workspace width');
  assert.match(shell, /window\.localStorage\.setItem\(SIDEBAR_STATE_KEY, String\(value\)\)/);
  assert.match(shell, /'ed-sidebar-collapsed':sidebarRail/);
  assert.match(shell, /sidebarRail = computed\(\(\) => sidebarCollapsed\.value && desktopSidebar\.value\)/,
    'mobile drawers should remain expanded independently of the saved desktop rail state');
  assert.match(shell, /aria-controls="workspace-navigation"/);
  assert.match(shell, /sidebarCollapsed\?'Expand navigation':'Collapse navigation'/);
  assert.match(shell, /class="ed-nav-module-symbol"/);
  assert.match(shell, /sidebarRail\?section\.label:undefined/,
    'icon-only module controls need discoverable labels');
  assert.match(shell, /id="workspace-page-title">\{\{ pageMeta\.title \}\}/);
  assert.match(css, /\.ed-nav-module\[aria-expanded=true\]/);
  assert.match(css, /\.ed-shell\.ed-sidebar-collapsed\{grid-template-columns:76px minmax\(0,1fr\)\}/);
  assert.match(css, /@media\(max-width:960px\)[\s\S]*\.ed-shell\.ed-sidebar-collapsed\{display:block\}/,
    'the compact desktop rail must not shrink the mobile drawer');
  assert.match(css, /@media\(pointer:coarse\)[^{]*\{\.ed-nav-module,\.ed-nav-pages a\{min-height:48px\}/,
    'module navigation needs touch-sized targets');
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
