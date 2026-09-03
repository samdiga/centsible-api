# Centsible API Migration Design

- **Status:** Approved foundation plus approved Plan 2 addendum; pending written-spec review
- **Date:** 2026-09-01
- **Target repository:** `/Users/samdiga/code/centsible-api`
- **Source repository:** `/Users/samdiga/code/centsible-claude`
- **Pinned source commit:** `06d3972a7ffc88b6c65a4bab4ad47487e55b800c`
- **Approved supplemental commits:** `ca000fbb1f1755e77b22970ba6ff11ce520aa4ea`, `32515278be92347635081bac76cf1766bb563189`, `423879917c74cce21ccafa606279cc0511d4da91`

## 1. Summary

`centsible-api` will become the sole owner of Centsible's backend domain code, HTTP API, database schema and migrations, shared backend contracts, business logic, background jobs, tests, and production build. The source monorepo, `centsible-claude`, will be archived after a successful cutover and soak period.

The migrated backend will remain a Node.js, TypeScript, Hono, Drizzle, and Postgres application. It will be one independently buildable pnpm package rather than another workspace monorepo. The code will be reorganized by business domain so that each API's routes, schemas, service logic, repository, wire mapper, and focused tests are co-located.

The native Swift application in `centsible-ui` is the HTTP compatibility boundary. Existing paths and successful response bodies remain compatible during migration. `centsy` remains the internet-facing Next.js application and will own Plaid OAuth fallback pages and public webhook ingress. It may durably insert verified webhook events, but it will not own or perform financial domain writes.

The backend runs manually on the Mac mini. The Swift app reaches it through Tailscale on port `4000`. Neon remains the shared Postgres database. Docker, Vercel deployment of the private API, a CDN, Redis, and a process supervisor are not part of this migration.

## 2. Source Baseline and Findings

The migration copies from the pinned source commit, not from an unrecorded moving checkout. Three explicitly approved, backend-only account lifecycle patches are applied on top of that immutable baseline; their exact SHAs are recorded above rather than repinning to the source repository's moving `HEAD`. The following dirty source-repository changes are unrelated and must not be copied unless separately requested:

- Deleted `.claude/hooks/context-monitor.js`
- Deleted `.claude/hooks/statusline.js`
- Modified `.claude/settings.json`
- Untracked `apps/mobile/TESTFLIGHT.md`
- Untracked `docs/VOICE_AGENT_CONTEXT.md`
- Untracked `docs/centsy-web-spec.md`

The effective backend inventory is the pinned baseline plus the approved supplemental account patches:

- 55 canonical HTTP handler definitions across 14 route modules after adding the approved `DELETE /accounts/:accountId` contract.
- Nine additional public paths from mounting the bills handlers at the deprecated `/recurring` alias.
- 119 TypeScript files under `apps/api/src` after the approved patches; the base pin contains 117.
- 41 API test files after the approved patches; the base pin contains 40. The previously discovered base suite contains 176 tests, and the supplemental account files add eight test cases. Implementation must produce a fresh test-list count and account for every discovered test.
- Seven generated Drizzle SQL migrations, six raw SQL migrations, and Drizzle snapshots/journal metadata.
- Direct workspace dependencies on `@centsible/db`, `@centsible/shared-types`, and `@centsible/shared-logic`.

Read-only verification found:

- API type checking passes when incremental compilation is disabled.
- ESLint passes.
- Prettier check fails in 94 API/support files.
- The current production build is not independently runnable. Workspace packages export TypeScript source while the compiled API imports `.js` paths that do not exist in those packages.
- The current TypeScript build emits test files and produces 468 output artifacts, which is unsuitable for a production runtime bundle.
- Tests could not run in the inspection environment because their fallback requires a container runtime. This is an environment limitation, not evidence that the tests fail.
- Error response shapes and response validation are inconsistent.
- The HTTP entrypoint starts both the API server and background processes, preventing independent operation and safe cutover.

## 3. Goals

The migration is complete when all of the following are true:

1. `centsible-api` independently installs, formats, lints, type-checks, tests, builds, migrates the database, and starts without any path or package dependency on `centsible-claude`.
2. Every source endpoint is either preserved at the same path or has an explicitly documented relocation. The only planned relocation is the public Plaid webhook ingress from the private API to `centsy`.
3. Existing Swift-used success response shapes remain compatible, including decimal integer strings for money and ISO-8601 timestamps.
4. API code is organized into domain-oriented vertical slices with enforced dependency boundaries.
5. HTTP errors have one stable envelope and typed internal causes.
6. Expensive reads use a bounded local LRU cache with a five-minute absolute TTL and write-driven invalidation.
7. Plaid webhooks are verified at `centsy`, committed durably to Neon before acknowledgment, and processed idempotently by the local worker.
8. API and worker entrypoints can be run manually and independently.
9. Browser-visible OpenAPI documentation supports authenticated requests using the existing Clerk account.
10. All tests run without Docker and cannot mutate the normal application schema.
11. The old repository can be stopped, the new server can assume port `4000`, and application rollback remains possible without immediately reverting the database.

