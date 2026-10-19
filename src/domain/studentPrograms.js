const clean = value => String(value ?? '').normalize('NFKC').trim();
const MAX_SEN = 9_000_000_000_000_000;

export const STUDENT_STATUSES = Object.freeze(['pending', 'verified', 'rejected', 'revoked']);
export const REDEMPTION_MODES = Object.freeze(['automatic', 'voucher']);

const integer = (value, label, { min = 0, max = Number.MAX_SAFE_INTEGER, nullable = false } = {}) => {
  if (nullable && (value === '' || value === null || value === undefined)) return null;
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`${label} must be a whole number between ${min} and ${max}.`);
  return number;
};

const boolean = value => value === true;

const requiredText = (value, label, min, max) => {
  const result = clean(value);
  if (result.length < min || result.length > max)
    throw new Error(`${label} must contain ${min} to ${max} characters.`);
  return result;
};

const optionalPositiveInteger = (value, label, max = Number.MAX_SAFE_INTEGER) =>
  integer(value, label, { min: 1, max, nullable: true });

const isoTime = (value, label, { nullable = false } = {}) => {
  if (nullable && !clean(value)) return null;
  const parsed = new Date(value);
  if (!clean(value) || Number.isNaN(parsed.getTime())) throw new Error(`${label} must be a valid date and time.`);
  return parsed.toISOString();
};

