import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  COMMERCE_CHANNEL_CONTRACT, PAYMENT_PROVIDER_CONTRACT, definePaymentProvider, INTEGRATION_KINDS,
} from '../src/integrations-contracts.js';
import {
  GOKOO_MALAYSIA, decimalStringToSen, mapGokooOrderStatus, mapGokooPaymentCode,
  normalizeGokooMalaysiaFinancials, normalizeGokooMalaysiaOrder,
} from '../src/integrations-gokoo.js';
import { classifyPaymentMethod, registerIntegrations } from '../src/integrations.js';

test('commerce-channel and payment-provider contracts have separate responsibilities', () => {
  assert.equal(GOKOO_MALAYSIA.kind, INTEGRATION_KINDS.COMMERCE_CHANNEL);
  assert.ok(COMMERCE_CHANNEL_CONTRACT.responsibilities.includes('orders'));
  assert.ok(COMMERCE_CHANNEL_CONTRACT.forbiddenResponsibilities.includes('payment_capture'));
  assert.ok(PAYMENT_PROVIDER_CONTRACT.responsibilities.includes('payment_capture'));
  assert.ok(PAYMENT_PROVIDER_CONTRACT.forbiddenResponsibilities.includes('order_fulfillment'));
  const payments = definePaymentProvider({ key:'example', kind:'payment_provider', capabilities:{} });
  assert.equal(payments.contract, PAYMENT_PROVIDER_CONTRACT);
  assert.throws(() => definePaymentProvider({ key:'wrong', kind:'commerce_channel', capabilities:{} }), /kind_mismatch/);
  assert.equal(GOKOO_MALAYSIA.activationAllowed, false);
  assert.equal(GOKOO_MALAYSIA.capabilities.paymentGateway, 'not_established');
});

test('decimal money parsing is exact and rejects ambiguous numeric inputs', () => {
  assert.equal(decimalStringToSen('0'), 0);
  assert.equal(decimalStringToSen('19.91'), 1991);
  assert.equal(decimalStringToSen('187.60'), 18760);
  assert.equal(decimalStringToSen('-1.25', { allowNegative:true }), -125);
  for (const value of [19.91, '1.001', '-1', 'NaN', '1e3', '', '  '])
    assert.throws(() => decimalStringToSen(value));
});

test('payment method classification keeps operational methods distinct', () => {
  assert.equal(classifyPaymentMethod('Cash'), 'cash');
  assert.equal(classifyPaymentMethod('QR Pay'), 'qr');
  assert.equal(classifyPaymentMethod('DuitNow QR'), 'qr');
  assert.equal(classifyPaymentMethod('Credit card'), 'card');
  assert.equal(classifyPaymentMethod('Bank transfer'), 'bank_transfer');
  assert.equal(classifyPaymentMethod('Touch n Go'), 'e_wallet');
  assert.equal(classifyPaymentMethod('WeChat Pay'), 'e_wallet');
  assert.equal(classifyPaymentMethod(''), 'unknown');
});

test('Gokoo Malaysia financial fields normalize to integer sen while the misleading commission-ratio field stays ambiguous', () => {
  const normalized = normalizeGokooMalaysiaFinancials({ data:{ items:[
    { fields:'order_total_amount', amount:'123.49', items:[
      { fields:'products_total_price', amount:'120.50' },
      { fields:'user_delivery_fee', amount:'2.99' },
    ] },
    { fields:'platform_commission_ratio', amount:'30.13', items:[] },
    { fields:'shop_real_revenue_amount', amount:'84.97', items:[] },
    { fields:'future_field', amount:'1.00', items:[] },
  ] } }, { currencyCode:'MYR' });
  assert.deepEqual(normalized.amountsSen, {
    orderTotal:12349, productsTotal:12050, userDeliveryFee:299, merchantActualReceivable:8497,
  });
  assert.equal(normalized.entries.some(entry => entry.providerField === 'platform_commission_ratio'), false);
  assert.deepEqual(normalized.ambiguousFields, [{
    providerField:'platform_commission_ratio', rawValue:'30.13',
    reason:'field_name_indicates_ratio_but_documentation_labels_value_as_amount',
  }]);
  assert.deepEqual(normalized.unknownFields, ['future_field']);
  assert.equal(normalized.accountingEffect, 'none');
  assert.throws(() => normalizeGokooMalaysiaFinancials([], {}), /explicit_myr/);
  assert.throws(() => normalizeGokooMalaysiaFinancials([
    { fields:'order_total_amount', amount:'1.00' }, { fields:'order_total_amount', amount:'1.00' },
  ], { currencyCode:'MYR' }), /duplicate/);
});