## 4. Non-goals

This migration will not:

- Deploy the private API or worker to Vercel.
- Add Docker, Kubernetes, Redis, a CDN, or a process supervisor.
- Rebuild the Swift UI or implement the Swift offline-write queue.
- Make the private API publicly accessible.
- Introduce a breaking `/v1` path prefix.
- Generate the Swift client from OpenAPI.
- Redesign the financial data model beyond changes required for durable events, cache invalidation, integrity, and migration correctness.
- Add persisted read models before measured query evidence shows they are needed.
- Preserve monorepo workspace package boundaries inside `centsible-api`.

## 5. Repository Ownership

### 5.1 `centsible-ui`

- Native SwiftUI client.
- Obtains Clerk bearer tokens.
- Calls the private Tailscale API on port `4000`.
- Owns presentation, screen state, and client-side resource caching.
- Does not own backend schemas or business rules.

### 5.2 `centsible-api`

- Sole owner of HTTP contracts, domain behavior, database schema, migrations, audit behavior, Plaid token encryption, jobs, schedules, webhook processing, cache invalidation, and all financial domain writes.
- Publishes the source schema file that `centsy` mirrors for type-safe narrow ingestion.
- Provides separate HTTP and worker entrypoints.

### 5.3 `centsy`

- Public landing pages, Plaid OAuth fallback, and Plaid webhook endpoint.
- Verifies the Plaid JWT and request-body digest.
- Performs request size and content-type checks.
- Inserts a narrow inbound-event record in Neon and returns success only after commit.
- Does not run Drizzle migrations or update accounts, transactions, bills, budgets, rules, forecasts, pipeline state, or audit records.
- Changes its schema mirror source from `centsible-claude` to `centsible-api`.

## 6. Runtime Topology

The private synchronous path is:

1. Swift obtains a Clerk session token.
2. Swift sends a request through Tailscale to the Mac mini on port `4000`.
3. HTTP middleware assigns a request ID, applies security headers and body limits, authenticates Clerk, and validates the request.
4. The selected domain service applies business rules and coordinates repositories.
5. Repositories perform typed Neon operations. Related domain writes, audit writes, and user revision increments are atomic where required.
6. A mapper produces the stable wire representation and the route returns it.

The asynchronous webhook path is:

1. Plaid sends a webhook to `centsy.dev`.
2. `centsy` verifies the Plaid JWT, allowed algorithm, key ID, and SHA-256 body digest before parsing or storing the event.
3. `centsy` inserts the event into `inbound_webhook_events` and acknowledges only after the transaction commits.
4. The Mac mini worker leases available events safely, dispatches them to the Plaid domain, and performs cursor-based synchronization or item-status changes.
5. The worker marks the event processed or schedules a bounded retry.

## 7. Target Repository Structure

```text
centsible-api/
├── src/
│   ├── entrypoints/
│   │   ├── api.ts
│   │   └── worker.ts
│   ├── app/
│   │   ├── create-http-app.ts
│   │   └── create-worker.ts
│   ├── modules/
│   │   ├── accounts/
│   │   ├── bills/
│   │   ├── budgets/
│   │   ├── categories/
│   │   ├── dashboard/
│   │   ├── forecast/
│   │   ├── health/
│   │   ├── notifications/
│   │   ├── pipeline/
│   │   ├── plaid/
│   │   ├── reports/
│   │   ├── rules/
│   │   ├── transactions/
│   │   └── user-data/
│   ├── platform/
│   │   ├── auth/
│   │   ├── cache/
│   │   ├── config/
│   │   ├── database/
│   │   ├── errors/
│   │   ├── http/
│   │   ├── jobs/
│   │   ├── logging/
│   │   └── openapi/
│   └── shared/
│       ├── money/
│       ├── pagination/
│       └── time/
├── database/
│   ├── migrations/
│   ├── schema/
│   └── seed/
├── tests/
│   ├── build/
│   ├── contract/
│   ├── integration/
│   ├── security/
│   └── support/
├── scripts/
└── docs/
```

A typical module contains:

```text
transactions/
├── transactions.routes.ts
├── transactions.schemas.ts
├── transactions.service.ts
├── transactions.repository.ts
├── transactions.mapper.ts
├── transactions.errors.ts
├── tests/
│   ├── transactions.routes.test.ts
│   └── transactions.service.test.ts
└── index.ts
```

