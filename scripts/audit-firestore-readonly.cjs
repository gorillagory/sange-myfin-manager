// Read-only, bounded inspection using the installed Firebase CLI's existing login.
// Usage: node scripts/audit-firestore-readonly.cjs <firebase-tools-directory>
// Does not write Firestore, deploy rules, or save raw documents or credentials.
const fs = require('node:fs');
const path = require('node:path');
const cliRoot = process.argv[2];
if (!cliRoot) throw new Error('Pass the installed firebase-tools package directory.');
const cli = name => require(path.join(cliRoot, 'lib', name));
const project = 'myfinmanager-1d2da';
const database = '(default)';
const root = path.resolve(__dirname, '..');
const auth = cli('auth.js');
const { requireAuth } = cli('requireAuth.js');
const { Client } = cli('apiv2.js');
const api = cli('api.js');
const rules = cli('gcp/rules.js');
const result = { checkedAt: new Date().toISOString(), project, database, readOnly: true, collections: {}, errors: [] };
const base = `projects/${project}/databases/${database}`;
const skipLog = { reqBody: true, resBody: true };
const scalar = value => value?.stringValue ?? value?.integerValue ?? value?.doubleValue ?? value?.booleanValue ?? value?.timestampValue ?? null;
const tally = values => values.reduce((out, value) => { const key = String(value ?? '(missing)'); out[key] = (out[key] || 0) + 1; return out; }, {});
const fieldsOf = value => value?.mapValue?.fields || {};
const itemsOf = value => value?.arrayValue?.values || [];
async function attempt(label, fn) {
  try { return await fn(); }
  catch (error) { result.errors.push({ check: label, message: String(error.message || error).slice(0, 400) }); return null; }
}

