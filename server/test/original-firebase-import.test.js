import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyOriginalFirebaseImport,
  createOriginalFirebaseImportPlan,
  generateOriginalFirebaseManifest,
  inspectOriginalFirebaseImportTarget,
  loadOriginalFirebaseExport,
  sha256,
  validateOriginalFirebaseManifest
} from '../src/original-firebase-import.js';

const PROJECT = 'synthetic-original-project';
const READ_TIME = '2024-05-06T07:08:09.000Z';
const COLLECTIONS = ['activities','clients','companies','expenses','products','transactions','users'];

function firestoreValue(value) {
  if (value === null) return { nullValue:null };
  if (Array.isArray(value)) return { arrayValue:{ values:value.map(firestoreValue) } };
  if (typeof value === 'boolean') return { booleanValue:value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue:String(value) } : { doubleValue:value };
  if (typeof value === 'string') return { stringValue:value };
  return { mapValue:{ fields:Object.fromEntries(Object.entries(value).map(([key,item]) => [key,firestoreValue(item)])) } };
}

function firestoreDocument(collection, id, data) {
  return {
    name:`projects/${PROJECT}/databases/(default)/documents/${collection}/${id}`,
    createTime:'2020-01-02T03:04:05.000Z',
    updateTime:'2024-01-02T03:04:05.000Z',
    fields:Object.fromEntries(Object.entries(data).map(([key,value]) => [key,firestoreValue(value)]))
  };
}

function syntheticDocuments() {
  return [
    firestoreDocument('companies','company-a',{name:'North & Co',preferences:{tax:6}}),
    firestoreDocument('companies','company-b',{name:'North & Co',preferences:{taxRate:8}}),
    firestoreDocument('users','legacy-super',{username:'Legacy Root',role:'super'}),
    firestoreDocument('users','manager-a',{username:'Manager',role:'company_admin',company_id:'company-a'}),
    firestoreDocument('products','product-a',{name:'Tea',company_id:'company-a',price:4.5,cost:2,stock:10,variants:[]}),
    firestoreDocument('clients','client-a',{id:null,name:'Customer',company_id:'company-a'}),
    firestoreDocument('transactions','sale-a',{company_id:'company-a',type:'Invoice',total:12.34}),
    firestoreDocument('transactions','expense-line',{company_id:'company-a',type:'Expense',total:5}),
    firestoreDocument('transactions','missing-total',{company_id:'company-a',type:'Invoice'}),
    firestoreDocument('transactions','missing-type',{company_id:'company-a',total:2}),
    firestoreDocument('transactions','expense-missing-total',{company_id:'company-a',type:'Expense'}),
    firestoreDocument('expenses','expense-a',{company_id:'company-a',amount:3.25}),
    firestoreDocument('activities','activity-a',{company_id:'company-a',actorId:'manager-a',date:'2024-01-01T00:00:00.000Z'}),
    firestoreDocument('activities','global-activity',{actorId:'legacy-super',date:'2024-01-01T00:00:00.000Z'})
  ];
}

async function writeProtected(path, contents) {
  await writeFile(path, contents, { mode:0o600 });
  await chmod(path, 0o600);
}