Routes authenticate, validate, call a service, and produce a response. Services own use cases and transactions. Repositories perform database access only. Mappers own database-to-wire conversion, including bigint-to-string serialization. Schemas describe the actual wire format rather than the internal database type.

Modules expose a small public surface through `index.ts`. A module may not import another module's internal files. `platform` holds reusable technical infrastructure; `shared` contains small stable primitives rather than miscellaneous helpers. Focused tests live in a `tests/` child directory inside the app, entrypoint, platform component, shared component, or domain they exercise. Repository-level cross-cutting suites remain in `tests/build`, `tests/contract`, `tests/integration`, and `tests/support` rather than being nested again.

Code quality is enforced rather than left to convention:

- Prettier and ESLint must pass for every migrated file.
- Hono's environment is typed so routes do not use unsafe `c.get('userId' as never)` casts.
- Domain outcomes use typed results or typed errors rather than comparing exception-message strings.
- Names describe business meaning; generic `utils` and catch-all service files are not introduced.
- Comments explain non-obvious financial, concurrency, security, or compatibility invariants. They do not narrate straightforward code.
- Public module functions and unusual edge cases receive concise documentation where the type signature is insufficient.
- Files that accumulate several unrelated responsibilities are split along route, service, repository, mapping, or policy boundaries.

## 8. Endpoint Compatibility Manifest

The canonical source handlers are:

| Domain        | Method and path                                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health        | `GET /health`                                                                                                                                                                                                                         |
| Accounts      | `GET /accounts`, `POST /accounts/:accountId/refresh-balance`, `DELETE /accounts/:accountId`                                                                                                                                           |
| Transactions  | `GET /transactions`, `GET /transactions/export`, `GET /transactions/:id`, `POST /transactions/bulk`, `PATCH /transactions/:id`                                                                                                        |
| Dashboard     | `GET /dashboard/summary`                                                                                                                                                                                                              |
| Categories    | `GET /categories`, `POST /categories`, `PATCH /categories/:id`, `DELETE /categories/:id`                                                                                                                                              |
| Rules         | `GET /rules/preview`, `GET /rules`, `POST /rules`, `PATCH /rules/:id`, `DELETE /rules/:id`                                                                                                                                            |
| Budgets       | `GET /budgets/suggestions`, `GET /budgets/active`, `POST /budgets`, `GET /budgets/:id/progress`, `PUT /budgets/:id/items`, `PATCH /budgets/active/items/:categoryId`, `DELETE /budgets/active/items/:categoryId`                      |
| Bills         | `GET /bills`, `POST /bills`, `PATCH /bills/:id`, `POST /bills/detect`, `DELETE /bills/:id`, `GET /bills/:id`, `GET /bills/:id/occurrences`, `POST /bills/:id/occurrences/:occId/mark-paid`, `POST /bills/:id/occurrences/:occId/skip` |
| Forecast      | `GET /forecast`, `GET /forecast/accuracy`                                                                                                                                                                                             |
| Notifications | `GET /notifications/preferences`, `PATCH /notifications/preferences`                                                                                                                                                                  |
| Reports       | `GET /reports/summary`                                                                                                                                                                                                                |
| User data     | `GET /user/export`, `POST /user/import`, `DELETE /user/data`                                                                                                                                                                          |
| Pipeline      | `GET /pipeline/runs`, `GET /pipeline/runs/:id`, `POST /pipeline/run`, `GET /pipeline/schedule`, `PUT /pipeline/schedule`                                                                                                              |
| Plaid         | `GET /plaid/items`, `POST /plaid/link-token`, `POST /plaid/exchange`, `POST /plaid/items/:itemId/refresh`, `POST /plaid/items/:itemId/update-link-token`, `DELETE /plaid/items/:itemId`, `POST /plaid/webhook`                        |

The seven budget handlers and the approved additive account deletion handler make the exact canonical total 55.

### 8.1 Approved account lifecycle addendum

The supplemental commits add one HTTP contract and refine Plaid account synchronization without changing the database schema:

- A Plaid account matched during a bank relink retains its existing account UUID and transaction history while its item reference is moved to the new live Plaid item.
- A routine sync against the same item preserves an intentional `deletedAt` value; a relink to a different item clears `deletedAt` and restores the account.
- `DELETE /accounts/:accountId` performs a tenant-scoped soft delete and preserves transactions. Missing, other-user, and already-removed accounts all return the stable `404 NOT_FOUND` envelope.
- A successful deletion returns `{ "ok": true, "unlinkedItem": boolean }`. If it removed the last live account for an active item, the accounts service invokes an injected unlink port. Plan 3 supplies the Plaid `/item/remove`, token decryption, and item cleanup adapter. `unlinkedItem: true` means local item state transitioned to disconnected, not that a best-effort upstream revoke is guaranteed.
- Local account removal remains authoritative if Plaid unlink fails. The upstream call is best effort and the failure is logged safely; local deletion, revision increment, and cache eviction still complete. Repeated deletion is safe, and the delete-plus-live-count decision is serialized by a user/item-scoped database lock so concurrent removals produce only one unlink request.

