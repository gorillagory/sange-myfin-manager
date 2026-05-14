# Templates And PDF

## Purpose

Controls document appearance, invoice/quote templates, PDF-specific rendering, print behavior, and template preferences.

## Source Files

- `src/components/dashboard/TemplateStudio.vue`
- `src/components/dashboard/docdesign/TemplateClean.vue`
- `src/components/dashboard/docdesign/TemplateCorporate.vue`
- `src/components/dashboard/docdesign/TemplateModern.vue`
- `src/components/dashboard/finance/sales-parts/SalesEditor.vue`
- `src/composables/usePdfGenerator.js`
- `src/style.css`

## Template Preferences

Stored inside company preferences through `Store.saveCompanyStyle()` / `Store.updatePreferences()`.

Common fields:

- `baseTheme`
- `primaryColor`
- `fontFamily`
- `labels.invoice`
- `labels.quote`
- `labels.billTo`
- `labels.total`
- `showLogo`
- `defaultNotes`
- `currency`

## Template Studio

- Lets admins preview clean, corporate, and modern document structures.
- Saves selected style into company preferences.
- Uses CSS custom property-like preview styling for color/font.

## Sales Editor Integration

- `SalesEditor.vue` chooses the active template by `companyPrefs.baseTheme`.
- It renders into `#invoice-print-area`.
- It passes:
  - `txForm`
  - `activeCompany`
  - `companyPrefs`
  - `clients`
  - `products`
  - `isGeneratingPdf`
  - live calculations

## PDF Generation

- `usePdfGenerator().generatePdf(transaction, elementId, fileName, callback)` waits for `nextTick()`, then a timeout.
- It captures the DOM with `html2pdf.js`.
- PDF options use A4 portrait, jpeg quality, and html2canvas scale 2.

## CSS Contract

Global CSS in `src/style.css` includes:

- `.doc-clean`
- `.doc-corporate`
- `.doc-modern`
- `.pdf-mode`
- `.no-print`
- print media overrides
- page-break protection

## Agent Notes

- Do not move or rename `#invoice-print-area` without updating PDF generation.
- Template components mutate document form values through `v-model` on props. This is the current pattern.
- `TemplateClean.vue` emits `saveDefaultNotes`; corporate and modern do not currently expose the same default-notes save action.
- PDF layout depends heavily on table widths, `.pdf-mode`, and print CSS. Test document rendering after template changes.
