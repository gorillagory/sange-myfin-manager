// Destructive acceptance test for a job-owned, locally bound PostgreSQL 16 cluster.
//
// The suite never connects to a MyFin application database. The caller must opt
// in with both variables below and configure PostgreSQL cluster_name to match:
//   MYFIN_MARKETING_PG_ACCEPTANCE=myfin-marketing-pg16-acceptance-20261011
//   MYFIN_MARKETING_PG_ADMIN_URL=postgresql://postgres:...@127.0.0.1:5432/postgres
// It creates a uniquely named database from template0 and drops it in finally.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { readMigrations, runMigrations } from '../src/migrations.js';

const marker = 'myfin-marketing-pg16-acceptance-20261011';
const adminConnection = process.env.MYFIN_MARKETING_PG_ADMIN_URL || '';
if (process.env.MYFIN_MARKETING_PG_ACCEPTANCE !== marker || !adminConnection)
  throw Error('marketing_postgres_acceptance_opt_in_required');

let adminTarget;
try {
  adminTarget = new URL(adminConnection);
} catch {
  throw Error('invalid_marketing_postgres_admin_url');
}
const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
if (!['postgres:', 'postgresql:'].includes(adminTarget.protocol) ||
    !localHosts.has(adminTarget.hostname.toLowerCase()) ||
    adminTarget.pathname !== '/postgres' || adminTarget.search || adminTarget.hash)
  throw Error('unsafe_marketing_postgres_target');

const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const databaseName = `myfin_marketing_accept_${suffix}`;
const runtimeRole = `myfin_marketing_runtime_${suffix}`;
if (!/^myfin_marketing_accept_[a-f0-9]{16}$/.test(databaseName) ||
    !/^myfin_marketing_runtime_[a-f0-9]{16}$/.test(runtimeRole))
  throw Error('unsafe_marketing_postgres_identifier');

const databaseUrl = new URL(adminConnection);
databaseUrl.pathname = `/${databaseName}`;
const quoteIdentifier = value => `"${String(value).replaceAll('"', '""')}"`;
const digest = value => createHash('sha256').update(String(value)).digest('hex');
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

// node:test reports a failed child without rejecting t.test(). These stages are
// dependent, so propagate the original error before a later stage can mutate.
async function requiredSubtest(parent, name, work) {
  let failure;
  await parent.test(name, async child => {
    try {
      return await work(child);
    } catch (error) {
      failure = error;
      throw error;
    }
  });
  if (failure) throw failure;
}