These behaviors are covered by route, service, repository, OpenAPI, and isolated-Neon tests for history preservation, same-item removal survival, different-item restoration, wrong-user access, idempotency, and last-account unlinking.

The nine bills handlers also remain available under `/recurring` during migration. Responses on the alias include standard deprecation metadata and point clients toward `/bills`; removal requires a separately approved compatibility change.

`POST /plaid/webhook` is the only deliberate topology change. Its public HTTP contract moves to `centsy`; its verification and dispatch behavior is split between Centsy's verified durable ingestion and the API worker's Plaid-domain handler. The private Mac mini API does not need a publicly routable webhook endpoint. Contract tests must prove the combined replacement covers every currently handled Plaid webhook code.

## 9. HTTP Contracts

### 9.1 Success bodies

Existing success bodies remain unwrapped. Compatibility rules are:

- Money values are signed decimal integer strings representing cents.
- Dates without times use `YYYY-MM-DD`.
- Timestamps use ISO-8601 UTC strings.
- Opaque cursors remain opaque and use keyset pagination.
- Empty collections use `[]` rather than `null`.
- Optional singular values follow their existing `null` behavior.
- The initial migration does not rename endpoint fields consumed by Swift.

Request schemas are always enforced at runtime. Response mappers are fully typed. Response schemas run in unit, contract, integration, and development execution. Production response validation is configurable and defaults off for large successful reads to avoid reparsing expensive payloads.

### 9.2 Error envelope

Every HTTP failure uses:

```json
{
  "error": {
    "code": "VALIDATION",
    "message": "The amount must be a decimal integer string.",
    "details": [
      {
        "path": "amount",
        "code": "invalid_format"
      }
    ]
  },
  "requestId": "req_01..."
}
```

`details` is optional. The current Swift decoder continues to work because it requires only `error.code` and `error.message` and ignores additional fields. `X-Request-ID` is also returned as a response header.

The central mapping is:

| Status | Stable codes and meaning                                 |
| ------ | -------------------------------------------------------- |
| 400    | `BAD_REQUEST`, `BAD_CURSOR`, or `VALIDATION`             |
| 401    | `UNAUTHENTICATED`                                        |
| 403    | `FORBIDDEN` or `FEATURE_DISABLED`                        |
| 404    | `NOT_FOUND`                                              |
| 409    | `CONFLICT` or an operation-specific idempotency conflict |
| 413    | `PAYLOAD_TOO_LARGE`                                      |
| 429    | `RATE_LIMITED`, with `Retry-After`                       |
| 502    | `UPSTREAM_FAILURE`                                       |
| 503    | `SERVICE_UNAVAILABLE`                                    |
| 504    | `UPSTREAM_TIMEOUT`                                       |
| 500    | `INTERNAL`                                               |

Routes do not handcraft errors. Typed platform and domain errors are mapped by one global handler. Zod failures, unknown routes, body-limit failures, and unexpected errors use the same envelope.

Messages returned to clients are safe and user-readable. Logs retain the internal cause, stack, request ID, route, timing, and allowlisted upstream metadata. Tokens, account numbers, transaction descriptions, webhook bodies, access tokens, passwords, and raw financial payloads are redacted.

## 10. Authentication, Network, and OpenAPI Console

Clerk bearer authentication remains mandatory for private domain endpoints even though Tailscale provides the network boundary. `GET /health` remains unauthenticated. Public CORS is not enabled.

When `API_DOCS_ENABLED=true`, the server provides:

- `GET /docs`: a same-origin documentation shell available through Tailscale.
- `GET /openapi.json`: a Clerk-protected OpenAPI 3.1 document.

OpenAPI operations are generated from the same request and response schemas used by the route. Every private operation declares the Clerk bearer scheme. Contract tests fail if a registered route is absent from the document or if its documented method/path differs.

The docs shell uses ClerkJS and Clerk's supported sign-in component. The user may enter the same Clerk username and password used by the app. Clerk receives those credentials directly; the API server does not receive, log, proxy, or store them. After sign-in, the page calls `Clerk.session.getToken()` before each Swagger request and injects the short-lived bearer token in memory. Swagger UI is not rendered until Clerk reports an authenticated session.

