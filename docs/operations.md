# Centsible API operations

This runbook covers the independent API and worker. Plan 5 Task 4 is limited to
an isolated Neon sandbox schema, API port `4001`, and a separate Centsy rehearsal
port. Port `4000` and production remain untouched until explicit Task 5
approval.

## Command labels and paths

- **Read-only** commands inspect files, processes, HTTP state, or database
  metadata without changing them.
- **Sandbox-mutating** commands may change only the exact generated Task 4
  schema or start and stop Task 4 processes.
- **Production-affecting — DO NOT RUN DURING TASK 4** commands are future Task 5
  steps and require explicit approval.

Run API commands from `/Users/samdiga/code/centsible-api` in Task 5, or from the
Task 4 worktree shown below during rehearsal. Run Centsy commands only from
`/Users/samdiga/code/centsy`.

## Prepare and build

The package requires Node `>=20` and pnpm `>=9`; `package.json` pins pnpm
`9.15.0`.

```bash
# Read-only — API worktree
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
node --version
pnpm --version
git rev-parse HEAD

# Sandbox-mutating local files only — installs the locked dependency graph
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
pnpm install --frozen-lockfile
pnpm build
pnpm test:dist
```

Keep secrets in an ignored, mode-`600` environment file. Never commit, print,
copy into a log, or pass a Clerk token on the command line.

```bash
# Read-only — API worktree; verifies the local file without displaying it
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
test -f .env.sandbox.local
test "$(stat -f '%Lp' .env.sandbox.local)" = 600
git check-ignore -q .env.sandbox.local

# Read-only — parse dotenv syntax without printing values
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
node --env-file=.env.sandbox.local --input-type=module -e '
const e=process.env;
if(!e.TEST_DATABASE_URL) process.exit(1); new URL(e.TEST_DATABASE_URL);'
```

Do not shell-source `.env.sandbox.local`: database URLs may legally contain
shell metacharacters such as `&`. Launch Node with
`--env-file=.env.sandbox.local`; when runtime credentials are also required,
load the ignored main-checkout `.env` first and the sandbox file second. Node
applies the later file as the guard override, and neither file is printed.

The combined ignored environment inputs need the runtime credentials represented
in `.env.example` and a short-lived sandbox Clerk identity when smoke checks
run. `.env.sandbox.local` supplies these guards and the approved test URL:

```text
NODE_ENV=test
DATABASE_ENVIRONMENT=sandbox
ALLOW_SHARED_SANDBOX_TEST_DATABASE=true
TEST_SCHEMA_PREFIX=centsible_test_
```

## Create and migrate an isolated sandbox schema

The manual SQL snippets below require the PostgreSQL `psql` client. Verify it
with `command -v psql` before Task 5. The Task 4 host did not have `psql`, so
the live rehearsal executed the same exact-name statements through the
repository's `postgres` driver instead; that does not waive the Task 5 client
preflight.

First confirm the guard values and the original URL. This rejects URL parameters
capable of overriding `search_path` and deliberately prints nothing.

```bash
# Read-only — API worktree
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
node --env-file=.env.sandbox.local --input-type=module -e '
const e=process.env;
if(e.NODE_ENV!=="test"||e.DATABASE_ENVIRONMENT!=="sandbox"||e.ALLOW_SHARED_SANDBOX_TEST_DATABASE!=="true"||e.TEST_SCHEMA_PREFIX!=="centsible_test_"||!e.TEST_DATABASE_URL) process.exit(1);
const u=new URL(e.TEST_DATABASE_URL);
if(!["postgres:","postgresql:"].includes(u.protocol)||!u.hostname||!u.username) process.exit(1);
for(const key of u.searchParams.keys()) if(["options","search_path"].includes(key.toLowerCase())) process.exit(1);'
```

Check only the two rehearsal ports before creating anything. Do not inspect port
`4000`.

```bash
# Read-only — API worktree
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
! lsof -nP -iTCP:4001 -sTCP:LISTEN
! lsof -nP -iTCP:4010 -sTCP:LISTEN
```

Generate one name, validate it, create only that schema, and derive a runtime URL
with exactly one encoded `options=-c search_path=...` value. The derived URL
remains in the current shell and is not printed.

```bash
# Sandbox-mutating — API worktree
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
export DATABASE_SCHEMA="centsible_test_$(openssl rand -hex 12)"
[[ "$DATABASE_SCHEMA" =~ ^centsible_test_[a-z0-9_]+$ ]] || exit 1
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -v schema_name="$DATABASE_SCHEMA" -c 'CREATE SCHEMA :"schema_name"'
export DATABASE_URL="$(node --input-type=module -e '
const u=new URL(process.env.TEST_DATABASE_URL); const s=process.env.DATABASE_SCHEMA;
if(!/^centsible_test_[a-z0-9_]+$/.test(s)) process.exit(1);
for(const key of u.searchParams.keys()) if(["options","search_path"].includes(key.toLowerCase())) process.exit(1);
u.searchParams.set("options",`-c search_path=${s}`); process.stdout.write(u.href);')"
test "$DATABASE_SCHEMA" != public
pnpm db:migrate
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc 'select current_schema()' | grep -Fx "$DATABASE_SCHEMA"
```

