<script setup>
import {ref,computed} from 'vue';
import {Store} from '../../store';
import {api,companyPath} from '../../services/api';
import {useStorage} from '../../composables/useStorage';
import {expenseRecords,money,businessDate,cents} from '../../domain/pos';
import {expenseTemplateCsv,exportExpensesCsv,importExpensesCsv} from '../../domain/expensesCsv.js';
import {
  EXPENSE_LINK_LABELS,EXPENSE_PAID_BY_LABELS,EXPENSE_STATUS_LABELS,
  effectiveExpenseStatus,expenseHasCashImpact,expenseSaveFailureDisposition,normalizeExpenseLifecycle,
} from '../../domain/expenseLifecycle.js';
import Icon from '../ui/EditionIcon.vue';
import Modal from '../ui/EditionModal.vue';

const {uploadFile,removeFile}=useStorage();
const search=ref(''),statusFilter=ref(''),paidByFilter=ref(''),form=ref(null),file=ref(null),busy=ref(false),error=ref(''),deleting=ref(null),approval=ref({managerCode:'',reason:''}),csvInput=ref(null),importBatch=ref(null);
const expenseEvents=ref([]),eventsLoading=ref(false);
let expenseEventRequest=0;
const linkOptions=ref({stockItems:[],stockMovements:[],purchaseOrders:[],goodsReceipts:[]});
const currency=computed(()=>Store.state.selectedCompany?.preferences?.currency||'RM');
const writeReady=computed(()=>Store.state.online&&!Store.state.fromCache);
const suppliers=computed(()=>Store.state.clients.filter(client=>client.type==='Supplier'));
const currentUserId=computed(()=>Store.state.currentUser?.id||Store.state.currentUser?.uid||'');
const payers=computed(()=>{
  const companyId=Store.state.selectedCompany?.id,values=[...Store.state.users];
  if(currentUserId.value&&!values.some(user=>user.id===currentUserId.value))values.unshift({id:currentUserId.value,username:Store.state.currentUser?.username||'Current user'});
  if(Store.permissions().operator)return values.filter(user=>user.id===currentUserId.value&&!user.disabled);
  return values.filter(user=>!user.disabled&&(!user.assignments?.length||user.id===currentUserId.value||user.assignments.some(item=>item.company_id===companyId))).sort((a,b)=>String(a.username||a.id).localeCompare(String(b.username||b.id)));
});
const allExpenses=computed(()=>expenseRecords(Store.state).sort((a,b)=>String(b.date).localeCompare(String(a.date))));
const expenses=computed(()=>allExpenses.value.filter(expense=>{
  const query=search.value.trim().toLocaleLowerCase(),status=effectiveExpenseStatus(expense);
  return (!query||[expense.description,expense.category,expense.payee,expense.paidByName,expense.paidByUserName,...(expense.links||[]).map(link=>link.label)].join(' ').toLocaleLowerCase().includes(query))
    &&(!statusFilter.value||status===statusFilter.value)
    &&(!paidByFilter.value||(expense.paidByType||'legacy_unspecified')===paidByFilter.value);
}));
const accruedTotal=computed(()=>expenses.value.reduce((sum,expense)=>sum+cents(expense.amount||0),0)/100);
const cashPaidTotal=computed(()=>expenses.value.filter(expenseHasCashImpact).reduce((sum,expense)=>sum+cents(expense.amount||0),0)/100);
const supplierName=id=>suppliers.value.find(supplier=>supplier.id===id)?.name||'';
const payerName=id=>payers.value.find(user=>user.id===id)?.username||'';
const actorName=id=>Store.state.users.find(user=>user.id===id)?.username||(id===currentUserId.value?Store.state.currentUser?.username:'')||id;
const canEditRecord=expense=>writeReady.value&&Store.can('expensesWrite')&&expense.origin!=='transactions';
const canVoidRecord=expense=>writeReady.value&&expense.origin!=='transactions'&&(Store.can('expensesVoid')||Store.permissions().operator);
const statusName=expense=>EXPENSE_STATUS_LABELS[effectiveExpenseStatus(expense)]||'Paid';
const paidByName=expense=>expense.origin==='transactions'?'Legacy record':expense.paidByType==='app_user'?(expense.paidByUserName||payerName(expense.paidByUserId)||'App user'):expense.paidByType==='non_user'?(expense.paidByName||'Named non-user'):expense.paidByType==='credit'?(expense.paidByName||'Credit'):EXPENSE_PAID_BY_LABELS[expense.paidByType||'legacy_unspecified'];
const linkSets={stock_item:'stockItems',stock_movement:'stockMovements',purchase_order:'purchaseOrders',goods_receipt:'goodsReceipts'};

