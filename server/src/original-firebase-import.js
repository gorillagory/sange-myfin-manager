import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { normalizeProduct } from '../../src/domain/pos.js';

const COLLECTIONS = ['activities','clients','companies','expenses','products','transactions','users'];
const AUTH_FIELDS = new Set(['localId','email','emailVerified','displayName','disabled','createdAt','lastLoginAt','lastRefreshAt','phoneNumber','photoUrl','customAttributes','tenantId','providerUserInfo']);
const PROVIDER_AUTH_FIELDS = new Set(['providerId','rawId','email','displayName','photoUrl','phoneNumber','federatedId']);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const TARGET_ROOT_DOMAIN = 'finn3.com';
const ID = /^.{1,256}$/s;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

export class OriginalFirebaseImportError extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}
const fail = (code, details) => { throw new OriginalFirebaseImportError(code, details); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const safeDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const unique = values => [...new Set(values)];
const asArray = value => Array.isArray(value) ? value : fail('invalid_manifest');
const asText = value => typeof value === 'string' && ID.test(value) ? value : fail('invalid_manifest');
const namespacedId = (kind,project,id) => `firebase-${kind}-${sha256(`${project}:${kind}:${id}`).slice(0,32)}`;

async function protectedFile(path) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) fail('export_file_missing');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) fail('export_permissions_not_private');
  return info;
}

async function protectedDirectory(path) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isDirectory()) fail('export_directory_missing');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) fail('export_permissions_not_private');
}

export function decodeFirestoreValue(value) {
  if (!object(value) || Object.keys(value).length !== 1) fail('invalid_firestore_value');
  const [kind] = Object.keys(value), raw = value[kind];
  if (kind === 'nullValue') return null;
  if (kind === 'stringValue' || kind === 'referenceValue' || kind === 'bytesValue') {
    if (typeof raw !== 'string') fail('invalid_firestore_value');
    return raw;
  }
  if (kind === 'timestampValue') {
    const parsed = safeDate(raw);
    if (!parsed) fail('invalid_firestore_timestamp');
    return parsed;
  }
  if (kind === 'booleanValue') {
    if (typeof raw !== 'boolean') fail('invalid_firestore_value');
    return raw;
  }
  if (kind === 'integerValue') {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) fail('unsafe_firestore_integer');
    return parsed;
  }
  if (kind === 'doubleValue') {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) fail('invalid_firestore_double');
    return parsed;
  }
  if (kind === 'arrayValue') {
    if (raw !== undefined && !object(raw)) fail('invalid_firestore_value');
    return (raw?.values || []).map(decodeFirestoreValue);
  }
  if (kind === 'mapValue') {
    if (raw !== undefined && !object(raw)) fail('invalid_firestore_value');
    return Object.fromEntries(Object.entries(raw?.fields || {}).map(([k,v]) => [k,decodeFirestoreValue(v)]));
  }
  if (kind === 'geoPointValue') {
    if (!object(raw) || !Number.isFinite(Number(raw.latitude)) || !Number.isFinite(Number(raw.longitude))) fail('invalid_firestore_value');
    return clone(raw);
  }
  fail('unsupported_firestore_value');
}

function parseDocument(raw, project) {
  if (!object(raw) || !object(raw.fields) || typeof raw.name !== 'string') fail('invalid_firestore_document');
  const prefix = `projects/${project}/databases/`;
  if (!raw.name.startsWith(prefix) || !raw.name.includes('/documents/')) fail('firebase_project_mismatch');
  const relative = raw.name.split('/documents/')[1], parts = relative?.split('/');
  if (parts?.length !== 2 || !COLLECTIONS.includes(parts[0]) || !parts[1]) fail('unsupported_firestore_path');
  return {
    collection: parts[0], documentId: parts[1], path: relative,
    createTime: safeDate(raw.createTime), updateTime: safeDate(raw.updateTime),
    sourcePayloadDigest:sha256(stableStringify(raw.fields)),
    data: Object.fromEntries(Object.entries(raw.fields).map(([k,v]) => [k,decodeFirestoreValue(v)]))
  };
}

function validateAuthProfiles(raw, reportedCount) {
  if (!Array.isArray(raw) || raw.length !== reportedCount) fail('auth_count_mismatch');
  const seen = new Set();
  for (const profile of raw) {
    if (!object(profile) || typeof profile.localId !== 'string' || !profile.localId || seen.has(profile.localId)) fail('invalid_auth_profile');
    if (Object.keys(profile).some(key => !AUTH_FIELDS.has(key))) fail('auth_export_contains_unapproved_fields');
    if (!Array.isArray(profile.providerUserInfo || []) || (profile.providerUserInfo || []).some(provider =>
      !object(provider) || Object.keys(provider).some(key => !PROVIDER_AUTH_FIELDS.has(key)))) fail('auth_export_contains_unapproved_fields');
    seen.add(profile.localId);
  }
  return raw;
}

