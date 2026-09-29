import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'vite';

const storage=new Map();
globalThis.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
const vite=await createServer({server:{middlewareMode:true,hmr:{port:0}},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
const {Store,DATA_REFRESH_STALE_MS}=await vite.ssrLoadModule('/src/store/editionStore.js');
const {hydrationCollections}=await vite.ssrLoadModule('/src/domain/viewAccess.js');
const {localPos}=await vite.ssrLoadModule('/src/services/posLocal.js');
const actor={uid:'refresh-operator',id:'refresh-operator',role:'company_user',company_id:'refresh-company'};
const company={id:'refresh-company',name:'Refresh Company',preferences:{currency:'RM'}};
const response=value=>({ok:true,status:200,json:async()=>value});

function session(){
  Store.clearSession();
  Store.state.currentUser={...actor};
  Store.state.companies=[company];
  Store.state.selectedCompany=company;
  Store.state.online=true;
  Store.state.fromCache=true;
  Store.state.dataLoading=false;
}
function result(path){
  if(path==='/api/me')return response({...actor});
  if(path==='/api/companies')return response([company]);
  if(path.endsWith('/receipt-reviews'))return response([]);
  return response({rows:[],next:null});
}

try{
  await test('refresh scheduling has no recurring full-data interval',async()=>{
    const source=await readFile(new URL('../src/store/editionStore.js',import.meta.url),'utf8');
    assert.doesNotMatch(source,/setInterval\s*\(/);
  });

  await test('silent concurrent refreshes share one request set and never flash loading',async()=>{
    session();
    const requested=[];let release;
    const gate=new Promise(resolve=>{release=resolve;});
    globalThis.fetch=async path=>{requested.push(path);await gate;return result(path);};
    const first=Store.refreshData({silent:true});
    const second=Store.refreshData({silent:true});
    await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(Store.state.dataLoading,false);
    release();
    const [a,b]=await Promise.all([first,second]);
    assert.equal(a.status,'refreshed');assert.equal(b.status,'refreshed');
    for(const suffix of [...hydrationCollections(actor).map(name=>'/'+name),'/receipt-reviews'])
      assert.equal(requested.filter(path=>path.endsWith(suffix)).length,1,suffix);
    assert.equal(Store.state.dataLoading,false);
  });

  await test('visible refresh stays idle while fresh, then coalesces one silent stale workspace refresh',async()=>{
    session();
    globalThis.fetch=async path=>result(path);
    await Store.refreshData({silent:true});
    let requested=[];let release;
    const gate=new Promise(resolve=>{release=resolve;});
    globalThis.fetch=async path=>{requested.push(path);await gate;return result(path);};
    const fresh=await Store.refreshIfStale(Date.now());
    assert.equal(fresh.status,'fresh');assert.equal(requested.length,0);
    const staleAt=Date.now()+DATA_REFRESH_STALE_MS+1;
    const first=Store.refreshIfStale(staleAt);
    const second=Store.refreshIfStale(staleAt);
    await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(Store.state.dataLoading,false);
    release();
    const [a,b]=await Promise.all([first,second]);
    assert.equal(a.status,'refreshed');assert.equal(b.status,'refreshed');
    assert.equal(requested.filter(path=>path==='/api/me').length,1);
    assert.equal(requested.filter(path=>path==='/api/companies').length,1);
    for(const suffix of [...hydrationCollections(actor).map(name=>'/'+name),'/receipt-reviews'])
      assert.equal(requested.filter(path=>path.endsWith(suffix)).length,1,suffix);
    assert.equal(Store.state.dataLoading,false);
  });

  await test('posted checkout refreshes stock and changed customers without fetching history',async()=>{
    session();Store.state.fromCache=false;
    Store.state.transactions=[{id:'older',company_id:company.id,type:'Invoice',source:'pos'}];
    Store.state.products=[{id:'product',name:'Latte',price:9,stock:10,trackStock:true,variants:[]}];
    Store.state.clients=[{id:'old-customer',name:'Old customer',type:'Customer'}];
    const posted={id:'paid-1',company_id:company.id,cashierId:actor.uid,type:'Invoice',source:'pos',status:'Paid',date:'2026-09-29T00:00:00.000Z',customerEmail:'new@example.test',items:[],total:9};
    const requested=[];
    globalThis.fetch=async path=>{
      requested.push(path);
      if(path.endsWith('/products'))return response({rows:[{id:'product',name:'Latte',price:9,stock:9,trackStock:true,variants:[]}],next:null});
      if(path.endsWith('/clients'))return response({rows:[{id:'new-customer',name:'New customer',type:'Customer',email:'new@example.test'}],next:null});
      throw Error('unexpected request: '+path);
    };
    const updated=await Store.refreshPostedSales([posted,posted]);
    assert.equal(updated.status,'refreshed');
    assert.deepEqual(requested.sort(),['/api/companies/refresh-company/clients','/api/companies/refresh-company/products']);
    assert.deepEqual(Store.state.transactions.map(row=>row.id),['older','paid-1']);
    assert.equal(Store.state.transactions[1].documentState,'issued');
    assert.equal(Store.state.products[0].stock,9);
    assert.equal(Store.state.clients[0].id,'new-customer');
    const cached=await localPos.getCatalog(actor.uid,company.id);
    assert.equal(cached.products[0].stock,9);
    assert.equal(cached.clients[0].id,'new-customer');
  });

  await test('successful checkout does not reload transaction and stock history',async()=>{
    session();Store.state.fromCache=false;
    const paid={id:'paid-2',company_id:company.id,cashierId:actor.uid,type:'Invoice',source:'pos',status:'Paid',date:'2026-09-29T01:00:00.000Z',items:[],total:5};
    const requested=[];
    globalThis.fetch=async path=>{
      requested.push(path);
      if(path.endsWith('/checkout'))return response(paid);
      if(path.endsWith('/products'))return response({rows:[{id:'product',name:'Cup',price:5,stock:4,trackStock:true,variants:[]}],next:null});
      throw Error('unexpected request: '+path);
    };
    const completed=await Store.completeSale(paid,'checkout-draft',{cart:[],held:[]});
    assert.equal(completed.syncStatus,'synced');
    assert.deepEqual(requested.sort(),['/api/companies/refresh-company/checkout','/api/companies/refresh-company/products']);
    assert.equal(Store.state.products[0].stock,4);
    assert.equal(Store.state.transactions.find(row=>row.id===paid.id)?.status,'Paid');
    assert.equal((await localPos.sales(actor.uid,company.id)).some(row=>row.id===paid.id),false);
  });

  await test('a company switch discards an in-flight checkout catalog refresh',async()=>{
    session();Store.state.fromCache=false;
    const posted={id:'paid-old-company',company_id:company.id,cashierId:actor.uid,type:'Invoice',source:'pos',status:'Paid'};
    let release;
    const gate=new Promise(resolve=>{release=resolve;});
    globalThis.fetch=async()=>{await gate;return response({rows:[{id:'old-company-product',stock:1,variants:[]}],next:null});};
    const pending=Store.refreshPostedSales([posted]);
    await new Promise(resolve=>setTimeout(resolve,5));
    Store.selectCompany(null,{hydrate:false});
    release();
    assert.equal((await pending).status,'stale');
    assert.equal(Store.state.transactions.length,0);
    assert.equal(Store.state.products.length,0);
  });

  await test('a posted receipt remains visible when stock refresh fails',async()=>{
    session();Store.state.fromCache=false;
    const posted={id:'paid-fetch-failed',company_id:company.id,cashierId:actor.uid,type:'Invoice',source:'pos',status:'Paid'};
    globalThis.fetch=async()=>{throw Error('catalog temporarily unavailable');};
    const outcome=await Store.refreshPostedSales([posted]);
    assert.equal(outcome.status,'failed');
    assert.equal(Store.state.fromCache,true);
    assert.equal(Store.state.transactions.find(row=>row.id===posted.id)?.status,'Paid');
  });
}finally{
  Store.clearSession();
  await vite.close();
}
