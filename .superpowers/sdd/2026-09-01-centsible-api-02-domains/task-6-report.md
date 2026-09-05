# Task 6: Bills domain and recurring aliases report

## Summary

Implemented the bills domain as a package-local TypeScript module. It registers all nine canonical `/bills` operations and all nine deprecated `/recurring` aliases, validates wire responses, emits signed decimal-integer money strings, and uses typed not-found/conflict errors.

The service uses revisioned response-cache keys for list/detail/occurrence-history reads. Every user mutation runs through `withUserMutation`, records a JSON-safe audit entry, and invalidates user cache state through the shared revision protocol. `BillJobDispatcher` is a narrow injected port with an inert default until Plan 3 supplies worker dispatching.

## RED / GREEN evidence

RED command:

```text
pnpm test src/modules/bills/tests/bills.routes.test.ts
```

Result: 2 failures as expected before registration. `/bills` and `/recurring` returned route-not-found envelopes; occurrence skip returned 404 rather than the required 409.

GREEN command:

```text
pnpm test src/modules/bills/tests/bills.routes.test.ts
```

Result: 1 file, 2 tests passed after the bills module and aliases were registered.

## Verification

```text
pnpm test src/modules/bills
```

Result: 3 files, 6 tests passed.

```text
pnpm exec vitest run tests/integration/bills --no-file-parallelism
```

Result: 1 file / 1 test skipped. `readTestDatabaseConfig(process.env)` found no isolated Neon/Postgres test inputs, so no database was contacted.

```text
pnpm test
```

Result: 42 files, 229 tests passed.

```text
pnpm typecheck
pnpm lint
pnpm build
pnpm test:dist
```

Result: all commands exited 0.

```text
git diff --check
```

Result: exited 0.

## Changed files

- `src/modules/bills/bills.schemas.ts`
- `src/modules/bills/bills.repository.ts`
- `src/modules/bills/bill-occurrences.repository.ts`
- `src/modules/bills/bills.service.ts`
- `src/modules/bills/recurring-engine.ts`
- `src/modules/bills/statement-bills.ts`
- `src/modules/bills/bills.mapper.ts`
- `src/modules/bills/bills.routes.ts`
- `src/modules/bills/index.ts`
- `src/modules/bills/tests/bills.routes.test.ts`
- `src/modules/bills/tests/bills.service.test.ts`
- `src/modules/bills/tests/recurring-engine.test.ts`
- `tests/integration/bills/bills.repository.test.ts`
- `src/app/create-http-app.ts`
- `src/app/register-modules.ts`
- `src/platform/openapi/tests/docs.routes.test.ts`

## Self-review

- Confirmed all canonical and alias paths are registered in the generated OpenAPI operation contract.
- Confirmed `/recurring` has `deprecated: true` OpenAPI metadata and runtime `Deprecation: true` / successor `Link` headers.
- Confirmed static `/bills/detect` and `/recurring/detect` registrations precede dynamic same-method occurrence handlers; no static route is shadowed by an `/:id` handler.
- Confirmed the conditional occurrence update includes allowed status in its SQL predicate, so a concurrent terminal transition loses with a typed conflict rather than a second write.
- Confirmed audit rows serialize bigint values before JSONB insertion.

## Concerns

- Guarded repository integration coverage did not execute because this shell lacks the required isolated database configuration. The integration test is present and uses `createIsolatedTestDatabase`; rerun it with the Plan 2 Neon test inputs.
- The default job dispatcher intentionally queues nothing. Plan 3 must inject the worker adapter before production detection/materialization scheduling is enabled.

## Fix Round 1/5

### Findings addressed

- Exported `runOverdueSweep`, `resolveMaturedForecastEvents`, and `upsertStatementBills` from the public Bills boundary. The worker functions keep every repository read/write under the supplied `userId` and mutation transaction; the lifecycle factory delegates to the same functions.
- Added injectable isolated-DB dependencies to statement upsert while preserving the pinned positive credit/loan statement filter and the no-resurrection rule for deleted, paused, or ended rows.
- Preserved the ruling that accepted `daily` cadence advances one UTC day and materializes occurrences/forecast events.
- Removed production Bills route `any`/`as never` route and alias plumbing by declaring typed OpenAPI routes directly.
- Added focused and guarded integration coverage for statement create/update/no-resurrection, manual materialization dispatch, daily cadence, worker lifecycle calls, and unknown occurrence history.

### RED / GREEN evidence

RED command:

```text
pnpm test src/modules/bills/tests/bills.service.test.ts
```

Result: 2 worker-boundary tests failed as expected with `TypeError: runOverdueSweep is not a function` and `TypeError: resolveMaturedForecastEvents is not a function`; the five pre-existing Bills tests passed.

GREEN command:

```text
pnpm test src/modules/bills/tests/bills.service.test.ts
```

Result: 1 file, 7 tests passed after adding the public worker functions and delegating lifecycle methods.

Statement RED command:

```text
pnpm test src/modules/bills/tests/statement-bills.test.ts
```

Result: 2 tests failed as expected with `Error: DATABASE_URL is required`, proving statement upsert did not yet accept isolated dependencies.

Statement GREEN command:

```text
pnpm test src/modules/bills/tests/statement-bills.test.ts
```

Result: 1 file, 2 tests passed after adding injectable DB/mutation dependencies.

### Fix-round verification

```text
pnpm test src/modules/bills
```

Result: 4 files, 15 tests passed.

```text
pnpm exec vitest run tests/integration/bills --no-file-parallelism
```

Result: 1 file, 3 tests skipped. The required guarded isolated-Neon inputs are absent; no database was contacted.

```text
pnpm test
```

Result: 43 files, 238 tests passed.

```text
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test:dist
git diff --check
```

Result: every command exited 0; Prettier reported all files formatted, and the distribution smoke test exited cleanly.

### Fix-round changed files

- `src/modules/bills/bills.service.ts`
- `src/modules/bills/bills.routes.ts`
- `src/modules/bills/bills.repository.ts`
- `src/modules/bills/bill-occurrences.repository.ts`
- `src/modules/bills/statement-bills.ts`
- `src/modules/bills/index.ts`
- `src/modules/bills/recurring-engine.ts`
- `src/modules/bills/tests/bills.routes.test.ts`
- `src/modules/bills/tests/bills.service.test.ts`
- `src/modules/bills/tests/recurring-engine.test.ts`
- `src/modules/bills/tests/statement-bills.test.ts`
- `tests/integration/bills/bills.repository.test.ts`

### Fix-round self-review

- Confirmed `src/modules/bills/bills.routes.ts` has no `any` or `as never` route/alias plumbing; remaining `any` usage is confined to the pre-existing test doubles in `bills.service.test.ts`.
- Confirmed manual create and active update dispatch materialization after the mutation resolves, while worker lifecycle operations use the same tenant-scoped repository methods.
- Confirmed the guarded integration suite is opt-in and exact-schema isolated; it reports skips in this shell because `TEST_DATABASE_URL` and its required guards are unavailable.

### Fix-round concern

- The integration scenarios are present but unexecuted here because the required isolated Neon test inputs are unavailable. Run `pnpm exec vitest run tests/integration/bills --no-file-parallelism` with the approved guarded environment before treating database behavior as independently verified.