export async function loadOriginalFirebaseExport(directory) {
  const base = resolve(directory), reportPath = join(base,'report.json');
  await protectedDirectory(base);
  await protectedFile(reportPath);
  const reportBytes = await readFile(reportPath);
  const report = JSON.parse(reportBytes.toString('utf8'));
  if (!object(report) || report.status !== 'complete' || report.productionWrites !== 0 || report.credentialExport !== false || report.errors?.length) fail('unverified_export_report');
  if (typeof report.project !== 'string' || !PROJECT_ID.test(report.project) || !safeDate(report.readTime) || !object(report.collections)) fail('invalid_export_report');
  const fileRows = Array.isArray(report.files) ? report.files : fail('invalid_export_report');
  const required = ['auth-users.json','firestore.ndjson','storage-objects.json'];
  const files = {}, verified = {};
  for (const name of required) {
    const row = fileRows.find(item => item?.name === name);
    if (!row || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes)) fail('invalid_export_report');
    const path = join(base,name), info = await protectedFile(path), bytes = await readFile(path);
    if (info.size !== row.bytes || sha256(bytes) !== row.sha256) fail('export_checksum_mismatch');
    files[name] = row.sha256; verified[name] = bytes;
  }
  const firestoreText = verified['firestore.ndjson'].toString('utf8');
  const documents = firestoreText.split(/\r?\n/).filter(Boolean).map(line => parseDocument(JSON.parse(line),report.project));
  if (documents.length !== report.firestoreDocuments || new Set(documents.map(x => x.path)).size !== documents.length) fail('firestore_count_mismatch');
  const counts = Object.fromEntries(COLLECTIONS.map(name => [name,documents.filter(x => x.collection === name).length]));
  if (COLLECTIONS.some(name => counts[name] !== Number(report.collections[name] || 0))) fail('collection_count_mismatch');
  const authProfiles = validateAuthProfiles(JSON.parse(verified['auth-users.json'].toString('utf8')),Number(report.authUsers));
  const storage = JSON.parse(verified['storage-objects.json'].toString('utf8'));
  if (!Array.isArray(storage) || storage.length !== Number(report.storageObjects) || storage.length) fail('storage_import_not_supported');
  const source = { projectId:report.project, readTime:new Date(report.readTime).toISOString(), reportDigest:sha256(reportBytes), files };
  return {
    source, exportDigest:sha256(stableStringify(source)), reportCounts:counts,
    documents:documents.sort((a,b) => a.path.localeCompare(b.path)), authProfiles:authProfiles.sort((a,b) => a.localId.localeCompare(b.localId))
  };
}

function slugify(value, fallback, suffix = '', maximum = 63) {
  const base = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || fallback;
  const tail = suffix ? `-${suffix}` : '';
  return `${base.slice(0,maximum-tail.length).replace(/-+$/,'')}${tail}`;
}

function unresolvedBusinessReferences(bundle) {
  const clients=new Set(bundle.documents.filter(row=>row.collection==='clients').map(row=>`${row.data.company_id}\0${row.documentId}`));
  const products=new Set(bundle.documents.filter(row=>row.collection==='products').map(row=>`${row.data.company_id}\0${row.documentId}`));
  const unresolved=[];
  for(const record of bundle.documents.filter(row=>row.collection==='transactions')){
    const clientId=String(record.data.client_id||'');
    if(clientId&&!clients.has(`${record.data.company_id}\0${clientId}`))unresolved.push({
      key:`${record.path}#client_id`,sourcePath:record.path,referenceType:'client',sourceId:clientId,disposition:'preserve_unlinked_reference'
    });
    for(const [index,item] of (Array.isArray(record.data.items)?record.data.items:[]).entries()){
      const productId=String(item?.productId||item?.product_id||'');
      if(productId&&!products.has(`${record.data.company_id}\0${productId}`))unresolved.push({
        key:`${record.path}#items/${index}/product`,sourcePath:record.path,referenceType:'product',sourceId:productId,disposition:'preserve_unlinked_reference'
      });
    }
  }
  return unresolved;
}

export function generateOriginalFirebaseManifest(bundle) {
  const companies = bundle.documents.filter(x => x.collection === 'companies');
  const used = new Set();
  const companyMappings = companies.map(record => {
    let workspaceSlug = slugify(record.data.name,'workspace','',58);
    if (workspaceSlug.startsWith('order-')) workspaceSlug=slugify(`legacy-${workspaceSlug}`,'legacy-workspace','',58);
    if (used.has(workspaceSlug)) {
      const digest = sha256(record.documentId);
      for (let length = 8; used.has(workspaceSlug) && length <= digest.length; length += 4)
        workspaceSlug = slugify(record.data.name,'workspace',digest.slice(0,length),58);
    }
    if (used.has(workspaceSlug)) fail('workspace_slug_collision');
    used.add(workspaceSlug);
    const companySlug = 'main';
    return {
      sourceCompanyId:record.documentId,
      targetWorkspaceId:`firebase-workspace-${sha256(`${bundle.source.projectId}:${record.documentId}`).slice(0,24)}`,
      workspaceMode:'create', workspaceName:String(record.data.name || 'Imported workspace'), workspaceSlug,
      targetCompanyId:namespacedId('company',bundle.source.projectId,record.documentId), companyMode:'create', companySlug,
      targetHostname:`${workspaceSlug}-${companySlug}.${TARGET_ROOT_DOMAIN}`,
      existingProfilePolicy:'preserve_target'
    };
  });
  const users = bundle.documents.filter(x => x.collection === 'users');
  const userMappings = users.map(record => ({
    sourceUid:record.documentId, targetIdentityId:namespacedId('identity',bundle.source.projectId,record.documentId), identityMode:'create', sourceRole:String(record.data.role || ''),
    access:record.data.role === 'super' ? 'identity_only' : 'preserve_role'
  }));
  const userIds = new Set(users.map(x => x.documentId));
  const orphanAuthProfiles = bundle.authProfiles.filter(x => !userIds.has(x.localId)).map(x => ({sourceUid:x.localId,disposition:'metadata_only'}));
  const recordDecisions = bundle.documents.filter(record =>
    (record.collection === 'transactions' && (record.data.total === undefined || !record.data.type)) ||
    (record.collection === 'activities' && !record.data.company_id)
  ).map(record => ({sourcePath:record.path,disposition:'review_only',reason:
    record.collection === 'activities' ? 'global_activity_has_no_company' :
    record.data.total === undefined ? 'transaction_total_missing' : 'transaction_type_missing'}));
  const expenseTransactionDecisions = bundle.documents.filter(x => x.collection === 'transactions' && x.data.type === 'Expense').map(record => ({
    sourcePath:record.path, disposition:record.data.total === undefined ? 'review_only' : 'keep_separate'
  }));
  const embeddedIdDecisions = bundle.documents.filter(record => Object.hasOwn(record.data,'id') && record.data.id !== record.documentId)
    .map(record => ({sourcePath:record.path,disposition:'use_firestore_path_id'}));
  const actorReferenceDecisions=bundle.documents.filter(record=>record.collection==='activities' && record.data.actorId && !userIds.has(record.data.actorId))
    .map(record=>({sourcePath:record.path,sourceActorId:record.data.actorId,disposition:'unknown_historical_actor'}));
  const businessReferenceDecisions=unresolvedBusinessReferences(bundle);
  return {schemaVersion:1,approved:false,source:clone(bundle.source),companyMappings,userMappings,orphanAuthProfiles,recordDecisions,expenseTransactionDecisions,embeddedIdDecisions,actorReferenceDecisions,businessReferenceDecisions};
}