`DATABASE_SCHEMA` selects the migration target; the derived `DATABASE_URL` pins
every API, worker, listener, and Centsy database connection to that schema. The
migration CLI refuses to default to `public`.

```bash
# Production-affecting — DO NOT RUN DURING TASK 4 — API checkout
cd /Users/samdiga/code/centsible-api
test "$DATABASE_ENVIRONMENT" = production
test "$DATABASE_SCHEMA" = public
test "$ALLOW_PUBLIC_DATABASE_MIGRATION" = true
pnpm db:migrate
```

## Start and observe the separate roles

Build before starting compiled roles. Create private temporary logs and record
the exact PID, working directory, role, worker identity, and build SHA.

```bash
# Sandbox-mutating — API worktree
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
pnpm build
export GIT_SHA="$(git rev-parse HEAD)"
export API_HOST=127.0.0.1 PORT=4001 API_DOCS_ENABLED=true
export WORKER_ID="task4-$(openssl rand -hex 8)"
export TASK4_LOG_DIR="$(mktemp -d /private/tmp/centsible-task4.XXXXXX)"
chmod 700 "$TASK4_LOG_DIR"
umask 077
pnpm start:api >"$TASK4_LOG_DIR/api.log" 2>&1 & API_PID=$!
until curl --fail --silent --output /dev/null http://127.0.0.1:4001/health; do kill -0 "$API_PID" 2>/dev/null || exit 1; sleep 1; done
pnpm start:worker >"$TASK4_LOG_DIR/worker.log" 2>&1 & WORKER_PID=$!
```

The API starts the PostgreSQL invalidation listener before accepting HTTP. Its
graceful close order is HTTP server, cache cleanup, listener unsubscription,
notification connection, then database pool. The worker starts job polling,
inbound-event polling, and the scheduler; reverse shutdown stops scheduling
first, then inbound and job claims, and finally closes the database pool.

```bash
# Read-only — API worktree; exact Task 4 PIDs only
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
ps -o pid=,ppid=,command= -p "$API_PID" -p "$WORKER_PID"
lsof -nP -a -p "$API_PID" -iTCP:4001 -sTCP:LISTEN
pwd -P
grep -E '"(service|role|hostname|port|revision|workerId|requestId|status)"' "$TASK4_LOG_DIR/api.log" "$TASK4_LOG_DIR/worker.log"
```

Report only role, service, worker/build identity, route, status, request ID,
event/job ID, safe error code, verification disposition, duration, and
timestamps. Never report payloads, tokens, account or transaction names,
financial values, or connection strings.

## Health, smoke runner, and Swagger

Every response receives or preserves `x-request-id`. The smoke runner reports
only route, status, safe error code, request ID, and counts. It rejects base URLs
with credentials, query strings, or fragments and rejects redirects.

```bash
# Read-only HTTP — API worktree; public health plus authenticated skips
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
env -u CENTSIBLE_SMOKE_TOKEN pnpm tsx scripts/smoke-api.ts --base-url http://127.0.0.1:4001

# Read-only HTTP — API worktree; token exists only in this process environment
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
CENTSIBLE_SMOKE_TOKEN="$CENTSIBLE_SMOKE_TOKEN" pnpm tsx scripts/smoke-api.ts --base-url http://127.0.0.1:4001
```

For Swagger, open `http://127.0.0.1:4001/docs`, sign in through the Clerk-hosted
component, and run safe reads. The browser keeps the bearer token only in memory.
Use the page's **Sign out** control; it clears Swagger authorization before Clerk
sign-out. Confirm an unauthenticated `/openapi.json` request returns `401`.

## Cache and reversible-write observation

The private response cache defaults to a five-minute TTL, 1,000 entries, 64 MiB
total, and 2 MiB per entry. A successful domain mutation commits its user-data
revision, evicts local entries, and publishes the internal user UUID for
cross-process eviction. Rehearsal uses `GET`/`PATCH
/notifications/preferences`; retain payloads in memory only and restore the
original value immediately.

```bash
# Read-only database metadata — API worktree; isolated internal UUID only
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v user_id="$REHEARSAL_USER_ID" -c \
  "select revision, updated_at from user_data_versions where user_id = :'user_id'::uuid"
```

## Read-only queue and pipeline inspection

These queries omit payloads, provider item IDs, user-facing names, monetary
values, and error messages.

