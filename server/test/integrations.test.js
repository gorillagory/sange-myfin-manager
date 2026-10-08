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
import { registerIntegrations } from '../src/integrations.js';

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
  assert.equal(saved.credentialRef, 'vault://myfin/gokoo');
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
