import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  HITPAY_ENVIRONMENTS, PaymentProviderError, createHitPayAdapter,
  normalizeHitPayCompletedWebhook, normalizeHitPayPaymentRequest,
} from '../src/payment-gateway-hitpay.js';
import {
  PAYMENT_GATEWAY_WEBHOOK_PATH, createPaymentGatewayRuntime, paymentAmountSen,
  paymentGatewayWebhookRequest, registerPaymentGatewayPublic, registerPaymentGatewayStaff,
  assertOrderHasNoConfirmedOnlinePayment,
} from '../src/payment-gateways.js';

const secretRef = 'secretref://myfin/company-a/hitpay';
const apiKey = 'api-key-01234567890123456789';
const webhookSalt = 'webhook-salt-01234567890123456789';

test('HitPay checkout uses the selected official environment and exact server amount', async () => {
  let observed;
  const adapter = createHitPayAdapter({ fetch: async (url, options) => {
    observed = { url, options };
    return { ok: true, text: async () => JSON.stringify({
      id: '90f28b43-2cff-4f86-a29e-15697424b3e7', reference_number: 'reference_1',
      amount: '19.95', currency: 'MYR', status: 'pending',
      url: 'https://securecheckout.sandbox.hit-pay.com/payment-request/@shop/request/checkout',
    }) };
  } });
  const result = await adapter.createCheckout({ apiKey, environment: 'sandbox', amountSen: 1995,
    currencyCode: 'MYR', referenceNumber: 'reference_1', purpose: 'Order ABC12345',
    redirectUrl: 'https://order.example.test/order/ABC12345?payment=return' });
  assert.equal(observed.url, HITPAY_ENVIRONMENTS.sandbox.endpoint);
  assert.equal(observed.options.headers['X-BUSINESS-API-KEY'], apiKey);
  assert.equal(observed.options.body.get('amount'), '19.95');
  assert.equal(observed.options.body.get('currency'), 'MYR');
  assert.equal(observed.options.body.get('allow_repeated_payments'), 'false');
  assert.equal(observed.options.body.get('expires_after'), '10 minutes');
  assert.equal(observed.options.body.has('webhook'), false, 'dashboard webhooks replace the deprecated request field');
  assert.doesNotMatch(observed.options.body.toString(), new RegExp(apiKey));
  assert.equal(result.checkoutUrl,
    'https://securecheckout.sandbox.hit-pay.com/payment-request/@shop/request/checkout');
  await assert.rejects(adapter.createCheckout({ apiKey, environment: 'production', amountSen: 1995,
    currencyCode: 'MYR', referenceNumber: 'reference_1', purpose: 'Order ABC12345',
    redirectUrl: 'https://order.example.test/order/ABC12345' }),
  error => error instanceof PaymentProviderError && error.code === 'provider_response_invalid');
});

test('HitPay webhook validation authenticates exact raw bytes and normalizes succeeded evidence', () => {
  const adapter = createHitPayAdapter();
  const payload = Buffer.from('{"id":"request_1","reference_number":"reference_1","status":"completed","currency":"MYR","amount":"19.95","payments":[{"id":"payment_1","status":"succeeded","payment_type":"duitnow","currency":"MYR","amount":"19.95","updated_at":"2026-10-16T02:30:00Z"}]}');
  const signature = createHmac('sha256', webhookSalt).update(payload).digest('hex');
  assert.equal(adapter.verifyWebhook({ rawBody: payload, signature, webhookSalt }), true);
  assert.equal(adapter.verifyWebhook({ rawBody: Buffer.concat([payload, Buffer.from(' ')]), signature, webhookSalt }), false);
  assert.deepEqual(normalizeHitPayCompletedWebhook(JSON.parse(payload)), {
    requestId: 'request_1', referenceNumber: 'reference_1', requestStatus: 'completed',
    currencyCode: 'MYR', amountSen: 1995, paymentId: 'payment_1', methodCode: 'duitnow',
    providerStatus: 'completed', occurredAt: '2026-10-16T02:30:00.000Z',
  });
  const duplicated = JSON.parse(payload);
  duplicated.payments.push({ ...duplicated.payments[0], id:'payment_2' });
  assert.throws(() => normalizeHitPayCompletedWebhook(duplicated),
    error => error instanceof PaymentProviderError && error.code === 'provider_response_invalid');
});

test('HitPay reconciliation uses exact request lookup and exact-reference discovery', async () => {
  const requests = [];
  const payment = {
    id: 'request_1', reference_number: 'reference_1', amount: '19.95', currency: 'myr',
    status: 'pending', allow_repeated_payments: false,
    url: 'https://securecheckout.sandbox.hit-pay.com/payment-request/@shop/request_1/checkout',
    updated_at: '2026-10-16T02:30:00Z',
  };
  const adapter = createHitPayAdapter({ fetch: async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('?')) return { ok: true, status: 200, text: async () => JSON.stringify({
      data: [{ ...payment, id: 'partial', reference_number: 'reference' }, payment],
    }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(payment) };
  } });
  assert.deepEqual(await adapter.getPaymentRequest({ apiKey, environment: 'sandbox', requestId: 'request_1' }), {
    requestId: 'request_1', referenceNumber: 'reference_1', amountSen: 1995,
    currencyCode: 'MYR', status: 'pending', checkoutUrl: payment.url,
    updatedAt: '2026-10-16T02:30:00.000Z',
  });
  assert.deepEqual(await adapter.findPaymentRequestByReference({ apiKey, environment: 'sandbox',
    referenceNumber: 'reference_1' }), normalizeHitPayPaymentRequest(payment, 'sandbox'));
  assert.equal(requests[0].url,
    'https://api.sandbox.hit-pay.com/v1/payment-requests/request_1');
  const search = new URL(requests[1].url);
  assert.equal(search.origin + search.pathname, HITPAY_ENVIRONMENTS.sandbox.endpoint);
  assert.equal(search.searchParams.get('search'), 'reference_1');
  assert.equal(search.searchParams.get('per_page'), '10');
  assert.equal(requests.every(item => item.options.method === 'GET' &&
    item.options.headers['X-BUSINESS-API-KEY'] === apiKey), true);
  assert.throws(() => normalizeHitPayPaymentRequest({ ...payment, allow_repeated_payments: true }, 'sandbox'),
    error => error instanceof PaymentProviderError && error.code === 'provider_response_invalid');
});

