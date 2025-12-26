# MyFin Manager (Lite)

A lightweight, single-file(ish) financial management tool built for Malaysian SMEs. It handles Multi-Company management, Income/Expense tracking, and SOP workflows (Quote -> Invoice -> PO) without requiring a backend or build tools.

**Tech Stack:** Vue.js 3, Tailwind CSS, LocalStorage, Chart.js, HTML2PDF.

## Features
- **Multi-Company:** Manage distinct financial data for multiple entities.
- **SOP Workflow:** Convert Quotes to Invoices & Purchase Orders with one click.
- **Visuals:** Dashboard with Income/Expense charts and KPI cards.
- **PDF Generation:** Generate standardized PDFs for Invoices, POs, and Vouchers.
- **Audit Trail:** Tracks status changes (e.g., Pending -> Paid) with timestamps.
- **Local Data:** All data persists in the browser's LocalStorage (No server required).

## Setup
1. Clone the repo.
2. Open `index.html` in any modern browser (Chrome/Edge recommended).
3. No `npm install` or server required.

## File Structure
- `index.html`: Main UI and templates.
- `js/1-store.js`: Central state management (Vue Reactive) & LocalStorage logic.
- `js/2-company.js`: Company creation and CRUD logic.
- `js/3-dashboard.js`: Core finance logic, chart rendering, and PDF generation.
- `js/4-app.js`: Vue app mounting point.

## License
Private / Personal Use.