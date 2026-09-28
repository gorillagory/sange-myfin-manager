import pg from "pg";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import {
  GenesisError,
  createGenesisSuperAdmin,
  genesisScope,
} from "./genesis.js";

let client;
try {
  const config = loadConfig();
  const scope = genesisScope(process.env, config.database.database);
  const password = readFileSync(
    process.env.MYFIN_GENESIS_PASSWORD_FILE,
    "utf8",
  ).replace(/\r?\n$/, "");
  client = new pg.Client({
    ...config.database,
    application_name: "myfin-genesis",
  });
  client.on("error", () => {});
  await client.connect();
  await client.query(`SET ROLE "${scope.owner}"`);
  await createGenesisSuperAdmin(client, {
    database: config.database.database,
    owner: scope.owner,
    email: process.env.MYFIN_GENESIS_EMAIL,
    displayName: process.env.MYFIN_GENESIS_DISPLAY_NAME,
    password,
  });
  process.stdout.write("Initial SuperAdmin created and audited.\n");
} catch (error) {
  const code = error instanceof GenesisError ? error.code : "genesis_failed";
  process.stderr.write(`${code}: verify scope, protected inputs, migrations and database state.\n`);
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => { process.exitCode = 1; });
}
