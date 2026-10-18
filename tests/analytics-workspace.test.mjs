import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileScript, compileStyle, compileTemplate, parse } from '@vue/compiler-sfc';

const analyticsFile = new URL('../src/components/dashboard/AnalyticsTab.vue', import.meta.url);
const advancedFile = new URL('../src/components/dashboard/AdvancedAnalyticsPanel.vue', import.meta.url);
const shellFile = new URL('../src/components/EditionShell.vue', import.meta.url);
const [analyticsSource, advancedSource, shellSource] = await Promise.all([
  readFile(analyticsFile, 'utf8'),
  readFile(advancedFile, 'utf8'),
  readFile(shellFile, 'utf8'),
]);

function compileComponent(source, file, id) {
  const parsed = parse(source, { filename:file.pathname });
  assert.deepEqual(parsed.errors, []);
  const script = compileScript(parsed.descriptor, { id });
  const template = compileTemplate({
    source:parsed.descriptor.template.content,
    filename:file.pathname,
    id,
    compilerOptions:{ bindingMetadata:script.bindings },
  });
  assert.deepEqual(template.errors, []);
  for (const style of parsed.descriptor.styles) {
    const result = compileStyle({
      source:style.content,
      filename:file.pathname,
      id,
      scoped:style.scoped,
    });
    assert.deepEqual(result.errors, []);
  }
}

test('analytics workspace and controlled advanced panel compile', () => {
  compileComponent(analyticsSource, analyticsFile, 'analytics-workspace-test');
  compileComponent(advancedSource, advancedFile, 'advanced-analytics-workspace-test');
});

test('analytics exposes six URL-addressable workspace sections', () => {
  const configuredViews = [...analyticsSource.matchAll(/\{ id:'([^']+)', label:'([^']+)'/g)]
    .slice(0, 6)
    .map(match => match[1]);
  assert.deepEqual(configuredViews, [
    'overview', 'financial', 'products', 'inventory', 'customers', 'reports',
  ]);
  assert.match(analyticsSource,
    /const activeView = computed\(\(\) => validViews\.has\(route\.query\.view\) \? route\.query\.view : 'overview'\)/);
  assert.match(analyticsSource, /const viewTarget = id => \(\{ path:'\/analytics', query:/);
  assert.match(analyticsSource,
    /<router-link v-for="item in views"[\s\S]*?:to="viewTarget\(item\.id\)"[\s\S]*?:aria-current="activeView===item\.id\?'page':undefined"/);
});

test('analytics mounts heavy panels only for their active section', () => {
  assert.match(analyticsSource,
    /<section v-if="activeView==='overview'"[\s\S]*?<AdvancedAnalyticsPanel[^>]*view="overview"[^>]*embedded\s*\/>/);
  assert.match(analyticsSource,
    /const advancedView = computed\(\(\) => \['overview','products','inventory','customers'\]\.includes\(activeView\.value\)/);
  assert.match(analyticsSource,
    /<section v-else-if="advancedView"[\s\S]*?<AdvancedAnalyticsPanel[^>]*:view="activeView"[^>]*embedded\s*\/>/);
  assert.match(analyticsSource,
    /<section v-else-if="activeView==='reports'"[^>]*>[\s\S]*?<ReportAutomationTab\s*\/>[\s\S]*?<\/section>/);
  assert.equal((analyticsSource.match(/<ReportAutomationTab\s*\/>/g) || []).length, 1);
  assert.equal((analyticsSource.match(/<AdvancedAnalyticsPanel\b/g) || []).length, 2);
});

test('financial requests use one applied range and filter snapshot', () => {
  assert.match(analyticsSource,
    /const applied = ref\(\{\s*from:from\.value, to:to\.value, cadence:cadence\.value,\s*filters:/s);
  assert.match(analyticsSource,
    /const hasDraftChanges = computed\(\(\) => from\.value !== applied\.value\.from \|\| to\.value !== applied\.value\.to/);
  assert.match(analyticsSource,
    /applied\.value = \{ from:from\.value, to:to\.value, cadence:cadence\.value, filters:selectedFilters\(\) \}/);
  assert.match(analyticsSource,
    /const queryFor = \(start, end\) => analyticsReportQuery\(start, end, applied\.value\.filters\)/);
  assert.match(analyticsSource,
    /const query = queryFor\(applied\.value\.from, applied\.value\.to\)/);
  assert.match(analyticsSource, /const query = queryFor\(bucket\.from, bucket\.to\)/);
  assert.match(analyticsSource, /:from="applied\.from" :to="applied\.to"/);
  assert.doesNotMatch(analyticsSource, /analyticsReportQuery\(from\.value,\s*to\.value/);
});

test('analytics avoids duplicate startup requests and invalidates stale drill-downs', () => {
  assert.match(analyticsSource,
    /\['overview','financial'\]\.includes\(view\) && !report\.value && !loading\.value/);
  const routeDateWatcher = analyticsSource.slice(
    analyticsSource.indexOf('watch(() => [route.query.from, route.query.to]'),
    analyticsSource.indexOf('watch(category'),
  );
  assert.equal((routeDateWatcher.match(/closeBucket\(\);/g) || []).length, 2);
  assert.equal((routeDateWatcher.match(/report\.value = null;/g) || []).length, 2);
});

test('advanced analytics supports an embedded parent-controlled view', () => {
  assert.match(advancedSource, /view:\{type:String,default:''\}/);
  assert.match(advancedSource, /embedded:\{type:Boolean,default:false\}/);
  assert.match(advancedSource,
    /const activeView=computed\(\(\)=>views\.some\(item=>item\.id===props\.view\)\?props\.view:localView\.value\)/);
  assert.match(advancedSource, /<section[^>]*class="business-analytics"[^>]*:class="\{embedded\}"/);
  assert.match(advancedSource, /<header v-if="!embedded"/);
  assert.match(advancedSource, /<nav v-if="!embedded"/);
  assert.match(advancedSource, /defineExpose\(\{ refresh:load \}\)/);
});

test('analytics opts into the modern application shell', () => {
  assert.match(shellSource,
    /'\/consolidation','\/analytics','\/settings'/,
    '/analytics must remain in EditionShell modern-route allowlist');
});
