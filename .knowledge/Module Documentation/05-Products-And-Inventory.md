# Products And Inventory

## Purpose

Manages product catalog, service items, variants, SKU generation, product pricing, stock fields, and POS product availability.

## Source Files

- `src/components/dashboard/ProductsTab.vue`
- `src/components/dashboard/products/ProductEditorModal.vue`
- `src/components/dashboard/products/ProductList.vue`
- `src/components/dashboard/pos/PosProductGrid.vue`
- `src/composables/useProductLogic.js`
- `src/store/inventory.js`

## Data Model

Firestore collection: `products`

Common fields:

- `id`
- `company_id`
- `name`
- `category`
- `unit`
- `description`
- `sku`
- `trackStock`
- `price`
- `cost`
- `stock`
- `hasVariants`
- `variants`

Variant fields:

- `name`
- `price`
- `cost`
- `stock`

## Product Editing

- `ProductsTab.vue` owns modal state and validation.
- `ProductEditorModal.vue` owns form behavior, category-based defaults, SKU generation, and variant editing.
- Service items force `trackStock = false` and stock values to zero.
- Products with variants must have at least one variant before saving.

## Store Behavior

- `inventoryModule.addProduct()` and `updateProduct()` set `company_id` and normalize numeric fields with `Number(...)`.
- Variant prices, costs, and stocks are normalized during writes.
- `deleteProduct()` requires `Store.canDelete()`.
- `deductStock()` uses Firestore `increment()` for simple products only.

## POS Integration

- `PosProductGrid.vue` filters products by search and category.
- `PosTab.vue` shows a variant picker when `product.variants` exists.
- Cart items use product name, variant display name, price, and quantity.

## UI Rules

- Keep catalog management in `/products`.
- Keep product row display in `ProductList.vue`.
- Keep SKU generation in `useProductLogic.js`.
- Show service stock as `N/A`.

## Agent Notes

- Product fields use both `sku` and `code` in different UI places. `ProductEditorModal.vue` writes `sku`; POS search/display checks `p.code`. Verify field naming before changing search or display.
- Variant stock deduction is explicitly not concurrency safe in the current MVP notes.
- `hasVariants` is a UI helper; the stored source of truth is usually whether `variants` has entries.
