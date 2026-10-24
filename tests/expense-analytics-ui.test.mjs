import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import {
  expenseInsightsSnapshot, expenseInsightsSnapshotKey, getExpenseClaimReport, getExpenseInsights,
} from '../src/services/expenseAnalytics.js';

const store = { state:{ selectedCompany:{ id:'company-1' } } };

test('expense analytics client uses role-scoped company routes and preserves report controls', async () => {
  const original = global.fetch, calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push([url, options.method || 'GET']);
    return { ok:true, json:async () => ({ summary:{} }) };
  };
  try {
    await getExpenseInsights(store, { from:'2026-01-01', to:'2026-10-24', grain:'quarter' });
    await getExpenseClaimReport(store, 'claim / 1');
  } finally { global.fetch = original; }
  assert.deepEqual(calls, [
    ['/api/companies/company-1/expense-insights?from=2026-01-01&to=2026-10-24&grain=quarter', 'GET'],
    ['/api/companies/company-1/expenses/claim%20%2F%201/claim-report', 'GET'],
  ]);
});

test('expense report snapshots change with identity, effective grants, access and applied filters', () => {
  let allowed=true;
  const scopedStore={state:{selectedCompany:{id:'company-1'},currentUser:{id:'staff-1',role:'operator',module_grants:['finance']}},
    can:capability=>capability==='expenseReportsRead'&&allowed};
  const first=expenseInsightsSnapshot(scopedStore,{from:'2026-01-01',to:'2026-01-31',grain:'month'});
  scopedStore.state.currentUser={...scopedStore.state.currentUser,id:'staff-2'};
  const otherActor=expenseInsightsSnapshot(scopedStore,{from:'2026-01-01',to:'2026-01-31',grain:'month'});
  assert.notEqual(expenseInsightsSnapshotKey(first),expenseInsightsSnapshotKey(otherActor));
  scopedStore.state.currentUser={...scopedStore.state.currentUser,id:'staff-1',module_grants:[]};allowed=false;
  const revoked=expenseInsightsSnapshot(scopedStore,{from:'2026-01-01',to:'2026-01-31',grain:'month'});
  assert.equal(revoked.reportAccess,false);assert.notEqual(expenseInsightsSnapshotKey(first),expenseInsightsSnapshotKey(revoked));
  allowed=true;scopedStore.state.currentUser={...scopedStore.state.currentUser,module_grants:['finance']};
  const editedFilter=expenseInsightsSnapshot(scopedStore,{from:'2026-02-01',to:'2026-02-28',grain:'month'});
  assert.notEqual(expenseInsightsSnapshotKey(first),expenseInsightsSnapshotKey(editedFilter));
});

test('expense analytics and expense workspace components compile', async () => {
  for (const relative of [
    '../src/components/dashboard/expenses/ExpenseAnalyticsPanel.vue',
    '../src/components/dashboard/EditionExpenses.vue',
  ]) {
    const filename = new URL(relative, import.meta.url), source = await readFile(filename, 'utf8');
    const parsed = parse(source, { filename:filename.pathname });
    assert.equal(parsed.errors.length, 0, `${relative} parses`);
    compileScript(parsed.descriptor, { id:relative });
    const template = compileTemplate({ source:parsed.descriptor.template.content, filename:filename.pathname,
      id:relative, compilerOptions:{ bindingMetadata:{} } });
    assert.deepEqual(template.errors, [], `${relative} template compiles`);
  }
});

test('expense intelligence UI exposes role-scoped reports, ageing and individual claim PDFs', async () => {
  const panel = await readFile(new URL('../src/components/dashboard/expenses/ExpenseAnalyticsPanel.vue', import.meta.url), 'utf8');
  const expenses = await readFile(new URL('../src/components/dashboard/EditionExpenses.vue', import.meta.url), 'utf8');
  for (const phrase of ['My claims','Company expenses','Outstanding ageing','Expenses by category','Claims by person',
    'Usage and control','Oldest outstanding claims','Month','Quarter','Year']) assert.match(panel, new RegExp(phrase));
  assert.match(panel, /pettyCash\.restricted/);
  assert.match(panel, /buildExpenseReport[\s\S]*analytics:insights\.value/);
  assert.match(panel, /serverClaims=claimsComplete/);
  assert.match(panel, /claimsComplete=.*!insights\.value\.claimsLimited/);
  assert.match(panel, /claimReportAvailable!==false/);
  assert.match(panel, /recordType===['"]legacy_transaction['"].*Legacy summary only.*Current claim report unavailable/);
  assert.match(panel, /Balance at period end/);
  assert.doesNotMatch(panel, /expenseRecords\(Store\.state\)/);
  assert.match(panel, /:disabled="!reportReady\|\|reportBusy"/);
  assert.match(panel, /insights\.value=null; appliedSnapshot\.value=null/);
  assert.match(panel, /watch\(contextKey/);
  assert.match(panel, /buildExpenseClaimReport/);
  assert.match(expenses, /Insights &amp; reports/);
  assert.doesNotMatch(expenses, /Finance PDF|downloadExpenseReportPdf|pettyDataForReport/);
  assert.match(expenses, /expense\.origin!==['"]transactions['"][\s\S]*Claim PDF/);
  assert.match(expenses, /getExpenseClaimReport/);
});

test('expense PDF font is loaded only by the asynchronous download path', async () => {
  const service=await readFile(new URL('../src/services/expenseReportPdf.js',import.meta.url),'utf8');
  assert.match(service,/await import\(['"]\.\/expensePdfFont\.js['"]\)/);
  assert.doesNotMatch(service,/^import .*expensePdfFont/m);
});
