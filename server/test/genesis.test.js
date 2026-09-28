import test from "node:test";
import assert from "node:assert/strict";
import {
  createGenesisSuperAdmin,
  genesisInput,
  genesisScope,
} from "../src/genesis.js";

function fake({ locked = true, context, active = false, failAudit = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("pg_try_advisory")) return { rows: [{ locked }] };
      if (sql.includes("current_database")) return { rows: [context || {
        database: "myfin_dev", db_role: "myfin_dev_owner", schema_ready: true,
      }] };
      if (sql.includes("WHERE is_super")) return { rowCount: active ? 1 : 0, rows: active ? [{ id: "existing" }] : [] };
      if (failAudit && sql.includes("management_events")) throw Error("database error with secret");
      return { rows: [], rowCount: 1 };
    },
  };
}

const input = {
  database: "myfin_dev",
  owner: "myfin_dev_owner",
  email: "Owner@Example.com",
  displayName: "Genesis Owner",
  password: "correct horse battery staple",
};

test("scope permits only the exact reviewed database, migrator and owner tuple", () => {
  assert.deepEqual(genesisScope({
    PGUSER: "myfin_dev_migrator",
    GENESIS_OWNER: "myfin_dev_owner",
    MYFIN_ALLOW_GENESIS: "myfin_dev",
  }, "myfin_dev"), { migrator: "myfin_dev_migrator", owner: "myfin_dev_owner" });
  for (const env of [
    {},
    { PGUSER: "myfin_dev_runtime", GENESIS_OWNER: "myfin_dev_owner", MYFIN_ALLOW_GENESIS: "myfin_dev" },
    { PGUSER: "myfin_dev_migrator", GENESIS_OWNER: "myfin_prod_owner", MYFIN_ALLOW_GENESIS: "myfin_dev" },
  ]) assert.throws(() => genesisScope(env, "myfin_dev"), { code: "genesis_scope_required" });
});

test("genesis input normalizes identity fields and rejects unsafe credentials", () => {
  assert.deepEqual(genesisInput(input), {
    email: "owner@example.com", username: "Genesis Owner", password: input.password,
  });
  assert.throws(() => genesisInput({ ...input, email: "invalid" }), { code: "invalid_genesis_input" });
  assert.throws(() => genesisInput({ ...input, password: "short" }), { code: "invalid_genesis_input" });
  assert.throws(() => genesisInput({ ...input, password: `${input.password}\nsecond` }), { code: "invalid_genesis_input" });
});

test("first SuperAdmin is created under the lock and audited in one transaction", async () => {
  const client = fake(), created = [];
  const id = await createGenesisSuperAdmin(client, input, async (_client, data) => {
    created.push(data); return "genesis-id";
  });
  assert.equal(id, "genesis-id");
  assert.equal(client.calls[0].sql, "BEGIN");
  assert.match(client.calls[1].sql, /pg_try_advisory_xact_lock/);
  assert.equal(client.calls.at(-1).sql, "COMMIT");
  assert.deepEqual(created[0], {
    email: "owner@example.com", username: "Genesis Owner", password: input.password,
    role: "super_admin", company_id: "", workspace_id: "",
  });
  const audit = client.calls.find(call => call.sql.includes("management_events"));
  assert.equal(audit.params[0], "genesis-id");
  assert.match(audit.params[1], /^[0-9a-f-]{36}$/);
  assert.deepEqual(audit.params[2], { method: "offline_genesis_v1", database: "myfin_dev" });
});

test("active SuperAdmin, concurrent attempt and wrong database context fail closed", async () => {
  for (const [client, code] of [
    [fake({ active: true }), "genesis_already_initialized"],
    [fake({ locked: false }), "genesis_locked"],
    [fake({ context: { database: "myfin_prod", db_role: "myfin_prod_owner", schema_ready: true } }), "genesis_database_context_invalid"],
    [fake({ context: { database: "myfin_dev", db_role: "myfin_dev_owner", schema_ready: false } }), "genesis_database_context_invalid"],
  ]) {
    let called = false;
    await assert.rejects(createGenesisSuperAdmin(client, input, async () => { called = true; }), { code });
    assert.equal(called, false);
    assert.equal(client.calls.at(-1).sql, "ROLLBACK");
  }
});

test("audit failure rolls the identity creation back", async () => {
  const client = fake({ failAudit: true });
  await assert.rejects(createGenesisSuperAdmin(client, input, async () => "genesis-id"), /database error/);
  assert.equal(client.calls.at(-1).sql, "ROLLBACK");
});
