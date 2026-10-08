# GoCo / Gokoo integration assessment

**Status:** foundation only; disabled by design
**Reviewed:** 9 October 2026
**Decision owner:** MyFin product owner

## Finding and identity uncertainty

The requested name, **“GoCo, the Chinese application,” is not yet a confirmed vendor identity**. The strongest match is **Gokoo / 悟空海外**, because its official site describes an overseas Chinese local-services and delivery platform and explicitly lists Kuala Lumpur, Malaysia. Its official partner documentation describes a Malaysia merchant API for authorization, catalog, availability, delivery orders, order status callbacks and order financial details.

This remains an inference. Exact-spelling alternatives do not fit the described use case: official **GoCo** describes a US HR/payroll product, while **GOCpay** describes gaming payments. A contract, vendor contact or application-store link must confirm the intended provider before activation.

Primary sources:

- Gokoo official site and Malaysia presence: <https://www.gokoo.com/la>
- Gokoo channel API guide and Malaysia host: <https://partner-doc.gokoo.com/8532246m0>
- Exact-spelling GoCo official product: <https://www.goco.io/>
- GOCpay official product: <https://corp.goc-pay.com/>

The Integration Center therefore labels Gokoo as **Candidate awaiting confirmation** and blocks activation.

## Feasibility conclusion

Gokoo is technically plausible as a **commerce channel**. The public documentation covers:

- partner AccessToken and merchant `openid` authorization;
- categories, products and stock availability;
- order listing, detail and lifecycle actions;
- order status callbacks; and
- Malaysia-specific provider financial details.

Primary documentation:

- Merchant authorization redirect: <https://partner-doc.gokoo.com/442970501e0>
- Partner access token (documented two-hour lifetime): <https://partner-doc.gokoo.com/442970502e0>
- Merchant OpenID: <https://partner-doc.gokoo.com/442970503e0>
- Product list: <https://partner-doc.gokoo.com/442970515e0>
- Batch stock update: <https://partner-doc.gokoo.com/442970519e0>
- Order list: <https://partner-doc.gokoo.com/442970529e0>
- Order detail and `pay_code` values: <https://partner-doc.gokoo.com/442970530e0>
- Accept order: <https://partner-doc.gokoo.com/442970522e0>
- Order status callback: <https://partner-doc.gokoo.com/446171397e0>
- Malaysia order financial details: <https://partner-doc.gokoo.com/465431942e0>

The public material does **not** establish Gokoo as a general payment gateway for MyFin. It does not document a MyFin-usable payment-intent, authorization, capture, refund and settlement contract. `pay_code` on an order describes a provider-side payment label; it is not independent proof of capture or settlement.

## Architecture boundary

MyFin now defines two independent contracts:

| Contract | Owns | Must not imply |
| --- | --- | --- |
| `CommerceChannel` | merchant binding, catalog, availability, orders, lifecycle and provider finance evidence | payment authorization, capture or cash recognition |
| `PaymentProvider` | authorization, capture, refund, settlement and payment reconciliation | catalog, stock or order-fulfilment control |

A vendor may eventually satisfy both contracts, but it must be reviewed and activated as two explicit capabilities. The Gokoo candidate currently satisfies only documented commerce-channel evidence. Its `paymentGateway` capability is `not_established`.

The current MyFin flow reinforces this separation:

- `src/components/dashboard/EditionPos.vue` requires a cashier to confirm external merchant-device payment.
- `src/domain/pos.js` creates the immutable paid-sale facts after that confirmation.
- `server/src/business.js` supplies checkout idempotency, an advisory lock and atomic stock/transaction writes.
- `src/services/posLocal.js` and `src/store/editionStore.js` retain offline paid receipts for retry.
- `server/src/documents.js` records invoice payments separately.
- `server/src/customer-orders.js` converts an accepted customer order at the counter with exact-once tender handling.
- `server/src/reporting.js` currently applies MyFin accounting policy to POS and document payments.
- `server/src/app.js` protects browser-origin POST requests and is not an external webhook ingress contract.
- `deploy/compose.yml` has no reviewed provider egress configuration.

Provider evidence must therefore remain outside sales, cash, stock and order tables until reconciliation and accounting policies are approved.

## Implemented disabled foundation

Migration `db/migrations/0021_integration_reconciliation.sql` adds:

- mutable, versioned `integration_connections`, scoped by company;
- immutable `integration_events` with provider-event idempotency keys and SHA-256 payload digests;
- immutable `integration_financial_entries` using integer sen, an external-finance idempotency key and `accounting_effect='none'`;
- immutable `integration_reconciliations` with exact expected/observed/difference sen and explicit pending, unavailable, matched and mismatch states; and
- update, delete and truncate guards on all evidence tables.

Every evidence table includes `company_id` in its keys and foreign keys. Cross-company references cannot satisfy the composite constraints. External event, financial and reconciliation keys are unique within a tenant connection.

