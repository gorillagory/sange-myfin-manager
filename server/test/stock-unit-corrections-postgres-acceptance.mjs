// Destructive acceptance test for migration 0045 on a disposable, locally
// bound PostgreSQL 16 cluster. The cluster_name and explicit opt-in must match:
//   MYFIN_STOCK_UNIT_PG_ACCEPTANCE=myfin-stock-unit-pg16-acceptance-20261018
//   MYFIN_STOCK_UNIT_PG_ADMIN_URL=postgresql://postgres:...@127.0.0.1:5432/postgres
// Run from server/ with:
//   node --test test/stock-unit-corrections-postgres-acceptance.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { readMigrations, runMigrations } from '../src/migrations.js';

const marker = 'myfin-stock-unit-pg16-acceptance-20261018';
const targetMigration = '0045_stock_unit_corrections.sql';
const adminConnection = process.env.MYFIN_STOCK_UNIT_PG_ADMIN_URL || '';
if (process.env.MYFIN_STOCK_UNIT_PG_ACCEPTANCE !== marker || !adminConnection)
  throw Error('stock_unit_postgres_acceptance_opt_in_required');

let adminTarget;
try {
  adminTarget = new URL(adminConnection);
} catch {
  throw Error('invalid_stock_unit_postgres_admin_url');
}
const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
if (!['postgres:', 'postgresql:'].includes(adminTarget.protocol) ||
    !localHosts.has(adminTarget.hostname.toLowerCase()) ||
    adminTarget.pathname !== '/postgres' || adminTarget.search || adminTarget.hash)
  throw Error('unsafe_stock_unit_postgres_target');

const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const databaseName = `myfin_stock_unit_${suffix}`;
if (!/^myfin_stock_unit_[a-f0-9]{16}$/.test(databaseName))
  throw Error('unsafe_stock_unit_postgres_identifier');
const databaseUrl = new URL(adminConnection);
databaseUrl.pathname = `/${databaseName}`;
const quoteIdentifier = value => `"${String(value).replaceAll('"', '""')}"`;
const digest = 'a'.repeat(64);

const expectPgError = (promise, code, message) => assert.rejects(
  promise,
  error => error?.code === code && (!message || error?.message === message),
  `expected PostgreSQL ${code}${message ? ` (${message})` : ''}`,
);

