# Inventory, receipts and printer setup

## Inventory

- Inventory uses the Edition light palette independently of the device's dark-mode preference.
- Product and contact editors use native modal dialogs, keyboard focus containment, 48 px inputs and persistent header/footer actions. Variant names, SKUs, barcodes, prices, costs and stock are editable in place.
- Download **SKU template**, replace its example rows, then choose **Upload CSV**. The preview validates the entire file before an atomic create-only import. Existing SKUs/barcodes are rejected; import never updates current stock. Limit: 2 MB, 1,000 rows and 300 products.
- Required CSV columns: `sku`, `name`, `price`. The supplied template documents the remaining fields. Numbers use a decimal point without currency symbols. `track_stock` accepts `true` or `false`. Repeat the parent SKU and identical product details for each variant, with a distinct `variant_name`. `barcode` belongs to that row's variant when present. Service items do not track stock.
- **Export inventory** downloads the current search results, including variant rows. Formula-like text is escaped for spreadsheet safety. Photo URLs export; local image files are not embedded in CSV.
- Upload JPG, PNG or WebP photos up to 3 MB, or provide an HTTPS image URL. In the PostgreSQL development build, the authenticated API enforces company ownership, inspects file bytes and stores photos privately. Product/variant QR and Code 128 PNG resources use the stored barcode value, falling back to SKU. Give each variant its own code to scan it directly.

## Printer setup

- Receipt preview supports **58 mm** and **80 mm**, browser printing, and PDF download. Set matching paper size in the installed printer driver and disable browser headers/footers. Print at 100% / actual size.
- Inventory → **QR / Labels** supports 40×30, 50×30 and 60×40 mm PDF labels, with 1–100 copies. Pick a variant for a variant price label. Longer codes use QR to avoid squeezing a 1D barcode below a useful scan size. Test one label on the actual printer.
- The browser's installed printer/driver handles USB, Bluetooth or network printing. Silent printing, ESC/POS commands, cutters, drawer opening and hardware discovery require a printer-specific adapter; these are not claimed as connected.
- `src/domain/receipt.js` exports a versioned `receiptPrintJob()` payload with width, saved sale identity and printable lines. `src/services/printing.js` owns PDF/code rendering so a future adapter can consume the same saved-sale data without rerunning checkout.
- A keyboard-wedge scanner works in Checkout's search field: scan an exact SKU/barcode and press Enter. A parent product code opens its variants; a unique variant code adds that variant. Ambiguous matches require an explicit choice.

## Email receipts and contacts

- Checkout's optional customer email is saved in the immutable sale snapshot and the customer directory in the same database transaction. Existing contact phone/type/name are preserved. Offline sales retain the email in their durable outbox and save the directory entry when synced.
- The receipt's **Open email draft** link opens the configured mail app with the recipient, receipt number and complete text. The cashier reviews and sends it. It does not indicate delivered/sent status.
- Download the receipt PDF to attach manually. Very long mailto bodies may be truncated by some mail clients; use the PDF attachment in that case.
- Contacts supports creating, editing and searching emails. A receipt can also save a corrected email to Contacts without rewriting a posted sale.

## Validation on 11 September 2026

- 13 domain tests cover checkout arithmetic, CSV parsing/validation, duplicate codes, variant grouping, formula-safe export and receipt/email payloads.
- 11 Firebase emulator tests cover sale idempotency, stock, tenant boundaries, customer email persistence, contact field preservation and image upload rules.
- Browser checks at 834×1112 and 1024×768: editable variant SKUs; photo upload; CSV preview/import; QR/barcode generation; variant scanner lookup; payment with email; saved contact; receipt export.
- Downloaded sticker verified at 50×30 mm; receipt verified at 58 mm. PDF render inspections showed legible, unclipped content. Physical printer and mail-client delivery tests require the user's devices.

Production data was not used for synthetic test sales or test imports.