const unique = (values, key = value => JSON.stringify(value)) => {
  const seen = new Set();
  return values.filter(value => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
};

export function normalizeMaskedReferenceHint(value) {
  const hint = clean(value);
  if (!hint) return '';
  if (!/^\*{3}[A-Za-z0-9._-]{1,8}$/.test(hint))
    throw new Error('Reference hint must contain only *** followed by the final 1 to 8 safe characters.');
  return hint;
}

export function eligibilityStatusLabel(value) {
  return ({ pending:'Pending review', verified:'Verified', rejected:'Rejected', revoked:'Revoked' })[value] || 'Not requested';
}

export function eligibilityActions(row = {}) {
  const status = clean(row.status).toLowerCase();
  if (!status || status === 'unreviewed') return ['pending'];
  if (status === 'pending') return ['verified', 'rejected'];
  if (status === 'verified') return ['verified', 'revoked'];
  if (status === 'rejected' || status === 'revoked') return ['pending'];
  return [];
}

export function studentReviewPayload(input = {}) {
  for (const key of ['document', 'documentData', 'documentUrl', 'rawDocument', 'studentId', 'studentNumber', 'idNumber']) {
    if (Object.hasOwn(input, key)) throw new Error('Student ID documents and raw student numbers must not be entered or uploaded.');
  }
  const status = clean(input.status).toLowerCase();
  if (!STUDENT_STATUSES.includes(status)) throw new Error('Choose a valid student review decision.');
  const payload = {
    expectedVersion: integer(input.expectedVersion ?? 0, 'Eligibility version', { min: 0 }),
    status,
    institutionName: requiredText(input.institutionName, 'Institution name', 2, 160),
    referenceHint: '',
    validUntil: null,
    reason: '',
  };
  if (status === 'verified') {
    payload.referenceHint = normalizeMaskedReferenceHint(input.referenceHint);
    payload.validUntil = isoTime(input.validUntil, 'Eligibility expiry');
  }
  if (status === 'rejected' || status === 'revoked')
    payload.reason = requiredText(input.reason, 'Review reason', 3, 500);
  return payload;
}

export function parseProductTargets(value) {
  const source = Array.isArray(value) ? value : clean(value).split(',');
  return unique(source.filter(item => typeof item === 'object' || clean(item)).map(item => {
    if (item && typeof item === 'object') {
      const productId = requiredText(item.productId ?? item.product_id, 'Product target', 1, 128);
      const variantId = clean(item.variantId ?? item.variant_id) || null;
      if (variantId && variantId.length > 128) throw new Error('Variant target must be 128 characters or fewer.');
      return { productId, variantId:variantId || '' };
    }
    const [product, variant, ...extra] = clean(item).split('/').map(clean);
    if (extra.length || !product) throw new Error('Product targets use product-id or product-id/variant-id.');
    return { productId:requiredText(product, 'Product target', 1, 128), variantId:variant || '' };
  }), item => `${item.productId}\0${item.variantId}`);
}

export function parseCategoryTargets(value) {
  const source = Array.isArray(value) ? value : clean(value).split(',');
  return unique(source.filter(item => typeof item === 'object' || clean(item)).map(item => {
    const rawCategory = item && typeof item === 'object' ? item.category ?? item.categoryKey ?? item.category_key : clean(item).split('/')[0];
    const rawSubcategory = item && typeof item === 'object' ? item.subcategory ?? item.subcategoryKey ?? item.subcategory_key : clean(item).split('/')[1];
    const category = clean(rawCategory).toLocaleLowerCase('en-US');
    const subcategory = clean(rawSubcategory).toLocaleLowerCase('en-US');
    if (!category || category.length > 120 || subcategory.length > 120)
      throw new Error('Category targets require a category of 1 to 120 characters.');
    return { category, subcategory };
  }), item => `${item.category}\0${item.subcategory}`);
}

export function parseCustomerTargets(value) {
  const source = Array.isArray(value) ? value : clean(value).split(',');
  return unique(source.map(item => clean(typeof item === 'object' ? item.customerId ?? item.customer_id : item)).filter(Boolean).map(item =>
    requiredText(item, 'Customer target', 1, 128)));
}

export function promotionPayload(input = {}) {
  const redemptionMode = clean(input.redemptionMode).toLowerCase();
  const discountType = clean(input.discountType).toLowerCase();
  if (!REDEMPTION_MODES.includes(redemptionMode)) throw new Error('Choose automatic or voucher redemption.');
  if (!['percentage', 'fixed'].includes(discountType)) throw new Error('Choose a percentage or fixed discount.');
  const validFrom = isoTime(input.validFrom, 'Promotion start');
  const validUntil = isoTime(input.validUntil, 'Promotion expiry', { nullable:true });
  if (validUntil && new Date(validUntil) <= new Date(validFrom)) throw new Error('Promotion expiry must be after its start.');
  const requiresStudent = boolean(input.requiresStudent);
  const payload = {
    expectedVersion: integer(input.expectedVersion ?? 0, 'Promotion version', { min: 0 }),
    name: requiredText(input.name, 'Promotion name', 1, 160),
    enabled: boolean(input.enabled),
    redemptionMode,
    validFrom,
    validUntil,
    discountType,
    discountBasisPoints: null,
    discountSen: null,
    maxDiscountSen: optionalPositiveInteger(input.maxDiscountSen, 'Maximum discount', MAX_SEN),
    minSubtotalSen: integer(input.minSubtotalSen ?? 0, 'Minimum subtotal', { min: 0, max:MAX_SEN }),
    maxTotalRedemptions: optionalPositiveInteger(input.maxTotalRedemptions, 'Maximum redemptions'),
    perCustomerLimit: optionalPositiveInteger(input.perCustomerLimit, 'Per-customer limit', 1_000_000),
    requiresCustomer: requiresStudent || boolean(input.requiresCustomer),
    requiresStudent,
    stackable: boolean(input.stackable),
    priority: integer(input.priority ?? 0, 'Priority', { min:-1_000_000, max:1_000_000 }),
    productTargets: parseProductTargets(input.productTargets ?? []),
    categoryTargets: parseCategoryTargets(input.categoryTargets ?? []),
    customerTargets: parseCustomerTargets(input.customerTargets ?? []),
  };
  if (discountType === 'percentage')
    payload.discountBasisPoints = integer(input.discountBasisPoints, 'Discount basis points', { min:1, max:10_000 });
  else payload.discountSen = integer(input.discountSen, 'Fixed discount', { min:1, max:MAX_SEN });
  if (payload.perCustomerLimit && payload.maxTotalRedemptions
      && payload.perCustomerLimit > payload.maxTotalRedemptions)
    throw new Error('Per-customer limit cannot exceed maximum redemptions.');
  return payload;
}

export function voucherPayload(input = {}, { creating = false } = {}) {
  const validFrom = isoTime(input.validFrom, 'Voucher start');
  const validUntil = isoTime(input.validUntil, 'Voucher expiry', { nullable:true });
  if (validUntil && new Date(validUntil) <= new Date(validFrom)) throw new Error('Voucher expiry must be after its start.');
  const payload = {
    expectedVersion: creating ? 0 : integer(input.expectedVersion ?? 0, 'Voucher version', { min: 0 }),
    enabled: boolean(input.enabled),
    validFrom,
    validUntil,
    maxRedemptions: optionalPositiveInteger(input.maxRedemptions, 'Maximum voucher redemptions'),
    perCustomerLimit: optionalPositiveInteger(input.perCustomerLimit, 'Voucher per-customer limit', 1_000_000),
  };
  if (payload.perCustomerLimit && payload.maxRedemptions
      && payload.perCustomerLimit > payload.maxRedemptions)
    throw new Error('Voucher per-customer limit cannot exceed maximum uses.');
  if (creating) {
    const code = requiredText(input.code, 'Voucher code', 3, 32).toLocaleUpperCase('en-US');
    if (!/^[A-Z0-9](?:[A-Z0-9-]{1,30}[A-Z0-9])$/.test(code))
      throw new Error('Voucher codes must start and end with a letter or number and may contain hyphens.');
    payload.code = code;
  }
  if (clean(input.campaignId)) payload.campaignId = clean(input.campaignId);
  return payload;
}

export function senFromRinggit(value, label = 'Amount', { nullable = false } = {}) {
  if (nullable && (value === '' || value === null || value === undefined)) return null;
  const text = clean(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`${label} must use at most two decimal places.`);
  const [whole, fraction = ''] = text.split('.');
  const result = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
  if (!Number.isSafeInteger(result) || result > MAX_SEN) throw new Error(`${label} is too large.`);
  return result;
}

export function ringgitFromSen(value) {
  if (value === null || value === undefined || value === '') return '';
  const sen = integer(Number(value), 'Amount', { min:0, max:MAX_SEN });
  return `${Math.floor(sen / 100)}.${String(sen % 100).padStart(2, '0')}`;
}
