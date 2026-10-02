import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  loadOriginalFirebaseExport,
  sha256,
} from '../server/src/original-firebase-import.js';

const SOURCE_PROJECT='myfinmanager-1d2da';
const SOURCE_COMPANY_ID='1766763557834';
const EXPECTED_COMPANY_NAME='Snidect Technologies';
const COLLECTIONS=['activities','clients','companies','expenses','products','transactions','users'];
const PAYLOAD_NAMES=['auth-users.json','firestore.ndjson','storage-objects.json'];
const ARTIFACT_NAMES=[...PAYLOAD_NAMES,'report.json'];
const STAGING_NAME='.snidect-subset-staging';
const SYSTEM_SID='S-1-5-18';
const execFileAsync=promisify(execFile);

const WINDOWS_ACL_SCRIPT=String.raw`
$ErrorActionPreference='Stop'
$paths=@(ConvertFrom-Json -InputObject $env:MYFIN_SNIDECT_ACL_PATHS)
$currentSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$items=@()
foreach($path in $paths){
  $acl=Get-Acl -LiteralPath $path
  $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    [pscustomobject]@{
      sid=$_.IdentityReference.Value
      type=$_.AccessControlType.ToString()
      propagationFlags=$_.PropagationFlags.ToString()
    }
  })
  $items += [pscustomobject]@{
    ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    protected=$acl.AreAccessRulesProtected
    rules=$rules
  }
}
[pscustomobject]@{currentSid=$currentSid;items=$items} | ConvertTo-Json -Compress -Depth 6
`;

function fail(code){throw new Error(code);}
function codeUnitCompare(a,b){return a<b?-1:a>b?1:0;}
function sameStrings(a,b){
  const left=[...a].sort(codeUnitCompare),right=[...b].sort(codeUnitCompare);
  return left.length===right.length&&left.every((value,index)=>value===right[index]);
}
function pathIdentity(path){return process.platform==='win32'?path.toLowerCase():path;}

async function windowsAcl(paths,{requireProtected=false}={}){
  let result;
  try{
    const command=Buffer.from(WINDOWS_ACL_SCRIPT,'utf16le').toString('base64');
    const execution=await execFileAsync('pwsh.exe',[
      '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',command,
    ],{
      encoding:'utf8',
      env:{...process.env,MYFIN_SNIDECT_ACL_PATHS:JSON.stringify(paths)},
      maxBuffer:1024*1024,
      timeout:15000,
      windowsHide:true,
    });
    const jsonLine=execution.stdout.split(/\r?\n/).map(line=>line.trim().replace(/^\uFEFF/,'')).reverse()
      .find(line=>line.startsWith('{')&&line.endsWith('}'));
    result=JSON.parse(jsonLine);
  }catch{
    fail('subset_output_acl_unverifiable');
  }
  const items=Array.isArray(result?.items)?result.items:result?.items?[result.items]:[];
  const currentSid=result?.currentSid;
  if(typeof currentSid!=='string'||items.length!==paths.length)fail('subset_output_acl_unverifiable');
  const allowed=new Set([currentSid,SYSTEM_SID]);
  for(const item of items){
    if(!allowed.has(item?.ownerSid)||(requireProtected&&item.protected!==true))fail('subset_output_acl_not_private');
    const effectivePrincipals=new Set();
    const rules=Array.isArray(item.rules)?item.rules:item.rules?[item.rules]:[];
    if(!rules.length)fail('subset_output_acl_not_private');
    for(const rule of rules){
      if(rule?.type!=='Allow'||!allowed.has(rule.sid))fail('subset_output_acl_not_private');
      if(!String(rule.propagationFlags||'').split(/,\s*/).includes('InheritOnly'))effectivePrincipals.add(rule.sid);
    }
    if(!effectivePrincipals.has(currentSid)||!effectivePrincipals.has(SYSTEM_SID))fail('subset_output_acl_not_private');
  }
}

async function protectedOutputDirectory(directory,{empty=false}={}){
  const info=await lstat(directory).catch(()=>null);
  if(!info?.isDirectory()||info.isSymbolicLink())fail('subset_output_directory_required');
  if(process.platform==='win32')await windowsAcl([directory],{requireProtected:true});
  else{
    if((info.mode&0o7777)!==0o700)fail('subset_output_permissions_not_private');
    if(typeof process.getuid==='function'&&info.uid!==process.getuid())fail('subset_output_owner_mismatch');
  }
  if(empty&&(await readdir(directory)).length)fail('subset_output_must_be_empty');
  return realpath(directory);
}

