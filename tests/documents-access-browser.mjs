// Synthetic, disposable Phase05 browser acceptance. Never record credentials or traces.
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
assert.equal(process.env.MYFIN_BROWSER_ACCEPTANCE,'myfin-phase05-20260913');
const origin='http://localhost:8080',evidence='/evidence';
const password=(await readFile('/run/seed','utf8')).trim();
await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage']});
const contexts=[],pages=[],errors=[],checkpoints=[],suffix=Date.now().toString(36);
async function newPage(){const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});contexts.push(context);const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));pages.push(page);return page;}
async function login(page,email){await page.goto(origin);await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in to workspace'}).click();await page.getByRole('button',{name:'Sign out',exact:true}).waitFor();}
async function api(page,path,{method='GET',data,status=200}={}){const response=await page.request.fetch(origin+'/api'+path,{method,headers:{Origin:origin},...(data===undefined?{}:{data})});const body=await response.json().catch(()=>({}));assert.equal(response.status(),status,`${method} ${path}: ${body.error||response.status()}`);return body;}
async function checkpoint(page,name){await page.screenshot({path:`${evidence}/${name}.png`,fullPage:true});checkpoints.push(name);console.log('passed: '+name);}
async function download(page,name,button){const pending=page.waitForEvent('download');await button.click();await(await pending).saveAs(`${evidence}/${name}.pdf`);}
function noConfidential(value){if(Array.isArray(value))return value.forEach(noConfidential);if(value&&typeof value==='object')for(const[key,item]of Object.entries(value)){assert.equal(/^(cost|costs|totalCost|unitCost|unit_cost|purchasePrice|margin|profit|grossProfit|netProfit|expenses|valuation|inventoryValue)$/i.test(key),false,'Confidential field persisted or returned: '+key);noConfidential(item);}}
async function deviceData(page){return page.evaluate(()=>new Promise((resolve,reject)=>{const request=indexedDB.open('myfin-pos');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const result={version:db.version};const tx=db.transaction(['catalog','profiles','outbox','drafts'],'readonly');for(const name of ['catalog','profiles','outbox','drafts']){const r=tx.objectStore(name).getAll();r.onsuccess=()=>result[name]=r.result;}tx.oncomplete=()=>{db.close();resolve(result);};tx.onerror=()=>reject(tx.error);};}));}
async function waitForReceiptAck(page,id){for(let attempt=0;attempt<120;attempt++){const data=await deviceData(page);if(!data.outbox.some(row=>row.id===id))return data;await page.waitForTimeout(250);}throw new Error('Original paid receipt remains in durable outbox after approval/retry');}
async function waitFor(page,fn,message){await page.waitForFunction(fn,null,{timeout:30000}).catch(()=>{throw new Error(message);});}
const owner=await newPage();let manager,staff,company,product,customer,staffUser,managerUser,paidIntent;
try{
  await login(owner,'operator@myfin.test');
  company=await api(owner,'/companies',{method:'POST',data:{name:'Document shop '+suffix,registration:'SYNTHETIC-DOC-05',address:'12 Synthetic Street\nKuala Lumpur',phone:'0000000000',email:'documents@myfin.test',preferences:{currency:'RM',taxRate:6,staffDiscountLimit:0,paperWidth:'80',receiptFooter:'Synthetic receipt footer'}}});
  const co='/companies/'+company.id;
  const managerEmail=`documents-manager-${suffix}@myfin.test`,staffEmail=`documents-staff-${suffix}@myfin.test`,peerEmail=`documents-peer-${suffix}@myfin.test`;
  for(const [email,username,role]of [[managerEmail,'Review manager '+suffix,'company_admin'],[staffEmail,'Draft staff '+suffix,'company_user'],[peerEmail,'Other staff '+suffix,'company_user']])await api(owner,'/users',{method:'POST',data:{email,username,password,role,company_id:company.id}});
  const users=await api(owner,'/users');managerUser=users.find(user=>user.email===managerEmail);staffUser=users.find(user=>user.email===staffEmail);
  product=await api(owner,co+'/products',{method:'POST',data:{name:'Acceptance coffee '+suffix,sku:'DOC-'+suffix,unit:'pcs',price:10,cost:3.47,stock:20,trackStock:true,variants:[]}});
  customer=await api(owner,co+'/clients',{method:'POST',data:{name:'Original customer '+suffix,type:'Customer',registration:'SYNTHETIC-CLIENT-05',address:'45 Customer Lane',phone:'0000000001',email:'customer@myfin.test'}});
  await api(owner,co+'/clients',{method:'POST',data:{name:'Confidential supplier '+suffix,type:'Supplier'}});
  await api(owner,co+'/expenses',{method:'POST',data:{amount:91.73,date:'2026-09-13',description:'Confidential expense '+suffix}});
  manager=await newPage();staff=await newPage();await login(manager,managerEmail);await login(staff,staffEmail);
  for(const page of [manager,staff]){
    for(const name of ['Financial reports','Expenses','Activity'])assert.equal(await page.getByRole('link',{name,exact:true}).count(),0);
    await api(page,co+'/expenses',{status:403});await api(page,co+'/activities',{status:403});
    noConfidential(await api(page,co+'/products'));assert.equal((await api(page,co+'/clients')).rows.some(client=>client.type==='Supplier'),false);
    await page.goto(origin+'/analytics');await page.waitForURL('**/overview');
    await page.getByRole('link',{name:'Inventory',exact:true}).click();
    assert.equal(await page.getByText('Cost (RM)',{exact:true}).count(),0);
    if(page===staff)assert.equal(await page.getByRole('button',{name:'Export inventory',exact:true}).count(),0);
  }
  assert.equal(await staff.getByRole('button',{name:'+ Add product',exact:true}).count(),0);
  await api(staff,co+'/products',{method:'POST',data:{},status:403});
  await api(manager,co+'/products/'+product.id,{method:'PUT',data:{...product,cost:0},status:403});
  const managedUsers=await api(manager,'/users');assert(managedUsers.length>=2);assert(managedUsers.every(user=>user.role==='company_user'&&user.company_id===company.id));
  await api(manager,'/users/'+managerUser.id,{method:'DELETE',status:403});
  const exportEvent=manager.waitForEvent('download');await manager.getByRole('button',{name:'Export inventory',exact:true}).click();const exported=await exportEvent;await exported.saveAs(evidence+'/manager-catalog.csv');const catalogCsv=await readFile(evidence+'/manager-catalog.csv','utf8');assert.doesNotMatch(catalogCsv.split(/\r?\n/)[0],/cost|margin|profit/i);assert.doesNotMatch(catalogCsv,/3\.47/);
  await checkpoint(staff,'staff-operational-catalog');await checkpoint(manager,'manager-financial-restrictions');

  // Staff prepares both document kinds through the real editor.
  await staff.getByRole('link',{name:'My documents',exact:true}).click();
  await staff.getByRole('heading',{name:'Every document, clearly handled.'}).waitFor();
  for(const [type,description]of [['Quote','Staff quote service '+suffix],['Invoice','Staff invoice service '+suffix]]){
    await staff.getByRole('button',{name:'New '+type.toLowerCase(),exact:true}).click();
    await staff.getByLabel(/^Customer \*/).selectOption(customer.id);
    await staff.getByLabel('Line 1 description *',{exact:true}).fill(description);
    await staff.getByLabel('Quantity *',{exact:true}).fill('2');await staff.getByLabel('Unit price *',{exact:true}).fill('100');
    await staff.getByLabel('Discount (%)',{exact:true}).fill('10');
    await staff.getByRole('button',{name:'Save draft',exact:true}).click();
    await staff.getByRole('heading',{name:'Document review',exact:true}).waitFor();
    assert.equal(await staff.getByRole('button',{name:/^Issue (invoice|quote)$/}).count(),0);
    if(type==='Invoice')await download(staff,'staff-invoice-draft',staff.getByRole('button',{name:'Download draft PDF',exact:true}));
    await checkpoint(staff,'staff-'+type.toLowerCase()+'-draft');
    await staff.getByRole('dialog',{name:'Document review',exact:true}).getByRole('button',{name:'Close dialog',exact:true}).click();
  }
  let drafts=await api(staff,co+'/documents');assert.equal(drafts.length,2);assert(drafts.every(doc=>doc.documentState==='draft'));
  let invoice=drafts.find(doc=>doc.type==='Invoice'),quote=drafts.find(doc=>doc.type==='Quote');
  await api(staff,co+'/documents/'+invoice.id+'/issue',{method:'POST',data:{version:invoice.version},status:403});
  await api(staff,co+'/documents/'+invoice.id+'/payments',{method:'POST',data:{amount:1,method:'Cash'},status:403});

  // Manager publishes a template using the same renderer used by actual documents.
  await manager.getByRole('link',{name:'Templates',exact:true}).click();
  await manager.getByLabel('Template name *',{exact:true}).fill('Acceptance invoice '+suffix);
  await manager.getByLabel(/^Layout/).selectOption('modern');
  await manager.getByLabel('Bank name',{exact:true}).fill('Synthetic Bank');
  await manager.getByLabel('Account name',{exact:true}).fill('Synthetic Account');
  await manager.getByLabel('Account number',{exact:true}).fill('TEST-0000');
  await manager.getByRole('button',{name:'Save draft template',exact:true}).click();
  await manager.getByRole('button',{name:'Publish version',exact:true}).click();
  await manager.getByRole('button',{name:'Publish template',exact:true}).click();await manager.getByRole('dialog',{name:'Publish this template version?',exact:true}).waitFor({state:'hidden'});
  await checkpoint(manager,'published-invoice-template');
  const templates=await api(manager,co+'/templates');const invoiceTemplate=templates.find(template=>template.name==='Acceptance invoice '+suffix);assert(invoiceTemplate?.published);
  // API assignment uses the editor's exact accepted draft contract.
  const draftBody=doc=>Object.fromEntries(['id','type','client_id','date','dueDate','validUntil','items','discount','taxRate','notes','paymentInstructions','terms','footer','signatureLabel','templateId','assignedTo','version'].filter(key=>doc[key]!==undefined).map(key=>[key,doc[key]]));
  invoice=await api(manager,co+'/documents/'+invoice.id,{method:'PUT',data:{...draftBody(invoice),templateId:invoiceTemplate.id}});
  await manager.getByRole('link',{name:'Sales & documents',exact:true}).click();
  await manager.locator('[data-document-id="'+invoice.id+'"]').getByRole('button',{name:'Review',exact:true}).click();
  await manager.getByRole('button',{name:'Issue invoice',exact:true}).click();await manager.getByLabel(/^Discount approval reason \*/).fill('Manager approves the proposed customer discount.');await manager.getByRole('button',{name:'Confirm issue',exact:true}).click();await manager.getByRole('dialog',{name:'Issue this document?',exact:true}).waitFor({state:'hidden'});
  invoice=await api(manager,co+'/documents/'+invoice.id);assert.equal(invoice.documentState,'issued');assert.equal(invoice.discountAmount,20);assert.equal(invoice.total,190.8);
  await download(manager,'issued-invoice-before',manager.getByRole('button',{name:'Download PDF',exact:true}));
  const snapshot=structuredClone(invoice.issuedSnapshot);
  await manager.getByRole('button',{name:'Record payment',exact:true}).click();await manager.getByLabel('Payment amount *',{exact:true}).fill('100');await manager.getByRole('button',{name:'Save payment',exact:true}).click();await manager.getByRole('dialog',{name:'Record a payment',exact:true}).waitFor({state:'hidden'});
  await manager.getByRole('button',{name:'Record payment',exact:true}).click();await manager.getByLabel('Payment amount *',{exact:true}).fill('90.80');await manager.getByRole('button',{name:'Save payment',exact:true}).click();await manager.getByRole('dialog',{name:'Record a payment',exact:true}).waitFor({state:'hidden'});
  invoice=await api(manager,co+'/documents/'+invoice.id);assert.equal(invoice.status,'Paid');assert.equal(invoice.outstandingAmount,0);assert.deepEqual(invoice.issuedSnapshot,snapshot);
  await download(manager,'paid-invoice',manager.getByRole('button',{name:'Download PDF',exact:true}));
  await api(owner,co,{method:'PUT',data:{...company,name:'Changed company '+suffix,address:'Changed company address'}});
  await api(owner,co+'/clients/'+customer.id,{method:'PUT',data:{...customer,name:'Changed customer '+suffix,address:'Changed customer address'}});
  await manager.reload();
  await manager.locator('[data-document-id="'+invoice.id+'"]').getByRole('button',{name:'Review',exact:true}).click();
  await download(manager,'paid-invoice-after-branding',manager.getByRole('button',{name:'Download PDF',exact:true}));
  invoice=await api(manager,co+'/documents/'+invoice.id);assert.deepEqual(invoice.issuedSnapshot,snapshot);
  await checkpoint(manager,'paid-invoice-frozen-details');
  // Restore current checkout merchant details for the independent offline test.
  await api(owner,co,{method:'PUT',data:company});await api(owner,co+'/clients/'+customer.id,{method:'PUT',data:customer});
  await manager.getByRole('dialog',{name:'Document review',exact:true}).getByRole('button',{name:'Close dialog',exact:true}).click();
  await manager.locator('[data-document-id="'+quote.id+'"]').getByRole('button',{name:'Review',exact:true}).click();
  await manager.getByRole('button',{name:'Issue quote',exact:true}).click();await manager.getByLabel(/^Discount approval reason \*/).fill('Manager approves the proposed customer discount.');await manager.getByRole('button',{name:'Confirm issue',exact:true}).click();await manager.getByRole('dialog',{name:'Issue this document?',exact:true}).waitFor({state:'hidden'});
  await download(manager,'issued-quote',manager.getByRole('button',{name:'Download PDF',exact:true}));
  await manager.getByRole('button',{name:'Convert to invoice',exact:true}).click();await manager.getByRole('button',{name:'Create invoice draft',exact:true}).click();await manager.getByRole('dialog',{name:'Convert quote to invoice?',exact:true}).waitFor({state:'hidden'});
  quote=await api(manager,co+'/documents/'+quote.id);assert(quote.convertedTo);const converted=await api(manager,co+'/documents/'+quote.convertedTo);assert.equal(converted.documentState,'draft');assert.equal(converted.quoteId,quote.id);
  await checkpoint(manager,'quote-converted-to-invoice-draft');

  // Already-paid offline intent survives a price change and an explicit review.
  await staff.goto(origin+'/pos');await staff.getByRole('button',{name:'Add '+product.name,exact:true}).waitFor();
  await staff.evaluate(()=>navigator.serviceWorker.ready);await staff.reload();await staff.getByRole('button',{name:'Add '+product.name,exact:true}).waitFor();
  await staff.context().setOffline(true);await staff.getByRole('button',{name:'Add '+product.name,exact:true}).click();await staff.getByRole('button',{name:/Charge RM/}).click();await staff.getByLabel('Cash received (RM)').fill('20');await staff.getByRole('button',{name:'Complete sale',exact:true}).click();await staff.getByRole('heading',{name:'Payment recorded. Sync pending.'}).waitFor();
  paidIntent=(await deviceData(staff)).outbox[0];assert.equal(paidIntent.total,10.6);noConfidential(paidIntent);
  await staff.getByRole('button',{name:'Receipt / Email'}).click();await download(staff,'pending-receipt-80',staff.getByRole('button',{name:'Download receipt PDF',exact:true}));await staff.getByRole('button',{name:'Close',exact:true}).last().click();await staff.getByRole('heading',{name:'A fresh order.',exact:true}).waitFor();
  const currentProduct=(await api(owner,co+'/products')).rows.find(row=>row.id===product.id);await api(owner,co+'/products/'+product.id,{method:'PUT',data:{...currentProduct,price:12}});
  await staff.context().setOffline(false);
  for(let attempt=0;attempt<60;attempt++){const reviews=await api(staff,co+'/receipt-reviews');if(reviews.some(review=>review.id===paidIntent.id))break;if(attempt===59)throw new Error('Paid receipt was not automatically submitted for review');await staff.waitForTimeout(250);}
  await staff.getByRole('link',{name:'Payment reviews',exact:true}).click();
  await staff.getByText(paidIntent.number,{exact:true}).waitFor();assert.equal((await deviceData(staff)).outbox.length,1);
  await manager.getByRole('link',{name:'Payment reviews',exact:true}).click();await manager.getByText(paidIntent.number,{exact:true}).waitFor();
  await checkpoint(staff,'staff-paid-receipt-review-pending');
  await manager.getByRole('button',{name:'Review payment',exact:true}).click();await manager.getByLabel(/^Approval reason/).fill('Recorded payment used cached price before catalog update.');await manager.getByRole('button',{name:'Approve original payment',exact:true}).click();
  await staff.goto(origin+'/pos');await staff.getByRole('button',{name:'Add '+product.name,exact:true}).waitFor();await waitForReceiptAck(staff,paidIntent.id);
  let posted=(await api(owner,co+'/transactions')).rows.filter(row=>row.id===paidIntent.id);assert.equal(posted.length,1);assert.equal(posted[0].total,10.6);assert.equal(posted[0].cashierId,staffUser.id);
  assert.equal((await api(owner,co+'/products')).rows.find(row=>row.id===product.id).stock,19);
  const cache=await deviceData(staff);assert.equal(cache.version,3);assert.equal(cache.outbox.length,0);noConfidential(cache);
  await checkpoint(manager,'manager-original-payment-approved');

  // Upgrade a real v2 device database containing a historical retry with costs.
  const legacy=await newPage();await legacy.goto(origin+'/healthz');
  await legacy.evaluate(async({sale,user,company,product})=>{
    await new Promise((resolve,reject)=>{const r=indexedDB.open('myfin-pos',2);r.onupgradeneeded=()=>{for(const name of ['drafts','catalog','profiles'])r.result.createObjectStore(name);r.result.createObjectStore('outbox',{keyPath:'id'});};r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction(['drafts','catalog','profiles','outbox'],'readwrite');tx.objectStore('outbox').put({...sale,items:sale.items.map(item=>({...item,cost:3.47}))});tx.objectStore('catalog').put({products:[product],clients:[],expenses:[{amount:91.73}]},user.id+':'+company.id);tx.objectStore('profiles').put({user:{...user,cost:9},companies:[{...company,expenses:[{amount:91.73}]}]},user.id);tx.objectStore('drafts').put({items:[{desc:'Preserved draft',cost:3.47,price:10,qty:1}]},user.id+':'+company.id);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
  },{sale:paidIntent,user:staffUser,company,product});
  await login(legacy,staffEmail);await legacy.goto(origin+'/pos');await legacy.getByRole('button',{name:'Add '+product.name,exact:true}).waitFor();await waitForReceiptAck(legacy,paidIntent.id);
  const upgraded=await deviceData(legacy);assert.equal(upgraded.version,3);assert.equal(upgraded.outbox.length,0);noConfidential(upgraded);assert.equal((await api(owner,co+'/products')).rows.find(row=>row.id===product.id).stock,19);assert.equal((await api(owner,co+'/transactions')).rows.filter(row=>row.id===paidIntent.id).length,1);
  await checkpoint(legacy,'legacy-cache-upgrade-paid-retry-once');
  assert.deepEqual(errors,[],'No browser runtime errors');
  await writeFile(evidence+'/documents-access-browser-result.json',JSON.stringify({status:'passed',checkpoints,checks:['staff prepares quote and invoice drafts','manager issue convert and partial/final payments','owner-only financial API UI and cache','manager manages staff only','published template and immutable issued details','offline receipt review retains original amount and cashier','stock and payment idempotency','real IndexedDB v2 upgrade scrubs confidential fields and preserves paid retry'],runtimeErrors:errors},null,2)+'\n');
}catch(error){for(let i=0;i<pages.length;i++)await pages[i].screenshot({path:`${evidence}/failure-${i}.png`,fullPage:true}).catch(()=>{});console.error('Documents/access browser acceptance failed:',error.message);console.error('Runtime errors:',JSON.stringify(errors));for(let i=0;i<pages.length;i++)await writeFile(`${evidence}/failure-${i}.aria.txt`,(await pages[i].locator('body').ariaSnapshot()).replaceAll(password,'[redacted]')).catch(()=>{});process.exitCode=1;}finally{await browser.close();}
