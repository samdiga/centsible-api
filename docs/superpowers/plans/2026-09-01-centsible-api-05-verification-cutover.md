# Centsible API Verification and Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove source parity and production independence, document manual operation, rehearse rollback, move Tailscale port `4000` to the new API, and archive the old repository after a stable soak.

**Architecture:** Automated manifests and clean-build smoke tests form the release gate. Operational cutover stops the old combined process before the new independent worker and API start; additive migrations keep application rollback available while Centsy retains inbound events durably.

**Tech Stack:** pnpm/Vitest/TypeScript, OpenAPI, Neon sandbox and point-in-time recovery, Swift/XCTest smoke tests, Tailscale, manual Node processes.

**Spec:** `docs/superpowers/specs/2026-09-01-centsible-api-migration-design.md`

## Global Constraints

- Complete Plans 1–4 and review every gate before this plan.
- Do not run destructive tests in `public`; use only generated `centsible_test_<run-id>` schemas.
- Do not run old and new schedulers concurrently.
- Do not stop the current port-4000 service or archive `centsible-claude` without an explicit cutover approval at Task 5.
- Initial migrations remain additive; rollback restarts the old application without dropping new tables.
- Keep Centsy storing verified events during an API rollback so no webhook is acknowledged and lost.
- Obtain separate filesystem write authorization before changing `centsible-claude/README.md`; source inspection remains read-only until then.

---

### Task 1: Complete source-test mapping and route/OpenAPI parity

**Files:**

- Create: `tests/contract/source-test-mapping.json`
- Create: `tests/contract/source-test-mapping.test.ts`
- Create: `tests/contract/route-openapi-parity.test.ts`
- Create: `scripts/list-routes.mjs`
- Create: `docs/source-parity.md`

**Interfaces:**

- `source-test-mapping.json` maps each of the 40 base-pin API test files, 11 base-pin shared-support test files, and every test added or changed by the three approved supplemental account commits to one or more target tests or an explicit relocation reason. Duplicate source paths appear once with all applicable source SHAs recorded.
- `list-routes.mjs` emits sorted `{ method, path, disposition }` JSON for registered routes and aliases.

- [ ] **Step 1: Write failing completeness tests**

```ts
it("maps every source test file exactly once", () => {
  const expectedSourceTests = [
    ...sourceManifest.apiFiles,
    ...sourceManifest.sharedSupportFiles,
    ...sourceManifest.supplementalTestFiles.map(({ path }) => path),
  ];
  expect(mapping.map((entry) => entry.source).sort()).toEqual(
    [...new Set(expectedSourceTests)].sort(),
  );
  expect(sourceManifest.supplementalCommits).toEqual(
    APPROVED_SUPPLEMENTAL_SHAS,
  );
  for (const supplemental of sourceManifest.supplementalTestFiles) {
    expect(
      mapping.find(({ source }) => source === supplemental.path)?.sourceCommits,
    ).toEqual(supplemental.sourceCommits);
  }
  expect(
    mapping.every(
      (entry) => entry.targets.length > 0 || entry.disposition === "relocated",
    ),
  ).toBe(true);
});

it("matches registered routes to OpenAPI and the source manifest", () => {
  expect(localCanonicalOperations).toEqual(expectedLocalOperations);
  expect(openApiOperations).toEqual(expectedDocumentedOperations);
  expect(relocatedOperations).toEqual([
    { method: "POST", path: "/plaid/webhook", target: "centsy" },
  ]);
});
```

- [ ] **Step 2: Verify failure and fill the mapping from actual files**

Run: `pnpm test tests/contract/source-test-mapping.test.ts tests/contract/route-openapi-parity.test.ts`

Expected initially: FAIL with unmapped tests or route differences. Add exact target paths; do not use wildcard statements such as “covered elsewhere.”

- [ ] **Step 3: Correct every parity difference**

