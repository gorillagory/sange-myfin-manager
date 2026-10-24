import { randomUUID, createHash } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import * as v from "./validation.js";
import { registerManagement, managementLock, managementSession, requirePasswordSession } from "./management.js";
import {
  canonical,
  deductItems,
  totalsFor,
  saleTotalsFor,
  normalizeProduct,
  cents,
  businessDate,
} from "../../src/domain/pos.js";
import { validateProduct } from "../../src/domain/inventoryCsv.js";
import { owner,manager,operator,requireCapability,containsConfidential,publicProduct,publicClient,publicTransaction,recordVisible,recordOutput,publicStockMovement } from "./access.js";
import { registerDocuments,publishedTemplate } from "./documents.js";
import { templateDefaults } from "../../src/domain/documents.js";
import { registerReceiptReviews } from "./receipt-reviews.js";
import { posIdentity,verifyManagerCode } from "./pos-auth.js";
import { registerWorkspaces } from "./workspaces.js";
import { handoffSubject,createHandoff } from "./session-handoff.js";
import { permissionsFor } from "../../src/domain/permissions.js";
import { registerExpenseImport } from "./expense-import.js";
import { activeExpenseSettlementDate,expenseAuditDetail,expenseLinkOptions,expenseOutput,lockRecordedPaymentLifecycle,prepareExpense,recordExpenseEvent,replaceExpenseLinks } from "./expense-lifecycle.js";
import { inspectExpenseCreate } from "./expense-create.js";
import { recordExpensePayment,registerPettyCash } from "./petty-cash.js";
import { registerStock } from "./stock.js";
import { consumeRecipeStock, offlineRecipeBoundary, recipeAvailabilityForProducts } from "./inventory-recipes.js";
import { registerProcurement } from "./procurement.js";
import { companyReport,companyRows,reportFilterShape } from "./reporting.js";
import { registerReportAutomation } from "./report-automation.js";
import { assertOrderCreated, registerOrders } from "./orders.js";
import { registerStorefrontAdmin } from "./storefront-admin.js";
import { registerCustomerOrders } from "./customer-orders.js";
import { registerCustomerProfiles } from "./customer-profiles.js";
import { registerStudentPrograms } from "./student-programs.js";
import { registerMarketingCampaigns } from "./marketing-campaigns.js";
import { awardLoyaltyPointsForSale, registerMarketingLoyalty } from "./marketing-loyalty.js";
import { registerPosPricing } from "./pos-pricing.js";
import {
  authorizePosPricingRecovery,
  commitPricingRedemptions,
  loadPricingSnapshot,
  posPricingRecoveryState,
} from "./pricing-engine.js";
import { registerAdvancedAnalytics } from "./advanced-analytics.js";
import { registerExpenseAnalytics } from "./expense-analytics.js";
import { registerManualSales } from "./manual-sales.js";
import { assertProductReservationFloor, assertUnreservedSaleStock } from "./customer-order-reservations.js";
import { registerPaymentGatewayStaff } from "./payment-gateways.js";
import { registerReceiptEmails } from "./receipt-emails.js";
import { preserveProductActive, unpublishInactiveProduct } from "./product-availability.js";
import { ensureRequestTerminalStaff, registerTerminalOperations, resolveTerminalContext, terminalDeviceContext } from "./terminal-operations.js";

const delayedReceiptReviewMs = 5 * 60 * 1000;
const maximumHistoricalReceiptMs = 72 * 60 * 60 * 1000;

export function receiptCapturePolicy(sale, serverOccurredAt, acceptedOrderQuote = false) {
  const capturedAt = new Date(sale?.date), serverAt = new Date(serverOccurredAt),
    valid = Number.isFinite(capturedAt.getTime()) && Number.isFinite(serverAt.getTime()),
    ageMs = valid ? serverAt.getTime() - capturedAt.getTime() : 0,
    delayedRecovery = valid && !acceptedOrderQuote && sale?.offline !== true &&
      Math.abs(ageMs) > delayedReceiptReviewMs,
    historicalCapture = !acceptedOrderQuote && (sale?.offline === true || delayedRecovery),
    unusualCaptureTime = valid && !acceptedOrderQuote &&
      (ageMs < -delayedReceiptReviewMs || ageMs > maximumHistoricalReceiptMs);
  return { capturedAt, serverAt, valid, delayedRecovery, historicalCapture, unusualCaptureTime };
}