function addDays(date,days){const stamp=Date.parse(`${date}T00:00:00.000Z`);return Number.isFinite(stamp)?new Date(stamp+Number(days)*86400000).toISOString().slice(0,10):'';}
function syncCreditDueDate(){if(form.value?.paidByType==='credit'&&form.value.date&&Number(form.value.creditTermsDays)>0)form.value.creditDueDate=addDays(form.value.date,form.value.creditTermsDays);}
function syncCreditTerms(){if(form.value?.paidByType!=='credit'||!form.value.date||!form.value.creditDueDate)return;form.value.creditTermsDays=Math.round((Date.parse(`${form.value.creditDueDate}T00:00:00.000Z`)-Date.parse(`${form.value.date}T00:00:00.000Z`))/86400000);}
function paidByChanged(){if(!form.value)return;if(form.value.paidByType==='credit'){form.value.status='pending';form.value.paidOn='';form.value.creditTermsDays=form.value.creditTermsDays||30;syncCreditDueDate();}else{form.value.status='paid';form.value.paidOn||=form.value.date;form.value.creditTermsDays=null;form.value.creditDueDate='';}if(form.value.paidByType!=='app_user')form.value.paidByUserId='';else form.value.paidByUserId||=currentUserId.value;if(!['non_user','other','credit'].includes(form.value.paidByType))form.value.paidByName='';}
function statusChanged(){if(!form.value)return;if(form.value.status==='paid')form.value.paidOn||=businessDate();else form.value.paidOn='';}
function optionsFor(link){const options=[...(linkOptions.value[linkSets[link.type]]||[])];if(link.id&&!options.some(row=>row.id===link.id))options.unshift({id:link.id,label:link.label||link.id});return options;}
function typesFor(link){return Object.keys(linkSets).filter(type=>type===link.type||(linkOptions.value[linkSets[type]]||[]).length);}
function addLink(){const type=Object.keys(linkSets).find(key=>(linkOptions.value[linkSets[key]]||[]).length)||'stock_item';form.value.links.push({type,id:''});}
async function loadLinkOptions(){try{linkOptions.value=await api(companyPath(Store,'/expense-link-options'));}catch(caught){error.value=caught.message||'Linked stock and purchasing records could not be loaded.';}}
function invalidateExpenseEvents(){expenseEventRequest++;expenseEvents.value=[];eventsLoading.value=false;}
function closeEditor(){invalidateExpenseEvents();form.value=null;}
async function loadExpenseEvents(id){const request=++expenseEventRequest;expenseEvents.value=[];eventsLoading.value=true;try{const rows=(await api(companyPath(Store,`/expenses/${encodeURIComponent(id)}/events`))).rows||[];if(request===expenseEventRequest&&form.value?.id===id)expenseEvents.value=rows;}catch(caught){if(request===expenseEventRequest&&form.value?.id===id)error.value=caught.message||'Expense history could not be loaded.';}finally{if(request===expenseEventRequest&&form.value?.id===id)eventsLoading.value=false;}}
function edit(expense){
  if(!writeReady.value){Store.notify('Reconnect and refresh live data before changing expenses.','error');return;}
  if(expense&&!canEditRecord(expense))return;
  invalidateExpenseEvents();
  form.value=expense?JSON.parse(JSON.stringify(expense)):{description:'',amount:'',date:businessDate(),category:'General',payee:'',supplier_id:'',receiptUrl:'',receiptPath:'',status:'paid',paidByType:'app_user',paidByUserId:currentUserId.value,paidByName:'',creditTermsDays:null,creditDueDate:'',paidOn:businessDate(),links:[]};
  form.value.status=['pending','paid'].includes(form.value.status)?form.value.status:'paid';
  form.value.paidByType||='legacy_unspecified';
  form.value.paidByUserId||='';form.value.paidByName||='';form.value.creditTermsDays??=null;form.value.creditDueDate||='';form.value.paidOn||=form.value.status==='paid'?form.value.date:'';
  form.value.links=(form.value.links||[]).map(link=>({type:link.type,id:link.id,label:link.label||'',source:link.source||'manual'}));
  file.value=null;error.value='';loadLinkOptions();if(expense?.id)loadExpenseEvents(expense.id);
}
function pick(event){const chosen=event.target.files[0];if(chosen&&chosen.size>5*1024*1024){error.value='Choose a receipt smaller than 5 MB.';event.target.value='';return;}file.value=chosen;}
function selectSupplier(){if(form.value?.supplier_id)form.value.payee=supplierName(form.value.supplier_id);}
async function save(){
  if(busy.value)return;error.value='';
  if(!writeReady.value){error.value='Reconnect and refresh live data before saving this expense.';return;}
  if(form.value?.id?!Store.can('expensesWrite'):!Store.can('expensesCreate')){error.value='You do not have permission to save this expense.';return;}
  const rawAmount=String(form.value.amount).trim();
  if(!form.value.description.trim()||!/^\d+(?:\.\d{1,2})?$/.test(rawAmount)||Number(rawAmount)<=0){error.value='Enter a description and an amount greater than zero with at most two decimal places.';return;}
  let lifecycle;try{lifecycle=normalizeExpenseLifecycle(form.value,{actorId:currentUserId.value,allowLegacy:Boolean(form.value.id),today:businessDate()});}catch(caught){error.value=caught.message;return;}
  busy.value=true;let uploaded=null,saved=false;const oldPath=form.value.receiptPath;
  try{
    if(file.value)uploaded=await uploadFile(file.value,`receipts/${Store.state.selectedCompany.id}/${crypto.randomUUID()}_${file.value.name}`);
    const {origin,amountSen,paidByUserName,...data}=form.value;
    data.amount=Number(rawAmount);Object.assign(data,lifecycle);
    data.links=lifecycle.links;
    if(uploaded){data.receiptUrl=uploaded.url;data.receiptPath=uploaded.path;}
    await Store.addExpense(data);
    saved=true;
    if(uploaded&&oldPath&&oldPath!==uploaded.path)await removeFile(oldPath).catch(()=>Store.notify('Expense saved, but the replaced receipt file could not be removed.','warning'));
    closeEditor();Store.notify('Expense saved.');
  }catch(caught){
    const disposition=expenseSaveFailureDisposition(caught);
    if(disposition==='committed'){
      saved=true;
      if(uploaded&&oldPath&&oldPath!==uploaded.path)await removeFile(oldPath).catch(()=>Store.notify('Expense saved, but the replaced receipt file could not be removed.','warning'));
      closeEditor();Store.notify('Expense saved, but live data could not be refreshed. Reconnect and refresh before making another change.','warning');
    }else if(disposition==='ambiguous'){Store.state.fromCache=true;Store.state.dataError='Expense save outcome requires reconciliation.';error.value='The server outcome is unknown because the connection was interrupted. The uploaded receipt was retained; reconnect and refresh before retrying.';}
    else{if(uploaded?.path&&!saved)await removeFile(uploaded.path).catch(()=>{});error.value=caught.message;}
  }finally{busy.value=false;}
}
async function remove(){if(busy.value)return;if(!writeReady.value){Store.notify('Reconnect and refresh live data before voiding an expense.','error');return;}if(!deleting.value||!canVoidRecord(deleting.value)){Store.notify('You do not have permission to void this expense.','error');return;}busy.value=true;try{if(deleting.value.origin==='transactions')throw new Error('Historical expenses require a correction workflow.');await Store.deleteExpense(deleting.value.id,approval.value);deleting.value=null;approval.value={managerCode:'',reason:''};Store.notify('Expense voided. Its audit history was retained.');}catch(caught){Store.notify(caught.message,'error');}finally{busy.value=false;}}
function download(text,name){const url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function exportCsv(){download(exportExpensesCsv(expenses.value,suppliers.value),'myfin-expenses.csv');}
function templateCsv(){download(expenseTemplateCsv(businessDate()),'myfin-expense-upload-template.csv');}
async function readCsv(event){error.value='';const chosen=event.target.files?.[0];event.target.value='';if(!chosen)return;try{if(chosen.size>1024*1024)throw new Error('Choose a CSV file smaller than 1 MB.');const rows=importExpensesCsv(await chosen.text(),suppliers.value);importBatch.value={name:chosen.name,batchId:crypto.randomUUID(),rows};}catch(caught){Store.notify(caught.message,'error');}}
async function importCsv(){if(!importBatch.value||busy.value)return;if(!writeReady.value||!Store.can('expensesWrite')){error.value='Reconnect and refresh live data before importing expenses.';return;}busy.value=true;error.value='';try{const result=await Store.importExpenses({batchId:importBatch.value.batchId,rows:importBatch.value.rows});importBatch.value=null;Store.notify(result.alreadyImported?`${result.count} expenses were already imported. No duplicates were created.`:`${result.count} expenses imported.`);}catch(caught){error.value=caught.message;}finally{busy.value=false;}}
</script>

<template>
  <div v-if="Store.can('expensesRead')" class="ed-page">
    <header class="ed-page-head"><div><div class="ed-eyebrow">FINANCE</div><h1>Expenses</h1><p>Track payment status, payer, credit terms, receipts, and linked stock records.</p></div><div class="ed-actions"><template v-if="Store.can('expensesWrite')"><button class="ed-btn" @click="templateCsv"><Icon name="download"/>CSV template</button><button class="ed-btn" :disabled="!writeReady" @click="csvInput.click()"><Icon name="arrow-up"/>Upload CSV</button><input ref="csvInput" type="file" accept=".csv,text/csv" hidden @change="readCsv"></template><button v-if="Store.permissions().owner||Store.permissions().manager" class="ed-btn" @click="exportCsv"><Icon name="download"/>Export</button><button v-if="Store.can('expensesCreate')" class="ed-btn primary" :disabled="!writeReady" @click="edit()"><Icon name="plus"/>Record expense</button></div></header>
    <div v-if="!writeReady" class="ed-notice warning" role="status">Cached expense data is read-only. Reconnect and refresh before recording, editing, importing, or voiding expenses.</div>
    <div class="ed-filters"><div class="ed-search"><Icon name="search"/><input v-model="search" class="ed-input" aria-label="Search expenses" placeholder="Search expenses, payers, or links"></div><select v-model="statusFilter" class="ed-input" aria-label="Filter expense status"><option value="">All statuses</option><option value="paid">Paid</option><option value="pending">Pending</option><option value="overdue">Overdue</option></select><select v-model="paidByFilter" class="ed-input" aria-label="Filter paid by"><option value="">All payment sources</option><option v-for="(label,value) in EXPENSE_PAID_BY_LABELS" :key="value" :value="value">{{ label }}</option></select><div class="expense-totals"><span><small>Accrued shown</small><strong>{{ money(accruedTotal,currency) }}</strong></span><span><small>Cash paid shown</small><strong>{{ money(cashPaidTotal,currency) }}</strong></span></div></div>
    <div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Expense</th><th>Category</th><th>Paid to</th><th>Status</th><th>Paid by</th><th>Linked records</th><th>Date</th><th class="num">Amount</th><th>Receipt</th><th>Actions</th></tr></thead><tbody><tr v-for="expense in expenses" :key="expense.origin+expense.id"><td><button v-if="canEditRecord(expense)" class="ed-link" @click="edit(expense)">{{ expense.description }}</button><strong v-else>{{ expense.description }}</strong><small v-if="expense.origin==='transactions'">Legacy {{ expense.type.toLowerCase() }}</small></td><td><span class="ed-pill">{{ expense.category||'General' }}</span></td><td>{{ supplierName(expense.supplier_id)||expense.payee||'—' }}</td><td><span class="ed-pill" :class="{ready:effectiveExpenseStatus(expense)==='paid',warning:effectiveExpenseStatus(expense)==='pending',error:effectiveExpenseStatus(expense)==='overdue'}">{{ statusName(expense) }}</span><small v-if="expense.status==='paid'&&expense.paidOn">Paid {{ expense.paidOn }}</small><small v-else-if="expense.creditDueDate">Due {{ expense.creditDueDate }}</small></td><td>{{ paidByName(expense) }}</td><td><template v-if="expense.links?.length"><small v-for="link in expense.links.slice(0,3)" :key="link.type+link.id">{{ EXPENSE_LINK_LABELS[link.type] }} · {{ link.label||link.id }}</small><small v-if="expense.links.length>3">+{{ expense.links.length-3 }} more</small></template><span v-else class="ed-muted">—</span></td><td>{{ businessDate(expense.date) }}</td><td class="num">{{ money(expense.amount,currency) }}</td><td><a v-if="expense.receiptUrl" class="ed-link" :href="expense.receiptUrl" target="_blank" rel="noopener">View ↗</a><span v-else class="ed-muted">—</span></td><td><button v-if="canEditRecord(expense)" class="ed-icon-button" :aria-label="`Edit ${expense.description}`" @click="edit(expense)"><Icon name="edit"/></button><button v-if="canVoidRecord(expense)" class="ed-icon-button" :aria-label="`Void ${expense.description}`" @click="deleting=expense;approval={managerCode:'',reason:''}"><Icon name="close"/></button></td></tr></tbody></table></div>
    <div v-if="!expenses.length" class="ed-empty"><Icon name="wallet"/><h3>No matching expenses.</h3><p>Record an expense or change the filters.</p></div>

    <Modal v-if="form" :title="form.id?'Edit expense':'Record expense'" :busy="busy" wide @close="closeEditor">
      <form id="expense-form" class="ed-form-grid" @submit.prevent="save">
        <label class="ed-field wide"><span>Description</span><input v-model="form.description" maxlength="500" required></label>
        <label class="ed-field"><span>Amount ({{ currency }})</span><input v-model="form.amount" type="number" step="0.01" min="0.01" required></label>
        <label class="ed-field"><span>Date</span><input v-model="form.date" type="date" required @change="syncCreditDueDate"></label>
        <label class="ed-field"><span>Category</span><select v-model="form.category"><option v-for="category in ['General','Inventory','Operations','Utilities','Rent','Salaries','Equipment','Marketing','Software/SaaS','Travel']" :key="category">{{ category }}</option></select></label>
        <label v-if="Store.can('suppliersRead')" class="ed-field"><span>Supplier · optional</span><select v-model="form.supplier_id" @change="selectSupplier"><option value="">None</option><option v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id">{{ supplier.name }}</option></select></label>
        <label class="ed-field"><span>Paid to</span><input v-model="form.payee" maxlength="500"></label>
        <label class="ed-field"><span>Payment source</span><select v-model="form.paidByType" required @change="paidByChanged"><option v-if="form.paidByType==='legacy_unspecified'" value="legacy_unspecified">Legacy / unspecified</option><option value="app_user">App user</option><option value="non_user">Named non-user</option><option value="petty_cash">Reserved petty cash</option><option value="other">Other</option><option value="credit">Credit / pay later</option></select></label>
        <label v-if="form.paidByType==='app_user'" class="ed-field"><span>Paid by user</span><select v-model="form.paidByUserId" required><option value="">Choose user</option><option v-for="user in payers" :key="user.id" :value="user.id">{{ user.username||user.id }}</option></select></label>
        <label v-if="form.paidByType==='non_user'" class="ed-field"><span>Non-user name</span><input v-model="form.paidByName" maxlength="500" required></label>
        <label v-if="form.paidByType==='other'" class="ed-field"><span>Who paid / payment source</span><input v-model="form.paidByName" maxlength="500" required></label>
        <label v-if="form.paidByType==='credit'" class="ed-field"><span>Creditor / account · optional</span><input v-model="form.paidByName" maxlength="500"></label>
        <label v-if="form.paidByType==='credit'" class="ed-field"><span>Status</span><select v-model="form.status" @change="statusChanged"><option value="pending">Pending</option><option value="paid">Paid</option></select></label>
        <label v-if="form.paidByType==='credit'" class="ed-field"><span>Credit duration (days)</span><input v-model.number="form.creditTermsDays" type="number" min="1" max="3650" required @change="syncCreditDueDate"></label>
        <label v-if="form.paidByType==='credit'" class="ed-field"><span>Due date</span><input v-model="form.creditDueDate" type="date" required @change="syncCreditTerms"></label>
        <label v-if="form.status==='paid'" class="ed-field"><span>Paid / settled on</span><input v-model="form.paidOn" type="date" :max="businessDate()" required></label>
        <fieldset class="expense-links wide"><legend>Stock and procurement links</legend><p class="ed-muted">Use fixed record types so each expense can be traced back to inventory or purchasing evidence.</p><div v-for="(link,index) in form.links" :key="`${index}-${link.source}`" class="expense-link-row"><select v-model="link.type" :disabled="link.source==='stock_ledger'" :aria-label="`Link ${index+1} type`" @change="link.id=''"><option v-for="type in typesFor(link)" :key="type" :value="type">{{ EXPENSE_LINK_LABELS[type] }}</option></select><select v-model="link.id" :disabled="link.source==='stock_ledger'" :aria-label="`Link ${index+1} record`" required><option value="">Choose record</option><option v-for="option in optionsFor(link)" :key="option.id" :value="option.id">{{ option.label }}</option></select><span v-if="link.source==='stock_ledger'" class="ed-pill">Ledger evidence</span><button v-else class="ed-icon-button" type="button" :aria-label="`Remove link ${index+1}`" @click="form.links.splice(index,1)"><Icon name="close"/></button></div><button class="ed-btn small" type="button" :disabled="!Object.values(linkOptions).some(rows=>rows.length)" @click="addLink"><Icon name="plus"/>Add linked record</button></fieldset>
        <label class="ed-field wide"><span>Receipt · optional, up to 5 MB</span><input type="file" accept="image/*,application/pdf" @change="pick"><small v-if="form.receiptUrl&&!file" class="ed-muted">A receipt is attached. Upload a file to replace it.</small></label>
        <section v-if="form.id" class="expense-history wide" aria-label="Expense lifecycle history"><h3>Lifecycle history</h3><p v-if="eventsLoading" class="ed-muted">Loading history…</p><p v-else-if="!expenseEvents.length" class="ed-muted">No lifecycle events have been recorded for this migrated expense yet.</p><ol v-else><li v-for="event in expenseEvents" :key="event.id"><strong>{{ event.action }} · v{{ event.expenseVersion }} · by {{ actorName(event.actorId) }}</strong><span>{{ event.from?.status||'new' }} → {{ event.to?.status }} · {{ EXPENSE_PAID_BY_LABELS[event.to?.paidByType]||event.to?.paidByType }}<template v-if="event.to?.creditDueDate"> · due {{ event.to.creditDueDate }}</template><template v-if="event.to?.paidOn"> · paid {{ event.to.paidOn }}</template></span><small>{{ new Date(event.createdAt).toLocaleString() }}<template v-if="event.reason"> · {{ event.reason }}</template></small></li></ol></section>
      </form>
      <p v-if="error" class="ed-alert" role="alert">{{ error }}</p>
      <template #actions><button class="ed-btn" :disabled="busy" @click="closeEditor">Cancel</button><button class="ed-btn primary" :disabled="busy||!writeReady" type="submit" form="expense-form">{{ busy?'Saving…':'Save expense' }}</button></template>
    </Modal>

    <Modal v-if="importBatch" title="Review expense import" :busy="busy" wide @close="importBatch=null"><p><strong>{{ importBatch.rows.length }}</strong> expenses from {{ importBatch.name }} are ready to import.</p><div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date</th><th>Description</th><th>Status</th><th>Payment source</th><th>Supplier / payee</th><th>Links</th><th class="num">Amount</th></tr></thead><tbody><tr v-for="(row,index) in importBatch.rows.slice(0,10)" :key="index"><td>{{ row.date }}</td><td>{{ row.description }}</td><td>{{ EXPENSE_STATUS_LABELS[effectiveExpenseStatus(row)] }}</td><td>{{ EXPENSE_PAID_BY_LABELS[row.paidByType] }}</td><td>{{ supplierName(row.supplier_id)||row.payee||'—' }}</td><td>{{ row.links.length||'—' }}</td><td class="num">{{ money(row.amount,currency) }}</td></tr></tbody></table></div><p v-if="importBatch.rows.length>10" class="ed-muted">Showing the first 10 rows. All {{ importBatch.rows.length }} validated rows will be imported together.</p><p v-if="error" class="ed-alert" role="alert">{{ error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="importBatch=null">Cancel</button><button class="ed-btn primary" :disabled="busy||!writeReady" @click="importCsv">{{ busy?'Importing…':`Import ${importBatch.rows.length} expenses` }}</button></template></Modal>
    <Modal v-if="deleting" title="Void this expense?" :busy="busy" @close="deleting=null"><p>{{ deleting.description }} · {{ money(deleting.amount,currency) }}</p><label class="ed-field"><span>Reason</span><input v-model="approval.reason" minlength="3" placeholder="Why this entry is being voided"></label><label v-if="Store.permissions().operator" class="ed-field"><span>Manager approval code</span><input v-model="approval.managerCode" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" placeholder="000000"></label><p class="ed-muted">The entry remains in the audit history.</p><template #actions><button class="ed-btn" :disabled="busy" @click="deleting=null">Keep expense</button><button class="ed-btn danger" :disabled="busy||!writeReady||approval.reason.trim().length<3||(Store.permissions().operator&&!/^\d{6}$/.test(approval.managerCode))" @click="remove">Void expense</button></template></Modal>
  </div>
  <div v-else class="ed-notice">Connect with an authorized company account to view this page.</div>
</template>

<style scoped>
.expense-totals{display:flex;gap:22px;margin-left:auto;text-align:right}.expense-totals span{display:grid;gap:3px}.expense-totals small{color:var(--ed-muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.expense-totals strong{font-size:18px;font-weight:550}.expense-links{border:1px solid var(--ed-line);border-radius:var(--ed-radius);padding:15px}.expense-links legend{padding:0 6px;font-size:12px;font-weight:600}.expense-link-row{display:grid;grid-template-columns:minmax(130px,.7fr) minmax(210px,1.4fr) auto auto;align-items:center;gap:9px;margin:9px 0}.expense-link-row select{min-width:0}.ed-filters>select{min-width:145px}@media(max-width:850px){.expense-totals{width:100%;justify-content:flex-end}.expense-link-row{grid-template-columns:1fr}.expense-link-row .ed-icon-button{justify-self:end}}
.expense-history{border-top:1px solid var(--ed-line);padding-top:12px}.expense-history h3{margin:0 0 8px}.expense-history ol{display:grid;gap:8px;margin:0;padding-left:20px}.expense-history li{padding-left:4px}.expense-history li span,.expense-history li small{display:block;color:var(--ed-muted)}
</style>
