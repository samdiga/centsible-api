# Centsible API Domain Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every non-Plaid, non-pipeline API capability into independently testable domain slices while preserving Swift contracts, the approved account lifecycle patches, and all `/bills` and `/recurring` behavior.

**Architecture:** Each module owns HTTP schemas, routes, service behavior, repository access, wire mappers, errors, and focused tests. Shared primitives are limited to money, time, pagination, ownership checks, and route registration.

**Tech Stack:** TypeScript, Hono OpenAPI routes, Zod, Drizzle, Neon Postgres, Vitest, the platform interfaces produced by Plan 1.

**Spec:** `docs/superpowers/specs/2026-09-01-centsible-api-migration-design.md`

## Global Constraints

- Complete Plan 1 first and use its `AppEnv`, error handler, DB, cache, revision, OpenAPI, and app-factory interfaces.
- Preserve method, path, success status, success body, money string, timestamp, cursor, and nullability behavior from pinned source commit `06d3972a7ffc88b6c65a4bab4ad47487e55b800c` plus approved supplemental account commits `ca000fbb1f1755e77b22970ba6ff11ce520aa4ea`, `32515278be92347635081bac76cf1766bb563189`, and `423879917c74cce21ccafa606279cc0511d4da91`.
- All user-scoped writes use `withUserMutation`; all approved cacheable reads include current user revision in their key.
- Routes contain no SQL, bigint serialization, string-coded error branching, or unsafe Hono context casts.
- Add each module's OpenAPI operations at the same time as its route tests.
- Put focused unit and route tests in a `tests/` child directory of the source component or domain they exercise. Keep database and cross-domain tests under `tests/integration/<domain>`, and keep repository-level `tests/build`, `tests/contract`, and `tests/support` at their current paths.
- Run and commit each task independently.

---

### Task 1: Shared money, time, pagination, ownership, and module registration

**Files:**

- Create: `src/shared/money/money.ts`
- Create: `src/shared/money/tests/money.test.ts`
- Create: `src/shared/time/date.ts`
- Create: `src/shared/time/tests/date.test.ts`
- Create: `src/shared/pagination/cursor.ts`
- Create: `src/shared/pagination/tests/cursor.test.ts`
- Create: `src/shared/ownership/ownership.service.ts`
- Create: `src/shared/ai/index.ts`
- Create: `src/app/register-modules.ts`
- Modify: `src/app/create-http-app.ts`
- Move: `src/app/create-http-app.test.ts` -> `src/app/tests/create-http-app.test.ts`
- Move: `src/app/create-worker.test.ts` -> `src/app/tests/create-worker.test.ts`
- Move: `src/entrypoints/api.test.ts` -> `src/entrypoints/tests/api.test.ts`
- Move: `src/entrypoints/entrypoint-imports.test.ts` -> `src/entrypoints/tests/entrypoint-imports.test.ts`
- Move: `src/entrypoints/root-drivers.test.ts` -> `src/entrypoints/tests/root-drivers.test.ts`
- Move: `src/entrypoints/worker.test.ts` -> `src/entrypoints/tests/worker.test.ts`
- Move: `src/modules/health/health.routes.test.ts` -> `src/modules/health/tests/health.routes.test.ts`
- Move: `src/platform/auth/clerk-auth.test.ts` -> `src/platform/auth/tests/clerk-auth.test.ts`
- Move: `src/platform/auth/user-identity.repository.test.ts` -> `src/platform/auth/tests/user-identity.repository.test.ts`
- Move: `src/platform/cache/response-cache.test.ts` -> `src/platform/cache/tests/response-cache.test.ts`
- Move: `src/platform/cache/user-revisions.test.ts` -> `src/platform/cache/tests/user-revisions.test.ts`
- Move: `src/platform/config/env.test.ts` -> `src/platform/config/tests/env.test.ts`
- Move: `src/platform/errors/error-handler.test.ts` -> `src/platform/errors/tests/error-handler.test.ts`
- Move: `src/platform/http/shutdown.test.ts` -> `src/platform/http/tests/shutdown.test.ts`
- Move: `src/platform/logging/logger.test.ts` -> `src/platform/logging/tests/logger.test.ts`
- Move: `src/platform/logging/redaction.test.ts` -> `src/platform/logging/tests/redaction.test.ts`
- Move: `src/platform/openapi/docs.routes.test.ts` -> `src/platform/openapi/tests/docs.routes.test.ts`
- Modify: `tests/contract/source-route-manifest.json`
- Modify: `tests/contract/source-test-manifest.json`
- Modify: `tests/contract/source-inventory.test.ts`
- Create: `scripts/verify-supplemental-source.mjs`
- Create: `scripts/tests/verify-supplemental-source.test.ts`

