import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileScript, compileStyle, compileTemplate, parse } from '@vue/compiler-sfc';
import {
  advancedAnalyticsQuery, analyticsErrorMessage, basisPointPercent, changePresentation, cohortPresentation,
  costCoveragePresentation, formatMilliQuantity, formatSen, ratioPercent, recentAnalyticsRange,
} from '../src/domain/advancedAnalytics.js';

const componentFile = new URL('../src/components/dashboard/AdvancedAnalyticsPanel.vue',import.meta.url);
const componentSource = await readFile(componentFile,'utf8');
const analyticsTabFile = new URL('../src/components/dashboard/AnalyticsTab.vue',import.meta.url);
const analyticsTabSource = await readFile(analyticsTabFile,'utf8');

test('advanced analytics query contains only the bounded dates', () => {
  assert.equal(advancedAnalyticsQuery('2026-10-01','2026-10-09').toString(),
    'from=2026-10-01&to=2026-10-09');
  assert.throws(() => advancedAnalyticsQuery('October','2026-10-09'),/valid analytics dates/);
});

test('analytics defaults to an inclusive recent 30-day range and explains dense ranges', () => {
  assert.deepEqual(recentAnalyticsRange('2026-10-18'),{ from:'2026-09-19',to:'2026-10-18' });
  assert.deepEqual(recentAnalyticsRange('2026-01-15'),{ from:'2025-12-17',to:'2026-01-15' });
  assert.throws(() => recentAnalyticsRange('2026-02-30'),/valid recent analytics range/);
  assert.equal(analyticsErrorMessage(new Error('analytics_range_too_dense')),
    'This range contains too many sales to analyze at once. Choose a shorter date range.');
  assert.equal(analyticsErrorMessage({ message:'analytics_product_range_too_dense' }),
    'This range contains too many products to analyze at once. Choose a shorter date range.');
  assert.equal(analyticsErrorMessage({ message:'analytics_pricing_snapshot_mismatch' }),
    'Stored pricing evidence is incomplete for this range. Ask an administrator to review the affected sales.');
  assert.equal(analyticsErrorMessage({ message:'invalid_analytics_range' }),
    'Choose valid analytics dates spanning no more than 366 days.');
  assert.match(analyticsTabSource,/const initialRange = recentAnalyticsRange\(today\)/);
  assert.match(analyticsTabSource,/const from = ref\(initialRange\.from\)/);
  assert.match(analyticsTabSource,/const to = ref\(initialRange\.to\)/);
  assert.match(analyticsTabSource,/reportRange\(from\.value, to\.value, 365\)/);
  assert.match(analyticsTabSource,/Last 30 days/);
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
  assert.deepEqual(changePresentation(1250),{ comparable:true,label:'Up 12.5% vs prior period',tone:'positive' });
  assert.equal(changePresentation(null).comparable,false);
  assert.equal(ratioPercent(2,8),'25%');
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
  assert.match(componentSource,/Customer names, contact details, and identities are excluded/);
  assert.match(componentSource,/Business overview/);
  assert.match(componentSource,/Products & categories/);
  assert.match(componentSource,/Inventory health/);
  assert.match(componentSource,/Paid order value/);
  assert.match(componentSource,/Positive net share/);
  assert.match(componentSource,/analyticsErrorMessage\(failure\)/);
  assert.match(componentSource,/const hasDailyActivity=computed/);
  assert.match(componentSource,/if \(!amount \|\| !trendMaximum\.value\) return '0%'/);
  assert.match(componentSource,/BigInt\(row\.netSalesSen\|\|0\)/);
  assert.match(componentSource,/trendHeight\(day\.netSalesSen\)/);
  assert.match(componentSource,/formatSen\(day\.netSalesSen,currency\).*after tax/s);
  assert.doesNotMatch(componentSource,/trendHeight\(day\.salesSen\)/);
});
