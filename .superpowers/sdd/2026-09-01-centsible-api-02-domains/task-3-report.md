# Task 3 accounts domain report

## Source mapping

- Base: `06d3972a7ffc88b6c65a4bab4ad47487e55b800c` account repository/routes and shared account, summary, and Plaid contracts.
- `ca000fbb1f1755e77b22970ba6ff11ce520aa4ea`: existing account relinks to the live item while retaining its UUID and history.
- `32515278be92347635081bac76cf1766bb563189`: same-item sync retains intentional `deletedAt`; different-item relink clears it.
- `423879917c74cce21ccafa606279cc0511d4da91`: account delete contract and last-account unlink handoff, redesigned here behind injected ports and a transaction advisory lock.

## RED/GREEN evidence

RED was captured before implementation with:

```text
pnpm exec vitest run src/modules/accounts --no-file-parallelism
Test Files: 2 failed, 1 passed; Tests: 3 failed
Failure: account repository/service modules were missing and account routes returned 404.
```

GREEN focused verification:

```text
pnpm exec vitest run src/modules/accounts --no-file-parallelism
Test Files 3 passed; Tests 12 passed
```

## Verification

- `pnpm format:check` — passed, all files matched Prettier.
- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- `pnpm test` — passed, 31 files / 189 tests.
- `pnpm exec vitest run tests/integration/accounts --no-file-parallelism` — skipped 1 file / 3 tests because the approved isolated Neon environment was not present; no Neon claim is made.
- `pnpm build` — passed.
- `pnpm test:dist` — passed.
- `git diff --check` — passed.

## Fix Round 2

- Added a transaction-required `findByIdForUpdate` account read and changed
  deletion to derive its item membership only after that decisive row lock.
- Added sorted user/item advisory locking to existing-account updates,
  relinks, and inserts. Same-item `deletedAt` preservation is now evaluated by
  SQL against the locked row, so a stale sync cannot resurrect a committed
  deletion. Root repository upserts and the new public
  `createPlaidAccountWriter(db)` both execute in an active transaction.
- Made `recordAudit` required and removed repository leakage from the accounts
  public index; only the explicit writer factory/types and service ports are
  public. Unique-violation reconciliation remains typed while unrelated
  database errors propagate.
- Added focused row-lock ordering coverage and guarded isolated integration
  coverage for same-item delete/sync ordering, relink ordering, concurrent new
  membership, and the public writer transaction.

Fix Round 2 RED/GREEN:

```text
RED: pnpm exec vitest run src/modules/accounts/tests/accounts.service.test.ts --no-file-parallelism
1 failed (the decisive findByIdForUpdate call was absent).
GREEN: pnpm exec vitest run src/modules/accounts --no-file-parallelism
3 files passed; 20 tests passed.
```

Fix Round 2 verification:

- `pnpm exec vitest run src/modules/accounts --no-file-parallelism` — 3 files / 20 tests passed.
- `pnpm test` — 31 files / 197 tests passed.
- `pnpm format:check` — all files matched Prettier.
- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- `pnpm test:dist` — passed.
- `git diff --check` — passed.
- Shared/Neon integration was not run per controller instruction; the new
  isolated cases remain guarded in `tests/integration/accounts` for controller
  execution.

Round 2 follow-up hardening:

- A final lock-order audit found a potential insert-versus-relink advisory-lock
  cycle during unique-conflict reconciliation. All upserts now first acquire a
  per-global-Plaid-account transaction lock, then row-lock the account and only
  then acquire sorted membership locks.
- Evidence after this follow-up: `pnpm typecheck`,
  `pnpm exec vitest run src/modules/accounts --no-file-parallelism` (3 files /
  20 tests), and `git diff --check` all passed.

## Fix Round 3

- Added `createIsolatedSchemaClient` and `createPeerClient` support helpers.
  Every peer uses its own max-one postgres pool, the exact generated schema's
  startup `search_path`, and explicit close-before-schema-cleanup handling.
  The three lock-contention cases now run across independent sessions rather
  than being serialized by the former single pool.
- Added a transaction-bound `findOwnedItemForUpdate` after sorted membership
  locks. Upserts now reject a target item that disappeared or was soft-deleted
  while waiting, without repointing/restoring the account. Delete holds the
  owned item row lock through its decision.