async function privateStagedFiles(staging){
  if(process.platform==='win32'){
    await windowsAcl([staging,...ARTIFACT_NAMES.map(name=>join(staging,name))]);
    return;
  }
  const directory=await lstat(staging);
  if((directory.mode&0o7777)!==0o700)fail('subset_staging_permissions_not_private');
  for(const name of ARTIFACT_NAMES){
    const info=await lstat(join(staging,name));
    if(!info.isFile()||(info.mode&0o7777)!==0o600)fail('subset_staging_permissions_not_private');
  }
}

function verifySubset(bundle,expectedPaths,expectedUserIds,expectedReadTime){
  const company=bundle.documents.find(row=>row.path===`companies/${SOURCE_COMPANY_ID}`);
  const actualPaths=bundle.documents.map(row=>row.path);
  const actualAuthIds=bundle.authProfiles.map(profile=>profile.localId);
  if(
    bundle.source.projectId!==SOURCE_PROJECT||
    bundle.source.readTime!==expectedReadTime||
    company?.data.name!==EXPECTED_COMPANY_NAME||
    bundle.reportCounts.companies!==1||
    !sameStrings(actualPaths,expectedPaths)||
    !sameStrings(actualAuthIds,expectedUserIds)||
    bundle.documents.some(row=>row.path!==company.path&&row.data.company_id!==SOURCE_COMPANY_ID)
  )fail('subset_verification_failed');
}

async function cleanupPartialOutput(output,staging,movedNames){
  const failures=[];
  for(const name of movedNames){
    try{await unlink(join(output,name));}catch(error){if(error?.code!=='ENOENT')failures.push(error);}
  }
  for(const name of ARTIFACT_NAMES){
    try{await unlink(join(staging,name));}catch(error){if(error?.code!=='ENOENT')failures.push(error);}
  }
  try{await rmdir(staging);}catch(error){if(error?.code!=='ENOENT')failures.push(error);}
  if(failures.length)fail('subset_cleanup_failed');
}

const [sourceArgument,outputArgument,expectedDigestArgument]=process.argv.slice(2);
if(!sourceArgument||!outputArgument||!expectedDigestArgument||process.argv.length!==5){
  fail('usage: node scripts/create-original-firebase-snidect-subset.mjs SOURCE OUTPUT EXPECTED_PARENT_EXPORT_DIGEST');
}
if(!/^[a-fA-F0-9]{64}$/.test(expectedDigestArgument))fail('invalid_expected_parent_export_digest');
const expectedParentExportDigest=expectedDigestArgument.toLowerCase();
const source=resolve(sourceArgument),output=resolve(outputArgument);
if(pathIdentity(source)===pathIdentity(output))fail('subset_output_must_differ');

const outputReal=await protectedOutputDirectory(output,{empty:true});
const sourceReal=await realpath(source).catch(()=>source);
if(pathIdentity(sourceReal)===pathIdentity(outputReal))fail('subset_output_must_differ');

const bundle=await loadOriginalFirebaseExport(source);
if(bundle.source.projectId!==SOURCE_PROJECT)fail('source_project_not_allowed');
if(bundle.exportDigest!==expectedParentExportDigest)fail('parent_export_digest_mismatch');
const company=bundle.documents.find(row=>row.path===`companies/${SOURCE_COMPANY_ID}`);
if(!company||company.data.name!==EXPECTED_COMPANY_NAME)fail('snidect_company_identity_mismatch');
const selected=bundle.documents.filter(row=>row.path===company.path||row.data.company_id===SOURCE_COMPANY_ID);
if(selected.some(row=>row.path!==company.path&&row.data.company_id!==SOURCE_COMPANY_ID))fail('subset_scope_invalid');
const selectedPaths=new Set(selected.map(row=>row.path));
const selectedUserIds=new Set(selected.filter(row=>row.collection==='users').map(row=>row.documentId));
const authProfiles=bundle.authProfiles
  .filter(profile=>selectedUserIds.has(profile.localId))
  .sort((a,b)=>codeUnitCompare(a.localId,b.localId));
if(authProfiles.length!==selectedUserIds.size)fail('selected_auth_profile_missing');

