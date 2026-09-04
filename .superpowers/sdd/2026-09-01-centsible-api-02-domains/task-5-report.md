# Task 5 — Dashboard and reports read domains

## Summary

Implemented and registered `GET /dashboard/summary` and `GET /reports/summary`.
Both services use the established five-minute response cache with the current
user revision. The dashboard cache key also includes the UTC calendar date;
report keys use the normalized `type`, `dateFrom`, and `dateTo` fields.

The dashboard runs account, spending-total, and upcoming-bill reads concurrently,
then computes pure net worth/safe-to-spend values. Report aggregation preserves
the pinned sign convention and serializes every monetary value as a decimal
integer string. Each route has OpenAPI metadata and validates its produced wire
shape before returning it.

## RED evidence

Command:

```sh
pnpm test src/modules/dashboard src/modules/reports
```

Result: exit 1 as expected before implementation. The dashboard route returned
404 instead of 200/401, and Vitest could not resolve `dashboard/net-worth` or
`reports.service`. This proved the new aggregate tests exercised absent behavior.

## GREEN evidence

Focused module tests:

```sh
pnpm test src/modules/dashboard src/modules/reports
```

Result: exit 0; 3 files and 6 tests passed.

Guarded repository integrations:

```sh
pnpm exec vitest run tests/integration/dashboard tests/integration/reports --no-file-parallelism
```

Result: exit 0; 2 files and 2 tests skipped. `createIsolatedTestDatabase`
correctly skipped them because this shell has no configured Neon test inputs.

OpenAPI contract regression found by the first full gate was corrected by adding
the two new operations to its expected inventory. Targeted confirmation:

```sh
pnpm test src/platform/openapi/tests/docs.routes.test.ts
```

Result: exit 0; 1 file and 6 tests passed.

## Full local gate

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
pnpm test:dist
```

Result: all commands exited 0. The full local test run passed 38 files / 217
tests; the distribution smoke test exited 0.

## Files changed

- `src/modules/dashboard/`: repository, service, pure net-worth computation,
  schemas, OpenAPI route, public module boundary, and focused tests.
- `src/modules/reports/`: repository, service, schemas, OpenAPI route, public
  module boundary, and focused service tests.
- `src/app/create-http-app.ts` and `src/app/register-modules.ts`: dependency
  injection and composition registration for both modules.
- `tests/integration/dashboard/dashboard.repository.test.ts` and
  `tests/integration/reports/reports.repository.test.ts`: guarded isolated-DB
  repository coverage.
- `src/platform/openapi/tests/docs.routes.test.ts`: expected OpenAPI route list.

## Self-review

- Confirmed no runtime module crosses another module's internal boundary.
- Confirmed dashboard independent reads and income-vs-spending reads remain under
  `Promise.all`.
- Confirmed cache keys contain revision; dashboard adds date; reports provide
  canonical query fields.
- Confirmed wire schemas accept signed decimal-integer money and preserve the
  pinned empty-string behavior for a null upcoming-bill date.
- Ran `git diff --check`; it reported no whitespace errors.

## Concern

The repository tests compile and are guarded correctly, but their SQL behavior
was not exercised here because the required isolated Neon configuration is not
available. Run the guarded integration command with those inputs before relying
on database-level aggregate behavior in deployment.
