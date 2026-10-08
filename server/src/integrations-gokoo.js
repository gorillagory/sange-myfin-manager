import { defineCommerceChannel, INTEGRATION_KINDS } from './integrations-contracts.js';

export const GOKOO_MALAYSIA = defineCommerceChannel({
  key: 'gokoo',
  displayName: 'Gokoo / 悟空海外',
  kind: INTEGRATION_KINDS.COMMERCE_CHANNEL,
  countryCode: 'MY',
  currencyCode: 'MYR',
  identityStatus: 'candidate_awaiting_confirmation',
  activationAllowed: false,
  capabilities: {
    merchantAuthorization: 'documented',
    catalog: 'documented',
    availability: 'documented',
    orders: 'documented',
    orderLifecycle: 'documented',
    providerFinanceEvidence: 'documented',
    paymentGateway: 'not_established',
  },
});

const financialFields = Object.freeze({
  order_total_amount: ['orderTotal', 'order_total'],
  products_total_price: ['productsTotal', 'products_total'],
  user_delivery_fee: ['userDeliveryFee', 'delivery_fee'],
  shop_subsidy_amount: ['merchantSubsidy', 'merchant_subsidy'],
  shop_reduce_freight: ['merchantDeliverySubsidy', 'merchant_subsidy'],
  platform_subsidy_amount: ['platformSubsidy', 'platform_subsidy'],
  platform_reduce_freight: ['platformDeliverySubsidy', 'platform_subsidy'],
  sst_amount: ['sst', 'tax'],
  user_pay_amount: ['customerPaid', 'customer_paid'],
  platform_expenses: ['platformExpenses', 'platform_expense'],
  platform_fee_amount: ['serviceFee', 'service_fee'],
  platform_fee_amount_with_sst: ['serviceFeeWithSst', 'service_fee_tax_inclusive'],
  shop_revenue_amount: ['merchantReceivable', 'merchant_receivable'],
  staff_amount: ['riderCommission', 'rider_commission'],
  shop_real_revenue_amount: ['merchantActualReceivable', 'merchant_actual_receivable'],
  delivery_amount: ['deliveryAmount', 'delivery_fee'],
});

const callbackStatuses = Object.freeze({
  WAIT_MERCHANT_CONFIRM: 'awaiting_acceptance',
  WAIT_DRIVER_CONFIRM: 'awaiting_driver',
  MERCHANT_CONFIRMED: 'accepted',
  DRIVER_CONFIRMED: 'driver_assigned',
  DRIVER_ARRIVED: 'driver_arrived',
  DRIVER_DELIVERING: 'out_for_delivery',
  DRIVER_DELIVERED: 'delivered',
  WAIT_COMMENT: 'completed',
  MERCHANT_DELIVERING: 'out_for_delivery',
  MERCHANT_DELIVERED: 'delivered',
  ORDER_DONE: 'completed',
  ORDER_REFUNDED: 'refunded',
  ORDER_CANCEL: 'cancelled',
});

export function decimalStringToSen(value, { allowNegative = false } = {}) {
  if (typeof value !== 'string') throw new TypeError('money_string_required');
  const input = value.trim();
  const match = /^(-?)(\d{1,13})(?:\.(\d{1,2}))?$/.exec(input);
  if (!match || (!allowNegative && match[1])) throw new RangeError('invalid_money_amount');
  const sen = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'));
  const signed = match[1] ? -sen : sen;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER))
    throw new RangeError('money_amount_out_of_range');
  return Number(signed);
}

export function mapGokooPaymentCode(value) {
  const code = String(value || '').trim().toLowerCase();
  const methods = { wxpay: 'wechat_pay', ksher_alipay: 'alipay', money: 'gokoo_balance', cash: 'cash' };
  return {
    providerCode: code,
    method: methods[code] || 'unknown',
    paymentProviderEvidence: false,
    accountingEffect: 'none',
  };
}

export function mapGokooOrderStatus(value) {
  const providerStatus = String(value || '').trim().toUpperCase();
  return { providerStatus, status: callbackStatuses[providerStatus] || 'unknown' };
}

function financeItems(payload) {
  const items = Array.isArray(payload) ? payload : payload?.data?.items;
  if (!Array.isArray(items)) throw new TypeError('gokoo_financial_items_required');
  return items;
}

export function normalizeGokooMalaysiaFinancials(payload, { currencyCode } = {}) {
  if (currencyCode !== 'MYR') throw new RangeError('explicit_myr_currency_required');
  const entries = [], amountsSen = {}, unknownFields = [], ambiguousFields = [];
  const seen = new Set();
  const visit = item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('invalid_gokoo_financial_item');
    const field = typeof item.fields === 'string' ? item.fields.trim() : '';
    if (field) {
      if (seen.has(field)) throw new RangeError('duplicate_gokoo_financial_field');
      seen.add(field);
      const mapping = financialFields[field];
      if (mapping) {
        const amountSen = decimalStringToSen(item.amount);
        const [name, entryType] = mapping;
        amountsSen[name] = amountSen;
        entries.push({ providerField: field, entryType, amountSen });
      } else if (field === 'platform_commission_ratio') {
        if (typeof item.amount !== 'string' || item.amount.length > 80) throw new TypeError('invalid_gokoo_commission_evidence');
        ambiguousFields.push({
          providerField: field,
          rawValue: item.amount,
          reason: 'field_name_indicates_ratio_but_documentation_labels_value_as_amount',
        });
      } else unknownFields.push(field);
    }
    if (item.items !== undefined) {
      if (!Array.isArray(item.items)) throw new TypeError('invalid_gokoo_financial_children');
      for (const child of item.items) visit(child);
    }
  };
  for (const item of financeItems(payload)) visit(item);
  return {
    provider: 'gokoo',
    countryCode: 'MY',
    currencyCode,
    amountsSen,
    entries,
    unknownFields,
    ambiguousFields,
    accountingEffect: 'none',
  };
}

export function normalizeGokooMalaysiaOrder(payload, { currencyCode } = {}) {
  if (currencyCode !== 'MYR') throw new RangeError('explicit_myr_currency_required');
  const data = payload?.data ?? payload;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('gokoo_order_required');
  const externalOrderId = String(data.order_id ?? '').trim();
  const externalMerchantId = String(data.shop_id ?? '').trim();
  if (!externalOrderId || !externalMerchantId) throw new TypeError('gokoo_order_identity_required');
  return {
    provider: 'gokoo',
    countryCode: 'MY',
    currencyCode,
    externalOrderId,
    externalOrderNumber: String(data.order_sn ?? '').trim(),
    externalMerchantId,
    providerOrderStatus: String(data.order_status ?? '').trim(),
    providerPaymentStatus: String(data.pay_status ?? '').trim(),
    orderTotalSen: decimalStringToSen(data.amount ?? data.total_price ?? ''),
    payment: mapGokooPaymentCode(data.pay_code),
    accountingEffect: 'none',
  };
}
