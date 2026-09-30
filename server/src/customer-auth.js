import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { z } from 'zod';
import { normalizeHostname } from './tenancy.js';
import { requirePublishedStorefrontPrivacy } from './storefront-privacy.js';
import * as v from './validation.js';

const scrypt = promisify(scryptCallback);
const sharedCookieName = '__Secure-myfin_customer_session';
const hostCookieName = '__Host-myfin_customer_session';
const sessionSeconds = 30 * 24 * 60 * 60;
const marketingNoticeVersion = 'myfin-marketing-v1';
const scryptParameters = Object.freeze({ N: 65536, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
const maxConcurrentKdfs = 2, maxQueuedKdfs = 8;
let activeKdfs = 0;
const kdfQueue = [];
const dummyEncoded = 'scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA$WXPLnTOvPfDYqb3uz0CdliKtVQWCNwvKSgLupRtx5VEl3o0_PRNDYBi2N71XfwplJOCTgWw3Xc2KKNLUB_LACA';
const dummySalt = Buffer.from('AAAAAAAAAAAAAAAAAAAAAA', 'base64url');
const dummyHash = Buffer.from('WXPLnTOvPfDYqb3uz0CdliKtVQWCNwvKSgLupRtx5VEl3o0_PRNDYBi2N71XfwplJOCTgWw3Xc2KKNLUB_LACA', 'base64url');

const emailSchema = z.email().max(254).transform(value => value.trim().toLowerCase());
const passwordSchema = z.string().min(12).max(128);
const phoneSchema = z.string().trim().max(24).refine(value => value === '' ||
  (value.length >= 7 && /^\+?[0-9 ()-]+$/.test(value) && /\d/.test(value)), 'invalid_phone').default('');
const registrationSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(120),
  phone: phoneSchema,
  adultConfirmed: z.literal(true),
});
const signInSchema = z.strictObject({ email: emailSchema, password: passwordSchema });
const profileSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(120),
  phone: phoneSchema,
});
const consentSchema = z.strictObject({
  channel: z.enum(['email', 'sms', 'whatsapp']),
  granted: z.boolean(),
});

const digest = value => createHash('sha256').update(value).digest('hex');
const sessionDigest = token => digest(`myfin-customer-session:${token}`);
const normalizedIp = value => String(value || '').replace(/^::ffff:/, '');

async function acquireKdfSlot() {
  if (activeKdfs < maxConcurrentKdfs) { activeKdfs += 1; return; }
  if (kdfQueue.length >= maxQueuedKdfs) v.fail(429, 'customer_authentication_busy');
  await new Promise(resolve => kdfQueue.push(resolve));
}

function releaseKdfSlot() {
  const next = kdfQueue.shift();
  if (next) next();
  else activeKdfs -= 1;
}

async function boundedScrypt(password, salt, length) {
  await acquireKdfSlot();
  try { return await scrypt(password, salt, length, scryptParameters); }
  finally { releaseKdfSlot(); }
}

function publicRateKey(req, authOptions = {}) {
  const remote = normalizedIp(req.socket?.remoteAddress || req.ip);
  if ((authOptions.publicProxyAddresses || []).includes(remote)) {
    const forwarded = Array.isArray(req.headers['x-myfin-client-ip']) ? '' : normalizedIp(req.headers['x-myfin-client-ip']);
    if (isIP(forwarded)) return forwarded;
  }
  return remote || 'unknown';
}

function publicContext(req) {
  if (req.tenant?.surface !== 'storefront') v.fail(404, 'not_found');
  return req.tenant;
}

function cookieValues(header) {
  const values = {};
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (name !== sharedCookieName && name !== hostCookieName) continue;
    try { values[name] = decodeURIComponent(part.slice(at + 1).trim()); } catch { values[name] = ''; }
  }
  return [...new Set([values[sharedCookieName], values[hostCookieName]].filter(Boolean))];
}

export function customerCookieDomain(hostname, rootDomain) {
  const host = normalizeHostname(hostname);
  const root = normalizeHostname(rootDomain);
  if (!host || !root || isIP(root) || root === 'localhost' || root.split('.').length < 2) return '';
  return host === root || host.endsWith(`.${root}`) ? root : '';
}

export function customerCookieHeader(token, hostname, rootDomain, maxAge = sessionSeconds) {
  const domain = customerCookieDomain(hostname, rootDomain);
  const name = domain ? sharedCookieName : hostCookieName;
  return `${name}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax${domain ? `; Domain=${domain}` : ''}`;
}

