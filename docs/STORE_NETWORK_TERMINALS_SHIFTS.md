# Store network, terminals and shifts

## Operating model

MyFin uses an explicit operating hierarchy. Each level has a different job and
must not be inferred from a hostname, IP address or browser fingerprint.

```text
Workspace
└── Company / brand
    └── Store / branch
        └── Location / area
            └── Terminal
                ├── Staff work shift
                ├── Terminal staff session
                └── Register shift and cash entries
```

- A **store** is a physical branch, outlet, kiosk, warehouse or office.
- A **location** is an operating area inside a store, such as Front Counter,
  Kitchen, Stockroom or Office.
- A **terminal** is a MyFin-issued identity assigned to one location. Terminal
  types include POS, kitchen display, customer display, back office and print
  connector.
- Existing storefront `shop_locations` remain customer ordering points. A table
  QR, pickup counter or ordering zone may be linked to an operating store and
  location, but it is not a branch or terminal.

## Device recognition

A browser cannot reliably expose a hardware serial number, MAC address, Wi-Fi
SSID or stable operating-system device ID. IP addresses are also unreliable for
physical location because of NAT, VPNs, mobile networks and Cloudflare ingress.

MyFin therefore recognizes a device through explicit enrollment:

1. A password-authenticated owner or manager creates a terminal and assigns its
   store, location, type and display name.
2. MyFin produces a short-lived, single-use pairing code.
3. The target browser claims the code on the exact company hostname.
4. The server activates a random terminal credential and stores only its
   protected verifier. Clearing browser site data deliberately requires
   re-enrollment.
5. Heartbeats report last-seen time, application release and operating status.
   They describe the last browser report; they do not prove that a machine is
   powered off or physically present.

The terminal credential is a device factor, not a staff account. A personal
six-digit staff code or password is still required. Suspending or retiring a
terminal revokes its terminal sessions without deleting financial history or
queued receipt evidence.

Offline browser storage never supplies a trusted terminal, store or shift ID.
When connectivity returns, the server resolves the HttpOnly terminal credential
and staff session, then stamps the receipt. A receipt captured before a policy
cutover retains bounded capture and session evidence so it can be reviewed
without pretending a later terminal or drawer handled the original payment.

## Staff and register shifts

MyFin keeps attendance, terminal control and cash reconciliation separate:

- A **staff work shift** records clock-in, breaks and clock-out for one person at
  one store.
- A **terminal staff session** records who currently controls a terminal. A
  handover ends one session and starts another without closing the drawer.
- A **register shift** belongs to one POS terminal and business date. It records
  opening float, cash sales, paid-in/out entries, closing count, expected cash,
  variance and the people who operated it.

Register history is append-only. Forced closes and manager approvals append
new events rather than editing old facts. Finalized cash entries cannot be
rewritten; any later correction must be implemented as a separately authorized
compensating event. New POS sales receive
server-derived store, location, terminal and shift identifiers plus readable
snapshots. Existing historical records stay `Legacy / company-wide` rather than
being assigned to a location without evidence.

## Rollout and compatibility

Terminal enforcement is disabled by default for an existing company. This
allows owners to create the store network and enroll every active till before
requiring registered terminals or open shifts.

Existing paid receipt queues remain recoverable. Older schema-v2/v3 receipts do
not suddenly acquire guessed terminal data, and an enforcement cutover never
invalidates an exact retry of a payment captured before the cutover. New live
receipts use the registered terminal and current shift when those policies are
enabled.

Store assignment is the authoritative location. Optional IP or browser details
are short-retention diagnostics only and never grant access. Always-on hardware,
printer and LAN monitoring requires a separately installed Windows/Android
connector or device-management agent; a background browser tab cannot provide
that guarantee.

## Initial operating sequence

1. Create each physical store and its internal locations.
2. Create terminals and pair the target browsers.
3. Assign staff to the company and create personal six-digit POS codes.
4. Test staff login, handover, shift open, paid-in/out and close on each till.
5. Reconcile expected and counted cash and verify receipt attribution.
6. Enable **Require registered terminals**.
7. Enable **Require an open register shift for POS sales** after every till has
   completed the acceptance checks.
