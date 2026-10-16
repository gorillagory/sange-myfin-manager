import { createHash, createHmac } from 'node:crypto';

const MAX_SEN = 9_000_000_000_000_000;
const statuses = new Set(['pending', 'verified', 'rejected', 'revoked']);
const verificationMethods = new Set(['staff_attestation', 'institution_email', 'external_provider']);
const promotionKeys = new Set([
  'id', 'version', 'name', 'enabled', 'redemptionMode', 'validFrom', 'validUntil',
  'discountType', 'discountBasisPoints', 'discountSen', 'maxDiscountSen', 'minSubtotalSen',
  'rewardProductId', 'rewardVariantId', 'rewardQuantityMilli',
  'maxTotalRedemptions', 'perCustomerLimit', 'requiresCustomer', 'requiresStudent',
  'priority', 'stackable', 'productTargets', 'categoryTargets', 'customerTargets', 'usage', 'voucher',
]);
const studentChangeKeys = new Set([
  'workspaceId', 'customerId', 'status', 'institutionName', 'verificationMethod',
  'referenceDigest', 'referenceHint', 'validFrom', 'validUntil', 'reason', 'expectedVersion',
]);

function fail(message) {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

function object(value, message = 'invalid_input') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(message);
  return value;
}

function strictKeys(value, allowed, message = 'invalid_input') {
  object(value, message);
  if (Object.keys(value).some(key => !allowed.has(key))) fail(message);
}

function array(value, message = 'invalid_input') {
  if (!Array.isArray(value)) fail(message);
  return value;
}

function boundedArray(value, max, message = 'invalid_input') {
  const result = array(value, message);
  if (result.length > max) fail(message);
  return result;
}

function boolean(value, message = 'invalid_input') {
  if (typeof value !== 'boolean') fail(message);
  return value;
}

function text(value, { min = 0, max = 128, pattern, message = 'invalid_input' } = {}) {
  if (typeof value !== 'string') fail(message);
  const result = value.trim();
  if (result.length < min || result.length > max || (pattern && !pattern.test(result))) fail(message);
  return result;
}

function integer(value, { min = 0, max = Number.MAX_SAFE_INTEGER, nullable = false, message = 'invalid_input' } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(message);
  return value;
}

function instant(value, { nullable = false, message = 'invalid_input' } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string') fail(message);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !value.includes('T')) fail(message);
  return date.toISOString();
}

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;

const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function roundedRatio(numerator, denominator) {
  const whole = numerator / denominator;
  const remainder = numerator % denominator;
  return whole + (remainder * 2n >= denominator ? 1n : 0n);
}

function safeNumber(value, message = 'amount_too_large') {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_SEN) fail(message);
  return result;
}

function key(value) {
  return String(value || '').trim().toLowerCase();
}

export function normalizeVoucherCode(value) {
  if (typeof value !== 'string' || value !== value.normalize('NFKC')) fail('invalid_voucher_code');
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9](?:[A-Z0-9-]{4,30}[A-Z0-9])$/.test(normalized)) fail('invalid_voucher_code');
  return normalized;
}

// Codes are bearer credentials. Store only an HMAC lookup digest and a short
// display hint; a plain SHA-256 digest would permit cheap dictionary attacks.
export function voucherLookupDigest(pepper, code) {
  if (typeof pepper !== 'string' || pepper.length < 32) fail('voucher_pepper_required');
  return createHmac('sha256', pepper).update(normalizeVoucherCode(code)).digest('hex');
}

export function studentEligibilityAt(eligibility, at = new Date().toISOString()) {
  const checkedAt = instant(at, { message: 'invalid_eligibility_time' });
  if (!eligibility || eligibility.status !== 'verified') return { eligible: false, reason: 'not_verified' };
  const validFrom = instant(eligibility.validFrom, { message: 'invalid_student_eligibility' });
  const validUntil = instant(eligibility.validUntil, { message: 'invalid_student_eligibility' });
  if (validUntil <= validFrom) fail('invalid_student_eligibility');
  if (checkedAt < validFrom) return { eligible: false, reason: 'not_yet_valid' };
  if (checkedAt >= validUntil) return { eligible: false, reason: 'expired' };
  return { eligible: true, reason: 'verified', version: integer(eligibility.version, { min: 1 }) };
}

