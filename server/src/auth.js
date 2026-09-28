import { betterAuth } from "better-auth";
import { readFileSync } from "node:fs";
import { hashPassword } from "better-auth/crypto";
import { randomUUID } from "node:crypto";
import { normalizeHostname } from "./tenancy.js";

export function authConfig(env = process.env) {
  const base = new URL(env.AUTH_BASE_URL || "invalid:");
  const local =
    env.AUTH_LOCAL_TEST === "true" &&
    env.NODE_ENV === "test" &&
    ["127.0.0.1", "localhost"].includes(base.hostname);
  if (
    base.origin === "null" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    (base.protocol !== "https:" && !local)
  )
    throw new Error("invalid_auth_origin");
  const secret = readFileSync(env.AUTH_SECRET_FILE, "utf8").trim();
  if (secret.length < 32) throw new Error("invalid_auth_secret");
  const rawHosts = (env.AUTH_ALLOWED_HOSTS || base.hostname).split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  const allowedHosts = [...new Set(rawHosts.map(host=>host.startsWith("*.")?`*.${normalizeHostname(host.slice(2))}`:normalizeHostname(host)))];
  if (!allowedHosts.length || allowedHosts.some(host=>!host || (host.startsWith("*.") && host.slice(2).split(".").length<2))) throw new Error("invalid_auth_allowed_hosts");
  const protocol = base.protocol;
  const controlHosts = (env.AUTH_CONTROL_HOSTS || "").split(",").map(normalizeHostname).filter(Boolean);
  if (controlHosts.some(host=>!allowedHosts.some(pattern=>pattern===host || pattern.startsWith("*.")&&host.endsWith(pattern.slice(1))))) throw new Error("invalid_auth_control_hosts");
  const readOptionalSecret = key => {
    if (!env[key]) return null;
    const value=readFileSync(env[key],"utf8").trim();
    if(value.length<32)throw new Error(`invalid_${key.toLowerCase()}`);
    return value;
  };
  const posCodeSecret=readOptionalSecret("POS_CODE_SECRET_FILE"),posSessionSecret=readOptionalSecret("POS_SESSION_SECRET_FILE");
  if((posCodeSecret&&!posSessionSecret)||(!posCodeSecret&&posSessionSecret)||(env.NODE_ENV==="production"&&!posCodeSecret))throw new Error("invalid_pos_secrets");
  const rootDomain=(env.PUBLIC_ROOT_DOMAIN||"").trim().toLowerCase();
  if(rootDomain&&normalizeHostname(rootDomain)!==rootDomain)throw new Error("invalid_public_root_domain");
  const sessionHours=Number(env.POS_SESSION_HOURS||8);if(!Number.isInteger(sessionHours)||sessionHours<1||sessionHours>24)throw new Error("invalid_pos_session_hours");
  return {
    origin: base.origin, protocol, allowedHosts, controlHosts,
    rootDomain,
    enforceTenantHosts:env.TENANT_HOST_ENFORCEMENT!=="false" && env.NODE_ENV!=="test",
    secret, secure: base.protocol === "https:",
    pos:posCodeSecret?{codeSecret:posCodeSecret,sessionSecret:posSessionSecret,sessionHours}:null,
  };
}
export function createAuth(pool, config) {
  return betterAuth({
    appName: "MyFin",
    baseURL: config.allowedHosts.length===1 && !config.allowedHosts[0].startsWith("*.")
      ? config.origin
      : { allowedHosts: config.allowedHosts, protocol: config.protocol.slice(0,-1) },
    basePath: "/api/auth",
    secret: config.secret,
    database: pool,
    trustedOrigins: config.allowedHosts.map(host=>`${config.protocol}//${host}`),
    user: { modelName: "auth_user" },
    session: {
      modelName: "auth_session",
      expiresIn: 60 * 60 * 24,
      updateAge: 3600,
      cookieCache: { enabled: false },
    },
    account: { modelName: "auth_account", accountLinking: { enabled: false } },
    verification: { modelName: "auth_verification" },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
    },
    advanced: {
      useSecureCookies: config.secure,
      cookiePrefix: "myfin",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.secure,
      },
      ipAddress: { ipAddressHeaders: [] },
      database: { validateSchema: false },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const r = await pool.query(
              `SELECT i.id FROM myfin.app_identities i JOIN myfin.identity_mappings x ON x.identity_id=i.id
                WHERE x.provider='better-auth' AND x.subject=$1 AND i.disabled_at IS NULL AND
                (i.is_super OR EXISTS(SELECT 1 FROM myfin.workspace_memberships wm JOIN myfin.workspaces w ON w.id=wm.workspace_id
                  WHERE wm.identity_id=i.id AND wm.suspended_at IS NULL AND w.suspended_at IS NULL AND w.archived_at IS NULL)
                 OR EXISTS(SELECT 1 FROM myfin.memberships m JOIN myfin.companies c ON c.id=m.company_id JOIN myfin.workspaces w ON w.id=c.workspace_id
                  WHERE m.identity_id=i.id AND c.suspended_at IS NULL AND c.archived_at IS NULL AND w.suspended_at IS NULL AND w.archived_at IS NULL))`,
              [session.userId],
            );
            if (!r.rowCount) return false;
            return { data: session };
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      customRules: { "/sign-in/email": { window: 60, max: 10 } },
    },
    logger: { disabled: true },
  });
}
// Password derivation belongs entirely to the pinned auth library. Account and
// explicit application identity are created in the caller's SQL transaction.
export async function createIdentity(
  client,
  { email, username, password, role, company_id, workspace_id, disabled = false },
) {
  if (password.length < 12 || password.length > 128)
    throw new Error("invalid_password");
  const id = randomUUID(),
    hash = await hashPassword(password);
  await client.query(
    'INSERT INTO myfin.auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',
    [id, username, email.toLowerCase()],
  );
  await client.query(
    'INSERT INTO myfin.auth_account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES($1,$2,\'credential\',$2,$3,now(),now())',
    [randomUUID(), id, hash],
  );
  const normalizedRole={super:"super_admin",company_admin:"manager",company_user:"operator"}[role]||role;
  await client.query(
    "INSERT INTO myfin.app_identities(id,display_name,is_super,disabled_at) VALUES($1,$2,$3,CASE WHEN $4 THEN now() ELSE NULL END)",
    [id, username, normalizedRole === "super_admin", disabled],
  );
  await client.query(
    "INSERT INTO myfin.identity_mappings(provider,subject,identity_id) VALUES('better-auth',$1,$1)",
    [id],
  );
  if (normalizedRole === "workspace_owner")
    await client.query(
      "INSERT INTO myfin.workspace_memberships(workspace_id,identity_id,role) VALUES($1,$2,'workspace_owner')",
      [workspace_id, id],
    );
  if (["manager","operator"].includes(normalizedRole))
    await client.query(
      "INSERT INTO myfin.memberships(company_id,identity_id,role) VALUES($1,$2,$3)",
      [company_id, id, normalizedRole],
    );
  return id;
}