const firestoreBytes=await readFile(join(source,'firestore.ndjson'));
if(sha256(firestoreBytes)!==bundle.source.files['firestore.ndjson'])fail('source_changed_after_verification');
const originalLines=firestoreBytes.toString('utf8').split(/\r?\n/).filter(Boolean);
const keptLines=[];
for(const line of originalLines){
  const document=JSON.parse(line),relative=String(document.name||'').split('/documents/')[1];
  if(selectedPaths.has(relative))keptLines.push(line);
}
if(keptLines.length!==selected.length)fail('subset_source_line_mismatch');
const parentReportBytes=await readFile(join(source,'report.json'));
if(sha256(parentReportBytes)!==bundle.source.reportDigest)fail('source_changed_after_verification');

const payloads={
  'auth-users.json':`${JSON.stringify(authProfiles,null,2)}\n`,
  'firestore.ndjson':`${keptLines.join('\n')}\n`,
  'storage-objects.json':'[]\n',
};
const counts=Object.fromEntries(COLLECTIONS.map(name=>[name,selected.filter(row=>row.collection===name).length]));
const report={
  project:bundle.source.projectId,
  readTime:bundle.source.readTime,
  status:'complete',
  productionWrites:0,
  credentialExport:false,
  errors:[],
  collections:counts,
  firestoreDocuments:selected.length,
  firestoreStatus:'complete_verified_subset',
  authUsers:authProfiles.length,
  authStatus:'complete_without_password_hashes_or_tokens',
  storageObjects:0,
  storageStatus:'complete_empty',
  consistency:'Exact company-scoped subset of a checksum-verified fixed-read-time Firestore export.',
  derivation:{
    type:'verified_company_subset_v1',
    sourceCompanyId:SOURCE_COMPANY_ID,
    sourceCompanyNameSha256:sha256(EXPECTED_COMPANY_NAME),
    parentReportSha256:bundle.source.reportDigest,
    parentExportDigest:bundle.exportDigest,
    selectedPathsSha256:sha256([...selectedPaths].sort(codeUnitCompare).join('\n')),
  },
  files:Object.entries(payloads).map(([name,contents])=>({name,bytes:Buffer.byteLength(contents),sha256:sha256(contents)})),
};

const staging=join(output,STAGING_NAME);
const movedNames=[];
let stagingCreated=false;
try{
  await mkdir(staging,{mode:0o700});
  stagingCreated=true;
  if(process.platform!=='win32')await chmod(staging,0o700);
  for(const [name,contents] of Object.entries(payloads)){
    const path=join(staging,name);
    await writeFile(path,contents,{mode:0o600,flag:'wx'});
    if(process.platform!=='win32')await chmod(path,0o600);
  }
  const reportPath=join(staging,'report.json');
  await writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`,{mode:0o600,flag:'wx'});
  if(process.platform!=='win32')await chmod(reportPath,0o600);
  await privateStagedFiles(staging);

  const staged=await loadOriginalFirebaseExport(staging);
  verifySubset(staged,selectedPaths,selectedUserIds,bundle.source.readTime);
  await protectedOutputDirectory(output);
  const entries=await readdir(output);
  if(entries.length!==1||entries[0]!==STAGING_NAME)fail('subset_output_changed');

  for(const name of PAYLOAD_NAMES){
    await rename(join(staging,name),join(output,name));
    movedNames.push(name);
  }
  await rename(join(staging,'report.json'),join(output,'report.json'));
  movedNames.push('report.json');
  await rmdir(staging);
  stagingCreated=false;

  const verified=await loadOriginalFirebaseExport(output);
  verifySubset(verified,selectedPaths,selectedUserIds,bundle.source.readTime);
  if(process.platform==='win32'){
    await windowsAcl([output],{requireProtected:true});
    await windowsAcl(ARTIFACT_NAMES.map(name=>join(output,name)));
  }
  else await protectedOutputDirectory(output);
  process.stdout.write(`${JSON.stringify({
    sourceCompanyId:SOURCE_COMPANY_ID,
    readTime:verified.source.readTime,
    documents:verified.documents.length,
    authProfiles:verified.authProfiles.length,
    counts:verified.reportCounts,
    parentExportDigest:bundle.exportDigest,
    exportDigest:verified.exportDigest,
    reportDigest:verified.source.reportDigest,
  })}\n`);
}catch(error){
  if(stagingCreated||movedNames.length){
    try{await cleanupPartialOutput(output,staging,movedNames);}
    catch(cleanupError){throw new AggregateError([error,cleanupError],'subset_cleanup_failed');}
  }
  throw error;
}
