import { createHmac, timingSafeEqual } from 'node:crypto';

const environments = Object.freeze({
  sandbox: Object.freeze({
    endpoint: 'https://api.sandbox.hit-pay.com/v1/payment-requests',
    checkoutOrigin: 'https://securecheckout.sandbox.hit-pay.com',
  }),
  production: Object.freeze({
    endpoint: 'https://api.hit-pay.com/v1/payment-requests',
    checkoutOrigin: 'https://securecheckout.hit-pay.com',
  }),
});

export class PaymentProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PaymentProviderError';
    this.code = code;
  }
}

const exactMoney = amountSen => {
  if (!Number.isSafeInteger(amountSen) || amountSen <= 0)
    throw new PaymentProviderError('invalid_payment_amount');
  return `${Math.floor(amountSen / 100)}.${String(amountSen % 100).padStart(2, '0')}`;
};

const safeId = value => {
  const input = String(value || '');
  return input.length >= 1 && input.length <= 128 && /^[A-Za-z0-9_-]+$/.test(input) ? input : '';
};

const secureCheckoutUrl = (value, environment) => {
  try {
    const url = new URL(String(value || ''));
    if (url.origin !== environments[environment]?.checkoutOrigin ||
        !url.pathname.startsWith('/payment-request/') || url.username || url.password ||
        url.toString().length > 2048) return '';
    url.hash = '';
    return url.toString();
  } catch { return ''; }
};

async function responseJson(response) {
  let text;
  try { text = await response.text(); }
  catch { throw new PaymentProviderError('provider_unavailable'); }
  if (Buffer.byteLength(text) > 256 * 1024) throw new PaymentProviderError('provider_response_invalid');
  try { return JSON.parse(text); }
  catch { throw new PaymentProviderError('provider_response_invalid'); }
}

const providerStatuses = new Set([
  'pending', 'completed', 'failed', 'expired', 'canceled', 'inactive',
]);

function exactProviderAmount(value) {
  const text = String(value ?? '');
  if (!/^\d{1,13}\.\d{2}$/.test(text))
    throw new PaymentProviderError('provider_response_invalid');
  const [whole, fraction] = text.split('.');
  const amountSen = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(amountSen) || amountSen <= 0)
    throw new PaymentProviderError('provider_response_invalid');
  return amountSen;
}

export function normalizeHitPayPaymentRequest(payload, environment) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !Object.hasOwn(environments, environment))
    throw new PaymentProviderError('provider_response_invalid');
  const requestId = safeId(payload.id);
  const referenceNumber = safeId(payload.reference_number);
  const status = String(payload.status || '').toLowerCase();
  const currencyCode = String(payload.currency || '').toUpperCase();
  const checkoutUrl = secureCheckoutUrl(payload.url, environment);
  if (!requestId || !referenceNumber || !providerStatuses.has(status) ||
      currencyCode !== 'MYR' || !checkoutUrl || payload.allow_repeated_payments !== false)
    throw new PaymentProviderError('provider_response_invalid');
  const updatedText = String(payload.updated_at || '');
  const updated = /(?:Z|[+-]\d{2}:\d{2})$/i.test(updatedText) ? Date.parse(updatedText) : NaN;
  return Object.freeze({
    requestId, referenceNumber, status, currencyCode,
    amountSen: exactProviderAmount(payload.amount), checkoutUrl,
    updatedAt: Number.isFinite(updated) ? new Date(updated).toISOString() : null,
  });
}

async function providerGet(fetchImpl, timeoutMs, { apiKey, environment, url }) {
  if (typeof apiKey !== 'string' || apiKey.length < 16 || apiKey.length > 500 || /[\r\n\0]/.test(apiKey) ||
      !Object.hasOwn(environments, environment))
    throw new PaymentProviderError('provider_unavailable');
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'X-BUSINESS-API-KEY': apiKey,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
  } catch { throw new PaymentProviderError('provider_unavailable'); }
  if (response?.status === 404) throw new PaymentProviderError('provider_request_not_found');
  if (!response?.ok) {
    const status = Number(response?.status || 0);
    throw new PaymentProviderError(status >= 400 && status < 500 &&
      ![408, 409, 425, 429].includes(status) ? 'provider_request_rejected' : 'provider_unavailable');
  }
  return responseJson(response);
}

