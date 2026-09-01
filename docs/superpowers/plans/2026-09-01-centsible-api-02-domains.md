# Centsible API Domain Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every non-Plaid, non-pipeline API capability into independently testable domain slices while preserving Swift contracts and all `/bills` and `/recurring` behavior.

**Architecture:** Each module owns HTTP schemas, routes, service behavior, repository access, wire mappers, errors, and focused tests. Shared primitives are limited to money, time, pagination, ownership checks, and route registration.

**Tech Stack:** TypeScript, Hono OpenAPI routes, Zod, Drizzle, Neon Postgres, Vitest, the platform interfaces produced by Plan 1.

**Spec:** `docs/superpowers/specs/2026-09-01-centsible-api-migration-design.md`

## Global Constraints

- Complete Plan 1 first and use its `AppEnv`, error handler, DB, cache, revision, OpenAPI, and app-factory interfaces.
- Preserve method, path, success status, success body, money string, timestamp, cursor, and nullability behavior from pinned source commit `06d3972a7ffc88b6c65a4bab4ad47487e55b800c`.
- All user-scoped writes use `withUserMutation`; all approved cacheable reads include current user revision in their key.
- Routes contain no SQL, bigint serialization, string-coded error branching, or unsafe Hono context casts.
- Add each module's OpenAPI operations at the same time as its route tests.
- Run and commit each task independently.

---

### Task 1: Shared money, time, pagination, ownership, and module registration

**Files:**

- Create: `src/shared/money/money.ts`
- Create: `src/shared/money/money.test.ts`
- Create: `src/shared/time/date.ts`
- Create: `src/shared/time/date.test.ts`
- Create: `src/shared/pagination/cursor.ts`
- Create: `src/shared/pagination/cursor.test.ts`
- Create: `src/shared/ownership/ownership.service.ts`
- Create: `src/shared/ai/index.ts`
- Create: `src/app/register-modules.ts`
- Modify: `src/app/create-http-app.ts`

**Interfaces:**

- Produces `centsToWire(value: bigint | null): string | null`, `wireToCents(value: string): bigint`, `toIso(value: Date | null): string | null`.
- Produces `encodeCursor(value: CursorValue): string` and `decodeCursor(value: string): CursorValue` with typed `BadCursorError`.
- Produces `requireOwnedCategory`, `requireOwnedAccount`, and `requireOwnedHouseholdMember` services using injected repositories.
- Produces `registerModules(app, deps): void` as the only app-level module mount point.
- Preserves the unused-but-owned `packages/shared-logic/src/ai/index.ts` as `src/shared/ai/index.ts` so backend code is not lost during source archival.

- [ ] **Step 1: Write failing primitive tests**

```ts
expect(centsToWire(0n)).toBe("0");
expect(centsToWire(-125n)).toBe("-125");
expect(() => wireToCents("1.25")).toThrow(ValidationError);
expect(
  decodeCursor(encodeCursor({ date: "2026-08-31", id: crypto.randomUUID() })),
).toEqual(value);
expect(() => decodeCursor("not-base64")).toThrow(BadCursorError);
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/shared`

Expected: FAIL because shared primitives are missing.

- [ ] **Step 3: Lift exact source behavior and narrow it**

Move `packages/shared-types/src/money.ts`, `apps/api/src/lib/cursor.ts`, and `apps/api/src/services/ownership.ts` into the listed targets. Copy `packages/shared-logic/src/ai/index.ts` to `src/shared/ai/index.ts` and export it only from that boundary. Keep only backend-used exports elsewhere, preserve cursor wire encoding, and translate source `ValidationError` use to the platform error classes.

- [ ] **Step 4: Add empty module registration and verify**

Mount health through `registerModules`; later tasks add one explicit import and route call each. Run:

```bash
pnpm test src/shared
pnpm typecheck
git add src/shared src/app
git commit -m "refactor: add shared backend primitives"
```

### Task 2: Categories domain

