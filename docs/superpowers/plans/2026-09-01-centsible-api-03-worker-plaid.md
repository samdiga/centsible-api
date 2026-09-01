# Centsible API Worker and Plaid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate jobs, schedules, pipeline, Plaid integration, durable webhook-event processing, retries, retention, and the real worker runtime.

**Architecture:** Database-backed jobs and inbound webhook events are leased by a separately started worker. Plaid link and manual actions remain private API routes; public webhook receipt is represented by a durable event contract consumed here and implemented in Centsy by Plan 4.

**Tech Stack:** TypeScript, Hono, Drizzle/Postgres, Plaid SDK, JOSE, TweetNaCl, Pino, Vitest, Plan 1 platform and Plan 2 domains.

**Spec:** `docs/superpowers/specs/2026-09-01-centsible-api-migration-design.md`

## Global Constraints

- Complete Plans 1 and 2 first.
- Preserve source job uniqueness, Plaid cursor compare-and-set behavior, encrypted access tokens, pipeline step semantics, and private Plaid route bodies.
- Worker claims use finite leases and graceful shutdown; only one scheduler runs at cutover.
- Every worker domain write increments the user's data revision and publishes `centsible_user_data_changed`.
- Public Plaid webhook acknowledgment is not implemented in the Mac mini API.
- Retry interval is `30s × 2^(attempt-1)`, capped at one hour, with 0–25% jitter; lease is five minutes; dead after eight attempts.

---

### Task 1: Jobs repository and lease-safe poller

**Files:**

- Create: `src/platform/jobs/jobs.types.ts`
- Create: `src/platform/jobs/jobs.repository.ts`
- Create: `src/platform/jobs/jobs.repository.test.ts`
- Create: `src/platform/jobs/jobs-poller.ts`
- Create: `src/platform/jobs/jobs-poller.test.ts`
- Create: `src/platform/jobs/dispatch.ts`
- Move schema definitions into: `database/schema/jobs.ts`

**Interfaces:**

- Produces `enqueueJob(input): Promise<Job>`, `claimJobs(workerId, limit, leaseMs): Promise<Job[]>`, `completeJob(id)`, `retryJob(id, errorCode, availableAt)`, and `reapExpiredJobs(now)`.
- Produces `createJobsPoller({ handlers, pollMs, workerId }): { start(); stop(): Promise<void> }`.

- [ ] **Step 1: Write failing lease and uniqueness tests**

```ts
const [a, b] = await Promise.all([
  claimJobs("worker-a", 1, 300_000),
  claimJobs("worker-b", 1, 300_000),
]);
expect([...a, ...b]).toHaveLength(1);
expect(await enqueueSameUniqueJobTwice()).toMatchObject({ deduped: true });
await advancePastLease();
expect(await claimJobs("worker-b", 1, 300_000)).toHaveLength(1);
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/platform/jobs`

Expected: FAIL because the jobs interfaces are missing.

- [ ] **Step 3: Lift source jobs repository and poller**

