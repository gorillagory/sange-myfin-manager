export const REQUIRED_RUNTIME_MIGRATION = '0034_receipt_sync_recovery.sql';

const tableGroups = [
  {
    privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    objects: [
      'auth_user', 'auth_session', 'auth_account', 'auth_verification',
      'companies', 'app_identities', 'identity_mappings', 'memberships',
      'products', 'product_variants', 'clients', 'transactions', 'expenses', 'files',
      'stock_packagings',
      'workspaces', 'workspace_memberships', 'tenant_hosts', 'pos_access_codes',
      'pos_login_guards', 'pos_sessions', 'app_sessions', 'session_handoffs',
      'storefront_product_variants',
    ],
  },
  {
    privileges: ['SELECT', 'INSERT', 'UPDATE'],
    objects: [
      'stock_items', 'orders',
      'storefront_settings', 'storefront_hosts', 'shop_locations', 'storefront_products',
      'storefront_delivery_zones', 'customer_guest_sessions', 'customer_accounts',
      'customer_credentials', 'customer_sessions', 'customer_workspace_profiles',
      'customer_loyalty_accounts', 'customer_order_requests', 'customer_order_reservations',
      'workspace_loyalty_settings', 'document_number_sequences', 'document_templates',
      'document_template_defaults', 'receipt_reviews', 'integration_connections',
      'inventory_recipes', 'stock_identifiers', 'purchase_orders', 'inventory_weighted_costs',
      'low_stock_alerts', 'report_schedules', 'report_runs', 'student_eligibilities',
      'promotions', 'promotion_vouchers', 'customer_order_recipe_reservations',
      'marketing_audiences', 'marketing_campaigns', 'loyalty_point_reservations',
      'inventory_source_effects', 'purchase_order_lines', 'goods_receipts',
      'goods_receipt_lines', 'pricing_snapshots', 'promotion_redemptions',
      'loyalty_point_events', 'loyalty_sale_award_batches',
      'customer_order_lines', 'inventory_recipe_versions', 'inventory_recipe_components',
    ],
  },
  {
    privileges: ['SELECT', 'INSERT'],
    objects: [
      'stock_ledger', 'order_events', 'customer_identities', 'customer_company_links',
      'customer_consent_events', 'customer_loyalty_events',
      'customer_order_events', 'customer_order_payments', 'expense_import_batches',
      'expense_events', 'activities', 'stock_movements', 'company_enrollments',
      'management_events', 'document_template_versions', 'document_payments',
      'document_events', 'action_approvals', 'purchase_order_events', 'stock_batches',
      'goods_receipt_reversals', 'inventory_valuation_events', 'low_stock_alert_events',
      'student_eligibility_events', 'promotion_versions', 'promotion_version_products',
      'promotion_version_categories', 'promotion_version_customers',
      'promotion_voucher_versions', 'pricing_snapshot_lines',
      'pricing_snapshot_discounts', 'pricing_snapshot_discount_lines',
      'marketing_audience_versions', 'marketing_campaign_versions',
      'marketing_campaign_version_promotions', 'marketing_campaign_version_audiences',
      'marketing_campaign_events', 'workspace_loyalty_setting_versions',
      'loyalty_point_reservation_events',
    ],
  },
  { privileges: ['SELECT', 'INSERT', 'DELETE'], objects: ['expense_links'] },
  {
    privileges: ['SELECT'],
    objects: [
      'schema_migrations', 'integration_events', 'integration_financial_entries',
      'integration_reconciliations', 'integration_payment_transactions',
      'promotion_usage_counters', 'promotion_customer_usage_counters',
      'promotion_voucher_usage_counters', 'promotion_voucher_customer_usage_counters',
      'promotion_reservations', 'promotion_reservation_events',
    ],
  },
];

function privilegeMap(groups) {
  const result = {};
  for (const { objects, privileges } of groups) {
    for (const object of objects) {
      if (result[object]) throw new Error(`duplicate_runtime_privilege_object:${object}`);
      result[object] = Object.freeze([...privileges]);
    }
  }
  return Object.freeze(result);
}

export const RUNTIME_PRIVILEGES = Object.freeze({
  schemas: Object.freeze({ myfin: Object.freeze(['USAGE']) }),
  tables: privilegeMap(tableGroups),
  sequences: Object.freeze({
    marketing_campaign_events_sequence_seq: Object.freeze(['USAGE']),
  }),
  functions: Object.freeze({
    'reserve_order_promotions(text,text,text,timestamptz)': Object.freeze(['EXECUTE']),
    'extend_order_promotion_reservations(text,text,timestamptz)': Object.freeze(['EXECUTE']),
    'release_order_promotion_reservations(text,text,text)': Object.freeze(['EXECUTE']),
    'consume_order_promotion_reservations(text,text,text,timestamptz)': Object.freeze(['EXECUTE']),
  }),
});

export function runtimePrivilegeCheck(startParameter = 1) {
  if (!Number.isSafeInteger(startParameter) || startParameter < 1)
    throw new TypeError('invalid_runtime_privilege_parameter');
  const parameters = [], predicates = [];
  const append = (kind, object, privilege) => {
    const objectParameter = startParameter + parameters.length;
    parameters.push(kind === 'schema' ? object : `myfin.${object}`, privilege);
    predicates.push(`has_${kind}_privilege(current_user, $${objectParameter}, $${objectParameter + 1})`);
  };
  for (const [kind, objects] of Object.entries(RUNTIME_PRIVILEGES)) {
    const singular = kind.slice(0, -1);
    for (const object of Object.keys(objects).sort())
      for (const privilege of objects[object]) append(singular, object, privilege);
  }
  return Object.freeze({
    predicate: predicates.join('\n        AND '),
    parameters: Object.freeze(parameters),
  });
}