export function normalizeStudentEligibilityChange(input, current = null, at = new Date().toISOString()) {
  strictKeys(input, studentChangeKeys, 'invalid_student_eligibility');
  const checkedAt = instant(at, { message: 'invalid_eligibility_time' });
  const status = text(input.status, { min: 1, max: 16, message: 'invalid_student_eligibility' });
  if (!statuses.has(status)) fail('invalid_student_eligibility');
  const expectedVersion = integer(input.expectedVersion, { min: 0, max: Number.MAX_SAFE_INTEGER });
  const previous = current?.status || null;
  const previousVersion = Number(current?.version || 0);
  if (previous && !statuses.has(previous)) fail('invalid_student_eligibility');
  if (previousVersion !== expectedVersion) fail('student_eligibility_changed');
  const expiredVerified = previous === 'verified' && current?.validUntil && checkedAt >= instant(current.validUntil);
  const allowed = previous === null ? ['pending']
    : previous === 'pending' ? ['verified', 'rejected']
      : previous === 'verified' ? (expiredVerified ? ['pending', 'verified', 'revoked'] : ['verified', 'revoked'])
        : ['pending'];
  if (!allowed.includes(status)) fail('invalid_student_eligibility_transition');
  const institutionName = text(input.institutionName, { min: 2, max: 160, message: 'invalid_student_eligibility' });
  const reason = text(input.reason || '', { max: 500, message: 'invalid_student_eligibility' });
  const referenceHint = text(input.referenceHint || '', {
    max: 11, pattern: /^(?:|\*{3}[A-Za-z0-9._-]{1,8})$/, message: 'invalid_student_reference_hint',
  });
  if (status === 'verified') {
    const verificationMethod = text(input.verificationMethod, { min: 1, max: 40, message: 'verification_method_required' });
    if (!verificationMethods.has(verificationMethod)) fail('invalid_verification_method');
    const referenceDigest = text(input.referenceDigest, {
      min: 64, max: 64, pattern: /^[0-9a-f]{64}$/, message: 'verification_reference_digest_required',
    });
    const validFrom = instant(input.validFrom, { message: 'student_validity_required' });
    const validUntil = instant(input.validUntil, { message: 'student_validity_required' });
    if (validUntil <= validFrom || validUntil <= checkedAt) fail('invalid_student_validity');
    return { workspaceId: text(input.workspaceId, { min: 1 }), customerId: text(input.customerId, { min: 1 }),
      status, institutionName, verificationMethod, referenceDigest, referenceHint,
      validFrom, validUntil, reason, expectedVersion, version: expectedVersion + 1 };
  }
  if ((status === 'rejected' || status === 'revoked') && reason.length < 3) fail('student_decision_reason_required');
  if (input.referenceDigest || input.validFrom || input.validUntil || input.verificationMethod)
    fail('student_evidence_only_allowed_for_verified');
  return { workspaceId: text(input.workspaceId, { min: 1 }), customerId: text(input.customerId, { min: 1 }),
    status, institutionName, verificationMethod: '', referenceDigest: '', referenceHint,
    validFrom: null, validUntil: null, reason, expectedVersion, version: expectedVersion + 1 };
}

function normalizeTarget(target, type) {
  object(target, 'invalid_promotion_target');
  const allowed = type === 'product' ? new Set(['productId', 'variantId']) : new Set(['category', 'subcategory']);
  strictKeys(target, allowed, 'invalid_promotion_target');
  return type === 'product'
    ? { productId: text(target.productId, { min: 1 }), variantId: text(target.variantId || '', { max: 128 }) }
    : { category: key(text(target.category, { min: 1, max: 120 })), subcategory: key(text(target.subcategory || '', { max: 120 })) };
}

