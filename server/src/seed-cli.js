import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { createIdentity } from "./auth.js";
let db;
try {
  const config = loadConfig();
  if (
    process.env.NODE_ENV === "production" ||
    config.database.database !== "myfin_dev" ||
    process.env.MYFIN_ALLOW_DEV_SEED !== "true"
  )
    throw Error("dev_seed_not_enabled");
  const password = readFileSync(
    process.env.MYFIN_SEED_PASSWORD_FILE,
    "utf8",
  ).trim();
  const email = process.env.MYFIN_SEED_EMAIL;
  if (!email || !email.endsWith(".test"))
    throw Error("synthetic_email_required");
  db = createDatabase(config.database);
  await db.transaction(async (c) => {
    await c.query(
      `INSERT INTO myfin.workspaces(id,name,slug,data) VALUES('synthetic-dev-workspace','Synthetic development workspace','synthetic-dev','{}');
       INSERT INTO myfin.companies(id,workspace_id,slug,name,data) VALUES('synthetic-dev','synthetic-dev-workspace','shop','Synthetic development shop','{"preferences":{"currency":"RM","taxRate":0}}')`,
    );
    await createIdentity(c, {
      email,
      username: "Development operator",
      password,
      role: "super_admin",
      company_id: "",
    });
  });
  process.stdout.write("Synthetic development seed created.\n");
} catch {
  process.stderr.write(
    "Seed failed: verify explicit dev scope, input files and existing records.\n",
  );
  process.exitCode = 1;
} finally {
  await db?.close();
}
