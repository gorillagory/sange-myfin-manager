import { z } from "zod";
export const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const text = z.string().max(500),
  short = z.string().max(120),
  number = z.number().finite().min(0).max(1e9);
const quantity = z
  .number()
  .finite()
  .positive()
  .max(1e6)
  .refine((n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6);
const stock = z
  .number()
  .finite()
  .min(-1e9)
  .max(1e9)
  .refine((n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6);
const opt = (x) => x.optional();
const date = z
  .string()
  .max(40)
  .refine(
    (x) =>
      /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(x) &&
      Number.isFinite(Date.parse(x)) &&
      (x.length !== 10 || new Date(x).toISOString().slice(0, 10) === x),
  );
const email = z.union([z.literal(""), z.email().max(254)]);
const image = z
  .string()
  .max(800000)
  .refine(
    (v) =>
      !v ||
      /^https:\/\/\S+$/.test(v) ||
      /^\/api\/files\/[A-Za-z0-9_-]+$/.test(v) ||
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v),
  );
export const preferences = z.strictObject({
  theme: opt(short),
  currency: opt(z.string().max(8)),
  tax: opt(number.max(100)),
  taxRate: opt(number.max(100)),
  staffDiscountLimit: opt(number.max(100)),
  receiptFooter: opt(text),
  paperWidth: opt(z.enum(["58", "80"])),
  density: opt(z.enum(["comfortable", "compact"])),
  reduceMotion: opt(z.boolean()),
  baseTheme: opt(short),
  primaryColor: opt(short),
  fontFamily: opt(short),
  showLogo: opt(z.boolean()),
  defaultNotes: opt(z.string().max(10000)),
  labels: opt(
    z.strictObject({
      invoice: opt(short),
      quote: opt(short),
      billTo: opt(short),
      total: opt(short),
    }),
  ),
});
export const company = z.strictObject({
  id: opt(id),
  name: short.min(1),
  registration: opt(text),
  address: opt(text),
  phone: opt(text),
  email: opt(email),
  logo: opt(image.nullable()),
  qrCode: opt(image.nullable()),
  qrCodeUrl: opt(image.nullable()),
  preferences: opt(preferences),
});
const base = { id: opt(id), company_id: opt(id) };
const variant = z.strictObject({
  id,
  name: short.min(1),
  sku: opt(z.string().max(64)),
  barcode: opt(z.string().max(64)),
  price: number,
  cost: number,
  stock,
});
export const product = z.strictObject({
  ...base,
  version: opt(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
  name: short.min(1),
  sku: z.string().min(1).max(64),
  code: opt(short),
  barcode: opt(short),
  category: opt(short),
  subcategory: opt(short),
  unit: opt(short),
  price: number,
  cost: number,
  stock,
  trackStock: z.boolean(),
  hasVariants: opt(z.boolean()),
  variants: z.array(variant).max(100),
  description: opt(z.string().max(10000)),
  imageUrl: opt(image),
  imagePath: opt(z.string().max(200)),
});
export const client = z.strictObject({
  ...base,
  name: short.min(1),
  email: opt(email),
  phone: opt(text),
  type: z.enum(["Client", "Customer", "Supplier"]),
  address: opt(text),
  registration: opt(text),
  notes: opt(text),
});
const item = z.strictObject({
  productId: opt(id),
  variantId: opt(z.union([id, z.literal("")])),
  variant: opt(short),
  sku: opt(short),
  desc: text,
  price: number,
  cost: opt(number),
  unit: opt(short),
  qty: quantity,
});
const totals = {
  subtotal: opt(number),
  discountAmount: opt(number),
  tax: opt(number),
  total: number,
  taxRate: number.max(100),
  discount: number.max(100),
};
export const transaction = z.strictObject({
  ...base,
  type: z.enum(["Invoice", "Quote", "Expense", "Payment Voucher"]),
  number: short,
  date,
  status: z.enum(["Pending", "Paid", "Cleared", "Voided", "Converted"]),
  items: z.array(item).max(500).default([]),
  ...totals,
  total: number.default(0),
  taxRate: number.max(100).default(0),
  discount: number.max(100).default(0),
  receiptUrl: opt(z.string().max(500)),
  receiptPath: opt(z.string().max(500)),
  category: opt(short),
  client_id: opt(z.union([id, z.literal("")])),
  project: opt(text),
  notes: opt(z.string().max(10000)),
  quoteId: opt(id),
  convertedTo: opt(id),
  source: opt(z.literal("manual")),
  payee: opt(text),
  description: opt(text),
  amount: opt(number),
});
export const expense = z.strictObject({
  ...base,
  amount: number,
  date,
  description: text,
  payee: opt(text),
  category: opt(short),
  receiptUrl: opt(z.string().max(500)),
  receiptPath: opt(z.string().max(500)),
  attachmentUrl: opt(z.string().max(500)),
  attachmentPath: opt(z.string().max(500)),
});
export const sale = z.strictObject({
  id,
  company_id: id,
  cashierId: id,
  cashierName: short,
  date: z.string().datetime(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  schemaVersion: z.literal(2),
  source: z.literal("pos"),
  type: z.literal("Invoice"),
  number: short,
  status: z.literal("Paid"),
  items: z
    .array(item.extend({ productId: id }))
    .min(1)
    .max(500),
  ...totals,
  paymentMethod: z.enum(["Cash", "QR Pay", "Card"]),
  received: number,
  change: number,
  client_id: z.union([id, z.literal("")]),
  customerName: text,
  customerEmail: email,
  offline: z.boolean(),
  receiptTemplateId: opt(z.string().max(128)),
  receiptTemplateVersion: opt(z.number().int().nonnegative()),
  overrideReason: opt(z.string().trim().min(3).max(1000)),
  storeSnapshot: z.strictObject({
    name: text,
    address: text,
    phone: text,
    registration: text,
    currency: short,
    footer: text,
    paperWidth: z.enum(["58", "80"]),
  }),
});
export const user = z.strictObject({
  id: opt(id),
  username: short.min(1),
  email: z.email().max(254),
  password: opt(z.string().min(12).max(128)),
  role: z.enum(["super_admin", "workspace_owner", "manager", "operator", "super", "company_admin", "company_user"]),
  company_id: z.union([id, z.literal("")]),
  workspace_id: opt(z.union([id,z.literal("")])),
  assignments: opt(z.array(z.strictObject({company_id:id,role:z.enum(["manager","operator"])})).max(100)),
  disabled: opt(z.boolean()),
});
export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw Object.assign(new Error("invalid_input"), { statusCode: 400 });
  return result.data;
}
export function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}
