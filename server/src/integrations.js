import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { owner, requireCapability } from './access.js';
import { GOKOO_MALAYSIA } from './integrations-gokoo.js';
import * as v from './validation.js';

const secretReference = z.string().trim().max(500).regex(
  /^(secretref|vault|file|aws-secretsmanager|gcp-secret-manager|azure-keyvault):\/\/\S+$/,
  'credential_reference_required',
);
const metadataSchema = z.strictObject({
  version: z.number().int().min(0).max(2147483647),
  status: z.enum(['disabled', 'pending']),
  externalAccountId: z.union([z.string().trim().min(1).max(256), z.null()]).optional(),
  credentialRef: z.union([secretReference, z.null()]).optional(),
});
const providerSchema = z.literal('gokoo');
const operationDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
});
const operationsQuerySchema = z.strictObject({
  from: operationDate,
  to: operationDate,
  status: z.enum(['all', 'pending', 'matched', 'mismatch', 'unavailable']).default('all'),
  provider: z.union([z.literal(''), z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/)]).default(''),
});

const providers = Object.freeze([GOKOO_MALAYSIA]);
const providerByKey = key => providers.find(provider => provider.key === key);
const requireOwner = who => { if (!owner(who)) v.fail(403, 'access_denied'); };

function connectionOutput(row, descriptor = providerByKey(row.provider_key)) {
  return {
    id: row.id,
    providerKey: row.provider_key,
    displayName: row.display_name,
    kind: row.integration_kind,
    identityStatus: row.identity_status,
    status: row.status,
    countryCode: row.country_code,
    currencyCode: row.currency_code,
    externalAccountId: row.external_account_id || '',
    credentialConfigured: row.credential_configured === true || !!row.credential_ref,
    capabilities: row.capabilities || descriptor?.capabilities || {},
    version: Number(row.version),
    activationAllowed: descriptor?.activationAllowed === true,
    updatedAt: row.updated_at,
  };
}

function providerOutput(descriptor, connection, summary) {
  return {
    providerKey: descriptor.key,
    displayName: descriptor.displayName,
    kind: descriptor.kind,
    identityStatus: descriptor.identityStatus,
    countryCode: descriptor.countryCode,
    currencyCode: descriptor.currencyCode,
    capabilities: descriptor.capabilities,
    activationAllowed: descriptor.activationAllowed,
    connection: connection ? connectionOutput(connection, descriptor) : {
      id: '', providerKey: descriptor.key, displayName: descriptor.displayName, kind: descriptor.kind,
      identityStatus: descriptor.identityStatus, status: 'disabled', countryCode: descriptor.countryCode,
      currencyCode: descriptor.currencyCode, externalAccountId: '',
      credentialConfigured: false, capabilities: descriptor.capabilities,
      activationAllowed: descriptor.activationAllowed, version: 0, updatedAt: null,
    },
    reconciliation: summary || {
      total: 0, pending: 0, matched: 0, mismatch: 0, unavailable: 0,
      mismatchDifferenceSen: '0', eventCount: 0, financialEntryCount: 0, lastCheckedAt: null,
    },
  };
}

const paymentMethodLabels = Object.freeze({
  cash: 'Cash', qr: 'QR payment', card: 'Card', bank_transfer: 'Bank transfer',
  e_wallet: 'E-wallet', provider_balance: 'Provider balance', other: 'Other', unknown: 'Unknown',
});

export function classifyPaymentMethod(value) {
  const method = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!method) return 'unknown';
  if (method === 'cash' || method === 'money') return 'cash';
  if (method === 'qr' || method === 'qr_pay' || method.includes('duitnow')) return 'qr';
  if (method.includes('card') || ['visa', 'mastercard', 'amex'].includes(method)) return 'card';
  if (method.includes('bank') || method === 'transfer') return 'bank_transfer';
  if (method.includes('wallet') || ['wxpay', 'wechat_pay', 'alipay', 'tng', 'touch_n_go'].includes(method))
    return 'e_wallet';
  if (method.includes('balance')) return 'provider_balance';
  return 'other';
}