**Interfaces:**

- Produces `centsToWire(value: bigint | null): string | null`, `wireToCents(value: string): bigint`, `toIso(value: Date | null): string | null`.
- Produces `encodeCursor(value: CursorValue): string` and `decodeCursor(value: string): CursorValue` with typed `BadCursorError`.
- Produces `requireOwnedCategory`, `requireOwnedAccount`, and `requireOwnedHouseholdMember` services using injected repositories.
- Produces `registerModules(app, deps): void` as the only app-level module mount point.
- Preserves the unused-but-owned `packages/shared-logic/src/ai/index.ts` as `src/shared/ai/index.ts` so backend code is not lost during source archival.

- [ ] **Step 1: Relocate existing focused tests without changing behavior**

Move the 17 existing `src/**/*.test.ts` files listed above into component-local `tests/` directories, update only their relative imports, and keep filenames intact. Do not move or further nest repository-level build, contract, integration, or support tests. Run `pnpm test` and require the existing baseline of 20 files and 146 tests to remain green before adding behavior.

- [ ] **Step 2: Extend the immutable route inventory**

Retain `sourceCommit` at the original pin in both source manifests and add a `supplementalCommits: string[]` containing the three full SHAs in their exact order. Add `DELETE /accounts/:accountId` as the sole additive canonical route. In the test manifest, add a unique `supplementalTestFiles` array with `{ path, change, sourceCommits }` entries: record `apps/api/src/repos/accounts.test.ts` as `modified` by `ca000fb` and `3251527`, and `apps/api/src/services/accounts.test.ts` as `added` by `4238799`, without duplicating the base account-repository path in `apiFiles`. Update the inventory assertion from 54 to 55 and assert the exact supplemental metadata so later movement cannot silently absorb unrelated source `HEAD` changes.

`verify-supplemental-source.mjs` verifies that all three objects exist, the base is an ancestor of `ca000fb`, `3251527` is the direct child of `ca000fb`, and `4238799` is the direct child of `3251527`. It rejects any per-commit changed path outside the exact accounts route/service/repository/test allowlist and verifies the expected added-versus-modified file status. Its focused tests build temporary Git fixtures that prove an unknown SHA, wrong parent, extra path, or wrong change status fails closed. Run it against `/Users/samdiga/code/centsible-claude` before extracting each approved commit's patch; never copy the intervening mobile commit or source `HEAD` wholesale.

The exact per-commit path sets are:

- `ca000fb`: modified `apps/api/src/repos/accounts.ts` and `apps/api/src/repos/accounts.test.ts`.
- `3251527`: modified `apps/api/src/repos/accounts.ts` and `apps/api/src/repos/accounts.test.ts`.
- `4238799`: modified `apps/api/src/routes/accounts.ts` and `apps/api/src/repos/accounts.ts`; added `apps/api/src/services/accounts.ts` and `apps/api/src/services/accounts.test.ts`.

- [ ] **Step 3: Write failing primitive tests**

```ts
expect(centsToWire(0n)).toBe("0");
expect(centsToWire(-125n)).toBe("-125");
expect(() => wireToCents("1.25")).toThrow(ValidationError);
expect(
  decodeCursor(encodeCursor({ date: "2026-08-31", id: crypto.randomUUID() })),
).toEqual(value);
expect(() => decodeCursor("not-base64")).toThrow(BadCursorError);
```

