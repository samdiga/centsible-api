# Plan 5 Task 5B readiness packet

> **STALE — NOT READY FOR CUTOVER.** This packet predates the replacement Neon
> database and the configurable on-demand worker redesign. Its database,
> process, runtime, build, and deployment evidence must be recaptured against
> the intended cutover state. It is retained only as historical evidence and
> does not authorize migrations, service changes, webhook delivery, or cutover.

Evidence captured on 2026-09-13. This packet is read-only preparation and is
not authorization to execute Task 5 or any cutover action.

## Verdict

`STALE — TASK 5 IS NOT CURRENTLY READY`

All Task 5B readiness gates are closed. The operator confirmed on 2026-09-13
that the existing Tailscale exposure already proxies the Swift-facing route to
the API on `127.0.0.1:4000` and that this path has been tested. Task 5 must
still reverify it immediately before approval and mutation.

## Repository identities

- API `HEAD` and local `main`:
  `676e1e98bf65f5d19f696f7c1197983ad16cf96c`.
- API `origin/main`:
  `c7815c379f008c43bb14cffc215c70b4ce7acc98`; it is an ancestor of local
  `main`.
- Swift `HEAD` and local `main`:
  `6b76c5b2c6d37433440a690a2583b31505a3408f`.
- Swift `RESEARCH.md` blob:
  `7a73a31d7fc587931ccd9a0d61f8d2777dc7b992`.
- Centsy local `HEAD`, local `main`, and `origin/main`:
  `81252964b244036852ac7c225da87e04fe6c2c02`.
- Legacy `HEAD` and local `main`:
  `423879917c74cce21ccafa606279cc0511d4da91`.
- Legacy `origin/main`:
  `7ed4bafc3d52ff45cf580055ed0090b1d111d876`; it is an ancestor of local
  `main`, which is three commits ahead.

Existing unrelated tracked/untracked/ignored files were preserved.

## Centsy parity and production deployment

- `CENTSIBLE_API_PATH=/Users/samdiga/code/centsible-api npm run schema:check`
  exited `0`: committed mirrors match the pre-remediation API `5c3dcd2`; the
  remediation changes only migration SQL and its test, not schema sources.
- Authenticated Vercel evidence identifies project `centsy`, Production
  environment, current domain `centsy.dev`, source repository
  `samdiga/centsy`, branch `main`, exact source commit
  `81252964b244036852ac7c225da87e04fe6c2c02`, and status `Ready`.
- The deployment was created on 2026-09-13 at 1:50:46 PM EDT, after the
  schema-parity commit.
- Vercel build logs show `npm run build` invoked `prebuild`, which ran
  `node scripts/sync-schema.mjs --check`. The build environment did not contain
  the API repository, so the check explicitly used committed schema mirrors.
  The build then completed and deployed successfully.
- Public HTTP evidence:
  - `/` -> `200`.
  - `/oauth` -> `200`.
  - `/.well-known/apple-app-site-association` -> direct `200`,
    `content-type: application/json`, no `Location` header.
  - `GET /api/plaid/webhook` -> expected `405`.
- No webhook `POST` was sent.

## API runtime configuration

- `.env` exists, is gitignored, and is not a symlink.
- Its content was not displayed or rewritten. Its mode was changed from `644`
  to `600` as authorized by Task 5B.
- Required nonblank names:
  - `DATABASE_URL=true`
  - `CLERK_SECRET_KEY=true`
  - `CLERK_PUBLISHABLE_KEY=true`
  - `PLAID_CLIENT_ID=true`
  - `PLAID_SECRET=true`
  - `PLAID_TOKEN_KEY=true`
  - `WEBHOOK_BASE_URL=true`
- Optional current name-only results:
  - `CLERK_JWT_KEY=false`
  - `PLAID_REDIRECT_URI=false`