For missing operations, fix module registration or OpenAPI metadata. For status/body differences, prefer the pinned fixture unless the approved spec deliberately standardizes errors or relocates the webhook. Record those two categories in `docs/source-parity.md`.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test tests/contract
node scripts/list-routes.mjs
git add tests/contract scripts/list-routes.mjs docs/source-parity.md
git commit -m "test: prove source route and test parity"
```

### Task 2: Clean-install, dist, Swagger, and secret-leak verification

**Files:**

- Create: `scripts/verify-clean-build.sh`
- Create: `tests/build/dist-contents.test.ts`
- Create: `tests/contract/openapi-security.test.ts`
- Create: `tests/security/no-secret-output.test.ts`
- Modify: `scripts/test-dist.mjs`

**Interfaces:**

- `scripts/verify-clean-build.sh` installs from lockfile in a generated temporary directory and runs the full non-production test/build matrix.
- Dist verification starts app factories without using TypeScript source or sibling repositories.

- [ ] **Step 1: Write failing build/security tests**

```ts
expect(distFiles.some((file) => file.endsWith(".test.js"))).toBe(false);
expect(distImports).not.toMatch(/@centsible\//);
expect(distImports).not.toContain("/Users/samdiga/code/centsible-claude");
expect(JSON.stringify(openApiDocument)).not.toContain(
  process.env.CLERK_SECRET_KEY,
);
expect(capturedLogs).not.toMatch(/access-sandbox-|password|transactionName/);
```

- [ ] **Step 2: Implement the clean-build verifier**

Stage this task's intended files first, derive an index tree with `git write-tree`, then use `mktemp -d` and `git archive <index-tree>` so the verifier tests the exact staged implementation rather than the previous commit. Run `pnpm install --frozen-lockfile`, then `format:check`, `lint`, `typecheck`, unit tests, build, and dist smoke. The script prints the temporary path on failure and removes it on success. It does not copy `.env` or unrelated untracked files.

- [ ] **Step 3: Verify Swagger manually and automatically**

With `API_DOCS_ENABLED=true`, authenticate using the Clerk component, load `/openapi.json`, and execute one safe GET from each module. Verify sign-out clears the token and unauthenticated spec access returns 401. Record only pass/fail and request IDs; do not record the token.

- [ ] **Step 4: Run and commit**

```bash
git add scripts tests/build tests/security tests/contract/openapi-security.test.ts
pnpm test tests/build tests/security tests/contract/openapi-security.test.ts
pnpm build
pnpm test:dist
bash scripts/verify-clean-build.sh
git commit -m "test: verify clean production build"
```

### Task 3: Performance baseline and approved cache limits

**Files:**

- Create: `scripts/benchmark-reads.ts`
- Create: `docs/performance-baseline.md`
- Create: `tests/integration/cache-write-invalidation.test.ts`

**Interfaces:**

- Benchmark records p50/p95 duration, query count, cache hit/miss, serialized bytes, and computation time for dashboard, accounts, first transaction page, reports, and forecast.

- [ ] **Step 1: Write failing write-invalidation scenarios**

```ts
for (const scenario of userWriteScenarios) {
  await primeEveryUserCache(scenario.userId);
  await scenario.write();
  expect(responseCache.keysForUser(scenario.userId)).toEqual([]);
  expect(await getUserRevision(scenario.userId)).toBeGreaterThan(
    scenario.beforeRevision,
  );
}
```

- [ ] **Step 2: Run uncached and cached baselines**

Run:

```bash
pnpm tsx scripts/benchmark-reads.ts --iterations 20 --horizon 30
pnpm test:integration tests/integration/cache-write-invalidation.test.ts
```

Record Mac mini model/RAM, Node version, sandbox branch, row counts, results, and the fixed defaults: five-minute absolute TTL, 1,000 entries, 64 MiB, and 2 MiB per entry.

- [ ] **Step 3: Review query plans without speculative indexes**

Capture `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)` for queries above the documented threshold. Do not change repositories or add indexes in this task. If a threshold fails, record the failing query and plan output, stop this gate, and write a separate focused remediation plan naming the exact repository and index files.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test:integration tests/integration/cache-write-invalidation.test.ts
pnpm typecheck
git add scripts/benchmark-reads.ts docs/performance-baseline.md tests/integration/cache-write-invalidation.test.ts
git commit -m "perf: verify read cache and hot queries"
```

### Task 4: Operator documentation and sandbox rehearsal

**Files:**

- Modify: `README.md`
- Create: `docs/operations.md`
- Create: `docs/cutover-checklist.md`
- Create: `docs/rollback-checklist.md`
- Create: `docs/deprecation-notice.md`
- Create: `scripts/smoke-api.ts`

**Interfaces:**

- `scripts/smoke-api.ts --base-url <url>` checks health and, when given a Clerk token through the environment, representative authenticated reads without printing the token.

- [ ] **Step 1: Write the operational documents with exact commands**

Document environment preparation, `pnpm db:migrate`, `pnpm start:worker`, `pnpm start:api`, Swagger login, log locations, graceful shutdown, worker identification, job/dead-event inspection, `pnpm webhook:replay -- <uuid>`, cache defaults, Tailscale URL, test-schema cleanup, and Neon recovery.

- [ ] **Step 2: Implement and test the smoke script**

The script asserts `/health`, `/accounts`, `/dashboard/summary`, `/transactions?limit=1`, `/bills`, `/budgets/active` allowing documented 404, `/forecast?horizonDays=30` allowing `FEATURE_DISABLED`, and `/plaid/items`. Any other status fails with request ID and safe error code.

- [ ] **Step 3: Rehearse in the sandbox on a non-production port**