function indexUnique(rows, key, code='invalid_manifest') {
  const map = new Map();
  for (const row of rows) { const id = key(row); if (map.has(id)) fail(code); map.set(id,row); }
  return map;
}

export function validateOriginalFirebaseManifest(bundle, manifest, { requireApproval=false } = {}) {
  if (!object(manifest) || manifest.schemaVersion !== 1 || typeof manifest.approved !== 'boolean' || !object(manifest.source)) fail('invalid_manifest');
  if (stableStringify(manifest.source) !== stableStringify(bundle.source)) fail('manifest_source_mismatch');
  if (requireApproval && manifest.approved !== true) fail('manifest_not_approved');
  const sourceCompanies = bundle.documents.filter(x => x.collection === 'companies');
  const companies = indexUnique(asArray(manifest.companyMappings),row => asText(row.sourceCompanyId));
  if (companies.size !== sourceCompanies.length || sourceCompanies.some(row => !companies.has(row.documentId))) fail('incomplete_company_mapping');
  const targetCompanies = new Set(), workspaceIds=new Set(), workspaceSlugs=new Set(), targetHosts=new Set();
  for (const [sourceId,row] of companies) {
    if (row.companyMode !== 'create' || row.workspaceMode !== 'create' || row.existingProfilePolicy !== 'preserve_target') fail('invalid_company_mapping');
    for (const field of ['targetWorkspaceId','targetCompanyId','companySlug','targetHostname']) asText(row[field]);
    if (!SLUG.test(row.companySlug)) fail('invalid_company_slug');
    if (!HOSTNAME.test(row.targetHostname) || row.targetHostname !== `${row.workspaceSlug}-${row.companySlug}.${TARGET_ROOT_DOMAIN}` ||
        `${row.workspaceSlug}-${row.companySlug}`.length > 63) fail('invalid_company_hostname');
    if (row.targetCompanyId !== namespacedId('company',bundle.source.projectId,sourceId)) fail('invalid_target_company_id');
    if (row.targetWorkspaceId !== `firebase-workspace-${sha256(`${bundle.source.projectId}:${sourceId}`).slice(0,24)}`) fail('invalid_target_workspace_id');
    asText(row.workspaceName); if (!SLUG.test(row.workspaceSlug || '') || row.workspaceSlug.startsWith('order-')) fail('invalid_workspace_slug');
    if(workspaceIds.has(row.targetWorkspaceId)||workspaceSlugs.has(row.workspaceSlug)||targetHosts.has(row.targetHostname))fail('duplicate_workspace_mapping');
    workspaceIds.add(row.targetWorkspaceId);workspaceSlugs.add(row.workspaceSlug);targetHosts.add(row.targetHostname);
    if (targetCompanies.has(row.targetCompanyId)) fail('duplicate_target_company'); targetCompanies.add(row.targetCompanyId);
  }
  const sourceUsers = bundle.documents.filter(x => x.collection === 'users');
  const users = indexUnique(asArray(manifest.userMappings),row => asText(row.sourceUid));
  if (users.size !== sourceUsers.length || sourceUsers.some(row => !users.has(row.documentId))) fail('incomplete_user_mapping');
  const targetIdentities = new Set();
  for (const source of sourceUsers) {
    const row = users.get(source.documentId);
    if (row.identityMode !== 'create' || !['identity_only','preserve_role'].includes(row.access) || row.sourceRole !== String(source.data.role || '')) fail('invalid_user_mapping');
    if (row.access === 'preserve_role' && !['company_admin','company_user'].includes(row.sourceRole)) fail('invalid_role_mapping');
    if (row.access === 'identity_only' && row.sourceRole !== 'super') fail('invalid_role_mapping');
    if (row.targetIdentityId !== namespacedId('identity',bundle.source.projectId,source.documentId)) fail('invalid_target_identity_id');
    asText(row.targetIdentityId); if (targetIdentities.has(row.targetIdentityId)) fail('duplicate_target_identity'); targetIdentities.add(row.targetIdentityId);
    if (row.access === 'preserve_role' && !companies.has(source.data.company_id)) fail('user_company_mapping_missing');
  }
  const sourceUserIds = new Set(sourceUsers.map(x => x.documentId));
  const sourceOrphans = bundle.authProfiles.filter(x => !sourceUserIds.has(x.localId));
  const orphans = indexUnique(asArray(manifest.orphanAuthProfiles),row => asText(row.sourceUid));
  if (orphans.size !== sourceOrphans.length || sourceOrphans.some(row => !orphans.has(row.localId)) || [...orphans.values()].some(row => row.disposition !== 'metadata_only')) fail('invalid_orphan_auth_mapping');
  const requiredDecisions = bundle.documents.filter(record =>
    (record.collection === 'transactions' && (record.data.total === undefined || !record.data.type)) ||
    (record.collection === 'activities' && !record.data.company_id));
  const decisions = indexUnique(asArray(manifest.recordDecisions),row => asText(row.sourcePath));
  if (decisions.size !== requiredDecisions.length || requiredDecisions.some(row => decisions.get(row.path)?.disposition !== 'review_only')) fail('unresolved_source_anomaly');
  const expenseRows = bundle.documents.filter(x => x.collection === 'transactions' && x.data.type === 'Expense');
  const expenses = indexUnique(asArray(manifest.expenseTransactionDecisions),row => asText(row.sourcePath));
  if (expenses.size !== expenseRows.length || expenseRows.some(row => !['keep_separate','review_only'].includes(expenses.get(row.path)?.disposition))) fail('unresolved_expense_lineage');
  const embeddedRows=bundle.documents.filter(record=>Object.hasOwn(record.data,'id')&&record.data.id!==record.documentId);
  const embeddedIds=indexUnique(asArray(manifest.embeddedIdDecisions),row=>asText(row.sourcePath));
  if(embeddedIds.size!==embeddedRows.length||embeddedRows.some(row=>embeddedIds.get(row.path)?.disposition!=='use_firestore_path_id'))fail('unresolved_embedded_id');
  const unknownActorRows=bundle.documents.filter(record=>record.collection==='activities'&&record.data.actorId&&!sourceUserIds.has(record.data.actorId));
  const actorReferences=indexUnique(asArray(manifest.actorReferenceDecisions),row=>asText(row.sourcePath));
  if(actorReferences.size!==unknownActorRows.length||unknownActorRows.some(row=>{
    const decision=actorReferences.get(row.path);return decision?.disposition!=='unknown_historical_actor'||decision.sourceActorId!==row.data.actorId;
  }))fail('unresolved_activity_actor');
  const unresolvedReferences=unresolvedBusinessReferences(bundle);
  const businessReferences=indexUnique(asArray(manifest.businessReferenceDecisions),row=>asText(row.key));
  if(businessReferences.size!==unresolvedReferences.length||unresolvedReferences.some(expected=>{
    const decision=businessReferences.get(expected.key);
    return !decision||stableStringify(decision)!==stableStringify(expected);
  }))fail('unresolved_business_reference');
  return {companies,users,decisions,expenses,embeddedIds,actorReferences,businessReferences,manifestDigest:sha256(stableStringify(manifest))};
}

