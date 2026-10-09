import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('report automation is registered, mounted and deployed as one constrained worker', async () => {
  const [business,analytics,compose,developmentUp,productionUp] = await Promise.all([
    read('server/src/business.js'),read('src/components/dashboard/AnalyticsTab.vue'),
    read('deploy/compose.yml'),read('scripts/deploy/up.sh'),read('scripts/deploy/production-up.sh'),
  ]);
  assert.match(business, /registerReportAutomation\(app,\{scoped,audit\}\)/);
  assert.match(analytics, /<ReportAutomationTab\s*\/>/);
  assert.match(compose, /^  report-worker:/m);
  assert.match(compose, /command: \[node, src\/report-worker\.js\]/);
  assert.match(compose, /REPORT_WORKER_ID: \$\{MYFIN_COMPOSE_PROJECT:-myfin-dev\}-report-worker-1/);
  assert.match(compose, /CUSTOMER_ORDER_MAINTENANCE_BATCH_LIMIT: \$\{MYFIN_CUSTOMER_ORDER_MAINTENANCE_BATCH_LIMIT:-100\}/);
  assert.match(compose, /networks: \[nexus-data\]/);
  assert.doesNotMatch(compose.match(/^  report-worker:[\s\S]*?(?=^networks:)/m)?.[0] || '', /ports:/);
  for (const source of [developmentUp,productionUp])
    assert.match(source, /compose up -d --no-build api report-worker/);
});

test('report and procurement tables have least-privilege runtime grants', async () => {
  const grants = await Promise.all([
    read('db/grant-development-runtime.sql'),read('db/grant-production-runtime.sql'),
  ]);
  for (const source of grants) {
    assert.match(source, /GRANT SELECT,INSERT,UPDATE ON myfin\.report_schedules,myfin\.report_runs/);
    assert.match(source, /GRANT SELECT,INSERT,UPDATE ON myfin\.stock_identifiers,myfin\.purchase_orders/);
    assert.match(source, /GRANT SELECT,INSERT ON myfin\.purchase_order_lines,myfin\.purchase_order_events/);
    for (const table of ['report_schedules','report_runs','purchase_orders','goods_receipts'])
      assert.doesNotMatch(source, new RegExp(`GRANT[^;]*DELETE[^;]*myfin\\.${table}`));
  }
});

test('quiescent backup and destructive restore stop both database writers', async () => {
  const [development,production,restore] = await Promise.all([
    read('scripts/deploy/backup.sh'),read('scripts/deploy/production-backup.sh'),read('scripts/deploy/restore.sh'),
  ]);
  assert.match(development, /compose stop report-worker api/);
  assert.match(development, /compose start api report-worker/);
  assert.match(production, /compose stop report-worker api/);
  assert.match(production, /compose start api report-worker/);
  assert.match(restore, /compose stop report-worker api/);
});