```bash
PORT=4001 pnpm start:api
pnpm start:worker
pnpm tsx scripts/smoke-api.ts --base-url http://127.0.0.1:4001
```

Trigger one reversible sandbox write, prove immediate cache invalidation, insert one signed webhook fixture through Centsy, process it, and execute the rollback checklist without touching port `4000`.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/operations.md docs/cutover-checklist.md docs/rollback-checklist.md docs/deprecation-notice.md scripts/smoke-api.ts
git commit -m "docs: add API operations and cutover runbooks"
```

### Task 5: Explicit cutover approval and Mac mini port-4000 transition

**Files:**

- Update after execution: `docs/cutover-checklist.md`
- Update after execution: `docs/operations.md`

**Interfaces:** None; this task changes live process ownership and requires the user at the checkpoint.

- [ ] **Step 1: Stop and ask for explicit cutover approval**

Report the verified commit SHA, full command matrix, Neon recovery status, sandbox rehearsal result, Centsy deployment status, current port-4000 process identity, and rollback command. Ask one wizard question: approve or postpone the live cutover. Do not continue on an ambiguous response.

- [ ] **Step 2: Resolve exact processes read-only**

Use `lsof -nP -iTCP:4000 -sTCP:LISTEN` and process inspection to identify the old API. Identify old worker/scheduler processes by command and verify their repository path. Do not use broad `killall`, wildcard process matching, or port-kill scripts.

- [ ] **Step 3: Create recovery point and stop old processes gracefully**

Confirm Neon point-in-time recovery or create the named restore point from the Neon console. Send the resolved old worker and API process IDs their normal termination signal, wait for exit, and confirm port `4000` plus old worker commands are absent.

- [ ] **Step 4: Migrate and start the new processes manually**

```bash
pnpm db:migrate
pnpm start:worker
pnpm start:api
```

Start from `/Users/samdiga/code/centsible-api` with the reviewed `.env`. Record process IDs and startup build SHA. Confirm only one scheduler claims work.

- [ ] **Step 5: Execute the live smoke checklist**

Run health, Clerk Swagger, representative reads, one reversible write, cache invalidation, Plaid item status, a Centsy webhook, worker completion, and Swift app refresh over the exact Tailscale URL on port `4000`. Verify that `centsible-ui` decodes `POST /plaid/items/:itemId/refresh` with its dedicated account-balance DTO rather than `AccountSummary`. On the first severity-one/two failure, stop and execute rollback; do not continue collecting failures.

- [ ] **Step 6: Record cutover state**

Mark each checklist item with timestamp, request/event ID, safe result, new process IDs, build SHA, and rollback decision. Commit documentation only:

```bash
git add docs/cutover-checklist.md docs/operations.md
git commit -m "docs: record API cutover"
```

### Task 6: Seven-day soak and source archive

**Files:**

- Create: `docs/soak-report.md`
- Modify: `README.md`
- Modify in `centsible-claude` after approval: `README.md`

**Interfaces:** The soak records daily health, restart count, unhandled errors, dead events, queue age, cache memory, Neon failures, Swift regressions, and scheduler duplication.

- [ ] **Step 1: Mark the source repository deprecated without deleting it**

After successful cutover, add a top-level notice pointing backend work to `centsible-api`, mobile work to `centsible-ui`, and public web work to `centsy`. Do not delete source files or rewrite history.

- [ ] **Step 2: Observe for seven complete days**

Once daily, record API/worker uptime, memory, cache entries/bytes, p95 hot-read latency, oldest pending event, retry/dead counts, scheduler runs, Neon connectivity, and Swift-visible issues. A restart is acceptable only when its cause and recovery are recorded.

- [ ] **Step 3: Decide archive eligibility**

Archive only when there is no unresolved severity-one or severity-two issue, no lost event, no duplicate scheduler, rollback has remained available, and all domain smoke checks still pass. Otherwise extend the soak and keep the source repository deprecated but writable only for emergency rollback.

- [ ] **Step 4: Commit reports and archive read-only**

```bash
git add README.md docs/soak-report.md
git commit -m "docs: complete API migration soak"
```

After a separate final user approval for the remote state change, run `gh repo archive samdiga/centsible-claude --yes`. Do not delete the local checkout or remote history. If GitHub reports that archival is unavailable or already applied, record the exact response and stop; do not substitute a destructive operation.

## Plan 5 Completion Gate

- [ ] All 55 canonical operations and nine aliases have passing compatibility or relocation evidence.
- [ ] All base-pin and approved supplemental source tests have exact mapping entries.
- [ ] Clean install, format, lint, type check, unit, integration, build, dist, Swagger, Centsy, Swift, and rollback checks pass.
- [ ] New API and worker own the Mac mini runtime; only one scheduler runs.
- [ ] The seven-day soak meets archive criteria and `centsible-claude` is archived read-only, not deleted.