async function syntheticExport(t, reportChanges = {}) {
  const directory = await mkdtemp(join(tmpdir(),'myfin-original-firebase-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  await chmod(directory,0o700);
  const documents = syntheticDocuments();
  const payloads = {
    'auth-users.json':JSON.stringify([
      {localId:'legacy-super',email:'root@example.test',displayName:'Legacy Root',providerUserInfo:[]},
      {localId:'manager-a',email:'manager@example.test',displayName:'Manager',providerUserInfo:[]},
      {localId:'auth-only',email:'orphan@example.test',displayName:'Auth only',providerUserInfo:[]}
    ]),
    'firestore.ndjson':`${documents.map(row => JSON.stringify(row)).join('\n')}\n`,
    'storage-objects.json':'[]'
  };
  for (const [name,contents] of Object.entries(payloads)) await writeProtected(join(directory,name),contents);
  const counts = Object.fromEntries(COLLECTIONS.map(name => [name,documents.filter(row => row.name.includes(`/documents/${name}/`)).length]));
  const report = {
    status:'complete',productionWrites:0,credentialExport:false,errors:[],project:PROJECT,readTime:READ_TIME,
    collections:counts,firestoreDocuments:documents.length,authUsers:3,storageObjects:0,
    files:Object.entries(payloads).map(([name,contents]) => ({name,bytes:Buffer.byteLength(contents),sha256:sha256(contents)})),
    ...reportChanges
  };
  await writeProtected(join(directory,'report.json'),JSON.stringify(report));
  return {directory,payloads,report};
}

class FakeQueryClient {
  constructor({ plan, conflict=false, prior=null, ready=true } = {}) {
    this.plan = plan;
    this.conflict = conflict;
    this.prior = prior;
    this.ready = ready;
    this.calls = [];
  }
  async query(sql, params=[]) {
    this.calls.push({sql,params});
    if (sql.includes('schema_migrations')) return {rows:[{ready:this.ready}]};
    if (sql.includes('original_firebase_import_runs')) return {rows:this.prior ? [this.prior] : []};
    if (this.prior) {
      if (sql.includes('original_firebase_source_records') && sql.includes('AS records')) return {rows:[{
        records:this.plan.counts.sourceRecords,review_only:this.plan.counts.reviewOnly,
        auth_profiles:this.plan.counts.authProfiles,mappings:this.plan.counts.importedRecords+this.plan.companyMappings.length
      }]};
      if (sql.includes('FROM myfin.workspaces')) return {rows:this.plan.workspaces.map(row=>({id:row.id}))};
      if (sql.includes('FROM myfin.companies')) return {rows:this.plan.companyMappings.map(row=>({id:row.targetCompanyId}))};
      if (sql.includes('FROM myfin.app_identities')) return {rows:[this.plan.importActorId,this.plan.unknownActorId,...this.plan.userMappings.map(row=>row.targetIdentityId)].map(id=>({id}))};
      if (sql.includes('FROM myfin.tenant_hosts')) return {rows:this.plan.companyMappings.map(row=>({hostname:row.targetHostname}))};
      if (sql.includes('FROM myfin.identity_mappings')) return {rows:this.plan.userMappings.map(row=>({subject:row.sourceUid}))};
      for (const table of ['products','clients','transactions','expenses','activities']) if (sql.includes(`FROM myfin.${table}`))
        return {rows:this.plan.records.filter(row=>row.disposition==='imported'&&row.targetTable===table).map(row=>({company_id:row.targetCompanyId,id:row.targetId}))};
    }
    if (!this.conflict) return {rows:[]};
    if (sql.includes('FROM myfin.app_identities') && sql.includes('id=ANY') && params[0]?.includes(this.plan.importActorId))
      return {rows:[{id:this.plan.importActorId,is_super:false,disabled_at:'2024-01-01'}]};
    if (sql.includes('FROM myfin.workspaces') && sql.includes('SELECT id')) return {rows:[{id:this.plan.workspaces[0].id}]};
    if (sql.includes('FROM myfin.workspaces') && sql.includes('SELECT slug')) return {rows:[{slug:this.plan.workspaces[0].slug}]};
    if (sql.includes('FROM myfin.companies')) return {rows:[{id:this.plan.companyMappings[0].targetCompanyId,workspace_id:this.plan.companyMappings[0].targetWorkspaceId}]};
    if (sql.includes('FROM myfin.tenant_hosts')) return {rows:[{hostname:this.plan.companyMappings[0].targetHostname,company_id:this.plan.companyMappings[0].targetCompanyId}]};
    if (sql.includes('FROM myfin.storefront_hosts')) return {rows:[{hostname:this.plan.companyMappings[0].targetHostname}]};
    if (sql.includes('FROM myfin.app_identities')) return {rows:[{id:this.plan.userMappings[0].targetIdentityId}]};
    if (sql.includes('FROM myfin.identity_mappings')) return {rows:[{subject:this.plan.userMappings[0].sourceUid,identity_id:'different-identity'}]};
    if (sql.includes('FROM myfin.original_firebase_source_records')) return {rows:[{source_path:this.plan.records[0].path}]};
    for (const table of ['products','clients','transactions','expenses','activities']) {
      if (!sql.includes(`FROM myfin.${table}`)) continue;
      const record = this.plan.records.find(row => row.disposition === 'imported' && row.targetTable === table);
      return {rows:record ? [{company_id:record.targetCompanyId,id:record.targetId}] : []};
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
}

test('protected export validates checksums and counts and generates isolated company mappings', async t => {
  const {directory} = await syntheticExport(t);
  const bundle = await loadOriginalFirebaseExport(directory);
  assert.equal(bundle.source.projectId,PROJECT);
  assert.equal(bundle.documents.length,syntheticDocuments().length);
  assert.deepEqual(bundle.reportCounts,{activities:2,clients:1,companies:2,expenses:1,products:1,transactions:5,users:2});
  assert.match(bundle.exportDigest,/^[a-f0-9]{64}$/);

  const manifest = generateOriginalFirebaseManifest(bundle);
  assert.equal(manifest.approved,false);
  assert.equal(manifest.companyMappings.length,2);
  const [first,second] = manifest.companyMappings;
  assert.notEqual(first.targetWorkspaceId,second.targetWorkspaceId);
  assert.notEqual(first.workspaceSlug,second.workspaceSlug);
  assert.notEqual(first.targetHostname,second.targetHostname);
  for (const mapping of manifest.companyMappings) {
    assert.match(mapping.targetCompanyId,/^firebase-company-[a-f0-9]{32}$/);
    assert.equal(mapping.companySlug,'main');
    assert.equal(mapping.targetHostname,`${mapping.workspaceSlug}-main.finn3.com`);
    assert.equal(mapping.existingProfilePolicy,'preserve_target');
  }
  assert.equal(manifest.userMappings.find(row => row.sourceUid === 'legacy-super').access,'identity_only');
  assert.equal(manifest.userMappings.find(row => row.sourceUid === 'manager-a').access,'preserve_role');
  assert.deepEqual(manifest.orphanAuthProfiles,[{sourceUid:'auth-only',disposition:'metadata_only'}]);
  assert.deepEqual(manifest.embeddedIdDecisions,[{sourcePath:'clients/client-a',disposition:'use_firestore_path_id'}]);
  assert.deepEqual(manifest.actorReferenceDecisions,[]);
  assert.deepEqual(manifest.businessReferenceDecisions,[]);

  const reviewPaths = new Set(manifest.recordDecisions.map(row => row.sourcePath));
  assert.deepEqual(reviewPaths,new Set([
    'activities/global-activity',
    'transactions/expense-missing-total',
    'transactions/missing-total',
    'transactions/missing-type'
  ]));
  assert.ok(manifest.recordDecisions.every(row => row.disposition === 'review_only'));
  assert.equal(manifest.expenseTransactionDecisions.find(row => row.sourcePath === 'transactions/expense-line').disposition,'keep_separate');
  assert.equal(manifest.expenseTransactionDecisions.find(row => row.sourcePath === 'transactions/expense-missing-total').disposition,'review_only');

  manifest.approved = true;
  validateOriginalFirebaseManifest(bundle,manifest,{requireApproval:true});
  const plan = createOriginalFirebaseImportPlan(bundle,manifest,{requireApproval:true});
  for (const path of reviewPaths) {
    const record = plan.records.find(row => row.path === path);
    assert.equal(record.disposition,'review_only');
    assert.equal(record.targetTable,null);
    assert.equal(record.targetData,null);
  }
  assert.equal(plan.records.find(row => row.path === 'transactions/expense-line').disposition,'imported');
  assert.equal(plan.counts.reviewOnly,4);
});

test('loader rejects a tampered payload and independently enforces reported record counts', async t => {
  const checksumExport = await syntheticExport(t);
  const authPath = join(checksumExport.directory,'auth-users.json');
  await writeProtected(authPath,`${await readFile(authPath,'utf8')} `);
  await assert.rejects(loadOriginalFirebaseExport(checksumExport.directory),{code:'export_checksum_mismatch'});

  const countExport = await syntheticExport(t,{firestoreDocuments:syntheticDocuments().length + 1});
  await assert.rejects(loadOriginalFirebaseExport(countExport.directory),{code:'firestore_count_mismatch'});
});

test('approval is mandatory before an import can reach a database transaction', async t => {
  const {directory} = await syntheticExport(t);
  const bundle = await loadOriginalFirebaseExport(directory);
  const manifest = generateOriginalFirebaseManifest(bundle);
  assert.throws(() => createOriginalFirebaseImportPlan(bundle,manifest,{requireApproval:true}),{code:'manifest_not_approved'});
  let transactionCalled = false;
  const database = { transaction:async () => { transactionCalled = true; throw new Error('must not run'); } };
  await assert.rejects(applyOriginalFirebaseImport(database,bundle,manifest),{code:'manifest_not_approved'});
  assert.equal(transactionCalled,false);
});

test('apply sends anomaly arrays as JSON and can repeat only after complete ledger verification', async t => {
  const {directory}=await syntheticExport(t);
  const bundle=await loadOriginalFirebaseExport(directory);
  const manifest=generateOriginalFirebaseManifest(bundle);manifest.approved=true;
  const plan=createOriginalFirebaseImportPlan(bundle,manifest,{requireApproval:true});
  const client=new FakeQueryClient({plan});
  const result=await applyOriginalFirebaseImport({transaction:fn=>fn(client)},bundle,manifest);
  assert.equal(result.alreadyApplied,false);
  const writes=client.calls.filter(call=>call.sql.includes('INSERT INTO myfin.original_firebase_source_records'));
  assert.equal(writes.length,plan.counts.sourceRecords);
  for(const write of writes){assert.equal(typeof write.params[15],'string');assert.ok(Array.isArray(JSON.parse(write.params[15])));}
});

test('deterministic target inspection reports conflicts and recognizes an identical prior run', async t => {
  const {directory} = await syntheticExport(t);
  const bundle = await loadOriginalFirebaseExport(directory);
  const manifest = generateOriginalFirebaseManifest(bundle);
  manifest.approved = true;
  const plan = createOriginalFirebaseImportPlan(bundle,manifest,{requireApproval:true});

  const cleanClient = new FakeQueryClient({plan});
  assert.deepEqual(await inspectOriginalFirebaseImportTarget(cleanClient,plan),{alreadyApplied:false,conflicts:[]});
  assert.equal(cleanClient.calls[0].params.length,0);

  const conflictClient = new FakeQueryClient({plan,conflict:true});
  assert.deepEqual((await inspectOriginalFirebaseImportTarget(conflictClient,plan)).conflicts,[
    'historical_actor_id_exists','workspace_id_exists','workspace_slug_exists','company_id_exists','tenant_hostname_exists','storefront_hostname_exists','identity_id_exists',
    'identity_mapping_exists','source_record_already_imported','products_id_exists','clients_id_exists','transactions_id_exists','expenses_id_exists','activities_id_exists'
  ]);

  const prior = {id:plan.runId,export_digest:plan.exportDigest,manifest_digest:plan.manifestDigest,counts:plan.counts};
  const repeatClient = new FakeQueryClient({plan,prior,conflict:true});
  assert.deepEqual(await inspectOriginalFirebaseImportTarget(repeatClient,plan),{alreadyApplied:true,conflicts:[],counts:plan.counts});
  assert.ok(repeatClient.calls.length>2);

  const mismatchClient = new FakeQueryClient({plan,prior:{...prior,manifest_digest:'0'.repeat(64)},conflict:true});
  assert.deepEqual(await inspectOriginalFirebaseImportTarget(mismatchClient,plan),{alreadyApplied:false,conflicts:['import_run_digest_mismatch']});
  assert.equal(mismatchClient.calls.length,2);
});
