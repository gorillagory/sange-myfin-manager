import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileScript, compileStyle, compileTemplate, parse } from '@vue/compiler-sfc';
import {
  advancedAnalyticsQuery, basisPointPercent, cohortPresentation, costCoveragePresentation,
  formatMilliQuantity, formatSen,
} from '../src/domain/advancedAnalytics.js';

const componentFile = new URL('../src/components/dashboard/AdvancedAnalyticsPanel.vue',import.meta.url);
const componentSource = await readFile(componentFile,'utf8');

test('advanced analytics query contains only the bounded dates', () => {
  assert.equal(advancedAnalyticsQuery('2026-10-01','2026-10-09').toString(),
    'from=2026-10-01&to=2026-10-09');
  assert.throws(() => advancedAnalyticsQuery('October','2026-10-09'),/valid analytics dates/);
});

test('integer sen and milli quantities format without floating point conversion', () => {
  assert.equal(formatSen('900719925474099312','RM'),'RM 9,007,199,254,740,993.12');
  assert.equal(formatSen('-125','MYR'),'-MYR 1.25');
  assert.equal(formatMilliQuantity('1234567'),'1,234.567');
  assert.equal(formatMilliQuantity('12000'),'12');
});

test('coverage and privacy presentations clearly distinguish unavailable results', () => {
  assert.deepEqual(costCoveragePresentation({ complete:false,coverageBasisPoints:6250,
    missingCostLineCount:3,operatingContributionSen:null }),{
    complete:false,percentage:'62.5%',title:'Partial item-cost coverage',missingLines:3,
    operatingContributionAvailable:false,
  });
  assert.equal(basisPointPercent(3333),'33.33%');
  assert.deepEqual(cohortPresentation({ suppressed:true,cohortThreshold:5 }),{
    available:false,label:'Hidden until at least 5 people qualify',
  });
  assert.deepEqual(cohortPresentation({ suppressed:false,cohortSize:9 }),{
    available:true,label:'9 people',
  });
});

test('advanced analytics panel compiles and keeps cost requests behind owner capability', () => {
  const parsed = parse(componentSource,{ filename:componentFile.pathname });
  assert.deepEqual(parsed.errors,[]);
  const script = compileScript(parsed.descriptor,{ id:'advanced-analytics-test' });
  const template = compileTemplate({ source:parsed.descriptor.template.content,
    filename:componentFile.pathname,id:'advanced-analytics-test',
    compilerOptions:{ bindingMetadata:script.bindings } });
  assert.deepEqual(template.errors,[]);
  for (const style of parsed.descriptor.styles) {
    const result = compileStyle({ source:style.content,filename:componentFile.pathname,
      id:'advanced-analytics-test',scoped:style.scoped });
    assert.deepEqual(result.errors,[]);
  }
  assert.match(componentSource,/if \(owner\.value\) requests\.push\(api\(companyPath\(Store,`\/analytics\/cost-performance/);
  assert.match(componentSource,/<section v-if="owner&&costs"/);
  assert.match(componentSource,/Customer identities and contact details are never included/);
  assert.match(componentSource,/<label>Submitted demand<\/label>/);
  assert.match(componentSource,/<label>Paid order value<\/label>/);
  assert.match(componentSource,/submitted average/);
  assert.match(componentSource,/paid average/);
});
