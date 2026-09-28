import { betterAuth } from "better-auth";
import { readFileSync } from "node:fs";
import { hashPassword } from "better-auth/crypto";
import { randomUUID } from "node:crypto";

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
  return { origin: base.origin, secret, secure: base.protocol === "https:" };
}
export function createAuth(pool, config) {
  return betterAuth({
    appName: "MyFin",
    baseURL: config.origin,
    basePath: "/api/auth",
    secret: config.secret,
    database: pool,
    trustedOrigins: [config.origin],
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
              "SELECT i.id FROM myfin.app_identities i JOIN myfin.identity_mappings x ON x.identity_id=i.id WHERE x.provider='better-auth' AND x.subject=$1 AND i.disabled_at IS NULL AND (i.is_super OR NOT EXISTS(SELECT 1 FROM myfin.memberships m JOIN myfin.companies c ON c.id=m.company_id WHERE m.identity_id=i.id AND c.archived_at IS NOT NULL))",
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
  { email, username, password, role, company_id, disabled = false },
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
  await client.query(
    "INSERT INTO myfin.app_identities(id,display_name,is_super,disabled_at) VALUES($1,$2,$3,CASE WHEN $4 THEN now() ELSE NULL END)",
    [id, username, role === "super", disabled],
  );
  await client.query(
    "INSERT INTO myfin.identity_mappings(provider,subject,identity_id) VALUES('better-auth',$1,$1)",
    [id],
  );
  if (role !== "super")
    await client.query(
      "INSERT INTO myfin.memberships(company_id,identity_id,role) VALUES($1,$2,$3)",
      [company_id, id, role],
    );
  return id;
}