function rangeInput(query) {
  const input = v.parse(operationsQuerySchema, query || {});
  const from = Date.parse(`${input.from}T00:00:00.000Z`);
  const to = Date.parse(`${input.to}T00:00:00.000Z`);
  if (from > to || to - from > 366 * 86400000) v.fail(400, 'invalid_payment_operations_range');
  return input;
}

function hint(value, visible = 8) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (input.length <= visible) return `••••${input.slice(-Math.min(4, input.length))}`;
  return `••••${input.slice(-visible)}`;
}

function safeReason(value) {
  const input = String(value || '').trim().toLowerCase();
  const allowed = new Set([
    'amount_mismatch', 'currency_mismatch', 'missing_provider_transaction', 'missing_local_transaction',
    'duplicate_provider_transaction', 'provider_unavailable', 'pending_settlement',
    'unsupported_provider_status', 'manual_review_required',
  ]);
  return allowed.has(input) ? input : (input ? 'details_withheld' : '');
}

function combinePaymentMethods(rows) {
  const methods = new Map();
  for (const row of rows) {
    const key = classifyPaymentMethod(row.method);
    const current = methods.get(key) || {
      key, label:paymentMethodLabels[key], transactionCount:0, amountSen:0n, sources:new Map(),
    };
    const count = Number(row.transaction_count || 0);
    const amount = BigInt(row.amount_sen || 0);
    current.transactionCount += count;
    current.amountSen += amount;
    const source = row.source === 'invoice' ? 'Invoice receipts' : 'POS sales';
    const sourceSummary = current.sources.get(source) || { label:source, transactionCount:0, amountSen:0n };
    sourceSummary.transactionCount += count;
    sourceSummary.amountSen += amount;
    current.sources.set(source, sourceSummary);
    methods.set(key, current);
  }
  return [...methods.values()].map(item => ({
    key:item.key, label:item.label, transactionCount:item.transactionCount,
    amountSen:item.amountSen.toString(),
    sources:[...item.sources.values()].map(source => ({
      ...source, amountSen:source.amountSen.toString(),
    })),
  })).sort((a, b) => b.transactionCount - a.transactionCount || a.label.localeCompare(b.label));
}

function operationConnection(row, descriptor = providerByKey(row.provider_key)) {
  return {
    id:row.id || '', providerKey:row.provider_key, displayName:row.display_name || descriptor?.displayName || row.provider_key,
    kind:row.integration_kind || descriptor?.kind || 'payment_provider',
    identityStatus:row.identity_status || descriptor?.identityStatus || 'candidate_awaiting_confirmation',
    status:row.status || 'disabled', countryCode:row.country_code || descriptor?.countryCode || 'MY',
    currencyCode:row.currency_code || descriptor?.currencyCode || 'MYR',
    externalAccountHint:hint(row.external_account_id, 4), credentialConfigured:row.credential_configured === true,
    activationAllowed:descriptor?.activationAllowed === true,
    reconciliation:{
      total:Number(row.reconciliation_total || 0), pending:Number(row.reconciliation_pending || 0),
      matched:Number(row.reconciliation_matched || 0), mismatch:Number(row.reconciliation_mismatch || 0),
      unavailable:Number(row.reconciliation_unavailable || 0),
      mismatchDifferenceSen:String(row.mismatch_difference_sen || '0'), lastCheckedAt:row.last_checked_at || null,
    },
  };
}