async function transaction(client, work) {
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    const result = await work(client);
    await client.query('COMMIT');
    open = false;
    return result;
  } catch (error) {
    if (open) await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

// These stages depend on each other. Propagate a child failure so a later
// stage cannot mutate the fixture after the first failed assertion.
async function requiredSubtest(parent, name, work) {
  let failure;
  await parent.test(name, async () => {
    try {
      return await work();
    } catch (error) {
      failure = error;
      throw error;
    }
  });
  if (failure) throw failure;
}

test('migration 0045 preserves historical stock units and append-only evidence', async t => {
  const admin = new pg.Client({
    connectionString: adminConnection,
    application_name: 'myfin-stock-unit-acceptance-admin',
  });
  let migrator;
  let databaseCreated = false;

  await admin.connect();
  try {
    await requiredSubtest(t, 'refuses an unmarked, remote, non-PostgreSQL-16, or incapable target', async () => {
      const safety = (await admin.query(`SELECT current_database() AS database,
        host(inet_server_addr()) AS server_address,
        current_setting('cluster_name') AS cluster_name,
        current_setting('server_version_num')::integer AS server_version_num,
        role.rolsuper AS is_superuser,role.rolcreatedb AS can_create_database
        FROM pg_roles role WHERE role.rolname=current_user`)).rows[0];
      assert.equal(safety.database, 'postgres');
      assert.ok(['127.0.0.1', '::1'].includes(safety.server_address), 'server must bind to loopback');
      assert.equal(safety.cluster_name, marker, 'cluster must carry the job marker');
      assert.ok(safety.server_version_num >= 160000 && safety.server_version_num < 170000,
        'PostgreSQL 16 is required');
      assert.equal(safety.is_superuser || safety.can_create_database, true,
        'acceptance administrator must be able to create its disposable database');
    });

    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0`);
    databaseCreated = true;
    migrator = new pg.Client({
      connectionString: databaseUrl.href,
      application_name: 'myfin-stock-unit-acceptance-migrator',
    });
    await migrator.connect();

    const migrations = await readMigrations();
    const targetIndex = migrations.findIndex(row => row.version === targetMigration);
    assert.notEqual(targetIndex, -1, `${targetMigration} must exist`);
    assert.equal(migrations.filter(row => row.version === targetMigration).length, 1);
    const through0044 = migrations.slice(0, targetIndex);
    const through0045 = migrations.slice(0, targetIndex + 1);
    assert.equal(through0044.at(-1)?.version, '0044_dynamic_module_access.sql');

    const fixture = {
      workspace: `workspace-${suffix}`,
      company: `company-${suffix}`,
      actor: `actor-${suffix}`,
      item: `stock-${suffix}`,
      packaging: `packaging-${suffix}`,
      oldLedger: `ledger-old-${suffix}`,
      newLedger: `ledger-new-${suffix}`,
      correction: `correction-${suffix}`,
    };
    let oldSnapshot;

    await requiredSubtest(t, 'applies the real migration prefix only through 0044', async () => {
      await migrator.query('CREATE SCHEMA myfin');
      assert.deepEqual(await runMigrations(migrator, through0044),
        through0044.map(row => row.version));
      const state = (await migrator.query(`SELECT count(*)::integer AS count,max(version) AS latest
        FROM myfin.schema_migrations`)).rows[0];
      assert.deepEqual(state, { count: through0044.length, latest: '0044_dynamic_module_access.sql' });
      const absent = (await migrator.query(`SELECT
        to_regclass('myfin.stock_unit_corrections') AS correction_table,
        EXISTS(SELECT 1 FROM information_schema.columns
          WHERE table_schema='myfin' AND table_name='stock_ledger'
            AND column_name='unit_version_at_time') AS snapshot_column`)).rows[0];
      assert.deepEqual(absent, { correction_table: null, snapshot_column: false });
    });

    await requiredSubtest(t, 'seeds one pre-0045 stock item, packaging, and ledger fact', async () => {
      await transaction(migrator, async client => {
        await client.query(`INSERT INTO myfin.workspaces(id,name,slug)
          VALUES($1,'Stock unit acceptance','stock-unit-acceptance')`, [fixture.workspace]);
        await client.query(`INSERT INTO myfin.app_identities(id,display_name)
          VALUES($1,'Stock unit acceptance actor')`, [fixture.actor]);
        await client.query(`INSERT INTO myfin.companies(id,name,workspace_id,slug,data)
          VALUES($1,'Stock unit acceptance company',$2,'stock-unit-acceptance','{}')`,
        [fixture.company, fixture.workspace]);
        await client.query(`INSERT INTO myfin.stock_items(
          company_id,id,name,tracking_mode,base_unit,on_hand,reorder_level)
          VALUES($1,$2,'Bottled ingredient','volume','ml',1500,0)`,
        [fixture.company, fixture.item]);
        await client.query(`INSERT INTO myfin.stock_packagings(
          company_id,item_id,id,label,quantity_in_base)
          VALUES($1,$2,$3,'Bottle',750)`,
        [fixture.company, fixture.item, fixture.packaging]);
        await client.query(`INSERT INTO myfin.stock_ledger(
          company_id,id,item_id,actor_id,kind,input_quantity,delta,quantity_after,
          packaging_id,reason,idempotency_key,request_digest)
          VALUES($1,$2,$3,$4,'receive',2,1500,1500,$5,
            'Opening packaged receipt',$6,$7)`, [fixture.company, fixture.oldLedger,
          fixture.item, fixture.actor, fixture.packaging, `old-${suffix}`, digest]);
      });
      const seeded = (await migrator.query(`SELECT item.internal_code,ledger.id AS ledger_id
        FROM myfin.stock_items item JOIN myfin.stock_ledger ledger
          ON ledger.company_id=item.company_id AND ledger.item_id=item.id
        WHERE item.company_id=$1 AND item.id=$2`, [fixture.company, fixture.item])).rows[0];
      assert.deepEqual(seeded, { internal_code: 'STK-000001', ledger_id: fixture.oldLedger });
    });

    await requiredSubtest(t, 'applies only 0045 and backfills the historical ledger snapshot', async () => {
      assert.deepEqual(await runMigrations(migrator, through0045), [targetMigration]);
      const migrationRow = (await migrator.query(`SELECT count(*)::integer AS count
        FROM myfin.schema_migrations WHERE version=$1`, [targetMigration])).rows[0];
      assert.equal(migrationRow.count, 1);
      oldSnapshot = (await migrator.query(`SELECT tracking_mode_at_time,base_unit_at_time,
        unit_version_at_time::text,packaging_label_at_time,packaging_quantity_at_time::text
        FROM myfin.stock_ledger WHERE company_id=$1 AND id=$2`,
      [fixture.company, fixture.oldLedger])).rows[0];
      assert.deepEqual(oldSnapshot, {
        tracking_mode_at_time: 'volume',
        base_unit_at_time: 'ml',
        unit_version_at_time: '1',
        packaging_label_at_time: 'Bottle',
        packaging_quantity_at_time: '750.000000',
      });
      const counter = (await migrator.query(`SELECT last_value::text
        FROM myfin.stock_internal_code_counters WHERE company_id=$1`, [fixture.company])).rows[0];
      assert.deepEqual(counter, { last_value: '1' });
    });

    await requiredSubtest(t, 'new ledger facts snapshot the corrected unit version and current packaging', async () => {
      const beforePackaging = [{
        id: fixture.packaging,
        label: 'Bottle',
        barcode: '',
        quantityInBase: '750.000000',
      }];
      const afterPackaging = [{
        id: fixture.packaging,
        label: 'Bottle',
        barcode: '',
        quantityInBase: '0.750000',
      }];
      await transaction(migrator, async client => {
        await client.query(`UPDATE myfin.stock_items
          SET base_unit='L',on_hand=1.5,unit_version=2,version=version+1,updated_at=now()
          WHERE company_id=$1 AND id=$2`, [fixture.company, fixture.item]);
        await client.query(`UPDATE myfin.stock_packagings SET quantity_in_base=0.75
          WHERE company_id=$1 AND item_id=$2 AND id=$3`,
        [fixture.company, fixture.item, fixture.packaging]);
        await client.query(`INSERT INTO myfin.stock_unit_corrections(
          company_id,id,stock_item_id,actor_id,
          from_tracking_mode,from_base_unit,from_unit_version,
          to_tracking_mode,to_base_unit,to_unit_version,strategy,conversion_factor,
          on_hand_before,on_hand_after,reorder_level_before,reorder_level_after,
          packagings_before,packagings_after,reason)
          VALUES($1,$2,$3,$4,'volume','ml',1,'volume','L',2,'convert',0.001,
            1500,1.5,0,0,$5::jsonb,$6::jsonb,'Correct millilitres to litres')`,
        [fixture.company, fixture.correction, fixture.item, fixture.actor,
          JSON.stringify(beforePackaging), JSON.stringify(afterPackaging)]);
      });

      await migrator.query(`UPDATE myfin.stock_packagings SET label='Metric bottle'
        WHERE company_id=$1 AND item_id=$2 AND id=$3`,
      [fixture.company, fixture.item, fixture.packaging]);
      assert.deepEqual((await migrator.query(`SELECT tracking_mode_at_time,base_unit_at_time,
        unit_version_at_time::text,packaging_label_at_time,packaging_quantity_at_time::text
        FROM myfin.stock_ledger WHERE company_id=$1 AND id=$2`,
      [fixture.company, fixture.oldLedger])).rows[0], oldSnapshot,
      'the old ledger snapshot must not follow later item or packaging edits');

      await transaction(migrator, async client => {
        await client.query(`UPDATE myfin.stock_items
          SET on_hand=2.25,version=version+1,updated_at=now()
          WHERE company_id=$1 AND id=$2`, [fixture.company, fixture.item]);
        await client.query(`INSERT INTO myfin.stock_ledger(
          company_id,id,item_id,actor_id,kind,input_quantity,delta,quantity_after,
          packaging_id,reason,idempotency_key,request_digest)
          VALUES($1,$2,$3,$4,'receive',1,0.75,2.25,$5,
            'Receipt after unit correction',$6,$7)`, [fixture.company, fixture.newLedger,
          fixture.item, fixture.actor, fixture.packaging, `new-${suffix}`, digest]);
      });
      const newSnapshot = (await migrator.query(`SELECT tracking_mode_at_time,base_unit_at_time,
        unit_version_at_time::text,packaging_label_at_time,packaging_quantity_at_time::text
        FROM myfin.stock_ledger WHERE company_id=$1 AND id=$2`,
      [fixture.company, fixture.newLedger])).rows[0];
      assert.deepEqual(newSnapshot, {
        tracking_mode_at_time: 'volume',
        base_unit_at_time: 'L',
        unit_version_at_time: '2',
        packaging_label_at_time: 'Metric bottle',
        packaging_quantity_at_time: '0.750000',
      });
    });

    await requiredSubtest(t, 'ledger snapshots reject both update and delete', async () => {
      await expectPgError(migrator.query(`UPDATE myfin.stock_ledger SET reason=reason
        WHERE company_id=$1 AND id=$2`, [fixture.company, fixture.oldLedger]),
      '23514', 'stock_ledger_immutable');
      await expectPgError(migrator.query(`DELETE FROM myfin.stock_ledger
        WHERE company_id=$1 AND id=$2`, [fixture.company, fixture.newLedger]),
      '23514', 'stock_ledger_immutable');
      assert.equal((await migrator.query(`SELECT count(*)::integer AS count
        FROM myfin.stock_ledger WHERE company_id=$1 AND id=ANY($2::text[])`,
      [fixture.company, [fixture.oldLedger, fixture.newLedger]])).rows[0].count, 2);
    });

    await requiredSubtest(t, 'correction audit rows are immutable and unit versions are unique', async () => {
      await expectPgError(migrator.query(`UPDATE myfin.stock_unit_corrections SET reason=reason
        WHERE company_id=$1 AND id=$2`, [fixture.company, fixture.correction]),
      '23514', 'stock_unit_correction_immutable');
      await expectPgError(migrator.query(`DELETE FROM myfin.stock_unit_corrections
        WHERE company_id=$1 AND id=$2`, [fixture.company, fixture.correction]),
      '23514', 'stock_unit_correction_immutable');
      await expectPgError(migrator.query(`INSERT INTO myfin.stock_unit_corrections(
        company_id,id,stock_item_id,actor_id,
        from_tracking_mode,from_base_unit,from_unit_version,
        to_tracking_mode,to_base_unit,to_unit_version,strategy,conversion_factor,
        on_hand_before,on_hand_after,reorder_level_before,reorder_level_after,
        packagings_before,packagings_after,reason)
        SELECT company_id,$3,stock_item_id,actor_id,
          from_tracking_mode,from_base_unit,from_unit_version,
          to_tracking_mode,to_base_unit,to_unit_version,strategy,conversion_factor,
          on_hand_before,on_hand_after,reorder_level_before,reorder_level_after,
          packagings_before,packagings_after,'Duplicate version must fail'
        FROM myfin.stock_unit_corrections WHERE company_id=$1 AND id=$2`,
      [fixture.company, fixture.correction, `duplicate-${suffix}`]), '23505');
      assert.equal((await migrator.query(`SELECT count(*)::integer AS count
        FROM myfin.stock_unit_corrections WHERE company_id=$1 AND stock_item_id=$2`,
      [fixture.company, fixture.item])).rows[0].count, 1);
    });

    await requiredSubtest(t, 'generated stock codes remain monotonic after an unused item is deleted', async () => {
      const firstUnused = `unused-a-${suffix}`;
      const secondUnused = `unused-b-${suffix}`;
      const insertUnused = id => migrator.query(`INSERT INTO myfin.stock_items(
        company_id,id,name,tracking_mode,base_unit,on_hand,reorder_level,active)
        VALUES($1,$2,'Unused acceptance item','count','each',0,0,false)
        RETURNING internal_code`, [fixture.company, id]);
      assert.equal((await insertUnused(firstUnused)).rows[0].internal_code, 'STK-000002');
      await migrator.query(`DELETE FROM myfin.stock_items WHERE company_id=$1 AND id=$2`,
        [fixture.company, firstUnused]);
      assert.equal((await migrator.query(`SELECT count(*)::integer AS count FROM myfin.stock_items
        WHERE company_id=$1 AND id=$2`, [fixture.company, firstUnused])).rows[0].count, 0);
      assert.equal((await insertUnused(secondUnused)).rows[0].internal_code, 'STK-000003');
      assert.equal((await migrator.query(`SELECT last_value::text
        FROM myfin.stock_internal_code_counters WHERE company_id=$1`,
      [fixture.company])).rows[0].last_value, '3');
    });

    await requiredSubtest(t, 'a full through-0045 migration rerun is a no-op', async () => {
      assert.deepEqual(await runMigrations(migrator, through0045), []);
      const state = (await migrator.query(`SELECT count(*)::integer AS migration_count,
        (SELECT count(*)::integer FROM myfin.stock_ledger WHERE company_id=$2) AS ledger_count,
        (SELECT count(*)::integer FROM myfin.stock_unit_corrections WHERE company_id=$2) AS correction_count
        FROM myfin.schema_migrations WHERE version=$1`,
      [targetMigration, fixture.company])).rows[0];
      assert.deepEqual(state, { migration_count: 1, ledger_count: 2, correction_count: 1 });
    });
  } finally {
    if (migrator) await migrator.end().catch(() => {});
    try {
      if (databaseCreated)
        await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
});