test('marketing and loyalty migrations enforce their PostgreSQL invariants', async t => {
  const admin = new pg.Client({
    connectionString: adminConnection,
    application_name: 'myfin-marketing-acceptance-admin',
  });
  let migrator;
  let databaseCreated = false;
  let roleCreated = false;
  let safety;

  await admin.connect();
  try {
    await requiredSubtest(t, 'refuses an unmarked, remote, non-PostgreSQL-16, or incapable target', async () => {
      safety = (await admin.query(`SELECT current_database() AS database,
        current_user AS role_name,host(inet_server_addr()) AS server_address,
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
      application_name: 'myfin-marketing-acceptance-migrator',
    });
    await migrator.connect();

    await requiredSubtest(t, 'applies every real migration twice and records 0030 exactly once', async () => {
      const fresh = (await migrator.query(`SELECT current_database() AS database,
        current_user=pg_get_userbyid(datdba) AS database_owner,
        to_regnamespace('myfin') AS myfin_schema
        FROM pg_database WHERE datname=current_database()`)).rows[0];
      assert.deepEqual(fresh, {
        database: databaseName,
        database_owner: true,
        myfin_schema: null,
      });
      await migrator.query('CREATE SCHEMA myfin');
      const migrations = await readMigrations();
      assert.equal(migrations.filter(row => row.version === '0029_marketing_campaigns.sql').length, 1);
      assert.equal(migrations.filter(row => row.version === '0030_marketing_rewards_loyalty.sql').length, 1);
      assert.deepEqual(await runMigrations(migrator, migrations), migrations.map(row => row.version));
      assert.deepEqual(await runMigrations(migrator, migrations), []);
      const ledger = await migrator.query(`SELECT version,count(*)::integer AS count
        FROM myfin.schema_migrations
        WHERE version IN ('0029_marketing_campaigns.sql','0030_marketing_rewards_loyalty.sql')
        GROUP BY version ORDER BY version`);
      assert.deepEqual(ledger.rows, [
        { version: '0029_marketing_campaigns.sql', count: 1 },
        { version: '0030_marketing_rewards_loyalty.sql', count: 1 },
      ]);
    });

    const fixture = {
      workspace: `workspace-${suffix}`,
      companyA: `company-a-${suffix}`,
      companyB: `company-b-${suffix}`,
      actor: `actor-${suffix}`,
      customer: `customer-${suffix}`,
      rewardProduct: `reward-${suffix}`,
      otherProduct: `other-${suffix}`,
      rewardVariant: `reward-small-${suffix}`,
      wrongRewardVariant: `reward-large-${suffix}`,
      otherVariant: `other-variant-${suffix}`,
      companyAudience: `audience-company-${suffix}`,
      workspaceAudience: `audience-workspace-${suffix}`,
      campaignA: `campaign-a-${suffix}`,
      campaignB: `campaign-b-${suffix}`,
      promotion: `free-item-${suffix}`,
      reservationA: `reservation-a-${suffix}`,
      reservationB: `reservation-b-${suffix}`,
    };

    await requiredSubtest(t, 'seeds isolated tenants, catalog variants, and loyalty state', async () => {
      await transaction(migrator, async client => {
        await client.query('INSERT INTO myfin.workspaces(id,name,slug) VALUES($1,$2,$1)',
          [fixture.workspace, 'Marketing acceptance workspace']);
        await client.query('INSERT INTO myfin.app_identities(id,display_name) VALUES($1,$2)',
          [fixture.actor, 'Marketing acceptance actor']);
        await client.query(`INSERT INTO myfin.companies(id,name,workspace_id,slug,data)
          VALUES($1,'Company A',$3,$1,'{}'),($2,'Company B',$3,$2,'{}')`,
        [fixture.companyA, fixture.companyB, fixture.workspace]);
        await client.query(`INSERT INTO myfin.products(company_id,id,data,stock,price,cost)
          VALUES($1,$2,$3,10,5,2),($1,$4,$5,10,5,2)`, [
          fixture.companyA,
          fixture.rewardProduct,
          { id: fixture.rewardProduct, name: 'Reward', stock: 10 },
          fixture.otherProduct,
          { id: fixture.otherProduct, name: 'Other', stock: 10 },
        ]);
        await client.query(`INSERT INTO myfin.product_variants(company_id,product_id,id,stock,price,cost)
          VALUES($1,$2,$3,10,5,2),($1,$2,$4,10,5,2),($1,$5,$6,10,5,2)`, [
          fixture.companyA, fixture.rewardProduct, fixture.rewardVariant, fixture.wrongRewardVariant,
          fixture.otherProduct, fixture.otherVariant,
        ]);
        await client.query(`INSERT INTO myfin.customer_accounts(id,display_name,adult_confirmed_at)
          VALUES($1,'Acceptance customer',now())`, [fixture.customer]);
        await client.query(`INSERT INTO myfin.customer_loyalty_accounts(
          workspace_id,customer_id,stamp_balance,reserved_points) VALUES($1,$2,100,0)`,
        [fixture.workspace, fixture.customer]);
        await client.query(`INSERT INTO myfin.workspace_loyalty_settings(workspace_id,updated_by)
          VALUES($1,$2)`, [fixture.workspace, fixture.actor]);
        await client.query(`INSERT INTO myfin.workspace_loyalty_setting_versions(
          workspace_id,version,enabled,unit_label,earn_mode,points_per_order,spend_step_sen,
          points_per_spend_step,minimum_spend_sen,redemption_threshold_points,request_digest,created_by)
          VALUES($1,1,true,'points','per_order',1,100,1,0,10,$2,$3)`,
        [fixture.workspace, digest('loyalty-settings'), fixture.actor]);
      });
    });

    const createAudience = async ({ id, scope, companyId }) => transaction(migrator, async client => {
      await client.query(`INSERT INTO myfin.marketing_audiences(
        workspace_id,id,company_id,scope,version,updated_by) VALUES($1,$2,$3,$4,1,$5)`,
      [fixture.workspace, id, companyId, scope, fixture.actor]);
      await client.query(`INSERT INTO myfin.marketing_audience_versions(
        workspace_id,audience_id,version,name,scope,company_id,request_digest,created_by)
        VALUES($1,$2,1,$3,$4,$5,$6,$7)`, [fixture.workspace, id, `Audience ${id}`, scope,
        companyId, digest(`audience:${id}`), fixture.actor]);
    });
    const createCampaign = async ({ id, companyId }) => transaction(migrator, async client => {
      await client.query(`INSERT INTO myfin.marketing_campaigns(
        workspace_id,company_id,id,version,updated_by) VALUES($1,$2,$3,1,$4)`,
      [fixture.workspace, companyId, id, fixture.actor]);
      await client.query(`INSERT INTO myfin.marketing_campaign_versions(
        workspace_id,company_id,campaign_id,version,name,objective,channels,starts_at,
        offer_kind,request_digest,created_by)
        VALUES($1,$2,$3,1,$4,'loyalty',ARRAY['pos'],now()-interval '1 hour',
          'none',$5,$6)`, [fixture.workspace, companyId, id, `Campaign ${id}`,
        digest(`campaign:${id}`), fixture.actor]);
      await client.query(`INSERT INTO myfin.marketing_campaign_events(
        workspace_id,company_id,campaign_id,campaign_version,event_type,to_lifecycle,actor_id)
        VALUES($1,$2,$3,1,'created','draft',$4)`,
      [fixture.workspace, companyId, id, fixture.actor]);
    });

    await requiredSubtest(t, 'audience versions preserve scope and campaigns accept only their company or workspace scope', async () => {
      await createAudience({
        id: fixture.companyAudience,
        scope: 'company',
        companyId: fixture.companyA,
      });
      await createAudience({ id: fixture.workspaceAudience, scope: 'workspace', companyId: null });
      await createCampaign({ id: fixture.campaignA, companyId: fixture.companyA });
      await createCampaign({ id: fixture.campaignB, companyId: fixture.companyB });

      await expectPgError(transaction(migrator, async client => {
        const id = `audience-mismatch-${suffix}`;
        await client.query(`INSERT INTO myfin.marketing_audiences(
          workspace_id,id,company_id,scope,version,updated_by) VALUES($1,$2,$3,'company',1,$4)`,
        [fixture.workspace, id, fixture.companyA, fixture.actor]);
        await client.query(`INSERT INTO myfin.marketing_audience_versions(
          workspace_id,audience_id,version,name,scope,company_id,request_digest,created_by)
          VALUES($1,$2,1,'Mismatched scope','workspace',NULL,$3,$4)`,
        [fixture.workspace, id, digest('mismatched-audience'), fixture.actor]);
      }), '23514', 'audience_scope_changed');

      await migrator.query(`INSERT INTO myfin.marketing_campaign_version_audiences(
        workspace_id,company_id,campaign_id,campaign_version,audience_id,audience_version)
        VALUES($1,$2,$3,1,$4,1)`,
      [fixture.workspace, fixture.companyA, fixture.campaignA, fixture.companyAudience]);
      await expectPgError(migrator.query(`INSERT INTO myfin.marketing_campaign_version_audiences(
        workspace_id,company_id,campaign_id,campaign_version,audience_id,audience_version)
        VALUES($1,$2,$3,1,$4,1)`,
      [fixture.workspace, fixture.companyB, fixture.campaignB, fixture.companyAudience]),
      '23514', 'campaign_audience_scope_mismatch');
      await migrator.query(`INSERT INTO myfin.marketing_campaign_version_audiences(
        workspace_id,company_id,campaign_id,campaign_version,audience_id,audience_version)
        VALUES($1,$2,$3,1,$4,1)`,
      [fixture.workspace, fixture.companyB, fixture.campaignB, fixture.workspaceAudience]);
    });

    const insertFreeItemVersion = (client, promotionId, rewardProductId, rewardVariantId) =>
      client.query(`INSERT INTO myfin.promotion_versions(
        workspace_id,company_id,promotion_id,version,name,enabled,redemption_mode,valid_from,
        currency_code,discount_type,min_subtotal_sen,requires_customer,requires_student,stackable,
        request_digest,created_by,reward_product_id,reward_variant_id,reward_quantity_milli)
        VALUES($1,$2,$3,1,'Free exact variant',true,'automatic',now()-interval '1 day',
          'MYR','free_item',0,false,false,false,$4,$5,$6,$7,1000)`, [fixture.workspace,
        fixture.companyA, promotionId, digest(`promotion:${promotionId}`), fixture.actor,
        rewardProductId, rewardVariantId]);
    const createFreeItemPromotion = promotionId => transaction(migrator, async client => {
      await client.query(`INSERT INTO myfin.promotions(workspace_id,company_id,id,version,updated_by)
        VALUES($1,$2,$3,1,$4)`,
      [fixture.workspace, fixture.companyA, promotionId, fixture.actor]);
      await insertFreeItemVersion(client, promotionId, fixture.rewardProduct, fixture.rewardVariant);
    });
    const createSnapshot = (snapshotId, variantId) => transaction(migrator, async client => {
      await client.query(`INSERT INTO myfin.pricing_snapshots(
        workspace_id,company_id,id,currency_code,subtotal_sen,discount_sen,taxable_sen,
        tax_sen,rounding_sen,total_sen,rules_digest,request_digest,priced_at,expires_at)
        VALUES($1,$2,$3,'MYR',500,500,0,0,0,0,$4,$5,now(),now()+interval '1 hour')`,
      [fixture.workspace, fixture.companyA, snapshotId, digest(`rules:${snapshotId}`),
        digest(`snapshot:${snapshotId}`)]);
      await client.query(`INSERT INTO myfin.pricing_snapshot_lines(
        workspace_id,company_id,snapshot_id,line_no,product_id,variant_id,description,
        quantity_milli,unit_price_sen,gross_sen,discount_sen,net_sen)
        VALUES($1,$2,$3,1,$4,$5,'Reward item',1000,500,500,500,0)`,
      [fixture.workspace, fixture.companyA, snapshotId, fixture.rewardProduct, variantId]);
      await client.query(`INSERT INTO myfin.pricing_snapshot_discounts(
        workspace_id,company_id,snapshot_id,sequence,promotion_id,promotion_version,
        display_name,discount_sen) VALUES($1,$2,$3,1,$4,1,'Free exact variant',500)`,
      [fixture.workspace, fixture.companyA, snapshotId, fixture.promotion]);
      await client.query(`INSERT INTO myfin.pricing_snapshot_discount_lines(
        workspace_id,company_id,snapshot_id,discount_sequence,line_no,discount_sen)
        VALUES($1,$2,$3,1,1,500)`, [fixture.workspace, fixture.companyA, snapshotId]);
    });
    const createSplitRewardSnapshot = snapshotId => transaction(migrator, async client => {
      await client.query(`INSERT INTO myfin.pricing_snapshots(
        workspace_id,company_id,id,currency_code,subtotal_sen,discount_sen,taxable_sen,
        tax_sen,rounding_sen,total_sen,rules_digest,request_digest,priced_at,expires_at)
        VALUES($1,$2,$3,'MYR',500,500,0,0,0,0,$4,$5,now(),now()+interval '1 hour')`,
      [fixture.workspace, fixture.companyA, snapshotId, digest(`rules:${snapshotId}`),
        digest(`snapshot:${snapshotId}`)]);
      await client.query(`INSERT INTO myfin.pricing_snapshot_lines(
        workspace_id,company_id,snapshot_id,line_no,product_id,variant_id,description,
        quantity_milli,unit_price_sen,gross_sen,discount_sen,net_sen,automatic_reward)
        VALUES($1,$2,$3,1,$4,$5,'Existing partial reward',500,500,250,250,0,false),
              ($1,$2,$3,2,$4,$5,'Automatic reward remainder',500,500,250,250,0,true)`,
      [fixture.workspace, fixture.companyA, snapshotId, fixture.rewardProduct, fixture.rewardVariant]);
      await client.query(`INSERT INTO myfin.pricing_snapshot_discounts(
        workspace_id,company_id,snapshot_id,sequence,promotion_id,promotion_version,
        display_name,discount_sen) VALUES($1,$2,$3,1,$4,1,'Free exact variant',500)`,
      [fixture.workspace, fixture.companyA, snapshotId, fixture.promotion]);
      await client.query(`INSERT INTO myfin.pricing_snapshot_discount_lines(
        workspace_id,company_id,snapshot_id,discount_sequence,line_no,discount_sen)
        VALUES($1,$2,$3,1,1,250),($1,$2,$3,1,2,250)`,
      [fixture.workspace, fixture.companyA, snapshotId]);
    });
    const redeemSnapshot = snapshotId => migrator.query(`INSERT INTO myfin.promotion_redemptions(
      workspace_id,company_id,id,promotion_id,promotion_version,pricing_snapshot_id,
      source_type,source_id,idempotency_key,request_digest,discount_sen,occurred_at)
      VALUES($1,$2,$3,$4,1,$5,'invoice',$6,$7,$8,500,now())`, [fixture.workspace,
      fixture.companyA, `redemption-${snapshotId}`, fixture.promotion, snapshotId,
      `source-${snapshotId}`, `idem-${snapshotId}`, digest(`redemption:${snapshotId}`)]);

    await requiredSubtest(t, 'free-item rules require a variant of the reward product and redeem only that exact variant', async () => {
      const invalidPromotion = `invalid-free-item-${suffix}`;
      await expectPgError(transaction(migrator, async client => {
        await client.query(`INSERT INTO myfin.promotions(workspace_id,company_id,id,version,updated_by)
          VALUES($1,$2,$3,1,$4)`,
        [fixture.workspace, fixture.companyA, invalidPromotion, fixture.actor]);
        await insertFreeItemVersion(client, invalidPromotion, fixture.rewardProduct, fixture.otherVariant);
      }), '23503');
      assert.equal((await migrator.query('SELECT count(*)::integer AS count FROM myfin.promotions WHERE id=$1',
        [invalidPromotion])).rows[0].count, 0);

      await createFreeItemPromotion(fixture.promotion);
      const wrongSnapshot = `snapshot-wrong-${suffix}`;
      const exactSnapshot = `snapshot-exact-${suffix}`;
      await createSnapshot(wrongSnapshot, fixture.wrongRewardVariant);
      await expectPgError(redeemSnapshot(wrongSnapshot), '23514', 'free_item_pricing_changed');
      await createSnapshot(exactSnapshot, fixture.rewardVariant);
      await redeemSnapshot(exactSnapshot);
      const splitSnapshot = `snapshot-split-${suffix}`;
      await createSplitRewardSnapshot(splitSnapshot);
      await redeemSnapshot(splitSnapshot);
      assert.equal((await migrator.query(`SELECT redemption_count::integer AS count
        FROM myfin.promotion_usage_counters
        WHERE workspace_id=$1 AND company_id=$2 AND promotion_id=$3`,
      [fixture.workspace, fixture.companyA, fixture.promotion])).rows[0].count, 2);
    });

    await requiredSubtest(t, 'reserved points equal active reservations at commit', async () => {
      await transaction(migrator, async client => {
        for (const [id, key] of [
          [fixture.reservationA, `reserve-a-${suffix}`],
          [fixture.reservationB, `reserve-b-${suffix}`],
        ]) {
          await client.query(`INSERT INTO myfin.loyalty_point_reservations(
            workspace_id,company_id,id,customer_id,points,program_version,idempotency_key,
            request_digest,expires_at,staff_actor_id)
            VALUES($1,$2,$3,$4,30,1,$5,$6,now()+interval '1 hour',$7)`, [fixture.workspace,
            fixture.companyA, id, fixture.customer, key, digest(key), fixture.actor]);
          await client.query(`INSERT INTO myfin.loyalty_point_reservation_events(
            workspace_id,id,reservation_id,action,idempotency_key,request_digest,
            actor_type,staff_actor_id,reason)
            VALUES($1,$2,$3,'reserved',$4,$5,'staff',$6,'Acceptance reservation')`, [
            fixture.workspace, `event-${id}`, id, `event-${key}`, digest(`event:${key}`), fixture.actor,
          ]);
        }
        await client.query(`UPDATE myfin.customer_loyalty_accounts
          SET reserved_points=60,version=version+1,updated_at=now()
          WHERE workspace_id=$1 AND customer_id=$2`, [fixture.workspace, fixture.customer]);
      });
      const total = (await migrator.query(`SELECT account.reserved_points,
        coalesce(sum(reservation.points) FILTER(WHERE reservation.state='active'),0)::integer AS active_points
        FROM myfin.customer_loyalty_accounts account
        LEFT JOIN myfin.loyalty_point_reservations reservation
          ON reservation.workspace_id=account.workspace_id AND reservation.customer_id=account.customer_id
        WHERE account.workspace_id=$1 AND account.customer_id=$2
        GROUP BY account.workspace_id,account.customer_id,account.reserved_points`,
      [fixture.workspace, fixture.customer])).rows[0];
      assert.deepEqual(total, { reserved_points: 60, active_points: 60 });

      await expectPgError(transaction(migrator, client => client.query(`UPDATE myfin.customer_loyalty_accounts
        SET reserved_points=59 WHERE workspace_id=$1 AND customer_id=$2`,
      [fixture.workspace, fixture.customer])), '23514', 'loyalty_reserved_total_changed');
      assert.equal((await migrator.query(`SELECT reserved_points FROM myfin.customer_loyalty_accounts
        WHERE workspace_id=$1 AND customer_id=$2`,
      [fixture.workspace, fixture.customer])).rows[0].reserved_points, 60);
    });

    const mismatchedRedeemEvent = `redeem-mismatch-${suffix}`;
    const exactRedeemEvent = `redeem-exact-${suffix}`;
    await requiredSubtest(t, 'consumed reservations bind one exact matching redeem event', async () => {
      await migrator.query(`INSERT INTO myfin.loyalty_point_events(
        workspace_id,company_id,id,customer_id,kind,points,balance_after,reserved_after,
        program_id,program_version,actor_type,staff_actor_id,reason,idempotency_key,
        request_digest,occurred_at)
        VALUES($1,$2,$3,$4,'redeem',-29,100,60,'workspace-loyalty',1,'staff',$5,
          'Deliberately mismatched redemption',$6,$7,now())`, [fixture.workspace, fixture.companyA,
        mismatchedRedeemEvent, fixture.customer, fixture.actor, `idem-${mismatchedRedeemEvent}`,
        digest(mismatchedRedeemEvent)]);
      await expectPgError(migrator.query(`UPDATE myfin.loyalty_point_reservations
        SET state='consumed',consumed_event_id=$3,consumed_at=now(),updated_at=now()
        WHERE workspace_id=$1 AND id=$2`,
      [fixture.workspace, fixture.reservationA, mismatchedRedeemEvent]),
      '23514', 'loyalty_reservation_consumed_event_changed');

      await transaction(migrator, async client => {
        await client.query(`UPDATE myfin.customer_loyalty_accounts
          SET stamp_balance=70,reserved_points=30,version=version+1,updated_at=now()
          WHERE workspace_id=$1 AND customer_id=$2`, [fixture.workspace, fixture.customer]);
        await client.query(`INSERT INTO myfin.loyalty_point_events(
          workspace_id,company_id,id,customer_id,kind,points,balance_after,reserved_after,
          program_id,program_version,actor_type,staff_actor_id,reason,idempotency_key,
          request_digest,occurred_at)
          VALUES($1,$2,$3,$4,'redeem',-30,70,30,'workspace-loyalty',1,'staff',$5,
            'Exact reservation redemption',$6,$7,now())`, [fixture.workspace, fixture.companyA,
          exactRedeemEvent, fixture.customer, fixture.actor, `idem-${exactRedeemEvent}`,
          digest(exactRedeemEvent)]);
        await client.query(`UPDATE myfin.loyalty_point_reservations
          SET state='consumed',consumed_event_id=$3,consumed_at=now(),updated_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [fixture.workspace, fixture.reservationA, exactRedeemEvent]);
        await client.query(`INSERT INTO myfin.loyalty_point_reservation_events(
          workspace_id,id,reservation_id,action,idempotency_key,request_digest,
          actor_type,staff_actor_id,reason)
          VALUES($1,$2,$3,'consumed',$4,$5,'staff',$6,'Exact redemption consumed')`, [
          fixture.workspace, `consumed-${suffix}`, fixture.reservationA, `consume-${suffix}`,
          digest(`consume:${suffix}`), fixture.actor,
        ]);
      });
      const account = (await migrator.query(`SELECT stamp_balance,reserved_points
        FROM myfin.customer_loyalty_accounts WHERE workspace_id=$1 AND customer_id=$2`,
      [fixture.workspace, fixture.customer])).rows[0];
      assert.deepEqual(account, { stamp_balance: 70, reserved_points: 30 });
      await expectPgError(migrator.query(`UPDATE myfin.loyalty_point_reservations
        SET state='consumed',consumed_event_id=$3,consumed_at=now(),updated_at=now()
        WHERE workspace_id=$1 AND id=$2`,
      [fixture.workspace, fixture.reservationB, exactRedeemEvent]), '23505');
      assert.equal((await migrator.query(`SELECT state FROM myfin.loyalty_point_reservations
        WHERE workspace_id=$1 AND id=$2`, [fixture.workspace, fixture.reservationB])).rows[0].state,
      'active');
    });

    await requiredSubtest(t, 'marketing and loyalty version and event rows are append-only', async () => {
      const mutations = [
        {
          sql: `UPDATE myfin.marketing_audience_versions SET name=name
            WHERE workspace_id=$1 AND audience_id=$2 AND version=1`,
          params: [fixture.workspace, fixture.companyAudience],
          message: 'marketing_history_immutable',
        },
        {
          sql: `DELETE FROM myfin.marketing_campaign_versions
            WHERE workspace_id=$1 AND company_id=$2 AND campaign_id=$3 AND version=1`,
          params: [fixture.workspace, fixture.companyA, fixture.campaignA],
          message: 'marketing_history_immutable',
        },
        {
          sql: `UPDATE myfin.marketing_campaign_events SET details=details
            WHERE workspace_id=$1 AND company_id=$2 AND campaign_id=$3`,
          params: [fixture.workspace, fixture.companyA, fixture.campaignA],
          message: 'marketing_history_immutable',
        },
        {
          sql: `UPDATE myfin.promotion_versions SET reward_variant_id=reward_variant_id
            WHERE workspace_id=$1 AND company_id=$2 AND promotion_id=$3 AND version=1`,
          params: [fixture.workspace, fixture.companyA, fixture.promotion],
          message: 'promotion_history_immutable',
        },
        {
          sql: `UPDATE myfin.workspace_loyalty_setting_versions SET unit_label=unit_label
            WHERE workspace_id=$1 AND version=1`,
          params: [fixture.workspace],
          message: 'loyalty_history_immutable',
        },
        {
          sql: `DELETE FROM myfin.loyalty_point_events WHERE workspace_id=$1 AND id=$2`,
          params: [fixture.workspace, exactRedeemEvent],
          message: 'loyalty_history_immutable',
        },
        {
          sql: `UPDATE myfin.loyalty_point_reservation_events SET reason=reason
            WHERE workspace_id=$1 AND reservation_id=$2`,
          params: [fixture.workspace, fixture.reservationA],
          message: 'loyalty_history_immutable',
        },
        {
          sql: `UPDATE myfin.loyalty_point_reservations SET updated_at=now()
            WHERE workspace_id=$1 AND id=$2`,
          params: [fixture.workspace, fixture.reservationA],
          message: 'loyalty_reservation_history_immutable',
        },
      ];
      for (const mutation of mutations)
        await expectPgError(migrator.query(mutation.sql, mutation.params), '23514', mutation.message);
    });

    await requiredSubtest(t, 'a runtime-style role cannot alter schema or migration and history rows', async roleTest => {
      if (!safety.is_superuser) {
        roleTest.skip('runtime role setup requires a disposable-cluster superuser');
        return;
      }
      const quotedRole = quoteIdentifier(runtimeRole);
      await admin.query(`CREATE ROLE ${quotedRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
      roleCreated = true;
      await migrator.query(`GRANT USAGE ON SCHEMA myfin TO ${quotedRole}`);
      await migrator.query(`GRANT SELECT ON myfin.schema_migrations TO ${quotedRole}`);
      await migrator.query(`GRANT SELECT,INSERT,UPDATE ON
        myfin.marketing_audiences,myfin.marketing_campaigns,myfin.loyalty_point_reservations
        TO ${quotedRole}`);
      await migrator.query(`GRANT SELECT,INSERT ON
        myfin.marketing_audience_versions,myfin.marketing_campaign_versions,
        myfin.marketing_campaign_version_audiences,myfin.marketing_campaign_events,
        myfin.workspace_loyalty_setting_versions,myfin.loyalty_point_events,
        myfin.loyalty_point_reservation_events TO ${quotedRole}`);
      await migrator.query(`SET ROLE ${quotedRole}`);
      try {
        const privileges = (await migrator.query(`SELECT current_user AS role_name,
          has_schema_privilege(current_user,'myfin','CREATE') AS schema_create,
          has_table_privilege(current_user,'myfin.schema_migrations','UPDATE') AS migration_update,
          has_table_privilege(current_user,'myfin.marketing_campaign_events','UPDATE') AS history_update`)).rows[0];
        assert.deepEqual(privileges, {
          role_name: runtimeRole,
          schema_create: false,
          migration_update: false,
          history_update: false,
        });
        assert.equal((await migrator.query('SELECT count(*)::integer AS count FROM myfin.schema_migrations'))
          .rows[0].count > 0, true);
        await expectPgError(migrator.query('CREATE TABLE myfin.runtime_schema_escape(id text)'), '42501');
        await expectPgError(migrator.query(
          'ALTER TABLE myfin.marketing_campaign_events ADD COLUMN runtime_escape boolean'), '42501');
        await expectPgError(migrator.query(
          "UPDATE myfin.schema_migrations SET checksum=repeat('0',64) WHERE version='0030_marketing_rewards_loyalty.sql'"),
        '42501');
        await expectPgError(migrator.query(`UPDATE myfin.marketing_campaign_events SET details=details
          WHERE workspace_id=$1 AND company_id=$2 AND campaign_id=$3`,
        [fixture.workspace, fixture.companyA, fixture.campaignA]), '42501');
      } finally {
        await migrator.query('RESET ROLE').catch(() => {});
      }
    });
  } finally {
    if (migrator) await migrator.end().catch(() => {});
    try {
      if (databaseCreated)
        await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    } finally {
      try {
        if (roleCreated) await admin.query(`DROP ROLE ${quoteIdentifier(runtimeRole)}`);
      } finally {
        await admin.end();
      }
    }
  }
});
