# centsible-api

API service for the Centsible app.

## Local development

Copy `.env.example` to `.env` and fill in credentials. Install dependencies
with `pnpm install`.

### Database setup

```sh
pnpm db:migrate
```

This applies all pending schema migrations and seeds the global reference
data (default categories) in one step — `db:seed` only needs to run on its
own if you want to reseed without touching migrations. The target database
must already have the `vector` and `pg_trgm` Postgres extensions installed
(`CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS
pg_trgm;`), or migration fails with a clear error naming what's missing.

`db:migrate`/`db:seed` read `DATABASE_URL` and `DATABASE_SCHEMA` directly from
the process environment, not through the sandbox/production switch below.
Migrating a real (non-test) database additionally requires passing
`DATABASE_SCHEMA=public ALLOW_PUBLIC_DATABASE_MIGRATION=true` explicitly on
the command line — never store these in `.env` — as a deliberate guard
against accidentally migrating the wrong database:

```sh
DATABASE_URL="<target-db-url>" DATABASE_SCHEMA=public ALLOW_PUBLIC_DATABASE_MIGRATION=true pnpm db:migrate
```

To wipe all user-owned data (users, plaid_items, transactions, budgets, etc.)
while preserving the global category list — e.g. after branching a database
from sandbox for a fresh production start — see `scripts/reset-domain-data.ts`.
It refuses to run without `RESET_CONFIRM=yes` and prints row counts before
and after.

### Starting the API and worker

```sh
pnpm dev:api      # watch mode, sandbox
pnpm dev:worker   # watch mode, sandbox
pnpm start:api    # built dist, sandbox
pnpm start:worker # built dist, sandbox
```

`start:api`/`start:worker` always kill whatever is already listening on their
port (4000 for the API, the `WORKER_WAKE_URL` port — 4011 by default — for
the worker) before starting, so rerunning them never fails on "port already
in use." Only exact-match `node` processes on that port are killed; anything
else sharing the port (e.g. a Tailscale-forwarded listener) is left alone.

### Combined rolling logs

The API and worker write redacted JSON lines to `.logs/centsible.log` under
this checkout by default. Set the same absolute `LOG_FILE` in both processes
if you want a different location. Test runs retain their existing console
logger. This does not change `LOG_LEVEL` or `LOG_REDACTION_MODE`.

Append and rotation share one cross-process lock, so a rotation cannot split
an entry or leave another process writing to an old open file. The file rotates
before an entry would exceed 10 MiB or when its previous write was on a different
UTC day. Archives are `.1` (newest) through `.7` (oldest), with seven retained.
A single entry larger than 10 MiB is kept whole. The directory is created with
mode 0700 and new log files with mode 0600. Do not remove the `.lock` directory
while either process is running; stale locks recover after 30 seconds. If the
file cannot be written or its lock cannot be acquired, already-redacted entries
fall back to stderr instead of stopping the API or worker. Abrupt termination
can lose entries still waiting in the process's write queue.

To follow the combined output, use `tail -F .logs/centsible.log`.

### Sandbox vs. production

By default, every start script runs against **sandbox** — sandbox Plaid
credentials, the sandbox database, and a sandbox Centsy webhook target. To
run against **production** instead, use the `:prod` variants, which set
`PLAID_ACTIVE_ENV=production` for that one process only:

```sh
pnpm start:api:prod
pnpm start:worker:prod
```

This swaps in `PLAID_PRODUCTION_CLIENT_ID`/`PLAID_PRODUCTION_SECRET` (Plaid
API), `DATABASE_URL_PRODUCTION` (Neon), `WEBHOOK_BASE_URL_PRODUCTION` (where
Plaid delivers webhooks), and `CLERK_PRODUCTION_SECRET_KEY`/
`CLERK_PRODUCTION_PUBLISHABLE_KEY` (a separate Clerk production instance) —
see `.env.example` for the full variable list. All of these production fields
(except the optional `CLERK_PRODUCTION_JWT_KEY`, matching `CLERK_JWT_KEY`'s
existing optional status) are required together whenever
`PLAID_ACTIVE_ENV=production`; nothing silently falls back to a sandbox
value. This exists specifically so local sandbox testing (and its hooks)
can't cross-contaminate production data — sandbox and production are
different Plaid environments, different Clerk instances, different
databases, and different webhook
endpoints end to end.

## Local network binding

The API defaults to `127.0.0.1:4000`, which is appropriate for same-host
access or when `tailscale serve` proxies the listener. For direct access from
the Swift app over Tailscale, set `API_HOST` to the Mac mini's Tailscale IP and
keep `PORT=4000`. Only loopback and Tailscale IP literals are accepted; do not
guess or commit the machine's address.

## Operator runbooks

Plan 5 Task 4 is a sandbox rehearsal only. It must use an isolated
`centsible_test_<run-id>` schema and non-production ports; port `4000` remains
untouched until a separate, explicit Task 5 cutover approval.

- [API and worker operations](docs/operations.md)
- [Task 5 cutover checklist](docs/cutover-checklist.md)
- [Rollback checklist](docs/rollback-checklist.md)
- [Draft deprecation notice](docs/deprecation-notice.md)
