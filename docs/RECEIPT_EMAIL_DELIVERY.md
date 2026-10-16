# Receipt email delivery

MyFin can queue a paid POS or recorded-sale receipt and send it through a dedicated SMTP worker. Delivery is disabled by default. The mailto draft and PDF download remain usable while it is disabled.

## Safety and data contract

- `receipt_email_deliveries` keeps the exact rendered subject/body, recipient, request identity and bounded delivery state. A unique tenant idempotency key makes an interrupted browser retry safe.
- `receipt_email_events` is append-only. It records state and safe error codes, not SMTP responses, credentials or customer message bodies.
- The worker uses a deterministic `Message-ID`. A stale in-flight lease becomes `delivery_unknown` because SMTP may have accepted it before the process lost its database acknowledgement. It is never automatically resent; a manager or workspace owner may create a new audited delivery after review.
- Connection failures known to occur before submission and explicit SMTP 4xx responses retry. Authentication, recipient and permanent message rejection fail immediately. The total budget is eight attempts and 72 hours.
- A receipt address is used for that transactional message only. It does not verify an account, update marketing consent or enroll the recipient in campaigns.

## Required infrastructure review

Do not attach the API or report worker to general outbound networking. Create an external Docker network dedicated to mail submission, then enforce its destination policy in the host/router firewall. Permit the receipt worker only to the reviewed SMTP submission hostname and port, plus the minimum DNS and time services that route requires. Record the network and firewall evidence in the deployment receipt.

The current `temp-mailserver` guest is active Mailcow infrastructure. Mail Control's proven SMTP path pins `mail.bayam.com.my` to `192.168.1.18` and uses STARTTLS on port 587, while ordinary DNS currently resolves that name to the old public address `211.25.114.74`. Configure MyFin's connection address and certificate identity separately so DNS cannot silently select that public endpoint. Reconfirm that `192.168.1.18` is reserved/stable before activation. Do not mount Mailcow volumes, share its administrator credentials, call Mail Control internals or reuse the migration relays by inference.

Create one send-only SMTP identity such as `receipts@finn3.com` with no Mailcow administration privileges and no dependency on a human mailbox password. Verify its sender domain, TLS certificate, SPF, DKIM and DMARC behavior with the mail owner. Store its independent password in a root-managed mode-0600 file outside Git.

Set these in the protected runtime environment only after development canary approval:

```text
RECEIPT_EMAIL_ENABLED=true
MYFIN_SMTP_EGRESS_NETWORK=myfin-smtp-egress
RECEIPT_SMTP_ADDRESS=<reviewed connection IP or hostname; current candidate 192.168.1.18>
RECEIPT_SMTP_PORT=587
RECEIPT_SMTP_USERNAME=<send-only SMTP identity>
RECEIPT_SMTP_TLS_SERVERNAME=<certificate hostname>
RECEIPT_EMAIL_FROM_ADDRESS=<approved From address>
RECEIPT_EMAIL_FROM_NAME='MyFin Receipts'
MYFIN_SMTP_PASSWORD_FILE=/absolute/protected/receipt-smtp.secret
```

`RECEIPT_SMTP_ADDRESS` controls the socket destination. `RECEIPT_SMTP_TLS_SERVERNAME` must be a DNS name and controls certificate validation and SNI; for the current candidate they are `192.168.1.18` and `mail.bayam.com.my` respectively. Ports 587 and 2525 require STARTTLS; port 465 requires implicit TLS. Certificate validation is always enabled. The deployment script refuses to enable email unless `MYFIN_SMTP_EGRESS_NETWORK` is explicit, exists and is different from `nexus-data`. The email worker alone joins that network.

## Activation and acceptance

Apply migration `0042_receipt_email_delivery.sql` and the matching runtime grants, then build the API image containing the worker and Nodemailer. Take the normal quiescent backup before migration. Start development with the reviewed deployment script; it conditionally creates the email worker only when the feature flag is true.

Use a synthetic paid development receipt and a controlled mailbox to verify:

1. one click creates one queue item and repeated submission with the same request does not duplicate it;
2. the UI advances from queued to sent and the received totals/receipt number match the posted sale;
3. SMTP headers pass TLS, SPF, DKIM and DMARC inspection;
4. an invalid controlled recipient becomes failed without exposing a raw server response;
5. stopping the SMTP route before connection produces a bounded retry, while an injected ambiguous outcome becomes `delivery_unknown` and requires manager action;
6. disabling the flag removes the worker and restores the mailto/PDF-only message without deleting delivery history.

Do not send a production test receipt to a real customer. Promote the identical image after the development canary, then use a mailbox controlled by the operator for the production smoke check.
