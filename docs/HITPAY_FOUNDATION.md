# HitPay hosted-checkout foundation

The gateway is disabled unless the API starts with both
`PAYMENT_GATEWAY_ENABLED=true` and an operator-mounted credential file. A
missing, unreadable or malformed file does not affect `/api/health/ready`;
payment creation returns the generic `online_payment_unavailable` error.

## Credential file

Create a dedicated, non-login host group (the example uses numeric GID `19000`)
and a `root:<dedicated-group>` mode-`0440` JSON file outside the repository.
Set `MYFIN_PAYMENT_GATEWAY_SECRET_GID` to that numeric GID. The API image still
runs as `USER node`; Compose grants only that supplementary group, so the file
does not need to be world-readable and the API never runs as root. PostgreSQL
stores only the opaque `secretRef` key. API keys and webhook salts must not be
placed in SQL, Compose environment variables, logs or browser storage.

```sh
sudo groupadd --system --gid 19000 myfin-payment-secrets
sudo install -o root -g myfin-payment-secrets -m 0440 \
  /secure/payment-gateway-credentials.json \
  /srv/myfin/secrets/payment-gateway-credentials.json
```

```json
{
  "secretref://myfin/company-id/hitpay": {
    "apiKey": "sandbox-or-production-api-key",
    "webhookSalt": "matching-environment-webhook-salt"
  }
}
```

The parser accepts only the two fields shown above. Keep old referenced entries
while their payment intents may still receive webhooks; each immutable intent
stores the opaque reference and sandbox/production environment used at creation.

## Company metadata contract

Workspace owners configure non-secret metadata through these authenticated,
company-scoped routes:

- `GET /api/companies/:company/payment-gateway`
- `PUT /api/companies/:company/payment-gateway`

The update body is:

```json
{
  "expectedVersion": 0,
  "status": "disabled",
  "providerEnvironment": "sandbox",
  "accountHint": "HitPay sandbox",
  "secretRef": "secretref://myfin/company-id/hitpay"
}
```

Use `expectedVersion: 0` to create the record, then use the returned version for
each update. Activation validates that the referenced credential exists. The GET
response reports `credentialAvailable` and each registered storefront's webhook
URL without returning secret values.

## Sandbox activation

1. Keep the connection `disabled` and `sandbox` while preparing credentials.
2. Register every returned webhook URL in the matching HitPay dashboard and
   subscribe it to `payment_request.completed`. HitPay registers webhooks in its
   dashboard; the deprecated payment-request `webhook` parameter is not sent.
3. Render the merged Compose model for review:

   ```sh
   docker compose --env-file /secure/myfin.env \
     -f deploy/compose.yml -f deploy/payment-gateway.override.yml config
   ```

   Before activation, verify the effective non-root container can read the
   mounted file without printing it:

   ```sh
   docker compose --env-file /secure/myfin.env \
     -f deploy/compose.yml -f deploy/payment-gateway.override.yml \
     run --rm --no-deps api node -e \
     "require('node:fs').accessSync(process.env.PAYMENT_GATEWAY_SECRET_FILE,require('node:fs').constants.R_OK)"
   ```

4. Restrict the host's container egress path to DNS plus TCP 443 for
   `api.sandbox.hit-pay.com` during acceptance. Production later needs
   `api.hit-pay.com`. Docker's bridge itself is not a hostname firewall; enforce
   this with the host firewall or an allowlisting HTTPS proxy before starting the
   override.
5. Start with the same two Compose files, set the company connection `active`,
   then perform a low-value sandbox checkout and verify the immutable webhook
   evidence in the staff order view.

The redirect URL never confirms payment. Only a raw-body HMAC-verified HitPay
webhook can produce `confirmed_unposted` evidence. This state remains separate
from the POS receipt and accounting transaction until a manager or workspace
owner finalizes it.

Payment-request creation sets HitPay's `expires_after` to 10 minutes. Before the
outbound call, MyFin writes an immutable intent and extends the accepted order,
sellable-product reservations, recipe reservations and promotion reservations
atomically to at least a 15-minute hold. Cancellation, scheduled/request-time
expiry and counter tender take the same order/payment lock and cannot release or
collect the order while the derived state is `creating`, `pending`,
`reconciliation_required`, `confirmed_unposted` or `finalized`.

A definite provider rejection (a non-transient 4xx response) is recorded as
`failed` and may be retried with a new idempotency key. A timeout, connection
loss, 5xx/429 response or malformed successful response is not evidence that
HitPay failed to create a payable request. It is recorded as
`checkout_creation_unknown`, exposed as `reconciliation_required`, keeps the
original idempotency key and blocks every new payment attempt. A later exact,
signed completion webhook safely moves that intent to `confirmed_unposted`.