- [ ] **Step 4: Run and confirm failure**

Run: `pnpm test src/shared`

Expected: FAIL because shared primitives are missing.

- [ ] **Step 5: Lift exact source behavior and narrow it**

Move `packages/shared-types/src/money.ts`, `apps/api/src/lib/cursor.ts`, and `apps/api/src/services/ownership.ts` into the listed targets. Copy `packages/shared-logic/src/ai/index.ts` to `src/shared/ai/index.ts` and export it only from that boundary. Keep only backend-used exports elsewhere, preserve cursor wire encoding, and translate source `ValidationError` use to the platform error classes.

- [ ] **Step 6: Add empty module registration and verify**

Mount health through `registerModules`; later tasks add one explicit import and route call each. Run:

```bash
pnpm test src/shared
pnpm test scripts/tests/verify-supplemental-source.test.ts tests/contract/source-inventory.test.ts
node scripts/verify-supplemental-source.mjs /Users/samdiga/code/centsible-claude
pnpm typecheck
git add src/shared src/app src/entrypoints src/modules/health src/platform tests/contract scripts
git commit -m "refactor: organize tests and add shared primitives"
```

### Task 2: Categories domain

**Files:**

- Create: `src/modules/categories/categories.schemas.ts`
- Create: `src/modules/categories/categories.repository.ts`
- Create: `src/modules/categories/categories.service.ts`
- Create: `src/modules/categories/categories.mapper.ts`
- Create: `src/modules/categories/categories.routes.ts`
- Create: `src/modules/categories/tests/categories.routes.test.ts`
- Create: `src/modules/categories/tests/categories.service.test.ts`
- Create: `tests/integration/categories/categories.repository.test.ts`
- Create: `src/modules/categories/index.ts`
- Modify: `src/app/register-modules.ts`

**Interfaces:**

- Produces `listCategories(userId)`, `createCategory(userId, input)`, `updateCategory(userId, id, input)`, and `archiveCategory(userId, id)`.
- Registers `GET /categories`, `POST /categories`, `PATCH /categories/:id`, and `DELETE /categories/:id`.

- [ ] **Step 1: Write failing route-contract tests**

```ts
expect(await authenticatedJson(app, "GET", "/categories")).toMatchObject({
  categories: expect.any(Array),
});
expect(
  (await authenticatedRequest(app, "POST", "/categories", validCategory))
    .status,
).toBe(201);
expect(
  await errorCode(app, "PATCH", `/categories/${missingId}`, validPatch),
).toBe("NOT_FOUND");
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/modules/categories`

Expected: FAIL with unregistered routes.

- [ ] **Step 3: Lift and refactor the complete slice**