The docs feature has these security properties:

- It is disabled by default outside explicit local configuration.
- The OpenAPI document requires Clerk authentication.
- The sign-in shell is reachable only on the Tailscale-hosted API address.
- Raw bearer tokens are not persisted in local storage by application code.
- The docs origin must be allowlisted in the Clerk instance configuration.
- A sign-out action clears the displayed console and in-memory authorization state.

## 11. Database Ownership and New Tables

All existing schema definitions, generated migrations, raw migrations, snapshots, migration runner behavior, and seed logic move into `centsible-api`. New migrations are additive through the initial cutover.

### 11.1 User data revisions

`user_data_versions` provides cross-process cache correctness:

| Column       | Purpose                         |
| ------------ | ------------------------------- |
| `user_id`    | Primary key and user owner      |
| `revision`   | Monotonically increasing bigint |
| `updated_at` | Operational timestamp           |

Every successful user-scoped domain write increments the revision in the same transaction as the mutation, even when that conservatively invalidates more entries than necessary. API-originated writes also evict the user's in-process cache immediately after commit. Worker-originated writes send a Postgres notification after commit so the API can eagerly evict the user's entries. A revision comparison before serving a cache hit protects correctness if a notification is missed.

### 11.2 Inbound webhook events

`inbound_webhook_events` is a narrow durable queue owned and migrated by `centsible-api`:

| Column                          | Purpose                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `id`                            | UUID primary key generated at ingress                                                        |
| `provider`                      | Provider discriminator; initially `plaid`                                                    |
| `webhook_type` / `webhook_code` | Dispatch fields extracted after verification                                                 |
| `provider_item_id`              | Plaid item identifier when present                                                           |
| `payload`                       | Verified JSON payload required for processing                                                |
| `payload_digest`                | SHA-256 of the exact raw request body                                                        |
| `dedupe_key`                    | SHA-256 of provider, type, code, item ID, and payload digest for recognizing equivalent work |
| `status`                        | `pending`, `processing`, `processed`, or `dead`                                              |
| `attempts`                      | Number of processing attempts                                                                |
| `available_at`                  | Earliest next claim time                                                                     |
| `lease_expires_at`              | Recovery boundary for interrupted workers                                                    |
| `locked_by`                     | Worker identity holding the lease                                                            |
| `last_error_code`               | Safe diagnostic code without raw secrets or payload                                          |
| `received_at` / `processed_at`  | Lifecycle timestamps                                                                         |

Ingress stores each verified delivery; the event table does not discard rows through a permanent unique constraint. The worker uses `dedupe_key` to recognize equivalent work, while the existing unique active-pipeline rule prevents concurrent duplicate synchronization. Plaid transaction cursors and compare-and-set cursor advancement make repeated domain handling safe. Item-status updates are idempotent. Every duplicate event is still given a terminal processed state so its delivery remains auditable.

The worker claims rows with transaction-safe locking and a five-minute expiring lease. A retryable failure waits `30 seconds × 2^(attempt - 1)`, capped at one hour, plus zero-to-25-percent jitter. After eight failed attempts, the event enters `dead` and can be replayed by an explicit command after the cause is corrected. Processed payloads are retained for 30 days; dead events are retained for 90 days. Retention is performed by the existing scheduled cleanup mechanism. Invalid signatures, digest mismatches, malformed JSON, unsupported content types, and oversized bodies are rejected at ingress and are never stored as trusted events. A Neon insertion failure returns `503` so Plaid retries delivery.

`centsy` should use a least-privileged database role limited to the inbound-event insert path and any schema metadata strictly required by its build. It must not receive permission to mutate domain tables.

## 12. Local LRU Cache

The API uses a process-local LRU cache. There is no Redis or CDN dependency.

Default configuration:

- Absolute TTL: 300,000 milliseconds, or five minutes.
- Maximum entries: 1,000.
- Approximate payload budget: 64 MiB.
- Maximum individual cached payload: 2 MiB.
- Expired-entry cleanup interval: one minute.

The TTL is absolute; reads do not extend it indefinitely. LRU pressure or byte-budget pressure may evict an entry earlier. Values are measured using their serialized response size plus conservative key overhead.

Cache keys include:

- Internal user ID.
- HTTP method and normalized route identity.
- Canonically ordered query values.
- User data revision.
- Algorithm version for computed outputs.
- Horizon for forecasts.
- Relevant calendar date and timezone for date-sensitive results.

Only successful, private `GET` responses with an explicit cache policy are cached. Initial policies cover accounts, bills, budgets, categories, dashboard, forecast, reports, Plaid item status, and the first transaction page. Cursor pages beyond the first are initially uncached to avoid high-cardinality cache growth.

