// Run after npm run build. Checks the exact worker shipped by that build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source=await readFile(new URL('../dist/sw.js',import.meta.url),'utf8');
function worker(fetch) {
  const events={},cached={kind:'cached-app'},installed=[];
  runInNewContext(source,{URL,fetch,caches:{open:async()=>({addAll:async urls=>installed.push(...urls)}),match:async()=>cached},self:{location:{origin:'https://example.test'},addEventListener:(name,fn)=>events[name]=fn}});
  return {events,cached,installed};
}
await test('production worker installs the shell and every emitted route asset',async()=>{
  const w=worker();let pending;w.events.install({waitUntil:p=>pending=p});await pending;
  assert.ok(w.installed.includes('/index.html'));assert.ok(w.installed.some(p=>p.includes('/assets/PosTab-')));assert.ok(w.installed.some(p=>p.endsWith('.css')));
});
for(const mode of ['network unavailable','gateway error']) await test(`navigation uses the cached shell on ${mode}`,async()=>{
  const w=worker(async()=>{if(mode==='network unavailable')throw Error('offline');return {ok:false,status:503};});let result;
  w.events.fetch({request:{method:'GET',url:'https://example.test/pos',mode:'navigate'},respondWith:p=>result=p});assert.equal(await result,w.cached);
});
await test('worker does not intercept Firebase or outgoing writes',()=>{
  const w=worker();let intercepted=false;
  for(const request of [{method:'GET',url:'https://firestore.googleapis.com/data'},{method:'POST',url:'https://example.test/data'}])w.events.fetch({request,respondWith:()=>intercepted=true});assert.equal(intercepted,false);
});
