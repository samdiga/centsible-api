# Plan 5 Task 5 cutover checklist

No live step in this file is approved or complete. Task 5 requires a separate,
explicit approval before any process on port `4000` is inspected deeply,
signaled, stopped, or replaced.

## Task 4 rehearsal evidence

- Date: 2026-09-12
- Isolated sandbox schema lifecycle: created, migrated, independently verified,
  and exact-name removed (`centsible_test_7419a40b56dca3618c604b25`)
- API `127.0.0.1:4001`: compiled role started, observed, gracefully stopped,
  and port confirmed free
- Centsy `127.0.0.1:4010`: existing build started without source changes,
  accepted signed deliveries, gracefully stopped, and port confirmed free
- Public/authenticated smoke: passed all required reads; documented budget `404`
  and disabled-forecast `403` were accepted only with their safe error codes
- Reversible write: cache was primed, revision advanced on change, changed value
  was observed, original value was restored, and revision advanced again
- Genuine Plaid Sandbox webhook: Centsy returned `200` after durable pending
  insert; the worker processed it, and exact redelivery produced one domain
  effect with one audit row
- Rollback: worker then API then Centsy stopped by recorded PID/session; six
  events and five jobs were terminal, active lease counts were zero, both
  rehearsal ports were free, and the exact schema was absent after cleanup
- Port `4000`: excluded from Task 4 and must remain unchanged

## Approval packet

- [ ] Record the exact verified `centsible-api` commit SHA.
- [ ] Attach the full format, lint, typecheck, unit, build, dist, and diff-check
      matrix with exact counts and skips.
- [ ] Confirm Centsy is deployed at its reviewed commit and its mirrored inbound
      schema matches the API migration.
- [ ] Confirm Centsy continues durable webhook ingress throughout cutover and
      rollback.
- [ ] Record Neon project and branch identifiers, the pre-migration timestamp,
      recovery retention, and point-in-time recovery operator.
- [ ] Verify API and worker environment values without displaying secrets.
- [ ] Resolve the Mac mini Tailscale address with `tailscale ip -4`; do not use a
      guessed or committed address.
- [ ] Record immediate rollback triggers and the exact old-service restart
      command/path.
- [ ] Obtain explicit Task 5 approval.

## Live process resolution — production-affecting, DO NOT RUN DURING TASK 4

Run from `/Users/samdiga/code/centsible-api` only after approval.

- [ ] Resolve the exact process listening on port `4000`.
- [ ] Record its PID, parent PID, executable, working directory, build SHA, and
      environment owner without printing environment values.
- [ ] Resolve the exact old API and scheduler/worker processes by verified PID
      and path.
- [ ] Confirm the shutdown plan targets only those exact PIDs.
- [ ] Confirm the old scheduler stops before the new worker starts.
- [ ] Confirm exactly one scheduler will be active at every post-transition
      checkpoint.

## Required command matrix

All boxes remain unchecked until Task 5 execution.

- [ ] Clean locked install: `pnpm install --frozen-lockfile`
- [ ] `pnpm format:check`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] Approved isolated/production integration evidence
- [ ] `pnpm build`
- [ ] `pnpm test:dist`
- [ ] `git diff --check`
- [ ] Guarded additive migration: `pnpm db:migrate`
- [ ] Separate compiled API: `pnpm start:api`
- [ ] Separate compiled worker: `pnpm start:worker`

## Transition — production-affecting, DO NOT RUN DURING TASK 4

- [ ] Reconfirm approval, exact SHAs, recovery point, rollback trigger, and
      operator roles immediately before the first signal.
- [ ] Stop the verified old scheduler/worker gracefully by exact PID.
- [ ] Confirm it released or will safely expire all leases.
- [ ] Stop the verified old API gracefully by exact PID.
- [ ] Confirm port `4000` is free.
- [ ] Apply only reviewed additive migrations.
- [ ] Start the new worker with a unique `WORKER_ID` and exact `GIT_SHA`.
- [ ] Prove only one scheduler is active.
- [ ] Start the new API on the resolved Tailscale address and port `4000`.
- [ ] Prove the API and worker roles, paths, revisions, and graceful-shutdown
      handlers.

## Cutover smoke matrix

- [ ] Public `GET /health` returns `200` with a request ID.
- [ ] Authenticated smoke runner passes every required read.
- [ ] Swagger signs in with Clerk, runs an authenticated request, and signs out
      without retaining authorization.
- [ ] Swift connects over the exact Tailscale URL and decodes representative
      responses, including Plaid refresh's dedicated balance DTO.
- [ ] One reversible HTTP write is immediately visible through a cached read,
      increments revision, and is restored with another revision increment.
- [ ] Centsy accepts a genuinely signed Plaid webhook only after durable insert.
- [ ] The worker processes the event to a terminal state with the expected safe
      domain effect and no duplicate effect on redelivery.
- [ ] Plaid item status and a safe Plaid operation pass.
- [ ] Queue, pipeline, retry, dead-event, cache, memory, and Neon activity show
      no severity-one or severity-two issue.

## Immediate rollback triggers

Rollback immediately on lost acknowledged webhook data, duplicate schedulers,
unsafe schema routing, repeated authentication failure, stale post-write cache,
unrecoverable worker leases, contract-breaking Swift responses, or a
severity-one/two regression. Use [rollback-checklist.md](rollback-checklist.md).

## Recording

- [ ] Record timestamps, request/event IDs, statuses, safe error codes, process
      PIDs, worker/build identities, and rollback decisions only.
- [ ] Do not record tokens, payloads, connection strings, user-facing names, or
      financial values.
- [ ] Do not begin the seven-day Task 6 soak until every Task 5 gate passes.
