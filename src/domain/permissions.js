export const roleOf = user => user?.role || "";
export function permissionsFor(user) {
  const role=roleOf(user), superAdmin=["super_admin","super"].includes(role), workspaceOwner=role==="workspace_owner",
    owner=superAdmin||workspaceOwner, manager=["manager","company_admin"].includes(role), operator=["operator","company_user"].includes(role), staff=operator, active=owner||manager||operator;
  return {role,superAdmin,workspaceOwner,owner,manager,operator,staff,active,checkout:active,documentsRead:active,documentsDraft:active,
    documentsIssue:owner||manager,documentsConvert:owner||manager,documentsPayment:owner||manager,
    documentsCorrect:owner||manager,inventoryRead:active,inventoryWrite:owner||manager,
    inventoryTransact:active,costsRead:owner,costsWrite:owner,expensesRead:active,expensesCreate:active,
    expensesWrite:owner||manager,expensesVoid:owner||manager,financialReports:owner||manager,
    bulkExport:owner,clientsRead:active,clientsCreate:active,clientsWrite:owner||manager,
    suppliersRead:owner||manager,suppliersWrite:owner,templatesWrite:owner||manager,
    companyWrite:owner||manager,companyFinancialSettingsWrite:owner,integrationSettingsWrite:owner,
    deviceSettingsWrite:active,workspaceWrite:owner,companyEnroll:owner,usersManage:owner||manager,
    managersManage:owner,activityRead:owner||manager,stockHistoryRead:owner||manager,
    receiptReviewsResolve:owner||manager};
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