function normalizeUsage(input = {}) {
  strictKeys(input, new Set(['total', 'customer']), 'invalid_promotion_usage');
  return { total: integer(input.total ?? 0), customer: integer(input.customer ?? 0) };
}

export function normalizePromotion(input) {
  strictKeys(input, promotionKeys, 'invalid_promotion');
  const id = text(input.id, { min: 1 });
  const version = integer(input.version, { min: 1 });
  const name = text(input.name, { min: 1, max: 160 });
  const enabled = boolean(input.enabled, 'invalid_promotion');
  const redemptionMode = input.redemptionMode;
  if (!['automatic', 'voucher'].includes(redemptionMode)) fail('invalid_promotion');
  const validFrom = instant(input.validFrom, { message: 'invalid_promotion_validity' });
  const validUntil = instant(input.validUntil, { nullable: true, message: 'invalid_promotion_validity' });
  if (validUntil && validUntil <= validFrom) fail('invalid_promotion_validity');
  const discountType = input.discountType;
  if (!['percentage', 'fixed', 'free_item'].includes(discountType)) fail('invalid_promotion_discount');
  const discountBasisPoints = discountType === 'percentage'
    ? integer(input.discountBasisPoints, { min: 1, max: 10000, message: 'invalid_promotion_discount' }) : null;
  const discountSen = discountType === 'fixed'
    ? integer(input.discountSen, { min: 1, max: MAX_SEN, message: 'invalid_promotion_discount' }) : null;
  if ((discountType === 'percentage' && input.discountSen != null)
    || (discountType === 'fixed' && input.discountBasisPoints != null)
    || (discountType === 'free_item' && (input.discountBasisPoints != null || input.discountSen != null)))
    fail('invalid_promotion_discount');
  const maxDiscountSen = integer(input.maxDiscountSen, { min: 1, max: MAX_SEN, nullable: true });
  const rewardProductId = discountType === 'free_item'
    ? text(input.rewardProductId, { min: 1, message: 'invalid_free_item_reward' }) : '';
  const rewardVariantId = discountType === 'free_item'
    ? text(input.rewardVariantId || '', { max: 128, message: 'invalid_free_item_reward' }) : '';
  const rewardQuantityMilli = discountType === 'free_item'
    ? integer(input.rewardQuantityMilli, { min: 1, max: 1_000_000_000, message: 'invalid_free_item_reward' }) : null;
  if (discountType === 'free_item' && maxDiscountSen !== null) fail('invalid_free_item_reward');
  if (discountType !== 'free_item' && (input.rewardProductId || input.rewardVariantId || input.rewardQuantityMilli != null))
    fail('invalid_free_item_reward');
  const maxTotalRedemptions = integer(input.maxTotalRedemptions, { min: 1, nullable: true });
  const perCustomerLimit = integer(input.perCustomerLimit, { min: 1, nullable: true });
  const requiresStudent = boolean(input.requiresStudent ?? false, 'invalid_promotion');
  const requiresCustomer = boolean(input.requiresCustomer ?? false, 'invalid_promotion')
    || perCustomerLimit !== null || requiresStudent;
  const rawCustomerTargets = boundedArray(input.customerTargets || [], 1000, 'invalid_promotion_target');
  const customerTargets = [...new Set(rawCustomerTargets.map(value => text(value, { min: 1 })))].sort();
  const productTargets = boundedArray(input.productTargets || [], 1000, 'invalid_promotion_target').map(value => normalizeTarget(value, 'product'));
  const categoryTargets = boundedArray(input.categoryTargets || [], 1000, 'invalid_promotion_target').map(value => normalizeTarget(value, 'category'));
  if (customerTargets.length && input.customerTargets.length !== customerTargets.length) fail('duplicate_promotion_customer');
  if (new Set(productTargets.map(target => `${target.productId}\u0000${target.variantId}`)).size !== productTargets.length)
    fail('duplicate_promotion_product');
  if (new Set(categoryTargets.map(target => `${target.category}\u0000${target.subcategory}`)).size !== categoryTargets.length)
    fail('duplicate_promotion_category');
  const voucher = input.voucher == null ? null : normalizeVoucher(input.voucher);
  if ((redemptionMode === 'voucher') !== Boolean(voucher)) fail('voucher_selection_required');
  return { id, version, name, enabled, redemptionMode, validFrom, validUntil,
    discountType, discountBasisPoints, discountSen, maxDiscountSen,
    rewardProductId, rewardVariantId, rewardQuantityMilli,
    minSubtotalSen: integer(input.minSubtotalSen ?? 0, { max: MAX_SEN }),
    maxTotalRedemptions, perCustomerLimit, requiresCustomer, requiresStudent,
    priority: integer(input.priority ?? 0, { min: -1000000, max: 1000000 }),
    stackable: boolean(input.stackable, 'invalid_promotion'), productTargets, categoryTargets, customerTargets,
    usage: normalizeUsage(input.usage), voucher };
}