export async function identity(db, subject, tenant=null) {
  const r = (await db.query(
    `SELECT i.id,i.display_name AS username,i.is_super,i.disabled_at,u.email
       FROM myfin.identity_mappings x JOIN myfin.app_identities i ON i.id=x.identity_id
       JOIN myfin.auth_user u ON u.id=x.subject
      WHERE x.provider='better-auth' AND x.subject=$1`,[subject])).rows[0];
  if (!r || r.disabled_at) v.fail(401, "session_required");
  const workspaces=(await db.query(`SELECT wm.workspace_id,wm.role FROM myfin.workspace_memberships wm
    JOIN myfin.workspaces w ON w.id=wm.workspace_id WHERE wm.identity_id=$1 AND wm.suspended_at IS NULL
    AND w.suspended_at IS NULL AND w.archived_at IS NULL ORDER BY wm.workspace_id`,[r.id])).rows;
  const companies=(await db.query(`SELECT m.company_id,m.role,c.workspace_id,g.module_ids FROM myfin.memberships m
    JOIN myfin.companies c ON c.id=m.company_id JOIN myfin.workspaces w ON w.id=c.workspace_id
    LEFT JOIN myfin.membership_module_grants g ON g.company_id=m.company_id AND g.identity_id=m.identity_id
    WHERE m.identity_id=$1 AND c.suspended_at IS NULL AND c.archived_at IS NULL
      AND w.suspended_at IS NULL AND w.archived_at IS NULL ORDER BY m.company_id`,[r.id])).rows;
  const target=tenant?.surface==="tenant"?tenant.company_id:companies[0]?.company_id||"";
  const company=companies.find(x=>x.company_id===target),workspaceId=tenant?.workspace_id||company?.workspace_id||workspaces[0]?.workspace_id||"";
  const workspaceOwner=workspaces.some(x=>x.workspace_id===workspaceId);
  const role=r.is_super?"super_admin":workspaceOwner?"workspace_owner":company?.role;
  if(!role&&!r.is_super)v.fail(403,"access_denied");
  return {id:r.id,uid:r.id,username:r.username,email:r.email,role,globalRole:r.is_super?"super_admin":"",
    workspace_id:workspaceId,company_id:target,workspaceMemberships:workspaces,companyMemberships:companies,
    module_grants:owner({role})?null:(company?.module_ids??null),
    authLevel:"password",host_company_id:tenant?.surface==="tenant"?tenant.company_id:""};
}
export async function authorize(c, who, companyId, admin = false) {
  const { rows } = await c.query(
    "SELECT * FROM myfin.app_identities WHERE id=$1 AND disabled_at IS NULL FOR SHARE",
    [who.id],
  );
  if (!rows[0]) v.fail(401, "session_required");
  const company = await c.query(
    "SELECT id,workspace_id FROM myfin.companies WHERE id=$1 AND archived_at IS NULL AND suspended_at IS NULL FOR SHARE",
    [companyId],
  );
  if (!company.rowCount) v.fail(404, "not_found");
  if(who.host_company_id&&who.host_company_id!==companyId)v.fail(404,"not_found");
  if (rows[0].is_super) {who.role="super_admin";who.globalRole="super_admin";who.company_id=companyId;who.workspace_id=company.rows[0].workspace_id;who.module_grants=null;return;}
  const wm=await c.query("SELECT 1 FROM myfin.workspace_memberships WHERE identity_id=$1 AND workspace_id=$2 AND suspended_at IS NULL",[who.id,company.rows[0].workspace_id]);
  if(wm.rowCount){who.role="workspace_owner";who.company_id=companyId;who.workspace_id=company.rows[0].workspace_id;who.module_grants=null;return;}
  const m = await c.query(
    `SELECT m.role,g.module_ids FROM myfin.memberships m
      LEFT JOIN myfin.membership_module_grants g ON g.company_id=m.company_id AND g.identity_id=m.identity_id
      WHERE m.identity_id=$1 AND m.company_id=$2 FOR SHARE OF m`,
    [who.id, companyId],
  );
  if (!m.rowCount || (admin && m.rows[0].role !== "manager"))
    v.fail(403, "access_denied");
  who.role=m.rows[0].role;who.company_id=companyId;who.workspace_id=company.rows[0].workspace_id;who.module_grants=m.rows[0].module_ids;
}
async function requireSuper(c, who) {
  const r = await c.query(
    "SELECT id FROM myfin.app_identities WHERE id=$1 AND is_super AND disabled_at IS NULL FOR SHARE",
    [who.id],
  );
  if (!r.rowCount) v.fail(403, "access_denied");
}
async function validateFileRefs(c, companyId, data) {
  const paths = [data.imagePath, data.receiptPath, data.attachmentPath].filter(
    Boolean,
  );
  for (const url of [data.imageUrl, data.receiptUrl, data.attachmentUrl, data.logo, data.qrCode, data.qrCodeUrl].filter(
    Boolean,
  )) {
    if (url.startsWith("/api/files/")) paths.push(url.slice(11));
    else if ([data.receiptUrl, data.attachmentUrl].includes(url)) v.fail(400, "private_file_required");
  }
  for (const path of paths) {
    const file = v.parse(v.id, path);
    const r = await c.query(
      "SELECT id FROM myfin.files WHERE id=$1 AND company_id=$2 FOR KEY SHARE",
      [file, companyId],
    );
    if (!r.rowCount) v.fail(403, "invalid_file_reference");
  }
}
async function validateSupplierRef(c, companyId, supplierId) {
  if (!supplierId) return;
  const row = (await c.query(
    "SELECT data FROM myfin.clients WHERE company_id=$1 AND id=$2 FOR KEY SHARE",
    [companyId, supplierId],
  )).rows[0];
  if (!row || row.data.type !== "Supplier") v.fail(409, "supplier_not_found");
}
export async function reconcileProductVariants(c, companyId, product) {
  for (const variant of product.variants)
    await c.query(
      `INSERT INTO myfin.product_variants(company_id,product_id,id,stock,price,cost)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(company_id,product_id,id) DO UPDATE
       SET stock=EXCLUDED.stock,price=EXCLUDED.price,cost=EXCLUDED.cost`,
      [companyId, product.id, variant.id, variant.stock, variant.price, variant.cost],
    );
  await c.query(
    "DELETE FROM myfin.product_variants WHERE company_id=$1 AND product_id=$2 AND NOT (id=ANY($3::text[]))",
    [companyId, product.id, product.variants.map((variant) => variant.id)],
  );
}
const asRecord = (r) => ({
  ...r.data,
  id: r.id,
  company_id: r.company_id,
  ...(r.version === undefined ? {} : { version: Number(r.version) }),
});
export async function audit(
  c,
  who,
  companyId,
  action,
  details,
  id = randomUUID(),
) {
  await c.query(
    "INSERT INTO myfin.activities(company_id,id,actor_id,data) VALUES($1,$2,$3,$4)",
    [
      companyId,
      id,
      who.id,
      {
        action,
        details,
        user: who.username,
        actorId: who.id,
        date: new Date().toISOString(),
      },
    ],
  );
}
async function saveProduct(c, companyId, data, create = false) {
  const p = normalizeProduct(data);
  if (create) p.version = 1;
  else {
    const current = await c.query(
      "SELECT version FROM myfin.products WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [companyId, p.id],
    );
    if (!current.rowCount) v.fail(404, "not_found");
    if (p.version !== Number(current.rows[0].version))
      v.fail(409, "Product changed. Refresh and reopen it before saving.");
    p.version++;
    await assertProductReservationFloor(c,companyId,p);
  }
  const prior = await c.query(
    "SELECT id,data FROM myfin.products WHERE company_id=$1 ORDER BY id",
    [companyId],
  );
  try {
    validateProduct(
      {
        ...p,
        hasVariants: p.variants.length > 0,
        imageUrl: p.imageUrl?.startsWith("/api/files/") ? "" : p.imageUrl,
      },
      prior.rows.map(asRecord),
    );
  } catch {
    v.fail(400, "invalid_or_duplicate_product");
  }
  if (create) {
    await c.query(
      "INSERT INTO myfin.products(company_id,id,data,stock,price,cost) VALUES($1,$2,$3,$4,$5,$6)",
      [companyId, p.id, p, p.stock, p.price, p.cost],
    );
  } else {
    const r = await c.query(
      "UPDATE myfin.products SET data=$3,stock=$4,price=$5,cost=$6,version=version+1 WHERE company_id=$1 AND id=$2",
      [companyId, p.id, p, p.stock, p.price, p.cost],
    );
    if (!r.rowCount) v.fail(404, "not_found");
  }
  await reconcileProductVariants(c, companyId, p);
  await unpublishInactiveProduct(c, companyId, p);
  const old = prior.rows.find((x) => x.id === p.id)?.data;
  const movements = [];
  for (const target of p.variants.length ? p.variants : [p]) {
    const variantId = p.variants.length ? target.id : "";
    const previous = variantId
      ? old?.variants?.find((x) => x.id === variantId)?.stock
      : old?.stock;
    const quantity =
      Math.round((target.stock - Number(previous || 0)) * 1000) / 1000;
    if (p.trackStock && quantity)
      movements.push({
        productId: p.id,
        variantId,
        quantity,
        stockAfter: target.stock,
      });
  }
  return { ...p, _adjustments: movements };
}
async function acceptedOrderPricing(c, companyId, orderId, sale) {
  if (!orderId || !sale.pricingSnapshotId) v.fail(409, "customer_order_checkout_changed");
  const order = (await c.query(
    `SELECT o.*,s.workspace_id,s.customer_id AS snapshot_customer_id,s.currency_code,
            s.subtotal_sen,s.discount_sen,s.taxable_sen,s.tax_sen,s.tax_basis_points,
            s.rounding_sen AS snapshot_rounding_sen,s.total_sen
       FROM myfin.customer_order_requests o
       JOIN myfin.pricing_snapshots s ON s.company_id=o.company_id AND s.id=o.pricing_snapshot_id
      WHERE o.company_id=$1 AND o.id=$2 AND s.id=$3 FOR SHARE OF s`,
    [companyId, orderId, sale.pricingSnapshotId],
  )).rows[0];
  if (!order || order.customer_id !== order.snapshot_customer_id || Number(order.snapshot_rounding_sen) !== 0)
    v.fail(409, "customer_order_checkout_changed");
  const expected = {
    subtotal: Number(order.subtotal), discountAmount: Number(order.discount_amount),
    tax: Number(order.tax), taxRate: Number(order.tax_rate), discount: 0,
    ...(order.service_mode === "delivery" ? { deliveryFee: Number(order.delivery_fee_sen) / 100 } : {}),
    totalBeforeRounding: Number(order.total_before_rounding), rounding: Number(order.rounding),
    total: Number(order.total),
  };
  const feeSen = Number(order.delivery_fee_sen || 0);
  if (cents(expected.subtotal) !== Number(order.subtotal_sen) ||
      cents(expected.discountAmount) !== Number(order.discount_sen) ||
      cents(expected.tax) !== Number(order.tax_sen) ||
      Math.round(expected.taxRate * 100) !== Number(order.tax_basis_points) ||
      cents(expected.totalBeforeRounding) !== Number(order.total_sen) + feeSen ||
      cents(expected.total) !== cents(expected.totalBeforeRounding) + cents(expected.rounding))
    v.fail(409, "customer_order_checkout_changed");
  const lines = (await c.query(
    `SELECT line_no,product_id,variant_id,quantity_milli,unit_price_sen,gross_sen,
            catalog_unit_price_sen,catalog_product_version,price_source
       FROM myfin.pricing_snapshot_lines
      WHERE workspace_id=$1 AND company_id=$2 AND snapshot_id=$3 ORDER BY line_no`,
    [order.workspace_id, companyId, sale.pricingSnapshotId],
  )).rows;
  if (lines.length !== sale.items.length || lines.some((line, index) => {
    const item = sale.items[index];
    return item.productId !== line.product_id || (item.variantId || "") !== (line.variant_id || "") ||
      Math.round(Number(item.qty) * 1000) !== Number(line.quantity_milli) ||
      cents(item.price) !== Number(line.unit_price_sen) ||
      Math.round(Number(line.unit_price_sen) * Number(line.quantity_milli) / 1000) !== Number(line.gross_sen);
  })) v.fail(409, "customer_order_checkout_changed");
  const discounts = (await c.query(
    `SELECT display_name,discount_sen FROM myfin.pricing_snapshot_discounts
      WHERE workspace_id=$1 AND company_id=$2 AND snapshot_id=$3 ORDER BY sequence`,
    [order.workspace_id, companyId, sale.pricingSnapshotId],
  )).rows.map(row => ({ name: row.display_name, amount: Number(row.discount_sen) / 100 }));
  return { totals: expected, discounts, pricingLines: lines.map(line => ({
    catalogUnitPriceSen: line.catalog_unit_price_sen == null ? null : Number(line.catalog_unit_price_sen),
    catalogProductVersion: line.catalog_product_version == null ? null : Number(line.catalog_product_version),
    priceSource: line.price_source || '',
  })) };
}
async function posSalePricing(c, companyId, who, sale, approval = null) {
  const company = (await c.query(
    'SELECT workspace_id FROM myfin.companies WHERE id=$1 FOR SHARE', [companyId],
  )).rows[0];
  if (!company) v.fail(404, 'company_not_found');
  let customerId = '';
  if (sale.client_id) {
    const link = (await c.query(
      `SELECT link.customer_id
         FROM myfin.clients client
         LEFT JOIN myfin.customer_company_links link
           ON link.company_id=client.company_id AND link.client_id=client.id
        WHERE client.company_id=$1 AND client.id=$2`,
      [companyId, sale.client_id],
    )).rows[0];
    if (link) customerId = link.customer_id || '';
    else if (sale.client_id !== `pos-${sale.id}`) v.fail(409, 'pricing_customer_changed');
  }
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,37))',
    [`${companyId}:pos-pricing:${sale.pricingSnapshotId}`]);
  const prior = (await c.query(
    `SELECT id FROM myfin.transactions
      WHERE company_id=$1 AND pricing_snapshot_id=$2 ORDER BY id FOR SHARE`,
    [companyId, sale.pricingSnapshotId],
  )).rows;
  if (prior.some(row => row.id !== sale.id)) v.fail(409, 'pricing_snapshot_already_used');
  const exactReplay = prior.some(row => row.id === sale.id);
  const snapshot = await loadPricingSnapshot(c, {
    workspaceId: company.workspace_id,
    companyId,
    snapshotId: sale.pricingSnapshotId,
    customerId,
  }, { allowExpired: true });
  if (snapshot.channel !== 'pos' || snapshot.issuedToStaffId !== who.id)
    v.fail(403, 'pricing_snapshot_principal_changed');
  if (!exactReplay) {
    const recovery = posPricingRecoveryState(snapshot, { capturedAt:sale.date });
    const managerRecovery = approval?.pricingExpiryResolution === 'honor_paid_tender';
    if ((!recovery.capturedDuringTender || !recovery.recoveryActive) && !managerRecovery)
      v.fail(409, 'receipt_review_required_pricing_expired');
    if (managerRecovery && (!recovery.capturedDuringTender || !recovery.recoveryActive)) await authorizePosPricingRecovery(c, {
      companyId, checkoutId:sale.id, snapshotId:sale.pricingSnapshotId,
      approverId:approval.who.id, reason:approval.reason,
    });
  }
  if (snapshot.lines.length !== sale.items.length || snapshot.lines.some((line, index) => {
    const item = sale.items[index];
    return item.productId !== line.productId || (item.variantId || '') !== line.variantId ||
      Math.round(Number(item.qty) * 1000) !== line.quantityMilli ||
      cents(item.price) !== line.unitPriceSen ||
      Math.round(line.unitPriceSen * line.quantityMilli / 1000) !== line.grossSen;
  })) v.fail(409, 'pricing_snapshot_cart_changed');
  const totals = {
    subtotal: snapshot.subtotalSen / 100,
    discountAmount: snapshot.discountSen / 100,
    tax: snapshot.taxSen / 100,
    taxRate: snapshot.taxBasisPoints / 100,
    discount: snapshot.manualDiscountBasisPoints / 100,
    totalBeforeRounding: (snapshot.taxableSen + snapshot.taxSen) / 100,
    rounding: snapshot.roundingSen / 100,
    total: snapshot.totalSen / 100,
  };
  const discounts = snapshot.discounts.map(row => ({ name: row.name, amount: row.discountSen / 100 }));
  return { totals, discounts, pricingLines:snapshot.lines, workspaceId: company.workspace_id,
    manualDiscountAmount: snapshot.manualDiscountSen / 100 };
}
export async function checkout(c, who, companyId, input, approval=null, options={}) {
  requireCapability(approval?.who || who, approval ? "receiptReviewsResolve" : "checkout");
  const submittedSale = v.parse(v.sale, input), sale={...submittedSale};
  if (sale.company_id !== companyId || sale.cashierId !== who.id)
    v.fail(403, "invalid_sale_actor");
  let lockedRegister=null;
  if(who.terminalId&&who.registerShiftId){
    lockedRegister=(await c.query(`SELECT * FROM myfin.register_shifts WHERE company_id=$1 AND id=$2
      AND terminal_id=$3 AND store_id=$4 AND store_location_id=$5 FOR UPDATE`,
    [companyId,who.registerShiftId,who.terminalId,who.storeId,who.storeLocationId])).rows[0]||null;
  }
  if (sale.pricingSnapshotId && options.acceptedOrderQuote && !options.reservationOrderId)
    v.fail(409, "customer_order_checkout_changed");
  let totals,lockedPricing=null;
  if (sale.pricingSnapshotId) {
    lockedPricing = options.acceptedOrderQuote
      ? await acceptedOrderPricing(c, companyId, options.reservationOrderId, sale)
      : await posSalePricing(c, companyId, who, sale, approval);
    totals = lockedPricing.totals;
  } else {
    try { totals=saleTotalsFor(sale); } catch { v.fail(400,"invalid_sale_rounding"); }
  }
  if (
    sale.number !== `POS-${sale.id.toUpperCase()}` ||
    sale.businessDate !== businessDate(sale.date) ||
    cents(sale.received) / 100 !== sale.received ||
    cents(sale.change) / 100 !== sale.change
  )
    v.fail(400, "invalid_receipt_fields");
  const serverRow=options.serverNow?{server_now:options.serverNow}:(await c.query('SELECT now() AS server_now')).rows[0],
    capturePolicy=receiptCapturePolicy(sale,serverRow?.server_now,options.acceptedOrderQuote),
    serverOccurredAt=capturePolicy.serverAt,capturedAt=capturePolicy.capturedAt,
    effectiveOffline=capturePolicy.historicalCapture,delayedRecovery=capturePolicy.delayedRecovery,
    unusualCaptureTime=capturePolicy.unusualCaptureTime;
  if(!capturePolicy.valid)v.fail(500,'server_time_unavailable');
  const serverIso=serverOccurredAt.toISOString(),capturedIso=capturedAt.toISOString();
  if((sale.receiptTemplateId&&!(sale.receiptTemplateVersion>0))||(!sale.receiptTemplateId&&sale.receiptTemplateVersion>0))v.fail(400,"invalid_receipt_template_reference");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonical(submittedSale)))
    .digest("hex");
  // Serialize same receipt before checking existence; different receipts then lock
  // product rows in a stable order. Both lock classes are transaction-scoped.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7))", [
    companyId + ":sale:" + sale.id,
  ]);
  const existing = await c.query(
    "SELECT * FROM myfin.transactions WHERE company_id=$1 AND id=$2",
    [companyId, sale.id],
  );
  if (existing.rowCount) {
    if(options.requireNewSale)v.fail(409,"sale_id_already_used");
    // Old paid queues may have had confidential cost fields scrubbed by the access
    // upgrade. Match their complete operational intent, never repost stock.
    const intent=value=>{
      const copy=Object.fromEntries(Object.keys(v.sale.shape).filter(key=>value[key]!==undefined&&!['cashierName','overrideReason'].includes(key)).map(key=>[key,value[key]]));
      copy.items=(copy.items||[]).map(({cost,...item})=>item);return JSON.stringify(canonical(copy));
    };
    if (existing.rows[0].fingerprint !== fingerprint && intent(existing.rows[0].data)!==intent(sale))
      v.fail(409, "receipt_payload_changed");
    // A review approval must never attach a recipe decision to a transaction
    // that was already posted under different inventory evidence. Exact retries
    // of the decision that created the transaction remain idempotent.
    const requestedResolution=approval?.inventoryRecipeResolution||null,
      recordedResolution=existing.rows[0].data?.inventoryRecipeResolution||null;
    if(approval&&requestedResolution!==recordedResolution)v.fail(409,"inventory_recipe_resolution_changed");
    return publicTransaction(asRecord(existing.rows[0]),who);
  }
  // A paid intent retried well after its captured time is no longer a live
  // checkout. Preserve its original accounting date and require an operator to
  // hand it to a manager. Exact lost-response retries still return above.
  // A manager or owner syncing their own routine receipt is already an
  // authenticated resolver. Let that identity continue through the ordinary
  // product, merchant, pricing, recipe and stock checks instead of forcing a
  // second approval solely because transport was offline or delayed. Unusual
  // historical capture timestamps still require an explicit review.
  const selfManagedRecovery=manager(who)||owner(who);
  if(!options.acceptedOrderQuote&&unusualCaptureTime&&(!approval||approval.revalidatePolicy))
    v.fail(409,'receipt_review_required_offline_time');
  if(!approval&&!options.acceptedOrderQuote){
    if(delayedRecovery&&!selfManagedRecovery)v.fail(409,'receipt_review_required_delayed_sync');
    // A receipt captured while the device was offline represents an already
    // collected payment. Unusual timestamps always need an explicit decision;
    // routine operator receipts transfer to the durable review queue.
    if(sale.offline===true){
      if(!selfManagedRecovery)v.fail(409,'receipt_review_required_offline_sync');
    }
  }
  if(!effectiveOffline){
    sale.date=serverIso;sale.businessDate=businessDate(serverIso);sale.offline=false;
  }
  // Once the capture policy accepts the receipt, its effective sale instant is
  // the preserved capture time for delayed/offline recovery and server time for
  // a live checkout. Promotions, loyalty, stock and financial reporting must
  // all use that same instant instead of the later retry/approval time.
  const effectiveSaleIso=sale.date;
  const reviewResolution=await c.query("SELECT status FROM myfin.receipt_reviews WHERE company_id=$1 AND id=$2 FOR SHARE",[companyId,sale.id]);
  if(reviewResolution.rows[0]?.status==="dismissed")v.fail(409,"receipt_dismissed");
  const ids = [...new Set(sale.items.map((i) => i.productId))].sort();
  if (ids.length > 100) v.fail(400, "too_many_products");
  const rows = await c.query(
    "SELECT * FROM myfin.products WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",
    [companyId, ids],
  );
  if (rows.rowCount !== ids.length) v.fail(409, "receipt_review_required_product_changed");
  if (rows.rows.some(row => row.data?.active === false)) v.fail(409, "product_inactive");
  const inventoryShortageApproved=approval?.inventoryShortageResolution==='record_shortage';
  if(!inventoryShortageApproved)
    await assertUnreservedSaleStock(c,companyId,rows.rows,sale.items,options.reservationOrderId||"");
  if(effectiveOffline){
    const boundary=await offlineRecipeBoundary(c,{companyId,items:sale.items,capturedAt:capturedIso});
    if(boundary.changed&&!approval?.inventoryRecipeResolution)v.fail(409,'receipt_review_required_recipe_timing');
    if(!boundary.changed&&approval?.inventoryRecipeResolution)v.fail(400,'inventory_recipe_resolution_not_applicable');
  }
  else if(approval?.inventoryRecipeResolution)v.fail(400,'inventory_recipe_resolution_not_applicable');
  const companyRow=(await c.query(`SELECT name,data,terminal_enforcement_enabled,terminal_enforcement_from,
    require_open_register_for_pos,require_open_register_from FROM myfin.companies WHERE id=$1 FOR SHARE`,[companyId])).rows[0];
  const enforcementFrom=companyRow.terminal_enforcement_from?new Date(companyRow.terminal_enforcement_from):null,
    reviewCreatedAt=options.receiptReviewCreatedAt?new Date(options.receiptReviewCreatedAt):null,
    originSessionAt=options.originPosSessionCreatedAt?new Date(options.originPosSessionCreatedAt):null,
    trustedLegacy=options.legacyTerminalOrigin===true&&enforcementFrom&&(
      (reviewCreatedAt&&reviewCreatedAt<enforcementFrom)||(originSessionAt&&originSessionAt<enforcementFrom));
  const terminalExempt=options.terminalExemptReason==='verified_online_payment';
  if(companyRow.terminal_enforcement_enabled&&!who.terminalId&&!trustedLegacy&&!terminalExempt)
    v.fail(409,'receipt_review_required_terminal_attribution');
  if(who.terminalId&&!who.staffSessionId&&!terminalExempt)
    v.fail(409,'receipt_review_required_terminal_session');
  let terminalAttribution=null;
  let operationalContext=null;
  if(who.terminalId&&who.staffSessionId){
    const context=(await c.query(`SELECT ss.status AS staff_status,ws.status AS work_status,
        rs.status AS register_status,rs.business_date,t.status AS terminal_status,tc.revoked_at AS credential_revoked_at,
        t.code AS terminal_code,t.name AS terminal_name,t.type AS terminal_type,
        st.code AS store_code,st.name AS store_name,sl.code AS location_code,sl.name AS location_name
      FROM myfin.terminal_staff_sessions ss
      JOIN myfin.terminals t ON t.company_id=ss.company_id AND t.id=ss.terminal_id
      JOIN myfin.terminal_credentials tc ON tc.company_id=t.company_id AND tc.terminal_id=t.id AND tc.version=$9
      JOIN myfin.stores st ON st.company_id=ss.company_id AND st.id=ss.store_id
      JOIN myfin.store_locations sl ON sl.company_id=ss.company_id AND sl.id=ss.store_location_id
      LEFT JOIN myfin.staff_work_shifts ws ON ws.company_id=ss.company_id AND ws.id=$6
      LEFT JOIN myfin.register_shifts rs ON rs.company_id=ss.company_id AND rs.id=$7
      WHERE ss.company_id=$1 AND ss.id=$2 AND ss.terminal_id=$3 AND ss.store_id=$4
        AND ss.store_location_id=$5 AND ss.identity_id=$8 FOR SHARE OF ss,t`,
    [companyId,who.staffSessionId,who.terminalId,who.storeId,who.storeLocationId,who.workShiftId||null,
      who.registerShiftId||null,who.id,who.terminalCredentialVersion])).rows[0];
    if(!context||(!options.originReplay&&context.staff_status!=='active'))v.fail(409,'receipt_review_required_terminal_session');
    if(!options.originReplay&&(context.terminal_status!=='active'||context.credential_revoked_at))
      v.fail(409,'receipt_review_required_terminal_session');
    const registerRequired=options.originReplay
      ? options.originRegisterPolicyRequired===true
      : companyRow.require_open_register_for_pos;
    if(registerRequired&&!options.originReplay&&context.work_status!=='open')
      v.fail(409,'receipt_review_required_staff_shift');
    if(registerRequired&&context.register_status!=='open')
      v.fail(409,'receipt_review_required_register_shift');
    if(who.registerShiftId){
      if(!lockedRegister||lockedRegister.status!=='open')v.fail(409,'receipt_review_required_register_shift');
    }
    terminalAttribution={storeId:who.storeId,storeLocationId:who.storeLocationId,terminalId:who.terminalId,
      terminalCredentialVersion:who.terminalCredentialVersion,staffSessionId:who.staffSessionId,
      workShiftId:who.workShiftId||'',registerShiftId:who.registerShiftId||''};
    operationalContext=options.terminalOriginSnapshot||{
      store:{id:who.storeId,code:context.store_code,name:context.store_name},
      location:{id:who.storeLocationId,code:context.location_code,name:context.location_name},
      terminal:{id:who.terminalId,code:context.terminal_code,name:context.terminal_name,type:context.terminal_type},
      staffSessionId:who.staffSessionId,workShiftId:who.workShiftId||'',
      register:who.registerShiftId?{id:who.registerShiftId,businessDate:String(context.business_date).slice(0,10)}:null,
    };
  }
  const company={...companyRow.data,name:companyRow.name},prefs=company.preferences||{};
  const expectedStore={name:company.name||"",address:company.address||"",phone:company.phone||"",registration:company.registration||"",currency:prefs.currency||"RM",footer:prefs.receiptFooter||"Thank you for shopping with us.",paperWidth:prefs.paperWidth||"80"};
  if((!approval||approval.revalidatePolicy)&&JSON.stringify(canonical(sale.storeSnapshot))!==JSON.stringify(canonical(expectedStore)))v.fail(409,"receipt_review_required_merchant_changed");
  const canonicalItems=sale.items.map((item,index)=>{
    const productRow=rows.rows.find(row=>row.id===item.productId),product=productRow?.data;
    const variant=item.variantId?product?.variants?.find(v=>v.id===item.variantId):null;
    if(!product||(item.variantId&&!variant))v.fail(409,"receipt_review_required_product_changed");
    const currentCatalogPrice=Number(variant?.price??product.price),evidence=lockedPricing?.pricingLines?.[index],
      hasHistoricalCatalog=Number.isSafeInteger(evidence?.catalogUnitPriceSen)&&evidence.catalogUnitPriceSen>=0;
    const catalogPrice=hasHistoricalCatalog?evidence.catalogUnitPriceSen/100:
      (lockedPricing?Number(item.price):currentCatalogPrice);
    const catalogVersion=Number(evidence?.catalogProductVersion||productRow.version||product.version||1);
    const priceSource=evidence?.priceSource||
      (lockedPricing||cents(item.price)===cents(currentCatalogPrice)?'catalog':'manual_override');
    return {...item,cost:Number(variant?.cost??product.cost??0),catalogPrice,catalogVersion,priceSource};
  });
  const priceChanged=canonicalItems.some(item=>cents(item.price)!==cents(item.catalogPrice)),taxChanged=sale.taxRate!==Number(prefs.taxRate??prefs.tax??0),limit=Number(prefs.staffDiscountLimit||0),unlockedPricePolicy=!lockedPricing&&(priceChanged||taxChanged);
  if((!approval||approval.revalidatePolicy)&&!options.acceptedOrderQuote&&operator(who)&&(unlockedPricePolicy||sale.discount>limit))v.fail(409,"receipt_review_required_pricing_policy");
  if(!approval&&!options.acceptedOrderQuote&&manager(who)&&(unlockedPricePolicy||sale.discount>limit)&&!sale.overrideReason)v.fail(409,"manager_override_reason_required");
  sale.items=canonicalItems;
  const template=sale.receiptTemplateId?await publishedTemplate(c,companyId,"Receipt",sale.receiptTemplateId,sale.receiptTemplateVersion):sale.receiptTemplateVersion===0?{settings:templateDefaults("Receipt")}:await publishedTemplate(c,companyId,"Receipt");
  if(approval)Object.assign(expectedStore,sale.storeSnapshot);
  const companySnapshot={...expectedStore,email:company.email||"",logo:company.logo||"",qrCode:company.qrCode||company.qrCodeUrl||""};
  if (
    totals.total <= 0 ||
    Object.entries(totals).some(([k, n]) => sale[k] !== n) ||
    cents(sale.received) < cents(totals.total) ||
    cents(sale.change) !== cents(sale.received) - cents(totals.total)
  )
    v.fail(400, "invalid_sale_totals");
  if (sale.paymentMethod !== "Cash" && sale.received !== sale.total)
    v.fail(400, "invalid_tender");
  let deduction;
  try {
    deduction = deductItems(rows.rows.map(asRecord), sale.items, sale.offline||!!approval);
  } catch {
    v.fail(409, "stock_unavailable");
  }
  const { updates, movements, shortage } = deduction;
  if (sale.client_id) {
    const customer = await c.query(
      "SELECT data FROM myfin.clients WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [companyId, sale.client_id],
    );
    if(!owner(who)&&customer.rows[0]?.data.type==="Supplier")v.fail(403,"supplier_restricted");
    if (sale.customerEmail && (!customer.rowCount || !operator(who))) {
      const data = {
        ...(customer.rows[0]?.data || {
          name: sale.customerName,
          type: "Client",
        }),
        email: sale.customerEmail,
      };
      await c.query(
        "INSERT INTO myfin.clients(company_id,id,data) VALUES($1,$2,$3) ON CONFLICT(company_id,id) DO UPDATE SET data=EXCLUDED.data",
        [companyId, sale.client_id, data],
      );
    } else if (!customer.rowCount) v.fail(404, "customer_not_found");
  }
  const saved = {
    ...sale,
    cashierId: who.id,
    cashierName: who.username,
    stockShortage: shortage,
    serverRecordedAt:serverIso,
    ...(delayedRecovery?{clientCapturedAt:capturedIso,recordingMode:'delayed_sync_recovery'}:
      sale.date!==capturedIso?{clientCapturedAt:capturedIso}:{}),
    ...(approval?.inventoryRecipeResolution?{inventoryRecipeResolution:approval.inventoryRecipeResolution}:{}),
    ...(shortage&&inventoryShortageApproved?{inventoryShortageResolution:'record_shortage'}:{}),
    storeSnapshot:expectedStore,companySnapshot,templateSnapshot:template.settings,
    ...(lockedPricing ? { promotionDiscounts: lockedPricing.discounts } : {}),
    ...(terminalAttribution?{...terminalAttribution,operationalContext}:
      {terminalAttribution:terminalExempt?'online_payment':'legacy'}),
  };
  await c.query(
    `INSERT INTO myfin.transactions(company_id,id,actor_id,source,total,fingerprint,data,pricing_snapshot_id,
      store_id,store_location_id,terminal_id,terminal_credential_version,staff_session_id,work_shift_id,register_shift_id)
      VALUES($1,$2,$3,'pos',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [companyId,sale.id,who.id,sale.total,fingerprint,saved,sale.pricingSnapshotId||null,
      terminalAttribution?.storeId||null,terminalAttribution?.storeLocationId||null,terminalAttribution?.terminalId||null,
      terminalAttribution?.terminalCredentialVersion||null,terminalAttribution?.staffSessionId||null,
      terminalAttribution?.workShiftId||null,terminalAttribution?.registerShiftId||null],
  );
  if(sale.paymentMethod==='Cash'&&lockedRegister){
    await c.query(`INSERT INTO myfin.register_cash_entries(company_id,id,register_shift_id,terminal_id,store_id,
      store_location_id,staff_session_id,kind,amount_sen,source_type,source_id,request_id,request_digest,reason,actor_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'cash_sale',$8,'pos_sale',$9,$10,$11,'POS cash sale',$12)`,
    [companyId,randomUUID(),lockedRegister.id,who.terminalId,who.storeId,who.storeLocationId,who.staffSessionId,
      cents(sale.total),sale.id,`sale:${sale.id}`,fingerprint,who.id]);
  }
  if (sale.pricingSnapshotId && !options.acceptedOrderQuote) await commitPricingRedemptions(c, {
    workspaceId: lockedPricing.workspaceId,
    companyId,
    snapshotId: sale.pricingSnapshotId,
    sourceType: 'pos_sale',
    sourceId: sale.id,
  }, { now: effectiveSaleIso });
  if (!options.acceptedOrderQuote && sale.client_id) {
    const customerId = (await c.query(
      `SELECT customer_id FROM myfin.customer_company_links
        WHERE company_id=$1 AND client_id=$2`,
      [companyId, sale.client_id],
    )).rows[0]?.customer_id;
    if (customerId) await awardLoyaltyPointsForSale(c, {
      companyId,
      customerId,
      saleId: sale.id,
      orderId: '',
      sourceType: 'pos_sale',
      channel: 'pos',
      totalSen: cents(sale.total),
      occurredAt: effectiveSaleIso,
      actorId: who.id,
    });
  }
  await assertOrderCreated(c, companyId, sale.id);
  let recipeConsumption;
  try {
    recipeConsumption=await consumeRecipeStock(c, {
      companyId,
      actorId: who.id,
      saleId: sale.id,
      serverOccurredAt:serverIso,
      capturedAt:capturedIso,
      items: sale.items,
      reservationOrderId:options.reservationOrderId||'',
      offline:effectiveOffline,
      inventoryRecipeResolution:approval?.inventoryRecipeResolution||'',
      inventoryShortageResolution:inventoryShortageApproved?'record_shortage':'',
    });
  } catch (error) {
    if(!options.reservationOrderId&&error?.message==='recipe_stock_unavailable')
      v.fail(409,'receipt_review_required_recipe_stock');
    throw error;
  }
  if(recipeConsumption?.inventoryShortage){
    saved.recipeStockShortage=true;
    saved.inventoryShortageResolution='record_shortage';
    await c.query("UPDATE myfin.transactions SET data=$3 WHERE company_id=$1 AND id=$2",
      [companyId,sale.id,saved]);
  }
  for (const p of updates) {
    p.version++;
    await c.query(
      "UPDATE myfin.products SET data=$3,stock=$4,version=version+1 WHERE company_id=$1 AND id=$2",
      [companyId, p.id, p, p.stock],
    );
    for (const x of p.variants)
      await c.query(
        "UPDATE myfin.product_variants SET stock=$4 WHERE company_id=$1 AND product_id=$2 AND id=$3",
        [companyId, p.id, x.id, x.stock],
      );
  }
  await c.query(
    "INSERT INTO myfin.stock_movements(company_id,id,actor_id,data,sale_id) VALUES($1,$2,$3,$4,$2)",
    [
      companyId,
      sale.id,
      who.id,
      {
        saleId: sale.id,
        date: sale.date,
        cashierId: who.id,
        movements,
        shortage,
      },
    ],
  );
  await audit(
    c,
    who,
    companyId,
    "POS sale",
    `${sale.number} · ${sale.paymentMethod} · ${sale.total.toFixed(2)}${shortage||recipeConsumption?.inventoryShortage ? " · Inventory shortage recorded" : ""}`,
    sale.id,
  );
  if(approval)await audit(c,approval.who,companyId,"Approve paid receipt",sale.id+" · "+approval.reason);
  return publicTransaction(saved,who);
}
export function registerBusiness(app, { database: db, auth, authOptions, paymentGateway, receiptEmailEnabled = false }) {
  app.decorateRequest("identity", null);
  app.decorateRequest("authSessionId", null);
  app.decorateRequest("enrolledTerminal", null);
  app.addHook("preHandler", async (req) => {
    if (req.url.startsWith("/api/health/") || req.url.startsWith("/api/public/") || req.url.startsWith("/api/auth/") || req.url.startsWith("/api/pos-auth/") || req.url.startsWith("/api/terminal-enrollment/") || req.url==="/api/terminal-context" || req.url.startsWith("/api/terminal-context?") || req.url.startsWith("/api/terminal-context/heartbeat") || req.url==="/api/tenant-context" || req.url==="/api/session-handoffs/consume" || req.url==="/api/session-handoffs/sign-out")
      return;
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (session) {
      req.identity = await identity(db, session.user.id,req.tenant);
      req.authSessionId = session.session.id;
      req.authLevel="password";
      const terminal=await resolveTerminalContext(db,req,authOptions);
      if(terminal){req.enrolledTerminal=terminal;Object.assign(req.identity,terminalDeviceContext(terminal));}
      return;
    }
    const handoff=await handoffSubject(db,req,authOptions);
    if(handoff){req.identity=await identity(db,handoff.subject,req.tenant);req.identity.authLevel="handoff_password";req.identity.handoffSessionDigest=handoff.digest;req.authLevel="handoff_password";
      const terminal=await resolveTerminalContext(db,req,authOptions);
      if(terminal){req.enrolledTerminal=terminal;Object.assign(req.identity,terminalDeviceContext(terminal));}return;}
    req.identity=await posIdentity(db,req,authOptions);
    if(!req.identity)v.fail(401,"session_required");
    req.authLevel="pos_code";
  });
  app.get("/api/me", async (req) => {
    const { company } = v.parse(z.strictObject({ company:v.id.optional() }), req.query || {});
    if (!company) return req.identity;
    return db.transaction(async c => {
      await managementSession(c,req);
      const selected={...req.identity};
      await authorize(c,selected,company);
      return selected;
    });
  });
  app.post("/api/session-handoffs",async req=>db.transaction(async c=>{
    requirePasswordSession(req);await managementLock(c);await managementSession(c,req);
    const {targetHostname}=v.parse(z.strictObject({targetHostname:z.string().trim().toLowerCase().max(253)}),req.body);
    return createHandoff(c,req,authOptions,targetHostname);
  }));
  app.patch("/api/me", async (req) => {
    requirePasswordSession(req);
    const data = v.parse(
      z.strictObject({ username: z.string().min(1).max(120) }),
      req.body,
    );
    await db.transaction(async (c) => {
      await managementLock(c);
      await managementSession(c,req);
      const active = await c.query("SELECT id FROM myfin.app_identities WHERE id=$1 AND disabled_at IS NULL FOR SHARE", [req.identity.id]);
      if (!active.rowCount) v.fail(401, "session_required");
      await c.query(
        "UPDATE myfin.app_identities SET display_name=$2 WHERE id=$1",
        [req.identity.id, data.username],
      );
      await c.query(
        'UPDATE myfin.auth_user SET name=$2,"updatedAt"=now() WHERE id=$1',
        [req.identity.id, data.username],
      );
    });
    return { ok: true };
  });
  registerManagement(app, { db, authOptions, authorize, requireSuper, validateFileRefs, audit });
  registerWorkspaces(app,{db,authOptions,authorize,audit,validateFileRefs});
  registerDocuments(app,{db,authorize,audit});
  registerReceiptReviews(app,{db,authorize,checkout,audit,ensureTerminalActor:ensureRequestTerminalStaff});
  const scoped = (req, fn, admin = false, transactionOptions = undefined) => {
    const company = v.parse(v.id, req.params.company);
    return db.transaction(async (c) => {
      await managementSession(c,req);
      await authorize(c, req.identity, company, admin);
      return fn(c, company);
    },transactionOptions);
  };
  registerTerminalOperations(app,{db,scoped,audit,authOptions});
  registerExpenseImport(app,{scoped,audit});
  registerPettyCash(app,{scoped,audit});
  registerStock(app,{scoped,audit});
  registerProcurement(app,{scoped,audit});
  registerReportAutomation(app,{scoped,audit});
  registerAdvancedAnalytics(app,{scoped});
  registerExpenseAnalytics(app,{scoped});
  registerOrders(app,{scoped,audit});
  registerManualSales(app,{scoped,audit});
  registerStorefrontAdmin(app,{scoped,authOptions,audit});
  registerCustomerOrders(app,{scoped,audit,ensureTerminalActor:ensureRequestTerminalStaff,
    checkout:(c,who,companyId,sale,approval,options)=>checkout(c,who,companyId,sale,approval,{...options,acceptedOrderQuote:true,requireNewSale:true})});
  registerCustomerProfiles(app,{scoped});
  registerStudentPrograms(app,{scoped,audit,voucherPepper:authOptions.voucherHmacSecret});
  registerMarketingCampaigns(app,{scoped,audit});
  registerMarketingLoyalty(app,{scoped,audit});
  registerPosPricing(app,{scoped,voucherPepper:authOptions.voucherHmacSecret});
  registerPaymentGatewayStaff(app,{scoped,audit,runtime:paymentGateway});
  registerReceiptEmails(app,{scoped,audit,enabled:receiptEmailEnabled});
  app.get("/api/companies/:company/expense-link-options",req=>scoped(req,async(c,co)=>{
    requireCapability(req.identity,"expensesRead");
    return expenseLinkOptions(c,co,req.identity);
  }));
  app.get("/api/companies/:company/expenses/:id/events",req=>scoped(req,async(c,co)=>{
    requireCapability(req.identity,"expensesWrite");
    const id=v.parse(v.id,req.params.id);
    const exists=await c.query("SELECT id FROM myfin.expenses WHERE company_id=$1 AND id=$2",[co,id]);
    if(!exists.rowCount)v.fail(404,"not_found");
    const rows=(await c.query(`SELECT id,expense_version,action,from_lifecycle,to_lifecycle,reason,actor_id,created_at
      FROM myfin.expense_events WHERE company_id=$1 AND expense_id=$2
      ORDER BY expense_version,created_at,id`,[co,id])).rows;
    return {rows:rows.map(row=>({id:row.id,expenseVersion:Number(row.expense_version),action:row.action,
      from:row.from_lifecycle,to:row.to_lifecycle,reason:row.reason,actorId:row.actor_id,createdAt:row.created_at}))};
  }));
  app.get("/api/companies/:company/reports/summary",req=>scoped(req,async(c,co)=>{
    requireCapability(req.identity,"financialReports");
    const dates=v.parse(z.strictObject({from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),...reportFilterShape,analysis:z.enum(["true"]).optional()}),req.query);
    const to=dates.to||businessDate(),from=dates.from||businessDate(new Date(Date.now()-6*86400000));
    const span=(Date.parse(to)-Date.parse(from))/86400000;
    if(!Number.isInteger(span)||span<0||span>366||new Date(from).toISOString().slice(0,10)!==from||new Date(to).toISOString().slice(0,10)!==to)v.fail(400,"invalid_report_range");
    const rows=await companyRows(c,[co],from,to),report=companyReport(rows,from,to,dates);
    return {from,to,...report.totals,daily:report.daily,basis:report.basis,
      ...((dates.analysis==="true"||report.filterActive)?{filters:report.filters,filterOptions:report.filterOptions,
        filterActive:report.filterActive,filterScope:report.filterScope,breakdowns:report.breakdowns}:{})};
  }));
  app.post("/api/companies/:company/stock-adjustments",req=>scoped(req,async(c,co)=>{
    requireCapability(req.identity,"inventoryTransact");
    const body=v.parse(z.strictObject({reason:z.string().trim().min(3).max(500),adjustments:z.array(z.strictObject({productId:v.id,variantId:z.string().max(128).optional(),quantity:z.number().min(-1e6).max(1e6).refine(n=>n!==0)})).min(1).max(100)}),req.body);
    const ids=[...new Set(body.adjustments.map(x=>x.productId))].sort();
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,8))",[co]);
    const rows=await c.query("SELECT * FROM myfin.products WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",[co,ids]);
    if(rows.rowCount!==ids.length)v.fail(404,"product_not_found");
    const movements=[];
    for(const row of rows.rows){
      const product=normalizeProduct(row.data);if(!product.trackStock)v.fail(409,"stock_tracking_required");
      for(const item of body.adjustments.filter(x=>x.productId===row.id)){
        const target=item.variantId?product.variants.find(x=>x.id===item.variantId):product;
        if(!target||(product.variants.length&&!item.variantId))v.fail(404,"variant_not_found");
        const after=Math.round((Number(target.stock)+item.quantity)*1000)/1000;if(after<0)v.fail(409,"stock_unavailable");
        target.stock=after;movements.push({productId:row.id,variantId:item.variantId||"",quantity:item.quantity,stockAfter:after});
      }
      product.stock=product.variants.length?product.variants.reduce((n,x)=>n+Number(x.stock),0):product.stock;product.version=Number(row.version)+1;
      await assertProductReservationFloor(c,co,product);
      await c.query("UPDATE myfin.products SET data=$3,stock=$4,version=version+1 WHERE company_id=$1 AND id=$2",[co,row.id,product,product.stock]);
      for(const item of product.variants)await c.query("UPDATE myfin.product_variants SET stock=$4 WHERE company_id=$1 AND product_id=$2 AND id=$3",[co,row.id,item.id,item.stock]);
    }
    const id=randomUUID(),data={id,company_id:co,action:"Inventory transaction",reason:body.reason,date:new Date().toISOString(),cashierId:req.identity.id,movements};
    await c.query("INSERT INTO myfin.stock_movements(company_id,id,actor_id,data) VALUES($1,$2,$3,$4)",[co,id,req.identity.id,data]);
    await audit(c,req.identity,co,"Inventory transaction",`${id} · ${body.reason}`);
    return publicStockMovement(data,req.identity);
  }));
  const schemas = {
    products: v.product,
    clients: v.client,
    transactions: v.transaction,
    expenses: v.expense,
  };
  for (const name of [
    ...Object.keys(schemas),
    "activities",
    "stock_movements",
  ]) {
    app.get(`/api/companies/:company/${name}`, (req) =>
      scoped(req, async (c, co) => {
        if(name==="products")requireCapability(req.identity,"catalogRead");
        if(name==="transactions")requireCapability(req.identity,"transactionsRead");
        if(name==="clients"){
          const permissions=permissionsFor(req.identity);
          if(!permissions.clientsRead&&!permissions.suppliersRead)v.fail(403,"access_denied");
        }
        const q = v.parse(
          z.strictObject({
            after: v.id.optional(),
            limit: z.coerce.number().int().min(1).max(500).default(500),
          }),
          req.query,
        );
        if(["expenses","activities"].includes(name))requireCapability(req.identity,name==="expenses"?"expensesRead":"activityRead");
        if(name==="stock_movements")requireCapability(req.identity,"stockHistoryRead");
        const predicates=["company_id=$1","id>$2"],args=[co,q.after||""];
        if(name==="expenses")predicates.push("voided_at IS NULL");
        if(name==="expenses"&&operator(req.identity)){args.push(req.identity.id);predicates.push(`created_by=$${args.length}`);}
        if(!permissionsFor(req.identity).suppliersRead&&name==="clients")predicates.push("coalesce(data->>'type','Customer')<>'Supplier'");
        if(!permissionsFor(req.identity).clientsRead&&name==="clients")predicates.push("coalesce(data->>'type','Customer')='Supplier'");
        if(!owner(req.identity)&&name==="transactions"){
          if(operator(req.identity)){args.push(req.identity.id);predicates.push(`((source='pos' AND actor_id=$${args.length}) OR (document_state='draft' AND data->>'type' IN ('Invoice','Quote') AND (actor_id=$${args.length} OR assigned_to=$${args.length})))`);}
          else predicates.push("(source IN ('pos','manual_sale') OR (document_state<>'legacy' AND data->>'type' IN ('Invoice','Quote')) OR (document_state='legacy' AND data->>'type'='Invoice' AND data->>'status' IN ('Pending','Partially paid','Paid','Cleared')))");
        }
        args.push(q.limit+1);
        const select=name==="transactions"?"t.*,(SELECT coalesce(sum(amount),0) FROM myfin.document_payments p WHERE p.company_id=t.company_id AND p.document_id=t.id) AS paid_amount":"*";
        const r=await c.query(`SELECT ${select} FROM myfin.${name} t WHERE ${predicates.join(" AND ")} ORDER BY id LIMIT $${args.length}${name==="products"?" FOR SHARE OF t":""}`,args);
        let page=r.rows.slice(0,q.limit);
        if(name==="expenses")page=await expenseOutput(c,co,page,req.identity);
        if(name==="products"&&page.length){
          const availability=await recipeAvailabilityForProducts(c,co,page),key=(productId,variantId='')=>`${productId}\u0000${variantId}`;
          page=page.map(row=>{
            const data=asRecord(row),variants=(data.variants||[]).map(variant=>{
              const recipe=availability.get(key(row.id,variant.id));return recipe?{...variant,...recipe}:variant;
            }),recipe=availability.get(key(row.id));
            return {...data,...(recipe||{}),variants,
              ...(!recipe&&variants.some(variant=>variant.recipeTracked)?{recipeTracked:true}:{})};
          });
        }
        return {rows:page.map(row=>name==="expenses"?row:name==="products"?publicProduct(row.data?asRecord(row):row,req.identity):name==="clients"?publicClient(asRecord(row),req.identity):name==="transactions"?recordOutput(row,req.identity):name==="stock_movements"?publicStockMovement(asRecord(row),req.identity):asRecord(row)),next:r.rows.length>q.limit?r.rows[q.limit-1].id:null};
      }),
    );
    if (!schemas[name]) continue;
    const save = (req, update) =>
      scoped(req, async (c, co) => {
        let input=req.body;
        let expenseAuditDetails="";
        let savedExpense=null;
        if(name==="products"){
          requireCapability(req.identity,"inventoryWrite");
          await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,8))",[co]);
          const currentProduct=update?(await c.query("SELECT data FROM myfin.products WHERE company_id=$1 AND id=$2 FOR UPDATE",[co,v.parse(v.id,req.params.id)])).rows[0]?.data:null;
          input=preserveProductActive(input,currentProduct,update);
          if(!owner(req.identity)){
            if(containsConfidential(input))v.fail(403,"financial_fields_restricted");
            const prior=currentProduct;
            input={...input,cost:prior?.cost||0,variants:(input.variants||[]).map(item=>({...item,cost:prior?.variants?.find(v=>v.id===item.id)?.cost||0}))};
          }
        }
        if(name==="expenses")requireCapability(req.identity,update?"expensesWrite":"expensesCreate");
        if(name==="transactions"){
          if(!owner(req.identity))v.fail(403,"use_document_workflow");
          if(!["Expense","Payment Voucher"].includes(input?.type))v.fail(409,"use_document_workflow");
        }
        if(name==="clients"){
          requireCapability(req.identity,update?"clientsWrite":"clientsCreate");
          if(!owner(req.identity)&&input?.type==="Supplier")v.fail(403,"supplier_restricted");
          if(update){const prior=(await c.query("SELECT data FROM myfin.clients WHERE company_id=$1 AND id=$2 FOR UPDATE",[co,v.parse(v.id,req.params.id)])).rows[0];if(!owner(req.identity)&&prior?.data.type==="Supplier")v.fail(403,"supplier_restricted");}
        }
        let data = v.parse(name==="expenses"&&!update?v.expenseCreate:schemas[name], input);
        const id =
          update ? v.parse(v.id, req.params.id)
            : name==="expenses" ? data.id : data.id || randomUUID();
        if (
          (data.company_id && data.company_id !== co) ||
          (data.id && data.id !== id)
        )
          v.fail(403, "invalid_tenant_or_id");
        data.id = id;
        data.company_id = co;
        let expenseCreateDigest=null;
        if(name==="expenses"&&!update){
          const request=await inspectExpenseCreate(c,co,req.identity.id,data);
          expenseCreateDigest=request.requestDigest;
          if(request.existing){
            const replay=(await expenseOutput(c,co,[request.existing],req.identity))[0];
            return {...replay,idempotentReplay:true};
          }
        }
        await validateFileRefs(c, co, data);
        if (name === "expenses") await validateSupplierRef(c, co, data.supplier_id);
        if (name === "products") {
          await c.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,8))",
            [co],
          );
          await c.query(
            "SELECT id FROM myfin.products WHERE company_id=$1 AND id=$2 FOR UPDATE",
            [co, id],
          );
          const saved = await saveProduct(c, co, data, !update);
          data.version = saved.version;
          if (saved._adjustments.length)
            await c.query(
              "INSERT INTO myfin.stock_movements(company_id,id,actor_id,data) VALUES($1,$2,$3,$4)",
              [
                co,
                randomUUID(),
                req.identity.id,
                {
                  action: "Stock adjustment",
                  date: new Date().toISOString(),
                  cashierId: req.identity.id,
                  movements: saved._adjustments,
                },
              ],
            );
        } else {
          const old = await c.query(
            `SELECT * FROM myfin.${name} WHERE company_id=$1 AND id=$2 FOR UPDATE`,
            [co, id],
          );
          if (["pos","manual_sale"].includes(old.rows[0]?.source))
            v.fail(409, "posted_sale_immutable");
          if (update && !old.rowCount) v.fail(404, "not_found");
          if (!update && old.rowCount) v.fail(409, "already_exists");
          if (name === "transactions") {
            if (
              (!update &&
                (data.quoteId ||
                  data.convertedTo ||
                  data.status === "Converted")) ||
              (update &&
                (old.rows[0].data.status === "Converted" ||
                  data.quoteId !== old.rows[0].data.quoteId ||
                  data.convertedTo !== old.rows[0].data.convertedTo ||
                  data.type !== old.rows[0].data.type))
            )
              v.fail(409, "conversion_fields_protected");
            if (data.number.startsWith("POS-"))
              v.fail(400, "reserved_receipt_number");
            if (data.client_id) {
              const r = await c.query(
                "SELECT id FROM myfin.clients WHERE company_id=$1 AND id=$2",
                [co, data.client_id],
              );
              if (!r.rowCount) v.fail(404, "customer_not_found");
            }
            if (["Expense", "Payment Voucher"].includes(data.type)) {
              if (data.amount === undefined || !data.description)
                v.fail(400, "invalid_expense");
              data.amount = cents(data.amount) / 100;
              data.total = data.amount;
            } else {
              if (!data.items.length) v.fail(400, "items_required");
              Object.assign(
                data,
                totalsFor(data.items, data.taxRate, data.discount),
              );
              if (data.subtotal > 1e9 || data.total > 1e9)
                v.fail(400, "amount_too_large");
            }
            if (update)
              await c.query(
                "UPDATE myfin.transactions SET data=$3,total=$4 WHERE company_id=$1 AND id=$2",
                [co, id, data, data.total],
              );
            else
              await c.query(
                "INSERT INTO myfin.transactions(company_id,id,actor_id,source,total,data) VALUES($1,$2,$3,'manual',$4,$5)",
                [co, id, req.identity.id, data.total, data],
              );
          } else if (name === "expenses") {
            if(update&&old.rows[0].voided_at)v.fail(409,"expense_voided");
            if(!update&&data.status==='partially_paid')v.fail(409,"expense_payment_state_derived");
            const paidAmountSen=update?Number(old.rows[0].paid_amount_sen||0):0;
            if(update&&paidAmountSen>0){
              const paymentLock=lockRecordedPaymentLifecycle(data,old.rows[0]);
              if(paymentLock.changedFields.length)v.fail(409,"expense_payment_source_immutable");
              data=paymentLock.input;
            }
            let prepared=await prepareExpense(c,co,req.identity,data,
              {allowLegacy:update&&old.rows[0].paid_by_type==="legacy_unspecified",
                allowRecordedPaymentState:update&&paidAmountSen>0,defaultPaidOn:update?'':data.date,
                existingPettyCashFundId:update?(old.rows[0].petty_cash_fund_id||''):''});
            if(update&&prepared.version===undefined)v.fail(409,"expense_version_required");
            if(update&&prepared.version!==Number(old.rows[0].version))v.fail(409,"expense_changed");
            if(update){
              if(paidAmountSen>prepared.amountSen)v.fail(409,"expense_amount_below_payments");
              const oldStatus=old.rows[0].status==='pending'?'pending_payment':old.rows[0].status;
              if(prepared.status==='paid'&&oldStatus!=='paid')v.fail(409,"use_expense_payment_workflow");
              if(prepared.status==='partially_paid'&&oldStatus!=='partially_paid')v.fail(409,"expense_payment_state_derived");
              let derivedStatus=prepared.status,derivedPaidOn=prepared.paidOn;
              if(paidAmountSen>0){
                derivedStatus=paidAmountSen<prepared.amountSen?'partially_paid':'paid';
                if(derivedStatus==='paid'){
                  derivedPaidOn=old.rows[0].paid_on||prepared.paidOn;
                  if(!derivedPaidOn){
                    derivedPaidOn=await activeExpenseSettlementDate(c,co,id);
                    if(!derivedPaidOn)v.fail(409,"expense_payment_state_inconsistent");
                  }
                }else derivedPaidOn='';
              }else if(!['draft','pending_payment'].includes(prepared.status)){
                v.fail(409,"expense_payment_state_derived");
              }
              prepared={...prepared,status:derivedStatus,paidOn:derivedPaidOn,
                data:{...prepared.data,status:derivedStatus,paidOn:derivedPaidOn,
                  paidAmountSen,outstandingAmountSen:prepared.amountSen-paidAmountSen}};
            }
            data=prepared.data;
            data.amount=prepared.amountSen/100;
            expenseAuditDetails=expenseAuditDetail(id,update?old.rows[0]:null,prepared);
            if (update)
              await c.query(
                `UPDATE myfin.expenses SET data=$3,amount=$4,amount_sen=$5,supplier_id=$6,status=$7,
                  paid_by_type=$8,paid_by_identity_id=$9,paid_by_name=$10,petty_cash_fund_id=$11,
                  credit_terms_days=$12,credit_due_date=$13,paid_on=$14
                 WHERE company_id=$1 AND id=$2`,
                [co,id,data,data.amount,prepared.amountSen,data.supplier_id||null,prepared.status,
                  prepared.paidByType,prepared.paidByUserId||null,prepared.paidByName||null,
                  prepared.pettyCashFundId||null,prepared.creditTermsDays,prepared.creditDueDate||null,prepared.paidOn||null],
              );
            else {
              const initialStatus=prepared.status==='paid'?'pending_payment':prepared.status;
              const initialPaidOn=prepared.status==='paid'?null:(prepared.paidOn||null);
              const initialData={...data,status:initialStatus,paidOn:initialPaidOn||'',paidAmountSen:0,
                outstandingAmountSen:prepared.amountSen};
              await c.query(
                `INSERT INTO myfin.expenses(company_id,id,data,amount,amount_sen,created_by,supplier_id,status,
                  paid_by_type,paid_by_identity_id,paid_by_name,petty_cash_fund_id,credit_terms_days,credit_due_date,paid_on,
                  create_request_digest)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
                [co,id,initialData,data.amount,prepared.amountSen,req.identity.id,data.supplier_id||null,initialStatus,
                  prepared.paidByType,prepared.paidByUserId||null,prepared.paidByName||null,
                  prepared.pettyCashFundId||null,prepared.creditTermsDays,prepared.creditDueDate||null,initialPaidOn,
                  expenseCreateDigest],
              );
            }
            await replaceExpenseLinks(c,co,id,prepared.links,req.identity);
            savedExpense=(await c.query("SELECT * FROM myfin.expenses WHERE company_id=$1 AND id=$2",[co,id])).rows[0];
            const eventAction=!update?"created":"updated";
            await recordExpenseEvent(c,co,req.identity,{expenseId:id,expenseVersion:Number(savedExpense.version),
              action:eventAction,from:update?old.rows[0]:null,to:savedExpense});
            if(!update&&prepared.status==='paid'){
              const payment=await recordExpensePayment(c,req.identity,co,id,{
                amount:prepared.amountSen/100,sourceType:prepared.paidByType,
                pettyCashFundId:prepared.pettyCashFundId||'',paidByUserId:prepared.paidByUserId||'',
                paidByName:prepared.paidByName||'',paidOn:prepared.paidOn,reference:'',
                reason:`Initial payment for ${String(data.description||'expense').slice(0,900)}`,
                idempotencyKey:`initial-${createHash('sha256').update(`${co}\u0000${id}`).digest('hex')}`,
                expectedVersion:Number(savedExpense.version),
              },audit,{requireWrite:false});
              savedExpense=(await c.query("SELECT * FROM myfin.expenses WHERE company_id=$1 AND id=$2",[co,id])).rows[0];
              expenseAuditDetails=expenseAuditDetail(id,null,savedExpense);
            }
          } else if (update)
            await c.query(
              "UPDATE myfin.clients SET data=$3 WHERE company_id=$1 AND id=$2",
              [co, id, data],
            );
          else
            await c.query(
              "INSERT INTO myfin.clients(company_id,id,data) VALUES($1,$2,$3)",
              [co, id, data],
            );
        }
        await audit(
          c,
          req.identity,
          co,
          `${update ? "Update" : "Create"} ${name}`,
          name === "products"
            ? `${data.name} · Stock ${data.stock}${data.variants.length ? " · " + data.variants.map((x) => x.name + ": " + x.stock).join(", ") : ""}`
            : name === "expenses" ? expenseAuditDetails : id,
        );
        if(name==="expenses"){
          return (await expenseOutput(c,co,[savedExpense],req.identity))[0];
        }
        return name==="products"?publicProduct(data,req.identity):name==="clients"?publicClient(data,req.identity):data;
      });
    app.post(`/api/companies/:company/${name}`, (req) => save(req, false));
    app.put(`/api/companies/:company/${name}/:id`, (req) => save(req, true));
    app.delete(`/api/companies/:company/${name}/:id`, (req) =>
      scoped(
        req,
        async (c, co) => {
          if(name==="products")requireCapability(req.identity,"inventoryWrite");
          if(name==="clients")requireCapability(req.identity,"clientsWrite");
          if(name==="expenses")requireCapability(req.identity,"expensesRead");
          const id = v.parse(v.id, req.params.id);
          const old = await c.query(
            `SELECT * FROM myfin.${name} WHERE company_id=$1 AND id=$2 FOR UPDATE`,
            [co, id],
          );
          if (!old.rowCount) v.fail(404, "not_found");
          if(name==="expenses"){
            if(old.rows[0].voided_at)v.fail(409,"expense_already_voided");
            if(Number(old.rows[0].paid_amount_sen||0)>0)v.fail(409,"expense_payments_must_be_reversed");
            const approval=v.parse(z.strictObject({reason:z.string().trim().min(3).max(1000),managerCode:z.string().regex(/^\d{6}$/).optional()}),req.body||{});
            if(operator(req.identity)){
              if(!authOptions.pos||!approval.managerCode)v.fail(403,"manager_approval_required");
              const approver=await verifyManagerCode(c,authOptions.pos,co,approval.managerCode,"expensesVoid");
              await c.query("INSERT INTO myfin.action_approvals(id,company_id,actor_id,approver_id,action,subject_type,subject_id,reason) VALUES($1,$2,$3,$4,'void','expense',$5,$6)",[randomUUID(),co,req.identity.id,approver,id,approval.reason]);
            }else requireCapability(req.identity,"expensesVoid");
            const voided=(await c.query("UPDATE myfin.expenses SET voided_at=now(),voided_by=$3,void_reason=$4 WHERE company_id=$1 AND id=$2 RETURNING *",[co,id,req.identity.id,approval.reason])).rows[0];
            await recordExpenseEvent(c,co,req.identity,{expenseId:id,expenseVersion:Number(voided.version),action:"voided",
              from:old.rows[0],to:voided,reason:approval.reason});
            await audit(c,req.identity,co,"Void expense",`${expenseAuditDetail(id,old.rows[0],voided,{voided:true})} · prior version ${old.rows[0].version} · reason ${approval.reason}`);return {ok:true};
          }
          if(name==="transactions")v.fail(409,"financial_history_immutable");
          if(name==="transactions"&&old.rows[0].document_state!=="legacy")v.fail(409,"use_document_workflow");
          if(name==="clients"&&!owner(req.identity)&&old.rows[0].data.type==="Supplier")v.fail(403,"supplier_restricted");
          if (["pos","manual_sale"].includes(old.rows[0].source)) v.fail(409, "posted_sale_immutable");
          await c.query(
            `DELETE FROM myfin.${name} WHERE company_id=$1 AND id=$2`,
            [co, id],
          );
          await audit(c, req.identity, co, `Delete ${name}`, id);
          return { ok: true };
        },
        name !== "expenses",
      ),
    );
  }
  app.post("/api/companies/:company/checkout", (req) =>
    scoped(req, async(c,co)=>{await ensureRequestTerminalStaff(c,req);return checkout(c,req.identity,co,req.body);}),
  );
  app.post("/api/companies/:company/import-products", (req) =>
    scoped(req, async (c, co) => {
      requireCapability(req.identity,"inventoryWrite");
      if(!owner(req.identity)&&containsConfidential(req.body))v.fail(403,"financial_fields_restricted");
      const input=owner(req.identity)?req.body:(req.body||[]).map(p=>({...p,cost:0,variants:(p.variants||[]).map(x=>({...x,cost:0}))}));
      const products = v.parse(z.array(v.product).min(1).max(300), input);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,8))", [
        co,
      ]);
      for (const p of products) {
        if (p.company_id && p.company_id !== co) v.fail(403, "invalid_tenant");
        await validateFileRefs(c, co, p);
        const saved = await saveProduct(
          c,
          co,
          { ...p, id: randomUUID() },
          true,
        );
        if (saved._adjustments.length)
          await c.query(
            "INSERT INTO myfin.stock_movements(company_id,id,actor_id,data) VALUES($1,$2,$3,$4)",
            [
              co,
              randomUUID(),
              req.identity.id,
              {
                action: "Opening stock",
                date: new Date().toISOString(),
                cashierId: req.identity.id,
                movements: saved._adjustments,
              },
            ],
          );
      }
      await audit(
        c,
        req.identity,
        co,
        "Import products",
        String(products.length),
      );
      return { count: products.length };
    }),
  );
  app.post("/api/companies/:company/convert-quote/:id",req=>scoped(req,async()=>{v.fail(409,"use_document_workflow");}));
  app.post("/api/companies/:company/assign-project", (req) =>
    scoped(req, async (c, co) => {
      requireCapability(req.identity,"documentsIssue");
      const data = v.parse(
        z.strictObject({
          ids: z.array(v.id).min(1).max(500),
          projectName: z.string().max(500),
        }),
        req.body,
      );
      const r = await c.query(
        "SELECT * FROM myfin.transactions WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",
        [co, data.ids],
      );
      if (
        r.rowCount !== new Set(data.ids).size
      )
        v.fail(409, "invalid_project_documents");
      if(r.rows.some(row=>["pos","manual_sale"].includes(row.source)||!recordVisible(row,req.identity)||row.document_state==="issued"||row.document_state==="voided"||row.document_state==="corrected"))v.fail(409,"issued_document_immutable");
      for (const x of r.rows)
        await c.query(
          "UPDATE myfin.transactions SET data=$3 WHERE company_id=$1 AND id=$2",
          [co, x.id, { ...x.data, project: data.projectName }],
        );
      await audit(c, req.identity, co, "Assign project", data.projectName);
      return { ok: true };
    }),
  );
}