Move `repos/jobs.ts`, its two test files, `workers/jobsPoller.ts`, and its tests. Preserve `FOR UPDATE SKIP LOCKED` or equivalent atomic claim behavior, unique-violation handling, terminal/retry states, stale-running reaping, handler isolation, and bounded batch size. Replace raw error text persistence with safe `errorCode`; retain full causes only in redacted logs.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test src/platform/jobs
pnpm test:integration src/platform/jobs
git add src/platform/jobs database/schema/jobs.ts
git commit -m "feat: migrate lease-safe jobs worker"
```

### Task 2: Pipeline domain and scheduler

**Files:**

- Create: `src/modules/pipeline/pipeline.schemas.ts`
- Create: `src/modules/pipeline/pipeline.repository.ts`
- Create: `src/modules/pipeline/pipeline.service.ts`
- Create: `src/modules/pipeline/pipeline.mapper.ts`
- Create: `src/modules/pipeline/pipeline.routes.ts`
- Create: `src/modules/pipeline/pipeline.routes.test.ts`
- Create: `src/modules/pipeline/pipeline.service.test.ts`
- Create: `src/modules/pipeline/index.ts`
- Create: `src/platform/jobs/scheduler.ts`
- Create: `src/platform/jobs/scheduler.test.ts`
- Modify: `src/app/register-modules.ts`

**Interfaces:**

- Registers all five `/pipeline` routes.
- Produces `startPipelineRun({ userId, trigger }): Promise<{ runId: string | null; deduped: boolean }>`.
- Produces `createScheduler({ schedules, enqueue, clock }): { start(); stop(): Promise<void> }`.

- [ ] **Step 1: Write failing pipeline and timezone tests**

```ts
expect((await triggerTwice(userId)).map((x) => x.deduped)).toEqual([
  false,
  true,
]);
expect(
  await errorCode(app, "PUT", "/pipeline/schedule", {
    ...valid,
    timezone: "Mars/Olympus",
  }),
).toBe("VALIDATION");
expect(run.steps.map((step) => step.step)).toEqual(expectedPipelineSteps);
```

- [ ] **Step 2: Lift and refactor pipeline/scheduler sources**

Move `routes/pipeline.ts`, `services/pipeline/index.ts`, `repos/pipeline.ts`, shared pipeline schemas, `workers/scheduler.ts`, and their tests. Preserve schedule key `daily_sync_pipeline`, default 06:00 UTC disabled schedule, active-run conflict status 409, step ordering, retention schedule, and forecast-accuracy schedule. Replace repository imports with the module interface and use typed validation/not-found errors.

- [ ] **Step 3: Wire Plan 2 job dispatcher interfaces**

Provide `BillJobDispatcher` and `RuleJobDispatcher` adapters through `platform/jobs/dispatch.ts`, mapping source job names exactly. Do not import platform job internals from bills or rules; inject their exported dispatcher interfaces during app composition.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test src/modules/pipeline src/platform/jobs/scheduler.test.ts
pnpm test:integration src/modules/pipeline
git add src/modules/pipeline src/platform/jobs src/app/register-modules.ts
git commit -m "feat: migrate pipeline and scheduler"
```

### Task 3: Plaid client, encryption, link, balances, and private routes

**Files:**

- Create: `src/modules/plaid/plaid.schemas.ts`
- Create: `src/modules/plaid/plaid.client.ts`
- Create: `src/modules/plaid/plaid.crypto.ts`
- Create: `src/modules/plaid/plaid.errors.ts`
- Create: `src/modules/plaid/plaid-items.repository.ts`
- Create: `src/modules/plaid/plaid-link.service.ts`
- Create: `src/modules/plaid/plaid-balance.service.ts`
- Create: `src/modules/plaid/plaid-item-removal.service.ts`
- Create: `src/modules/plaid/plaid.mapper.ts`
- Create: `src/modules/plaid/plaid.routes.ts`
- Create: `src/modules/plaid/plaid.routes.test.ts`
- Create: `src/modules/plaid/plaid.crypto.test.ts`
- Create: `src/modules/plaid/plaid-link.service.test.ts`
- Create: `src/modules/plaid/plaid-balance.service.test.ts`
- Create: `src/modules/plaid/index.ts`
- Modify: `src/modules/accounts/index.ts`
- Modify: `src/app/register-modules.ts`

**Interfaces:**

- Registers six private Plaid routes; it does not register `POST /plaid/webhook`.
- Produces `createLinkToken`, `exchangePublicToken`, `createUpdateLinkToken`, `refreshItemBalances`, `refreshSingleAccount`, and `unlinkItem`.

- [ ] **Step 1: Write failing auth, crypto, and route tests**

```ts
expect((await app.request("/plaid/items")).status).toBe(401);
expect(decryptAccessToken(encryptAccessToken("access-sandbox-token"))).toBe(
  "access-sandbox-token",
);
expect(await exchangePublicToken(userId, token, institution)).toMatchObject({
  itemId: expect.any(String),
});
expect(await errorCode(app, "DELETE", `/plaid/items/${otherUsersItem}`)).toBe(
  "NOT_FOUND",
);
```

- [ ] **Step 2: Lift the private Plaid slice**

Move source Plaid client, crypto, error/types, link, balance, liabilities helper, item removal, Plaid item repository, shared Plaid schemas, and private route handlers. Preserve encryption format compatibility so existing encrypted Neon tokens remain readable. Preserve safe Plaid error mapping and account/balance money conversion. Connect the accounts refresh adapter to `refreshSingleAccount`.

- [ ] **Step 3: Ensure every successful Plaid mutation invalidates**