function normalizeVoucher(input) {
  strictKeys(input, new Set([
    'id', 'version', 'enabled', 'validFrom', 'validUntil', 'maxRedemptions', 'perCustomerLimit', 'usage',
  ]), 'invalid_voucher');
  const validFrom = instant(input.validFrom, { message: 'invalid_voucher_validity' });
  const validUntil = instant(input.validUntil, { nullable: true, message: 'invalid_voucher_validity' });
  if (validUntil && validUntil <= validFrom) fail('invalid_voucher_validity');
  return { id: text(input.id, { min: 1 }), version: integer(input.version, { min: 1 }),
    enabled: boolean(input.enabled, 'invalid_voucher'), validFrom, validUntil,
    maxRedemptions: integer(input.maxRedemptions, { min: 1, nullable: true }),
    perCustomerLimit: integer(input.perCustomerLimit, { min: 1, nullable: true }),
    usage: normalizeUsage(input.usage) };
}

function promotionActive(promotion, at, customerId, student) {
  if (!promotion.enabled || at < promotion.validFrom || (promotion.validUntil && at >= promotion.validUntil)) return false;
  if ((promotion.requiresCustomer || promotion.customerTargets.length) && !customerId) return false;
  if (promotion.customerTargets.length && !promotion.customerTargets.includes(customerId)) return false;
  if (promotion.requiresStudent && !student.eligible) return false;
  if (promotion.maxTotalRedemptions !== null && promotion.usage.total >= promotion.maxTotalRedemptions) return false;
  if (promotion.perCustomerLimit !== null && promotion.usage.customer >= promotion.perCustomerLimit) return false;
  if (promotion.voucher) {
    const voucher = promotion.voucher;
    if (!voucher.enabled || at < voucher.validFrom || (voucher.validUntil && at >= voucher.validUntil)) return false;
    if (voucher.maxRedemptions !== null && voucher.usage.total >= voucher.maxRedemptions) return false;
    if (voucher.perCustomerLimit !== null && (!customerId || voucher.usage.customer >= voucher.perCustomerLimit)) return false;
  }
  return true;
}

function eligibleLine(promotion, line) {
  const hasTargets = promotion.productTargets.length || promotion.categoryTargets.length;
  if (!hasTargets) return true;
  return promotion.productTargets.some(target => target.productId === line.productId
      && (!target.variantId || target.variantId === line.variantId))
    || promotion.categoryTargets.some(target => target.category === key(line.category)
      && (!target.subcategory || target.subcategory === key(line.subcategory)));
}