- `ALLOW_PUBLIC_DATABASE_MIGRATION` is absent.
- `loadEnv()` passed without starting a role for both API and worker using the
  static future overrides below. The API input omitted `WORKER_ID`; the worker
  input used the unique, unpersisted identity below.

Future API/worker runtime overrides:

```text
NODE_ENV=production
PORT=4000
API_HOST=127.0.0.1
DATABASE_ENVIRONMENT=production
PLAID_ENV=sandbox
API_DOCS_ENABLED=true
GIT_SHA=676e1e98bf65f5d19f696f7c1197983ad16cf96c
```

Future worker-only override:

```text
WORKER_ID=task5-52c41fe7-c647-49f1-a215-8598f4bb23e2
```

`API_HOST=127.0.0.1` and `PLAID_ENV=sandbox` now pass `loadEnv()`. The operator
confirmed the existing Tailscale exposure from the Swift-facing tailnet route
to `127.0.0.1:4000` is already configured and tested. End-to-end reachability
must be reverified immediately before Task 5 approval and again before
startup.
`PLAID_ENV=sandbox` is the intentional
Task 5 and Task 6 state, using the existing Sandbox secret and Items. Current
Plaid documentation confirms that the former Development environment was
decommissioned on 2024-06-20; the repository's `development.plaid.com` option
and the earlier Task 5B Development lock are stale. Plaid Production launch
remains deferred until after the seven-complete-day Task 6 soak. Sandbox Items
are not treated as transferable Production Items.

Do not persist `CENTSIBLE_SMOKE_TOKEN`. Keep
`ALLOW_PUBLIC_DATABASE_MIGRATION` false/absent for API and worker. Only the
single future approved migration process may receive
`DATABASE_SCHEMA=public` and `ALLOW_PUBLIC_DATABASE_MIGRATION=true`.

## Neon recovery evidence

- Project: `centsible-sandbox` (`twilight-mouse-96614468`).
- Production/default branch: `production` (`br-little-truth-awmppkut`).
- Region: AWS US East 1, N. Virginia (`us-east-1`).
- Plan: Free.
- History/PITR retention: six hours. At inspection, the console exposed an
  exact earliest-restorable timestamp and enabled the point-in-time Restore
  control.
- Snapshot creation was also enabled; no snapshots currently existed and
  scheduled snapshots require an upgrade.
- Operator/mechanism: project Admin Ganesh must use Neon Console -> production
  -> Backup & Restore -> Create snapshot immediately before the migration, or
  confirm the pre-migration timestamp is inside the enabled six-hour PITR
  window. Record only the resulting safe snapshot/timestamp identifier.
- Pre-migration reference captured for this packet:
  `2026-09-13T21:22:00Z`. Task 5 must capture a new timestamp immediately
  before mutation.
- No snapshot, branch, restore, or database write was performed.

## Production migration-ledger evidence

The database session used `BEGIN READ ONLY`; `transaction_read_only=on` was
verified before metadata queries. It targeted the configured Neon endpoint,
database `neondb`, and `current_schema()=public`. No application rows, payloads,
user names, or financial values were selected.

The generated history currently resides in the supported legacy relation
`drizzle.__drizzle_migrations`; `public.__drizzle_migrations` does not yet
exist. `public.schema_raw_migrations` exists. No duplicate, unknown, or partial
pending migration state was found.

### Applied and recognized generated migrations

1. `0000_white_puff_adder.sql` —
   `9b96207482b90c39d0f6ff5185075109a3164a5882e2310eb08c533884c662fc`
2. `0001_cooing_edwin_jarvis.sql` —
   `4f9a853bc411aa90b7f3b325f565e9eac9cffe558ac43b7a4591ec95d7721b4e`
3. `0002_smooth_scarecrow.sql` —
   `a23696a17252b03a778c5296433b9a16883812cdc98b12209b13acd27cdfe463`
4. `0003_rename_recurring_series_to_bill_setup.sql` —
   `5a148428a58e08fb2151fa372e6c4abc98f5459a527b011c087d37778cdfd2b4`
