# POS

## Purpose

Provides point-of-sale product browsing, cart management, held orders, checkout, payment capture, recent sales, and sale completion.

## Source Files

- `src/components/dashboard/PosTab.vue`
- `src/components/dashboard/pos/PosProductGrid.vue`
- `src/components/dashboard/pos/PosCart.vue`
- `src/components/dashboard/pos/PosPaymentModal.vue`
- `src/components/dashboard/pos/PosOrderModal.vue`
- `src/components/dashboard/pos/PosSuccessModal.vue`
- `src/store/finance.js`

## Data Inputs

- Active company from `Store.state.selectedCompany`.
- Products from `Store.state.products` filtered by active `company_id`.
- Recent sales from `Store.state.transactions`.

## Cart Flow

- Product grid emits `add-to-cart`.
- `PosTab.vue` opens a variant picker if the product has variants.
- Cart line identity is based on item name and price.
- Cart totals are computed from line item price and quantity.
- Held carts are local component state only and are not persisted.

## Checkout Flow

- `PosPaymentModal.vue` supports:
  - Cash
  - QR Pay
  - Card
- Cash requires received amount to be at least the total.
- On complete, `PosTab.vue` creates a transaction:
  - `type: 'Invoice'`
  - `number: 'POS-' + timestamp`
  - `status: 'Cleared'`
  - line items mapped to `{ desc, qty, price, unit }`
  - `paymentMethod`
  - `history`
- Transaction is saved through `Store.addTransaction()`.

## Recent Sales

`PosTab.vue` shows today's cleared invoices or POS-numbered transactions from the active company.

## UI Rules

- Keep POS layout split between product grid and cart.
- Preserve fixed-height cart scrolling for desktop and mobile usability.
- Use `SmartButton` where cart restore or destructive actions need confirmation.
- Keep payment completion feedback in `PosSuccessModal.vue`.

## Agent Notes

- POS tax calculation checks `activeCompany.preferences?.taxRate`, while company settings use `preferences.tax`. Verify before changing tax behavior.
- QR payment modal checks `company.qrCodeUrl`, while company settings save `qrCode`.
- Receipt printing is currently a placeholder that logs and notifies.
- POS does not currently call `inventoryModule.deductStock()` after sale completion.
