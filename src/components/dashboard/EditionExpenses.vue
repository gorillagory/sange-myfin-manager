<script setup>
import {ref,computed} from 'vue';
import {Store} from '../../store';
import {api,companyPath} from '../../services/api';
import {useStorage} from '../../composables/useStorage';
import {expenseRecords,money,businessDate,cents} from '../../domain/pos';
import {expenseTemplateCsv,exportExpensesCsv,importExpensesCsv} from '../../domain/expensesCsv.js';
import {buildExpenseReport,effectiveReportExpenseStatus} from '../../domain/expenseReport.js';
import {
  EXPENSE_LINK_LABELS,EXPENSE_PAID_BY_LABELS,EXPENSE_STATUS_LABELS,
  expenseHasCashImpact,expenseSaveFailureDisposition,normalizeExpenseLifecycle,
} from '../../domain/expenseLifecycle.js';
import {downloadExpenseReportPdf} from '../../services/expenseReportPdf.js';
import {listExpensePayments,listPettyCashEntries,listPettyCashFunds,postExpensePayment,reverseExpensePayment} from '../../services/pettyCash.js';
import {clearExpenseIntent,loadOrCreateExpenseIntent} from '../../services/expenseIntent.js';
import Icon from '../ui/EditionIcon.vue';
import Modal from '../ui/EditionModal.vue';
import PettyCashPanel from './expenses/PettyCashPanel.vue';

const {uploadFile,removeFile}=useStorage();
const view=ref('expenses'),search=ref(''),statusFilter=ref(''),paidByFilter=ref(''),fromDate=ref(''),toDate=ref(''),form=ref(null),file=ref(null),busy=ref(false),reportBusy=ref(false),error=ref(''),deleting=ref(null),approval=ref({managerCode:'',reason:''}),csvInput=ref(null),importBatch=ref(null);
const payment=ref(null),paymentRows=ref([]),paymentFunds=ref([]),expenseFunds=ref([]),reversingPayment=ref(null),pettyReportData=ref({funds:[],entries:[]});
const expenseEvents=ref([]),eventsLoading=ref(false),editing=ref(false),expenseOutcomeUnknown=ref(false);
let expenseEventRequest=0;
const linkOptions=ref({stockItems:[],stockMovements:[],purchaseOrders:[],goodsReceipts:[]});
const currency=computed(()=>Store.state.selectedCompany?.preferences?.currency||'RM');
const writeReady=computed(()=>Store.state.online&&!Store.state.fromCache);
const suppliers=computed(()=>Store.state.clients.filter(client=>client.type==='Supplier'));
const currentUserId=computed(()=>Store.state.currentUser?.id||Store.state.currentUser?.uid||'');
const paymentLifecycleLocked=computed(()=>Number(form.value?.paidAmountSen||0)>0);
const payers=computed(()=>{
  const companyId=Store.state.selectedCompany?.id,values=[...Store.state.users];
  if(currentUserId.value&&!values.some(user=>user.id===currentUserId.value))values.unshift({id:currentUserId.value,username:Store.state.currentUser?.username||'Current user'});
  if(Store.permissions().operator)return values.filter(user=>user.id===currentUserId.value&&!user.disabled);
  return values.filter(user=>!user.disabled&&(!user.assignments?.length||user.id===currentUserId.value||user.assignments.some(item=>item.company_id===companyId))).sort((a,b)=>String(a.username||a.id).localeCompare(String(b.username||b.id)));
});
const allExpenses=computed(()=>expenseRecords(Store.state).sort((a,b)=>String(b.date).localeCompare(String(a.date))));
const expenses=computed(()=>allExpenses.value.filter(expense=>{
  const query=search.value.trim().toLocaleLowerCase(),status=effectiveReportExpenseStatus(expense);
  return (!query||[expense.description,expense.category,expense.payee,expense.paidByName,expense.paidByUserName,...(expense.links||[]).map(link=>link.label)].join(' ').toLocaleLowerCase().includes(query))
    &&(!statusFilter.value||status===statusFilter.value)
    &&(!paidByFilter.value||(expense.paidByType||expense.paid_by_type||'legacy_unspecified')===paidByFilter.value)
    &&(!fromDate.value||businessDate(expense.date)>=fromDate.value)&&(!toDate.value||businessDate(expense.date)<=toDate.value);
}));
const accruedTotal=computed(()=>expenses.value.reduce((sum,expense)=>sum+cents(expense.amount||0),0)/100);
const cashPaidTotal=computed(()=>expenses.value.reduce((sum,expense)=>sum+(Number.isSafeInteger(Number(expense.paidAmountSen))?Number(expense.paidAmountSen):expenseHasCashImpact(expense)?cents(expense.amount||0):0),0)/100);
const outstandingTotal=computed(()=>expenses.value.reduce((sum,expense)=>sum+(Number.isSafeInteger(Number(expense.outstandingAmountSen))?Number(expense.outstandingAmountSen):expenseHasCashImpact(expense)?0:cents(expense.amount||0)),0)/100);
const supplierName=id=>suppliers.value.find(supplier=>supplier.id===id)?.name||'';
const payerName=id=>payers.value.find(user=>user.id===id)?.username||'';
const actorName=id=>Store.state.users.find(user=>user.id===id)?.username||(id===currentUserId.value?Store.state.currentUser?.username:'')||id;
const canEditRecord=expense=>writeReady.value&&Store.can('expensesWrite')&&expense.origin!=='transactions';
const canVoidRecord=expense=>writeReady.value&&expense.origin!=='transactions'&&(Store.can('expensesVoid')||Store.permissions().operator);
const statusName=expense=>EXPENSE_STATUS_LABELS[effectiveReportExpenseStatus(expense)]||effectiveReportExpenseStatus(expense).replaceAll('_',' ');
const paidByName=expense=>expense.origin==='transactions'?'Legacy record':expense.paidByType==='app_user'?(expense.paidByUserName||payerName(expense.paidByUserId)||'App user'):expense.paidByType==='non_user'?(expense.paidByName||'Named non-user'):expense.paidByType==='credit'?(expense.paidByName||'Credit'):EXPENSE_PAID_BY_LABELS[expense.paidByType||'legacy_unspecified'];
const linkSets={stock_item:'stockItems',stock_movement:'stockMovements',purchase_order:'purchaseOrders',goods_receipt:'goodsReceipts'};
const statusFilters=[['draft','Draft'],['pending_payment','Pending payment'],['partially_paid','Partially paid'],['paid','Paid'],['overdue','Overdue']];
const paymentSourceName=value=>({...EXPENSE_PAID_BY_LABELS,bank:'Bank',card:'Card'})[value]||String(value||'').replaceAll('_',' ');