Connections may store only a reference with an approved URI scheme such as `vault://…` or `file:///run/secrets/…`. Secret values, API keys, tokens and passwords are outside this schema. The owner-only API accepts strict metadata, rejects unknown secret-like properties through a strict request schema, rejects `active`, and uses optimistic `version` checks. The UI does not collect credential references.

The pure Gokoo mapper:

- requires an explicit `MYR` context rather than inferring currency from a symbol;
- accepts decimal strings and converts them to exact integer sen without floating-point arithmetic;
- maps documented `fields` keys from the Malaysia financial response;
- omits customer contact, mobile and address data from normalized order metadata;
- records payment codes as labels with `paymentProviderEvidence=false` and `accountingEffect='none'`; and
- preserves `platform_commission_ratio` as ambiguous raw evidence instead of money. The field name says “ratio,” while the Malaysia page labels and examples show a monetary amount. Sandbox evidence and a vendor-approved contract must resolve that conflict.

The current implementation performs **no outbound calls, OAuth redirects, public webhook handling, credential capture, cash recognition, sales posting, order mutation, catalog write or stock mutation**.

## Security, idempotency and reconciliation model

When a later phase passes the gates below, the ingestion sequence should be:

1. Terminate provider traffic at a dedicated integration ingress, separate from browser-origin APIs.
2. Authenticate the provider before parsing business content. Verify signature, timestamp skew, nonce/replay rules and the exact raw bytes specified by the vendor.
3. Hash the retained/sanitized payload and insert one immutable event by `(company, connection, provider_event_key)`.
4. Normalize only allowlisted metadata and integer-sen facts. Do not retain customer PII unless a documented purpose, retention rule and access policy exist.
5. Fetch or receive authoritative provider financial facts through an independently idempotent key.
6. Compare provider facts with MyFin facts in an immutable reconciliation row. `matched` requires a zero difference; `mismatch` requires a non-zero difference; pending and unavailable rows contain no comparison amounts.
7. Let a separate reviewed accounting policy post a sale, refund or cash movement. An integration event can never directly become cash.

The public callback page lists `time`, `nonce_str`, `sign` and sorted callback data, but its published signature section does not provide a complete secret/hash/encoding algorithm or test vectors. No webhook can be exposed until Gokoo supplies an authoritative, testable signing contract.

## Readiness gates

All gates are mandatory. “Active” remains unavailable until each gate has evidence and an owner-approved change:

1. **Identity:** written confirmation that the intended application is Gokoo / 悟空海外, including legal entity and Malaysia product.
2. **Commercial access:** executed partner terms, support contact, service levels, rate limits, outage behavior and data-processing roles.
3. **Credentials:** approved secret store, rotation/revocation procedure and production/sandbox separation. MyFin stores references only.
4. **API contract:** versioned endpoint/field contract, Malaysia host confirmation, error semantics, pagination and retry limits.
5. **Webhook security:** complete signature algorithm, canonicalization, encoding, replay window, nonce rules, key rotation and vendor test vectors.
6. **Sandbox:** merchant authorization, token expiry/refresh, duplicate callbacks, out-of-order status changes, cancellation, refund and retry tests.
7. **Money contract:** explicit `MYR`, decimal scale, rounding rules, refund signs and authoritative resolution of `platform_commission_ratio` and the inconsistent Malaysia examples.
8. **Reconciliation:** settlement identifiers, settlement timing, fee/tax basis, mismatch ownership and daily close procedure.
9. **Accounting:** approved rules for sale, receivable, fee, tax, refund and cash recognition. Existing reports must not infer cash from provider labels.
10. **Data protection:** field-level purpose, consent/legal basis, retention/deletion, customer access and incident process for any PII.
11. **Infrastructure:** allowlisted outbound egress, DNS/TLS, isolated webhook ingress, request size/rate limits, monitoring and redacted logs.
12. **Operations:** alerting, runbooks, backfill/replay process, kill switch, support escalation and audit ownership.
13. **Recovery:** database backup/restore test, event replay test, credential revocation and rollback to disabled without data loss.
14. **Acceptance:** reviewed end-to-end sandbox receipts proving no duplicate order, stock, payment or accounting mutation.
15. **Regulatory/acquirer review:** confirm that the chosen payment provider/acquirer and merchant flow meet Bank Negara Malaysia requirements. See BNM’s Merchant Acquiring Services policy: <https://www.bnm.gov.my/-/pd-merchant-acquiring-services>.
16. **Card-data boundary, if cards are introduced:** use provider-hosted collection and validate the applicable PCI scope. PCI SSC’s SAQ A eligibility clarification is at <https://www.pcisecuritystandards.org/faqs/1588/>.

## Lowest-risk next slice

After vendor identity confirmation, implement a sandbox-only read path for one test merchant: merchant binding, read-only order detail, read-only Malaysia financial detail, sanitized immutable evidence and a reconciliation preview. Keep order actions, catalog/stock writes, webhook ingress and all accounting effects disabled. This slice proves authentication, field semantics, exact money handling and reconciliation without changing customer orders or MyFin books.