test('Gokoo order mapping omits customer PII and does not treat a payment label as settlement evidence', () => {
  const order = normalizeGokooMalaysiaOrder({ data:{
    order_id:'5208510', order_sn:'GK-1', shop_id:'shop-7', order_status:'WAIT_MERCHANT_CONFIRM',
    pay_status:'paid', amount:'19.91', pay_code:'wxpay', contact:'Private Person', mobile:'0123456789', addr:'Private address',
  } }, { currencyCode:'MYR' });
  assert.equal(order.orderTotalSen, 1991);
  assert.deepEqual(order.payment, {
    providerCode:'wxpay', method:'wechat_pay', paymentProviderEvidence:false, accountingEffect:'none',
  });
  assert.doesNotMatch(JSON.stringify(order), /Private Person|0123456789|Private address/);
  assert.equal(mapGokooPaymentCode('cash').accountingEffect, 'none');
  assert.deepEqual(mapGokooOrderStatus('ORDER_REFUNDED'), { providerStatus:'ORDER_REFUNDED', status:'refunded' });
  assert.throws(() => normalizeGokooMalaysiaOrder({ data:{ order_id:'1', shop_id:'2', amount:19.91 } }, { currencyCode:'MYR' }), /money_string/);
});

function routesFor({ currentVersion = 0, who = { id:'owner', role:'workspace_owner' } } = {}) {
  const routes = new Map(), calls = [], audits = [];
  const connection = {
    id:'connection-1', provider_key:'gokoo', integration_kind:'commerce_channel', display_name:'Gokoo / 悟空海外',
    identity_status:'candidate_awaiting_confirmation', status:'pending', country_code:'MY', currency_code:'MYR',
    external_account_id:'merchant-1', credential_ref:'vault://myfin/gokoo', capabilities:GOKOO_MALAYSIA.capabilities,
    version:currentVersion + 1, updated_at:'2026-10-09T00:00:00.000Z',
  };
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('SELECT version FROM myfin.integration_connections'))
      return { rows:currentVersion ? [{ version:currentVersion }] : [], rowCount:currentVersion ? 1 : 0 };
    if (sql.includes('INSERT INTO myfin.integration_connections')) return { rows:[connection], rowCount:1 };
    if (sql.includes('FROM myfin.integration_reconciliations')) return { rows:[], rowCount:0 };
    if (sql.includes('AS event_count')) return { rows:[], rowCount:0 };
    if (sql.includes('FROM myfin.integration_connections')) return { rows:[], rowCount:0 };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    put(path, handler) { routes.set(`PUT ${path}`, handler); },
  };
  registerIntegrations(app, {
    db:{ transaction:fn => fn(client) },
    managed:(req, fn) => fn(client, { ...who }),
    authorize:async (_c, actor, companyId) => { actor.company_id = companyId; },
    managementSession:async () => {}, requirePasswordSession:() => {},
    audit:async (_c, _actor, companyId, action, details) => audits.push({ companyId, action, details }),
  });
  return { routes, calls, audits };
}