async function paymentOperationsOutput(c, companyId, input) {
  const params = [companyId, input.from, input.to, input.provider, input.status];
  const [connectionRows, methodRows, transactionRows, reconciliationRows, reconciliationSummary] = await Promise.all([
    c.query(`SELECT c.id,c.provider_key,c.integration_kind,c.display_name,c.identity_status,c.status,c.country_code,
      c.currency_code,c.external_account_id,(c.credential_ref IS NOT NULL) AS credential_configured,
      count(r.id)::int AS reconciliation_total,
      count(r.id) FILTER (WHERE r.status='pending')::int AS reconciliation_pending,
      count(r.id) FILTER (WHERE r.status='matched')::int AS reconciliation_matched,
      count(r.id) FILTER (WHERE r.status='mismatch')::int AS reconciliation_mismatch,
      count(r.id) FILTER (WHERE r.status='unavailable')::int AS reconciliation_unavailable,
      coalesce(sum(r.difference_amount_sen) FILTER (WHERE r.status='mismatch'),0)::text AS mismatch_difference_sen,
      max(r.checked_at) AS last_checked_at
      FROM myfin.integration_connections c
      LEFT JOIN myfin.integration_reconciliations r ON r.company_id=c.company_id AND r.connection_id=c.id
        AND (r.checked_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date BETWEEN $2::date AND $3::date
      WHERE c.company_id=$1 GROUP BY c.company_id,c.id ORDER BY c.display_name,c.id`, params.slice(0, 3)),
    c.query(`WITH payment_facts AS (
      SELECT CASE WHEN source='manual_sale' THEN 'manual' ELSE 'pos' END AS source,
        coalesce(nullif(data->>'paymentMethod',''),'Unspecified') AS method,
        round(total*100)::bigint AS amount_sen
      FROM myfin.transactions
      WHERE company_id=$1 AND source IN ('pos','manual_sale') AND data->>'status'='Paid'
        AND (CASE WHEN data->>'businessDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          THEN (data->>'businessDate')::date
          ELSE ((data->>'date')::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur')::date END)
          BETWEEN $2::date AND $3::date
      UNION ALL
      SELECT 'invoice',coalesce(nullif(method,''),'Unspecified'),round(amount*100)::bigint
      FROM myfin.document_payments
      WHERE company_id=$1 AND (paid_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date BETWEEN $2::date AND $3::date
    ) SELECT source,method,count(*)::int AS transaction_count,coalesce(sum(amount_sen),0)::text AS amount_sen
      FROM payment_facts GROUP BY source,method ORDER BY source,method`, params.slice(0, 3)),
    c.query(`SELECT p.id,p.transaction_type,p.payment_method,p.provider_method_code,p.currency_code,
      p.amount_sen::text,p.provider_status,p.occurred_at,p.imported_at,c.provider_key,c.display_name,
      p.external_transaction_key,p.external_order_id
      FROM myfin.integration_payment_transactions p
      JOIN myfin.integration_connections c ON c.company_id=p.company_id AND c.id=p.connection_id
      WHERE p.company_id=$1
        AND (coalesce(p.occurred_at,p.imported_at) AT TIME ZONE 'Asia/Kuala_Lumpur')::date BETWEEN $2::date AND $3::date
        AND ($4='' OR c.provider_key=$4)
      ORDER BY coalesce(p.occurred_at,p.imported_at) DESC,p.id DESC LIMIT 201`, params.slice(0, 4)),
    c.query(`SELECT r.id,r.scope_type,r.currency_code,r.expected_amount_sen::text,r.observed_amount_sen::text,
      r.difference_amount_sen::text,r.status,r.reason,r.checked_at,c.provider_key,c.display_name,
      r.external_reference
      FROM myfin.integration_reconciliations r
      JOIN myfin.integration_connections c ON c.company_id=r.company_id AND c.id=r.connection_id
      WHERE r.company_id=$1 AND (r.checked_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date BETWEEN $2::date AND $3::date
        AND ($4='' OR c.provider_key=$4) AND ($5='all' OR r.status=$5)
      ORDER BY r.checked_at DESC,r.id DESC LIMIT 201`, params),
    c.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE r.status='pending')::int AS pending,
      count(*) FILTER (WHERE r.status='matched')::int AS matched,
      count(*) FILTER (WHERE r.status='mismatch')::int AS mismatch,
      count(*) FILTER (WHERE r.status='unavailable')::int AS unavailable,
      coalesce(sum(r.difference_amount_sen) FILTER (WHERE r.status='mismatch'),0)::text AS mismatch_difference_sen
      FROM myfin.integration_reconciliations r
      JOIN myfin.integration_connections c ON c.company_id=r.company_id AND c.id=r.connection_id
      WHERE r.company_id=$1 AND (r.checked_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date BETWEEN $2::date AND $3::date
        AND ($4='' OR c.provider_key=$4)`, params.slice(0, 4)),
  ]);
  const byProvider = new Map(connectionRows.rows.map(row => [row.provider_key, operationConnection(row)]));
  for (const descriptor of providers) if (!byProvider.has(descriptor.key)) byProvider.set(descriptor.key, operationConnection({
    id:'', provider_key:descriptor.key, display_name:descriptor.displayName, integration_kind:descriptor.kind,
    identity_status:descriptor.identityStatus, status:'disabled', country_code:descriptor.countryCode,
    currency_code:descriptor.currencyCode, external_account_id:'', credential_configured:false,
  }, descriptor));
  const transactions = transactionRows.rows.slice(0, 200).map(row => ({
    id:row.id, providerKey:row.provider_key, providerName:row.display_name,
    transactionType:row.transaction_type, paymentMethod:row.payment_method,
    paymentMethodLabel:paymentMethodLabels[row.payment_method] || paymentMethodLabels.unknown,
    providerMethodCode:row.provider_method_code, currencyCode:row.currency_code,
    amountSen:String(row.amount_sen), providerStatus:row.provider_status,
    transactionReferenceHint:hint(row.external_transaction_key), orderReferenceHint:hint(row.external_order_id),
    occurredAt:row.occurred_at, importedAt:row.imported_at, accountingEffect:'none',
  }));
  const reconciliations = reconciliationRows.rows.slice(0, 200).map(row => ({
    id:row.id, providerKey:row.provider_key, providerName:row.display_name, scopeType:row.scope_type,
    currencyCode:row.currency_code, expectedAmountSen:row.expected_amount_sen,
    observedAmountSen:row.observed_amount_sen, differenceAmountSen:row.difference_amount_sen,
    status:row.status, reasonCode:safeReason(row.reason), referenceHint:hint(row.external_reference),
    checkedAt:row.checked_at,
  }));
  const summaryRow = reconciliationSummary.rows[0] || {};
  return {
    range:{ from:input.from, to:input.to, timeZone:'Asia/Kuala_Lumpur' },
    filters:{ provider:input.provider, status:input.status }, connections:[...byProvider.values()],
    paymentMethods:combinePaymentMethods(methodRows.rows), providerTransactions:transactions, reconciliations,
    reconciliationSummary:{
      total:Number(summaryRow.total || 0), pending:Number(summaryRow.pending || 0),
      matched:Number(summaryRow.matched || 0), mismatch:Number(summaryRow.mismatch || 0),
      unavailable:Number(summaryRow.unavailable || 0),
      mismatchDifferenceSen:String(summaryRow.mismatch_difference_sen || '0'),
    },
    limited:{ providerTransactions:transactionRows.rows.length > 200, reconciliations:reconciliationRows.rows.length > 200 },
    policy:{ providerEvidenceOnly:true, accountingEffect:'none', credentialsExposed:false, gokooActivationAllowed:false },
  };
}

async function integrationOutput(c, companyId) {
  const [connections, reconciliations, evidence] = await Promise.all([
    c.query(`SELECT id,provider_key,integration_kind,display_name,identity_status,status,country_code,currency_code,
      external_account_id,credential_ref,capabilities,version,updated_at
      FROM myfin.integration_connections WHERE company_id=$1 ORDER BY provider_key,integration_kind`, [companyId]),
    c.query(`SELECT connection_id,count(*)::int AS total,
      count(*) FILTER (WHERE status='pending')::int AS pending,
      count(*) FILTER (WHERE status='matched')::int AS matched,
      count(*) FILTER (WHERE status='mismatch')::int AS mismatch,
      count(*) FILTER (WHERE status='unavailable')::int AS unavailable,
      coalesce(sum(difference_amount_sen) FILTER (WHERE status='mismatch'),0)::text AS mismatch_difference_sen,
      max(checked_at) AS last_checked_at
      FROM myfin.integration_reconciliations WHERE company_id=$1 GROUP BY connection_id`, [companyId]),
    c.query(`SELECT connection_id,
      (SELECT count(*)::int FROM myfin.integration_events e WHERE e.company_id=$1 AND e.connection_id=c.id) AS event_count,
      (SELECT count(*)::int FROM myfin.integration_financial_entries f WHERE f.company_id=$1 AND f.connection_id=c.id) AS financial_entry_count
      FROM myfin.integration_connections c WHERE c.company_id=$1`, [companyId]),
  ]);
  const rows = new Map(connections.rows.map(row => [row.provider_key, row]));
  const summaries = new Map(reconciliations.rows.map(row => [row.connection_id, {
    total: Number(row.total), pending: Number(row.pending), matched: Number(row.matched),
    mismatch: Number(row.mismatch), unavailable: Number(row.unavailable),
    mismatchDifferenceSen: String(row.mismatch_difference_sen), lastCheckedAt: row.last_checked_at,
  }]));
  for (const row of evidence.rows) Object.assign(summaries.get(row.connection_id) || (() => {
    const summary = { total:0,pending:0,matched:0,mismatch:0,unavailable:0,mismatchDifferenceSen:'0',lastCheckedAt:null };
    summaries.set(row.connection_id, summary); return summary;
  })(), { eventCount:Number(row.event_count), financialEntryCount:Number(row.financial_entry_count) });
  return {
    providers: providers.map(descriptor => {
      const connection = rows.get(descriptor.key);
      return providerOutput(descriptor, connection, connection ? summaries.get(connection.id) : null);
    }),
    policy: {
      outboundCalls: false, publicWebhooks: false, credentialCapture: false,
      cashRecognition: false, orderMutation: false, stockMutation: false,
    },
  };
}

export function registerIntegrations(app, { db, managed, authorize, managementSession, requirePasswordSession, audit }) {
  app.get('/api/companies/:company/payment-operations', req => {
    requirePasswordSession(req);
    return db.transaction(async c => {
      await managementSession(c, req);
      const companyId = v.parse(v.id, req.params.company);
      await authorize(c, req.identity, companyId);
      requireCapability(req.identity, 'paymentOperationsRead');
      return paymentOperationsOutput(c, companyId, rangeInput(req.query));
    });
  });

  app.get('/api/companies/:company/integrations', req => {
    requirePasswordSession(req);
    return db.transaction(async c => {
      await managementSession(c, req);
      const companyId = v.parse(v.id, req.params.company);
      await authorize(c, req.identity, companyId);
      requireOwner(req.identity);
      return integrationOutput(c, companyId);
    });
  });

  app.put('/api/companies/:company/integrations/:provider', req => managed(req, async (c, who) => {
    const companyId = v.parse(v.id, req.params.company);
    const providerKey = v.parse(providerSchema, req.params.provider);
    const input = v.parse(metadataSchema, req.body);
    await authorize(c, who, companyId);
    requireOwner(who);
    const descriptor = providerByKey(providerKey);
    if (!descriptor) v.fail(404, 'integration_provider_not_found');
    const current = await c.query(`SELECT version FROM myfin.integration_connections
      WHERE company_id=$1 AND provider_key=$2 AND integration_kind=$3 FOR UPDATE`,
    [companyId, descriptor.key, descriptor.kind]);
    if (Number(current.rows[0]?.version || 0) !== input.version) v.fail(409, 'integration_changed');
    const result = await c.query(`INSERT INTO myfin.integration_connections(
      company_id,id,provider_key,integration_kind,display_name,identity_status,status,country_code,currency_code,
      external_account_id,credential_ref,capabilities,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
      ON CONFLICT(company_id,provider_key,integration_kind) DO UPDATE SET
        status=EXCLUDED.status,external_account_id=EXCLUDED.external_account_id,
        credential_ref=EXCLUDED.credential_ref,capabilities=EXCLUDED.capabilities,
        updated_by=EXCLUDED.updated_by,updated_at=now(),version=integration_connections.version+1
      WHERE integration_connections.version=$14
      RETURNING id,provider_key,integration_kind,display_name,identity_status,status,country_code,currency_code,
        external_account_id,credential_ref,capabilities,version,updated_at`, [
      companyId, randomUUID(), descriptor.key, descriptor.kind, descriptor.displayName, descriptor.identityStatus,
      input.status, descriptor.countryCode, descriptor.currencyCode, input.externalAccountId || null,
      input.credentialRef || null, descriptor.capabilities, who.id, input.version,
    ]);
    if (!result.rowCount) v.fail(409, 'integration_changed');
    await audit(c, who, companyId, 'Integration metadata',
      `${descriptor.displayName} · ${input.status} · credential reference ${input.credentialRef ? 'configured' : 'not configured'}`);
    return connectionOutput(result.rows[0], descriptor);
  }));
}
