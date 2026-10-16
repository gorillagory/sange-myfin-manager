# MyFin Sales & Marketing platform

**Status:** implementation candidate; deployment receipts are recorded only after
the exact build passes the gates below.

## Product boundary

The former **Student Programs** area becomes the **Sales & Marketing** workspace.
Student verification remains available as one optional audience attribute. It is
not the organizing model for campaigns, offers, loyalty, or analytics.

The workspace provides:

- campaigns with draft, scheduled, active, paused, completed, and archived
  lifecycle states;
- audiences scoped to the current company or its workspace, with student status
  available as one filter;
- percentage, fixed-value, free-item, voucher, and bonus-points offers;
- workspace loyalty configuration, member balances, controlled adjustments, and
  immutable earning, redemption, reversal, and expiry history;
- attributed revenue, orders, customers, redemptions, discount cost, and bonus
  points awarded, with the existing small-cohort privacy threshold retained;
- immutable campaign and offer versions so historic orders continue to explain
  the rule that priced them.

Campaign analytics describe recorded attribution. They do not claim causal lift
or return on investment without an experiment or an externally supplied cost.

## Roles

| Capability | SuperAdmin | Workspace owner | Manager | Operator |
| --- | --- | --- | --- | --- |
| View marketing workspace and analytics | All workspaces | All workspace companies | Assigned companies | No |
| Create and edit company campaigns, offers, audiences | Yes | Yes | Assigned companies | No |
| Publish, pause, or archive a company campaign | Yes | Yes | Assigned companies | No |
| Configure shared workspace loyalty economics | Yes | Yes | No | No |
| Review loyalty members and company activity | Yes | Yes | Assigned companies | No |
| Make a reasoned loyalty adjustment | Yes | Yes | Assigned companies | No |
| Review student eligibility | Yes | Yes | No | No |
| See storefront-order offer evidence while tendering at the counter | Yes | Yes | Yes | Yes |

The server is the authorization boundary. Navigation and disabled controls are
only user-interface guidance.

## Integrity rules

1. Campaigns, audiences, and offers are company-scoped and checked against the
   authenticated workspace and company on every request.
2. Published versions are immutable. Edits create a new version; historic
   attribution always points to the exact version used.
3. Free-item rewards identify a real sellable product and variant and cannot
   bypass stock, recipe, order reservation, or completion checks.
4. Points use integers. Every earn, bonus, redemption, adjustment, reversal, and
   expiry is an immutable ledger event with an idempotency key and resulting
   balance. Replaying a source cannot award or deduct points twice.
5. Promotion reservations and redemption counters remain authoritative during
   concurrent online ordering. A campaign link does not weaken the existing
   limits.
6. Customer consent remains workspace-specific. This release records campaign
   configuration and attribution; it does not send email, SMS, or WhatsApp.
7. Reports suppress small customer cohorts using the existing threshold of five.
8. Compatibility routes for `/student-programs` and the existing offer APIs stay
   available during the transition.

## Live channel boundary

The online storefront and staff POS are live campaign execution channels in this
release. A campaign runs only on the channels explicitly selected in its
published version. New POS carts receive an authoritative server quote; eligible
percentage, fixed-value, voucher, and free-item rules appear before tender with
their original price, savings, and final price. Online and POS orders share the
same reservation ledger, so campaign and voucher capacity cannot be spent once
through each channel. Email, SMS, WhatsApp, QR, social, and other in-store
selections remain planning or attribution metadata until their own reviewed
execution adapters exist.

The staff POS can also tender an accepted storefront order with its immutable
offer evidence. Direct POS rewards use normal stock and recipe validation and
the server inserts automatic free-item lines into the immutable pricing
snapshot; the cashier cannot add, remove, or edit those reward lines after the
quote.

Bonus points apply to each eligible paid storefront order. Total and per-customer
bonus caps are not represented yet, so the campaign builder neither accepts nor
claims those controls for bonus-only campaigns. Loyalty redemption creates
auditable point-ledger activity; it is not yet a POS discount, tender, or payment
instrument.

## Release gates

- all migrations apply once on PostgreSQL 16 and a second migration run is a
  no-op;
- the restricted runtime role has only the grants required by the new APIs;
- campaign lifecycle and version-conflict tests pass;
- offer pricing, voucher limits, free-item stock integrity, points idempotency,
  redemption, and reversal tests pass;
- the full server, frontend, offline, management, build, and database acceptance
  suites pass at the exact candidate commit;
- development is backed up and restored in isolation before migration;
- authenticated browser acceptance covers campaign creation, publishing,
  analytics, loyalty adjustment, and compatibility routing;
- production is backed up off-host, restored in isolation, deployed from the
  accepted immutable images, and reconciled against pre-deployment business and
  financial counts.
