-- Explicit MyFin-only ACLs, run after migrations as provisioning administrator.
\set ON_ERROR_STOP on
SELECT current_database() = 'myfin_dev' AS correct_database \gset
\if :correct_database
GRANT SELECT ON myfin.schema_migrations TO myfin_dev_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON myfin.auth_user, myfin.auth_session,
 myfin.auth_account, myfin.auth_verification, myfin.companies, myfin.app_identities,
 myfin.identity_mappings, myfin.memberships, myfin.products, myfin.product_variants,
 myfin.clients, myfin.transactions, myfin.expenses, myfin.files,
 myfin.workspaces, myfin.workspace_memberships, myfin.tenant_hosts,
 myfin.pos_access_codes, myfin.pos_login_guards, myfin.pos_sessions,
 myfin.app_sessions, myfin.session_handoffs TO myfin_dev_runtime;
GRANT SELECT, INSERT, UPDATE ON myfin.stock_items TO myfin_dev_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON myfin.stock_packagings TO myfin_dev_runtime;
GRANT SELECT, INSERT ON myfin.stock_ledger TO myfin_dev_runtime;
GRANT SELECT, INSERT, UPDATE ON myfin.orders TO myfin_dev_runtime;
GRANT SELECT, INSERT ON myfin.order_events TO myfin_dev_runtime;
GRANT SELECT,INSERT,UPDATE ON myfin.storefront_settings,myfin.storefront_hosts,myfin.shop_locations,
 myfin.storefront_products,myfin.storefront_delivery_zones,myfin.customer_guest_sessions,myfin.customer_accounts,
 myfin.customer_credentials,myfin.customer_sessions,myfin.customer_workspace_profiles,
 myfin.customer_loyalty_accounts,myfin.customer_order_requests,
 myfin.customer_order_reservations,myfin.workspace_loyalty_settings TO myfin_dev_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON myfin.storefront_product_variants,
 myfin.storefront_carousel_slides TO myfin_dev_runtime;
GRANT SELECT,INSERT ON myfin.customer_identities,myfin.customer_company_links,myfin.customer_consent_events,
 myfin.customer_loyalty_events,myfin.customer_order_lines,myfin.customer_order_events,
 myfin.customer_order_payments TO myfin_dev_runtime;
GRANT SELECT, INSERT ON myfin.expense_import_batches TO myfin_dev_runtime;
GRANT SELECT, INSERT, DELETE ON myfin.expense_links TO myfin_dev_runtime;
GRANT SELECT, INSERT ON myfin.expense_events TO myfin_dev_runtime;
GRANT SELECT, INSERT ON myfin.activities, myfin.stock_movements,
 myfin.company_enrollments, myfin.management_events,
 myfin.document_template_versions, myfin.document_payments, myfin.document_events,
 myfin.action_approvals TO myfin_dev_runtime;
GRANT SELECT,INSERT,UPDATE ON myfin.document_number_sequences,myfin.document_templates,myfin.document_template_defaults,myfin.receipt_reviews TO myfin_dev_runtime;
GRANT SELECT,INSERT,UPDATE ON myfin.integration_connections TO myfin_dev_runtime;
GRANT SELECT ON myfin.integration_events,myfin.integration_financial_entries,myfin.integration_reconciliations TO myfin_dev_runtime;
GRANT SELECT ON myfin.integration_payment_transactions TO myfin_dev_runtime;
GRANT SELECT,INSERT,UPDATE ON myfin.inventory_recipes TO myfin_dev_runtime;
GRANT SELECT,INSERT ON myfin.inventory_recipe_versions,myfin.inventory_recipe_components,myfin.inventory_source_effects TO myfin_dev_runtime;
GRANT SELECT,INSERT,UPDATE ON myfin.stock_identifiers,myfin.purchase_orders,
 myfin.inventory_weighted_costs,myfin.low_stock_alerts TO myfin_dev_runtime;
GRANT SELECT,INSERT ON myfin.purchase_order_lines,myfin.purchase_order_events,
 myfin.goods_receipts,myfin.goods_receipt_lines,myfin.stock_batches,
 myfin.goods_receipt_reversals,myfin.inventory_valuation_events,
 myfin.low_stock_alert_events TO myfin_dev_runtime;
