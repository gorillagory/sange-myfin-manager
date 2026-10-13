import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fromRoot = path => readFile(join(projectRoot, path), 'utf8');
const [main, professionalCss, editionCss, shell, stockTab, packageJson] = await Promise.all([
  fromRoot('src/main.js'),
  fromRoot('src/professional.css'),
  fromRoot('src/edition.css'),
  fromRoot('src/components/EditionShell.vue'),
  fromRoot('src/components/dashboard/StockTab.vue'),
  fromRoot('package.json').then(JSON.parse),
]);

function compactCss(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
}

function assertCssIncludes(source, fragment, message) {
  assert.ok(compactCss(source).includes(compactCss(fragment)), message);
}

async function componentFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? componentFiles(path) : [path];
  }));
  return files.flat().filter(path => path.endsWith('.vue'));
}

test('self-hosted Geist fonts load before the application cascade', () => {
  const cssImports = [...main.matchAll(/^import ['"]([^'"]+\.css)['"]/gm)].map(match => match[1]);
  assert.deepEqual(cssImports, [
    '@fontsource-variable/geist/wght.css',
    '@fontsource-variable/geist-mono/wght.css',
    './style.css',
    './edition.css',
    './professional.css',
  ]);
  assert.equal(packageJson.dependencies['@fontsource-variable/geist'], '5.3.0');
  assert.equal(packageJson.dependencies['@fontsource-variable/geist-mono'], '5.3.0');
  assert.doesNotMatch(`${main}\n${professionalCss}`, /fonts\.(?:googleapis|gstatic)\.com/i,
    'the application font must remain self-hosted');
});

test('professional UI tokens preserve tables, responsive product grids, and touch targets', () => {
  for (const token of [
    '--ed-font-sans', '--ed-font-mono', '--ed-bg', '--ed-paper', '--ed-ink', '--ed-muted',
    '--ed-line', '--ed-line-strong', '--ed-surface-subtle', '--ed-shadow-xs', '--ed-shadow-sm',
    '--ed-shadow-md', '--ed-radius', '--ed-radius-sm', '--ed-radius-md', '--ed-radius-lg',
  ]) assert.match(professionalCss, new RegExp(`${token}:`), `${token} must remain in the visual system`);

  assert.match(professionalCss, /--ed-font-sans:\s*'Geist Variable'/);
  assert.match(professionalCss, /--ed-font-mono:\s*'Geist Mono Variable'/);
  assertCssIncludes(professionalCss, 'html { font-family: var(--ed-font-sans);',
    'the document root should use the sans token');
  assertCssIncludes(professionalCss, 'body { color: var(--ed-ink); font-family: var(--ed-font-sans);',
    'the application body should use the professional type and color tokens');
  assertCssIncludes(professionalCss,
    '.edition-app :is(button, input, select, textarea) { color: inherit; font-family: inherit; }',
    'form controls should inherit the application font');
  assertCssIncludes(professionalCss,
    '.edition-app :is(.ed-money, .ed-number, .ed-table .num, .ed-metric strong, .ed-summary, output) { font-variant-numeric: tabular-nums lining-nums; }',
    'financial values should retain aligned numerals');
  assertCssIncludes(professionalCss,
    '.edition-app :is(.ed-receipt, .ed-code, .ed-sku, code, kbd) { font-family: var(--ed-font-mono); }',
    'codes and receipts should use the self-hosted mono token');

  assertCssIncludes(editionCss,
    '.edition-app button,.edition-app a{touch-action:manipulation}',
    'interactive controls should avoid delayed touch activation');
  assert.match(professionalCss,
    /\.edition-app \.ed-table-wrap\s*\{[^}]*overflow:\s*auto;[^}]*border:\s*1px solid var\(--ed-line\);[^}]*border-radius:\s*var\(--ed-radius-md\);/s);
  assert.match(professionalCss,
    /\.edition-app \.ed-table\s*\{[^}]*border-collapse:\s*separate;[^}]*border-spacing:\s*0;[^}]*font-size:\s*14px;/s);
  assert.match(professionalCss,
    /\.edition-app \.ed-table tbody tr:hover td\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--ed-tint\) 42%, white\);/s);
  assert.match(professionalCss,
    /\.edition-app \.ed-btn\.primary\s*\{[^}]*background:\s*var\(--ed-accent\);[^}]*color:\s*var\(--ed-accent-text\);/s,
    'the visual override must preserve visible primary controls');
  assert.match(professionalCss,
    /\.edition-app \.ed-tabs button\.active\s*\{[^}]*background:\s*var\(--ed-accent\);[^}]*color:\s*var\(--ed-accent-text\);/s,
    'active tabs must remain visibly selected');
  assertCssIncludes(professionalCss,
    '.edition-app .ed-search > :is(input, .ed-input) { padding-left: 40px; }',
    'search text must clear its leading icon');

  assertCssIncludes(professionalCss,
    '.edition-app .ed-product-grid { grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));',
    'wide product grids should fill available workspace width');
  assert.match(professionalCss,
    /@media\s*\(max-width:\s*1200px\)[\s\S]*?\.edition-app \.ed-product-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax\(190px, 1fr\)\);/);
  assert.match(professionalCss,
    /@media\s*\(max-width:\s*720px\)[\s\S]*?\.edition-app \.ed-product-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(professionalCss,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.edition-app \.ed-product-grid\s*\{[^}]*grid-template-columns:\s*1fr;/);
  assert.match(professionalCss,
    /@media\s*\(pointer:\s*coarse\)[\s\S]*?\.edition-app :is\(\.ed-btn, \.ed-tabs button, \.ed-icon-button\)\s*\{[^}]*min-height:\s*46px;/);
  assert.match(professionalCss,
    /@media\s*\(pointer:\s*coarse\)[\s\S]*?\.edition-app :is\(\.ed-field input, \.ed-field select, \.ed-field textarea, \.ed-input\)\s*\{[^}]*min-height:\s*48px;[^}]*font-size:\s*16px;/);
  assert.match(professionalCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/,
    'the visual system should respect reduced-motion preferences');
});