test('owner-only integration read returns a disabled Gokoo candidate and explicit no-side-effect policy', async () => {
  const { routes } = routesFor();
  const result = await routes.get('GET /api/companies/:company/integrations')({
    params:{ company:'company-a' }, identity:{ id:'owner', role:'workspace_owner' }, authLevel:'password',
  });
  assert.equal(result.providers[0].connection.status, 'disabled');
  assert.equal(result.providers[0].connection.version, 0);
  assert.equal(result.providers[0].identityStatus, 'candidate_awaiting_confirmation');
  assert.deepEqual(result.policy, {
    outboundCalls:false, publicWebhooks:false, credentialCapture:false,
    cashRecognition:false, orderMutation:false, stockMutation:false,
  });
  const manager = routesFor({ who:{ id:'manager', role:'manager' } });
  await assert.rejects(manager.routes.get('GET /api/companies/:company/integrations')({
    params:{ company:'company-a' }, identity:{ id:'manager', role:'manager' }, authLevel:'password',
  }), error => error.statusCode === 403 && error.message === 'access_denied');
});

test('metadata update stores a credential reference only and enforces optimistic versions', async () => {
  const fresh = routesFor();
  const update = fresh.routes.get('PUT /api/companies/:company/integrations/:provider');
  const req = body => ({ params:{ company:'company-a', provider:'gokoo' }, body, authLevel:'password' });
  const saved = await update(req({ version:0, status:'pending', externalAccountId:'merchant-1', credentialRef:'vault://myfin/gokoo' }));
  assert.equal(saved.version, 1);
  assert.equal(saved.credentialConfigured, true);
  assert.equal(Object.hasOwn(saved, 'credentialRef'), false);
  assert.doesNotMatch(JSON.stringify(saved), /vault:\/\//);
  assert.equal(fresh.audits[0].details.includes('vault://'), false);
  await assert.rejects(update(req({ version:0, status:'active' })), error => error.statusCode === 400);
  await assert.rejects(update(req({ version:0, status:'pending', appSecret:'do-not-store' })), error => error.statusCode === 400);
  await assert.rejects(update(req({ version:0, status:'pending', credentialRef:'literal-secret' })), error => error.statusCode === 400);
  const stale = routesFor({ currentVersion:3 });
  await assert.rejects(stale.routes.get('PUT /api/companies/:company/integrations/:provider')(
    req({ version:2, status:'pending' })), error => error.statusCode === 409 && error.message === 'integration_changed');
  const invalidCreateVersion = routesFor();
  await assert.rejects(invalidCreateVersion.routes.get('PUT /api/companies/:company/integrations/:provider')(
    req({ version:1, status:'pending' })), error => error.statusCode === 409);
});

function paymentOperationsRoutes({ who = { id:'manager', role:'manager' } } = {}) {
  const routes = new Map(), calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('LEFT JOIN myfin.integration_reconciliations r')) return { rows:[{
      id:'connection-1', provider_key:'gokoo', integration_kind:'commerce_channel',
      display_name:'Gokoo / 悟空海外', identity_status:'candidate_awaiting_confirmation', status:'disabled',
      country_code:'MY', currency_code:'MYR', external_account_id:'merchant-secret-7788',
      credential_configured:true, reconciliation_total:2, reconciliation_pending:0,
      reconciliation_matched:1, reconciliation_mismatch:1, reconciliation_unavailable:0,
      mismatch_difference_sen:'-5', last_checked_at:'2026-10-09T00:00:00.000Z',
    }] };
    if (sql.includes('WITH payment_facts AS')) return { rows:[
      { source:'pos', method:'QR Pay', transaction_count:2, amount_sen:'9007199254740991' },
      { source:'invoice', method:'DuitNow QR', transaction_count:1, amount_sen:'9' },
      { source:'pos', method:'Cash', transaction_count:3, amount_sen:'3200' },
    ] };
    if (sql.includes('FROM myfin.integration_payment_transactions p')) return { rows:[{
      id:'provider-payment-1', transaction_type:'capture', payment_method:'e_wallet', provider_method_code:'wxpay',
      currency_code:'MYR', amount_sen:'1991', provider_status:'PAID', occurred_at:'2026-10-08T12:00:00.000Z',
      imported_at:'2026-10-08T12:01:00.000Z', provider_key:'gokoo', display_name:'Gokoo / 悟空海外',
      external_transaction_key:'provider-transaction-private-12345678', external_order_id:'order-private-87654321',
    }] };
    if (sql.includes('SELECT r.id,r.scope_type')) return { rows:[{
      id:'reconciliation-1', scope_type:'external_order', currency_code:'MYR', expected_amount_sen:'1991',
      observed_amount_sen:'1986', difference_amount_sen:'-5', status:'mismatch',
      reason:'token=credential-should-not-leak', checked_at:'2026-10-09T00:00:00.000Z',
      provider_key:'gokoo', display_name:'Gokoo / 悟空海外', external_reference:'provider-order-private-87654321',
    }] };
    if (sql.includes('SELECT count(*)::int AS total')) return { rows:[{
      total:2, pending:0, matched:1, mismatch:1, unavailable:0, mismatch_difference_sen:'-5',
    }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const app = { get(path, handler) { routes.set(`GET ${path}`, handler); }, put() {} };
  registerIntegrations(app, {
    db:{ transaction:fn => fn(client) }, managed:() => {}, authorize:async () => {},
    managementSession:async () => {}, requirePasswordSession:() => {}, audit:async () => {},
  });
  const request = query => ({
    params:{ company:'company-a' }, query, identity:{ ...who }, authLevel:'password',
  });
  return { routes, calls, request };
}

test('payment operations gives managers exact, tenant-scoped and credential-free evidence', async () => {
  const { routes, calls, request } = paymentOperationsRoutes();
  const result = await routes.get('GET /api/companies/:company/payment-operations')(
    request({ from:'2026-10-01', to:'2026-10-09', status:'all', provider:'' }),
  );
  assert.equal(result.connections[0].externalAccountHint, '••••7788');
  assert.equal(result.connections[0].credentialConfigured, true);
  assert.equal(result.connections[0].activationAllowed, false);
  assert.deepEqual(result.paymentMethods.find(item => item.key === 'qr'), {
    key:'qr', label:'QR payment', transactionCount:3, amountSen:'9007199254741000',
    sources:[
      { label:'POS sales', transactionCount:2, amountSen:'9007199254740991' },
      { label:'Invoice receipts', transactionCount:1, amountSen:'9' },
    ],
  });
  assert.equal(result.providerTransactions[0].transactionReferenceHint, '••••12345678');
  assert.equal(result.providerTransactions[0].accountingEffect, 'none');
  assert.equal(result.reconciliations[0].reasonCode, 'details_withheld');
  assert.equal(result.reconciliations[0].referenceHint, '••••87654321');
  assert.deepEqual(result.policy, {
    providerEvidenceOnly:true, accountingEffect:'none', credentialsExposed:false, gokooActivationAllowed:false,
  });
  assert.doesNotMatch(JSON.stringify(result), /merchant-secret|credential-should-not-leak|private-/);
  assert.ok(calls.every(call => call.params[0] === 'company-a'));
  assert.ok(calls.every(call => /company_id=\$1|company_id = \$1|c\.company_id=\$1|p\.company_id=\$1|r\.company_id=\$1/.test(call.sql)));
});

test('payment operations rejects operators and unbounded or reversed ranges', async () => {
  const operatorRoutes = paymentOperationsRoutes({ who:{ id:'operator', role:'operator' } });
  const route = operatorRoutes.routes.get('GET /api/companies/:company/payment-operations');
  await assert.rejects(route(operatorRoutes.request({
    from:'2026-10-01', to:'2026-10-09', status:'all', provider:'',
  })), error => error.statusCode === 403 && error.message === 'access_denied');
  const managerRoutes = paymentOperationsRoutes();
  const managerRoute = managerRoutes.routes.get('GET /api/companies/:company/payment-operations');
  await assert.rejects(managerRoute(managerRoutes.request({
    from:'2026-10-10', to:'2026-10-09', status:'all', provider:'',
  })), error => error.statusCode === 400 && error.message === 'invalid_payment_operations_range');
  await assert.rejects(managerRoute(managerRoutes.request({
    from:'2025-01-01', to:'2026-10-09', status:'all', provider:'',
  })), error => error.statusCode === 400 && error.message === 'invalid_payment_operations_range');
});

test('integration migration enforces tenant idempotency, immutable evidence, exact sen and explicit reconciliation states', async () => {
  const sql = await readFile(new URL('../../db/migrations/0021_integration_reconciliation.sql', import.meta.url), 'utf8');
  for (const table of ['integration_connections','integration_events','integration_financial_entries','integration_reconciliations'])
    assert.match(sql, new RegExp(`CREATE TABLE myfin\\.${table}`));
  assert.match(sql, /UNIQUE \(company_id,connection_id,provider_event_key\)/);
  assert.match(sql, /UNIQUE \(company_id,connection_id,external_financial_key\)/);
  assert.match(sql, /UNIQUE \(company_id,connection_id,reconciliation_key\)/);
  assert.match(sql, /amount_sen bigint NOT NULL/);
  assert.match(sql, /accounting_effect text NOT NULL DEFAULT 'none' CHECK \(accounting_effect='none'\)/);
  assert.match(sql, /status IN \('matched','mismatch'\) AND expected_amount_sen IS NOT NULL AND observed_amount_sen IS NOT NULL/);
  assert.match(sql, /status IN \('pending','unavailable'\) AND expected_amount_sen IS NULL AND observed_amount_sen IS NULL/);
  assert.match(sql, /version integer NOT NULL DEFAULT 1 CHECK \(version > 0\)/);
  assert.equal((sql.match(/EXECUTE FUNCTION myfin\.protect_integration_evidence/g) || []).length, 6);
  for (const [file, role] of [['grant-development-runtime.sql','myfin_dev_runtime'],['grant-production-runtime.sql','myfin_prod_runtime']]) {
    const grants = await readFile(new URL(`../../db/${file}`, import.meta.url), 'utf8');
    assert.match(grants, new RegExp(`GRANT SELECT,INSERT,UPDATE ON myfin\\.integration_connections TO ${role}`));
    assert.match(grants, new RegExp(`GRANT SELECT ON myfin\\.integration_events,myfin\\.integration_financial_entries,myfin\\.integration_reconciliations TO ${role}`));
    assert.doesNotMatch(grants, new RegExp(`GRANT SELECT,INSERT(?:,UPDATE)? ON myfin\\.integration_events`));
  }
});

test('payment operations migration keeps normalized provider transactions immutable and non-accounting', async () => {
  const sql = await readFile(new URL('../../db/migrations/0026_payment_operations.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE myfin\.integration_payment_transactions/);
  assert.match(sql, /UNIQUE \(company_id,connection_id,external_transaction_key\)/);
  assert.match(sql, /amount_sen bigint NOT NULL/);
  assert.match(sql, /accounting_effect text NOT NULL DEFAULT 'none' CHECK \(accounting_effect='none'\)/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON myfin\.integration_payment_transactions/);
  assert.match(sql, /BEFORE TRUNCATE ON myfin\.integration_payment_transactions/);
  assert.match(sql, /REVOKE ALL ON myfin\.integration_payment_transactions FROM PUBLIC/);
  assert.doesNotMatch(sql, /payload\s+jsonb|credential_ref\s+text|customer_name\s+text|customer_email\s+text|customer_phone\s+text/i);
});