The cache never stores:

- Errors or authentication results.
- Write responses.
- Health, docs, or OpenAPI responses in the domain cache.
- Imports, exports, webhook payloads, or streamed bodies.
- Values larger than the per-entry limit.

Concurrent misses for one key share one in-flight computation. A failed computation is never cached. Metrics and structured logs cover hits, misses, coalesced requests, TTL eviction, LRU eviction, byte eviction, user invalidation, entry count, approximate bytes, and computation duration.

After every successful domain write:

1. Commit the domain change, audit record, and revision increment atomically.
2. If the write ran in the API process, evict all entries for that user immediately.
3. Publish the user ID through Postgres notification after commit.
4. Other API listeners evict that user. If notification delivery is interrupted, revision checking prevents a stale hit.

An explicit future Swift refresh optimization may send `Cache-Control: no-cache` and support `304 Not Modified`. ETag support is not required for this migration because the current Swift client treats a raw 304 as an unexpected status.

## 13. Worker and Job Semantics

HTTP and worker concerns are composed separately:

- `src/entrypoints/api.ts` starts only the HTTP server.
- `src/entrypoints/worker.ts` starts the jobs poller, scheduler, inbound-event consumer, and retention work.
- Importing `create-http-app.ts` or `create-worker.ts` has no startup side effects.

The manual commands are:

```text
pnpm dev:api
pnpm dev:worker
pnpm start:api
pnpm start:worker
pnpm db:migrate
```

Both processes validate environment variables before accepting work, report their role and build revision at startup, and close database connections during graceful shutdown. The worker stops claiming new work, finishes or safely releases its lease within a bounded shutdown window, and then exits.

Only one scheduler is active during cutover. Existing unique job constraints and active-run dedupe remain in force. Unknown webhook types are recorded as processed/no-op with structured metadata rather than retried forever.

## 14. Performance Strategy

The migration adds timing around routes, repositories, external Plaid calls, domain computation, serialization, and cache operations. Slow-query review uses actual `EXPLAIN ANALYZE` evidence from the sandbox schema before introducing new indexes.

Initial performance rules are:

- Retain keyset pagination for transaction lists.
- Preserve bounded import/export batches and streaming responses.
- Run independent dashboard/report database calls concurrently.
- Add indexes only for measured user/date/status/filter access patterns.
- Configure finite database pool, connection timeout, idle timeout, and statement timeout values.
- Coalesce identical expensive work.
- Key forecast cache entries by data revision, horizon, date, timezone where applicable, and algorithm version.
- Keep persisted summary tables outside the initial implementation unless indexed queries plus the five-minute LRU remain insufficient.

The local topology makes a CDN counterproductive: data is private, user-specific, and invalidated by local and webhook-driven writes.

## 15. Test Strategy

### 15.1 Database isolation without Docker

The existing Neon sandbox database may be used for tests, but tests never use its normal application schema. Each integration run creates a schema named `centsible_test_<run-id>`, applies the full migration chain inside it, sets the connection search path to that schema without falling back to `public`, runs database tests serially, and drops only that prefixed schema after the suite. Migration code is adapted so tables, enums, the Drizzle journal, and other test objects remain inside the generated schema; test cleanup never drops shared extensions or objects from `public`.

The test harness refuses to perform destructive setup unless all conditions hold:

- `NODE_ENV` is `test`.
- The selected schema begins with `centsible_test_`.
- The schema is not `public`.
- `DATABASE_ENVIRONMENT` is exactly `sandbox`.
- `ALLOW_SHARED_SANDBOX_TEST_DATABASE` is exactly `true` when `TEST_DATABASE_URL` equals `DATABASE_URL`.
- The database identity matches the explicitly configured sandbox identity.

Cleanup validates the exact generated schema name before dropping it. A failed run prints the retained schema name for manual inspection rather than broadening the cleanup target.

### 15.2 Test layers

The required matrix is:

- **Unit:** pure domain logic, money conversion, date/time behavior, cursors, cache eviction, single-flight behavior, mappers, error mapping, retries, and idempotency decisions.
- **Route:** auth, request validation, response mapping, status codes, headers, body limits, unknown routes, and consistent errors.
- **Contract:** all canonical routes and aliases, Swift-compatible success fixtures, unified error fixtures, money/timestamp rules, OpenAPI method/path parity, and documented security requirements.
- **Integration:** complete migrations, repository constraints, transactions, user revision updates, cache invalidation notifications, worker leases, abandoned-lease recovery, inbound-event retry/dead/replay behavior, Plaid cursor safety, and retention.
- **Build:** format check, lint, type check, unit and integration tests, clean production compile, and proof that compiled output excludes tests and starts without source workspace packages.
- **Cross-repository smoke:** `centsy` verified webhook insert, worker processing, Neon domain update, cache invalidation, and Swift request over Tailscale port `4000`.
- **Docs security:** docs-disabled 404 behavior, authenticated OpenAPI access, rejected unauthenticated access, Clerk sign-in, token refresh per request, and sign-out clearing console authorization.