test('gateway secrets are disabled by default, strictly shaped and never named in errors', () => {
  const document = JSON.stringify({ [secretRef]: { apiKey, webhookSalt } });
  const disabled = createPaymentGatewayRuntime({}, { readFile: () => document });
  assert.equal(disabled.enabled, false);
  assert.throws(() => disabled.credentialsFor(secretRef), error => {
    assert.equal(error.message, 'online_payment_unavailable');
    assert.doesNotMatch(String(error.stack), /api-key|webhook-salt|secretref:\/\//);
    return true;
  });
  const enabled = createPaymentGatewayRuntime({ PAYMENT_GATEWAY_ENABLED: 'true',
    PAYMENT_GATEWAY_SECRET_FILE: '/run/secrets/payment_gateway_credentials' }, { readFile: () => document });
  assert.deepEqual(enabled.credentialsFor(secretRef), { apiKey, webhookSalt });
  const malformed = createPaymentGatewayRuntime({ PAYMENT_GATEWAY_ENABLED: 'true',
    PAYMENT_GATEWAY_SECRET_FILE: '/run/secrets/payment_gateway_credentials' }, {
    readFile: () => JSON.stringify({ [secretRef]: { apiKey, webhookSalt, unexpected: 'value' } }),
  });
  assert.throws(() => malformed.credentialsFor(secretRef), /online_payment_unavailable/);
});

test('money parsing is decimal exact and webhook origin bypass detection is one exact POST path', () => {
  assert.equal(paymentAmountSen('19.90'), 1990);
  assert.equal(paymentAmountSen('19.95'), 1995);
  assert.throws(() => paymentAmountSen('19.999'), /online_payment_amount_invalid/);
  assert.equal(paymentGatewayWebhookRequest({ method: 'POST', url: PAYMENT_GATEWAY_WEBHOOK_PATH }), true);
  assert.equal(paymentGatewayWebhookRequest({ method: 'POST', url: `${PAYMENT_GATEWAY_WEBHOOK_PATH}/other` }), false);
  assert.equal(paymentGatewayWebhookRequest({ method: 'GET', url: PAYMENT_GATEWAY_WEBHOOK_PATH }), false);
});

function fakeApp() {
  const routes = [];
  return {
    routes, hasRequestDecorator: () => false, decorateRequest() {},
    post(url, options, handler) {
      if (typeof options === 'function') routes.push({ method: 'POST', url, options: {}, handler: options });
      else routes.push({ method: 'POST', url, options, handler });
    },
    get(url, options, handler) {
      if (typeof options === 'function') routes.push({ method: 'GET', url, options: {}, handler: options });
      else routes.push({ method: 'GET', url, options, handler });
    },
    put(url, options, handler) {
      if (typeof options === 'function') routes.push({ method: 'PUT', url, options: {}, handler: options });
      else routes.push({ method: 'PUT', url, options, handler });
    },
  };
}

function fakeDatabase({ storefrontHostActive = true } = {}) {
  const order = { company_id: 'company-a', id: 'order-a', public_code: 'ABC12345',
    status: 'accepted', payment_state: 'unpaid', total: '19.95', currency: 'RM', version: 2,
    expires_at: new Date(Date.now() + 600_000).toISOString() };
  const connection = { id: 'gateway-a', provider_key: 'hitpay', provider_environment: 'sandbox',
    secret_ref: secretRef, version: 1, account_hint: 'Sandbox shop' };
  const intents = [], events = [], orderEvents = [], sql = [];
  const client = { query: async (statement, params = []) => {
    sql.push(statement);
    if (/SELECT 1 FROM myfin\.storefront_hosts/.test(statement) && /FOR SHARE/.test(statement))
      return { rows: storefrontHostActive ? [{}] : [], rowCount: storefrontHostActive ? 1 : 0 };
    if (/SELECT o\.\* FROM myfin\.customer_order_requests o/.test(statement)) return { rows: [order], rowCount: 1 };
    if (/SELECT \* FROM myfin\.online_payment_intents/.test(statement)) {
      const row = intents.find(intent => intent.company_id === params[0] && intent.idempotency_key === params[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/FROM myfin\.customer_order_online_payment_state s/.test(statement)) {
      const candidates = intents.filter(intent => intent.company_id === params[0] && intent.order_id === params[1] &&
        (!params[2] || intent.id === params[2]));
      const intent = candidates.at(-1);
      if (!intent) return { rows: [], rowCount: 0 };
      const related = events.filter(event => event.intent_id === intent.id);
      const checkout = related.find(event => ['checkout_created','checkout_discovered'].includes(event.event_type));
      const confirmed = related.find(event => event.event_type === 'payment_confirmed');
      const reconciled = related.find(event => event.event_type === 'payment_reconciliation_required');
      const observed = related.filter(event =>
        ['checkout_discovered','provider_status_observed'].includes(event.event_type)).at(-1);
      const unknown = related.find(event => event.event_type === 'checkout_creation_unknown');
      const failed = related.find(event => event.event_type === 'checkout_creation_failed');
      const state = reconciled ? 'reconciliation_required' : confirmed ? 'confirmed_unposted'
        : observed?.provider_status === 'completed' ? 'reconciliation_required'
          : ['failed','expired','canceled','inactive'].includes(observed?.provider_status) ? 'failed'
            : checkout ? 'pending' : unknown ? 'reconciliation_required' : failed ? 'failed' : 'creating';
      return { rowCount: 1, rows: [{ ...intent, intent_id:intent.id,
        provider_key: 'hitpay', account_hint: connection.account_hint,
        state, checkout_url: checkout?.checkout_url || null,
        provider_payment_request_id: checkout?.provider_payment_request_id || confirmed?.provider_payment_request_id || null,
        provider_payment_id: confirmed?.provider_payment_id || null,
        provider_method_code: confirmed?.provider_method_code || '',
        provider_status: confirmed?.provider_status || observed?.provider_status || '',
        confirmed_at: confirmed?.provider_occurred_at || null, created_at: new Date().toISOString() }] };
    }
    if (/SELECT state FROM myfin\.customer_order_online_payment_state/.test(statement) &&
        /state<>'failed'/.test(statement)) {
      const active = intents.filter(intent => intent.company_id === params[0] && intent.order_id === params[1])
        .map(intent => {
          const related = events.filter(event => event.intent_id === intent.id);
          return related.some(event => event.event_type === 'payment_reconciliation_required')
            ? 'reconciliation_required'
            : related.some(event => event.event_type === 'payment_confirmed') ? 'confirmed_unposted'
            : related.some(event => ['checkout_discovered','provider_status_observed'].includes(event.event_type) &&
              event.provider_status === 'completed') ? 'reconciliation_required'
            : related.some(event => ['checkout_discovered','provider_status_observed'].includes(event.event_type) &&
              ['failed','expired','canceled','inactive'].includes(event.provider_status)) ? 'failed'
            : related.some(event => ['checkout_created','checkout_discovered'].includes(event.event_type)) ? 'pending'
              : related.some(event => event.event_type === 'checkout_creation_unknown')
                ? 'reconciliation_required'
              : related.some(event => event.event_type === 'checkout_creation_failed') ? 'failed' : 'creating';
        }).find(state => state !== 'failed');
      return { rowCount: active ? 1 : 0, rows: active ? [{ state: active }] : [] };
    }
    if (/SELECT id,provider_key,provider_environment,secret_ref,version/.test(statement))
      return { rows: [connection], rowCount: 1 };
    if (/SELECT greatest\(\$1::timestamptz/.test(statement))
      return { rows:[{ hold_until:new Date(Date.now() + 900_000).toISOString() }], rowCount:1 };
    if (/INSERT INTO myfin\.online_payment_intents/.test(statement)) {
      intents.push({ company_id: params[0], id: params[1], order_id: params[2], connection_id: params[3],
        connection_version: params[4], provider_environment: params[5], secret_ref_snapshot: params[6],
        idempotency_key: params[7], request_digest: params[8], provider_reference: params[9],
        amount_sen: params[10], currency_code: params[11], order_version: params[12],
        order_status_snapshot: params[13], public_code_snapshot: params[14], hold_until:params[15] });
      return { rowCount: 1, rows: [] };
    }
    if (/UPDATE myfin\.customer_order_requests\s+SET expires_at=\$3/.test(statement)) {
      order.expires_at = params[2]; order.version = params[3];
      return { rows:[{ version:order.version, expires_at:order.expires_at }], rowCount:1 };
    }
    if (/SELECT\s+EXISTS\(SELECT 1 FROM myfin\.customer_order_reservations/.test(statement))
      return { rows:[{ stale:false }], rowCount:1 };
    if (/UPDATE myfin\.customer_order_(?:recipe_)?reservations\s+SET expires_at/.test(statement))
      return { rows:[], rowCount:1 };
    if (/extend_order_promotion_reservations/.test(statement))
      return { rows:[{ count:1 }], rowCount:1 };
    if (/INSERT INTO myfin\.customer_order_events/.test(statement)) {
      orderEvents.push({ version:params[3], request_id:params[4] });
      return { rows:[], rowCount:1 };
    }
    if (/pg_advisory_xact_lock/.test(statement)) return { rowCount: 1, rows: [{}] };
    if (/SELECT id FROM myfin\.online_payment_events/.test(statement)) {
      const matching = events.filter(event => event.company_id === params[0] && event.intent_id === params[1] &&
        (statement.includes('provider_event_key=$3') ? event.provider_event_key === params[2]
          : ['payment_confirmed','payment_reconciliation_required'].includes(event.event_type)));
      return { rowCount: matching.length, rows: matching };
    }
    if (/coalesce\(max\(event_no\),0\)\+1/.test(statement)) {
      const maximum = Math.max(0, ...events.filter(event => event.intent_id === params[1]).map(event => event.event_no));
      return { rowCount: 1, rows: [{ event_no: maximum + 1 }] };
    }
    if (/INSERT INTO myfin\.online_payment_events/.test(statement)) {
      events.push({ company_id: params[0], id: params[1], intent_id: params[2], event_no: params[3],
        event_type: params[4], provider_event_key: params[5], payload_digest: params[6],
        provider_payment_request_id: params[7], provider_payment_id: params[8],
        provider_method_code: params[9], provider_status: params[10], checkout_url: params[11],
        observed_amount_sen: params[12], observed_currency_code: params[13], failure_code: params[14],
        provider_occurred_at: params[15] });
      return { rowCount: 1, rows: [] };
    }
    if (/SELECT i\.\*,e\.provider_payment_request_id/.test(statement)) {
      const intent = intents.find(item => item.company_id === params[0] && item.provider_reference === params[1]);
      const checkout = intent && events.find(event => event.intent_id === intent.id && event.event_type === 'checkout_created');
      return { rowCount: intent ? 1 : 0, rows: intent ? [{ ...intent,
        provider_payment_request_id: checkout?.provider_payment_request_id || null }] : [] };
    }
    if (/SELECT secret_ref FROM myfin\.payment_gateway_connections/.test(statement))
      return { rowCount: 1, rows: [{ secret_ref: secretRef }] };
    if (/SELECT status,payment_state FROM myfin\.customer_order_requests/.test(statement))
      return { rowCount:1, rows:[{ status:order.status, payment_state:order.payment_state }] };
    if (/SELECT id FROM myfin\.customer_order_requests WHERE company_id=\$1 AND id=\$2/.test(statement))
      return { rowCount: params[1] === order.id ? 1 : 0, rows: params[1] === order.id ? [{ id:order.id }] : [] };
    if (/SELECT intent_id FROM myfin\.online_payment_events/.test(statement)) {
      const binding = events.find(event => event.company_id === params[0] &&
        event.provider_payment_request_id === params[1] && params[2].includes(event.event_type));
      return { rowCount:binding ? 1 : 0, rows:binding ? [{ intent_id:binding.intent_id }] : [] };
    }
    if (/SELECT event_no,event_type,provider_payment_request_id/.test(statement)) {
      const rows = events.filter(event => event.company_id === params[0] && event.intent_id === params[1])
        .map(event => ({ ...event, created_at:new Date().toISOString() }));
      return { rowCount:rows.length, rows };
    }
    if (/SELECT state,attempt_count,next_attempt_at,last_outcome_code,escalation_reason/.test(statement))
      return { rowCount:0,rows:[] };
    throw new Error(`unexpected_sql:${statement}`);
  } };
  return { transaction: fn => fn(client), client, order, connection, intents, events, orderEvents, sql };
}

test('public creation is order-total authoritative, exactly idempotent and redirect never confirms payment', async () => {
  const db = fakeDatabase(), app = fakeApp();
  let providerCalls = 0;
  const runtime = createPaymentGatewayRuntime({ PAYMENT_GATEWAY_ENABLED: 'true',
    PAYMENT_GATEWAY_SECRET_FILE: '/run/secrets/payment_gateway_credentials' }, {
    readFile: () => JSON.stringify({ [secretRef]: { apiKey, webhookSalt } }),
    fetch: async (_url, options) => {
      providerCalls += 1;
      assert.equal(options.body.get('amount'), '19.95');
      assert.equal(options.body.get('redirect_url'), 'https://order.example.test/order/ABC12345?payment=return');
      return { ok: true, text: async () => JSON.stringify({ id: 'request_1',
        reference_number: options.body.get('reference_number'),
        amount: '19.95', currency: 'MYR', status: 'pending',
        url: 'https://securecheckout.sandbox.hit-pay.com/payment-request/@shop/request_1/checkout' }) };
    },
  });
  registerPaymentGatewayPublic(app, { db, authOptions: { publicProxyAddresses: [] }, runtime });
  const create = app.routes.find(route => route.method === 'POST' && route.url.includes(':code'));
  const request = { method: 'POST', url: create.url, params: { code: 'abc12345' }, body: {},
    tenant: { surface: 'storefront', company_id: 'company-a', hostname: 'order.example.test' },
    headers: { cookie: `__Host-myfin_guest_order=${'a'.repeat(43)}`,
      'idempotency-key': 'd2719d4f-4ea6-4e4f-8158-fd55e953a0eb' } };
  const reply = { status: 200, code(value) { this.status = value; return this; } };
  const first = await create.handler(request, reply);
  assert.equal(reply.status, 201);
  assert.equal(first.onlinePayment.state, 'pending');
  assert.equal(first.onlinePayment.amountSen, 1995);
  assert.equal(providerCalls, 1);
  const second = await create.handler(request, { code() {} });
  assert.equal(second.onlinePayment.state, 'pending');
  assert.equal(providerCalls, 1, 'same idempotency key must not create another provider request');
  assert.deepEqual(db.events.map(event => event.event_type), ['checkout_creation_started', 'checkout_created']);
  assert.equal(db.orderEvents.length, 1, 'the hosted-checkout hold must be part of order history');
  assert.equal(db.intents[0].hold_until, db.order.expires_at);
  assert.equal(db.sql.some(statement => /UPDATE myfin\.customer_order_reservations\s+SET expires_at/.test(statement)), true);
  assert.equal(db.sql.some(statement => /UPDATE myfin\.customer_order_recipe_reservations\s+SET expires_at/.test(statement)), true);
  assert.equal(db.sql.some(statement => /extend_order_promotion_reservations/.test(statement)), true);
  assert.equal(db.sql.some(statement => /UPDATE myfin\.transactions/.test(statement)), false);
  assert.equal(db.sql.some(statement => /FROM myfin\.storefront_hosts[\s\S]*FOR SHARE/.test(statement)), true);
  await assert.rejects(create.handler({ ...request, body: { amount: 0.01 } }, { code() {} }),
    error => error.statusCode === 400 && error.message === 'invalid_input');
});

test('public payment creation rejects a storefront hostname disabled after tenant resolution', async () => {
  const db = fakeDatabase({ storefrontHostActive:false }), app = fakeApp();
  let providerCalls = 0;
  const runtime = createPaymentGatewayRuntime({ PAYMENT_GATEWAY_ENABLED:'true',
    PAYMENT_GATEWAY_SECRET_FILE:'/run/secrets/payment_gateway_credentials' }, {
    readFile:() => JSON.stringify({ [secretRef]:{ apiKey,webhookSalt } }),
    fetch:async () => { providerCalls += 1; throw new Error('provider must not be called'); },
  });
  registerPaymentGatewayPublic(app, { db, authOptions:{ publicProxyAddresses:[] }, runtime });
  const create = app.routes.find(route => route.method === 'POST' && route.url.includes(':code'));
  const request = { method:'POST', url:create.url, params:{ code:'ABC12345' }, body:{},
    tenant:{ surface:'storefront', company_id:'company-a', hostname:'order-old.example.test' },
    headers:{ cookie:`__Host-myfin_guest_order=${'a'.repeat(43)}`,
      'idempotency-key':'d2719d4f-4ea6-4e4f-8158-fd55e953a0eb' } };
  await assert.rejects(create.handler(request, { code() {} }),
    error => error.statusCode === 409 && error.message === 'storefront_hostname_changed');
  assert.equal(providerCalls,0);
  assert.equal(db.intents.length,0);
  assert.match(db.sql[0], /FROM myfin\.storefront_hosts[\s\S]*FOR SHARE/);
});

test('only an exact-header, HMAC-verified HitPay webhook records confirmation evidence', async () => {
  const db = fakeDatabase(), app = fakeApp();
  const runtime = createPaymentGatewayRuntime({ PAYMENT_GATEWAY_ENABLED: 'true',
    PAYMENT_GATEWAY_SECRET_FILE: '/run/secrets/payment_gateway_credentials' }, {
    readFile: () => JSON.stringify({ [secretRef]: { apiKey, webhookSalt } }),
    fetch: async () => { throw new Error('not used'); },
  });
  registerPaymentGatewayPublic(app, { db, authOptions: { publicProxyAddresses: [] }, runtime });
  const create = app.routes.find(route => route.method === 'POST' && route.url.includes(':code'));
  const baseRequest = { method: 'POST', url: create.url, params: { code: 'ABC12345' }, body: {},
    tenant: { surface: 'storefront', company_id: 'company-a', hostname: 'order.example.test' },
    headers: { cookie: `__Host-myfin_guest_order=${'a'.repeat(43)}`,
      'idempotency-key': 'd2719d4f-4ea6-4e4f-8158-fd55e953a0eb' } };
  // Seed a pending intent without invoking the adapter in this test.
  const intent = { company_id: 'company-a', id: 'intent-a', order_id: 'order-a', connection_id: 'gateway-a',
    connection_version: 1, provider_environment: 'sandbox', secret_ref_snapshot: secretRef,
    idempotency_key: baseRequest.headers['idempotency-key'], request_digest: 'a'.repeat(64),
    provider_reference: 'reference_1', amount_sen: 1995, currency_code: 'MYR',
    order_version: 2, order_status_snapshot: 'accepted', public_code_snapshot: 'ABC12345' };
  db.intents.push(intent);
  db.events.push({ company_id: 'company-a', id: 'event-a', intent_id: 'intent-a', event_no: 1,
    event_type: 'checkout_created', provider_payment_request_id: 'request_1',
    checkout_url: 'https://securecheckout.sandbox.hit-pay.com/payment-request/@shop/request_1/checkout' });
  const webhook = app.routes.find(route => route.url === PAYMENT_GATEWAY_WEBHOOK_PATH);
  const body = { id: 'request_1', reference_number: 'reference_1', status: 'completed', currency: 'MYR',
    amount: '19.95', updated_at: '2026-10-16T02:30:00Z',
    payments: [{ id: 'payment_1', status: 'succeeded', payment_type: 'duitnow', currency: 'MYR', amount: '19.95',
      updated_at: '2026-10-16T02:30:00Z' }] };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = createHmac('sha256', webhookSalt).update(rawBody).digest('hex');
  const result = await webhook.handler({ method: 'POST', url: webhook.url, body, gatewayRawBody: rawBody,
    tenant: baseRequest.tenant, headers: { 'hitpay-signature': signature,
      'hitpay-event-type': 'completed', 'hitpay-event-object': 'payment_request' } });
  assert.deepEqual(result, { accepted: true });
  const confirmed = db.events.find(event => event.event_type === 'payment_confirmed');
  assert.equal(confirmed.provider_payment_id, 'payment_1');
  assert.equal(confirmed.observed_amount_sen, 1995);
  assert.equal(db.sql.some(statement => /UPDATE myfin\.(customer_order_requests|transactions)/.test(statement)), false);
  const bad = { ...body, amount: '0.01', payments: [{ ...body.payments[0], amount: '0.01' }] };
  const badRaw = Buffer.from(JSON.stringify(bad));
  const badSignature = createHmac('sha256', webhookSalt).update(badRaw).digest('hex');
  const rejected = await webhook.handler({ method: 'POST', url: webhook.url, body: bad,
    gatewayRawBody: badRaw, tenant: baseRequest.tenant, headers: { 'hitpay-signature': badSignature,
      'hitpay-event-type': 'completed', 'hitpay-event-object': 'payment_request' } });
  assert.deepEqual(rejected, { accepted: false });
  assert.equal(db.events.some(event => event.event_type === 'webhook_rejected' &&
    event.failure_code === 'amount_mismatch'), true);
});

test('a failed checkout is stable for the same key and permits one explicit new-key retry', async () => {
  const db = fakeDatabase(), app = fakeApp();
  let providerCalls = 0, succeed = false;
  const runtime = createPaymentGatewayRuntime({ PAYMENT_GATEWAY_ENABLED: 'true',
    PAYMENT_GATEWAY_SECRET_FILE: '/run/secrets/payment_gateway_credentials' }, {
    readFile: () => JSON.stringify({ [secretRef]: { apiKey, webhookSalt } }),
    fetch: async (_url, options) => {
      providerCalls += 1;
      if (!succeed) return { ok: false, status:422, text: async () => '{}' };
      return { ok: true, text: async () => JSON.stringify({ id: 'request_retry',
        reference_number: options.body.get('reference_number'),
        amount: '19.95', currency: 'MYR', status: 'pending',
        url: 'https://securecheckout.sandbox.hit-pay.com/payment-request/@shop/request_retry/checkout' }) };
    },
  });
  registerPaymentGatewayPublic(app, { db, authOptions: { publicProxyAddresses: [] }, runtime });
  const route = app.routes.find(item => item.method === 'POST' && item.url.includes(':code'));
  const request = { method: 'POST', url: route.url, params: { code: 'ABC12345' }, body: {},
    tenant: { surface: 'storefront', company_id: 'company-a', hostname: 'order.example.test' },
    headers: { cookie: `__Host-myfin_guest_order=${'a'.repeat(43)}`,
      'idempotency-key': '92a2ce7f-b52f-44a9-a43b-c5e655e03e76' } };
  await assert.rejects(route.handler(request, { code() {} }),
    error => error.statusCode === 503 && error.message === 'online_payment_unavailable');
  assert.equal(providerCalls, 1);
  const same = await route.handler(request, { code() {} });
  assert.equal(same.onlinePayment.state, 'failed');
  assert.equal(providerCalls, 1);
  succeed = true;
  const retried = await route.handler({ ...request, headers: { ...request.headers,
    'idempotency-key': '7516ed0d-2be7-4377-9df5-9de1297a2105' } }, { code() {} });
  assert.equal(retried.onlinePayment.state, 'pending');
  assert.equal(providerCalls, 2);
  assert.equal(db.intents.length, 2);
});

test('an ambiguous checkout response is non-retryable and a later signed completion recovers it', async () => {
  const db = fakeDatabase(), app = fakeApp();
  let providerCalls = 0;
  const runtime = createPaymentGatewayRuntime({ PAYMENT_GATEWAY_ENABLED: 'true',
    PAYMENT_GATEWAY_SECRET_FILE: '/run/secrets/payment_gateway_credentials' }, {
    readFile: () => JSON.stringify({ [secretRef]: { apiKey, webhookSalt } }),
    fetch: async () => { providerCalls += 1; throw new Error('response lost'); },
  });
  registerPaymentGatewayPublic(app, { db, authOptions: { publicProxyAddresses: [] }, runtime });
  const create = app.routes.find(item => item.method === 'POST' && item.url.includes(':code'));
  const status = app.routes.find(item => item.method === 'GET' && item.url.includes(':code'));
  const request = { method: 'POST', url: create.url, params: { code: 'ABC12345' }, body: {},
    tenant: { surface: 'storefront', company_id: 'company-a', hostname: 'order.example.test' },
    headers: { cookie: `__Host-myfin_guest_order=${'a'.repeat(43)}`,
      'idempotency-key': '3731136f-6784-4665-8df7-15c40fa89c18' } };
  await assert.rejects(create.handler(request, { code() {} }),
    error => error.statusCode === 503 && error.message === 'online_payment_unavailable');
  assert.equal(providerCalls, 1);
  assert.deepEqual(db.events.map(event => event.event_type),
    ['checkout_creation_started', 'checkout_creation_unknown']);
  const same = await create.handler(request, { code() {} });
  assert.equal(same.onlinePayment.state, 'reconciliation_required');
  await assert.rejects(create.handler({ ...request, headers: { ...request.headers,
    'idempotency-key':'bc75fdc4-7a91-45f5-b027-47448eb34911' } }, { code() {} }),
  error => error.statusCode === 409 && error.message === 'online_payment_already_started');
  assert.equal(providerCalls, 1, 'response loss must never create a second payable request');

  const intent = db.intents[0];
  const body = { id:'request_recovered', reference_number:intent.provider_reference,
    status:'completed', currency:'MYR', amount:'19.95', updated_at:'2026-10-16T02:30:00Z',
    payments:[{ id:'payment_recovered', status:'succeeded', payment_type:'duitnow',
      currency:'MYR', amount:'19.95', updated_at:'2026-10-16T02:30:00Z' }] };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = createHmac('sha256', webhookSalt).update(rawBody).digest('hex');
  const webhook = app.routes.find(item => item.url === PAYMENT_GATEWAY_WEBHOOK_PATH);
  assert.deepEqual(await webhook.handler({ method:'POST', url:webhook.url, body, gatewayRawBody:rawBody,
    tenant:request.tenant, headers:{ 'hitpay-signature':signature,
      'hitpay-event-type':'completed', 'hitpay-event-object':'payment_request' } }), { accepted:true });
  const recovered = await status.handler({ ...request, method:'GET', url:status.url });
  assert.equal(recovered.onlinePayment.state, 'confirmed_unposted');
  assert.equal(recovered.onlinePayment.confirmation.status, 'completed');
});

test('a signed payment received after an order became non-payable is quarantined for reconciliation', async () => {
  const db = fakeDatabase(), app = fakeApp();
  const runtime = createPaymentGatewayRuntime({ PAYMENT_GATEWAY_ENABLED:'true',
    PAYMENT_GATEWAY_SECRET_FILE:'/run/secrets/payment_gateway_credentials' }, {
    readFile:() => JSON.stringify({ [secretRef]:{ apiKey, webhookSalt } }),
  });
  registerPaymentGatewayPublic(app, { db, authOptions:{ publicProxyAddresses:[] }, runtime });
  const intent = { company_id:'company-a', id:'intent-late', order_id:'order-a', connection_id:'gateway-a',
    connection_version:1, provider_environment:'sandbox', secret_ref_snapshot:secretRef,
    idempotency_key:'5d9745fe-307d-41d2-a8ad-6407e3a80181', request_digest:'a'.repeat(64),
    provider_reference:'reference_late', amount_sen:1995, currency_code:'MYR', order_version:2,
    order_status_snapshot:'accepted', public_code_snapshot:'ABC12345',
    hold_until:new Date(Date.now()+900_000).toISOString() };
  db.intents.push(intent);
  db.events.push({ company_id:'company-a', id:'created-late', intent_id:intent.id, event_no:1,
    event_type:'checkout_created', provider_payment_request_id:'request_late',
    checkout_url:'https://securecheckout.sandbox.hit-pay.com/payment-request/@shop/request_late/checkout' });
  db.order.status = 'cancelled';
  const body = { id:'request_late', reference_number:'reference_late', status:'completed',
    currency:'MYR', amount:'19.95', updated_at:'2026-10-16T02:30:00Z', payments:[{
      id:'payment_late', status:'succeeded', payment_type:'duitnow', currency:'MYR', amount:'19.95',
      updated_at:'2026-10-16T02:30:00Z' }] };
  const rawBody = Buffer.from(JSON.stringify(body));
  const webhook = app.routes.find(item => item.url === PAYMENT_GATEWAY_WEBHOOK_PATH);
  const result = await webhook.handler({ method:'POST', url:webhook.url, body, gatewayRawBody:rawBody,
    tenant:{ surface:'storefront', company_id:'company-a', hostname:'order.example.test' },
    headers:{ 'hitpay-signature':createHmac('sha256', webhookSalt).update(rawBody).digest('hex'),
      'hitpay-event-type':'completed', 'hitpay-event-object':'payment_request' } });
  assert.deepEqual(result, { accepted:false });
  const quarantined = db.events.find(event => event.event_type === 'payment_reconciliation_required');
  assert.equal(quarantined.failure_code, 'order_not_payable');
  assert.equal(quarantined.provider_payment_id, 'payment_late');
});

test('staff reconciliation discovers an ambiguous request and only a provider terminal state unlocks it', async () => {
  const db = fakeDatabase(), app = fakeApp(), audits = [];
  const intent = { company_id:'company-a', id:'intent-unknown', order_id:'order-a', connection_id:'gateway-a',
    connection_version:1, provider_environment:'sandbox', secret_ref_snapshot:secretRef,
    idempotency_key:'2b308609-6668-4daf-9c22-1ddcc58995a6', request_digest:'a'.repeat(64),
    provider_reference:'reference_unknown', amount_sen:1995, currency_code:'MYR', order_version:2,
    order_status_snapshot:'accepted', public_code_snapshot:'ABC12345',
    hold_until:new Date(Date.now()+900_000).toISOString() };
  db.intents.push(intent);
  db.events.push({ company_id:'company-a', id:'started', intent_id:intent.id, event_no:1,
    event_type:'checkout_creation_started' });
  db.events.push({ company_id:'company-a', id:'unknown', intent_id:intent.id, event_no:2,
    event_type:'checkout_creation_unknown', failure_code:'provider_outcome_unknown' });
  let status = 'pending', fetches = 0;
  const runtime = createPaymentGatewayRuntime({ PAYMENT_GATEWAY_ENABLED:'true',
    PAYMENT_GATEWAY_SECRET_FILE:'/run/secrets/payment_gateway_credentials' }, {
    readFile:() => JSON.stringify({ [secretRef]:{ apiKey, webhookSalt } }),
    fetch:async url => {
      fetches += 1;
      const payment = { id:'request_found', reference_number:intent.provider_reference,
        amount:'19.95', currency:'MYR', status, allow_repeated_payments:false,
        url:'https://securecheckout.sandbox.hit-pay.com/payment-request/@shop/request_found/checkout',
        updated_at:'2026-10-16T02:30:00Z' };
      return { ok:true, status:200, text:async () => JSON.stringify(
        String(url).includes('?') ? { data:[payment] } : payment) };
    },
  });
  const scoped = (_req, fn) => fn(db.client, 'company-a');
  registerPaymentGatewayStaff(app, { scoped, runtime,
    audit:async (_c, _who, _company, action, details) => audits.push({ action, details }) });
  const reconcile = app.routes.find(route => route.url.endsWith('/online-payment/reconcile'));
  const req = { params:{ company:'company-a', id:'order-a' }, body:{},
    identity:{ id:'manager-a', role:'manager' } };
  await assert.rejects(reconcile.handler({ ...req, identity:{ id:'operator-a', role:'operator' } }),
    error => error.statusCode === 403 && error.message === 'access_denied');
  assert.equal(fetches, 0, 'an operator must not trigger a provider lookup');
  const discovered = await reconcile.handler(req);
  assert.equal(discovered.onlinePayment.state, 'pending');
  assert.equal(discovered.onlinePayment.paymentRequestId, 'request_found');
  assert.equal(discovered.reconciliation.changed, true);
  assert.equal(db.events.at(-1).event_type, 'checkout_discovered');
  assert.equal(db.events.at(-1).provider_status, 'pending');
  status = 'expired';
  const terminal = await reconcile.handler(req);
  assert.equal(terminal.onlinePayment.state, 'failed');
  assert.equal(terminal.onlinePayment.providerStatus, 'expired');
  assert.equal(db.events.at(-1).event_type, 'provider_status_observed');
  assert.equal(fetches, 2);
  assert.deepEqual(audits, [
    { action:'Reconcile online payment', details:'HitPay · ABC12345 · pending' },
    { action:'Reconcile online payment', details:'HitPay · ABC12345 · expired' },
  ]);
});

test('provider completed lookup remains quarantined until the signed webhook supplies payment evidence', async () => {
  const db = fakeDatabase(), app = fakeApp();
  const intent = { company_id:'company-a', id:'intent-pending', order_id:'order-a', connection_id:'gateway-a',
    connection_version:1, provider_environment:'sandbox', secret_ref_snapshot:secretRef,
    idempotency_key:'6ac9612d-7acf-4202-bf43-7d4f3af30454', request_digest:'a'.repeat(64),
    provider_reference:'reference_pending', amount_sen:1995, currency_code:'MYR', order_version:2,
    order_status_snapshot:'accepted', public_code_snapshot:'ABC12345',
    hold_until:new Date(Date.now()+900_000).toISOString() };
  db.intents.push(intent);
  db.events.push({ company_id:'company-a', id:'created', intent_id:intent.id, event_no:1,
    event_type:'checkout_created', provider_payment_request_id:'request_pending', provider_status:'pending',
    checkout_url:'https://securecheckout.sandbox.hit-pay.com/payment-request/@shop/request_pending/checkout' });
  const runtime = createPaymentGatewayRuntime({ PAYMENT_GATEWAY_ENABLED:'true',
    PAYMENT_GATEWAY_SECRET_FILE:'/run/secrets/payment_gateway_credentials' }, {
    readFile:() => JSON.stringify({ [secretRef]:{ apiKey, webhookSalt } }),
    fetch:async () => ({ ok:true, status:200, text:async () => JSON.stringify({
      id:'request_pending', reference_number:intent.provider_reference, amount:'19.95', currency:'MYR',
      status:'completed', allow_repeated_payments:false,
      url:'https://securecheckout.sandbox.hit-pay.com/payment-request/@shop/request_pending/checkout',
      updated_at:'2026-10-16T02:30:00Z', payments:[{ id:'untrusted-until-webhook', status:'succeeded' }],
    }) }),
  });
  registerPaymentGatewayStaff(app, { scoped:(_req, fn) => fn(db.client, 'company-a'), runtime });
  const reconcile = app.routes.find(route => route.url.endsWith('/online-payment/reconcile'));
  const result = await reconcile.handler({ params:{ company:'company-a', id:'order-a' }, body:{},
    identity:{ id:'owner-a', role:'workspace_owner' } });
  assert.equal(result.onlinePayment.state, 'reconciliation_required');
  assert.equal(result.onlinePayment.providerStatus, 'completed');
  assert.equal(result.onlinePayment.paymentId, '');
  const observation = db.events.at(-1);
  assert.equal(observation.event_type, 'provider_status_observed');
  assert.equal(observation.provider_payment_id, null,
    'API-key status lookup must not replace raw-HMAC payment evidence');
  assert.equal(db.events.some(event => event.event_type === 'payment_confirmed'), false);
});

test('an exact-reference miss never unlocks an ambiguous checkout', async () => {
  const db = fakeDatabase(), app = fakeApp();
  const intent = { company_id:'company-a', id:'intent-missing', order_id:'order-a', connection_id:'gateway-a',
    connection_version:1, provider_environment:'sandbox', secret_ref_snapshot:secretRef,
    idempotency_key:'2d4bfb09-2c96-49e5-8d18-c3f36c48de06', request_digest:'a'.repeat(64),
    provider_reference:'reference_missing', amount_sen:1995, currency_code:'MYR', order_version:2,
    order_status_snapshot:'accepted', public_code_snapshot:'ABC12345',
    hold_until:new Date(Date.now()+900_000).toISOString() };
  db.intents.push(intent);
  db.events.push({ company_id:'company-a', id:'unknown', intent_id:intent.id, event_no:1,
    event_type:'checkout_creation_unknown', failure_code:'provider_outcome_unknown' });
  const runtime = createPaymentGatewayRuntime({ PAYMENT_GATEWAY_ENABLED:'true',
    PAYMENT_GATEWAY_SECRET_FILE:'/run/secrets/payment_gateway_credentials' }, {
    readFile:() => JSON.stringify({ [secretRef]:{ apiKey, webhookSalt } }),
    fetch:async () => ({ ok:true, status:200, text:async () => JSON.stringify({ data:[] }) }),
  });
  registerPaymentGatewayStaff(app, { scoped:(_req, fn) => fn(db.client, 'company-a'), runtime });
  const reconcile = app.routes.find(route => route.url.endsWith('/online-payment/reconcile'));
  await assert.rejects(reconcile.handler({ params:{ company:'company-a', id:'order-a' }, body:{},
    identity:{ id:'manager-a', role:'manager' } }),
  error => error.statusCode === 409 && error.message === 'online_payment_provider_request_not_found');
  assert.equal(db.events.length, 1);
});

test('owner metadata routes never expose secrets and confirmed evidence blocks a second POS tender', async () => {
  const app = fakeApp(), audits = [];
  let row = { id: 'gateway-a', status: 'disabled', provider_environment: 'sandbox',
    secret_ref: secretRef, account_hint: 'Sandbox', version: 1 };
  const c = { query: async (sql, params) => {
    if (/pg_advisory_xact_lock/.test(sql)) return { rowCount: 1, rows: [{}] };
    if (/FROM myfin\.payment_gateway_connections/.test(sql)) return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    if (/FROM myfin\.storefront_hosts/.test(sql)) return { rowCount: 1,
      rows: [{ hostname: 'order.example.test' }] };
    if (/UPDATE myfin\.payment_gateway_connections/.test(sql)) {
      row = { ...row, status: params[2], provider_environment: params[3], secret_ref: params[4],
        account_hint: params[5], version: params[6] };
      return { rowCount: 1, rows: [row] };
    }
    if (/SELECT state FROM myfin\.customer_order_online_payment_state/.test(sql))
      return { rowCount: 1, rows: [{ state: 'confirmed_unposted' }] };
    throw new Error(`unexpected_sql:${sql}`);
  } };
  const runtime = createPaymentGatewayRuntime({ PAYMENT_GATEWAY_ENABLED: 'true',
    PAYMENT_GATEWAY_SECRET_FILE: '/run/secrets/payment_gateway_credentials' }, {
    readFile: () => JSON.stringify({ [secretRef]: { apiKey, webhookSalt } }),
  });
  const scoped = (req, fn) => fn(c, req.params.company);
  registerPaymentGatewayStaff(app, { scoped, runtime,
    audit: async (_c, _who, _company, action, details) => audits.push({ action, details }) });
  const get = app.routes.find(item => item.method === 'GET' && item.url.endsWith('/payment-gateway'));
  const put = app.routes.find(item => item.method === 'PUT' && item.url.endsWith('/payment-gateway'));
  const req = { params: { company: 'company-a' }, identity: { id: 'owner-a', role: 'workspace_owner' } };
  const before = await get.handler(req);
  assert.equal(before.connection.credentialAvailable, true);
  assert.deepEqual(before.connection.webhookUrls,
    [`https://order.example.test${PAYMENT_GATEWAY_WEBHOOK_PATH}`]);
  assert.doesNotMatch(JSON.stringify(before), new RegExp(`${apiKey}|${webhookSalt}`));
  const saved = await put.handler({ ...req, body: { expectedVersion: 1, status: 'active',
    providerEnvironment: 'sandbox', accountHint: 'Shop account', secretRef } });
  assert.equal(saved.connection.status, 'active');
  assert.equal(saved.connection.version, 2);
  assert.deepEqual(audits, [{ action: 'Update payment gateway', details: 'HitPay · sandbox · active' }]);
  await assert.rejects(assertOrderHasNoConfirmedOnlinePayment(c, 'company-a', 'order-a'),
    error => error.statusCode === 409 && error.message === 'online_payment_already_confirmed');
});

test('counter tender shares the order-payment lock and stops while hosted checkout is active', async () => {
  const calls = [];
  const c = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/pg_advisory_xact_lock/.test(sql)) return { rows:[{}], rowCount:1 };
    if (/SELECT state FROM myfin\.customer_order_online_payment_state/.test(sql))
      return { rows:[{ state:'pending' }], rowCount:1 };
    throw new Error(`unexpected_sql:${sql}`);
  } };
  await assert.rejects(assertOrderHasNoConfirmedOnlinePayment(c, 'company-a', 'order-a'),
    error => error.statusCode === 409 && error.message === 'online_payment_in_progress');
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.equal(calls[0].params[0], 'online-payment-order:company-a:order-a');
  assert.match(calls[1].sql, /customer_order_online_payment_state/);
});

test('migration stores only opaque credential references and keeps gateway evidence immutable and separate', async () => {
  const [sql, reconciliation] = await Promise.all([
    readFile(new URL('../../db/migrations/0036_payment_gateway.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../db/migrations/0039_payment_gateway_reconciliation.sql', import.meta.url), 'utf8'),
  ]);
  assert.match(sql, /provider_environment IN \('sandbox','production'\)/);
  assert.match(sql, /secret_ref_snapshot/);
  assert.match(sql, /immutable_online_payment_intents/);
  assert.match(sql, /immutable_online_payment_events/);
  assert.match(sql, /online_payment_checkout_request_unique/);
  assert.match(sql, /online_payment_actual_payment_unique/);
  assert.match(sql, /checkout_creation_unknown/);
  assert.match(sql, /payment_reconciliation_required/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION myfin\.protect_customer_order_recipe_reservation/);
  assert.match(sql, /CREATE TABLE myfin\.online_payment_finalizations/);
  assert.match(sql, /immutable_online_payment_finalizations/);
  assert.match(sql, /WHEN finalized\.intent_id IS NOT NULL THEN 'finalized'/);
  assert.match(sql, /THEN 'confirmed_unposted'/);
  const definitions = sql.slice(0, sql.indexOf('COMMENT ON'));
  assert.doesNotMatch(definitions, /^\s*(?:api[_]?key|webhook[_]?salt)\s+/im);
  assert.doesNotMatch(sql, /UPDATE\s+myfin\.(customer_order_requests|transactions)/i);
  assert.match(reconciliation, /checkout_discovered/);
  assert.match(reconciliation, /provider_status_observed/);
  assert.match(reconciliation, /observed\.provider_status='completed' THEN 'reconciliation_required'/);
  assert.match(reconciliation,
    /observed\.provider_status IN \('failed','expired','canceled','inactive'\) THEN 'failed'/);
  assert.match(reconciliation, /event_type IN \('checkout_created','checkout_discovered'\)/);
  assert.doesNotMatch(reconciliation, /UPDATE\s+myfin\.(customer_order_requests|transactions)/i);
});

test('gateway Compose override keeps API and reconciliation worker non-root with the secret-reader group', async () => {
  const [override, example, docs, dockerfile] = await Promise.all([
    readFile(new URL('../../deploy/payment-gateway.override.yml', import.meta.url), 'utf8'),
    readFile(new URL('../../deploy/payment-gateway.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/HITPAY_FOUNDATION.md', import.meta.url), 'utf8'),
    readFile(new URL('../../deploy/api.Dockerfile', import.meta.url), 'utf8'),
  ]);
  assert.match(dockerfile, /^USER node$/m);
  assert.equal((override.match(/PAYMENT_GATEWAY_ENABLED: 'true'/g) || []).length,2);
  assert.equal((override.match(/group_add:\s*\n\s*- \$\{MYFIN_PAYMENT_GATEWAY_SECRET_GID:/g) || []).length,2);
  assert.match(override,/report-worker:[\s\S]*PAYMENT_GATEWAY_SECRET_FILE: \/run\/secrets\/payment_gateway_credentials/);
  assert.doesNotMatch(override, /^\s*user:\s*(?:root|["']?0)/m);
  assert.match(example, /MYFIN_PAYMENT_GATEWAY_SECRET_GID=19000/);
  assert.match(docs, /root:<dedicated-group>.*mode-`0440`/s);
  assert.match(docs, /accessSync\(process\.env\.PAYMENT_GATEWAY_SECRET_FILE/);
  assert.doesNotMatch(docs, /mode-`0400`/);
});
