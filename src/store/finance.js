import { api, companyPath, writeRecord, removeRecord } from "../services/api";
import {expenseCommittedRefreshError} from "../domain/expenseLifecycle.js";
export const financeModule = {
  addTransaction: (s, t) => writeRecord(s, "transactions", t),
  updateTransaction: (s, t) => writeRecord(s, "transactions", t, true),
  deleteTransaction: (s, id) => removeRecord(s, "transactions", id),
  async convertQuote(s, q) {
    const r = await api(
      companyPath(s, "/convert-quote/" + encodeURIComponent(q.id)),
      { method: "POST" },
    );
    await s.refreshData();
    return r.id;
  },
  async assignProject(s, data) {
    await api(companyPath(s, "/assign-project"), {
      method: "POST",
      body: data,
    });
    await s.refreshData();
  },
  async addExpense(s,e) {
    const update=Boolean(e.id);
    if(update?!s.can("expensesWrite"):!s.can("expensesCreate"))
      throw new Error(update?"Ask a manager to edit an existing expense.":"You cannot record expenses in this company.");
    const result=await api(companyPath(s,"/expenses"+(update?"/"+encodeURIComponent(e.id):"")),{
      method:update?"PUT":"POST",body:e,
    });
    let refreshResult;
    try { refreshResult=await s.refreshData(); }
    catch(cause) {
      // The mutation has already committed. Preserve receipt evidence and let
      // the caller explain that only the local projection failed to refresh.
      throw Object.assign(cause,{mutationCommitted:true,mutationResult:result});
    }
    const refreshError=expenseCommittedRefreshError(refreshResult,result);
    if(refreshError) throw refreshError;
    return result;
  },
  async deleteExpense(s,id,approval={}) { if(!s.can("expensesVoid")&&!s.permissions().operator) throw new Error("You cannot void this expense.");await api(companyPath(s,"/expenses/"+encodeURIComponent(id)),{method:"DELETE",body:approval});await s.refreshData(); },
  async importExpenses(s,batch){if(!s.can('expensesWrite'))throw new Error('Ask a manager to import expenses.');const result=await api(companyPath(s,'/import-expenses'),{method:'POST',body:batch});await s.refreshData();return result;},
  async addClient(s, c) {
    const exists = c.id && s.state.clients.some((x) => x.id === c.id);
    if(c.type === "Supplier" && !s.can("suppliersWrite")) throw new Error("Only an owner can manage supplier details.");
    if(exists && !s.can("clientsWrite")) throw new Error("This account can create customer records but cannot edit existing contacts.");
    return writeRecord(s, "clients", c, !!exists);
  },
  deleteClient(s,id) { if(!s.can("clientsWrite")) throw new Error("Ask a manager to delete a contact."); return removeRecord(s,"clients",id); },
};
