// Read only. Emits aggregate UID/profile compatibility, never user records or tokens.
const path = require('node:path');
const root = process.argv[2];
const cli = name => require(path.join(root, 'lib', name));
(async () => {
  const project = 'myfinmanager-1d2da';
  const options = {project,projectRoot:process.cwd(),nonInteractive:true};
  const auth = cli('auth.js');
  auth.setActiveAccount(options,auth.getProjectDefaultAccount(process.cwd()));
  await cli('requireAuth.js').requireAuth(options);
  const {Client}=cli('apiv2.js'),api=cli('api.js'),skipLog={reqBody:true,resBody:true};
  const firestore=new Client({auth:true,apiVersion:'v1',urlPrefix:api.firestoreOrigin()});
  const profiles=(await firestore.post(`projects/${project}/databases/(default)/documents:runQuery`,{structuredQuery:{from:[{collectionId:'users'}],select:{fields:[{fieldPath:'email'},{fieldPath:'role'},{fieldPath:'company_id'}]},limit:100}},{skipLog})).body.filter(r=>r.document).map(r=>r.document);
  const accounts=(await new Client({auth:true,urlPrefix:api.googleOrigin()}).post('/identitytoolkit/v3/relyingparty/downloadAccount',{targetProjectId:project,maxResults:100},{skipLog})).body;
  const users=accounts.users||[];
  const mismatches=profiles.filter(p=>!users.some(u=>u.localId===p.name.split('/').at(-1)&&u.email?.toLowerCase()===p.fields.email?.stringValue?.toLowerCase()));
  console.log(JSON.stringify({checkedAt:new Date().toISOString(),profiles:profiles.length,authAccounts:users.length,uidAndEmailMatches:profiles.length-mismatches.length,mismatches:mismatches.length,truncated:!!accounts.nextPageToken,readOnly:true}));
  if(mismatches.length||accounts.nextPageToken)process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1;});
