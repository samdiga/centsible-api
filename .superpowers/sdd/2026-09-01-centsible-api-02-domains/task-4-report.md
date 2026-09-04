# Task 4 report: Transactions domain

## Status

Implemented and ready to commit after local verification. The isolated database suite is
present and guarded; it was skipped because this shell does not supply the required
`TEST_DATABASE_URL`, `NODE_ENV=test`, `DATABASE_ENVIRONMENT=sandbox`,
`ALLOW_SHARED_SANDBOX_TEST_DATABASE=true`, and `TEST_SCHEMA_PREFIX` inputs.

## Implementation summary

- Added the `transactions` module with wire schemas, tenant-scoped repository,
  DTO mapper, list/detail/patch/bulk/export service, and five OpenAPI handlers.
- Preserved source behavior from pinned commit `06d3972a7ffc88b6c65a4bab4ad47487e55b800c`:
  keyset ordering `(date DESC, id DESC)`, Plaid upserts, user-category override
  preservation, tenant-scoped writes, CSV header/formula escaping/sign convention,
  and the 10,000-row truncation signal.
- Added typed request errors: malformed cursors return `BAD_CURSOR`; empty patches
  return `BAD_REQUEST`; missing rows use `NOT_FOUND`; cross-tenant bulk IDs use
  `FORBIDDEN`.
- Cached only un-cursored `GET /transactions` pages by user revision. Cursor pages
  and CSV exports bypass the cache. Patch and bulk each execute through exactly one
  `withUserMutation` operation and write an audit record in that transaction.
- Registered transactions in app composition and expanded the OpenAPI operation
  inventory expectation for the five new routes.

## RED to GREEN evidence

1. RED command:

   `pnpm test src/modules/transactions`

   Result: exit 1. Vitest reported `Cannot find module '../transactions.routes.js'`
   from the new route test; this was the expected missing-module failure.

2. GREEN focused commands:

   `pnpm test src/modules/transactions && pnpm typecheck`

   Result: exit 0; 4 files and 6 focused tests passed; TypeScript completed with
   no diagnostics.

3. Guarded integration command:

   `pnpm exec vitest run tests/integration/transactions --no-file-parallelism`

   Result: exit 0; 1 file / 1 test skipped by the explicit database guard. No Neon
   execution was claimed or performed.

4. Full local gate:

   `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`

   Result: exit 0. ESLint and Prettier passed, TypeScript passed, Vitest reported
   35 files / 207 tests passing, and the build completed.

## Files changed

- `src/modules/transactions/{index,transactions.schemas,transactions.repository,transactions.mapper,transactions.service,transactions.routes}.ts`
- `src/modules/transactions/tests/{transactions.routes,transactions.repository,transactions.service,transactions.export}.test.ts`
- `tests/integration/transactions/transactions.repository.test.ts`
- `src/app/{register-modules,create-http-app}.ts`
- `src/platform/errors/app-error.ts`
- `src/platform/openapi/tests/docs.routes.test.ts`

## Self-review

- Confirmed pagination returns `limit + 1`, encodes the final retained tuple, and
  applies `(date, id)` keyset ordering to prevent duplicates across pages.
- Confirmed all repository reads and writes include user ownership predicates.
- Confirmed CSV never enters the response cache and the truncation header is set
  only for a truncated result.
- Confirmed `git diff --check` returned clean before commit.

## Remaining concern

The isolated database repository case has not run in this shell because the guarded
test database credentials/opt-in variables are absent. Run the guarded integration
command above in the configured sandbox before relying on database-backed behavior.

## Fix Round 1

### Findings addressed

1. Route handlers now execute `TransactionListResponseSchema`,
   `TransactionDetailResponseSchema`, and `TransactionBulkPatchResponseSchema`
   before emitting JSON. The amount field is constrained to a signed decimal
   integer string (`-?\\d+`), so a decimal such as `12.50` cannot escape.
2. Patch category/member ownership checks and the authoritative `findById`
   before-image now execute inside the one `withUserMutation` callback and use
   the callback's transaction. Bulk ownership checks now use that same boundary.
3. Focused routes now cover response rejection, detail, CSV export, bulk, and
   successful patch; service coverage proves both patch and bulk use one
   mutation. The guarded real repository suite now covers Plaid idempotency,
   override preservation, keyset paging, soft delete, foreign reads/writes, and
   mixed-owner bulk rejection.
4. The guarded integration suite now creates a second tenant and verifies that
   foreign rows cannot appear in a list, detail lookup, single write, or bulk
   update.

### Fix Round 1 RED to GREEN evidence

- RED: `pnpm test src/modules/transactions` exited 1. The invalid-response route
  test received HTTP 200 instead of 400, and the patch test showed
  `categoryExists` had no transaction-scoped call.
- GREEN: `pnpm test src/modules/transactions && pnpm typecheck` exited 0 with
  4 files / 9 focused tests passing and no TypeScript diagnostics.
- Guarded integration: `pnpm exec vitest run tests/integration/transactions
  --no-file-parallelism` exited 0 with 1 file / 2 tests skipped. The shell still
  lacks the required isolated-sandbox environment variables, so Neon was not run.

### Fix Round 1 full local verification

- `pnpm test src/modules/transactions` — 4 files / 9 tests passed.
- `pnpm test` — 35 files / 210 tests passed.
- `pnpm exec vitest run tests/integration/transactions --no-file-parallelism` —
  1 file / 2 tests skipped because the explicit isolated-Neon inputs remain
  unavailable; no database-execution claim is made.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`,
  `pnpm test:dist`, and `git diff --check` — all exited 0.
