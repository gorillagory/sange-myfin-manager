export const roleOf = user => user?.role || "";
export function permissionsFor(user) {
  const role=roleOf(user), owner=role==="super", manager=role==="company_admin", staff=role==="company_user", active=owner||manager||staff;
  return {role,owner,manager,staff,active,checkout:active,documentsRead:active,documentsDraft:active,
    documentsIssue:owner||manager,documentsConvert:owner||manager,documentsPayment:owner||manager,
    documentsCorrect:owner||manager,inventoryRead:active,inventoryWrite:owner||manager,
    costsRead:owner,costsWrite:owner,expensesRead:owner,expensesWrite:owner,financialReports:owner,
    bulkExport:owner,clientsRead:active,clientsCreate:active,clientsWrite:owner||manager,
    suppliersRead:owner,suppliersWrite:owner,templatesWrite:owner||manager,
    companyWrite:owner||manager,companyEnroll:owner,usersManage:owner||manager,
    managersManage:owner,activityRead:owner,stockHistoryRead:owner||manager};
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