function cents(value, maximum=1000000000000) {
  const n = Number(value), rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  if (!Number.isFinite(n) || n < 0 || n > maximum || Math.abs(n-rounded) > 1e-6) fail('invalid_source_money');
  return rounded;
}
function finite(value, places, fallback=0, minimum=-1000000000, maximum=1000000000) {
  const n = Number(value ?? fallback), factor = 10 ** places, rounded = Math.round((n + Number.EPSILON) * factor) / factor;
  if (!Number.isFinite(n) || n < minimum || n > maximum || Math.abs(n-rounded) > 1e-7) fail('invalid_source_number');
  return rounded;
}
function sourceCompany(record) { return record.collection === 'companies' ? record.documentId : record.data.company_id ?? null; }
function anomaliesFor(record) {
  const result=[];
  if (Object.hasOwn(record.data,'id') && record.data.id !== record.documentId) result.push('embedded_id_differs_from_path');
  if (record.collection === 'transactions') {
    if (record.data.total === undefined) result.push('transaction_total_missing');
    else if (Math.abs(Number(record.data.total)-cents(record.data.total)) > 0) result.push('monetary_normalized_to_cents');
    if (!record.data.type) result.push('transaction_type_missing');
  }
  if (record.collection === 'activities' && !record.data.actorId) result.push('activity_actor_id_missing');
  if (record.collection === 'activities' && !record.data.company_id) result.push('global_activity_has_no_company');
  return result;
}

function transformed(record, targetCompanyId) {
  const data=clone(record.data); data.id=record.documentId;
  if (record.collection !== 'companies') data.company_id=targetCompanyId;
  if (record.collection === 'companies') {
    data.preferences=object(data.preferences)?data.preferences:{};
    data.preferences.taxRate=finite(data.preferences.taxRate ?? data.preferences.tax ?? 0,4,0,0,100);
    data.preferences.currency=String(data.preferences.currency || 'RM').trim() || 'RM';
    data.registration=String(data.registration || data.regNo || '').trim();
    if (!String(data.address || '').trim()) {
      data.address=[data.address1,data.postcode,data.state,data.country].map(value=>String(value||'').trim()).filter(Boolean).join(', ');
    }
    data.id=targetCompanyId;
  }
  if (record.collection === 'products') {
    if(record.documentId.length>128||!Array.isArray(data.variants||[]))fail('invalid_source_product');
    const product=normalizeProduct(data);
    product.price=finite(product.price,4,0,0);product.cost=finite(product.cost,4,0,0);product.stock=finite(product.stock,3);
    const variantIds=new Set();
    product.variants=product.variants.map(v=>{
      if(typeof v.id!=='string'||!v.id||v.id.length>128||variantIds.has(v.id))fail('invalid_source_product_variant');
      variantIds.add(v.id);
      return {...v,price:finite(v.price,4,0,0),cost:finite(v.cost,4,0,0),stock:finite(v.stock,3)};
    });
    return product;
  }
  if (record.collection === 'transactions' && data.total !== undefined) data.total=cents(data.total);
  if (record.collection === 'expenses') data.amount=cents(data.amount);
  return data;
}