export async function hashCustomerPassword(password) {
  const value = v.parse(passwordSchema, password);
  const salt = randomBytes(16);
  const key = await boundedScrypt(value, salt, 64);
  return `scrypt$${scryptParameters.N}$${scryptParameters.r}$${scryptParameters.p}$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`;
}

export async function verifyCustomerPassword(password, encoded) {
  const parts = String(encoded || '').split('$');
  const selected = parts.length === 6 && parts[0] === 'scrypt' ? parts : dummyEncoded.split('$');
  const [_, rawN, rawR, rawP, rawSalt, rawHash] = selected;
  const N = Number(rawN), r = Number(rawR), p = Number(rawP);
  let salt, expected;
  try { salt = Buffer.from(rawSalt, 'base64url'); expected = Buffer.from(rawHash, 'base64url'); }
  catch { salt = dummySalt; expected = dummyHash; }
  const parametersValid = N === scryptParameters.N && r === scryptParameters.r && p === scryptParameters.p &&
    salt.length === 16 && expected.length === 64;
  if (!parametersValid) { salt = dummySalt; expected = dummyHash; }
  const actual = Buffer.from(await boundedScrypt(String(password), salt, expected.length));
  return parametersValid && timingSafeEqual(actual, expected);
}

async function createSession(c, customerId) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sessionDigest(token);
  await c.query(
    `INSERT INTO myfin.customer_sessions(token_digest,customer_id,expires_at)
     VALUES($1,$2,now()+interval '30 days')`, [tokenHash, customerId],
  );
  await c.query(
    `UPDATE myfin.customer_sessions SET revoked_at=coalesce(revoked_at,now())
      WHERE customer_id=$1 AND revoked_at IS NULL AND expires_at>now() AND token_digest IN (
        SELECT token_digest FROM myfin.customer_sessions WHERE customer_id=$1
          AND revoked_at IS NULL AND expires_at>now()
        ORDER BY created_at DESC,token_digest DESC OFFSET 10
      )`, [customerId],
  );
  return token;
}

export async function customerSession(c, req, touch = true) {
  const tokenHashes = cookieValues(req.headers.cookie)
    .filter(token => /^[A-Za-z0-9_-]{43}$/.test(token)).map(sessionDigest);
  if (!tokenHashes.length) return null;
  const row = (await c.query(
    `SELECT s.token_digest,s.customer_id,s.expires_at,a.display_name,a.primary_email,a.email_verified_at,
            a.adult_confirmed_at
       FROM myfin.customer_sessions s
       JOIN myfin.customer_accounts a ON a.id=s.customer_id
      WHERE s.token_digest=ANY($1::text[]) AND s.revoked_at IS NULL AND s.expires_at>now()
        AND a.disabled_at IS NULL
      ORDER BY array_position($1::text[],s.token_digest) LIMIT 1`,
    [tokenHashes],
  )).rows[0];
  if (!row) return null;
  if (touch) await c.query(
    `UPDATE myfin.customer_sessions SET last_seen_at=now()
      WHERE token_digest=$1 AND last_seen_at<now()-interval '5 minutes'`, [row.token_digest],
  );
  return {
    digest: row.token_digest, customerId: row.customer_id, displayName: row.display_name || '',
    email: row.primary_email || '', emailVerified: Boolean(row.email_verified_at),
    adultConfirmed: Boolean(row.adult_confirmed_at), expiresAt: row.expires_at,
  };
}

export async function customerOrderDefaults(c, workspaceId, session) {
  if (!session) return { customerId: null, name: '', email: '', phone: '' };
  const profile = (await c.query(
    `SELECT display_name,phone FROM myfin.customer_workspace_profiles
      WHERE workspace_id=$1 AND customer_id=$2`, [workspaceId, session.customerId],
  )).rows[0];
  return { customerId: session.customerId, name: profile?.display_name || session.displayName,
    email: session.email, phone: profile?.phone || '' };
}

