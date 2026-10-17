export const MODULE_DEFINITIONS = Object.freeze([
  Object.freeze({ id:'workspace', label:'Workspace', description:'POS, orders, storefront and kitchen' }),
  Object.freeze({ id:'inventory', label:'Inventory', description:'Products, stock and procurement' }),
  Object.freeze({ id:'finance', label:'Finance', description:'Sales, documents, expenses and payments' }),
  Object.freeze({ id:'analytics', label:'Analytics', description:'Financial analysis, consolidation and marketing' }),
  Object.freeze({ id:'administration', label:'Administration', description:'Contacts, company profile and activity' }),
  Object.freeze({ id:'settings', label:'Settings', description:'Devices, templates and integrations' }),
  Object.freeze({ id:'access', label:'User administration', description:'People, roles and company access' }),
]);
export const MODULE_IDS = Object.freeze(MODULE_DEFINITIONS.map(module => module.id));
const normalizedRole = role => ({super:'super_admin',company_admin:'manager',company_user:'operator'}[role] || role || '');
const roleModules = Object.freeze({
  manager: MODULE_IDS,
  operator: Object.freeze(['workspace','inventory','finance','administration','settings']),
});

export const roleOf = user => normalizedRole(user?.role);
export function moduleCeilingFor(role) {
  role=normalizedRole(role);
  return ['super_admin','workspace_owner'].includes(role) ? [...MODULE_IDS] : [...(roleModules[role] || [])];
}
export const defaultModulesForRole = role => moduleCeilingFor(role);
export function effectiveModulesFor(user) {
  const role=roleOf(user),ceiling=moduleCeilingFor(role);
  if(['super_admin','workspace_owner'].includes(role))return ceiling;
  const configured=Array.isArray(user?.module_grants) ? user.module_grants
    : Array.isArray(user?.modules) ? user.modules : null;
  if(configured===null)return defaultModulesForRole(role);
  const allowed=new Set(ceiling);
  return [...new Set(configured)].filter(module=>allowed.has(module));
}
export const hasModuleAccess = (user,module) => effectiveModulesFor(user).includes(module);
export function actorForCompany(user,company) {
  if(!user||!company?.id)return user;
  const globalRole=normalizedRole(user.globalRole),memberships=Array.isArray(user.companyMemberships)?user.companyMemberships:null;
  if(globalRole==='super_admin'||roleOf(user)==='super_admin')return {...user,role:'super_admin',company_id:company.id,workspace_id:company.workspace_id||user.workspace_id,module_grants:null};
  const workspaceOwner=Array.isArray(user.workspaceMemberships)&&user.workspaceMemberships.some(membership=>membership.workspace_id===company.workspace_id);
  if(workspaceOwner)return {...user,role:'workspace_owner',company_id:company.id,workspace_id:company.workspace_id||user.workspace_id,module_grants:null};
  if(memberships){
    const membership=memberships.find(item=>item.company_id===company.id);
    if(!membership)return {...user,role:'',company_id:company.id,workspace_id:company.workspace_id||'',module_grants:[]};
    return {...user,role:normalizedRole(membership.role),company_id:company.id,
      workspace_id:membership.workspace_id||company.workspace_id||'',module_grants:membership.module_ids??membership.modules??null};
  }
  return {...user,company_id:company.id,workspace_id:company.workspace_id||user.workspace_id};
}
export function permissionsFor(user) {
  const role=roleOf(user), superAdmin=["super_admin","super"].includes(role), workspaceOwner=role==="workspace_owner",
    owner=superAdmin||workspaceOwner, manager=role==="manager", operator=role==="operator", staff=operator, active=owner||manager||operator,
    modules=effectiveModulesFor(user),enabled=module=>owner||modules.includes(module),
    workspace=enabled('workspace'),inventory=enabled('inventory'),finance=enabled('finance'),analytics=enabled('analytics'),
    administration=enabled('administration'),settings=enabled('settings'),access=enabled('access');
  return {role,superAdmin,workspaceOwner,owner,manager,operator,staff,active,modules,
    checkout:active&&workspace,storefrontManage:(owner||manager)&&workspace,
    transactionsRead:active&&(workspace||finance),documentsRead:active&&finance,documentsDraft:active&&finance,
    documentsIssue:(owner||manager)&&finance,documentsConvert:(owner||manager)&&finance,documentsPayment:(owner||manager)&&finance,
    manualSalesCreate:(owner||manager)&&finance,
    documentsCorrect:(owner||manager)&&finance,catalogRead:active&&(workspace||inventory||finance),inventoryRead:active&&inventory,inventoryWrite:(owner||manager)&&inventory,
    inventoryTransact:active&&inventory,costsRead:owner&&inventory,costsWrite:owner&&inventory,expensesRead:active&&finance,expensesCreate:active&&finance,
    expensesWrite:(owner||manager)&&finance,expensesVoid:(owner||manager)&&finance,financialReports:(owner||manager)&&(finance||analytics),
    pettyCashRead:(owner||manager)&&finance,pettyCashManage:(owner||manager)&&finance,expensePaymentsWrite:(owner||manager)&&finance,
    paymentOperationsRead:(owner||manager)&&finance,
    analyticsRead:(owner||manager)&&analytics,
    bulkExport:owner&&inventory,clientsRead:active&&(workspace||finance||administration),clientsCreate:active&&(workspace||administration),clientsWrite:(owner||manager)&&administration,
    customerProfilesRead:(owner||manager)&&(administration||analytics),
    suppliersRead:(owner||manager)&&(inventory||finance||administration),suppliersWrite:owner&&(inventory||administration),
    templatesRead:active&&(finance||settings),templatesWrite:(owner||manager)&&settings,
    companyWrite:(owner||manager)&&administration,companyFinancialSettingsWrite:owner&&administration,integrationSettingsWrite:owner&&settings,integrationsRead:owner&&settings,
    deviceSettingsWrite:active&&settings,workspaceWrite:owner,companyEnroll:owner,usersManage:(owner||manager)&&access,
    managersManage:owner&&access,activityRead:(owner||manager)&&administration,stockHistoryRead:(owner||manager)&&inventory,
    receiptReviewsRead:(active&&workspace)||((owner||manager)&&finance),receiptReviewsResolve:(owner||manager)&&finance,receiptEmailsRetry:(owner||manager)&&finance,studentProgramsRead:(owner||manager)&&analytics,
    studentEligibilityReview:owner&&analytics,promotionsManage:(owner||manager)&&analytics,
    marketingRead:(owner||manager)&&analytics,marketingManage:(owner||manager)&&analytics,marketingWorkspaceManage:owner&&analytics,
    loyaltyWorkspaceManage:owner};
}
export const capabilities = permissionsFor;
export const can = (user,action) => permissionsFor(user)[action] === true;
// Client cache hygiene only; API projections remain the authorization boundary.
const privateKey=/^(cost|costs|totalCost|unitCost|unit_cost|purchasePrice|purchase_price|costPrice|cost_price|margin|profit|grossProfit|gross_profit|netProfit|net_profit|expense|expenses|valuation|inventoryValue|inventory_value|financialReports|financial_reports|costTotal|cost_total)$/i;
export function stripConfidential(value){
  if(Array.isArray(value))return value.map(stripConfidential);
  if(value && typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([key])=>!privateKey.test(key)).map(([key,v])=>[key,stripConfidential(v)]));
  return value;
}
