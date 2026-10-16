# Inventory, receipts and printer setup

## Inventory

- Inventory uses the Edition light palette independently of the device's dark-mode preference.
- Product and contact editors use native modal dialogs, keyboard focus containment, 48 px inputs and persistent header/footer actions. Variant names, SKUs, barcodes, prices, costs and stock are editable in place.
- Download **SKU template**, replace its example rows, then choose **Upload CSV**. The preview validates the entire file before an atomic create-only import. Existing SKUs/barcodes are rejected; import never updates current stock. Limit: 2 MB, 1,000 rows and 300 products.
- Required CSV columns: `sku`, `name`, `price`. The supplied template documents the remaining fields. Numbers use a decimal point without currency symbols. `track_stock` accepts `true` or `false`. Repeat the parent SKU and identical product details for each variant, with a distinct `variant_name`. `barcode` belongs to that row's variant when present. Service items do not track stock.
- **Export inventory** downloads the current search results, including variant rows. Formula-like text is escaped for spreadsheet safety. Photo URLs export; local image files are not embedded in CSV.
- Upload JPG, PNG or WebP photos up to 3 MB, or provide an HTTPS image URL. In the PostgreSQL development build, the authenticated API enforces company ownership, inspects file bytes and stores photos privately. Product/variant QR and Code 128 PNG resources use the stored barcode value, falling back to SKU. Give each variant its own code to scan it directly.

## Printer setup

- Receipt preview supports **58 mm** and **80 mm**, browser printing, PDF download and an optional direct ESC/POS connection saved per terminal. Device / Printing can pair a WebUSB printer, a Bluetooth Low Energy printer, or an HTTPS MyFin print connector and sends a test slip before the profile is accepted. MyFin enumerates already-granted USB/BLE devices on setup, automatically selects a sole previously authorized printer, and monitors USB cable connect/disconnect events. A saved direct printer reconnects when the cashier prints; the browser cannot silently grant first-time hardware permission.
- Inventory → **QR / Labels** supports 40×30, 50×30 and 60×40 mm PDF labels, with 1–100 copies, QR or Code 128, three bounded design presets, brand color, optional label copy and price visibility. Pick a variant for its exact selling-price label. Longer codes use QR to avoid squeezing a 1D barcode below a useful scan size. Test one label on the actual printer.
- Browser/platform limits are explicit. Chrome/Edge can expose eligible USB devices through WebUSB. Web Bluetooth reaches BLE/GATT printers, not legacy Bluetooth Classic printer profiles. Browser code cannot scan LAN printers or open raw TCP/9100; Wi-Fi/Ethernet and unsupported Android USB models require the separately installed HTTPS connector/vendor driver. The normal operating-system print dialog remains available as a fail-closed fallback and can use any installed printer.
- Product/stock stickers continue through calibrated PDF/driver media instead of generic direct ESC/POS. This preserves gap, cut and page-size settings controlled by the label printer driver while retaining a scannable QR/barcode on every design.
- `src/domain/receipt.js` exports a versioned `receiptPrintJob()` payload with width, saved sale identity and printable lines. `src/services/printing.js` owns PDF/code rendering so a future adapter can consume the same saved-sale data without rerunning checkout.
- A keyboard-wedge scanner works in Checkout's search field: scan an exact SKU/barcode and press Enter. A parent product code opens its variants; a unique variant code adds that variant. Ambiguous matches require an explicit choice.

## Email receipts and contacts

- Checkout's optional customer email is saved in the immutable sale snapshot and the customer directory in the same database transaction. Existing contact phone/type/name are preserved. Offline sales retain the email in their durable outbox and save the directory entry when synced.
- When the reviewed SMTP integration is enabled, **Send receipt email** creates a tenant-scoped, idempotent queue item from the immutable paid receipt. The receipt shows queued, retry, sent, failed or outcome-unknown status. Safe pre-acceptance failures retry with a bounded 72-hour/eight-attempt budget. An uncertain SMTP outcome never auto-resends; a manager may explicitly send it again after review.
- The dedicated email worker receives only its database password and a send-only SMTP password mounted from protected files. The browser, API responses, PostgreSQL and logs never receive the SMTP credential. A receipt destination is transactional and does not create marketing consent.
- **Open email draft** and **Download receipt PDF** remain available when SMTP delivery is disabled or interrupted. Very long mailto bodies may be truncated by some mail clients; use the PDF attachment in that case.
- Contacts supports creating, editing and searching emails. A receipt can also save a corrected email to Contacts without rewriting a posted sale.

Deployment and egress prerequisites are in `docs/RECEIPT_EMAIL_DELIVERY.md`.

## Validation on 11 September 2026

- 13 domain tests cover checkout arithmetic, CSV parsing/validation, duplicate codes, variant grouping, formula-safe export and receipt/email payloads.
- 11 Firebase emulator tests cover sale idempotency, stock, tenant boundaries, customer email persistence, contact field preservation and image upload rules.
- Browser checks at 834×1112 and 1024×768: editable variant SKUs; photo upload; CSV preview/import; QR/barcode generation; variant scanner lookup; payment with email; saved contact; receipt export.
- Downloaded sticker verified at 50×30 mm; receipt verified at 58 mm. PDF render inspections showed legible, unclipped content. Physical printer and mail-client delivery tests require the user's devices.

Production data was not used for synthetic test sales or test imports.