export function createHitPayAdapter({ fetch: fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch_required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000)
    throw new TypeError('invalid_provider_timeout');
  return Object.freeze({
    providerKey: 'hitpay',
    async createCheckout({ apiKey, environment, amountSen, currencyCode, referenceNumber, purpose,
      redirectUrl, expiresAfterMinutes = 10 }) {
      if (typeof apiKey !== 'string' || apiKey.length < 16 || apiKey.length > 500 || /[\r\n\0]/.test(apiKey))
        throw new PaymentProviderError('provider_unavailable');
      if (!Object.hasOwn(environments, environment))
        throw new PaymentProviderError('provider_unavailable');
      if (currencyCode !== 'MYR') throw new PaymentProviderError('invalid_payment_currency');
      if (!safeId(referenceNumber)) throw new PaymentProviderError('invalid_payment_reference');
      if (!Number.isInteger(expiresAfterMinutes) || expiresAfterMinutes < 5 || expiresAfterMinutes > 60)
        throw new PaymentProviderError('invalid_payment_expiry');
      let redirect;
      try {
        redirect = new URL(redirectUrl);
        if (redirect.protocol !== 'https:' || redirect.username || redirect.password)
          throw new Error('invalid');
      } catch { throw new PaymentProviderError('invalid_redirect_url'); }
      const body = new URLSearchParams({
        amount: exactMoney(amountSen), currency: currencyCode,
        reference_number: referenceNumber, purpose: String(purpose || '').slice(0, 120),
        redirect_url: redirect.toString(), allow_repeated_payments: 'false',
        expires_after: `${expiresAfterMinutes} minutes`,
      });
      let response;
      try {
        response = await fetchImpl(environments[environment].endpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), body,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-BUSINESS-API-KEY': apiKey,
            'X-Requested-With': 'XMLHttpRequest',
          },
        });
      } catch { throw new PaymentProviderError('provider_unavailable'); }
      if (!response?.ok) {
        const status = Number(response?.status || 0);
        const ambiguous = !Number.isInteger(status) || status < 400 || status >= 500 ||
          [408, 409, 425, 429].includes(status);
        throw new PaymentProviderError(ambiguous ? 'provider_outcome_unknown' : 'provider_request_rejected');
      }
      const value = await responseJson(response);
      const id = safeId(value?.id), url = secureCheckoutUrl(value?.url, environment);
      if (!id || !url || value?.reference_number !== referenceNumber ||
          String(value?.amount || '') !== exactMoney(amountSen) ||
          String(value?.currency || '').toUpperCase() !== currencyCode ||
          String(value?.status || '').toLowerCase() !== 'pending')
        throw new PaymentProviderError('provider_response_invalid');
      return Object.freeze({ id, checkoutUrl: url });
    },
    async getPaymentRequest({ apiKey, environment, requestId }) {
      if (!safeId(requestId)) throw new PaymentProviderError('provider_response_invalid');
      const value = await providerGet(fetchImpl, timeoutMs, {
        apiKey, environment,
        url: `${environments[environment]?.endpoint}/${encodeURIComponent(requestId)}`,
      });
      const normalized = normalizeHitPayPaymentRequest(value, environment);
      if (normalized.requestId !== requestId)
        throw new PaymentProviderError('provider_response_invalid');
      return normalized;
    },
    async findPaymentRequestByReference({ apiKey, environment, referenceNumber }) {
      if (!safeId(referenceNumber)) throw new PaymentProviderError('provider_response_invalid');
      const url = new URL(environments[environment]?.endpoint || 'https://invalid.invalid');
      url.searchParams.set('search', referenceNumber);
      url.searchParams.set('per_page', '10');
      url.searchParams.set('current_page', '1');
      const value = await providerGet(fetchImpl, timeoutMs, { apiKey, environment, url: url.toString() });
      const rows = Array.isArray(value) ? value
        : Array.isArray(value?.data) ? value.data
          : Array.isArray(value?.payment_requests) ? value.payment_requests : null;
      if (!rows) throw new PaymentProviderError('provider_response_invalid');
      const exact = [];
      for (const row of rows) {
        if (String(row?.reference_number || '') !== referenceNumber) continue;
        exact.push(normalizeHitPayPaymentRequest(row, environment));
      }
      if (!exact.length) throw new PaymentProviderError('provider_request_not_found');
      if (exact.length !== 1) throw new PaymentProviderError('provider_response_invalid');
      return exact[0];
    },
    verifyWebhook({ rawBody, signature, webhookSalt }) {
      if (!Buffer.isBuffer(rawBody) || !rawBody.length || rawBody.length > 256 * 1024) return false;
      if (typeof webhookSalt !== 'string' || webhookSalt.length < 16 || webhookSalt.length > 500 ||
          /[\r\n\0]/.test(webhookSalt)) return false;
      const supplied = String(signature || '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(supplied)) return false;
      const expected = createHmac('sha256', webhookSalt).update(rawBody).digest();
      const actual = Buffer.from(supplied, 'hex');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  });
}

export function normalizeHitPayCompletedWebhook(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new PaymentProviderError('provider_response_invalid');
  const requestId = safeId(payload.id);
  const referenceNumber = safeId(payload.reference_number);
  const requestStatus = String(payload.status || '').toLowerCase();
  const currencyCode = String(payload.currency || '').toUpperCase();
  const amountText = String(payload.amount || '');
  if (!requestId || !referenceNumber || requestStatus !== 'completed' || currencyCode !== 'MYR' ||
      !/^\d{1,13}\.\d{2}$/.test(amountText))
    throw new PaymentProviderError('provider_response_invalid');
  const [whole, fraction] = amountText.split('.');
  const amountSen = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(amountSen) || amountSen <= 0)
    throw new PaymentProviderError('provider_response_invalid');
  const succeededPayments = Array.isArray(payload.payments)
    ? payload.payments.filter(payment => String(payment?.status || '').toLowerCase() === 'succeeded')
    : [];
  if (succeededPayments.length > 1) throw new PaymentProviderError('provider_response_invalid');
  const succeeded = succeededPayments[0] || null;
  const paymentId = safeId(succeeded?.id);
  if (!paymentId) throw new PaymentProviderError('payment_not_succeeded');
  if (String(succeeded.amount || '') !== amountText ||
      String(succeeded.currency || '').toUpperCase() !== currencyCode)
    throw new PaymentProviderError('provider_response_invalid');
  const paymentType = String(succeeded.payment_type || '').toLowerCase();
  const methodCode = /^[a-z0-9_.:-]{1,80}$/.test(paymentType) ? paymentType : 'unknown';
  const occurredText = String(succeeded.updated_at || payload.updated_at || '');
  const occurred = /(?:Z|[+-]\d{2}:\d{2})$/i.test(occurredText) ? Date.parse(occurredText) : NaN;
  return Object.freeze({
    requestId, referenceNumber, requestStatus, currencyCode, amountSen, paymentId,
    methodCode, providerStatus: 'completed',
    occurredAt: Number.isFinite(occurred) ? new Date(occurred).toISOString() : null,
  });
}

export const HITPAY_ENVIRONMENTS = environments;