test('stock records keep primary actions visible and secondary actions in a responsive menu', () => {
  assert.match(stockTab, /class="ed-table mf-stock-table"[^>]*><colgroup>/,
    'stock records should own a balanced column contract without changing other tables');
  assert.match(stockTab, /class="mf-stock-col-item"/);
  assert.match(stockTab, /class="mf-stock-col-actions"/);
  assert.match(stockTab, /class="mf-stock-actions"[^>]*><button v-if="item\.active"[^>]*>Receive<\/button><button v-if="item\.active"[^>]*>Count<\/button>/,
    'Receive and Count should remain one-tap actions');
  assert.match(stockTab, /<details[^>]*class="mf-stock-action-menu"[^>]*name="stock-row-actions"/,
    'secondary row actions should use a keyboard-accessible native disclosure');
  for (const label of ['Code &amp; labels', 'Duplicate', 'Edit', 'Archive', 'Restore'])
    assert.match(stockTab, new RegExp(`>${label}<`));
  assert.match(stockTab, /@media \(max-width: 640px\)[\s\S]*?\.mf-stock-table tr\s*\{[^}]*display:\s*grid;/,
    'phone stock rows should become readable cards');
});

test('sidebar collapse stays persistent on desktop and independent from the mobile drawer', () => {
  assert.match(shell, /SIDEBAR_STATE_KEY = 'myfin\.workspace\.sidebar-collapsed'/);
  assert.match(shell, /window\.localStorage\.getItem\(SIDEBAR_STATE_KEY\)/);
  assert.match(shell, /window\.localStorage\.setItem\(SIDEBAR_STATE_KEY, String\(value\)\)/);
  assert.match(shell, /matchMedia\?\.\('\(max-width: 1280px\)'\)/,
    'first-use compact layouts should preserve workspace width');
  assert.match(shell, /matchMedia\('\(min-width: 961px\)'\)/);
  assert.match(shell, /sidebarRail = computed\(\(\) => sidebarCollapsed\.value && desktopSidebar\.value\)/,
    'saved desktop state must not collapse the mobile drawer');
  assert.match(shell, /'ed-sidebar-collapsed':sidebarRail/);
  assert.match(shell, /if \(sidebarRail\.value\)\s*\{\s*sidebarCollapsed\.value = false;/,
    'selecting a rail module should expand its navigation');
  assert.match(shell, /class="ed-icon-button ed-sidebar-collapse"[^>]*:aria-expanded="!sidebarCollapsed"[^>]*aria-controls="workspace-navigation"/);
  assert.match(shell, /<button v-if="menu" class="ed-scrim"[^>]*@click="menu=false"/);
  assert.match(shell, /<aside id="workspace-navigation" class="ed-sidebar" :class="\{open:menu\}"/);
  assert.match(shell, /class="ed-icon-button ed-menu-toggle" aria-label="Open navigation" @click="menu=true"/);

  assert.match(editionCss,
    /@media\(min-width:961px\)[\s\S]*?\.ed-shell\.ed-sidebar-collapsed\{grid-template-columns:76px minmax\(0,1fr\)\}/);
  assert.match(editionCss,
    /\.ed-sidebar-collapsed \.ed-brand-name,[^{]+\{display:none!important\}/,
    'the compact rail should hide labels while preserving icon controls');
  assert.match(editionCss,
    /@media\(max-width:960px\)[\s\S]*?\.ed-shell\.ed-sidebar-collapsed\{display:block\}[\s\S]*?\.ed-sidebar-collapse\{display:none\}/,
    'mobile should use the drawer and hide the desktop collapse control');
  assert.match(editionCss,
    /@media\(max-width:960px\)\{[^}]*\.ed-shell\{display:block\}[^}]*\.ed-sidebar\{[^}]*transform:translateX\(-100%\);visibility:hidden;/,
    'mobile navigation should begin off-canvas');
  assert.match(editionCss, /\.ed-sidebar\.open\{transform:none;visibility:visible\}/,
    'opening the mobile menu should reveal the drawer');
  assert.match(editionCss,
    /@media\(pointer:coarse\)\{\.ed-nav-module,\.ed-nav-pages a\{min-height:48px\}\.ed-sidebar-collapse\{width:44px;height:44px\}\}/,
    'sidebar controls should stay touch-sized');
});

test('application components do not reintroduce Georgia or Segoe UI', async () => {
  // These files render user-selected document typography or printer output. Surrounding editors and
  // operational screens remain part of the scan.
  const printDocumentTemplates = new Set([
    'src/components/dashboard/docdesign/DocumentPreview.vue',
    'src/components/dashboard/docdesign/TemplateClean.vue',
    'src/components/dashboard/docdesign/TemplateCorporate.vue',
    'src/components/dashboard/docdesign/TemplateModern.vue',
    'src/components/dashboard/pos/EditionReceipt.vue',
  ]);
  const files = await componentFiles(join(projectRoot, 'src/components'));
  const relativeFiles = files.map(path => relative(projectRoot, path).replaceAll('\\', '/'));
  assert.deepEqual([...printDocumentTemplates].filter(path => !relativeFiles.includes(path)), [],
    'the print/document exclusions should name real template components');

  const offenders = [];
  for (const path of files) {
    const relativePath = relative(projectRoot, path).replaceAll('\\', '/');
    if (printDocumentTemplates.has(relativePath)) continue;
    const source = await readFile(path, 'utf8');
    if (/\b(?:Georgia|Segoe UI)\b/i.test(source)) offenders.push(relativePath);
  }
  assert.deepEqual(offenders, [],
    'application UI must use the shared Geist tokens; document and print templates are explicitly excluded');
});
