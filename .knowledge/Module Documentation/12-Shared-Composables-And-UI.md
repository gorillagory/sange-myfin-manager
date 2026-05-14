# Shared Composables And UI

## Purpose

Documents shared helpers used across modules for storage, image processing, QR extraction, PDF creation, SKU generation, and confirmation buttons.

## Source Files

- `src/composables/useStorage.js`
- `src/composables/usePdfGenerator.js`
- `src/composables/useProductLogic.js`
- `src/components/ui/SmartButton.vue`
- `src/style.css`
- `index.html`

## useStorage

Exports:

- `uploadFile(file, path)`
- `removeFile(path)`
- `optimizeImage(file, isLogo = false)`
- `extractQRCode(file)`

Responsibilities:

- Firebase Storage upload/delete.
- Canvas-based image resizing to max 400px.
- QR extraction through `jsqr`.
- QR regeneration through `qrcode`.

## usePdfGenerator

Exports:

- `generatePdf(transaction, elementId, fileName, callback)`

Responsibilities:

- waits for Vue DOM update.
- captures an element by id.
- uses `html2pdf.js` to save A4 PDF.

## useProductLogic

Exports:

- `generateSKU(category)`

Behavior:

- uses first three uppercase category letters.
- appends a random 4-digit number.

## SmartButton

Purpose:

- two-click confirmation for inline actions.

Props:

- `icon`
- `label`
- `confirmLabel`
- `color`
- `confirmColor`

Event:

- `confirmed`

Behavior:

- first click enters confirmation state.
- state resets after 3 seconds.
- second click emits `confirmed`.

## Global UI Dependencies

- `index.html` loads Font Awesome 6.4.0 from CDN.
- Tailwind utilities are used across Vue templates.
- `src/style.css` contains shared transitions, PDF mode, document themes, print styles, and spinner styles.

## Agent Notes

- Prefer these composables over duplicating logic in components.
- `CompanyModal.vue` currently duplicates image and QR logic instead of using `useStorage.js`.
- Do not add another icon library for normal app controls.
