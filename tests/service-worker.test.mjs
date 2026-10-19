// Run after npm run build. Checks the exact worker shipped by that build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';

const executeFile = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source=await readFile(new URL('../dist/sw.js',import.meta.url),'utf8');
const currentCache=source.match(/const CACHE = '([^']+)'/)?.[1];
function worker(fetch,clients=[]) {
  const events={},cached={kind:'old-cached-asset'},currentCached={kind:'current-cached-app'},installed=[],deleted=[];let skipped=false,claimed=false;
  runInNewContext(source,{URL,fetch,caches:{open:async()=>({addAll:async urls=>installed.push(...urls),match:async()=>currentCached}),match:async()=>cached,keys:async()=>['myfin-edition-111111111111',currentCache],delete:async key=>{deleted.push(key);return true;}},self:{location:{origin:'https://example.test'},clients:{claim:async()=>{claimed=true;},matchAll:async()=>clients},addEventListener:(name,fn)=>events[name]=fn,skipWaiting:async()=>{skipped=true;}}});
  return {events,cached,currentCached,installed,deleted,get skipped(){return skipped;},get claimed(){return claimed;}};
}
await test('production worker installs the shell and every emitted route asset',async()=>{
  const w=worker();let pending;w.events.install({waitUntil:p=>pending=p});await pending;
  assert.ok(w.installed.includes('/index.html'));assert.ok(w.installed.some(p=>p.includes('/assets/PosTab-')));assert.ok(w.installed.some(p=>p.endsWith('.css')));
  assert.equal(w.skipped,false,'installing an update must not interrupt the open app');
});
await test('production worker activates only after the app accepts the update',async()=>{
  const w=worker();let pending=null,acknowledgement=null;
  w.events.message({data:{type:'IGNORED'},waitUntil:p=>pending=p});
  assert.equal(pending,null);assert.equal(w.skipped,false);
  w.events.message({data:{type:'SKIP_WAITING'},source:{postMessage:value=>acknowledgement=value},waitUntil:p=>pending=p});
  await pending;assert.equal(w.skipped,true);assert.equal(acknowledgement.type,'APP_UPDATE_ACCEPTED');
});
await test('activation preserves old hashed chunks for other open tabs',async()=>{
  const messages=[],client={id:'old-tab',postMessage:value=>messages.push(value)};
  const w=worker(undefined,[client]);let activation,result,pending;
  w.events.activate({waitUntil:p=>activation=p});await activation;
  assert.equal(w.claimed,true);assert.deepEqual(w.deleted,[]);assert.equal(messages[0].type,'REQUEST_CLIENT_RELEASE');
  w.events.fetch({request:{method:'GET',url:'https://example.test/assets/old-release-chunk.js',mode:'cors'},respondWith:p=>result=p});
  assert.equal(await result,w.cached);
  w.events.message({data:{type:'CLIENT_RELEASE',release:'111111111111'},source:client,waitUntil:p=>pending=p});
  await pending;assert.deepEqual(w.deleted,[],'the cache reported by an old open tab must remain');
  w.events.message({data:{type:'CLIENT_RELEASE',release:currentCache.replace('myfin-edition-','')},source:client,waitUntil:p=>pending=p});
  await pending;assert.deepEqual(w.deleted,['myfin-edition-111111111111'],'the old cache can be pruned after its last tab updates');
});
for(const mode of ['network unavailable','gateway error']) await test(`navigation uses the cached shell on ${mode}`,async()=>{
  const w=worker(async()=>{if(mode==='network unavailable')throw Error('offline');return {ok:false,status:503};});let result;
  w.events.fetch({request:{method:'GET',url:'https://example.test/pos',mode:'navigate'},respondWith:p=>result=p});assert.equal(await result,w.currentCached);
});
await test('worker does not intercept Firebase or outgoing writes',()=>{
  const w=worker();let intercepted=false;
  for(const request of [{method:'GET',url:'https://firestore.googleapis.com/data'},{method:'POST',url:'https://example.test/data'}])w.events.fetch({request,respondWith:()=>intercepted=true});assert.equal(intercepted,false);
});
await test('API and private file navigation never uses cache or SPA fallback',()=>{
 const w=worker();let intercepted=false;
 for(const path of ['/api','/api/me','/api/files/private','/api/auth/get-session','/%61pi/files/private','//api/files/private','/api%2ffiles%2fprivate'])for(const mode of ['navigate','cors'])w.events.fetch({request:{method:'GET',url:'https://example.test'+path,mode},respondWith:()=>intercepted=true});
 assert.equal(intercepted,false);
});

