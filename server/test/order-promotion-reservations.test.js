import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('reservation migration serializes capacity and counts only live holds', async () => {
  const sql = await read('../../db/migrations/0027_order_promotion_reservations.sql');
  assert.match(sql, /CREATE TABLE myfin\.promotion_reservations[\s\S]*state text NOT NULL DEFAULT 'active'[\s\S]*CHECK\(state IN \('active','released','consumed'\)\)/);
  assert.match(sql, /promotion_reservations_global_active_idx[\s\S]*WHERE state='active'/);
  const reserve = sql.slice(sql.indexOf('CREATE FUNCTION myfin.reserve_order_promotions'),
    sql.indexOf('CREATE FUNCTION myfin.extend_order_promotion_reservations'));
  const parentLock = reserve.indexOf('FROM myfin.promotions');
  const totalUsage = reserve.indexOf('FROM myfin.promotion_usage_counters');
  const activeHolds = reserve.indexOf('FROM myfin.promotion_reservations', totalUsage);
  assert.ok(parentLock >= 0 && parentLock < totalUsage && totalUsage < activeHolds,
    'the promotion parent must serialize redemption plus reservation capacity checks');
  assert.match(reserve, /state='active' AND expires_at>now\(\)/);
  assert.match(reserve, /coalesce\(used,0\)\+held>=rule\.max_total_redemptions/);
  assert.match(reserve, /FROM myfin\.promotion_vouchers[\s\S]*FOR UPDATE/);
  assert.match(reserve, /coalesce\(used,0\)\+held>=voucher_rule\.max_redemptions/);
});

test('reservation state transitions are order-bound, auditable and reusable after release', async () => {
  const sql = await read('../../db/migrations/0027_order_promotion_reservations.sql');
  const extend = sql.slice(sql.indexOf('CREATE FUNCTION myfin.extend_order_promotion_reservations'),
    sql.indexOf('CREATE FUNCTION myfin.release_order_promotion_reservations'));
  assert.match(extend, /order_row\.status NOT IN \('accepted','preparing','ready'\)/);
  assert.match(extend, /order_row\.expires_at IS DISTINCT FROM requested_expiry/);
  const release = sql.slice(sql.indexOf('CREATE FUNCTION myfin.release_order_promotion_reservations'),
    sql.indexOf('CREATE FUNCTION myfin.apply_reserved_promotion_usage'));
  assert.doesNotMatch(release, /requested_reason<>'rollback'/);
  assert.match(release, /requested_reason NOT IN \('cancelled','expired'\)/);
  assert.match(release, /order_row\.status<>requested_reason/);
  assert.match(release, /order_row\.payment_state<>'unpaid'/);
  assert.match(release, /SET state='released',released_at=now\(\)/);
  assert.match(release, /append_promotion_reservation_event\(reservation,'released'/);
  assert.match(sql, /promotion_reservation_history_immutable/);
  assert.match(sql, /promotion_reservation_identity_immutable/);
  assert.doesNotMatch(sql, /(?:voucher_code|student_document)\s+(?:text|json|bytea)/i);
});

test('reserved tender remains valid after quote expiry or rule replacement but only for the exact paid source', async () => {
  const sql = await read('../../db/migrations/0027_order_promotion_reservations.sql');
  const trigger = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION myfin.enforce_promotion_redemption'),
    sql.indexOf('CREATE FUNCTION myfin.consume_order_promotion_reservations'));
  const reserved = trigger.slice(trigger.indexOf("IF NEW.source_type='customer_order'"),
    trigger.indexOf('SELECT * INTO current_promotion'));
  assert.match(reserved, /r\.state='active'/);
  assert.match(reserved, /NEW\.occurred_at>=reservation\.expires_at/);
  assert.match(reserved, /reserved_order\.status<>'paid'/);
  assert.match(reserved, /sale\.source='pos' AND sale\.pricing_snapshot_id=NEW\.pricing_snapshot_id/);
  assert.doesNotMatch(reserved, /snapshot\.expires_at|current_promotion\.version|rule\.valid_until/);
  assert.match(trigger, /PERFORM myfin\.apply_reserved_promotion_usage\(reservation\)/);
});

