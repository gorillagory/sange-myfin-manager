// Strictly local fixtures. Never point this script at a real Firebase project.
import { writeFile } from 'node:fs/promises';
const project='demo-myfin-edition';
const firestore=`http://127.0.0.1:8080/v1/projects/${project}/databases/(default)/documents`;
const field=v=>v===null?{nullValue:null}:typeof v==='string'?{stringValue:v}:typeof v==='number'?{doubleValue:v}:typeof v==='boolean'?{booleanValue:v}:Array.isArray(v)?{arrayValue:{values:v.map(field)}}:{mapValue:{fields:Object.fromEntries(Object.entries(v).map(([k,v])=>[k,field(v)]))}};
async function put(collection,id,data){const r=await fetch(`${firestore}/${collection}/${id}`,{method:'PATCH',headers:{'content-type':'application/json',Authorization:'Bearer owner'},body:JSON.stringify({fields:field(data).mapValue.fields})});if(!r.ok)throw new Error(`${collection}: ${await r.text()}`);}
const accounts=[];
for(const [name,email,role,company] of [['Aisha Rahman','owner@example.test','super','test-store'],['Sarah Ismail','cashier@example.test','company_user','test-store'],['Other Cashier','other@example.test','company_user','other-store']]){
 const response=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'EditionTest123!',returnSecureToken:true})});
 let account=await response.json();if(!response.ok){const existing=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'EditionTest123!',returnSecureToken:true})});account=await existing.json();}
 if(!account.localId)throw new Error('Could not create local fixture account.');
 accounts.push({uid:account.localId,email,role});await put('users',account.localId,{username:name,email,role,company_id:company});
}
await put('companies','test-store',{name:'Kedai Kota · Test Store',registration:'TEST-ONLY',address:'24 Jalan Kota, Kuala Lumpur',phone:'012 345 6789',email:'store@example.test',preferences:{currency:'RM',tax:0,theme:'light',paperWidth:'80',receiptFooter:'Thank you for shopping small.'}});
await put('companies','other-store',{name:'Other isolated store',preferences:{currency:'RM',tax:0}});
const products=[['coffee','House blend coffee','Beverages',14.5,42],['oat','Oat milk','Beverages',12.9,18],['croissant','Butter croissant','Food',7.5,12],['honey','Wildflower honey','Pantry',28,7],['tote','Everyday tote','Lifestyle',25,23],['cup','Ceramic cup','Lifestyle',32,4],['chocolate','Sea salt chocolate','Pantry',16.9,31],['brew','Cold brew','Beverages',11,3]];
for(const [id,name,category,price,stock] of products)await put('products',id,{name,category,price,cost:price*.5,stock,trackStock:true,sku:`${category.slice(0,3).toUpperCase()}-${id}`,unit:'pcs',company_id:'test-store',variants:id==='cup'?[{id:'chalk',name:'Chalk',price:32,cost:16,stock:4},{id:'forest',name:'Forest',price:34,cost:17,stock:5}]:[]});
await put('products','service',{name:'Gift wrapping',category:'Service',price:5,cost:0,stock:0,trackStock:false,sku:'SRV-WRAP',unit:'service',company_id:'test-store',variants:[]});
await put('products','other-product',{name:'Other store item',category:'Other',price:10,stock:5,company_id:'other-store'});
for(const [id,name] of [['amelia','Amelia Tan'],['daniel','Daniel Lee']])await put('clients',id,{name,phone:'012 345 6789',type:'Client',company_id:'test-store'});
const date=new Date().toISOString();
for(const [id,status,total,name,type] of [['demo-paid','Paid',78.4,'Amelia Tan','Invoice'],['demo-cleared','Cleared',45,'Walk-in customer','Invoice'],['demo-pending','Pending',125,'Daniel Lee','Invoice'],['demo-quote','Pending',174,'Daniel Lee','Quote']])await put('transactions',id,{company_id:'test-store',number:id.toUpperCase(),status,total,subtotal:total,type,date,client_id:name==='Amelia Tan'?'amelia':'daniel',items:[{desc:'Sample purchase',qty:1,price:total,unit:'pcs'}]});
await put('expenses','sample-expense',{company_id:'test-store',description:'Weekly stock delivery',category:'Inventory',payee:'Local supplier',amount:425,date:date.slice(0,10)});
await put('activities','sample-activity',{company_id:'test-store',action:'Store ready for testing',details:'Isolated Firebase Emulator fixtures',user:'Aisha Rahman',actorId:accounts[0].uid,date});
await writeFile('scripts/emulator-accounts.local.json',JSON.stringify(accounts,null,2));
console.log('Seeded isolated demo-myfin-edition. Login: owner@example.test / EditionTest123!');