function allocate(discount, indexes, remaining) {
  if (!discount) return indexes.map(index => ({ index, amount: 0 }));
  const total = indexes.reduce((sum, index) => sum + BigInt(remaining[index]), 0n);
  if (!total) return [];
  const target = BigInt(discount);
  const rows = indexes.map(index => {
    const numerator = target * BigInt(remaining[index]);
    return { index, amount: numerator / total, remainder: numerator % total };
  });
  let left = target - rows.reduce((sum, row) => sum + row.amount, 0n);
  rows.sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (let i = 0; left > 0n; i++, left--) rows[i % rows.length].amount++;
  return rows.map(row => ({ index: row.index, amount: safeNumber(row.amount) }));
}

export function priceWithPromotions({
  lines, promotions = [], customerId = '', studentEligibility = null,
  at = new Date().toISOString(), currencyCode = 'MYR', taxBasisPoints = 0, cashRounding = false,
  automaticRewards = [],
}) {
  const pricedAt = instant(at, { message: 'invalid_pricing_time' });
  if (!Array.isArray(lines) || !lines.length || lines.length > 500) fail('invalid_pricing_lines');
  if (!/^[A-Z]{3}$/.test(currencyCode)) fail('invalid_currency');
  integer(taxBasisPoints, { min: 0, max: 10000, message: 'invalid_tax_rate' });
  boolean(cashRounding, 'invalid_cash_rounding');
  const normalizedLines = lines.map((line, index) => {
    strictKeys(line, new Set(['lineNo', 'productId', 'variantId', 'category', 'subcategory', 'description', 'quantityMilli', 'unitPriceSen']), 'invalid_pricing_line');
    const lineNo = integer(line.lineNo ?? index + 1, { min: 1, max: 500 });
    const quantityMilli = integer(line.quantityMilli, { min: 1, max: 1_000_000_000 });
    const unitPriceSen = integer(line.unitPriceSen, { max: MAX_SEN });
    const grossSen = safeNumber(roundedRatio(BigInt(unitPriceSen) * BigInt(quantityMilli), 1000n));
    return { lineNo, productId: text(line.productId, { min: 1 }), variantId: text(line.variantId || '', { max: 128 }),
      category: text(line.category || '', { max: 120 }), subcategory: text(line.subcategory || '', { max: 120 }),
      description: text(line.description || '', { min: 1, max: 500 }), quantityMilli, unitPriceSen, grossSen };
  });
  if (new Set(normalizedLines.map(line => line.lineNo)).size !== normalizedLines.length) fail('duplicate_pricing_line');
  // A reward added by the pricing engine must never make its own campaign meet
  // a minimum-spend threshold. Keep the qualifying subtotal fixed to the
  // products the cashier/customer actually selected.
  const qualifyingSubtotalSen = normalizedLines.reduce(
    (sum, line) => safeNumber(BigInt(sum) + BigInt(line.grossSen)), 0,
  );
  const customer = customerId ? text(customerId, { min: 1 }) : '';
  const student = studentEligibilityAt(studentEligibility, pricedAt);
  const normalizedPromotions = boundedArray(promotions, 100, 'too_many_promotions').map(normalizePromotion);
  if (new Set(normalizedPromotions.map(p => p.id)).size !== normalizedPromotions.length) fail('duplicate_promotion');
  normalizedPromotions.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const rewardCatalog = new Map(boundedArray(automaticRewards, 100, 'too_many_automatic_rewards').map(raw => {
    strictKeys(raw, new Set([
      'promotionId', 'productId', 'variantId', 'category', 'subcategory', 'description', 'unitPriceSen',
    ]), 'invalid_automatic_reward');
    const promotionId = text(raw.promotionId, { min: 1 });
    return [promotionId, {
      productId: text(raw.productId, { min: 1 }),
      variantId: text(raw.variantId || '', { max: 128 }),
      category: text(raw.category || '', { max: 120 }),
      subcategory: text(raw.subcategory || '', { max: 120 }),
      description: text(raw.description || '', { min: 1, max: 500 }),
      unitPriceSen: integer(raw.unitPriceSen, { max: MAX_SEN }),
    }];
  }));
  if (rewardCatalog.size !== automaticRewards.length) fail('duplicate_automatic_reward');
  const remaining = normalizedLines.map(line => line.grossSen);
  const remainingQuantity = normalizedLines.map(line => line.quantityMilli);
  const automaticRewardLineNos = new Set();
  const applications = [];
  for (const promotion of normalizedPromotions) {
    if (applications.length && !promotion.stackable) continue;
    if (!promotionActive(promotion, pricedAt, customer, student)
        || qualifyingSubtotalSen < promotion.minSubtotalSen) continue;
    const indexes = normalizedLines.map((line, index) => eligibleLine(promotion, line) && remaining[index] > 0 ? index : -1).filter(index => index >= 0);
    let discountSen;
    let lineDiscounts;
    if (promotion.discountType === 'free_item') {
      if ((promotion.productTargets.length || promotion.categoryTargets.length) && !indexes.length) continue;
      let quantityLeft = promotion.rewardQuantityMilli;
      lineDiscounts = [];
      for (let index = 0; index < normalizedLines.length && quantityLeft > 0; index++) {
        const line = normalizedLines[index];
        if (line.productId !== promotion.rewardProductId || line.variantId !== promotion.rewardVariantId
            || remaining[index] <= 0 || remainingQuantity[index] <= 0) continue;
        const rewardedQuantity = Math.min(remainingQuantity[index], quantityLeft);
        const amount = Math.min(remaining[index], safeNumber(roundedRatio(
          BigInt(remaining[index]) * BigInt(rewardedQuantity), BigInt(remainingQuantity[index]),
        )));
        if (amount > 0) {
          lineDiscounts.push({ index, amount });
          remainingQuantity[index] -= rewardedQuantity;
          quantityLeft -= rewardedQuantity;
        }
      }
      if (quantityLeft > 0 && rewardCatalog.has(promotion.id)) {
        const reward = rewardCatalog.get(promotion.id);
        if (reward.productId !== promotion.rewardProductId || reward.variantId !== promotion.rewardVariantId)
          fail('invalid_automatic_reward');
        if (normalizedLines.length >= 500) fail('too_many_pricing_lines');
        const occupied = new Set(normalizedLines.map(line => line.lineNo));
        let lineNo = 1;
        while (occupied.has(lineNo) && lineNo <= 500) lineNo++;
        if (lineNo > 500) fail('too_many_pricing_lines');
        const quantityMilli = quantityLeft;
        const grossSen = safeNumber(roundedRatio(
          BigInt(reward.unitPriceSen) * BigInt(quantityMilli), 1000n,
        ));
        if (!grossSen) continue;
        normalizedLines.push({ ...reward, lineNo, quantityMilli, grossSen });
        remaining.push(grossSen);
        remainingQuantity.push(0);
        automaticRewardLineNos.add(lineNo);
        lineDiscounts.push({ index: normalizedLines.length - 1, amount: grossSen });
        quantityLeft = 0;
      }
      discountSen = lineDiscounts.reduce((sum, line) => safeNumber(BigInt(sum) + BigInt(line.amount)), 0);
      if (!discountSen) continue;
    } else {
      const eligibleSen = indexes.reduce((sum, index) => sum + remaining[index], 0);
      if (!eligibleSen) continue;
      discountSen = promotion.discountType === 'fixed' ? promotion.discountSen
        : safeNumber(roundedRatio(BigInt(eligibleSen) * BigInt(promotion.discountBasisPoints), 10000n));
      if (promotion.maxDiscountSen !== null) discountSen = Math.min(discountSen, promotion.maxDiscountSen);
      discountSen = Math.min(discountSen, eligibleSen);
      if (!discountSen) continue;
      lineDiscounts = allocate(discountSen, indexes, remaining);
    }
    for (const row of lineDiscounts) remaining[row.index] -= row.amount;
    applications.push({ promotionId: promotion.id, promotionVersion: promotion.version,
      name: promotion.name, voucherId: promotion.voucher?.id || '', voucherVersion: promotion.voucher?.version || null,
      discountSen, lineDiscounts: lineDiscounts.filter(row => row.amount > 0)
        .map(row => ({ lineNo: normalizedLines[row.index].lineNo, discountSen: row.amount })) });
    if (!promotion.stackable) break;
  }
  const subtotalSen = normalizedLines.reduce(
    (sum, line) => safeNumber(BigInt(sum) + BigInt(line.grossSen)), 0,
  );
  const discountSen = applications.reduce((sum, item) => sum + item.discountSen, 0);
  const taxableSen = subtotalSen - discountSen;
  const taxSen = safeNumber(roundedRatio(BigInt(taxableSen) * BigInt(taxBasisPoints), 10000n));
  const totalBeforeRoundingSen = safeNumber(BigInt(taxableSen) + BigInt(taxSen));
  const remainder = totalBeforeRoundingSen % 5;
  const roundingSen = cashRounding && remainder ? (remainder <= 2 ? -remainder : 5 - remainder) : 0;
  const totalSen = totalBeforeRoundingSen + roundingSen;
  const outputLines = normalizedLines.map((line, index) => ({ ...line,
    automaticReward: automaticRewardLineNos.has(line.lineNo),
    discountSen: line.grossSen - remaining[index], netSen: remaining[index] }));
  const digestPromotions = normalizedPromotions.map(({ usage, voucher, ...rule }) => ({ ...rule,
    voucher: voucher ? (({ usage: voucherUsage, ...voucherRule }) => voucherRule)(voucher) : null }));
  const rulesDigest = digest({ pricedAt, currencyCode, customerId: customer,
    studentEligibilityVersion: student.eligible ? student.version : null,
    lines: outputLines.map(({ discountSen: _discountSen, netSen: _netSen, ...line }) => line),
    promotions: digestPromotions, taxBasisPoints, cashRounding });
  return { pricedAt, currencyCode, customerId: customer, studentEligibilityVersion: student.eligible ? student.version : null,
    subtotalSen, discountSen, taxableSen, taxSen, totalBeforeRoundingSen, roundingSen, totalSen,
    lines: outputLines, applications, rulesDigest };
}