await test('offline cache version changes when any precached file changes',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'myfin-offline-'));
  try {
    await mkdir(join(directory,'dist','assets'),{recursive:true});
    await Promise.all([
      writeFile(join(directory,'dist','index.html'),'<html><head></head><body><main>app</main></body></html>'),
      writeFile(join(directory,'dist','edition-icon.svg'),'<svg>one</svg>'),
      writeFile(join(directory,'dist','assets','main-abc.js'),'export default 1;'),
    ]);
    const script=join(projectRoot,'scripts','build-offline.mjs');
    await executeFile(process.execPath,[script],{cwd:directory});
    const first=await readFile(join(directory,'dist','sw.js'),'utf8');
    const firstRelease=await readFile(join(directory,'dist','release.json'),'utf8');
    const firstIndex=await readFile(join(directory,'dist','index.html'),'utf8');
    await executeFile(process.execPath,[script],{cwd:directory});
    assert.equal(await readFile(join(directory,'dist','sw.js'),'utf8'),first);
    assert.equal(await readFile(join(directory,'dist','release.json'),'utf8'),firstRelease);
    assert.equal(await readFile(join(directory,'dist','index.html'),'utf8'),firstIndex);
    await writeFile(join(directory,'dist','edition-icon.svg'),'<svg>two</svg>');
    await executeFile(process.execPath,[script],{cwd:directory});
    const second=await readFile(join(directory,'dist','sw.js'),'utf8');
    const version=text=>text.match(/const CACHE = '([^']+)'/)?.[1];
    assert.ok(version(first));assert.ok(version(second));assert.notEqual(version(first),version(second));
    const release=JSON.parse(await readFile(join(directory,'dist','release.json'),'utf8')).release;
    const index=await readFile(join(directory,'dist','index.html'),'utf8');
    const extensionlessWorker=await readFile(join(directory,'dist','offline-worker'),'utf8');
    assert.equal(release,version(second).replace('myfin-edition-',''));
    assert.match(index,new RegExp(`<meta name="myfin-release" content="${release}">`));
    assert.equal(extensionlessWorker,second);
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
});

await test('app update prompt checks durably and only activates on user action',async()=>{
  const [main,app,state,nginx]=await Promise.all([
    readFile(join(projectRoot,'src','main.js'),'utf8'),
    readFile(join(projectRoot,'src','App.vue'),'utf8'),
    readFile(join(projectRoot,'src','store','state.js'),'utf8'),
    readFile(join(projectRoot,'deploy','nginx.conf'),'utf8'),
  ]);
  assert.match(main,/`\/offline-worker\?release=\$\{encodeURIComponent\(BUILD_RELEASE\)\}`/);
  assert.match(main,/register\(workerUrl, \{ scope: '\/', updateViaCache: 'none' \}\)/);
  assert.match(main,/fetch\(`\/release\.json\?from=/);
  assert.match(main,/cache: 'no-store'/);
  assert.match(main,/registration\.waiting/);
  assert.match(main,/addEventListener\('updatefound'/);
  assert.match(main,/addEventListener\('online', checkForUpdate\)/);
  assert.match(main,/addEventListener\('visibilitychange'/);
  assert.match(main,/setInterval\(checkForUpdate, APP_UPDATE_CHECK_INTERVAL_MS\)/);
  assert.match(main,/worker\.postMessage\(\{ type: 'SKIP_WAITING' \}\)/);
  assert.match(main,/if \(updateRequested\) location\.reload\(\)/);
  assert.match(state,/appUpdateAvailable: false/);assert.match(state,/appUpdateApplying: false/);
  assert.match(state,/appUpdateMessage: ''/);
  assert.match(app,/v-if="Store\.state\.appUpdateAvailable"/);
  assert.match(app,/dispatchEvent\(new Event\('myfin:apply-app-update'\)\)/);
  assert.match(app,/:disabled="Store\.state\.appUpdateApplying"/);
  assert.match(nginx,/location = \/offline-worker[\s\S]*default_type application\/javascript[\s\S]*Cache-Control 'no-cache, no-store, must-revalidate' always/);
  assert.match(nginx,/location = \/release\.json[\s\S]*default_type application\/json[\s\S]*Cache-Control 'no-cache, no-store, must-revalidate' always/);
  assert.match(nginx,/location \/[\s\S]*Cache-Control 'no-cache, must-revalidate' always/);
});