GRANT SELECT,INSERT,UPDATE ON myfin.report_schedules,myfin.report_runs TO myfin_dev_runtime;
GRANT SELECT,INSERT,UPDATE ON myfin.student_eligibilities,myfin.promotions,
 myfin.promotion_vouchers TO myfin_dev_runtime;
GRANT SELECT,INSERT ON myfin.student_eligibility_events,myfin.promotion_versions,
 myfin.promotion_version_products,myfin.promotion_version_categories,
 myfin.promotion_version_customers,myfin.promotion_voucher_versions TO myfin_dev_runtime;
GRANT SELECT ON myfin.promotion_usage_counters,myfin.promotion_customer_usage_counters,
 myfin.promotion_voucher_usage_counters,myfin.promotion_voucher_customer_usage_counters TO myfin_dev_runtime;
GRANT SELECT,INSERT ON myfin.pricing_snapshots,myfin.pricing_snapshot_lines,
 myfin.pricing_snapshot_discounts,myfin.pricing_snapshot_discount_lines,
 myfin.promotion_redemptions TO myfin_dev_runtime;
GRANT SELECT ON myfin.promotion_reservations,myfin.promotion_reservation_events TO myfin_dev_runtime;
GRANT SELECT,INSERT,UPDATE ON myfin.customer_order_recipe_reservations TO myfin_dev_runtime;
GRANT SELECT,INSERT,UPDATE ON myfin.marketing_audiences,myfin.marketing_campaigns TO myfin_dev_runtime;
GRANT SELECT,INSERT ON myfin.marketing_audience_versions,myfin.marketing_campaign_versions,
 myfin.marketing_campaign_version_promotions,myfin.marketing_campaign_version_audiences,
 myfin.marketing_campaign_events TO myfin_dev_runtime;
GRANT USAGE,SELECT ON SEQUENCE myfin.marketing_campaign_events_sequence_seq TO myfin_dev_runtime;
GRANT SELECT,INSERT ON myfin.workspace_loyalty_setting_versions,myfin.loyalty_point_events,
 myfin.loyalty_sale_award_batches,myfin.loyalty_point_reservation_events TO myfin_dev_runtime;
GRANT SELECT,INSERT,UPDATE ON myfin.loyalty_point_reservations TO myfin_dev_runtime;
GRANT SELECT,INSERT,UPDATE ON myfin.payment_gateway_connections TO myfin_dev_runtime;
GRANT SELECT,INSERT ON myfin.online_payment_intents,myfin.online_payment_events,
 myfin.online_payment_finalizations TO myfin_dev_runtime;
GRANT SELECT,INSERT,UPDATE ON myfin.online_payment_reconciliation_jobs TO myfin_dev_runtime;
GRANT SELECT,INSERT,UPDATE ON myfin.receipt_email_deliveries TO myfin_dev_runtime;
GRANT INSERT ON myfin.receipt_email_events TO myfin_dev_runtime;
GRANT SELECT ON myfin.customer_order_online_payment_state TO myfin_dev_runtime;
-- PostgreSQL locking reads require UPDATE even when immutable evidence rows are never changed.
GRANT UPDATE ON myfin.inventory_source_effects,myfin.purchase_order_lines,
 myfin.goods_receipts,myfin.goods_receipt_lines,myfin.pricing_snapshots,
 myfin.promotion_redemptions,myfin.loyalty_point_events,myfin.loyalty_sale_award_batches,
 myfin.customer_order_lines,myfin.inventory_recipe_versions,
 myfin.inventory_recipe_components TO myfin_dev_runtime;
GRANT EXECUTE ON FUNCTION myfin.reserve_order_promotions(text,text,text,timestamptz),
 myfin.reserve_pos_promotions(text,text,text,timestamptz),
 myfin.release_pos_promotions(text,text,text,text),
 myfin.authorize_pos_pricing_recovery(text,text,text,text,text),
 myfin.pos_pricing_recovery_authorized(text,text,text),
 myfin.cleanup_expired_unbound_storefront_pricing_snapshots(integer),
 myfin.extend_order_promotion_reservations(text,text,timestamptz),
 myfin.release_order_promotion_reservations(text,text,text),
 myfin.consume_order_promotion_reservations(text,text,text,timestamptz) TO myfin_dev_runtime;
\else
\echo 'Refusing runtime grants outside myfin_dev'
\quit 1
\endif
