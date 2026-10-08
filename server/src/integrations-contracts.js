export const INTEGRATION_KINDS = Object.freeze({
  COMMERCE_CHANNEL: 'commerce_channel',
  PAYMENT_PROVIDER: 'payment_provider',
});

export const CONNECTION_STATUSES = Object.freeze(['disabled', 'pending', 'active']);

// These contracts keep order/catalog responsibilities separate from movement
// of money. A provider may implement both, but each connection is evaluated
// and activated independently.
export const COMMERCE_CHANNEL_CONTRACT = Object.freeze({
  kind: INTEGRATION_KINDS.COMMERCE_CHANNEL,
  responsibilities: Object.freeze([
    'merchant_identity', 'catalog', 'availability', 'orders', 'order_status', 'provider_finance_evidence',
  ]),
  forbiddenResponsibilities: Object.freeze(['payment_authorization', 'payment_capture', 'cash_recognition']),
});

export const PAYMENT_PROVIDER_CONTRACT = Object.freeze({
  kind: INTEGRATION_KINDS.PAYMENT_PROVIDER,
  responsibilities: Object.freeze([
    'payment_authorization', 'payment_capture', 'refund', 'settlement', 'payment_reconciliation',
  ]),
  forbiddenResponsibilities: Object.freeze(['catalog', 'stock_mutation', 'order_fulfillment']),
});

function provider(definition, contract) {
  if (!definition || definition.kind !== contract.kind) throw new TypeError('integration_kind_mismatch');
  return Object.freeze({
    ...definition,
    capabilities: Object.freeze({ ...definition.capabilities }),
    contract,
  });
}

export const defineCommerceChannel = definition => provider(definition, COMMERCE_CHANNEL_CONTRACT);
export const definePaymentProvider = definition => provider(definition, PAYMENT_PROVIDER_CONTRACT);