export function createOriginalFirebaseImportPlan(bundle, manifest, options={}) {
  const validated=validateOriginalFirebaseManifest(bundle,manifest,{requireApproval:options.requireApproval});
  const companyMap=validated.companies,userMap=validated.users,provider=`firebase:${bundle.source.projectId}`;
  const importActorId=namespacedId('import',bundle.source.projectId,bundle.exportDigest);
  const unknownActorId=namespacedId('unknown',bundle.source.projectId,bundle.exportDigest);
  const workspaces=indexUnique([...companyMap.values()].map(row=>({id:row.targetWorkspaceId,mode:row.workspaceMode,name:row.workspaceName,slug:row.workspaceSlug,sourceCompanyId:row.sourceCompanyId})),row=>row.id);
  const records=[];
  for (const record of bundle.documents) {
    const sourceCompanyId=sourceCompany(record), company=sourceCompanyId?companyMap.get(sourceCompanyId):null;
    let disposition='imported',targetTable,targetId=record.documentId,targetCompanyId=company?.targetCompanyId||null;
    if (validated.decisions.has(record.path)) disposition='review_only';
    if (record.collection==='transactions' && validated.expenses.get(record.path)?.disposition==='review_only') disposition='review_only';
    const companyRequired=!['companies','users'].includes(record.collection) && disposition==='imported';
    if ((sourceCompanyId && !company) || (companyRequired && !sourceCompanyId)) fail('source_company_mapping_missing',{sourcePath:record.path});
    if (record.collection==='companies') {targetTable='companies';targetCompanyId=company.targetCompanyId;targetId=company.targetCompanyId;}
    else if (record.collection==='users') {targetTable='app_identities';targetId=userMap.get(record.documentId).targetIdentityId;}
    else targetTable=({products:'products',clients:'clients',transactions:'transactions',expenses:'expenses',activities:'activities'})[record.collection];
    if (disposition!=='imported') {targetTable=null;targetId=null;targetCompanyId=null;}
    const referenceAnomalies=[...validated.businessReferences.values()].filter(decision=>decision.sourcePath===record.path).map(decision=>`unlinked_${decision.referenceType}_reference`);
    const targetData=disposition==='imported'?transformed(record,company?.targetCompanyId):null;
    if(record.collection==='activities'&&targetData){
      const actorMapping=record.data.actorId?userMap.get(record.data.actorId):null;
      targetData.actorId=actorMapping?.targetIdentityId||unknownActorId;
    }
    records.push({...record,sourceCompanyId,targetCompanyId,targetTable,targetId,disposition,anomalies:unique([...anomaliesFor(record),...referenceAnomalies]),targetData});
  }
  const sumTransactions = values => values.reduce((sum,row)=>sum+Math.round(cents(row.data.total)*100),0)/100;
  const sourceTransactions=records.filter(x=>x.collection==='transactions'&&x.data.total!==undefined);
  const importedTransactions=records.filter(x=>x.collection==='transactions'&&x.disposition==='imported');
  const reviewTransactions=records.filter(x=>x.collection==='transactions'&&x.disposition==='review_only'&&x.data.total!==undefined);
  const anomalyCounts={};for(const record of records)for(const anomaly of record.anomalies)anomalyCounts[anomaly]=(anomalyCounts[anomaly]||0)+1;
  const companyReconciliation=[...companyMap.values()].map(mapping=>{
    const companyRecords=records.filter(row=>row.sourceCompanyId===mapping.sourceCompanyId);
    const sourceTx=companyRecords.filter(row=>row.collection==='transactions'&&row.data.total!==undefined);
    const importedTx=companyRecords.filter(row=>row.collection==='transactions'&&row.disposition==='imported');
    const products=companyRecords.filter(row=>row.collection==='products'&&row.disposition==='imported').map(row=>row.targetData);
    return {sourceCompanyId:mapping.sourceCompanyId,targetCompanyId:mapping.targetCompanyId,
      source:Object.fromEntries(COLLECTIONS.map(name=>[name,companyRecords.filter(row=>row.collection===name).length])),
      imported:Object.fromEntries(COLLECTIONS.map(name=>[name,companyRecords.filter(row=>row.collection===name&&row.disposition==='imported').length])),
      sourceTransactionTotal:sumTransactions(sourceTx),importedTransactionTotal:sumTransactions(importedTx),
      productStockTotal:products.reduce((sum,product)=>sum+product.stock,0),
      variantStockTotal:products.flatMap(product=>product.variants).reduce((sum,variant)=>sum+variant.stock,0)};
  }).sort((a,b)=>a.sourceCompanyId.localeCompare(b.sourceCompanyId));
  const counts={
    source:Object.fromEntries(COLLECTIONS.map(name=>[name,records.filter(x=>x.collection===name).length])),
    imported:Object.fromEntries(COLLECTIONS.map(name=>[name,records.filter(x=>x.collection===name&&x.disposition==='imported').length])),
    sourceRecords:records.length,importedRecords:records.filter(x=>x.disposition==='imported').length,
    reviewOnly:records.filter(x=>x.disposition==='review_only').length,authProfiles:bundle.authProfiles.length,
    sourceTransactionTotal:sumTransactions(sourceTransactions),importedTransactionTotal:sumTransactions(importedTransactions),
    reviewOnlyTransactionTotal:sumTransactions(reviewTransactions),anomalies:anomalyCounts,companyReconciliation
  };
  const runId=`firebase-${sha256(`${bundle.exportDigest}:${validated.manifestDigest}`).slice(0,40)}`;
  return {runId,provider,importActorId,unknownActorId,manifestDigest:validated.manifestDigest,source:bundle.source,exportDigest:bundle.exportDigest,counts,workspaces:[...workspaces.values()],companyMappings:[...companyMap.values()],userMappings:[...userMap.values()],records,authProfiles:bundle.authProfiles,orphanAuthProfiles:new Map(manifest.orphanAuthProfiles.map(x=>[x.sourceUid,x])),approved:manifest.approved};
}