(async () => {
  const options = { project, projectRoot: root, nonInteractive: true };
  const account = auth.getProjectDefaultAccount(root);
  if (!account) throw new Error('No existing Firebase CLI account is available.');
  auth.setActiveAccount(options, account);
  await requireAuth(options);
  const client = new Client({ auth: true, apiVersion: 'v1', urlPrefix: api.firestoreOrigin() });
  const metadata = await attempt('database metadata', async () => (await client.get(base, { skipLog })).body);
  if (metadata) result.configuration = Object.fromEntries(['locationId', 'type', 'concurrencyMode', 'pointInTimeRecoveryEnablement', 'deleteProtectionState', 'databaseEdition'].map(key => [key, metadata[key] ?? '(not returned)']));
  const schedules = await attempt('backup schedules', async () => (await client.get(`${base}/backupSchedules`, { skipLog })).body);
  if (schedules) result.backupScheduleCount = (schedules.backupSchedules || []).length;
  const releases = await attempt('deployed rules', () => rules.listAllReleases(project));
  if (releases) {
    result.deployedRules = [];
    for (const release of releases.filter(r => /\/releases\/cloud\.(firestore|storage)/.test(r.name))) {
      const files = await attempt('read released rules', () => rules.getRulesetContent(release.rulesetName));
      if (!files) continue;
      // Rules are code, not business records; retain only diagnostic flags and hashes.
      const crypto = require('node:crypto');
      result.deployedRules.push({
        service: release.name.split('/releases/')[1], updatedAt: release.updateTime || release.createTime,
        files: files.map(file => ({ name: file.name, sha256: crypto.createHash('sha256').update(file.content).digest('hex'),
          unconditionalReadWrite: /allow\s+read\s*,\s*write\s*:\s*if\s+true\s*;/.test(file.content),
          hasAuthenticationCondition: /request\.auth/.test(file.content),
          matchesLocalFirestoreRules: file.content.replace(/\r\n/g, '\n').trim() === fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8').replace(/\r\n/g, '\n').trim()
        }))
      });
    }
  }
  const projection = {
    companies: ['preferences.currency', 'preferences.tax', 'preferences.taxRate', 'qrCode', 'qrCodeUrl'],
    users: ['role', 'company_id'],
    products: ['company_id', 'sku', 'code', 'price', 'cost', 'stock', 'unit', 'trackStock', 'hasVariants', 'variants'],
    transactions: ['company_id', 'date', 'type', 'status', 'items', 'subtotal', 'total', 'tax', 'taxRate', 'discount', 'amount', 'paymentMethod', 'number', 'schemaVersion', 'cashierId', 'registerId', 'shiftId'],
    expenses: ['company_id', 'date', 'amount', 'total', 'type', 'receiptPath'],
    clients: ['company_id', 'type'],
    activities: ['company_id', 'date', 'action']
  };
  const inventory = await attempt('collection names', async () => (await client.post(`${base}/documents:listCollectionIds`, { pageSize: 100 }, { skipLog })).body);
  if (inventory) { result.topLevelCollections = inventory.collectionIds || []; result.collectionInventoryTruncated = Boolean(inventory.nextPageToken); }
  for (const [collection, fieldPaths] of Object.entries(projection)) {
    const countResponse = await attempt(`${collection} count`, async () => (await client.post(`${base}/documents:runAggregationQuery`, {
      structuredAggregationQuery: { structuredQuery: { from: [{ collectionId: collection }] }, aggregations: [{ alias: 'count', count: {} }] }
    }, { skipLog })).body);
    const count = countResponse ? Number(scalar(countResponse.find(r => r.result)?.result?.aggregateFields?.count)) : null;
    const limit = collection === 'transactions' ? 100 : 30;
    const response = await attempt(`${collection} schema sample`, async () => (await client.post(`${base}/documents:runQuery`, {
      structuredQuery: { from: [{ collectionId: collection }], select: { fields: fieldPaths.map(fieldPath => ({ fieldPath })) }, limit }
    }, { skipLog })).body);
    if (!response) continue;
    const docs = response.filter(r => r.document).map(r => r.document);
    const rows = docs.map(d => d.fields || {});
    const summary = { totalDocuments: count, sampledDocuments: docs.length, sampleLimit: limit, sampleComplete: count !== null && count <= docs.length,
      sampleOrder: 'Default document-ID order; not necessarily recent.', projectedFields: fieldPaths,
      fieldTypes: {}, missingCompanyId: rows.filter(r => !r.company_id).length };
    for (const row of rows) for (const [name, value] of Object.entries(row)) {
      summary.fieldTypes[name] ??= {};
      const type = Object.keys(value)[0];
      summary.fieldTypes[name][type] = (summary.fieldTypes[name][type] || 0) + 1;
    }
    if (collection === 'companies') {
      delete summary.missingCompanyId;
      summary.withQrCode = rows.filter(r => Boolean(scalar(r.qrCode))).length;
      summary.withQrCodeUrl = rows.filter(r => Boolean(scalar(r.qrCodeUrl))).length;
      summary.withTaxField = rows.filter(r => fieldsOf(r.preferences).tax).length;
      summary.withTaxRateField = rows.filter(r => fieldsOf(r.preferences).taxRate).length;
    }
    if (collection === 'users') summary.roles = tally(rows.map(r => scalar(r.role)));
    if (collection === 'products') {
      const variants = rows.flatMap(r => itemsOf(r.variants).map(fieldsOf));
      summary.withSku = rows.filter(r => Boolean(scalar(r.sku))).length;
      summary.withCode = rows.filter(r => Boolean(scalar(r.code))).length;
      summary.withVariants = rows.filter(r => itemsOf(r.variants).length).length;
      summary.variantCount = variants.length;
      summary.variantsWithStableId = variants.filter(v => v.id || v.variantId).length;
      summary.variantFieldNames = [...new Set(variants.flatMap(Object.keys))].sort();
      summary.negativeStock = rows.filter(r => Number(scalar(r.stock)) < 0).length;
    }
    if (collection === 'transactions') {
      summary.statuses = tally(rows.map(r => scalar(r.status)));
      summary.types = tally(rows.map(r => scalar(r.type)));
      summary.paymentMethods = tally(rows.map(r => scalar(r.paymentMethod)));
      const items = rows.flatMap(r => itemsOf(r.items).map(fieldsOf));
      summary.lineItemCount = items.length;
      summary.lineItemsWithProductId = items.filter(i => i.productId || i.product_id).length;
      summary.lineItemFieldNames = [...new Set(items.flatMap(Object.keys))].sort();
      summary.withTaxButNoTaxRate = rows.filter(r => Number(scalar(r.tax)) > 0 && !r.taxRate).length;
      summary.withAmountButNoTotal = rows.filter(r => r.amount && !r.total).length;
      const numbers = tally(rows.map(r => scalar(r.number)).filter(Boolean));
      summary.duplicateNumberGroups = Object.values(numbers).filter(n => n > 1).length;
    }
    result.collections[collection] = summary;
  }
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/firestore-readonly-evidence.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ configuration: result.configuration, backupScheduleCount: result.backupScheduleCount,
    deployedRules: result.deployedRules, collections: Object.fromEntries(Object.entries(result.collections).map(([name, value]) => [name, { total: value.totalDocuments, sampled: value.sampledDocuments }])), errors: result.errors }, null, 2));
})().catch(error => { console.error(String(error.message || error).slice(0, 400)); process.exitCode = 1; });