- Removed the standalone compatibility upsert export. Repository and public
  writer no-transaction calls open a bound transaction; supplied transaction
  calls stay on that transaction. The upsert implementation accepts only a
  `DbTransaction` internally.
- Added guarded cross-session target-item invalidation coverage and support
  configuration coverage for max-one schema-pinned peers.

Fix Round 3 verification:

- `pnpm exec vitest run tests/support src/modules/accounts --no-file-parallelism` — 4 files / 37 tests passed.
- `pnpm test` — 31 files / 198 tests passed.
- `pnpm format:check` — all files matched Prettier.
- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- `pnpm test:dist` — passed.
- `git diff --check` — passed.
- Shared/Neon integration was not run per controller instruction; all extra
  clients are explicitly closed in guarded integration `finally` blocks before
  exact-schema cleanup.

## Remaining risks

The isolated Neon concurrency, transaction-history, tenant-isolation, and generated-schema cleanup cases are present but could not run without the controller-provided sandbox. Plaid refresh and unlink adapters remain no-op/upstream-unavailable ports for Plan 3 injection.

## Fix Round 4

- Replaced timing-based concurrency checks with PostgreSQL-observed blocking.
  Each waiter records its backend PID and the test releases the competing
  transaction only after `pg_blocking_pids` confirms the intended lock wait.
- Registered every peer pool with isolated-schema cleanup. Cleanup now attempts
  every pool shutdown, still drops only the exact generated schema when a peer
  close fails, preserves multiple failures, and remains retryable.
- Revalidated the target Plaid item after global account-conflict reconciliation
  acquires membership locks, preventing a waiting reconcile from attaching an
  account to an item deleted during the wait.

Fix Round 4 verification:

- `pnpm exec vitest run tests/support src/modules/accounts --no-file-parallelism` — 4 files / 38 tests passed.
- `pnpm test` — 31 files / 199 tests passed.
- `pnpm format:check` — all files matched Prettier.
- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- `pnpm exec vitest run tests/integration/accounts --no-file-parallelism` — 1 file / 13 tests skipped because the explicit isolated-Neon variables were unavailable; no database-execution claim is made.

## Commit

The final commit SHA is the value printed by `git rev-parse HEAD` for this
report's commit (`feat: migrate accounts domain`); it is returned in the task
handoff. Since this report is part of the commit, embedding that hash here
would change the hash itself.

## Fix Round 1

- Added `accounts-audit.ts` with an explicit complete AccountRow snapshot: bigint cents become strings and dates become ISO strings before JSONB audit insertion. `softDelete` now returns the persisted row so the audit reflects its actual deletion timestamp.
- Added transaction-bound tenant item lookup. Missing, foreign, or already-disconnected item links still permit local account deletion and audit, but cannot produce a Plaid unlink request.
- Moved `ActiveItemUnlinker` and its no-op adapter to `accounts-item-unlinker.ts`; narrowed `index.ts` to service and explicit Plan 3 ports without repository exports.
- Made refresh's default adapter fail as typed `UPSTREAM_FAILURE` before opening a database transaction; added typed 404/429 route coverage.
- Made post-commit unlink logging nested best effort, made global Plaid-account insert conflicts reconcile through `onConflictDoNothing`, and expanded guarded integration coverage.

Fix Round 1 RED/GREEN:

```text
RED: pnpm exec vitest run src/modules/accounts/tests/accounts.service.test.ts --no-file-parallelism
4 tests failed (missing audit mapper, unsafe item unlink, logger propagation, default refresh setup).
GREEN: pnpm exec vitest run src/modules/accounts --no-file-parallelism
3 files passed; 19 tests passed.
```

Fix Round 1 verification:

- `pnpm exec vitest run src/modules/accounts --no-file-parallelism` — 3 files / 19 tests passed.
- `pnpm exec vitest run tests/integration/accounts --no-file-parallelism` — 1 file / 8 tests skipped; isolated Neon was intentionally not run.
- `pnpm test` — 31 files / 196 tests passed.
- `pnpm format:check` — all files matched Prettier.
- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- `pnpm test:dist` — passed.
- `git diff --check` — passed.