Move source `routes/categories.ts`, `services/categories/index.ts`, `repos/categories.ts`, shared category schemas/icons, and their tests. Put all wire conversion in the mapper, use typed not-found errors, preserve global-versus-user category rules, and wrap create/update/archive in `withUserMutation`.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test src/modules/categories
pnpm exec vitest run tests/integration/categories --no-file-parallelism
pnpm typecheck
git add src/modules/categories src/app/register-modules.ts tests/integration/categories
git commit -m "feat: migrate categories domain"
```

### Task 3: Accounts domain

**Files:**

- Create: `src/modules/accounts/accounts.schemas.ts`
- Create: `src/modules/accounts/accounts.repository.ts`
- Create: `src/modules/accounts/accounts.service.ts`
- Create: `src/modules/accounts/accounts.mapper.ts`
- Create: `src/modules/accounts/accounts.routes.ts`
- Create: `src/modules/accounts/accounts-item-unlinker.ts`
- Create: `src/modules/accounts/tests/accounts.routes.test.ts`
- Create: `src/modules/accounts/tests/accounts.repository.test.ts`
- Create: `src/modules/accounts/tests/accounts.service.test.ts`
- Create: `tests/integration/accounts/accounts.repository.test.ts`
- Create: `src/modules/accounts/index.ts`
- Modify: `src/app/register-modules.ts`

**Interfaces:**

- Produces `listAccountSummaries(userId)`, `refreshAccountBalance(userId, accountId)`, `removeAccount(userId, accountId)`, and a Plaid-sync-facing `upsertFromPlaid` repository operation; refresh and item unlink implementations are injected until Plan 3 supplies Plaid.
- Defines the narrow `ActiveItemUnlinker.unlinkActiveItem({ userId, itemId }): Promise<boolean>` port. Plan 2 owns the last-live-account decision and stable result; Plan 3 owns active-item validation, token decryption, Plaid `/item/remove`, and local item cleanup behind the adapter. `true` means the local item transitioned to disconnected; it does not guarantee the best-effort upstream revoke succeeded.
- Registers `GET /accounts`, `POST /accounts/:accountId/refresh-balance`, and `DELETE /accounts/:accountId`.

- [ ] **Step 1: Write the failing wire-format test**

```ts
expect(account).toMatchObject({
  currentBalance: "12345",
  availableBalance: null,
  lastSyncAt: expect.stringMatching(/Z$/),
  plaidItem: { id: expect.any(String), status: expect.any(String) },
});
expect(JSON.stringify(account)).not.toContain("12345n");
expect(await removeAccount(userId, accountId)).toEqual({
  removed: true,
  unlinkedItem: true,
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/modules/accounts`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Lift the source account repository/route and map honestly**

Move `repos/accounts.ts`, `routes/accounts.ts`, shared account schemas, and tests from the base pin, then apply only the three approved supplemental account patches. Replace the source response-schema bigint mismatch with a wire schema whose balances are `string | null`. Cache `GET /accounts` for five minutes by user revision. Refresh and delete are writes and run through `withUserMutation`.

The repository must preserve an existing account UUID and transactions when a relink points it to a different live item. Same-item routine sync preserves an intentional `deletedAt`; a different-item relink clears it. Soft delete is tenant-scoped and idempotent at the repository boundary. The route maps missing, other-user, and already-removed accounts to the same stable `404 NOT_FOUND` envelope and returns `{ ok: true, unlinkedItem }` on success.

After the local delete commits, call the injected unlink port only when the deleted account was the last live account for its item; the adapter verifies that the item is active. Plaid unlink is best effort: log a safe failure and retain the local removal. Serialize concurrent delete-and-count decisions with a user/item-scoped database lock inside the mutation transaction so only the transition to zero live accounts requests unlink; the adapter itself must also be idempotent. Add isolated-Neon cases for preserved transaction history, same-item removal survival, different-item restoration, wrong-user access, repeated deletion, concurrent deletions, and last-account unlinking.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test src/modules/accounts
pnpm exec vitest run tests/integration/accounts --no-file-parallelism
pnpm format:check
pnpm lint
pnpm typecheck
git add src/modules/accounts src/app/register-modules.ts tests/integration/accounts
git commit -m "feat: migrate accounts domain"
```

### Task 4: Transactions domain

**Files:**

- Create: `src/modules/transactions/transactions.schemas.ts`
- Create: `src/modules/transactions/transactions.repository.ts`
- Create: `src/modules/transactions/transactions.service.ts`
- Create: `src/modules/transactions/transactions.mapper.ts`
- Create: `src/modules/transactions/transactions.routes.ts`
- Create: `src/modules/transactions/tests/transactions.routes.test.ts`
- Create: `src/modules/transactions/tests/transactions.repository.test.ts`
- Create: `src/modules/transactions/tests/transactions.service.test.ts`
- Create: `src/modules/transactions/tests/transactions.export.test.ts`
- Create: `tests/integration/transactions/transactions.repository.test.ts`
- Create: `src/modules/transactions/index.ts`
- Modify: `src/app/register-modules.ts`

**Interfaces:**

- Produces list/detail/bulk-patch/patch/export services and opaque keyset pages.
- Registers all five transaction handlers from the manifest.

- [ ] **Step 1: Write failing pagination and error tests**

```ts
expect(firstPage.transactions).toHaveLength(2);
expect(firstPage.nextCursor).toEqual(expect.any(String));
expect(
  new Set([...firstPage.transactions, ...secondPage.transactions]).size,
).toBe(4);
expect(await errorCode(app, "GET", "/transactions?cursor=bad")).toBe(
  "BAD_CURSOR",
);
expect(await errorCode(app, "PATCH", `/transactions/${id}`, {})).toBe(
  "BAD_REQUEST",
);
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/modules/transactions`

Expected: FAIL with missing route/service exports.

- [ ] **Step 3: Lift repository, patch, bulk, export, schemas, and tests**

Move source `repos/transactions.ts`, `services/transactions/{patch,bulk,export}.ts`, `routes/transactions.ts`, and shared transaction files. Replace `Error('NOT_FOUND')`, `Error('EMPTY_PATCH')`, and `Error('UNAUTHORIZED')` with typed domain errors. Preserve CSV headers and truncation header. Cache only the first un-cursored list page; never cache CSV or later cursor pages. Bulk and patch use `withUserMutation` once per committed operation.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test src/modules/transactions
pnpm exec vitest run tests/integration/transactions --no-file-parallelism
pnpm typecheck
git add src/modules/transactions src/app/register-modules.ts tests/integration/transactions
git commit -m "feat: migrate transactions domain"
```

### Task 5: Dashboard and reports read domains

**Files:**

- Create: `src/modules/dashboard/dashboard.repository.ts`
- Create: `src/modules/dashboard/dashboard.service.ts`
- Create: `src/modules/dashboard/net-worth.ts`
- Create: `src/modules/dashboard/dashboard.schemas.ts`
- Create: `src/modules/dashboard/dashboard.routes.ts`
- Create: `src/modules/dashboard/tests/dashboard.routes.test.ts`
- Create: `src/modules/dashboard/tests/net-worth.test.ts`
- Create: `src/modules/reports/reports.repository.ts`
- Create: `src/modules/reports/reports.service.ts`
- Create: `src/modules/reports/reports.schemas.ts`
- Create: `src/modules/reports/reports.routes.ts`
- Create: `src/modules/reports/tests/reports.service.test.ts`
- Create: `tests/integration/dashboard/dashboard.repository.test.ts`
- Create: `tests/integration/reports/reports.repository.test.ts`
- Modify: `src/app/register-modules.ts`

**Interfaces:**

- Registers `GET /dashboard/summary` and `GET /reports/summary`.
- Produces five-minute cached results keyed by user revision and normalized report query.

- [ ] **Step 1: Write failing aggregate tests**

```ts
expect(summary).toMatchObject({
  netWorth: expect.stringMatching(/^-?\d+$/),
  safeToSpend: expect.stringMatching(/^-?\d+$/),
  upcomingBills: expect.any(Array),
});
expect(report.type).toBe("income_vs_spending");
expect(report.months[0]).toMatchObject({
  incomeCents: expect.any(String),
  spendingCents: expect.any(String),
});
```

- [ ] **Step 2: Lift and refactor the exact sources**

Move dashboard route/repository/service, reports route/repository/service, shared dashboard/report schemas, and `shared-logic/net-worth`. Keep independent DB calls under `Promise.all`, include the calendar date in dashboard cache keys, and remove the duplicate legacy `services/netWorth.ts` after its tests map to `dashboard/tests/net-worth.test.ts`.

- [ ] **Step 3: Verify and commit**

```bash
pnpm test src/modules/dashboard src/modules/reports
pnpm exec vitest run tests/integration/dashboard tests/integration/reports --no-file-parallelism
git add src/modules/dashboard src/modules/reports src/app/register-modules.ts tests/integration/dashboard tests/integration/reports
git commit -m "feat: migrate dashboard and reports"
```

### Task 6: Bills domain and recurring aliases

**Files:**

- Create: `src/modules/bills/bills.schemas.ts`
- Create: `src/modules/bills/bills.repository.ts`
- Create: `src/modules/bills/bill-occurrences.repository.ts`
- Create: `src/modules/bills/bills.service.ts`
- Create: `src/modules/bills/recurring-engine.ts`
- Create: `src/modules/bills/statement-bills.ts`
- Create: `src/modules/bills/bills.mapper.ts`
- Create: `src/modules/bills/bills.routes.ts`
- Create: `src/modules/bills/tests/bills.routes.test.ts`
- Create: `src/modules/bills/tests/bills.service.test.ts`
- Create: `src/modules/bills/tests/recurring-engine.test.ts`
- Create: `tests/integration/bills/bills.repository.test.ts`
- Create: `src/modules/bills/index.ts`
- Modify: `src/app/register-modules.ts`

**Interfaces:**

- Registers the nine `/bills` handlers and the same router at `/recurring`.
- Produces a `BillJobDispatcher` interface for detect/materialize jobs supplied by Plan 3.

- [ ] **Step 1: Write failing alias and occurrence tests**

```ts
expect(await json(app, "/bills")).toEqual(await json(app, "/recurring"));
expect(
  (await request(app, "GET", "/recurring")).headers.get("deprecation"),
).toBe("true");
expect(
  await errorCode(
    app,
    "POST",
    `/bills/${id}/occurrences/${missing}/mark-paid`,
    paidBody,
  ),
).toBe("NOT_FOUND");
expect(
  await errorStatus(app, "POST", `/bills/${id}/occurrences/${paid}/skip`),
).toBe(409);
```

- [ ] **Step 2: Lift the complete bills slice**

Move source bills route, `services/billSetup`, bill setup/occurrence repositories, shared bills schemas/tests, and `shared-logic/recurring`. Preserve newest-first occurrence history, manual setup behavior, statement detection, cadence/date rules, and write/audit semantics. Replace result-reason JSON branches with typed not-found/conflict errors. Cache list/detail/history; invalidate on every create/update/delete/mark-paid/skip.

- [ ] **Step 3: Verify and commit**

```bash
pnpm test src/modules/bills
pnpm exec vitest run tests/integration/bills --no-file-parallelism
git add src/modules/bills src/app/register-modules.ts tests/integration/bills
git commit -m "feat: migrate bills and recurring aliases"
```

### Task 7: Budgets domain

**Files:**

- Create: `src/modules/budgets/budgets.schemas.ts`
- Create: `src/modules/budgets/budgets.repository.ts`
- Create: `src/modules/budgets/budgets.service.ts`
- Create: `src/modules/budgets/budget-calculations.ts`
- Create: `src/modules/budgets/budgets.mapper.ts`
- Create: `src/modules/budgets/budgets.routes.ts`
- Create: `src/modules/budgets/tests/budgets.routes.test.ts`
- Create: `src/modules/budgets/tests/budget-calculations.test.ts`
- Create: `tests/integration/budgets/budgets.repository.test.ts`
- Modify: `src/app/register-modules.ts`

**Interfaces:** Registers all seven budget handlers and returns wire money strings.

- [ ] **Step 1: Write failing active-budget and mutation tests**

```ts
expect(await errorCode(app, "GET", "/budgets/active")).toBe("NOT_FOUND");
expect(created.status).toBe(201);
expect(progress.progress.spentCents).toMatch(/^-?\d+$/);
expect(revisionAfterDelete).toBeGreaterThan(revisionBeforeDelete);
```

- [ ] **Step 2: Lift source budgets code and shared calculations**

Move budgets route/repository/service, budget schemas, and `shared-logic/budgets`. Keep replacement atomic, validate ownership before writes, use typed not-found errors, cache suggestions/active/progress, and invalidate after all four write handlers.

- [ ] **Step 3: Verify and commit**

```bash
pnpm test src/modules/budgets
pnpm exec vitest run tests/integration/budgets --no-file-parallelism
git add src/modules/budgets src/app/register-modules.ts tests/integration/budgets
git commit -m "feat: migrate budgets domain"
```

### Task 8: Forecast domain

**Files:**

- Create: `src/modules/forecast/forecast.schemas.ts`
- Create: `src/modules/forecast/forecast.repository.ts`
- Create: `src/modules/forecast/forecast-events.repository.ts`
- Create: `src/modules/forecast/forecast.service.ts`
- Create: `src/modules/forecast/engine/`
- Create: `src/modules/forecast/forecast.mapper.ts`
- Create: `src/modules/forecast/forecast.routes.ts`
- Create: `src/modules/forecast/tests/forecast.routes.test.ts`
- Create: `src/modules/forecast/engine/tests/*.test.ts`
- Create: `tests/integration/forecast/forecast.repository.test.ts`
- Modify: `src/app/register-modules.ts`

**Interfaces:** Registers `GET /forecast` and `GET /forecast/accuracy`; cache key includes revision, horizon, date, timezone, and algorithm version.

- [ ] **Step 1: Write failing contract and cache tests**

```ts
expect(await errorCode(app, "GET", "/forecast?horizonDays=15")).toBe(
  "VALIDATION",
);
expect(
  await errorCode(app, "GET", "/forecast?horizonDays=30", disabledUser),
).toBe("FEATURE_DISABLED");
expect(forecast.days[0].p50Cents).toMatch(/^-?\d+$/);
expect(generateForecast).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Lift source forecast engine, schemas, repositories, service, and tests**

Move all `shared-logic/forecast` files, route/feature-flag access, forecast repositories, and accuracy behavior. Preserve horizons `14|30|60|90`, algorithm version, event serialization, and background run persistence. Replace fire-and-forget persistence with an explicitly caught/logged task or awaited persistence according to existing latency tests.

- [ ] **Step 3: Verify and commit**

```bash
pnpm test src/modules/forecast
pnpm exec vitest run tests/integration/forecast --no-file-parallelism
git add src/modules/forecast src/app/register-modules.ts tests/integration/forecast
git commit -m "feat: migrate forecast domain"
```

### Task 9: Rules domain and categorization engine

**Files:**

- Create: `src/modules/rules/rules.schemas.ts`
- Create: `src/modules/rules/rules.repository.ts`
- Create: `src/modules/rules/rules.service.ts`
- Create: `src/modules/rules/categorization.ts`
- Create: `src/modules/rules/retroactive.ts`
- Create: `src/modules/rules/rules.mapper.ts`
- Create: `src/modules/rules/rules.routes.ts`
- Create: `src/modules/rules/tests/rules.routes.test.ts`
- Create: `src/modules/rules/tests/categorization.test.ts`
- Create: `src/modules/rules/tests/retroactive.test.ts`
- Create: `tests/integration/rules/rules.repository.test.ts`
- Modify: `src/app/register-modules.ts`

**Interfaces:** Registers five rule handlers and produces `RuleJobDispatcher.dispatchRetroactive(ruleId, userId)` for Plan 3.

- [ ] **Step 1: Write failing priority and ownership tests**

```ts
expect(matchRules(transaction, orderedRules)?.id).toBe(highestPriority.id);
expect(await errorCode(app, "PATCH", `/rules/${otherUsersRule}`, patch)).toBe(
  "NOT_FOUND",
);
expect(created.retroactiveJobId).toEqual(expect.any(String));
```

- [ ] **Step 2: Lift rules and categorization sources**

Move rules route/repository/service/retroactive files, shared rule schemas, and `shared-logic/categorization`. Preserve stable priority ordering, amount boundaries, ownership, active flags, application counts, and retroactive batching. Use typed errors and `withUserMutation` for create/update/delete.

- [ ] **Step 3: Verify and commit**

```bash
pnpm test src/modules/rules
pnpm exec vitest run tests/integration/rules --no-file-parallelism
git add src/modules/rules src/app/register-modules.ts tests/integration/rules
git commit -m "feat: migrate rules domain"
```

### Task 10: Notification preferences domain

**Files:**

- Create: `src/modules/notifications/notifications.schemas.ts`
- Create: `src/modules/notifications/notifications.repository.ts`
- Create: `src/modules/notifications/notifications.service.ts`
- Create: `src/modules/notifications/bill-schedule.ts`
- Create: `src/modules/notifications/notifications.routes.ts`
- Create: `src/modules/notifications/tests/notifications.routes.test.ts`
- Create: `src/modules/notifications/tests/bill-schedule.test.ts`
- Create: `tests/integration/notifications/notifications.repository.test.ts`
- Modify: `src/app/register-modules.ts`

**Interfaces:** Registers `GET/PATCH /notifications/preferences`; scheduler-facing bill timing remains a pure exported function.

- [ ] **Step 1: Write failing default and quiet-hours tests**

```ts
expect(preferences).toMatchObject({
  billRemindersEnabled: expect.any(Boolean),
});
expect(
  nextReminder({
    dueDate: "2026-09-05",
    daysAhead: 2,
    timezone: "America/New_York",
  }),
).toBe(expectedInstant);
```

- [ ] **Step 2: Lift preference repository/route and shared notification logic**

Preserve get-or-create defaults, quiet-hour fields, timezone-safe scheduling, and response shape. PATCH uses `withUserMutation`; GET uses the five-minute cache.

- [ ] **Step 3: Verify and commit**

```bash
pnpm test src/modules/notifications
pnpm exec vitest run tests/integration/notifications --no-file-parallelism
git add src/modules/notifications src/app/register-modules.ts tests/integration/notifications
git commit -m "feat: migrate notification preferences"
```

### Task 11: User export, import, reset, audit, and retention repositories

**Files:**

- Create: `src/modules/user-data/user-data.schemas.ts`
- Create: `src/modules/user-data/user-data.repository.ts`
- Create: `src/modules/user-data/user-data.service.ts`
- Create: `src/modules/user-data/user-data.routes.ts`
- Create: `src/modules/user-data/tests/user-data.routes.test.ts`
- Create: `src/modules/user-data/tests/user-data.service.test.ts`
- Create: `src/platform/database/audit-log.repository.ts`
- Create: `src/platform/database/tests/audit-log.repository.test.ts`
- Create: `tests/integration/user-data/user-data.repository.test.ts`
- Modify: `src/app/register-modules.ts`

**Interfaces:** Registers `GET /user/export`, `POST /user/import`, and `DELETE /user/data`; produces bounded 5,000-row export pages and atomic import/reset operations.

- [ ] **Step 1: Write failing streaming and atomicity tests**

```ts
expect(response.headers.get("content-type")).toContain("application/json");
expect(JSON.parse(await response.text()).transactions).toHaveLength(5_001);
await expect(importInvalidBackup()).rejects.toThrow(ValidationError);
expect(await countUserRows()).toBe(beforeCount);
expect(await getUserRevision(userId)).toBe(revisionBefore);
```

- [ ] **Step 2: Lift source user-data and audit repositories**

Move `routes/user.ts`, `services/userData.ts`, `repos/userData.ts`, `repos/auditLog.ts`, and shared backup schemas. Preserve streaming JSON assembly, 5,000-row pages, version validation, reference integrity, reset ordering, and rollback. Import/reset increment revision once after the transaction and then clear all user cache entries. Exports are never cached.

- [ ] **Step 3: Verify and commit**

```bash
pnpm test src/modules/user-data src/platform/database/tests/audit-log.repository.test.ts
pnpm exec vitest run tests/integration/user-data --no-file-parallelism
pnpm format:check
pnpm lint
pnpm typecheck
git add src/modules/user-data src/platform/database src/app/register-modules.ts tests/integration/user-data
git commit -m "feat: migrate user data lifecycle"
```

## Plan 2 Completion Gate

- [ ] Plan 1 health plus Plan 2 domains expose exactly 43 canonical local operations; the remaining 11 local operations belong to Plan 3 and the webhook is relocated in Plan 4, for 55 canonical behaviors total.
- [ ] `/recurring` exposes all nine bills aliases with deprecation metadata.
- [ ] No module imports another module's internal file; cross-domain calls use exported interfaces.
- [ ] Every successful user-scoped write increments revision and evicts cache.
- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, and `pnpm test:dist` pass.