async function mePayload(c, context, session) {
  const profile = (await c.query(
    `SELECT display_name,phone FROM myfin.customer_workspace_profiles
      WHERE workspace_id=$1 AND customer_id=$2`, [context.workspace_id, session.customerId],
  )).rows[0];
  const settings = (await c.query(
    `SELECT enabled,stamps_required,reward_label,minimum_spend FROM myfin.workspace_loyalty_settings
      WHERE workspace_id=$1`, [context.workspace_id],
  )).rows[0];
  const loyalty = (await c.query(
    `SELECT stamp_balance FROM myfin.customer_loyalty_accounts
      WHERE workspace_id=$1 AND customer_id=$2`, [context.workspace_id, session.customerId],
  )).rows[0];
  const consentRows = (await c.query(
    `SELECT DISTINCT ON (channel) channel,granted,notice_version,created_at
       FROM myfin.customer_consent_events
      WHERE workspace_id=$1 AND customer_id=$2 AND purpose='marketing'
      ORDER BY channel,created_at DESC,id DESC`, [context.workspace_id, session.customerId],
  )).rows;
  const consent = Object.fromEntries(['email','sms','whatsapp'].map(channel => {
    const row = consentRows.find(item => item.channel === channel);
    return [channel, { granted: Boolean(row?.granted), noticeVersion: row?.notice_version || '',
      updatedAt: row?.created_at || null }];
  }));
  return {
    authenticated: true,
    customer: { id: session.customerId, displayName: session.displayName,
      email: session.email, emailVerified: session.emailVerified,
      adultConfirmed: session.adultConfirmed !== false },
    profile: { workspaceId: context.workspace_id,
      displayName: profile?.display_name || session.displayName, phone: profile?.phone || '' },
    marketingNoticeVersion,
    marketingConsent: consent,
    loyalty: { workspaceId: context.workspace_id, enabled: settings?.enabled ?? true,
      stampsRequired: Number(settings?.stamps_required ?? 10), rewardLabel: settings?.reward_label || 'Reward',
      minimumSpend: Number(settings?.minimum_spend ?? 0), stampBalance: Number(loyalty?.stamp_balance ?? 0),
      earnRule: 'one_stamp_per_eligible_paid_order' },
  };
}

