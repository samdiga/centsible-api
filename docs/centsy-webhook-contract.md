# Centsy Plaid webhook ingress contract

`centsy` is the public Plaid ingress. `centsible-api` owns the database
schema, all migrations, the durable-event worker, and every financial domain
write. Centsy has no permission to read or mutate domain tables.

## Accepted delivery and persisted row

Centsy accepts only `application/json` Plaid webhook deliveries. It reads the
raw request body once and rejects either a declared or measured body larger
than 262,144 bytes (256 KiB). Before inserting, it verifies the
`Plaid-Verification` JWT, checks the raw-body digest, and parses the JSON.
Invalid JWTs or digests, malformed JSON, unsupported content types, and
oversized bodies are not persisted. A database failure returns `503` so Plaid
can retry; Centsy acknowledges with `200` only after the insert completes.

Verified JWT signing keys are cached for 24 hours. Verification rejects tokens
older than five minutes. These are ingress controls owned by Centsy; API
workers trust only rows that Centsy has durably written.

Centsy pre-generates the UUID and performs one insert without `RETURNING`.
The exact row shape is:

| Column             | Centsy value                                |
| ------------------ | ------------------------------------------- |
| `id`               | Pre-generated UUID                          |
| `provider`         | `plaid`                                     |
| `webhook_type`     | Verified Plaid `webhook_type`               |
| `webhook_code`     | Verified Plaid `webhook_code`               |
| `provider_item_id` | Verified `item_id`, or NULL when absent     |
| `payload`          | Parsed verified JSON object                 |
| `payload_digest`   | 64-character digest of the raw request body |
| `dedupe_key`       | 64-character delivery key derived by Centsy |
| `status`           | `pending`                                   |
| `attempts`         | `0`                                         |
| `available_at`     | Centsy's insertion time                     |

All other inbound-event columns are API-worker-owned defaults or lifecycle
fields: `lease_expires_at`, `locked_by`, `last_error_code`, `received_at`, and
`processed_at`. Centsy permits duplicate delivery rows. The API worker is the
only consumer and prevents duplicate active work using the event dedupe key and
pipeline-job deduplication.

## Processing, retry, and ownership

The API claims `pending` rows with a five-minute lease. It advances rows through
`pending`, `processing`, `processed`, or `dead`. Retryable failures use a
30-second exponential delay, capped at one hour, with 0–25% jitter. The worker
dead-letters a row after eight attempts. An operator may replay a `dead` row
after correcting the cause; replay restores it to `pending`, clears the lease
and error fields, and resets attempts to zero.

For `TRANSACTIONS:SYNC_UPDATES_AVAILABLE`, the API creates (or deduplicates)
one `webhook`-triggered pipeline run for the matched Plaid item user. For item
status events, it updates the item through the API mutation boundary, which
increments that user's revision and invalidates cached responses. Scheduling a
sync alone is not considered a status-data mutation.

Processed rows are retained for 30 days and dead rows for 90 days, then removed
by the API retention job. Centsy does not run retention, replay, migrations, or
any API worker.

## Least-privileged database role

The deployment owner creates and manages the `centsy_ingress` login separately.
Apply [centsy-ingress-grants.sql](../database/security/centsy-ingress-grants.sql)
as the API database owner after that role exists. It grants schema `USAGE` and
`INSERT` only on the eleven producer-owned inbound-event columns. It grants no
`SELECT`, `UPDATE`, `DELETE`, `RETURNING`, sequence, function, or domain-table
privileges.