**Files:**

- Create: `src/modules/categories/categories.schemas.ts`
- Create: `src/modules/categories/categories.repository.ts`
- Create: `src/modules/categories/categories.service.ts`
- Create: `src/modules/categories/categories.mapper.ts`
- Create: `src/modules/categories/categories.routes.ts`
- Create: `src/modules/categories/categories.routes.test.ts`
- Create: `src/modules/categories/categories.service.test.ts`
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
pnpm test:integration src/modules/categories
pnpm typecheck
git add src/modules/categories src/app/register-modules.ts
git commit -m "feat: migrate categories domain"
```

### Task 3: Accounts domain

**Files:**

- Create: `src/modules/accounts/accounts.schemas.ts`
- Create: `src/modules/accounts/accounts.repository.ts`
- Create: `src/modules/accounts/accounts.service.ts`
- Create: `src/modules/accounts/accounts.mapper.ts`
- Create: `src/modules/accounts/accounts.routes.ts`
- Create: `src/modules/accounts/accounts.routes.test.ts`
- Create: `src/modules/accounts/accounts.repository.test.ts`
- Create: `src/modules/accounts/index.ts`
- Modify: `src/app/register-modules.ts`

**Interfaces:**

- Produces `listAccountSummaries(userId)` and `refreshAccountBalance(userId, accountId)`; the refresh implementation is injected until Plan 3 supplies Plaid.
- Registers `GET /accounts` and `POST /accounts/:accountId/refresh-balance`.

- [ ] **Step 1: Write the failing wire-format test**

```ts
expect(account).toMatchObject({
  currentBalance: "12345",
  availableBalance: null,
  lastSyncAt: expect.stringMatching(/Z$/),
  plaidItem: { id: expect.any(String), status: expect.any(String) },
});
expect(JSON.stringify(account)).not.toContain("12345n");
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/modules/accounts`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Lift the source account repository/route and map honestly**

Move `repos/accounts.ts`, `routes/accounts.ts`, shared account schemas, and tests. Replace the source response-schema bigint mismatch with a wire schema whose balances are `string | null`. Cache `GET /accounts` for five minutes by user revision. A refresh is a write: after the injected Plaid call succeeds, increment revision and evict the user.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test src/modules/accounts
pnpm test:integration src/modules/accounts
git add src/modules/accounts src/app/register-modules.ts
git commit -m "feat: migrate accounts domain"
```

### Task 4: Transactions domain

**Files:**