5. `0004_dark_war_machine.sql` —
   `d11866382e31414072d80d92ed07fa397007a2cf8ac919c99929cb0b14094031`
6. `0005_unique_hammerhead.sql` —
   `59f8cfc7581283d61438c7ea90fd161c218862ce2adda6c004a698ca27047f47`
7. `0006_quick_hairball.sql` —
   `5f375ce469035ef16b39d69d6210d60fcddffc97d5d68874f8225af2e88ee053`

### Pending generated migrations

1. `0007_user_data_versions.sql` —
   `e344c0aa5503a2641476bd472a92a3a1c11c86c0227969c79043454e3ec6fd5b`
   — additive table.
2. `0008_jobs_leases.sql` —
   `49d214a18ab6c97088cc982e66c28b2e06e04ed01480c8d3a99f8b5649c03d69`
   — adds lease/error-code fields and normalizes active legacy rows while
   preserving the nullable legacy `jobs.error` column for rollback.
3. `0009_inbound_webhook_events.sql` —
   `b83adcaa294697a4982991a07a34125b6bb30ed03c4ab3ed520f44372f55bb6a`
   — additive table and indexes.
4. `0010_inbound_event_lease_fencing.sql` —
   `444211e9c032d0abf24e0eba134ed226e8d10a03673346e634946be76b9cd709`
   — adds lease fencing, normalizes only the newly introduced inbound-event
   lifecycle, and adds constraints/index.

### Applied and recognized raw migrations

`0001_extras.sql`, `0002_audit_sync_action.sql`,
`0003_cash_horizon_schema_patch.sql`, `0004_bills_type_cadence.sql`,
`0005_phase1_integrity_indexes.sql`, `0006_search_indexes.sql`.

### Pending raw migrations

- `0007_rules_rename_hide_actions.sql` — additive nullable columns using
  `IF NOT EXISTS`.

### Unknown or inconsistent in production

- Unknown generated hashes: none.
- Unknown raw filenames: none.
- Duplicate ledger identifiers: none.
- Partial pending schema objects: none.
- Blocking inconsistency: none. The `0008` rollback-compatibility remediation
  is merged locally as API commit
  `676e1e98bf65f5d19f696f7c1197983ad16cf96c` and passed its executed isolated
  migration regression.

## Legacy runtime and rollback

Current sanitized exact topology on terminal `ttys010`, process group `7033`:

```text
PID 7033  PPID 61404  PGID 7033  npm run dev
PID 7076  PPID 7033   PGID 7033  tsx watch ... src/index.ts
PID 59934 PPID 7076   PGID 7033  node/Hono ... src/index.ts
```

The process group snapshot contains exactly these three members and no
unrelated process. Listener PID `59934` owns TCP `*:4000`; its cwd is exactly
`/Users/samdiga/code/centsible-claude/apps/api`.

The source and compiled entrypoint start the Hono API, jobs poller, and
scheduler in the same process. There is no signal-driven graceful shutdown
handler. Therefore the legacy runtime cannot stop worker/scheduler separately.

`pnpm --filter @centsible/api build` exited `0` and changed no tracked file.
The ignored `apps/api/dist/index.js` contains the API/poller/scheduler startup.
`pnpm --filter @centsible/api exec node --version` reported `v24.2.0`.

Verified compiled rollback command:

```bash
cd /Users/samdiga/code/centsible-claude
pnpm --filter @centsible/api start
```

It resolves to `node --env-file-if-exists=../../.env dist/index.js`.
`package.json` has no `prestart`; this path does not invoke `kill-port.mjs`,
`kill:dev`, broad PID matching, a wildcard, or watch mode. Never use any dev
command for rollback.

## Controlled drained combined-stop procedure

Limitation: this is a drained exact-process-group stop, not graceful
component-by-component shutdown.

