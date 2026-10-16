# MyFin customer commerce release

**Status:** release candidate. The deployment receipt is recorded only after the
exact source, database migrations, browser acceptance, and production
reconciliation pass.

## What this release adds

- A first-class **Workspace → Online Storefront** module for managers and
  workspace owners.
- A bounded, brandable customer storefront with logo, colors, typeface, hero,
  promotional carousel, pickup and optional delivery.
- A reusable shop QR, one-time location QR codes, printable QR sheets, a
  16:9 downloadable banner, and a full-screen `/display` page for a shop screen.
- Guest ordering and an optional global **Finn3 ID**. The same ID/password
  works at participating Finn3 shops; each shop keeps a host-only session and
  therefore asks the customer to sign in on that host. The checkout name and phone,
  consent, loyalty, and order history remain isolated by workspace.
- Exact online-price overrides per product and variant. The public menu labels
  online and store prices whenever they differ and shows the original amount
  with a strike-through when the online price is lower.
- Authoritative POS campaign pricing. Eligible published POS campaigns apply
  during the server price quote; a cashier cannot alter an automatic reward
  line. The order summary shows each offer and the total savings before tender.
- HitPay hosted-checkout infrastructure, immutable payment evidence,
  provider-backed abandoned/ambiguous checkout reconciliation, and manager/owner
  finalization. Collection remains disabled until the sandbox acceptance
  described below is complete.
- Bounded automatic HitPay reconciliation in the report worker, with persisted
  cadence and attempt/age budgets, immutable observations, terminal-unpaid
  reservation release, and a durable operator-escalation queue and metric.
  Completed and unknown outcomes stay fail-closed; only a signed webhook
  confirms payment.

Google and Apple identity are not represented as active. They require each
provider's production verification, client credentials, redirect configuration,
and acceptance testing. The available Finn3 ID is the truthful cross-store
login in this release; guest ordering remains available.

## Publishing a customer shop

1. Open **Workspace → Online Storefront**.
2. Save a dedicated `order-…` hostname, shop identity, privacy details, theme,
   hero, and carousel slides.
3. Create at least one active pickup-capable location (`pickup` or `both`).
   Download or print its QR before closing the reveal dialog; rotating a
   location token invalidates its older QR.
4. Publish the intended products and variants. Leave an online price blank to
   inherit the current store price, or enter an exact two-decimal override.
5. Enable delivery only after creating an enabled delivery zone.
6. Select **Publish online ordering**, save, then accept the public `/shop` and
   `/display` pages in a separate browser session.

The general shop QR is reusable. A location QR contains a rotatable capability
that selects an at-premise table or pickup location and therefore must be saved
when it is revealed. The full-screen display refreshes published content,
rotates promotional slides unless paused, and exposes print and PNG banner
actions. PNG export stops with a clear warning when an external image host
blocks safe canvas reuse; print remains available.

## Launching a POS promotion

1. Open **Analytics → Marketing → Campaigns** and create a campaign.
2. Set the active dates, audience, limits, and **Checkout / POS** channel.
3. Choose a percentage, fixed-value, free-item, or voucher offer. A free item
   must identify the exact inventory product and variant.
4. Publish the campaign. Published rules are versioned; changing one creates a
   new rule version rather than rewriting historic receipts.
5. At POS, add the qualifying products and customer when the rule requires one.
   Automatic campaigns and eligible free items appear after the server quote.
   Enter bearer voucher codes in the POS voucher field.
6. Review the original subtotal, named offers, savings, tax, rounding, and final
   total before opening tender. If the quote expires, refresh it before taking
   payment.

Every new walk-in tender requires an authoritative price hold, even when no
campaign ultimately applies. A still-valid hold is bound to the exact shop,
cashier, cart, customer, voucher, discretionary discount, and checkout ID and
is saved with the device draft. A short connection loss can therefore finish
that exact held tender; a changed cart, missing hold, cached-only session, or
expired hold must reconnect before staff collect money. Already-paid legacy
offline receipts continue through the durable replay and manager-review path.

POS and online orders share campaign and voucher capacity. A concurrent order
cannot exceed a total, per-customer, or voucher limit by pricing through a
different channel. Reward products use the ordinary stock, recipe, reservation,
and sale-posting controls.

Limited online campaigns also have an anonymous-hold guard. A durable guest
session, registered customer, or normalized guest email/phone can hold at most
one unpaid order for the same scarce campaign at a time. Anonymous capacity is
further bounded independently for each limited campaign and voucher to one
quarter of its published capacity, with a minimum of one and a maximum of ten
simultaneous holds. This common budget remains effective when source IPs,
cookies, or contact details are rotated, while session and contact keys stop the
ordinary retry variants.

