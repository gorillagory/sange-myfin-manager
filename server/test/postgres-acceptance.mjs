// Explicit opt-in: synthetic tests only against the job-owned SSH tunnel.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink, symlink } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/database.js";
import { createAuth, authConfig, createIdentity } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { readMigrations, runMigrations } from "../src/migrations.js";
import { createSale, cartItem } from "../../src/domain/pos.js";
const secretDir = process.env.MYFIN_TEST_PRIVATE;
const phase05=process.env.MYFIN_ISOLATED_ACCEPTANCE === "myfin-phase05-pg-20260913";
const phase04 = process.env.MYFIN_ISOLATED_ACCEPTANCE === "myfin-phase04-pg-20260912";
const expectedMarker = phase05 ? "myfin-phase05-pg-20260913" : phase04 ? "myfin-phase04-pg-20260912" : "myfin-phase02-20260912";
if (
  (!phase05 && !phase04 && process.env.MYFIN_ISOLATED_ACCEPTANCE !== "myfin-phase02-pg-20260912") ||
  !secretDir
)
  throw Error("isolated_test_opt_in_required");
const cfg = loadConfig();
if (
  cfg.database.host !== "127.0.0.1" ||
  cfg.database.port !== (phase05 ? 25435 : phase04 ? 25434 : 25432) ||
  cfg.database.database !== "myfin_dev"
)
  throw Error("unsafe_test_target");
const db = createDatabase(cfg.database),
  authOptions = authConfig(),
  auth = createAuth(db.pool, authOptions);
const app = buildApp({
  database: db,
  auth,
  authOptions,
  uploadDir: process.env.UPLOAD_DIR,
});
const admin = new pg.Client({
  ...cfg.database,
  user: "postgres",
  password: (await readFile(secretDir + "/admin.secret", "utf8")).trim(),
});
await admin.connect();
assert.equal((await admin.query("SHOW cluster_name")).rows[0].cluster_name,expectedMarker,"refuse unmarked PostgreSQL server before mutations");
assert.match(
  (await admin.query("SELECT version() AS v")).rows[0].v,
  /PostgreSQL 16\./,
);
const password = (await readFile(secretDir + "/seed.secret", "utf8")).trim();
const tag = randomUUID().slice(0, 8),
  coA = "a-" + tag,
  coB = "b-" + tag;
let superCookie,
  staffCookie,
  adminCookie,
  bCookie,
  superUser,
  staff,
  manager,
  bUser;