```bash
# Read-only database metadata — API checkout/worktree
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "select id,type,status,attempts,max_attempts,scheduled_for,locked_by,lease_expires_at,completed_at,error_code,created_at from jobs order by created_at desc limit 50"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "select id,trigger,status,job_id,started_at,finished_at from pipeline_runs order by started_at desc limit 50"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "select id,provider,webhook_type,webhook_code,status,attempts,available_at,locked_by,lease_expires_at,last_error_code,received_at,processed_at from inbound_webhook_events order by received_at desc limit 50"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "select id,status,attempts,available_at,lease_expires_at,last_error_code,received_at,processed_at from inbound_webhook_events where status in ('pending','processing','dead') order by received_at"
```

Replay exactly one reviewed dead event. The command validates a canonical UUID,
requires current `dead` status, and writes a payload-free audit record.
Finished jobs, processed inbound events, and raw Plaid imports are retained for
30 days. Forecast runs, resolved forecast events, pipeline runs, and dead inbound
events are retained for 90 days; the API worker owns scheduled retention.

```bash
# Sandbox-mutating in Task 4; production-affecting in Task 5 — exact event only
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
pnpm webhook:replay -- 11111111-1111-4111-8111-111111111111
```

## Centsy durable webhook ingress

Centsy owns public `POST /api/plaid/webhook`. It validates content type and body
size, verifies the ES256 `Plaid-Verification` token and exact raw-body SHA-256,
then returns `200` only after the durable insert resolves. The API worker owns
processing, retries, dedupe-safe domain effects, and terminal status.

For Task 4, use Centsy's `DATABASE_URL` with the same exact
`options=-c search_path=<schema>` value, verify `current_schema()` through an
independent connection, then start the already-built read-only Centsy checkout
on port `4010`. Do not rebuild, edit, or deploy Centsy.

```bash
# Read-only source; sandbox-mutating process/database use — Centsy checkout
cd /Users/samdiga/code/centsy
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc 'select current_schema()' | grep -Fx "$DATABASE_SCHEMA"
PORT=4010 HOSTNAME=127.0.0.1 npm run start -- -p 4010 -H 127.0.0.1 >"$TASK4_LOG_DIR/centsy.log" 2>&1 & CENTSY_PID=$!
```

## Graceful shutdown and exact cleanup

Use only captured PIDs. Never use `killall`, `pkill`, wildcard PID matching, or a
port-kill script.

```bash
# Sandbox-mutating — exact Task 4 processes only
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
kill -TERM "$WORKER_PID" && wait "$WORKER_PID"
kill -TERM "$API_PID" && wait "$API_PID"
kill -TERM "$CENTSY_PID" && wait "$CENTSY_PID"
! lsof -nP -iTCP:4001 -sTCP:LISTEN
! lsof -nP -iTCP:4010 -sTCP:LISTEN
```

After inspecting durable event status and leases, close all clients and remove
only the exact schema created by this rehearsal. The name guard and quoted psql
identifier prevent prefix-wide cleanup.

```bash
# Sandbox-mutating — exact Task 4 schema only
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
[[ "$DATABASE_SCHEMA" =~ ^centsible_test_[a-z0-9_]+$ ]] || exit 1
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -v schema_name="$DATABASE_SCHEMA" -c 'DROP SCHEMA :"schema_name" CASCADE'
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -v schema_name="$DATABASE_SCHEMA" -Atc "select count(*) from pg_namespace where nspname = :'schema_name'" | grep -Fx 0
```

Leak inspection is read-only. Never feed its result into a bulk drop command;
the 52 retained diagnostic schemas are a separate cleanup backlog.

```bash
# Read-only — API worktree
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "select count(*) as prefixed_schema_count from pg_namespace where nspname like 'centsible_test_%'"
```

## Neon recovery preparation

Before Task 5, record the Neon project/branch identifiers, current production
branch head, migration start time, recovery retention window, and the operator
who can create a point-in-time recovery branch. Verify in the Neon console that
a recovery branch can be created at the pre-migration timestamp, but do not
restore, reset, promote, or rewire production during Task 4. Application
rollback preserves additive schema objects; it does not drop new tables.

## Tailscale and Task 5 capture

Resolve the Mac mini address at cutover time; never guess or commit it.

```bash
# Read-only — on the Mac mini during approved Task 5 preparation
cd /Users/samdiga/code/centsible-api
tailscale ip -4
```

Before requesting Task 5 approval, capture the verified API commit and full gate,
Centsy deployment and schema parity, Neon recovery evidence, exact current
port-`4000` API/scheduler paths and PIDs, one-scheduler plan, API/worker env
readiness, resolved Tailscale address, sandbox smoke/write/webhook/rollback
evidence, immediate rollback triggers, and the exact old-service restart path.