function addDays(date,days){const stamp=Date.parse(`${date}T00:00:00.000Z`);return Number.isFinite(stamp)?new Date(stamp+Number(days)*86400000).toISOString().slice(0,10):'';}
function syncCreditDueDate(){if(form.value?.paidByType==='credit'&&form.value.date&&Number(form.value.creditTermsDays)>0)form.value.creditDueDate=addDays(form.value.date,form.value.creditTermsDays);}
function syncCreditTerms(){if(form.value?.paidByType!=='credit'||!form.value.date||!form.value.creditDueDate)return;form.value.creditTermsDays=Math.round((Date.parse(`${form.value.creditDueDate}T00:00:00.000Z`)-Date.parse(`${form.value.date}T00:00:00.000Z`))/86400000);}
function paidByChanged(){if(!form.value)return;if(form.value.paidByType==='credit'){form.value.status='pending_payment';form.value.paidOn='';form.value.creditTermsDays=form.value.creditTermsDays||30;syncCreditDueDate();}else if(form.value.paidByType==='unassigned'){form.value.status=form.value.status==='draft'?'draft':'pending_payment';form.value.paidOn='';form.value.creditTermsDays=null;form.value.creditDueDate='';}else{form.value.status='paid';form.value.paidOn||=form.value.date;form.value.creditTermsDays=null;form.value.creditDueDate='';}if(form.value.paidByType!=='app_user')form.value.paidByUserId='';else form.value.paidByUserId||=currentUserId.value;if(form.value.paidByType!=='petty_cash')form.value.pettyCashFundId='';if(!['non_user','other','credit'].includes(form.value.paidByType))form.value.paidByName='';}
function statusChanged(){if(!form.value)return;if(form.value.status==='paid'){if(['unassigned','credit'].includes(form.value.paidByType))form.value.paidByType='app_user';form.value.paidOn||=businessDate();}else{form.value.paidOn='';if(form.value.status==='draft'||form.value.paidByType!=='credit')form.value.paidByType='unassigned';form.value.paidByUserId='';form.value.paidByName='';form.value.pettyCashFundId='';}}
function optionsFor(link){const options=[...(linkOptions.value[linkSets[link.type]]||[])];if(link.id&&!options.some(row=>row.id===link.id))options.unshift({id:link.id,label:link.label||link.id});return options;}
function typesFor(link){return Object.keys(linkSets).filter(type=>type===link.type||(linkOptions.value[linkSets[type]]||[]).length);}
function addLink(){const type=Object.keys(linkSets).find(key=>(linkOptions.value[linkSets[key]]||[]).length)||'stock_item';form.value.links.push({type,id:''});}
async function loadLinkOptions(){try{linkOptions.value=await api(companyPath(Store,'/expense-link-options'));}catch(caught){error.value=caught.message||'Linked stock and purchasing records could not be loaded.';}}
async function loadExpenseFunds(){if(!Store.can('pettyCashRead')){expenseFunds.value=[];return;}try{expenseFunds.value=(await listPettyCashFunds(Store)).rows||[];}catch(caught){error.value=caught.message||'Petty cash funds could not be loaded.';}}
function invalidateExpenseEvents(){expenseEventRequest++;expenseEvents.value=[];eventsLoading.value=false;}
function closeEditor(){
  if(!editing.value&&!expenseOutcomeUnknown.value&&form.value?.id)
    clearExpenseIntent(Store.state.selectedCompany?.id,form.value.id);
  invalidateExpenseEvents();form.value=null;editing.value=false;expenseOutcomeUnknown.value=false;
}
async function loadExpenseEvents(id){const request=++expenseEventRequest;expenseEvents.value=[];eventsLoading.value=true;try{const rows=(await api(companyPath(Store,`/expenses/${encodeURIComponent(id)}/events`))).rows||[];if(request===expenseEventRequest&&form.value?.id===id)expenseEvents.value=rows;}catch(caught){if(request===expenseEventRequest&&form.value?.id===id)error.value=caught.message||'Expense history could not be loaded.';}finally{if(request===expenseEventRequest&&form.value?.id===id)eventsLoading.value=false;}}
function edit(expense){
  if(!writeReady.value){Store.notify('Reconnect and refresh live data before changing expenses.','error');return;}
  if(expense&&!canEditRecord(expense))return;
  invalidateExpenseEvents();
  editing.value=Boolean(expense);expenseOutcomeUnknown.value=false;
  const companyId=Store.state.selectedCompany?.id;
  const requestId=expense?.id||loadOrCreateExpenseIntent(companyId,{committedIds:Store.state.expenses.map(row=>row.id)});
  form.value=expense?JSON.parse(JSON.stringify(expense)):{id:requestId,description:'',amount:'',date:businessDate(),category:'General',payee:'',supplier_id:'',receiptUrl:'',receiptPath:'',status:'paid',paidByType:'app_user',paidByUserId:currentUserId.value,paidByName:'',pettyCashFundId:'',creditTermsDays:null,creditDueDate:'',paidOn:businessDate(),links:[]};
  form.value.status=form.value.status==='pending'?'pending_payment':['draft','pending_payment','partially_paid','paid'].includes(form.value.status)?form.value.status:'paid';
  form.value.paidByType||='legacy_unspecified';
  form.value.paidByUserId||='';form.value.paidByName||='';form.value.pettyCashFundId||='';form.value.creditTermsDays??=null;form.value.creditDueDate||='';form.value.paidOn||=form.value.status==='paid'?form.value.date:'';
  form.value.links=(form.value.links||[]).map(link=>({type:link.type,id:link.id,label:link.label||'',source:link.source||'manual'}));
  file.value=null;error.value='';loadLinkOptions();loadExpenseFunds();if(expense?.id)loadExpenseEvents(expense.id);
}
function pick(event){const chosen=event.target.files[0];if(chosen&&chosen.size>5*1024*1024){error.value='Choose a receipt smaller than 5 MB.';event.target.value='';return;}file.value=chosen;}
function selectSupplier(){if(form.value?.supplier_id)form.value.payee=supplierName(form.value.supplier_id);}
async function save(){
  if(busy.value)return;error.value='';
  if(!writeReady.value){error.value='Reconnect and refresh live data before saving this expense.';return;}
  if(editing.value?!Store.can('expensesWrite'):!Store.can('expensesCreate')){error.value='You do not have permission to save this expense.';return;}
  const rawAmount=String(form.value.amount).trim();
  if(!form.value.description.trim()||!/^\d+(?:\.\d{1,2})?$/.test(rawAmount)||Number(rawAmount)<=0){error.value='Enter a description and an amount greater than zero with at most two decimal places.';return;}
  let lifecycle;try{lifecycle=normalizeExpenseLifecycle(form.value,{actorId:currentUserId.value,
    allowLegacy:editing.value,allowRecordedPaymentState:paymentLifecycleLocked.value,today:businessDate()});}catch(caught){error.value=caught.message;return;}
  busy.value=true;let uploaded=null,saved=false;const oldPath=form.value.receiptPath;
  try{
    if(file.value)uploaded=await uploadFile(file.value,`receipts/${Store.state.selectedCompany.id}/${crypto.randomUUID()}_${file.value.name}`);
    const {origin,amountSen,paidAmountSen,paidAmount,outstandingAmountSen,outstandingAmount,
      paymentSources,effectiveStatus,paidByUserName,...data}=form.value;
    data.amount=Number(rawAmount);Object.assign(data,lifecycle);
    data.links=lifecycle.links;
    if(uploaded){data.receiptUrl=uploaded.url;data.receiptPath=uploaded.path;}
    await Store.addExpense(data,editing.value);
    saved=true;
    if(uploaded&&oldPath&&oldPath!==uploaded.path)await removeFile(oldPath).catch(()=>Store.notify('Expense saved, but the replaced receipt file could not be removed.','warning'));
    closeEditor();Store.notify('Expense saved.');
  }catch(caught){
    const disposition=expenseSaveFailureDisposition(caught);
    if(disposition==='committed'){
      saved=true;
      if(uploaded&&oldPath&&oldPath!==uploaded.path)await removeFile(oldPath).catch(()=>Store.notify('Expense saved, but the replaced receipt file could not be removed.','warning'));
      closeEditor();Store.notify('Expense saved, but live data could not be refreshed. Reconnect and refresh before making another change.','warning');
    }else if(disposition==='ambiguous'){
      expenseOutcomeUnknown.value=true;
      if(uploaded){form.value.receiptUrl=uploaded.url;form.value.receiptPath=uploaded.path;file.value=null;}
      Store.state.fromCache=true;Store.state.dataError='Expense save outcome requires reconciliation.';
      error.value='The server outcome is unknown because the connection was interrupted. The request identity and uploaded receipt were retained; reconnect and refresh before retrying.';
    }
    else{if(uploaded?.path&&!saved)await removeFile(uploaded.path).catch(()=>{});error.value=caught.message;}
  }finally{busy.value=false;}
}
async function remove(){if(busy.value)return;if(!writeReady.value){Store.notify('Reconnect and refresh live data before voiding an expense.','error');return;}if(!deleting.value||!canVoidRecord(deleting.value)){Store.notify('You do not have permission to void this expense.','error');return;}busy.value=true;try{if(deleting.value.origin==='transactions')throw new Error('Historical expenses require a correction workflow.');await Store.deleteExpense(deleting.value.id,approval.value);deleting.value=null;approval.value={managerCode:'',reason:''};Store.notify('Expense voided. Its audit history was retained.');}catch(caught){Store.notify(caught.message,'error');}finally{busy.value=false;}}
function download(text,name){const url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function exportCsv(){download(exportExpensesCsv(expenses.value,suppliers.value),'myfin-expenses.csv');}
async function pettyDataForReport(){
  if(!Store.can('pettyCashRead')||!Store.state.online)return {funds:[],entries:[]};
  const known=pettyReportData.value.funds?.[0],funds=known?[known]:((await listPettyCashFunds(Store)).rows||[]);
  const fund=known||funds.find(item=>item.isDefault)||funds.find(item=>item.status==='open')||funds[0];
  if(!fund)return {funds:[],entries:[]};
  if(known&&pettyReportData.value.complete!==false)return pettyReportData.value;
  const entries=[],seen=new Set();let after='';
  do{const page=await listPettyCashEntries(Store,fund.id,{after,limit:500});entries.push(...(page.rows||[]));after=page.next||'';if(after&&seen.has(after))throw new Error('Petty cash history pagination did not advance. Refresh and try again.');if(after)seen.add(after);if(entries.length>50000)throw new Error('Petty cash history exceeds the PDF export limit. Narrow the date range.');}while(after);
  return {funds:[fund],entries,scope:'selected_fund',complete:true};
}
async function exportPdf(){
  if(reportBusy.value||!Store.can('financialReports'))return;
  if(fromDate.value&&toDate.value&&fromDate.value>toDate.value){Store.notify('The report start date must be on or before the end date.','error');return;}
  reportBusy.value=true;
  try{
    const company=Store.state.selectedCompany||{},workspace=Store.state.tenantContext?.workspace||{id:company.workspace_id,name:company.workspaceName};
    const pettyCash=await pettyDataForReport();
    const report=buildExpenseReport({expenses:allExpenses.value,company,workspace,actor:Store.state.currentUser,
      filters:{from:fromDate.value,to:toDate.value,status:statusFilter.value,paidBy:paidByFilter.value,query:search.value},pettyCash,generatedAt:new Date().toISOString()});
    downloadExpenseReportPdf(report);Store.notify(`Expense report created with ${report.totals.count} records.`);
  }catch(caught){Store.notify(caught.message||'The expense report could not be created.','error');}finally{reportBusy.value=false;}
}
const paymentOutstanding=expense=>Number.isSafeInteger(Number(expense?.outstandingAmountSen))?Number(expense.outstandingAmountSen)/100:Number(expense?.amount||0);
const canSettle=expense=>writeReady.value&&Store.can('expensePaymentsWrite')&&expense.origin!=='transactions'&&!['paid','voided','draft'].includes(effectiveReportExpenseStatus(expense))&&paymentOutstanding(expense)>0;
const canViewPayments=expense=>Store.can('expensePaymentsWrite')&&expense.origin!=='transactions'&&effectiveReportExpenseStatus(expense)!=='voided'&&(Number(expense?.paidAmountSen||0)>0||canSettle(expense));
async function loadPaymentDetail(expense){
  const [history,fundsResult]=await Promise.all([listExpensePayments(Store,expense.id),Store.can('pettyCashRead')?listPettyCashFunds(Store):Promise.resolve({rows:[]})]);
  paymentRows.value=history.rows||[];paymentFunds.value=(fundsResult.rows||[]).filter(fund=>fund.status==='open');
  return {...expense,...(history.expense||{})};
}
async function openPayment(expense){
  if(!canViewPayments(expense))return;busy.value=true;error.value='';
  try{const current=await loadPaymentDetail(expense);payment.value={expense:current,amount:paymentOutstanding(current).toFixed(2),sourceType:'app_user',pettyCashFundId:'',paidByUserId:currentUserId.value,paidByName:'',paidOn:businessDate(),reference:'',reason:'Expense settlement',idempotencyKey:crypto.randomUUID()};}
  catch(caught){Store.notify(caught.message||'Expense payments could not be loaded.','error');}finally{busy.value=false;}
}
function paymentSourceChanged(){if(!payment.value)return;if(payment.value.sourceType==='app_user'){payment.value.paidByUserId||=currentUserId.value;payment.value.paidByName='';payment.value.pettyCashFundId='';}else if(payment.value.sourceType==='petty_cash'){payment.value.pettyCashFundId||=paymentFunds.value.find(fund=>fund.isDefault)?.id||paymentFunds.value[0]?.id||'';payment.value.paidByUserId='';payment.value.paidByName='';}else{payment.value.paidByUserId='';payment.value.pettyCashFundId='';if(!['non_user','other'].includes(payment.value.sourceType))payment.value.paidByName='';}}
async function settleExpense(){
  if(busy.value||!payment.value||!writeReady.value)return;busy.value=true;error.value='';
  try{
    const {expense,amount,sourceType,pettyCashFundId,paidByUserId,paidByName,paidOn,reference,reason,idempotencyKey}=payment.value;
    await postExpensePayment(Store,expense.id,{amount:Number(amount),sourceType,pettyCashFundId,paidByUserId,paidByName,paidOn,reference,reason,idempotencyKey,expectedVersion:expense.version});
    payment.value=null;paymentRows.value=[];await Store.refreshData();Store.notify('Expense payment recorded.');
  }catch(caught){error.value=caught.message||'The expense payment could not be recorded.';}finally{busy.value=false;}
}
function askReversePayment(row){reversingPayment.value={expense:payment.value.expense,row,reason:'',idempotencyKey:crypto.randomUUID()};}
async function reversePayment(){
  if(busy.value||!reversingPayment.value||!writeReady.value)return;busy.value=true;error.value='';
  try{const value=reversingPayment.value;await reverseExpensePayment(Store,value.expense.id,value.row.id,{reason:value.reason,idempotencyKey:value.idempotencyKey,expectedVersion:value.expense.version});reversingPayment.value=null;const updated=await loadPaymentDetail(value.expense);if(payment.value){payment.value.expense=updated;payment.value.amount=paymentOutstanding(updated).toFixed(2);}await Store.refreshData();Store.notify('Expense payment reversed. The audit trail was retained.');}
  catch(caught){error.value=caught.message||'The payment could not be reversed.';}finally{busy.value=false;}
}
function templateCsv(){download(expenseTemplateCsv(businessDate()),'myfin-expense-upload-template.csv');}
async function readCsv(event){error.value='';const chosen=event.target.files?.[0];event.target.value='';if(!chosen)return;try{if(chosen.size>1024*1024)throw new Error('Choose a CSV file smaller than 1 MB.');const rows=importExpensesCsv(await chosen.text(),suppliers.value);importBatch.value={name:chosen.name,batchId:crypto.randomUUID(),rows};}catch(caught){Store.notify(caught.message,'error');}}
async function importCsv(){if(!importBatch.value||busy.value)return;if(!writeReady.value||!Store.can('expensesWrite')){error.value='Reconnect and refresh live data before importing expenses.';return;}busy.value=true;error.value='';try{const result=await Store.importExpenses({batchId:importBatch.value.batchId,rows:importBatch.value.rows});importBatch.value=null;Store.notify(result.alreadyImported?`${result.count} expenses were already imported. No duplicates were created.`:`${result.count} expenses imported.`);}catch(caught){error.value=caught.message;}finally{busy.value=false;}}
</script>

<template>
  <div v-if="Store.can('expensesRead')" class="ed-page">
    <header class="ed-page-head"><div><div class="ed-eyebrow">FINANCE</div><h1>Expenses</h1><p>Track claims, payables, settlements, supporting evidence, and controlled petty cash.</p></div><div v-if="view==='expenses'" class="ed-actions"><template v-if="Store.can('expensesWrite')"><button class="ed-btn" @click="templateCsv"><Icon name="download"/>CSV template</button><button class="ed-btn" :disabled="!writeReady" @click="csvInput.click()"><Icon name="arrow-up"/>Upload CSV</button><input ref="csvInput" type="file" accept=".csv,text/csv" hidden @change="readCsv"></template><button v-if="Store.can('financialReports')" class="ed-btn" :disabled="reportBusy" @click="exportPdf"><Icon name="download"/>{{ reportBusy?'Preparing…':'Finance PDF' }}</button><button v-if="Store.permissions().owner||Store.permissions().manager" class="ed-btn" @click="exportCsv"><Icon name="download"/>Export CSV</button><button v-if="Store.can('expensesCreate')" class="ed-btn primary" :disabled="!writeReady" @click="edit()"><Icon name="plus"/>Record expense</button></div></header>
    <div v-if="Store.can('pettyCashRead')" class="ed-tabs expense-tabs" role="tablist" aria-label="Expense finance views"><button :class="{active:view==='expenses'}" role="tab" :aria-selected="view==='expenses'" @click="view='expenses'">Expenses & claims</button><button :class="{active:view==='petty'}" role="tab" :aria-selected="view==='petty'" @click="view='petty'">Petty cash</button></div>
    <div v-if="!writeReady" class="ed-notice warning" role="status">Cached expense data is read-only. Reconnect and refresh before recording, editing, importing, or voiding expenses.</div>
    <template v-if="view==='expenses'">
      <div class="ed-filters expense-filters"><div class="ed-search"><Icon name="search"/><input v-model="search" class="ed-input" aria-label="Search expenses" placeholder="Search expenses, payers, or links"></div><label class="filter-date"><span>From</span><input v-model="fromDate" class="ed-input" type="date" aria-label="Expense report from date"></label><label class="filter-date"><span>To</span><input v-model="toDate" class="ed-input" type="date" aria-label="Expense report to date"></label><select v-model="statusFilter" class="ed-input" aria-label="Filter expense status"><option value="">All statuses</option><option v-for="([value,label]) in statusFilters" :key="value" :value="value">{{ label }}</option></select><select v-model="paidByFilter" class="ed-input" aria-label="Filter paid by"><option value="">All payment sources</option><option v-for="(label,value) in EXPENSE_PAID_BY_LABELS" :key="value" :value="value">{{ label }}</option></select></div>
      <div class="expense-totals"><span><small>Recorded shown</small><strong>{{ money(accruedTotal,currency) }}</strong></span><span><small>Paid shown</small><strong>{{ money(cashPaidTotal,currency) }}</strong></span><span :class="{attention:outstandingTotal>0}"><small>Outstanding shown</small><strong>{{ money(outstandingTotal,currency) }}</strong></span></div>
      <div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Expense</th><th>Category</th><th>Paid to</th><th>Status</th><th>Payment source</th><th>Linked records</th><th>Date</th><th class="num">Amount</th><th>Receipt</th><th>Actions</th></tr></thead><tbody><tr v-for="expense in expenses" :key="expense.origin+expense.id"><td><button v-if="canEditRecord(expense)" class="ed-link" @click="edit(expense)">{{ expense.description }}</button><strong v-else>{{ expense.description }}</strong><small v-if="expense.origin==='transactions'">Legacy {{ expense.type.toLowerCase() }}</small></td><td><span class="ed-pill">{{ expense.category||'General' }}</span></td><td>{{ supplierName(expense.supplier_id)||expense.payee||'—' }}</td><td><span class="ed-pill" :class="{ready:effectiveReportExpenseStatus(expense)==='paid',warning:['pending_payment','partially_paid'].includes(effectiveReportExpenseStatus(expense)),error:effectiveReportExpenseStatus(expense)==='overdue'}">{{ statusName(expense) }}</span><small v-if="Number(expense.paidAmountSen)>0">Paid {{ money(Number(expense.paidAmountSen)/100,currency) }} · due {{ money(Number(expense.outstandingAmountSen||0)/100,currency) }}</small><small v-else-if="expense.paidOn">Paid {{ expense.paidOn }}</small><small v-else-if="expense.creditDueDate">Due {{ expense.creditDueDate }}</small></td><td>{{ paidByName(expense) }}</td><td><template v-if="expense.links?.length"><small v-for="link in expense.links.slice(0,3)" :key="link.type+link.id">{{ EXPENSE_LINK_LABELS[link.type] }} · {{ link.label||link.id }}</small><small v-if="expense.links.length>3">+{{ expense.links.length-3 }} more</small></template><span v-else class="ed-muted">—</span></td><td>{{ businessDate(expense.date) }}</td><td class="num">{{ money(expense.amount,currency) }}</td><td><a v-if="expense.receiptUrl" class="ed-link" :href="expense.receiptUrl" target="_blank" rel="noopener">View ↗</a><span v-else class="ed-muted">—</span></td><td><div class="expense-row-actions"><button v-if="canViewPayments(expense)" class="ed-btn small" @click="openPayment(expense)">{{ canSettle(expense)?'Pay / settle':'Payments' }}</button><button v-if="canEditRecord(expense)" class="ed-icon-button" :aria-label="`Edit ${expense.description}`" @click="edit(expense)"><Icon name="edit"/></button><button v-if="canVoidRecord(expense)" class="ed-icon-button" :aria-label="`Void ${expense.description}`" @click="deleting=expense;approval={managerCode:'',reason:''}"><Icon name="close"/></button></div></td></tr></tbody></table></div>
      <div v-if="!expenses.length" class="ed-empty"><Icon name="wallet"/><h3>No matching expenses.</h3><p>Record an expense or change the filters.</p></div>
    </template>
    <PettyCashPanel v-else-if="view==='petty'&&Store.can('pettyCashRead')" @report-data="pettyReportData=$event"/>

    <Modal v-if="form" :title="editing?'Edit expense':'Record expense'" :busy="busy" wide @close="closeEditor">
      <form id="expense-form" class="ed-form-grid" @submit.prevent="save">
        <label class="ed-field wide"><span>Description</span><input v-model="form.description" maxlength="500" required></label>
        <label class="ed-field"><span>Amount ({{ currency }})</span><input v-model="form.amount" type="number" step="0.01" min="0.01" required></label>
        <label class="ed-field"><span>Date</span><input v-model="form.date" type="date" required @change="syncCreditDueDate"></label>
        <label class="ed-field"><span>Category</span><select v-model="form.category"><option v-for="category in ['General','Inventory','Operations','Utilities','Rent','Salaries','Equipment','Marketing','Software/SaaS','Travel']" :key="category">{{ category }}</option></select></label>
        <label v-if="Store.can('suppliersRead')" class="ed-field"><span>Supplier · optional</span><select v-model="form.supplier_id" @change="selectSupplier"><option value="">None</option><option v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id">{{ supplier.name }}</option></select></label>
        <label class="ed-field"><span>Paid to</span><input v-model="form.payee" maxlength="500"></label>
        <label class="ed-field"><span>Expense state</span><select v-model="form.status" :disabled="paymentLifecycleLocked||form.status==='partially_paid'" required @change="statusChanged"><option value="draft">Draft</option><option value="pending_payment">Pending payment</option><option v-if="form.status==='partially_paid'" value="partially_paid">Partially paid</option><option value="paid">Paid now</option></select><small v-if="form.status==='partially_paid'&&!paymentLifecycleLocked">Use Pay / settle from the expense list to record the remaining payment.</small></label>
        <label class="ed-field"><span>Payment source</span><select v-model="form.paidByType" :disabled="paymentLifecycleLocked||form.status==='partially_paid'" required @change="paidByChanged"><option v-if="form.paidByType==='legacy_unspecified'" value="legacy_unspecified">Legacy / unspecified</option><option v-if="form.status!=='paid'" value="unassigned">Not assigned yet</option><option value="app_user">App user</option><option value="non_user">Named non-user</option><option v-if="Store.can('pettyCashRead')" value="petty_cash">Petty cash fund</option><option value="other">Other</option><option value="credit">Credit / pay later</option></select></label>
        <p v-if="paymentLifecycleLocked" class="ed-notice wide">Status and payment source are locked because recorded payments are part of the audit trail. Reverse those payments before changing their evidence.</p>
        <label v-if="form.paidByType==='app_user'" class="ed-field"><span>Paid by user</span><select v-model="form.paidByUserId" :disabled="paymentLifecycleLocked" required><option value="">Choose user</option><option v-for="user in payers" :key="user.id" :value="user.id">{{ user.username||user.id }}</option></select></label>
        <label v-if="form.paidByType==='non_user'" class="ed-field"><span>Non-user name</span><input v-model="form.paidByName" :disabled="paymentLifecycleLocked" maxlength="500" required></label>
        <label v-if="form.paidByType==='other'" class="ed-field"><span>Who paid / payment source</span><input v-model="form.paidByName" :disabled="paymentLifecycleLocked" maxlength="500" required></label>
        <label v-if="form.paidByType==='petty_cash'" class="ed-field"><span>Petty cash fund</span><select v-model="form.pettyCashFundId" :disabled="paymentLifecycleLocked" required><option value="">Choose fund</option><option v-for="fund in expenseFunds" :key="fund.id" :value="fund.id" :disabled="fund.id!==form.pettyCashFundId&&(fund.status!=='open'||Number(fund.balance)<Number(form.amount))">{{ fund.name }} · {{ money(fund.balance,currency) }}{{ fund.status!=='open'?' · closed':'' }}</option></select><small v-if="!expenseFunds.some(fund=>fund.status==='open')">Open and replenish a petty cash fund first.</small></label>
        <label v-if="form.paidByType==='credit'" class="ed-field"><span>Creditor / account · optional</span><input v-model="form.paidByName" :disabled="paymentLifecycleLocked" maxlength="500"></label>
        <label v-if="form.paidByType==='credit'" class="ed-field"><span>Credit duration (days)</span><input v-model.number="form.creditTermsDays" :disabled="paymentLifecycleLocked" type="number" min="1" max="3650" required @change="syncCreditDueDate"></label>
        <label v-if="form.paidByType==='credit'" class="ed-field"><span>Due date</span><input v-model="form.creditDueDate" :disabled="paymentLifecycleLocked" type="date" required @change="syncCreditTerms"></label>
        <label v-if="form.status==='paid'" class="ed-field"><span>Paid / settled on</span><input v-model="form.paidOn" :disabled="paymentLifecycleLocked" type="date" :max="businessDate()" required></label><div v-if="form.status!=='paid'&&!paymentLifecycleLocked" class="ed-notice wide">This expense is recorded without moving cash. Record settlement later from Pay / settle.</div>
        <fieldset class="expense-links wide"><legend>Stock and procurement links</legend><p class="ed-muted">Use fixed record types so each expense can be traced back to inventory or purchasing evidence.</p><div v-for="(link,index) in form.links" :key="`${index}-${link.source}`" class="expense-link-row"><select v-model="link.type" :disabled="link.source==='stock_ledger'" :aria-label="`Link ${index+1} type`" @change="link.id=''"><option v-for="type in typesFor(link)" :key="type" :value="type">{{ EXPENSE_LINK_LABELS[type] }}</option></select><select v-model="link.id" :disabled="link.source==='stock_ledger'" :aria-label="`Link ${index+1} record`" required><option value="">Choose record</option><option v-for="option in optionsFor(link)" :key="option.id" :value="option.id">{{ option.label }}</option></select><span v-if="link.source==='stock_ledger'" class="ed-pill">Ledger evidence</span><button v-else class="ed-icon-button" type="button" :aria-label="`Remove link ${index+1}`" @click="form.links.splice(index,1)"><Icon name="close"/></button></div><button class="ed-btn small" type="button" :disabled="!Object.values(linkOptions).some(rows=>rows.length)" @click="addLink"><Icon name="plus"/>Add linked record</button></fieldset>
        <label class="ed-field wide"><span>Receipt · optional, up to 5 MB</span><input type="file" accept="image/*,application/pdf" @change="pick"><small v-if="form.receiptUrl&&!file" class="ed-muted">A receipt is attached. Upload a file to replace it.</small></label>
        <section v-if="editing" class="expense-history wide" aria-label="Expense lifecycle history"><h3>Lifecycle history</h3><p v-if="eventsLoading" class="ed-muted">Loading history…</p><p v-else-if="!expenseEvents.length" class="ed-muted">No lifecycle events have been recorded for this migrated expense yet.</p><ol v-else><li v-for="event in expenseEvents" :key="event.id"><strong>{{ event.action }} · v{{ event.expenseVersion }} · by {{ actorName(event.actorId) }}</strong><span>{{ event.from?.status||'new' }} → {{ event.to?.status }} · {{ EXPENSE_PAID_BY_LABELS[event.to?.paidByType]||event.to?.paidByType }}<template v-if="event.to?.creditDueDate"> · due {{ event.to.creditDueDate }}</template><template v-if="event.to?.paidOn"> · paid {{ event.to.paidOn }}</template></span><small>{{ new Date(event.createdAt).toLocaleString() }}<template v-if="event.reason"> · {{ event.reason }}</template></small></li></ol></section>
      </form>
      <p v-if="error" class="ed-alert" role="alert">{{ error }}</p>
      <template #actions><button class="ed-btn" :disabled="busy" @click="closeEditor">Cancel</button><button class="ed-btn primary" :disabled="busy||!writeReady" type="submit" form="expense-form">{{ busy?'Saving…':'Save expense' }}</button></template>
    </Modal>

    <Modal v-if="importBatch" title="Review expense import" :busy="busy" wide @close="importBatch=null"><p><strong>{{ importBatch.rows.length }}</strong> expenses from {{ importBatch.name }} are ready to import.</p><div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date</th><th>Description</th><th>Status</th><th>Payment source</th><th>Supplier / payee</th><th>Links</th><th class="num">Amount</th></tr></thead><tbody><tr v-for="(row,index) in importBatch.rows.slice(0,10)" :key="index"><td>{{ row.date }}</td><td>{{ row.description }}</td><td>{{ EXPENSE_STATUS_LABELS[effectiveReportExpenseStatus(row)]||effectiveReportExpenseStatus(row) }}</td><td>{{ EXPENSE_PAID_BY_LABELS[row.paidByType] }}</td><td>{{ supplierName(row.supplier_id)||row.payee||'—' }}</td><td>{{ row.links.length||'—' }}</td><td class="num">{{ money(row.amount,currency) }}</td></tr></tbody></table></div><p v-if="importBatch.rows.length>10" class="ed-muted">Showing the first 10 rows. All {{ importBatch.rows.length }} validated rows will be imported together.</p><p v-if="error" class="ed-alert" role="alert">{{ error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="importBatch=null">Cancel</button><button class="ed-btn primary" :disabled="busy||!writeReady" @click="importCsv">{{ busy?'Importing…':`Import ${importBatch.rows.length} expenses` }}</button></template></Modal>
    <Modal v-if="payment" title="Expense payments" :busy="busy" wide @close="payment=null"><div class="payment-summary"><span><small>Expense</small><strong>{{ payment.expense.description }}</strong></span><span><small>Recorded</small><strong>{{ money(payment.expense.amount,currency) }}</strong></span><span><small>Outstanding</small><strong>{{ money(paymentOutstanding(payment.expense),currency) }}</strong></span></div><form v-if="canSettle(payment.expense)" id="expense-payment" class="ed-form-grid" @submit.prevent="settleExpense"><label class="ed-field"><span>Amount ({{ currency }})</span><input v-model="payment.amount" type="number" min="0.01" :max="paymentOutstanding(payment.expense)" step="0.01" required></label><label class="ed-field"><span>Payment date</span><input v-model="payment.paidOn" type="date" :max="businessDate()" required></label><label class="ed-field"><span>Payment source</span><select v-model="payment.sourceType" required @change="paymentSourceChanged"><option value="app_user">App user</option><option value="non_user">Named non-user</option><option value="petty_cash">Petty cash fund</option><option value="bank">Bank</option><option value="card">Card</option><option value="other">Other source</option></select></label><label v-if="payment.sourceType==='app_user'" class="ed-field"><span>Paid by user</span><select v-model="payment.paidByUserId" required><option v-for="user in payers" :key="user.id" :value="user.id">{{ user.username||user.id }}</option></select></label><label v-if="payment.sourceType==='petty_cash'" class="ed-field"><span>Petty cash fund</span><select v-model="payment.pettyCashFundId" required><option value="">Choose fund</option><option v-for="fund in paymentFunds" :key="fund.id" :value="fund.id" :disabled="fund.balance<payment.amount">{{ fund.name }} · {{ money(fund.balance,currency) }}</option></select></label><label v-if="['non_user','other'].includes(payment.sourceType)" class="ed-field"><span>{{ payment.sourceType==='non_user'?'Person who paid':'Payment source' }}</span><input v-model="payment.paidByName" maxlength="500" required></label><label class="ed-field"><span>Reference · optional</span><input v-model="payment.reference" maxlength="120" placeholder="Bank ref, voucher, receipt"></label><label class="ed-field wide"><span>Reason / note</span><textarea v-model="payment.reason" minlength="3" maxlength="1000" required></textarea></label></form><p v-else class="ed-notice">This expense is fully settled. Review its immutable payment history or reverse an incorrect payment below.</p><section v-if="paymentRows.length" class="expense-payment-history"><h3>Payment history</h3><div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>Date</th><th>Source</th><th>Reference</th><th class="num">Amount</th><th>Action</th></tr></thead><tbody><tr v-for="row in paymentRows" :key="row.id"><td>{{ row.paidOn }}</td><td>{{ paymentSourceName(row.sourceType) }}</td><td>{{ row.reference||'—' }}<small>{{ row.reason }}</small></td><td class="num">{{ row.eventType==='reversal'?'-':'' }}{{ money(Number(row.amountSen||0)/100,currency) }}</td><td><button v-if="row.eventType==='payment'&&!paymentRows.some(candidate=>candidate.reversesPaymentId===row.id)&&Store.can('expensePaymentsWrite')" class="ed-btn small" :disabled="!writeReady" @click="askReversePayment(row)">Reverse</button><span v-else class="ed-muted">{{ row.eventType==='reversal'?'Reversal':'—' }}</span></td></tr></tbody></table></div></section><p v-if="payment.sourceType==='petty_cash'&&!paymentFunds.length" class="ed-notice warning">Open and replenish a petty cash fund before using it for this payment.</p><p v-if="error" class="ed-alert">{{ error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="payment=null">Cancel</button><button v-if="canSettle(payment.expense)" class="ed-btn primary" :disabled="busy||!writeReady||(payment.sourceType==='petty_cash'&&!payment.pettyCashFundId)" type="submit" form="expense-payment">Record payment</button></template></Modal>
    <Modal v-if="reversingPayment" title="Reverse expense payment?" :busy="busy" @close="reversingPayment=null"><p>The original payment remains in the audit trail. A reversal restores the expense balance and, for petty cash, restores the same fund atomically.</p><label class="ed-field"><span>Reason</span><textarea v-model="reversingPayment.reason" minlength="3" maxlength="1000" required></textarea></label><p v-if="error" class="ed-alert">{{ error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="reversingPayment=null">Keep payment</button><button class="ed-btn danger" :disabled="busy||!writeReady||reversingPayment.reason.trim().length<3" @click="reversePayment">Reverse payment</button></template></Modal>
    <Modal v-if="deleting" title="Void this expense?" :busy="busy" @close="deleting=null"><p>{{ deleting.description }} · {{ money(deleting.amount,currency) }}</p><label class="ed-field"><span>Reason</span><input v-model="approval.reason" minlength="3" placeholder="Why this entry is being voided"></label><label v-if="Store.permissions().operator" class="ed-field"><span>Manager approval code</span><input v-model="approval.managerCode" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" placeholder="000000"></label><p class="ed-muted">The entry remains in the audit history.</p><template #actions><button class="ed-btn" :disabled="busy" @click="deleting=null">Keep expense</button><button class="ed-btn danger" :disabled="busy||!writeReady||approval.reason.trim().length<3||(Store.permissions().operator&&!/^\d{6}$/.test(approval.managerCode))" @click="remove">Void expense</button></template></Modal>
  </div>
  <div v-else class="ed-notice">Connect with an authorized company account to view this page.</div>
</template>

<style scoped>
.expense-tabs{align-self:start}.expense-filters{align-items:end}.filter-date{display:grid;gap:5px}.filter-date span{color:var(--ed-muted);font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase}.expense-totals{display:flex;justify-content:flex-end;gap:0;text-align:right;border:1px solid var(--ed-line);border-radius:var(--ed-radius);overflow:hidden}.expense-totals span{display:grid;gap:3px;min-width:170px;padding:13px 16px;border-left:1px solid var(--ed-line)}.expense-totals span:first-child{border-left:0}.expense-totals span.attention{background:color-mix(in srgb,var(--ed-error) 6%,var(--ed-paper))}.expense-totals small{color:var(--ed-muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.expense-totals strong{font-size:18px;font-weight:550}.expense-row-actions{display:flex;align-items:center;gap:5px;white-space:nowrap}.expense-links{border:1px solid var(--ed-line);border-radius:var(--ed-radius);padding:15px}.expense-links legend{padding:0 6px;font-size:12px;font-weight:600}.expense-link-row{display:grid;grid-template-columns:minmax(130px,.7fr) minmax(210px,1.4fr) auto auto;align-items:center;gap:9px;margin:9px 0}.expense-link-row select{min-width:0}.ed-filters>select{min-width:145px}.payment-summary{display:grid;grid-template-columns:2fr 1fr 1fr;gap:1px;margin-bottom:18px;border:1px solid var(--ed-line);border-radius:var(--ed-radius);overflow:hidden;background:var(--ed-line)}.payment-summary span{display:grid;gap:4px;padding:13px;background:var(--ed-paper)}.payment-summary small{color:var(--ed-muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.expense-payment-history{grid-column:1/-1;margin-top:18px}.expense-payment-history h3{margin:0 0 8px}@media(max-width:850px){.expense-totals{width:100%;flex-wrap:wrap}.expense-totals span{flex:1;min-width:145px}.expense-link-row{grid-template-columns:1fr}.expense-link-row .ed-icon-button{justify-self:end}.payment-summary{grid-template-columns:1fr}.expense-filters{align-items:stretch}}
.expense-history{border-top:1px solid var(--ed-line);padding-top:12px}.expense-history h3{margin:0 0 8px}.expense-history ol{display:grid;gap:8px;margin:0;padding-left:20px}.expense-history li{padding-left:4px}.expense-history li span,.expense-history li small{display:block;color:var(--ed-muted)}
</style>