Exchange, balance refresh, link repair, and unlink operations use `withUserMutation`. A failed upstream call must not increment revision or evict a still-valid cached response.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test src/modules/plaid --exclude '**/plaid-sync*'
pnpm test:integration src/modules/plaid/plaid.routes.test.ts
git add src/modules/plaid src/modules/accounts/index.ts src/app/register-modules.ts
git commit -m "feat: migrate private Plaid API"
```

### Task 4: Idempotent Plaid transaction sync and rule application

**Files:**

- Create: `src/modules/plaid/plaid-sync.service.ts`
- Create: `src/modules/plaid/plaid-sync.service.test.ts`
- Create: `src/modules/plaid/plaid-sync.integration.test.ts`
- Create: `src/modules/plaid/plaid-raw-imports.repository.ts`
- Modify: `src/modules/plaid/index.ts`
- Modify: `src/modules/pipeline/pipeline.service.ts`

**Interfaces:**

- Produces `syncPlaidItem({ userId, itemId }): Promise<SyncStats>`.
- Consumes transactions and rule public interfaces without importing their repositories directly.

- [ ] **Step 1: Write failing cursor-race tests**

```ts
await syncPlaidItem({ userId, itemId });
expect(await getStoredCursor(itemId)).toBe("cursor-page-2");
expect(await countTransactions(userId)).toBe(expectedCount);
await syncPlaidItem({ userId, itemId });
expect(await countTransactions(userId)).toBe(expectedCount);
expect(await runConcurrentSyncs()).toMatchObject({ oneAdvancedCursor: true });
```

- [ ] **Step 2: Lift source sync and raw-import behavior**

Move `services/plaid/sync.ts`, `repos/plaidRawImports.ts`, sync unit/integration tests, and liability tests. Preserve paging, added/modified/removed transaction handling, pending status, rule matching, raw import audit, and compare-and-set cursor advancement. Expose narrow transactions/rules APIs needed by sync; do not reach into their repositories.

- [ ] **Step 3: Wrap committed sync results in one revision invalidation**

The cursor and domain page changes remain atomic at the same boundaries as source behavior. Increment the user revision after a successful sync run that changes domain state, publish invalidation, and do not increment for a no-op page.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test src/modules/plaid/plaid-sync.service.test.ts
pnpm test:integration src/modules/plaid/plaid-sync.integration.test.ts
git add src/modules/plaid src/modules/pipeline
git commit -m "feat: migrate idempotent Plaid sync"
```

### Task 5: Durable inbound webhook event repository

**Files:**

- Create: `database/schema/inbound-webhook-events.ts`
- Create: `database/migrations/0008_inbound_webhook_events.sql`
- Create: `src/modules/plaid/inbound-events.types.ts`
- Create: `src/modules/plaid/inbound-events.repository.ts`
- Create: `src/modules/plaid/inbound-events.repository.test.ts`
- Create: `src/modules/plaid/inbound-event-handler.ts`
- Create: `src/modules/plaid/inbound-event-handler.test.ts`

**Interfaces:**

- Produces `claimInboundEvents(workerId, limit, leaseMs)`, `markProcessed(id)`, `scheduleRetry(id, attempt, now, random)`, `markDead(id, code)`, and `replayDeadEvent(id)`.
- Produces `handleInboundEvent(event): Promise<'processed' | 'duplicate' | 'ignored'>`.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
expect(await twoWorkersClaimOneEvent()).toEqual({ totalClaims: 1 });
expect(nextRetryAt(1, now, () => 0)).toEqual(addSeconds(now, 30));
expect(nextRetryAt(8, now, () => 1)).toEqual(addMinutes(now, 75));
expect(await failEightTimes(eventId)).toMatchObject({
  status: "dead",
  attempts: 8,
});
```

- [ ] **Step 2: Implement schema and repository**

Use every column and status from spec section 11.2. Add indexes for `(status, available_at)`, `lease_expires_at`, `provider_item_id`, and `dedupe_key`. Claim with `FOR UPDATE SKIP LOCKED`, set `processing`, increment attempts at claim, and recover expired leases. Keep every verified delivery row; do not add a permanent unique constraint on `dedupe_key`.

- [ ] **Step 3: Implement event dispatch**

Handle the existing four codes exactly: `TRANSACTIONS:SYNC_UPDATES_AVAILABLE`, `ITEM:ERROR`, `ITEM:PENDING_EXPIRATION`, and `ITEM:LOGIN_REPAIRED`. Unknown codes return `ignored` and are marked processed. Transaction updates converge through the active pipeline dedupe; item updates use `withUserMutation`.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test src/modules/plaid/inbound-event-handler.test.ts
pnpm test:integration src/modules/plaid/inbound-events.repository.test.ts
git add database/schema database/migrations/0008_inbound_webhook_events.sql src/modules/plaid
git commit -m "feat: add durable Plaid event processing"
```

