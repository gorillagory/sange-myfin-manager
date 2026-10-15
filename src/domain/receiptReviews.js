export const BULK_RECEIPT_REVIEW_LIMIT = 1000;

const bulkApprovalReasons = new Set([
  "receipt_review_required_offline_sync",
  "receipt_review_required_delayed_sync",
]);

const individualReviewReasons = new Map([
  ["cashier_requested_dismissal", "Dismissal request"],
  ["receipt_review_required_offline_time", "Recorded time needs verification"],
  ["receipt_review_required_pricing_policy", "Price, tax or discount needs verification"],
  ["receipt_review_required_merchant_changed", "Merchant details need verification"],
  ["receipt_review_required_product_changed", "Product details need reconciliation"],
  ["receipt_review_required_recipe_timing", "Inventory recipe choice required"],
  ["receipt_review_required_recipe_stock", "Recipe stock needs reconciliation"],
  ["receipt_review_required_record_conflict", "Record conflict needs reconciliation"],
  ["manager_override_reason_required", "Manager override needs individual review"],
  ["stock_unavailable", "Stock needs reconciliation"],
  ["stock_reserved_or_unavailable", "Reserved stock needs reconciliation"],
]);

export function receiptBulkApprovalBlock(row) {
  if (row?.status !== "pending") return "Review already resolved";
  if (bulkApprovalReasons.has(row.reasonCode)) return "";
  return individualReviewReasons.get(row.reasonCode) || "Individual verification required";
}

export function canBulkApproveReceipt(row) {
  return receiptBulkApprovalBlock(row) === "";
}