export async function recordPromotionRedemption(c, input) {
  strictKeys(input, new Set([
    'workspaceId', 'companyId', 'id', 'promotionId', 'promotionVersion', 'voucherId', 'voucherVersion',
    'pricingSnapshotId', 'customerId', 'sourceType', 'sourceId', 'idempotencyKey', 'requestDigest',
    'discountSen', 'occurredAt',
  ]), 'invalid_promotion_redemption');
  const sourceType = input.sourceType;
  if (!['customer_order', 'pos_sale', 'invoice'].includes(sourceType)) fail('invalid_promotion_redemption');
  const voucherId = input.voucherId ? text(input.voucherId, { min: 1 }) : null;
  const voucherVersion = voucherId ? integer(input.voucherVersion, { min: 1 }) : null;
  if (!voucherId && input.voucherVersion != null) fail('invalid_promotion_redemption');
  const values = [text(input.workspaceId, { min: 1 }), text(input.companyId, { min: 1 }),
    text(input.id, { min: 1 }), text(input.promotionId, { min: 1 }), integer(input.promotionVersion, { min: 1 }),
    voucherId, voucherVersion, text(input.pricingSnapshotId, { min: 1 }),
    input.customerId ? text(input.customerId, { min: 1 }) : null, sourceType, text(input.sourceId, { min: 1 }),
    text(input.idempotencyKey, { min: 8, max: 128 }),
    text(input.requestDigest, { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/ }),
    integer(input.discountSen, { min: 1, max: MAX_SEN }), instant(input.occurredAt)];
  return (await c.query(`INSERT INTO myfin.promotion_redemptions(
      workspace_id,company_id,id,promotion_id,promotion_version,voucher_id,voucher_version,pricing_snapshot_id,
      customer_id,source_type,source_id,idempotency_key,request_digest,discount_sen,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, values)).rows[0];
}