Every source test is mapped to a migrated test, merged into an equivalent stronger test with an explicit mapping record, or documented as obsolete because the replaced topology makes it impossible or irrelevant. Tests are not silently dropped.

## 16. Migration Phases

### Phase 1: Pin and inventory

- Record the source SHA and dirty-file exclusion list.
- Produce a machine-readable route manifest from the pinned source.
- Inventory API, DB, shared contracts, shared logic, migrations, scripts, and tests.
- Capture representative Swift-compatible success and failure fixtures.

**Gate:** inventory totals and route manifest match the pinned source.

### Phase 2: Independent package

- Create one pnpm package with Node 20+ and ESM configuration.
- Internalize DB, contracts, and shared business logic.
- Add formatting, linting, type checking, testing, migration, API, and worker scripts.
- Configure production compilation to exclude tests.
- Add repository `AGENTS.md` guidance preserving the user's preferred completion summary, wizard-style questions when input is required, and explicit next-step reporting across future tasks.

**Gate:** the compiled server starts without any `centsible-claude` workspace resolution.

### Phase 3: Platform foundation

- Implement typed configuration, database lifecycle, Clerk auth context, body limits, request IDs, structured logging/redaction, typed errors, the global error mapper, cache primitives, user revisions, jobs, inbound events, and OpenAPI support.
- Separate API and worker composition.
- Establish the isolated Neon-schema test harness.

**Gate:** platform unit, integration, docs-security, build, and startup tests pass.

### Phase 4: Domain migration waves

Migrate vertical slices in dependency order:

1. Health, user identity mapping, categories, accounts, and transactions.
2. Dashboard, reports, bills, budgets, forecast, and rules.
3. Plaid client/link/sync, pipeline, jobs, notifications, and schedules.
4. User import/export/reset and cross-domain retention.

Each wave preserves the route contract, moves focused tests into the module-local `tests/` directory, formats migrated code, removes string-coded exception branching, and adds cache revision/invalidation behavior for writes.

**Gate:** each wave passes its unit, route, contract, integration, format, lint, and type-check subset before the next wave begins.

### Phase 5: Centsy edge integration

- Add the public Plaid webhook endpoint in `centsy`.
- Verify JWT and raw-body digest before durable insert.
- Change the schema mirror source to `centsible-api`.
- Restrict Centsy's database permissions.
- Prove retry behavior when Neon is unavailable.

**Gate:** duplicate delivery, invalid signature, database outage, worker interruption, retry, dead-event replay, and cursor-idempotency tests pass end to end.

### Phase 6: Full verification

