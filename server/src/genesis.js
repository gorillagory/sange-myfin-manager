import { createIdentity } from "./auth.js";
import { randomUUID } from "node:crypto";

const targets = Object.freeze({
  myfin_dev: Object.freeze({ migrator: "myfin_dev_migrator", owner: "myfin_dev_owner" }),
  myfin_prod: Object.freeze({ migrator: "myfin_prod_migrator", owner: "myfin_prod_owner" }),
});

export class GenesisError extends Error {
  constructor(code) {
    super(code);
    this.name = "GenesisError";
    this.code = code;
  }
}

const fail = code => { throw new GenesisError(code); };

export function genesisScope(env, database) {
  const target = targets[database];
  if (
    !target ||
    env.PGUSER !== target.migrator ||
    env.GENESIS_OWNER !== target.owner ||
    env.MYFIN_ALLOW_GENESIS !== database
  ) fail("genesis_scope_required");
  return target;
}

export function genesisInput({ email, displayName, password }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedName = String(displayName || "").trim();
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ||
    normalizedEmail.length > 254 ||
    !normalizedName ||
    normalizedName.length > 120 ||
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128 ||
    /[\r\n\0]/.test(password)
  ) fail("invalid_genesis_input");
  return { email: normalizedEmail, username: normalizedName, password };
}

export async function createGenesisSuperAdmin(
  client,
  { database, owner, email, displayName, password },
  create = createIdentity,
) {
  const input = genesisInput({ email, displayName, password });
  await client.query("BEGIN");
  try {
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock(1297697102,7) AS locked",
    );
    if (lock.rows[0]?.locked !== true) fail("genesis_locked");
    const context = await client.query(`SELECT
      current_database() AS database,
      current_user AS db_role,
      EXISTS(SELECT 1 FROM myfin.schema_migrations WHERE version='0013_workspace_routing_access.sql') AS schema_ready`);
    const actual = context.rows[0];
    if (
      actual?.database !== database ||
      actual?.db_role !== owner ||
      actual?.schema_ready !== true
    ) fail("genesis_database_context_invalid");
    const active = await client.query(
      "SELECT id FROM myfin.app_identities WHERE is_super AND disabled_at IS NULL LIMIT 1",
    );
    if (active.rowCount) fail("genesis_already_initialized");
    const id = await create(client, {
      ...input,
      role: "super_admin",
      company_id: "",
      workspace_id: "",
    });
    await client.query(
      `INSERT INTO myfin.management_events(id,actor_id,company_id,subject_id,action,details)
       VALUES($2,$1,NULL,$1,'genesis_super_admin_created',$3)`,
      [id, randomUUID(), { method: "offline_genesis_v1", database }],
    );
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
