import { api, companyPath, writeRecord, removeRecord } from "../services/api";
import { normalizeProduct } from "../domain/pos";
import { stripConfidential } from "../domain/permissions";
const permitted = s => { if (!s.can("inventoryWrite")) throw new Error("This account can view inventory; ask a manager to change it."); };
const fields = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const productFields = ["id","company_id","version","active","name","sku","code","barcode","category","subcategory","unit","price","cost","stock","trackStock","hasVariants","description","imageUrl","imagePath"];
const variantFields = ["id","name","sku","barcode","price","cost","stock"];
export function productWritePayload(value) {
  const normalized = normalizeProduct(value);
  return {...fields(normalized,productFields),variants:normalized.variants.map(variant=>fields(variant,variantFields))};
}
const product = (s,p) => s.can("costsWrite") ? productWritePayload(p) : stripConfidential(productWritePayload(p));
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
