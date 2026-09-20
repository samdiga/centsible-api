# Configurable On-Demand Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace continuous idle database polling with immediate manual wakes and a configurable six-hour run-to-empty safety sweep.

**Architecture:** Keep API and worker entrypoints separate. The worker owns a loopback-only wake server and a single-flight sweep coordinator; manual pipeline creation sends a bounded wake after its database transaction commits. Existing repositories retain leasing, retries, dedupe, and terminal-state ownership.

**Tech Stack:** TypeScript ESM, Node HTTP/fetch, Hono, Zod, Drizzle ORM, postgres.js, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-configurable-on-demand-worker.md`

## Global Constraints

- Implementation approval does not authorize live database writes, service changes, Centsy deployment, or Task 5 cutover.
- `WORKER_SWEEP_INTERVAL_MINUTES` defaults to `360`, accepts `0`, and otherwise requires an integer from `60` through `1440`.
- `WORKER_WAKE_URL` defaults to `http://127.0.0.1:4011/wake` and must remain loopback-only HTTP without credentials, query, or fragment.
- API and worker entrypoints remain separate.
- User daily sync remains disabled by default; existing enabled schedules remain untouched.
- Work directly in the current checkout per user choice and preserve unrelated untracked files.
- Do not commit during this implementation-only pass; leave the diff available for review.

---

### Task 1: Runtime configuration and wake transport

**Files:**

- Modify: `src/platform/config/env.ts`
- Modify: `src/platform/config/tests/env.test.ts`
- Create: `src/platform/jobs/worker-wake.ts`
- Create: `src/platform/jobs/tests/worker-wake.test.ts`
- Modify: `.env.example`

**Interfaces:**

- Produces: `Env.WORKER_SWEEP_INTERVAL_MINUTES: number`
- Produces: `Env.WORKER_WAKE_URL: string`
- Produces: `createWorkerWakeClient(url, options?): () => Promise<void>`
- Produces: `createWorkerWakeServer({ url, wake, ... }): { start; stop }`

- [x] **Step 1: Write failing environment tests**

Add assertions for the `360` and loopback URL defaults, acceptance of `0`,
`60`, and `1440`, rejection of `1`, `59`, `1441`, fractions, and invalid text,
plus rejection of non-loopback/non-HTTP/credentialed/query/fragment wake URLs.

- [x] **Step 2: Run the environment tests and verify RED**

Run: `pnpm exec vitest run src/platform/config/tests/env.test.ts`

Expected: FAIL because the two worker settings do not exist.

- [x] **Step 3: Implement minimal configuration parsing**

Add a zero-or-bounded-integer schema and a loopback wake-URL schema, expose
both fields through `Env`, and document the defaults in `.env.example`.

- [x] **Step 4: Run the environment tests and verify GREEN**

Run: `pnpm exec vitest run src/platform/config/tests/env.test.ts`

Expected: PASS.

- [x] **Step 5: Write failing wake transport tests**

Test that the server binds the configured loopback address, accepts only the
configured `POST` path with `202`, rejects other methods/paths, invokes the
wake callback without awaiting full work, and closes idempotently. Test that
the client sends a bounded `POST` and rejects non-`202` responses.

- [x] **Step 6: Run wake transport tests and verify RED**

Run: `pnpm exec vitest run src/platform/jobs/tests/worker-wake.test.ts`

Expected: FAIL because `worker-wake.ts` does not exist.

- [x] **Step 7: Implement the wake transport**

Use `node:http` for the loopback server and injected `fetch`/timeout behavior
for the client. Do not log request bodies or configuration values.

- [x] **Step 8: Run wake transport tests and verify GREEN**

Run: `pnpm exec vitest run src/platform/jobs/tests/worker-wake.test.ts`

Expected: PASS.

### Task 2: Run-to-empty worker primitives

**Files:**

- Modify: `src/platform/jobs/jobs-poller.ts`
- Modify: `src/platform/jobs/tests/jobs-poller.test.ts`
- Modify: `src/platform/jobs/jobs.repository.ts`
- Modify: `src/platform/jobs/tests/jobs.repository.test.ts`
- Modify: `src/modules/plaid/inbound-events-poller.ts`
- Modify: `src/modules/plaid/tests/inbound-events-poller.test.ts`
- Modify: `src/modules/plaid/inbound-events.repository.ts`
- Modify: `src/modules/plaid/tests/inbound-events.repository.test.ts`