### Abandoned and unknown checkout reconciliation

Managers and workspace owners can run a provider-backed reconciliation from the
staff order view through:

- `POST /api/companies/:company/customer-orders/:id/online-payment/reconcile`

The request body is an empty JSON object. For a known HitPay request ID, MyFin
calls the official single-request status endpoint. If creation had an ambiguous
outcome and no request ID was received, MyFin searches using the immutable,
random `provider_reference` and accepts only one exact reference match whose ID,
amount, currency, checkout origin and repeated-payment setting all validate.
Partial matches, duplicate exact matches, malformed responses, 404 responses,
network errors and unsupported list-response shapes leave the checkout locked.

Each accepted observation is sanitized and appended as immutable evidence; raw
provider responses and customer contact data are not stored. The provider
statuses have these effects:

- `pending` stays locked and payable only at HitPay.
- `failed`, `expired`, `canceled` and `inactive` prove the request is no longer
  payable, derive the intent as `failed`, and allow a new tender or checkout.
- `completed` stays `reconciliation_required`. An API-key lookup deliberately
  does not manufacture payment evidence. The exact raw-body, HMAC-verified
  completion webhook must still identify the succeeded payment before a manager
  or workspace owner can finalize it into the sale ledger.

The reconciliation call runs the provider request outside a database
transaction, then re-authorizes the staff member, takes the shared order/payment
lock, re-checks the immutable intent, and binds a recovered provider request ID
under a provider-request advisory lock. A local timer, an expired MyFin hold, a
missing webhook or a search miss is never proof of non-payment.

The existing report worker performs the same provider-backed checks when the
payment-gateway Compose override is enabled. It creates a PII-free job for each
unresolved intent, waits two minutes before the first lookup, then persists 2,
5, 10, 15, 30 and 60 minute retry delays. Each cycle claims at most five jobs
with a three-minute crash-recovery lease. The hard budget is 24 attempts or 24
hours from intent creation.

Accepted statuses, safe lookup failures and escalations are immutable payment
events. The mutable job row contains only attempt/lease timing, safe outcome
codes and resolution/escalation timestamps. Exact `failed`, `expired`,
`canceled` or `inactive` results expire the unpaid order and release product,
recipe and promotion reservations atomically. `pending` retries. `completed`
escalates immediately and stays locked until the signed webhook arrives.
Unavailable, missing or otherwise unknown outcomes retry to the budget and then
enter the durable `operator_escalation` state without releasing anything;
invalid or mismatched evidence escalates immediately. Worker cycles expose an
`openEscalations` count and emit a redacted escalation metric, while staff order
details show the lifecycle, attempt count and safe reason beside the immutable
event history.

The implementation follows HitPay's documented
`GET /v1/payment-requests/{request_id}` status contract and its documented list
search by `reference_number`:
https://docs.hitpayapp.com/apis/payment-request/get-payment-status and
https://docs.hitpayapp.com/apis/payment-request/get-payment-requests.

## Staff evidence and finalization

Staff can inspect immutable evidence with:

- `GET /api/companies/:company/customer-orders/:id/online-payment`
- `POST /api/companies/:company/customer-orders/:id/online-payment/reconcile`
- `POST /api/companies/:company/customer-orders/:id/online-payment/finalize`

The finalization body contains only optimistic concurrency and idempotency data:

```json
{
  "requestId": "uuid-generated-once-by-the-client",
  "expectedVersion": 2
}
```

Only a manager or workspace owner can finalize. The API takes the amount, method,
line items, pricing snapshot, customer link and confirmation time from the locked
order and verified webhook evidence. In one database transaction it posts the
ordinary POS sale, marks the customer order paid, releases stock reservations,
consumes promotion reservations, awards loyalty, and writes the immutable
intent-to-sale link. Exact retries return the same sale. The derived payment state
then becomes `finalized`.

Counter tender is blocked while an online checkout is `creating`, `pending` or
`reconciliation_required`, as well as after confirmation. This prevents a
cashier and a hosted checkout from collecting the same accepted order
concurrently. A provider-confirmed terminal unpaid checkout is derived as
`failed` and remains tenderable. Keep production collection disabled until the
staff reconciliation/finalization UI and the complete flow pass sandbox
acceptance for payment creation, ambiguous response loss, exact-reference
discovery, pending and each terminal status, webhook confirmation,
finalization, idempotent retry, abandonment and counter double-tender.
