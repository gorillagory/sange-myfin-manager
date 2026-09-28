import { api, companyPath, writeRecord, removeRecord } from "../services/api";
import { normalizeProduct } from "../domain/pos";
import { stripConfidential } from "../domain/permissions";
const permitted = s => { if (!s.can("inventoryWrite")) throw new Error("This account can view inventory; ask a manager to change it."); };
const product = (s,p) => s.can("costsWrite") ? normalizeProduct(p) : stripConfidential(normalizeProduct(p));
export const inventoryModule = {
  async importProducts(s, products) {
    permitted(s);
    await api(companyPath(s, "/import-products"), { method:"POST", body:products.map(p=>product(s,p)) });
    await s.refreshData();
  },
  addProduct(s,p) { permitted(s); return writeRecord(s,"products",product(s,p)); },
  updateProduct(s,p) { permitted(s); return writeRecord(s,"products",product(s,p),true); },
  deleteProduct(s,id) { permitted(s); return removeRecord(s,"products",id); },
};
