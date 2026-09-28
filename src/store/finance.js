import { api, companyPath, writeRecord, removeRecord } from "../services/api";
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
  addExpense(s,e) { if(e.id?!s.can("expensesWrite"):!s.can("expensesCreate")) throw new Error(e.id?"Ask a manager to edit an existing expense.":"You cannot record expenses in this company."); return writeRecord(s,"expenses",e,!!e.id); },
  async deleteExpense(s,id,approval={}) { if(!s.can("expensesVoid")&&!s.permissions().operator) throw new Error("You cannot void this expense.");await api(companyPath(s,"/expenses/"+encodeURIComponent(id)),{method:"DELETE",body:approval});await s.refreshData(); },
  async addClient(s, c) {
    const exists = c.id && s.state.clients.some((x) => x.id === c.id);
    if(c.type === "Supplier" && !s.can("suppliersWrite")) throw new Error("Only an owner can manage supplier details.");
    if(exists && !s.can("clientsWrite")) throw new Error("This account can create customer records but cannot edit existing contacts.");
    return writeRecord(s, "clients", c, !!exists);
  },
  deleteClient(s,id) { if(!s.can("clientsWrite")) throw new Error("Ask a manager to delete a contact."); return removeRecord(s,"clients",id); },
};