1. Declare a short client-activity drain window without changing DNS or
   Centsy.
2. Keep Centsy online. Before the inbound-event migration exists, a failed
   durable insert must return a retryable failure rather than acknowledge data;
   after migration the replacement worker owns processing.
3. In an explicitly read-only session, query status/type/count and lifecycle
   timestamps only until there are no active legacy jobs, running pipeline
   operations, or processing inbound-event leases. Never select payloads,
   tenant/user identifiers, names, errors, or financial values.
4. Re-resolve `lsof -nP -iTCP:4000 -sTCP:LISTEN`, listener cwd, exact ancestry,
   descendants, PGID, terminal, repository state, and commit immediately before
   signaling. Historical PIDs in this packet are never future targets.
5. After separate Task 5 approval, send one normal `SIGINT` to the newly
   verified exact legacy process group:

   ```bash
   kill -INT -- -$RESOLVED_LEGACY_PGID
   ```

6. Wait until both the exact process group has no rows and port `4000` has no
   listener. A vanished individual PID is insufficient.
7. Start the replacement worker only after the legacy group is absent; prove
   the one-scheduler invariant before starting the new API.
8. On application rollback, stop the new worker/API first, prove their exact
   groups absent and port `4000` free, then run the verified compiled legacy
   `start` command above. Never use `dev`/`predev`.

Approval status: approved by the user on 2026-09-13 for the future Task 5
cutover procedure only. This approval does not authorize any signal in Task 5B
and does not authorize executing Task 5.

## Exact changes required in `PLAN5_TASK5_PROMPT.md`

Do not execute or edit that prompt until the blockers above are repaired.
When refreshing it:

1. Replace every API baseline/GIT_SHA/base occurrence of `c8e4c7a...` with
   `676e1e98bf65f5d19f696f7c1197983ad16cf96c` and carry forward the reports
   feature plus migration-remediation commits.
2. Replace its old Centsy deployment gate (`cdc6e7e...` or descendant) with
   exact verified Production SHA
   `81252964b244036852ac7c225da87e04fe6c2c02` and the Vercel evidence above.
3. Correct the stale Development premise. Lock `PLAID_ENV=sandbox` through
   Task 5 and the seven-complete-day Task 6 soak, using the existing Sandbox
   credentials/Items; defer the Plaid Production launch and Item recreation
   until after soak. Remove reliance on the decommissioned
   `development.plaid.com` environment from the Task 5 instructions.
4. Use `API_HOST=127.0.0.1` with the operator-confirmed existing Tailscale
   exposure. Reverify the Tailscale route, rerun `loadEnv()`, and run the
   Swift-facing health check immediately before approval and startup; do not
   assume this packet's earlier test remains current.
5. Insert the exact `.env` name-only/mode evidence and future API/worker
   overrides from this packet. Generate a fresh `WORKER_ID` again if the
   current packet is not used immediately.
6. Insert the Neon project/branch/six-hour PITR/Admin snapshot mechanism and
   require a new pre-migration timestamp plus enabled recovery controls before
   mutation.
7. Insert the exact applied/pending/inconsistent migration sets and the new
   `0008_jobs_leases.sql` hash. Retain the executed regression proving that
   legacy `jobs.error` values survive migration.
8. Replace the impossible old worker-first graceful-stop assumption with the
   approved drained exact-process-group `SIGINT` procedure. Re-resolve all
   process identities before approval and again before signaling.
9. Replace rollback dev commands with the compiled legacy `start` command and
   require both process-group absence and a free port before restart.
10. Keep all existing live mutation gates: fresh provider state, recovery
    availability, migration ledger, PIDs, bind address, and explicit approval
    must be reconfirmed immediately before mutation.

## Actions not performed

No signal, server start/stop, port-`4000` change, migration, database write,
webhook delivery, authenticated financial write, provider configuration
change, deployment, push, Plaid environment switch, cutover, Task 5, or Task 6
was performed.