Run the complete matrix:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm test:dist
pnpm db:migrate:test
```

Also compare the generated route/OpenAPI manifest with the pinned source manifest and run Swift-facing fixtures.

**Gate:** every required command passes from a clean install, and the compiled API and worker both start.

### Phase 7: Cutover and archive

1. Create a Neon restore point or confirm point-in-time recovery.
2. Confirm the new build SHA, environment, and migration plan.
3. Stop the old API, poller, and scheduler. Verify no old worker remains.
4. Apply additive migrations from `centsible-api`.
5. Start the new worker and verify readiness without duplicate scheduling.
6. Start the new API on port `4000`.
7. Run health, Clerk-authenticated Swagger, representative read/write, Plaid connection, worker, cache invalidation, and Swift/Tailscale smoke checks.
8. Observe logs, jobs, dead events, memory, cache size, and Neon activity during a seven-day soak.
9. Mark `centsible-claude` deprecated immediately after cutover and archive it read-only after the soak succeeds.

**Gate:** Swift works against the new server on port `4000`, webhook events are processed, no old worker is running, and the soak has no unresolved severity-one or severity-two regression.

## 17. Rollback

Initial migrations are additive and backward-compatible with the old application. If cutover smoke checks fail:

1. Stop the new API and worker.
2. Confirm that no new worker lease remains active.
3. Restart the old API and worker with their prior environment.
4. Leave additive schema objects in place; do not attempt a rushed destructive migration rollback.
5. Record events received during the interruption. The durable event table remains available for later replay by the repaired new worker.

Rollback does not restore traffic to the old direct Plaid webhook unless its public routing still exists. During the transition, Centsy continues storing valid events durably so they are not lost while the application tier is rolled back.

## 18. Configuration

The exact schema is typed and fails fast. It includes at least:

- `NODE_ENV`
- `PORT`, default `4000`
- `API_HOST`, default `127.0.0.1`; direct iOS access uses the Mac mini's Tailscale IP
- `DATABASE_URL`
- `DATABASE_ENVIRONMENT`, set to `sandbox` for the current Neon database
- `TEST_DATABASE_URL`, allowed to equal `DATABASE_URL` only under the guarded sandbox policy
- `ALLOW_SHARED_SANDBOX_TEST_DATABASE`, default `false`
- `TEST_SCHEMA_PREFIX`, fixed to `centsible_test_` unless code and safety tests change together
- `CLERK_SECRET_KEY`
- `CLERK_PUBLISHABLE_KEY`
- `PLAID_CLIENT_ID`
- `PLAID_SECRET`
- `PLAID_ENV`
- `API_DOCS_ENABLED`, default `false`
- `CACHE_TTL_MS`, default `300000`
- `CACHE_MAX_ENTRIES`, default `1000`
- `CACHE_MAX_BYTES`, default `67108864`
- `CACHE_MAX_ENTRY_BYTES`, default `2097152`
- `WORKER_ID`, defaulting to a generated process identity
- Existing job polling, scheduling, rate-limit, retention, and body-limit settings after they are inventoried and normalized

`.env.example` documents names and safe examples but contains no real credentials. Startup logs list enabled capabilities and numeric limits without printing secrets or full database URLs.

## 19. Risks and Mitigations

| Risk                                    | Mitigation                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Swift schema drift                      | Preserve success shapes, add fixtures and contract tests, keep money as strings.                      |
| Source changes during migration         | Pin the source commit and require explicit review before importing later source changes.              |
| Accidental sandbox-data deletion        | Unique prefixed test schema, no `public` fallback, strict runtime guards, exact-target cleanup.       |
| Missed cross-process cache eviction     | Transactional revision increment, Postgres notification, and revision validation before a cache hit.  |
| Duplicate workers during cutover        | Stop and verify the old scheduler before starting the new worker; retain unique job constraints.      |
| Lost Plaid webhook                      | Acknowledge only after Neon insert commits; retry on database outage; leased processing with replay.  |
| Duplicate Plaid webhook                 | Active-work dedupe plus cursor-based idempotent synchronization.                                      |
| Password leakage through docs           | Clerk-managed sign-in component; the API never receives or stores the password; token kept in memory. |
| Production build works only from source | Dist startup test from a clean install; no workspace imports; tests excluded from output.             |
| Over-refactoring changes behavior       | Move by vertical slice, preserve route fixtures, and require a green gate after each wave.            |
| Cache memory growth                     | Entry, byte, per-entry, and TTL bounds with observable eviction reasons.                              |
| Raw webhook retention                   | Least-privileged access, log redaction, and scheduled 30/90-day retention.                            |

## 20. Documentation and Handoff Requirements

The implementation must produce:

- Root README with local API, worker, migration, test, Swagger, Tailscale, and cutover instructions.
- `.env.example` with safe descriptions.
- Root `AGENTS.md` containing the user's standing collaboration preferences.
- Architecture and module-boundary documentation.
- Generated OpenAPI 3.1 document and authenticated Swagger UI.
- Route parity manifest and source-test mapping.
- Centsy webhook-ingress contract.
- Manual runbook for API, worker, migrations, dead-event replay, cache inspection, cutover, and rollback.

The implementation plan following this spec must be suitable for a lower-cost coding model. It will use atomic tasks, exact file targets, explicit red/green tests, commands, expected outcomes, domain-by-domain checkpoints, and review gates. No task may combine several domain migrations without an intermediate verification point.

## 21. Definition of Done

The work is done only when:

- The target repository is independent of `centsible-claude` at install, build, test, and runtime.
- Every canonical route and deprecated alias passes its declared compatibility or relocation test.
- The OpenAPI document contains every registered HTTP operation and authenticated browser requests work through Clerk.
- All migrated tests and new platform/contract/integration tests pass without Docker.
- Tests use only isolated prefixed schemas in the approved sandbox Neon database.
- The five-minute bounded LRU serves no stale result after an API or worker domain write.
- Centsy acknowledges only durably stored verified webhooks.
- Worker retry, abandoned lease, dead event, and manual replay behavior are proven.
- The clean production build excludes tests and both compiled entrypoints start.
- The old worker is not running after cutover.
- Swift succeeds over the Tailscale URL on port `4000`.
- The cutover and rollback runbook has been exercised at least once in the sandbox environment.
- `centsible-claude` is marked deprecated and then archived after the seven-day soak.
