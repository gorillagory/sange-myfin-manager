\set ON_ERROR_STOP on
SELECT current_database()='myfin_prod' AS correct_database \gset
\if :correct_database
GRANT SELECT ON myfin.schema_migrations TO myfin_prod_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON myfin.auth_user,myfin.auth_session,myfin.auth_account,myfin.auth_verification,
 myfin.companies,myfin.app_identities,myfin.identity_mappings,myfin.memberships,myfin.products,myfin.product_variants,
 myfin.clients,myfin.transactions,myfin.expenses,myfin.files,myfin.workspaces,myfin.workspace_memberships,
 myfin.tenant_hosts,myfin.pos_access_codes,myfin.pos_login_guards,myfin.pos_sessions,
 myfin.app_sessions,myfin.session_handoffs TO myfin_prod_runtime;
GRANT SELECT,INSERT,UPDATE ON myfin.stock_items TO myfin_prod_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON myfin.stock_packagings TO myfin_prod_runtime;
GRANT SELECT,INSERT ON myfin.stock_ledger TO myfin_prod_runtime;
GRANT SELECT,INSERT ON myfin.expense_import_batches TO myfin_prod_runtime;
GRANT SELECT,INSERT ON myfin.activities,myfin.stock_movements,myfin.company_enrollments,myfin.management_events,
 myfin.document_template_versions,myfin.document_payments,myfin.document_events,myfin.action_approvals TO myfin_prod_runtime;
GRANT SELECT,INSERT,UPDATE ON myfin.document_number_sequences,myfin.document_templates,myfin.document_template_defaults,myfin.receipt_reviews TO myfin_prod_runtime;
\else
\echo 'Refusing runtime grants outside myfin_prod'
\quit 1
\endif