async function rows(client,sql,params=[]) { return (await client.query(sql,params)).rows; }
async function ids(client,table,values,column='id') {
  if (!values.length) return [];
  return rows(client,`SELECT ${column} FROM myfin.${table} WHERE ${column}=ANY($1::text[])`,[unique(values)]);
}

async function priorImportComplete(client,plan,prior){
  if(stableStringify(prior.counts)!==stableStringify(plan.counts))return false;
  const expectedMappings=plan.counts.importedRecords+plan.companyMappings.length;
  const ledger=(await rows(client,`SELECT
    (SELECT count(*)::int FROM myfin.original_firebase_source_records WHERE import_run_id=$1) AS records,
    (SELECT count(*)::int FROM myfin.original_firebase_source_records WHERE import_run_id=$1 AND disposition='review_only') AS review_only,
    (SELECT count(*)::int FROM myfin.original_firebase_auth_profiles WHERE import_run_id=$1) AS auth_profiles,
    (SELECT count(*)::int FROM myfin.original_firebase_id_mappings WHERE import_run_id=$1) AS mappings`,[plan.runId]))[0];
  if(ledger?.records!==plan.counts.sourceRecords||ledger?.review_only!==plan.counts.reviewOnly||
      ledger?.auth_profiles!==plan.counts.authProfiles||ledger?.mappings!==expectedMappings)return false;
  const workspaces=await ids(client,'workspaces',plan.workspaces.map(row=>row.id));
  if(workspaces.length!==plan.workspaces.length)return false;
  const companies=await ids(client,'companies',plan.companyMappings.map(row=>row.targetCompanyId));
  if(companies.length!==plan.companyMappings.length)return false;
  const identityIds=[plan.importActorId,plan.unknownActorId,...plan.userMappings.map(row=>row.targetIdentityId)];
  const identities=await rows(client,'SELECT id FROM myfin.app_identities WHERE id=ANY($1::text[]) AND disabled_at IS NOT NULL AND NOT is_super',[identityIds]);
  if(identities.length!==identityIds.length)return false;
  const hosts=await rows(client,'SELECT hostname FROM myfin.tenant_hosts WHERE hostname=ANY($1::text[])',[plan.companyMappings.map(row=>row.targetHostname)]);
  if(hosts.length!==plan.companyMappings.length)return false;
  const identityMappings=await rows(client,'SELECT subject FROM myfin.identity_mappings WHERE provider=$1 AND subject=ANY($2::text[])',[plan.provider,plan.userMappings.map(row=>row.sourceUid)]);
  if(identityMappings.length!==plan.userMappings.length)return false;
  for(const table of ['products','clients','transactions','expenses','activities']){
    const expected=plan.records.filter(row=>row.disposition==='imported'&&row.targetTable===table);
    if(!expected.length)continue;
    const found=await rows(client,`SELECT company_id,id FROM myfin.${table} WHERE company_id=ANY($1::text[]) AND id=ANY($2::text[])`,[unique(expected.map(row=>row.targetCompanyId)),unique(expected.map(row=>row.targetId))]);
    const foundKeys=new Set(found.map(row=>`${row.company_id}\0${row.id}`));
    if(expected.some(row=>!foundKeys.has(`${row.targetCompanyId}\0${row.targetId}`)))return false;
  }
  return true;
}