export function registerCustomerAccounts(app, { db, authOptions }) {
  const rate = max => ({ max, timeWindow: 60000, keyGenerator: req => publicRateKey(req, authOptions) });

  app.post('/api/public/customer/register', { config: { rateLimit: rate(5) } }, async (req, reply) => {
    const context = publicContext(req), input = v.parse(registrationSchema, req.body);
    return db.transaction(async c => {
      await requirePublishedStorefrontPrivacy(c, context.company_id);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,19))', [`customer-email:${input.email}`]);
      if ((await c.query('SELECT 1 FROM myfin.customer_accounts WHERE lower(primary_email)=$1', [input.email])).rowCount)
        v.fail(409, 'customer_account_unavailable');
      const customerId = randomUUID(), passwordHash = await hashCustomerPassword(input.password);
      await c.query(
        `INSERT INTO myfin.customer_accounts(id,display_name,primary_email,adult_confirmed_at)
         VALUES($1,$2,$3,now())`,
        [customerId, input.displayName, input.email],
      );
      await c.query(
        `INSERT INTO myfin.customer_credentials(customer_id,password_hash) VALUES($1,$2)`,
        [customerId, passwordHash],
      );
      await c.query(
        `INSERT INTO myfin.customer_identities(issuer,subject,customer_id,provider)
         VALUES('urn:myfin:customer:local',$1,$1,'password')`, [customerId],
      );
      await c.query(
        `INSERT INTO myfin.customer_workspace_profiles(workspace_id,customer_id,display_name,phone)
         VALUES($1,$2,$3,$4)`, [context.workspace_id, customerId, input.displayName, input.phone],
      );
      const token = await createSession(c, customerId);
      reply.header('Set-Cookie', customerCookieHeader(token, context.hostname, authOptions.rootDomain));
      reply.code(201);
      return mePayload(c, context, { customerId, displayName: input.displayName,
        email: input.email, emailVerified: false, adultConfirmed: true });
    });
  });

  app.post('/api/public/customer/sign-in', { config: { rateLimit: rate(8) } }, async (req, reply) => {
    const context = publicContext(req), input = v.parse(signInSchema, req.body);
    const result = await db.transaction(async c => {
      const row = (await c.query(
        `SELECT a.id,a.display_name,a.primary_email,a.email_verified_at,a.adult_confirmed_at,a.disabled_at,
                x.password_hash,x.failed_attempts,x.locked_until
           FROM myfin.customer_accounts a
           JOIN myfin.customer_credentials x ON x.customer_id=a.id
          WHERE lower(a.primary_email)=$1 FOR UPDATE OF x`, [input.email],
      )).rows[0];
      const validPassword = await verifyCustomerPassword(input.password, row?.password_hash);
      const locked = row?.locked_until && new Date(row.locked_until) > new Date();
      if (!row || !validPassword || row.disabled_at || locked) {
        if (row && !locked) await c.query(
          `UPDATE myfin.customer_credentials SET
             failed_attempts=failed_attempts+1,
             locked_until=CASE WHEN failed_attempts+1>=5 THEN now()+interval '15 minutes' ELSE NULL END,
             updated_at=now()
           WHERE customer_id=$1`, [row.id],
        );
        // Return a sentinel so the failed-attempt update commits. Throwing here
        // would roll the transaction back and make the lockout ineffective.
        return { authenticationFailed: true };
      }
      await c.query(
        `UPDATE myfin.customer_credentials SET failed_attempts=0,locked_until=NULL,last_used_at=now(),updated_at=now()
          WHERE customer_id=$1`, [row.id],
      );
      const token = await createSession(c, row.id);
      return { token, payload: await mePayload(c, context, { customerId: row.id, displayName: row.display_name || '',
        email: row.primary_email || '', emailVerified: Boolean(row.email_verified_at),
        adultConfirmed: Boolean(row.adult_confirmed_at) }) };
    });
    if (result.authenticationFailed) v.fail(401, 'customer_authentication_failed');
    reply.header('Set-Cookie', customerCookieHeader(result.token, context.hostname, authOptions.rootDomain));
    return result.payload;
  });

  app.post('/api/public/customer/sign-out', { config: { rateLimit: rate(30) } }, async (req, reply) => {
    const context = publicContext(req);
    await db.transaction(async c => {
      const tokenHashes = cookieValues(req.headers.cookie)
        .filter(token => /^[A-Za-z0-9_-]{43}$/.test(token)).map(sessionDigest);
      if (tokenHashes.length) await c.query(
        `UPDATE myfin.customer_sessions SET revoked_at=coalesce(revoked_at,now())
          WHERE token_digest=ANY($1::text[])`, [tokenHashes],
      );
    });
    reply.header('Set-Cookie', customerCookieHeader('', context.hostname, authOptions.rootDomain, 0));
    return { ok: true };
  });

  app.get('/api/public/customer/me', { config: { rateLimit: rate(120) } }, async req => {
    const context = publicContext(req);
    return db.transaction(async c => {
      const session = await customerSession(c, req);
      return session ? mePayload(c, context, session) : { authenticated: false };
    });
  });

  app.put('/api/public/customer/profile', { config: { rateLimit: rate(20) } }, async req => {
    const context = publicContext(req), input = v.parse(profileSchema, req.body);
    return db.transaction(async c => {
      await requirePublishedStorefrontPrivacy(c, context.company_id);
      const session = await customerSession(c, req);
      if (!session) v.fail(401, 'customer_session_required');
      await c.query(`UPDATE myfin.customer_accounts SET display_name=$2,updated_at=now() WHERE id=$1`,
        [session.customerId, input.displayName]);
      await c.query(
        `INSERT INTO myfin.customer_workspace_profiles(workspace_id,customer_id,display_name,phone)
         VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,customer_id) DO UPDATE SET
         display_name=EXCLUDED.display_name,phone=EXCLUDED.phone,updated_at=now()`,
        [context.workspace_id, session.customerId, input.displayName, input.phone],
      );
      return mePayload(c, context, { ...session, displayName: input.displayName });
    });
  });

  app.post('/api/public/customer/marketing-consent', { config: { rateLimit: rate(20) } }, async (req, reply) => {
    const context = publicContext(req), input = v.parse(consentSchema, req.body);
    return db.transaction(async c => {
      await requirePublishedStorefrontPrivacy(c, context.company_id);
      const session = await customerSession(c, req);
      if (!session) v.fail(401, 'customer_session_required');
      await c.query(
        `INSERT INTO myfin.customer_consent_events(workspace_id,id,customer_id,purpose,channel,granted,notice_version,source)
         VALUES($1,$2,$3,'marketing',$4,$5,$6,'customer_storefront')`,
        [context.workspace_id, randomUUID(), session.customerId, input.channel, input.granted, marketingNoticeVersion],
      );
      reply.code(201);
      return mePayload(c, context, session);
    });
  });
}

const customerPasswordPolicy = Object.freeze({ N: scryptParameters.N, r: scryptParameters.r,
  p: scryptParameters.p, maxConcurrentKdfs, maxQueuedKdfs });
export { hostCookieName as customerHostCookieName, sharedCookieName as customerSharedCookieName,
  customerPasswordPolicy, marketingNoticeVersion, phoneSchema as customerPhoneSchema,
  registrationSchema as customerRegistrationSchema,
  sessionDigest as customerSessionDigest };