test('consumption is exact-once and every failure stays inside the tender transaction', async () => {
  const [baseSql, sql, orders, business] = await Promise.all([
    read('../../db/migrations/0022_student_promotions.sql'),
    read('../../db/migrations/0027_order_promotion_reservations.sql'),
    read('../src/customer-orders.js'), read('../src/business.js'),
  ]);
  const consume = sql.slice(sql.indexOf('CREATE FUNCTION myfin.consume_order_promotion_reservations'),
    sql.indexOf('REVOKE ALL ON myfin.promotion_reservations'));
  assert.match(consume, /IF reservation\.state='consumed'[\s\S]*promotion_consumption_incomplete[\s\S]*CONTINUE/);
  assert.match(baseSql, /UNIQUE\(company_id,promotion_id,source_type,source_id\)/);
  assert.match(consume, /order_row\.status='paid'[\s\S]*payment\.sale_id=requested_sale[\s\S]*sale\.pricing_snapshot_id=reservation\.pricing_snapshot_id/);
  assert.doesNotMatch(consume, /\bCOMMIT\b|\bROLLBACK\b/);
  const tender = orders.slice(orders.indexOf("app.post('/api/companies/:company/customer-orders/:id/tender'"));
  const completion = orders.slice(orders.indexOf('async function completePaidOrder'),
    orders.indexOf('export function registerCustomerOrders'));
  assert.ok(tender.indexOf('SELECT p.request_digest,p.sale_id') < tender.indexOf('customer_order_not_tenderable'));
  assert.match(orders, /SELECT company_id,id,data FROM myfin\.transactions/);
  assert.match(orders, /sale: publicTransaction/);
  assert.ok(completion.indexOf('await checkout(') < completion.indexOf('INSERT INTO myfin.customer_order_payments'));
  assert.ok(completion.indexOf("SET status='paid',payment_state='paid'") < completion.indexOf('consumeOrderPromotionReservations'));
  assert.match(tender, /completePaidOrder/);
  assert.match(business, /INSERT INTO myfin\.transactions\([\s\S]*pricing_snapshot_id,[\s\S]*register_shift_id\)/);
});

test('storefront token and submit paths never persist a raw voucher', async () => {
  const [storefront, engine, ui, domain] = await Promise.all([
    read('../src/storefront-public.js'),
    read('../src/pricing-engine.js'),
    read('../../src/components/customer/CustomerStorefront.vue'),
    read('../../src/domain/customerOrdering.js'),
  ]);
  assert.match(storefront, /cartTokenInput\(input\)/);
  assert.doesNotMatch(storefront.slice(storefront.indexOf('function quoteToken'), storefront.indexOf('function verifyQuoteToken')),
    /voucherCode/);
  assert.match(ui, /currentOrder\(true\)/);
  assert.match(ui, /customerOrderSubmission\(\{ order: currentOrder\(\)/);
  assert.doesNotMatch(domain.slice(domain.indexOf('export function customerOrderSubmission')),
    /voucherCode/);
  assert.match(engine, /voucher_invalid_or_unavailable/);
  assert.match(storefront, /promotion_unavailable/);
});

test('runtime can use public lifecycle functions but cannot mutate reservations or counters directly', async () => {
  const grants = await Promise.all([
    read('../../db/grant-development-runtime.sql'), read('../../db/grant-production-runtime.sql'),
  ]);
  for (const sql of grants) {
    assert.match(sql, /GRANT EXECUTE ON FUNCTION myfin\.reserve_order_promotions/);
    assert.match(sql, /myfin\.consume_order_promotion_reservations\(text,text,text,timestamptz\)/);
    assert.match(sql, /GRANT SELECT ON myfin\.promotion_reservations,myfin\.promotion_reservation_events/);
    assert.doesNotMatch(sql, /GRANT[^;]*(?:INSERT|UPDATE|DELETE)[^;]*myfin\.promotion_reservations/);
    assert.doesNotMatch(sql, /GRANT[^;]*(?:INSERT|UPDATE|DELETE)[^;]*myfin\.promotion_usage_counters/);
  }
});