export async function inspectOriginalFirebaseImportTarget(client, plan) {
  const ready=(await rows(client,"SELECT EXISTS(SELECT 1 FROM myfin.schema_migrations WHERE version='0019_original_firebase_import.sql') AS ready"))[0]?.ready===true;
  if(!ready) return {alreadyApplied:false,conflicts:['import_schema_not_ready']};
  const prior=(await rows(client,'SELECT id,export_digest,manifest_digest,counts FROM myfin.original_firebase_import_runs WHERE id=$1',[plan.runId]))[0];
  if(prior){
    if(prior.export_digest!==plan.exportDigest||prior.manifest_digest!==plan.manifestDigest) return {alreadyApplied:false,conflicts:['import_run_digest_mismatch']};
    if(!await priorImportComplete(client,plan,prior))return {alreadyApplied:false,conflicts:['import_run_drift']};
    return {alreadyApplied:true,conflicts:[],counts:prior.counts};
  }
  const conflicts=[];
  const actors=await rows(client,'SELECT id,is_super,disabled_at FROM myfin.app_identities WHERE id=ANY($1::text[])',[[plan.importActorId,plan.unknownActorId]]);
  if(actors.length)conflicts.push('historical_actor_id_exists');
  const workspaceRows=await ids(client,'workspaces',plan.workspaces.map(x=>x.id));
  const workspaceById=new Set(workspaceRows.map(x=>x.id));
  for(const mapping of plan.workspaces)if((mapping.mode==='create')===workspaceById.has(mapping.id))conflicts.push(mapping.mode==='create'?'workspace_id_exists':'workspace_missing');
  const slugRows=plan.workspaces.some(x=>x.mode==='create')?await rows(client,'SELECT slug FROM myfin.workspaces WHERE slug=ANY($1::text[])',[plan.workspaces.filter(x=>x.mode==='create').map(x=>x.slug)]):[];
  if(slugRows.length)conflicts.push('workspace_slug_exists');
  const companyRows=await rows(client,'SELECT id,workspace_id FROM myfin.companies WHERE id=ANY($1::text[])',[plan.companyMappings.map(x=>x.targetCompanyId)]);
  const companyById=new Map(companyRows.map(x=>[x.id,x]));
  for(const mapping of plan.companyMappings){const found=companyById.get(mapping.targetCompanyId);if(mapping.companyMode==='create'&&found)conflicts.push('company_id_exists');if(mapping.companyMode==='existing'&&(!found||found.workspace_id!==mapping.targetWorkspaceId))conflicts.push('existing_company_mismatch');}
  const hostRows=await rows(client,'SELECT hostname,company_id FROM myfin.tenant_hosts WHERE hostname=ANY($1::text[])',[plan.companyMappings.map(x=>x.targetHostname)]);
  for(const found of hostRows){const expected=plan.companyMappings.find(x=>x.targetHostname===found.hostname);if(!expected||expected.targetCompanyId!==found.company_id||expected.companyMode==='create')conflicts.push('tenant_hostname_exists');}
  const storefrontHostRows=await rows(client,'SELECT hostname FROM myfin.storefront_hosts WHERE hostname=ANY($1::text[])',[plan.companyMappings.map(x=>x.targetHostname)]);
  if(storefrontHostRows.length)conflicts.push('storefront_hostname_exists');
  const identityRows=await ids(client,'app_identities',plan.userMappings.map(x=>x.targetIdentityId));
  const identityById=new Set(identityRows.map(x=>x.id));
  for(const mapping of plan.userMappings)if((mapping.identityMode==='create')===identityById.has(mapping.targetIdentityId))conflicts.push(mapping.identityMode==='create'?'identity_id_exists':'identity_missing');
  const mappingRows=await rows(client,'SELECT subject,identity_id FROM myfin.identity_mappings WHERE provider=$1 AND subject=ANY($2::text[])',[plan.provider,plan.userMappings.map(x=>x.sourceUid)]);
  if(mappingRows.length)conflicts.push('identity_mapping_exists');
  const sourceRows=await rows(client,'SELECT source_path FROM myfin.original_firebase_source_records WHERE source_project=$1 AND source_path=ANY($2::text[]) LIMIT 1',[plan.source.projectId,plan.records.map(x=>x.path)]);
  if(sourceRows.length)conflicts.push('source_record_already_imported');
  for(const table of ['products','clients','transactions','expenses','activities']){
    const expected=plan.records.filter(x=>x.disposition==='imported'&&x.targetTable===table);if(!expected.length)continue;
    const found=await rows(client,`SELECT company_id,id FROM myfin.${table} WHERE company_id=ANY($1::text[]) AND id=ANY($2::text[])`,[unique(expected.map(x=>x.targetCompanyId)),unique(expected.map(x=>x.targetId))]);
    const keys=new Set(expected.map(x=>`${x.targetCompanyId}\0${x.targetId}`));if(found.some(x=>keys.has(`${x.company_id}\0${x.id}`)))conflicts.push(`${table}_id_exists`);
  }
  return {alreadyApplied:false,conflicts:unique(conflicts)};
}

