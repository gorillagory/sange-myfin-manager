import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { owner } from './access.js';
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
    credentialRef: row.credential_ref || '',
    credentialConfigured: !!row.credential_ref,
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
      currencyCode: descriptor.currencyCode, externalAccountId: '', credentialRef: '',
      credentialConfigured: false, capabilities: descriptor.capabilities,
      activationAllowed: descriptor.activationAllowed, version: 0, updatedAt: null,
    },
    reconciliation: summary || {
      total: 0, pending: 0, matched: 0, mismatch: 0, unavailable: 0,
      mismatchDifferenceSen: '0', eventCount: 0, financialEntryCount: 0, lastCheckedAt: null,
    },
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