**Interfaces:**

- Produces: `JobsPoller.drainOnce(): Promise<void>`
- Produces: `InboundEventsPoller.drainOnce(): Promise<void>`
- Produces: earliest future retry deadline readers for jobs and inbound events

- [x] **Step 1: Write failing jobs drain tests**

Test that `drainOnce()` repeatedly claims batches until an empty claim, waits
for every active handler, shares an overlapping drain promise, and performs no
new claim after resolving.

- [x] **Step 2: Run jobs poller tests and verify RED**

Run: `pnpm exec vitest run src/platform/jobs/tests/jobs-poller.test.ts`

Expected: FAIL because `drainOnce` does not exist.

- [x] **Step 3: Implement minimal jobs drain behavior**

Reuse the existing lease, heartbeat, completion, retry, and shutdown code.
Keep legacy `start()` behavior available for isolated compatibility tests, but
the default worker composition will no longer call it.

- [x] **Step 4: Run jobs poller tests and verify GREEN**

Run: `pnpm exec vitest run src/platform/jobs/tests/jobs-poller.test.ts`

Expected: PASS.

- [x] **Step 5: Write failing inbound drain tests**

Test repeated batches through the first empty claim, same-item serialization,
single-flight overlap, and no idle claim after the drain resolves.

- [x] **Step 6: Run inbound poller tests and verify RED**

Run: `pnpm exec vitest run src/modules/plaid/tests/inbound-events-poller.test.ts`

Expected: FAIL because `drainOnce` does not exist.

- [x] **Step 7: Implement minimal inbound drain behavior**

Extract one batch claim from `pollOnce()` and loop it in `drainOnce()` without
changing lease fencing, dedupe, retry, or shutdown semantics.

- [x] **Step 8: Run inbound poller tests and verify GREEN**

Run: `pnpm exec vitest run src/modules/plaid/tests/inbound-events-poller.test.ts`

Expected: PASS.

- [x] **Step 9: Add failing repository deadline tests, then implement readers**

Test that each repository returns the minimum future `available_at` for queued
retryable work and `null` when none exists. Implement one bounded aggregate
query per repository and rerun both repository suites.

### Task 3: Single-flight sweep worker and entrypoint lifecycle

**Files:**

- Modify: `src/app/create-worker.ts`
- Modify: `src/app/default-worker-adapters.ts`
- Modify: `src/app/tests/create-worker.test.ts`
- Modify: `src/entrypoints/worker.ts`
- Modify: `src/entrypoints/tests/worker.test.ts`

**Interfaces:**

- Extends: `WorkerAdapter.sweep?: () => Promise<void>`
- Extends: `WorkerRuntime.wake(): Promise<void>`
- Consumes: `createWorkerWakeServer`
- Consumes: `Env.WORKER_SWEEP_INTERVAL_MINUTES`

- [x] **Step 1: Write failing worker sweep tests**

Test that enabled adapters sweep in declared order, overlapping wakes share
one sweep, a stopped worker rejects/ignores new work without starting adapters,
and stop waits for or bounds active adapter cleanup through existing behavior.

- [x] **Step 2: Run worker shell tests and verify RED**

Run: `pnpm exec vitest run src/app/tests/create-worker.test.ts`

Expected: FAIL because `wake` and adapter sweeps do not exist.

- [x] **Step 3: Implement worker single-flight wakes**

Add `sweep` and `wake` without changing existing start/stop idempotence or
failure aggregation.

- [x] **Step 4: Run worker shell tests and verify GREEN**

Run: `pnpm exec vitest run src/app/tests/create-worker.test.ts`

Expected: PASS.

- [x] **Step 5: Write failing default composition tests**

Prove default startup does not start poller/scheduler intervals and a wake runs
scheduler once, drains inbound events, then drains jobs.

- [x] **Step 6: Implement one-shot default adapters**

Compose scheduler `tickOnce`, inbound `drainOnce`, and jobs `drainOnce` in that
order. Their `stop` methods remain responsible for bounded active-work cleanup.

- [x] **Step 7: Write failing entrypoint timer/server tests**