- Create: `src/modules/transactions/transactions.schemas.ts`
- Create: `src/modules/transactions/transactions.repository.ts`
- Create: `src/modules/transactions/transactions.service.ts`
- Create: `src/modules/transactions/transactions.mapper.ts`
- Create: `src/modules/transactions/transactions.routes.ts`
- Create: `src/modules/transactions/transactions.routes.test.ts`
- Create: `src/modules/transactions/transactions.repository.test.ts`
- Create: `src/modules/transactions/transactions.service.test.ts`
- Create: `src/modules/transactions/transactions.export.test.ts`
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
pnpm test:integration src/modules/transactions
pnpm typecheck
git add src/modules/transactions src/app/register-modules.ts
git commit -m "feat: migrate transactions domain"
```

### Task 5: Dashboard and reports read domains

**Files:**

- Create: `src/modules/dashboard/dashboard.repository.ts`
- Create: `src/modules/dashboard/dashboard.service.ts`
- Create: `src/modules/dashboard/net-worth.ts`
- Create: `src/modules/dashboard/dashboard.schemas.ts`
- Create: `src/modules/dashboard/dashboard.routes.ts`
- Create: `src/modules/dashboard/dashboard.routes.test.ts`
- Create: `src/modules/dashboard/net-worth.test.ts`
- Create: `src/modules/reports/reports.repository.ts`
- Create: `src/modules/reports/reports.service.ts`
- Create: `src/modules/reports/reports.schemas.ts`
- Create: `src/modules/reports/reports.routes.ts`
- Create: `src/modules/reports/reports.service.test.ts`
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

Move dashboard route/repository/service, reports route/repository/service, shared dashboard/report schemas, and `shared-logic/net-worth`. Keep independent DB calls under `Promise.all`, include the calendar date in dashboard cache keys, and remove the duplicate legacy `services/netWorth.ts` after its tests map to `dashboard/net-worth.test.ts`.

- [ ] **Step 3: Verify and commit**

```bash
pnpm test src/modules/dashboard src/modules/reports
pnpm test:integration src/modules/dashboard src/modules/reports
git add src/modules/dashboard src/modules/reports src/app/register-modules.ts
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
- Create: `src/modules/bills/bills.routes.test.ts`
- Create: `src/modules/bills/bills.service.test.ts`
- Create: `src/modules/bills/recurring-engine.test.ts`
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
pnpm test:integration src/modules/bills
git add src/modules/bills src/app/register-modules.ts
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
- Create: `src/modules/budgets/budgets.routes.test.ts`
- Create: `src/modules/budgets/budget-calculations.test.ts`
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
pnpm test:integration src/modules/budgets
git add src/modules/budgets src/app/register-modules.ts
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
- Create: `src/modules/forecast/forecast.routes.test.ts`
- Create: `src/modules/forecast/engine/*.test.ts`
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
pnpm test:integration src/modules/forecast
git add src/modules/forecast src/app/register-modules.ts
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
- Create: `src/modules/rules/rules.routes.test.ts`
- Create: `src/modules/rules/categorization.test.ts`
- Create: `src/modules/rules/retroactive.test.ts`
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
pnpm test:integration src/modules/rules
git add src/modules/rules src/app/register-modules.ts
git commit -m "feat: migrate rules domain"
```

### Task 10: Notification preferences domain

**Files:**

- Create: `src/modules/notifications/notifications.schemas.ts`
- Create: `src/modules/notifications/notifications.repository.ts`
- Create: `src/modules/notifications/notifications.service.ts`
- Create: `src/modules/notifications/bill-schedule.ts`
- Create: `src/modules/notifications/notifications.routes.ts`
- Create: `src/modules/notifications/notifications.routes.test.ts`
- Create: `src/modules/notifications/bill-schedule.test.ts`
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
pnpm test:integration src/modules/notifications
git add src/modules/notifications src/app/register-modules.ts
git commit -m "feat: migrate notification preferences"
```

### Task 11: User export, import, reset, audit, and retention repositories

**Files:**

- Create: `src/modules/user-data/user-data.schemas.ts`
- Create: `src/modules/user-data/user-data.repository.ts`
- Create: `src/modules/user-data/user-data.service.ts`
- Create: `src/modules/user-data/user-data.routes.ts`
- Create: `src/modules/user-data/user-data.routes.test.ts`
- Create: `src/modules/user-data/user-data.service.test.ts`
- Create: `src/platform/database/audit-log.repository.ts`
- Create: `src/platform/database/audit-log.repository.test.ts`
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
pnpm test src/modules/user-data src/platform/database/audit-log.repository.test.ts
pnpm test:integration src/modules/user-data
pnpm format:check
pnpm lint
pnpm typecheck
git add src/modules/user-data src/platform/database/audit-log.repository.ts src/platform/database/audit-log.repository.test.ts src/app/register-modules.ts
git commit -m "feat: migrate user data lifecycle"
```

## Plan 2 Completion Gate

- [ ] Plan 1 health plus Plan 2 domains expose exactly 42 canonical local operations; the remaining 11 local operations belong to Plan 3 and the webhook is relocated in Plan 4.
- [ ] `/recurring` exposes all nine bills aliases with deprecation metadata.
- [ ] No module imports another module's internal file; cross-domain calls use exported interfaces.
- [ ] Every successful user-scoped write increments revision and evicts cache.
- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, and `pnpm test:dist` pass.
