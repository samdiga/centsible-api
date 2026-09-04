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

## Remaining risks

The isolated Neon concurrency, transaction-history, tenant-isolation, and generated-schema cleanup cases are present but could not run without the controller-provided sandbox. Plaid refresh and unlink adapters remain no-op/upstream-unavailable ports for Plan 3 injection.

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