Test startup wake, `360`-minute scheduling, `0` disabling the periodic timer,
earliest-retry scheduling even when periodic sweeps are disabled, manual wake
resetting a single timer, wake-server lifecycle, and cleanup order.

- [x] **Step 8: Implement entrypoint scheduling and control server**

Start the loopback server, accept asynchronous wakes, run an initial sweep,
schedule at most one timeout, and stop timer/server/worker/database in order.

- [x] **Step 9: Run worker composition and entrypoint tests**

Run: `pnpm exec vitest run src/app/tests/create-worker.test.ts src/app/tests/default-worker-adapters.test.ts src/entrypoints/tests/worker.test.ts`

Expected: PASS.

### Task 4: Wake after durable manual pipeline enqueue

**Files:**

- Modify: `src/modules/pipeline/pipeline.service.ts`
- Modify: `src/modules/pipeline/tests/pipeline.service.test.ts`
- Modify: `src/app/register-modules.ts`
- Modify: `src/app/create-http-app.ts`
- Modify: `src/app/tests/register-modules.test.ts` or the nearest existing composition test

**Interfaces:**

- Consumes: `wakeWorker: () => Promise<void>`
- Preserves: `PipelineService.startPipelineRun(...)` response schema

- [x] **Step 1: Write failing manual-wake service tests**

Test that a newly committed manual run sends exactly one wake, a deduped manual
run does not send a redundant wake, scheduled/webhook runs do not send a wake,
and a wake transport failure is logged while the durable run still returns.

- [x] **Step 2: Run pipeline service tests and verify RED**

Run: `pnpm exec vitest run src/modules/pipeline/tests/pipeline.service.test.ts`

Expected: FAIL because the service has no wake dependency.

- [x] **Step 3: Implement post-commit best-effort wake**

Invoke the injected wake only after `startPipelineRun` commits a non-deduped
manual run. Catch and redact transport errors without deleting the queued job.

- [x] **Step 4: Run pipeline service tests and verify GREEN**

Run: `pnpm exec vitest run src/modules/pipeline/tests/pipeline.service.test.ts`

Expected: PASS.

- [x] **Step 5: Wire the default API composition**

Create one wake client from validated API configuration and inject it into the
shared pipeline service used by pipeline routes and Plaid exchange.

- [x] **Step 6: Run app and route tests**

Run: `pnpm exec vitest run src/app/tests src/modules/pipeline/tests/pipeline.routes.test.ts src/modules/plaid/tests/plaid.service.test.ts`

Expected: PASS.

### Task 5: Operational documentation and complete verification

**Files:**

- Modify: `docs/operations.md`
- Modify: `PLAN5_TASK5B_READINESS_PACKET.md`

**Interfaces:**

- Documents: configuration, manual wake fallback, six-hour webhook latency,
  start/stop behavior, and the invalidated cutover readiness evidence.

- [x] **Step 1: Update operational documentation**

Document both environment settings, loopback binding, `202` manual behavior,
six-hour webhook bound, disabled daily sync default, and the fact that live
scale-to-zero plus `LISTEN` behavior still requires separate verification.

- [x] **Step 2: Mark the old readiness packet stale**

Record that the database endpoint changed and this redesign changes worker
startup/ownership, so no prior packet authorizes cutover.

- [x] **Step 3: Run focused worker verification**

Run: `pnpm exec vitest run src/platform/config/tests/env.test.ts src/platform/jobs/tests/worker-wake.test.ts src/platform/jobs/tests/jobs-poller.test.ts src/modules/plaid/tests/inbound-events-poller.test.ts src/app/tests/create-worker.test.ts src/app/tests/default-worker-adapters.test.ts src/entrypoints/tests/worker.test.ts src/modules/pipeline/tests/pipeline.service.test.ts`

Expected: PASS.

- [x] **Step 4: Run repository verification**

Run, independently:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:dist
pnpm format:check
git diff --check
```

Expected: every command exits `0`. If `format:check` retains a pre-existing
failure outside this change, report it with exact paths and format only files
owned by this implementation.

- [x] **Step 5: Attack the result before reporting**

Review the diff for accidental live configuration changes, secret exposure,
unbounded timers, wake-server external binding, duplicate schedulers, lost
durable jobs, and any path that queries Neon while idle. Report what was and
was not verified; do not claim live Neon scale-to-zero.
