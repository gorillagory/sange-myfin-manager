import { api } from "../services/api";
import { companyPayload } from "../domain/management";
export const companiesModule = {
  async addCompany(s, c) {
    await api("/companies", {
      method: "POST",
      body: Object.fromEntries(
        Object.entries(c).filter(([k, value]) => !(k === "id" && !value)),
      ),
    });
    await s.startListeners();
  },
  async updateCompany(s, c) {
    const body = companyPayload(c);
    if(!s.can("costsWrite")) delete body.preferences.staffDiscountLimit;
    await api("/companies/" + encodeURIComponent(c.id), {
      method: "PUT",
      body,
    });
    await s.startListeners();
  },
  async deleteCompany(s, id) {
    await api("/companies/" + encodeURIComponent(id), { method: "DELETE" });
    await s.startListeners();
  },
  selectCompany: (s, c) => s.switchCompany(c),
  async updatePreferences(s, prefs) {
    const c = s.state.selectedCompany;
    if (!c) throw new Error("Choose a store first.");
    return this.updateCompany(s, {
      ...c,
      preferences: { ...c.preferences, ...prefs },
    });
  },
};