async function insertSourceRecord(c,plan,record){
  await c.query(`INSERT INTO myfin.original_firebase_source_records
    (import_run_id,source_project,source_path,collection_name,document_id,source_company_id,source_created_at,source_updated_at,source_payload_digest,payload_digest,decoded_data,disposition,target_table,target_company_id,target_id,anomalies)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[
      plan.runId,plan.source.projectId,record.path,record.collection,record.documentId,record.sourceCompanyId,record.createTime,record.updateTime,
      record.sourcePayloadDigest,sha256(stableStringify(record.data)),record.data,record.disposition,record.targetTable,record.targetCompanyId,record.targetId,record.anomalies]);
  if(record.disposition==='imported')await c.query(`INSERT INTO myfin.original_firebase_id_mappings
    (import_run_id,entity_type,source_company_id,source_id,target_table,target_company_id,target_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [plan.runId,record.collection,record.sourceCompanyId||'',record.documentId,record.targetTable,record.targetCompanyId||'',record.targetId]);
}

export async function applyOriginalFirebaseImport(database,bundle,manifest){
  const plan=createOriginalFirebaseImportPlan(bundle,manifest,{requireApproval:true});
  return database.transaction(async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('myfin:original-firebase-import',19))");
    const target=await inspectOriginalFirebaseImportTarget(c,plan);
    if(target.alreadyApplied)return {alreadyApplied:true,runId:plan.runId,counts:target.counts};
    if(target.conflicts.length)fail('target_conflicts',{conflicts:target.conflicts});
    await c.query(`INSERT INTO myfin.original_firebase_import_runs
      (id,source_project,source_read_time,source_files,export_digest,manifest_digest,counts) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [plan.runId,plan.source.projectId,plan.source.readTime,plan.source.files,plan.exportDigest,plan.manifestDigest,plan.counts]);
    await c.query("INSERT INTO myfin.app_identities(id,display_name,is_super,disabled_at) VALUES($1,'Original Firebase import',false,$3),($2,'Unknown historical Firebase actor',false,$3)",[plan.importActorId,plan.unknownActorId,plan.source.readTime]);
    for(const workspace of plan.workspaces)if(workspace.mode==='create'){
      const sourceCompany=plan.records.find(x=>x.collection==='companies'&&x.documentId===workspace.sourceCompanyId);
      await c.query("INSERT INTO myfin.workspaces(id,name,slug,data,created_at) VALUES($1,$2,$3,$4,$5)",[workspace.id,workspace.name,workspace.slug,{source:'original-firebase-import'},sourceCompany?.createTime||plan.source.readTime]);
    }
    for(const mapping of plan.companyMappings){
      const record=plan.records.find(x=>x.collection==='companies'&&x.documentId===mapping.sourceCompanyId);
      if(mapping.companyMode==='create')await c.query("INSERT INTO myfin.companies(id,name,data,workspace_id,slug,created_at) VALUES($1,$2,$3,$4,$5,$6)",
        [mapping.targetCompanyId,String(record.targetData.name||'Imported company'),record.targetData,mapping.targetWorkspaceId,mapping.companySlug,record.createTime||new Date(0).toISOString()]);
      if(mapping.companyMode==='create')await c.query("INSERT INTO myfin.tenant_hosts(hostname,workspace_id,company_id,canonical,created_at) VALUES($1,$2,$3,true,$4)",
        [mapping.targetHostname,mapping.targetWorkspaceId,mapping.targetCompanyId,record.createTime||plan.source.readTime]);
      await c.query("INSERT INTO myfin.original_firebase_id_mappings(import_run_id,entity_type,source_company_id,source_id,target_table,target_company_id,target_id) VALUES($1,'workspace',$2,$2,'workspaces','',$3)",[plan.runId,mapping.sourceCompanyId,mapping.targetWorkspaceId]);
    }
    const sourceUsers=new Map(plan.records.filter(x=>x.collection==='users').map(x=>[x.documentId,x]));
    for(const mapping of plan.userMappings){
      const record=sourceUsers.get(mapping.sourceUid), data=record.data;
      if(mapping.identityMode==='create')await c.query("INSERT INTO myfin.app_identities(id,display_name,is_super,disabled_at,created_at) VALUES($1,$2,$3,$4,$5)",[
        mapping.targetIdentityId,String(data.username||'Historical user'),false,plan.source.readTime,safeDate(data.createdAt)||record.createTime||new Date(0).toISOString()]);
      await c.query("INSERT INTO myfin.identity_mappings(provider,subject,identity_id) VALUES($1,$2,$3)",[plan.provider,mapping.sourceUid,mapping.targetIdentityId]);
      if(mapping.access==='preserve_role'){
        const company=plan.companyMappings.find(x=>x.sourceCompanyId===data.company_id);
        if(data.role==='company_admin')await c.query("INSERT INTO myfin.workspace_memberships(workspace_id,identity_id,role) VALUES($1,$2,'workspace_owner')",[company.targetWorkspaceId,mapping.targetIdentityId]);
        await c.query("INSERT INTO myfin.memberships(company_id,identity_id,role) VALUES($1,$2,$3)",[company.targetCompanyId,mapping.targetIdentityId,data.role==='company_admin'?'manager':'operator']);
      }
    }
    for(const record of plan.records.filter(x=>x.disposition==='imported'&&x.collection==='clients'))await c.query("INSERT INTO myfin.clients(company_id,id,data) VALUES($1,$2,$3)",[record.targetCompanyId,record.targetId,record.targetData]);
    for(const record of plan.records.filter(x=>x.disposition==='imported'&&x.collection==='products')){
      const p=record.targetData;await c.query("INSERT INTO myfin.products(company_id,id,data,stock,price,cost) VALUES($1,$2,$3,$4,$5,$6)",[record.targetCompanyId,record.targetId,p,p.stock,p.price,p.cost]);
      for(const variant of p.variants)await c.query("INSERT INTO myfin.product_variants(company_id,product_id,id,stock,price,cost) VALUES($1,$2,$3,$4,$5,$6)",[record.targetCompanyId,record.targetId,variant.id,variant.stock,variant.price,variant.cost]);
    }
    for(const record of plan.records.filter(x=>x.disposition==='imported'&&x.collection==='transactions'))await c.query(
      "INSERT INTO myfin.transactions(company_id,id,actor_id,source,total,data,document_state) VALUES($1,$2,$3,'manual',$4,$5,'legacy')",
      [record.targetCompanyId,record.targetId,plan.importActorId,record.targetData.total,record.targetData]);
    for(const record of plan.records.filter(x=>x.disposition==='imported'&&x.collection==='expenses'))await c.query(
      "INSERT INTO myfin.expenses(company_id,id,amount,data,created_by) VALUES($1,$2,$3,$4,$5)",[record.targetCompanyId,record.targetId,record.targetData.amount,record.targetData,plan.importActorId]);
    for(const record of plan.records.filter(x=>x.disposition==='imported'&&x.collection==='activities')){
      const actorMapping=record.data.actorId?plan.userMappings.find(x=>x.sourceUid===record.data.actorId):null;
      await c.query("INSERT INTO myfin.activities(company_id,id,actor_id,data,created_at) VALUES($1,$2,$3,$4,$5)",[
        record.targetCompanyId,record.targetId,actorMapping?.targetIdentityId||plan.unknownActorId,record.targetData,safeDate(record.data.date)||record.createTime||new Date(0).toISOString()]);
    }
    for(const record of plan.records)await insertSourceRecord(c,plan,record);
    const mappedUsers=new Map(plan.userMappings.map(x=>[x.sourceUid,x]));
    for(const profile of plan.authProfiles){
      const mapping=mappedUsers.get(profile.localId), disposition=mapping?'identity_only':plan.orphanAuthProfiles.get(profile.localId)?.disposition;
      await c.query("INSERT INTO myfin.original_firebase_auth_profiles(import_run_id,source_uid,metadata,payload_digest,disposition,target_identity_id) VALUES($1,$2,$3,$4,$5,$6)",[
        plan.runId,profile.localId,profile,sha256(stableStringify(profile)),disposition,mapping?.targetIdentityId||null]);
    }
    return {alreadyApplied:false,runId:plan.runId,counts:plan.counts};
  });
}

export async function dryRunOriginalFirebaseImport(client,bundle,manifest){
  const plan=createOriginalFirebaseImportPlan(bundle,manifest);
  const target=await inspectOriginalFirebaseImportTarget(client,plan);
  return {runId:plan.runId,approved:plan.approved,alreadyApplied:target.alreadyApplied,conflicts:target.conflicts,counts:plan.counts};
}