### Task 6: Worker composition, retry loop, and graceful shutdown

**Files:**

- Create: `src/modules/plaid/inbound-events-poller.ts`
- Create: `src/modules/plaid/inbound-events-poller.test.ts`
- Modify: `src/app/create-worker.ts`
- Modify: `src/entrypoints/worker.ts`
- Create: `src/app/create-worker.test.ts`

**Interfaces:**

- `createWorker` composes jobs poller, scheduler, inbound-events poller, and retention scheduler.
- `WorkerRuntime.stop()` stops new claims and waits a bounded interval for active handlers.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
await worker.start();
expect(jobs.start).toHaveBeenCalledOnce();
expect(events.start).toHaveBeenCalledOnce();
await worker.stop();
expect(scheduler.stop).toHaveBeenCalledOnce();
expect(closeDb).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Implement poller and worker composition**

Poll only events with `available_at <= now` or expired leases. On success mark processed; on typed retryable error apply the exact backoff; on terminal error mark dead immediately with a safe code; on shutdown stop polling before awaiting active work. Report worker ID and build SHA without logging database URL or event payload.

- [ ] **Step 3: Verify and commit**

```bash
pnpm test src/app/create-worker.test.ts src/modules/plaid/inbound-events-poller.test.ts
pnpm build
pnpm test:dist
git add src/app/create-worker.ts src/app/create-worker.test.ts src/entrypoints/worker.ts src/modules/plaid/inbound-events-poller*
git commit -m "feat: compose local API worker runtime"
```

### Task 7: Retention and manual dead-event replay

**Files:**

- Create: `src/platform/jobs/retention.repository.ts`
- Create: `src/platform/jobs/retention.repository.test.ts`
- Create: `scripts/replay-webhook-event.ts`
- Create: `scripts/replay-webhook-event.test.ts`
- Modify: `package.json`
- Modify: `src/platform/jobs/scheduler.ts`

**Interfaces:**

- Produces `deleteExpiredOperationalData(now): Promise<RetentionCounts>`.
- Adds `pnpm webhook:replay -- <uuid>`.

- [ ] **Step 1: Write failing retention/replay tests**

```ts
expect(await retainProcessedEvent(ageDays(29))).toBe(true);
expect(await retainProcessedEvent(ageDays(31))).toBe(false);
expect(await retainDeadEvent(ageDays(89))).toBe(true);
expect(await replayProcessedEvent()).rejects.toThrow(ConflictError);
expect(await replayDeadEvent()).toMatchObject({
  status: "pending",
  attempts: 0,
});
```

- [ ] **Step 2: Lift existing retention and add event policy**

Move source `repos/retention.ts` and tests. Preserve existing audit/job/forecast/pipeline cleanup periods. Add processed-event 30-day and dead-event 90-day deletion. Replay accepts one validated UUID, requires status `dead`, clears lease/error fields, and records a structured audit log without payload.

- [ ] **Step 3: Verify and commit**

```bash
pnpm test src/platform/jobs/retention.repository.test.ts scripts/replay-webhook-event.test.ts
pnpm test:integration src/platform/jobs/retention.repository.test.ts
git add src/platform/jobs scripts/replay-webhook-event* package.json
git commit -m "feat: add event retention and replay command"
```

## Plan 3 Completion Gate

- [ ] The route manifest has 53 private/local canonical routes registered; `POST /plaid/webhook` is marked relocated, not silently missing.
- [ ] All source jobs, scheduler, pipeline, Plaid, crypto, sync, liability, and retention tests have mapped targets.
- [ ] Duplicate sync, cursor race, abandoned lease, eight-attempt dead state, replay, and cache invalidation tests pass.
- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, and `pnpm test:dist` pass.