Before staff acceptance, an anonymous order using scarce campaign or voucher
capacity expires after at most five minutes. Acceptance extends a still-live
reservation through the normal preparation window; an expired hold cannot be
revived. Replaying the original idempotency key returns the original order before
the guard runs, so a lost response does not consume a second slot. Denials use
the same generic `promotion_unavailable` response and emit a structured warning
containing only the reason class, authentication state, voucher presence, and
rule count. Guest tokens, contacts, customer IDs, campaign IDs, and voucher IDs
are absent from that signal.

## Customer accounts and marketing

Creating a Finn3 ID records a global login handle. An unverified email is contact
data and cannot reserve or take ownership of a global identity; existing accounts
retain their email-shaped Finn3 ID for sign-in compatibility. Each workspace owns
its own checkout name and phone, loyalty balance, marketing choices, and order history.
Consent is recorded independently for email, SMS, and WhatsApp. A grant is
rejected until the exact email or workspace phone is verified, and changing a
phone invalidates the previous verification and grant. Withdrawal never depends
on verification. This release has no email or phone challenge service, so new
accounts remain safely opted out. Outbound messaging also requires a separately
reviewed provider integration.

Customer sessions are host-only `__Host-` cookies and server-bound to the exact
storefront hostname. The retired parent-domain
bearer is ignored and cleared on the next authentication action. Seamless
session transfer will require `id.finn3.com` to issue a single-use, short-lived,
destination-bound exchange code into each storefront's host-only session; that
identity host, DNS route and browser acceptance are not part of this release.

Campaign analytics report attributed orders, revenue, customers, discounts,
redemptions, and loyalty events. They do not claim causal lift or return on
investment without an experiment and campaign-cost input.

## Online payment rollout

HitPay is the first hosted provider because it covers Malaysian cards, DuitNow,
FPX, and major wallets without putting payment credentials inside MyFin. The
runtime and every company connection remain disabled for this deployment.

Activation requires all of the following:

1. Install the company credentials in the root-owned server secret file and
   store only its opaque `secretref://…` name in MyFin.
2. Verify the manager/owner **Reconcile with HitPay** action against known
   requests and creation-unknown exact-reference discovery. Only HitPay's
   `failed`, `expired`, `canceled` or `inactive` status may unlock another
   tender; a timer, search miss or missing webhook never does.
3. Complete HitPay sandbox acceptance for success, rejection, customer
   abandonment, lost create response, delayed webhook, exact retry, every
   terminal state, manager finalization, and attempted counter double-tender.
4. Start the reviewed Compose gateway override and enable the company connection
   in **Settings → Integrations**.

The public storefront hostname cannot change while any hosted payment is still
pending or requires reconciliation. Checkout creation share-locks the active
hostname, so a concurrent settings save cannot publish a webhook URL and disable
it in the same race. Finish or reconcile every intent before rotating the host.

The browser redirect never confirms payment. Only the exact raw-body,
HMAC-verified provider webhook can create confirmed evidence, and a manager or
workspace owner posts that evidence once into the normal sale and accounting
ledgers. See `docs/HITPAY_FOUNDATION.md` for the secret, webhook, and runtime
contract.

## Pricing evidence retention

The report worker reclaims at most 500 storefront price previews per cycle only
after they have been expired for a full day and remain unbound. Orders, sales,
receipt reviews, promotion reservations and redemptions, and manager recovery
evidence all block deletion. Receipt reviews expose their immutable JSON price
reference through a generated foreign key, so review creation and cleanup are
serialized by PostgreSQL rather than relying on a timing-sensitive JSON check.

POS price snapshots are retained indefinitely in this release. A till can lose
connectivity after receiving a valid price hold and before its first paid-receipt
request reaches the server, leaving the only receipt in the device outbox and no
server transaction row that cleanup could recognize. Reclaiming POS snapshots
becomes safe only after a future tender-start protocol creates a durable server
binder with explicit cancelled or settled states. Storage cleanup must not make
a paid interrupted receipt impossible to recover.

## Release and rollback

The database migrations are forward-only. Before each environment, create a
fresh database/configuration/uploads backup, copy its checksums off-host, and
complete an isolated restore rehearsal. Apply migrations and least-privilege
grants, build the API and web images sequentially, and deploy development first.
Production receives the exact accepted commit and image IDs.

Application rollback points the release symlink and application containers back
to the prior immutable receipt. Because migrations are additive, do not run a
down migration. Keep the new tables and disable storefront publication,
campaigns, and gateway connections if business rollback is required.