async function request(
  path,
  {
    cookie = superCookie,
    method = "GET",
    body,
    origin = authOptions.origin,
    headers = {},
  } = {},
) {
  return app.inject({
    url: "/api" + path,
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { payload: body }),
  });
}
async function login(email) {
  const r = await request("/auth/sign-in/email", {
    method: "POST",
    cookie: null,
    body: { email, password },
  });
  assert.equal(r.statusCode, 200, "login status");
  const cookies = r.headers["set-cookie"];
  assert.ok(cookies, "session cookie exists");
  const all = Array.isArray(cookies) ? cookies : [cookies];
  assert.ok(
    all.some((c) => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c)),
    "cookie attributes",
  );
  return all.map((c) => c.split(";")[0]).join("; ");
}
async function json(path, options) {
  const r = await request(path, options);
  assert.equal(
    r.statusCode,
    200,
    `${options?.method || "GET"} ${path}: ${r.statusCode}`,
  );
  return r.json();
}
const route = (co, name) => `/companies/${co}/${name}`;
const baseProduct = (id, stock = 2) => ({
  id,
  name: "Synthetic product",
  sku: id,
  price: 10,
  cost: 2,
  stock,
  trackStock: true,
  variants: [],
  category: "Retail",
  unit: "kg",
});
let p;
await test("real migration history, repeat, drift, removed/backfilled, advisory locking, rollback and runtime ACLs", async () => {
  const owner = new pg.Client({
    ...cfg.database,
    user: "myfin_dev_migrator",
    password: (await readFile(secretDir + "/migrator.secret", "utf8")).trim(),
  });
  await owner.connect();
  await owner.query("SET ROLE myfin_dev_owner");
  try {
    const migrations = await readMigrations();
    assert.deepEqual(await runMigrations(owner, migrations), []);
    await assert.rejects(
      runMigrations(
        owner,
        migrations.map((m, i) => (i ? m : { ...m, checksum: "0".repeat(64) })),
      ),
      (e) => e.code === "migration_checksum_mismatch",
    );
    await assert.rejects(
      runMigrations(owner, migrations.slice(1)),
      (e) => e.code === "migration_history_mismatch",
    );
    await assert.rejects(
      runMigrations(owner, [
        {
          version: "0000_backfill.sql",
          checksum: "1".repeat(64),
          sql: "SELECT 1",
        },
        ...migrations,
      ]),
      (e) => e.code === "migration_history_mismatch",
    );
    await admin.query("BEGIN");
    await admin.query("SELECT pg_advisory_xact_lock(1297697102,1)");
    await assert.rejects(
      runMigrations(owner, migrations),
      (e) => e.code === "migration_locked",
    );
    await admin.query("ROLLBACK");
    const extra = [
      {
        version: "9000_rollback.sql",
        sql: "CREATE TABLE myfin.must_rollback(id text)",
        checksum: "a".repeat(64),
      },
      { version: "9001_fail.sql", sql: "SELECT 1/0", checksum: "b".repeat(64) },
    ];
    await assert.rejects(runMigrations(owner, [...migrations, ...extra]));
    assert.equal(
      (await admin.query("SELECT to_regclass('myfin.must_rollback') AS t"))
        .rows[0].t,
      null,
    );
    assert.equal(
      (
        await owner.query(
          "SELECT count(*) AS n FROM myfin.schema_migrations WHERE version LIKE '900%'",
        )
      ).rows[0].n,
      "0",
    );
    for (const sql of [
      "CREATE TABLE myfin.forbidden(id text)",
      "CREATE SCHEMA forbidden",
      "SET ROLE myfin_dev_owner",
      "DELETE FROM myfin.schema_migrations",
      "ALTER TABLE myfin.products ADD COLUMN forbidden text",
    ])
      await assert.rejects(db.query(sql), (e) => e.code === "42501");
    await assert.rejects(
      db.query(
        "INSERT INTO myfin.memberships(company_id,identity_id,role) VALUES('missing','missing','super')",
      ),
      (e) => ["23514", "23503"].includes(e.code),
    );
    await assert.rejects(
      db.query(
        "INSERT INTO myfin.memberships(company_id,identity_id,role) VALUES('missing','missing','company_user')",
      ),
      (e) => e.code === "23503",
    );
  } finally {
    await owner.end();
  }
});
await test("fresh complete migration batch and first-run all-or-nothing rollback", async () => {
  const name = "myfin_phase02_fresh";
  assert.equal(
    (await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]))
      .rowCount,
    0,
  );
  await admin.query(
    "CREATE DATABASE myfin_phase02_fresh OWNER myfin_dev_owner",
  );
  const fresh = new pg.Client({
    ...cfg.database,
    database: name,
    user: "postgres",
    password: (await readFile(secretDir + "/admin.secret", "utf8")).trim(),
  });
  await fresh.connect();
  try {
    await fresh.query("CREATE SCHEMA myfin AUTHORIZATION myfin_dev_owner");
    await fresh.query("SET ROLE myfin_dev_owner");
    const migrations = await readMigrations();
    await assert.rejects(
      runMigrations(fresh, [
        ...migrations,
        {
          version: "9999_failure.sql",
          sql: "SELECT 1/0",
          checksum: "f".repeat(64),
        },
      ]),
    );
    assert.equal(
      (
        await fresh.query(
          "SELECT count(*) AS n FROM pg_tables WHERE schemaname='myfin'",
        )
      ).rows[0].n,
      "0",
    );
    assert.equal(
      (await runMigrations(fresh, migrations)).length,
      migrations.length,
    );
    assert.deepEqual(await runMigrations(fresh, migrations), []);
  } finally {
    await fresh.end();
    await admin.query("DROP DATABASE myfin_phase02_fresh");
  }
});
await test("independent synthetic identities and server-managed accounts", async () => {
  await db.transaction(async (c) => {
    for (const co of [coA, coB])
      await c.query(
        "INSERT INTO myfin.companies(id,name,data) VALUES($1,$1,'{}')",
        [co],
      );
    superUser = await createIdentity(c, {
      email: `super-${tag}@myfin.test`,
      username: "Super",
      password,
      role: "super",
    });
  });
  superCookie = await login(`super-${tag}@myfin.test`);
  for (const [key, role, co] of [
    ["manager", "company_admin", coA],
    ["staff", "company_user", coA],
    ["other", "company_admin", coB],
  ]) {
    const r = await json("/users", {
      method: "POST",
      body: {
        email: `${key}-${tag}@myfin.test`,
        username: key,
        password,
        role,
        company_id: co,
      },
    });
    if (key === "staff") staff = r.id;
    else if (key === "manager") manager = r.id;
    else bUser = r.id;
  }
  adminCookie = await login(`manager-${tag}@myfin.test`);
  staffCookie = await login(`staff-${tag}@myfin.test`);
  bCookie = await login(`other-${tag}@myfin.test`);
  p = await json(route(coA, "products"), {
    method: "POST",
    cookie: adminCookie,
    body: baseProduct("product-" + tag),
  });
});
await test("origin/session/tenant/role enforcement, malformed fields and no registration", async () => {
  assert.equal((await request("/me", { cookie: null })).statusCode, 401);
  assert.equal(
    (
      await request("/auth/sign-up/email", {
        method: "POST",
        cookie: null,
        body: { email: "x@x.test", password, name: "x" },
      })
    ).statusCode,
    404,
  );
  for (const origin of [null, "https://evil.test"])
    assert.equal(
      (
        await request(route(coA, "products"), {
          method: "POST",
          origin,
          body: baseProduct("bad"),
        })
      ).statusCode,
      403,
    );
  for (const name of [
    "products",
    "clients",
    "transactions",
    "expenses",
    "activities",
    "stock_movements",
  ])
    assert.equal(
      (await request(route(coB, name), { cookie: staffCookie })).statusCode,
      403,
    );
  assert.equal(
    (
      await request(route(coA, "products"), {
        method: "POST",
        cookie: staffCookie,
        body: baseProduct("staff-product-" + tag),
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await request(route(coA, "products") + "/staff-product-" + tag, {
        method: "DELETE",
        cookie: staffCookie,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request("/users", {
        method: "POST",
        cookie: staffCookie,
        body: {
          username: "Forbidden",
          email: "forbidden@myfin.test",
          password,
          role: "company_user",
          company_id: coA,
        },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request("/companies/" + coA, {
        method: "PUT",
        cookie: staffCookie,
        body: { name: "Forbidden" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request("/users", {
        method: "POST",
        cookie: adminCookie,
        body: {
          username: "Bad",
          email: `bad-${tag}@myfin.test`,
          password,
          role: "super",
          company_id: coA,
        },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request("/users", {
        method: "POST",
        cookie: adminCookie,
        body: {
          username: "Bad",
          email: `bad-${tag}@myfin.test`,
          password,
          role: "company_admin",
          company_id: coB,
        },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(route(coA, "products"), {
        method: "POST",
        body: { ...baseProduct("bad"), super: true },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await request(route(coA, "products"), {
        method: "POST",
        body: {
          ...baseProduct("bad"),
          variants: [
            {
              id: "v",
              name: "v",
              price: 1,
              cost: 0,
              stock: 1,
              evil: { role: "super" },
            },
          ],
        },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await request(route(coA, "clients"), {
        method: "POST",
        cookie: staffCookie,
        body: {
          id: "client-bad",
          company_id: coB,
          name: "bad",
          type: "Client",
        },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await request(route(coA, "products") + "?filter[x]=a")).statusCode,
    400,
  );
});
const makeSale = (product, qty = 1, options = {}) =>
  createSale({
    id: randomUUID(),
    items: [{ ...cartItem(product), qty }],
    company: { id: coA, name: "Synthetic", preferences: {} },
    user: { uid: staff, username: "staff" },
    method: "Cash",
    received: 100,
    confirmed: true,
    ...options,
  });
let savedSale;
await test("concurrent stock checkout, replay after lost response, full fingerprint and immutable finance paths", async () => {
  const a = makeSale(p, 1.5),
    b = makeSale(p, 1.5);
  const results = await Promise.all([
    request(route(coA, "checkout"), {
      method: "POST",
      cookie: staffCookie,
      body: a,
    }),
    request(route(coA, "checkout"), {
      method: "POST",
      cookie: staffCookie,
      body: b,
    }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  savedSale = results[0].statusCode === 200 ? a : b;
  assert.equal(
    (
      await request(route(coA, "products") + "/" + p.id, {
        method: "PUT",
        body: { ...p, name: "Stale editor" },
      })
    ).statusCode,
    409,
  );
  const replay = await request(route(coA, "checkout"), {
    method: "POST",
    cookie: staffCookie,
    body: savedSale,
  });
  assert.equal(replay.statusCode, 200);
  const row = await db.query(
    "SELECT stock FROM myfin.products WHERE company_id=$1 AND id=$2",
    [coA, p.id],
  );
  assert.equal(Number(row.rows[0].stock), 0.5);
  for (const patch of [
    { customerName: "Changed" },
    { offline: true },
    { storeSnapshot: { ...savedSale.storeSnapshot, footer: "Changed" } },
    { date: new Date().toISOString() },
    { received: 101 },
  ])
    assert.equal(
      (
        await request(route(coA, "checkout"), {
          method: "POST",
          cookie: staffCookie,
          body: { ...savedSale, ...patch },
        })
      ).statusCode,
      409,
    );
  assert.equal(
    (
      await request(route(coA, "checkout"), {
        method: "POST",
        cookie: staffCookie,
        body: { ...makeSale(p), cashierId: manager },
      })
    ).statusCode,
    403,
  );
  for (const method of ["PUT", "DELETE"])
    assert.equal(
      (
        await request(route(coA, "transactions") + "/" + savedSale.id, {
          method,
          body:
            method === "PUT" ? { ...savedSale, source: "manual" } : undefined,
        })
      ).statusCode >= 400,
      true,
    );
  assert.equal(
    (
      await request(route(coA, "assign-project"), {
        method: "POST",
        body: { ids: [savedSale.id], projectName: "POS project" },
      })
    ).statusCode,
    200,
  );
  const projectReplay = await json(route(coA, "checkout"), {method:"POST",cookie:staffCookie,body:savedSale});
  assert.equal(projectReplay.project, "POS project");
  await assert.rejects(db.query("UPDATE myfin.transactions SET data=jsonb_set(data,'{total}','1') WHERE company_id=$1 AND id=$2",[coA,savedSale.id]),e=>e.code==='23514');

  await assert.rejects(
    db.query("DELETE FROM myfin.transactions WHERE company_id=$1 AND id=$2", [
      coA,
      savedSale.id,
    ]),
    (e) => e.code === "23514",
  );
  const counts = await db.query(
    "SELECT (SELECT count(*) FROM myfin.stock_movements WHERE company_id=$1 AND sale_id IS NOT NULL) AS n",
    [coA],
  );
  assert.equal(counts.rows[0].n, "1");
});
await test("fractional variants, services, flagged offline shortage and preserved customer fields", async () => {
  const prod = await json(route(coA, "products"), {
    method: "POST",
    body: {
      ...baseProduct("variant-" + tag),
      hasVariants: true,
      variants: [
        {
          id: "v1",
          name: "Variant",
          sku: "vs-" + tag,
          price: 2.55,
          cost: 1,
          stock: 0.25,
        },
      ],
    },
  });
  const service = await json(route(coA, "products"), {
    method: "POST",
    body: {
      ...baseProduct("service-" + tag),
      category: "Service",
      trackStock: false,
      stock: 0,
    },
  });
  const customer = await json(route(coA, "clients"), {
    method: "POST",
    body: {
      id: "customer-" + tag,
      name: "Keep Name",
      phone: "synthetic",
      type: "Supplier",
      email: "",
    },
  });
  const sale = createSale({
    id: randomUUID(),
    items: [
      { ...cartItem(prod, prod.variants[0]), qty: 0.375 },
      cartItem(service),
    ],
    company: { id: coA, preferences: { taxRate: 6 } },
    user: { uid: staff, username: "staff" },
    method: "Cash",
    received: 20,
    confirmed: true,
    offline: true,
    customer: {
      id: customer.id,
      email: "receipt@myfin.test",
      name: "Not replacement",
    },
  });
  const saved = await json(route(coA, "checkout"), {
    method: "POST",
    cookie: staffCookie,
    body: sale,
  });
  assert.equal(saved.stockShortage, true);
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT stock FROM myfin.product_variants WHERE company_id=$1 AND product_id=$2",
          [coA, prod.id],
        )
      ).rows[0].stock,
    ),
    -0.125,
  );
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT stock FROM myfin.products WHERE company_id=$1 AND id=$2",
          [coA, service.id],
        )
      ).rows[0].stock,
    ),
    0,
  );
  const data = (
    await db.query(
      "SELECT data FROM myfin.clients WHERE company_id=$1 AND id=$2",
      [coA, customer.id],
    )
  ).rows[0].data;
  assert.equal(data.name, "Keep Name");
  assert.equal(data.type, "Supplier");
  assert.equal(data.email, "receipt@myfin.test");
});
await test("late failure rolls back receipt, stock, customer, movements and audit together", async () => {
  const fresh = await json(route(coA, "products"), {
    method: "POST",
    body: baseProduct("rollback-" + tag, 10),
  });
  const sale = makeSale(fresh, 1, {
    customer: { email: "rollback@myfin.test", name: "Synthetic" },
  });
  // A collision in the last audit write forces rollback after all other side effects.
  await db.query(
    "INSERT INTO myfin.activities(company_id,id,actor_id,data) VALUES($1,$2,$3,'{}')",
    [coA, sale.id, staff],
  );
  assert.equal(
    (
      await request(route(coA, "checkout"), {
        method: "POST",
        cookie: staffCookie,
        body: sale,
      })
    ).statusCode,
    409,
  );
  for (const table of ["transactions", "stock_movements"])
    assert.equal(
      (
        await db.query(
          `SELECT count(*) n FROM myfin.${table} WHERE company_id=$1 AND id=$2`,
          [coA, sale.id],
        )
      ).rows[0].n,
      "0",
    );
  assert.equal(
    (
      await db.query(
        "SELECT count(*) n FROM myfin.clients WHERE company_id=$1 AND id=$2",
        [coA, sale.client_id],
      )
    ).rows[0].n,
    "0",
  );
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT stock FROM myfin.products WHERE company_id=$1 AND id=$2",
          [coA, fresh.id],
        )
      ).rows[0].stock,
    ),
    10,
  );
});
await test("quote conversion idempotency, scoped project assignment, expense and imports", async () => {
  const quote = {
    id: "quote-" + tag,
    type: "Quote",
    number: "QT-TEST",
    date: "2026-09-12",
    status: "Pending",
    items: [{ desc: "Synthetic", qty: 0.333, price: 1.005, unit: "kg" }],
    total: 0,
    taxRate: 6,
    discount: 5,
  };
  const q = await json(route(coA, "transactions"), {
    method: "POST",
    body: quote,
  });
  assert.equal(q.total, 0.34);
  const a = await json(route(coA, "convert-quote/" + q.id), { method: "POST" }),
    b = await json(route(coA, "convert-quote/" + q.id), { method: "POST" });
  assert.equal(a.id, b.id);
  await json(route(coA, "assign-project"), {
    method: "POST",
    body: { ids: [a.id], projectName: "Synthetic project" },
  });
  assert.equal(
    (
      await request(route(coA, "transactions") + "/" + a.id, {
        method: "DELETE",
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await request(route(coA, "transactions"), {
        method: "POST",
        body: {
          ...quote,
          id: "forged-" + tag,
          convertedTo: a.id,
          status: "Converted",
        },
      })
    ).statusCode,
    409,
  );
  await json(route(coA, "transactions"), {
    method: "POST",
    body: {
      id: "voucher-" + tag,
      type: "Payment Voucher",
      number: "PV-SYNTHETIC",
      date: "2026-09-12",
      status: "Paid",
      amount: 15.25,
      description: "Legacy voucher",
      category: "General",
    },
  });
  assert.equal(
    (
      await request(route(coB, "transactions") + "/" + a.id, {
        method: "DELETE",
        cookie: bCookie,
      })
    ).statusCode,
    404,
  );
  await json(route(coA, "expenses"), {
    method: "POST",
    body: {
      amount: 10.55,
      date: "2026-09-12",
      description: "Synthetic expense",
      category: "General",
    },
  });
  await json(route(coA, "import-products"), {
    method: "POST",
    body: [baseProduct("import-" + tag)],
  });
  const before = (
    await db.query(
      "SELECT count(*) n FROM myfin.products WHERE company_id=$1",
      [coA],
    )
  ).rows[0].n;
  assert.equal(
    (
      await request(route(coA, "import-products"), {
        method: "POST",
        body: [baseProduct("import-new-" + tag), baseProduct("import-" + tag)],
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*) n FROM myfin.products WHERE company_id=$1",
        [coA],
      )
    ).rows[0].n,
    before,
  );
});
await test("private uploads tenant scope, sniffing, limits, traversal and symlinks", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WQAAAABJRU5ErkJggg==",
    "base64",
  );
  async function upload(
    bytes,
    kind = "products",
    mime = "image/png",
    cookie = adminCookie,
  ) {
    const boundary = "myfin-test-boundary";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return request(route(coA, "files/" + kind), {
      method: "POST",
      cookie,
      body,
      headers: { "content-type": "multipart/form-data; boundary=" + boundary },
    });
  }
  const r = await upload(png);
  assert.equal(r.statusCode, 200);
  const file = r.json();
  const unreferenced = (await upload(png)).json();
  assert.equal((await request(unreferenced.url.slice(4),{method:"DELETE",cookie:staffCookie})).statusCode,200);

  assert.equal(
    (await request(file.url.slice(4), { cookie: staffCookie })).statusCode,
    200,
  );
  assert.equal(
    (await request(file.url.slice(4), { cookie: bCookie })).statusCode,
    403,
  );
  assert.equal(
    (
      await request(route(coB, "expenses"), {
        method: "POST",
        cookie: bCookie,
        body: {
          amount: 1,
          description: "Foreign file",
          date: "2026-09-12",
          receiptPath: file.path,
          receiptUrl: file.url,
        },
      })
    ).statusCode,
    403,
  );
  assert.equal((await request("/companies/"+coB,{method:"PUT",cookie:bCookie,body:{name:"Foreign logo",logo:file.url}})).statusCode,403);
  assert.equal((await request(route(coB,"import-products"),{method:"POST",cookie:bCookie,body:[{...baseProduct("foreign-image-"+tag),imageUrl:file.url}]})).statusCode,403);
  await json("/companies/"+coA,{method:"PUT",body:{name:"Test A",logo:file.url}});
  assert.equal((await request(file.url.slice(4),{method:"DELETE",cookie:staffCookie})).statusCode,409);
  await json("/companies/"+coA,{method:"PUT",body:{name:"Test A",logo:""}});
  const attached = await json(route(coA, "expenses"), {
    method: "POST",
    body: {
      amount: 1,
      description: "Attached file",
      date: "2026-09-12",
      receiptPath: file.path,
      receiptUrl: file.url,
    },
  });
  assert.equal(
    (await request(file.url.slice(4), { method: "DELETE" })).statusCode,
    409,
  );
  await json(route(coA, "expenses") + "/" + attached.id, { method: "DELETE" });
  assert.equal(
    (await request(file.url.slice(4), { cookie: null })).statusCode,
    401,
  );
  assert.equal(
    (await upload(Buffer.from('<svg onload="alert(1)"></svg>'))).statusCode,
    400,
  );
  assert.equal(
    (await upload(Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)])))
      .statusCode,
    413,
  );
  assert.equal(
    (
      await upload(
        Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)]),
        "receipts",
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await upload(
        Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]),
        "receipts",
      )
    ).statusCode,
    413,
  );
  await unlink(process.env.UPLOAD_DIR + "/" + file.path);
  await symlink("/etc/hostname", process.env.UPLOAD_DIR + "/" + file.path);
  assert.equal((await request(file.url.slice(4))).statusCode, 404);
  await unlink(process.env.UPLOAD_DIR + "/" + file.path);
  assert.equal(
    (await request("/files/..%2F..%2Fetc%2Fpasswd")).statusCode,
    400,
  );
});
await test("HTTPS cookie policy, forwarded-header distrust and auth origin controls", async () => {
  const secureOptions = {
    ...authOptions,
    origin: "https://myfin.example.test",
    secure: true,
  };
  const secureApp = buildApp({
    database: { ...db, close: async () => {} },
    auth: createAuth(db.pool, secureOptions),
    authOptions: secureOptions,
  });
  try {
    const r = await secureApp.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: {
        origin: secureOptions.origin,
        "x-forwarded-proto": "http",
        "x-forwarded-host": "evil.test",
      },
      payload: { email: `super-${tag}@myfin.test`, password },
    });
    assert.equal(r.statusCode, 200);
    const cookies = r.headers["set-cookie"];
    assert.ok(
      (Array.isArray(cookies) ? cookies : [cookies]).some(
        (c) => /; Secure/i.test(c) && /HttpOnly/i.test(c),
      ),
      "HTTPS cookie attributes",
    );
    assert.equal(
      (
        await secureApp.inject({
          method: "POST",
          url: "/api/auth/sign-out",
          headers: { origin: "https://evil.test", cookie: superCookie },
        })
      ).statusCode,
      403,
    );
  } finally {
    await secureApp.close();
  }
});
await test("password reauthentication and access revocation on disable/delete", async () => {
  assert.equal(
    (
      await request("/auth/change-password", {
        method: "POST",
        cookie: staffCookie,
        body: {
          newPassword: password + "x",
          currentPassword: "wrong-password",
          revokeOtherSessions: true,
        },
      })
    ).statusCode,
    400,
  );
  await json("/users/" + staff, {
    method: "PUT",
    body: {
      id: staff,
      email: `staff-${tag}@myfin.test`,
      username: "staff",
      role: "company_user",
      company_id: coA,
      disabled: true,
    },
  });
  assert.equal((await request("/me", { cookie: staffCookie })).statusCode, 401);
  const disabled = await request("/auth/sign-in/email", {
    method: "POST",
    cookie: null,
    body: { email: `staff-${tag}@myfin.test`, password },
  });
  assert.ok(disabled.statusCode >= 400, "disabled login rejected");
  await db.query(
    'UPDATE myfin.auth_session SET \"expiresAt\"=now()-interval \'1 second\' WHERE \"userId\"=$1',
    [bUser],
  );
  assert.equal((await request("/me", { cookie: bCookie })).statusCode, 401);
  bCookie = await login(`other-${tag}@myfin.test`);
  await json("/users", { method:"POST", body:{username:"Successor",email:`successor-${tag}@myfin.test`,password,role:"company_admin",company_id:coB} });
  await json("/users/" + bUser, { method: "DELETE" });
  assert.equal((await request("/me", { cookie: bCookie })).statusCode, 401);
});
// File fixtures use the controller's private test directory, never deployed uploads.
for (const row of (
  await db.query(
    "DELETE FROM myfin.files WHERE company_id=ANY($1::text[]) RETURNING id",
    [[coA, coB]],
  )
).rows)
  await unlink(process.env.UPLOAD_DIR + "/" + row.id).catch(() => {});
await app.close();
await admin.end();
