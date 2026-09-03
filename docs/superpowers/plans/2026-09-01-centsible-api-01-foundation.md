# Centsible API Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an independently buildable backend package with safe Neon tests, typed HTTP infrastructure, authenticated Swagger UI, separate entrypoints, and the reusable five-minute cache foundation.

**Architecture:** Platform code lives under `src/platform`; startup is composed under `src/app` and invoked only by `src/entrypoints`. Database schema and migrations are owned locally, and integration tests isolate themselves in generated schemas inside the existing Neon sandbox.

**Tech Stack:** Node.js 20+, pnpm 9+, TypeScript ESM, Hono, Zod, Drizzle ORM, postgres.js, Vitest, Pino, Clerk, OpenAPI 3.1, Swagger UI, `lru-cache`.

**Spec:** `docs/superpowers/specs/2026-09-01-centsible-api-migration-design.md`

## Global Constraints

- Source commit is `06d3972a7ffc88b6c65a4bab4ad47487e55b800c`.
- Runtime build must not import `@centsible/*` workspace packages or source files outside this repository.
- API defaults to port `4000`; API and worker start independently.
- Integration tests require `NODE_ENV=test`, `DATABASE_ENVIRONMENT=sandbox`, and a generated `centsible_test_<run-id>` schema.
- Cache defaults are 300,000 ms, 1,000 entries, 64 MiB total, and 2 MiB per entry.
- Do not modify the untracked `.idea/` directory.

---

### Task 1: Package, toolchain, and repository guidance

**Files:**

- Create: `package.json`
- Create: `pnpm-lock.yaml`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `vitest.config.ts`
- Create: `AGENTS.md`
- Create: `tests/build/package-scripts.test.ts`

**Interfaces:**

- Produces scripts `dev:api`, `dev:worker`, `start:api`, `start:worker`, `build`, `typecheck`, `lint`, `format`, `format:check`, `test`, `test:integration`, `test:dist`, `db:migrate`, and `db:migrate:test`.
- Produces Node ESM output in `dist/` using `module` and `moduleResolution` set to `NodeNext`.

- [ ] **Step 1: Install the package manifest and dependencies**

Create a private ESM package requiring Node 20 and pnpm 9, then run:

```bash
pnpm add @clerk/backend @clerk/clerk-js @hono/node-server @hono/swagger-ui @hono/zod-openapi drizzle-orm hono jose lru-cache pino plaid postgres tweetnacl tweetnacl-util zod
pnpm add -D @eslint/js @types/node eslint prettier tsx typescript typescript-eslint vitest
```

Use these exact script bodies:

```json
{
  "dev:api": "tsx watch --env-file-if-exists=.env src/entrypoints/api.ts",
  "dev:worker": "tsx watch --env-file-if-exists=.env src/entrypoints/worker.ts",
  "start:api": "node --env-file-if-exists=.env dist/entrypoints/api.js",
  "start:worker": "node --env-file-if-exists=.env dist/entrypoints/worker.js",
  "build": "tsc -p tsconfig.build.json",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "lint": "eslint .",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "test": "vitest run --exclude tests/integration/**",
  "test:integration": "vitest run tests/integration --poolOptions.threads.singleThread=true",
  "test:dist": "node scripts/test-dist.mjs",
  "db:migrate": "tsx database/migrate.ts",
  "db:migrate:test": "tsx scripts/migrate-test-schema.ts"
}
```

- [ ] **Step 2: Write the package-contract test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("package scripts", () => {
  it("exposes separate API and worker lifecycle commands", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["start:api"]).toContain("dist/entrypoints/api.js");
    expect(pkg.scripts["start:worker"]).toContain("dist/entrypoints/worker.js");
    expect(pkg.scripts.build).toContain("tsconfig.build.json");
  });
});
```

- [ ] **Step 3: Configure strict TypeScript and test/build exclusions**

`tsconfig.json` includes `src`, `database`, `scripts`, and `tests`, enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `resolveJsonModule`, and `noEmit`. `tsconfig.build.json` extends it, enables emit to `dist`, and includes only `src`, `database`, and runtime scripts while excluding every `*.test.ts` and `tests/**` file.

- [ ] **Step 4: Record standing collaboration and environment guidance**

`AGENTS.md` must state: finish each task with what changed, verification evidence, inputs still needed through one-question-at-a-time wizard prompts, and the next possible step. `.env.example` lists names from spec section 18 without secrets and sets `PORT=4000`, `API_DOCS_ENABLED=true`, `CACHE_TTL_MS=300000`, and `DATABASE_ENVIRONMENT=sandbox` as local examples.

- [ ] **Step 5: Run the task gate**

Run:

```bash
pnpm test tests/build/package-scripts.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
```

Expected: all four commands exit `0`.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json eslint.config.js .prettierrc.json .prettierignore .gitignore .env.example vitest.config.ts AGENTS.md tests/build/package-scripts.test.ts
git commit -m "chore: bootstrap independent API package"
```

### Task 2: Pinned-source inventory and parity manifest

**Files:**

- Create: `scripts/verify-source-pin.mjs`
- Create: `tests/contract/source-route-manifest.json`
- Create: `tests/contract/source-test-manifest.json`
- Create: `tests/contract/source-inventory.test.ts`

**Interfaces:**

- Consumes source root from `CENTSIBLE_SOURCE_ROOT`, defaulting to `/Users/samdiga/code/centsible-claude`.
- Produces immutable JSON manifests with `sourceCommit`, routes, aliases, source test files, DB migrations, and copied support files.

- [ ] **Step 1: Write the failing manifest test**

```ts
import routes from "./source-route-manifest.json";
import tests from "./source-test-manifest.json";
import { describe, expect, it } from "vitest";

describe("pinned source inventory", () => {
  it("contains every canonical handler and recurring alias", () => {
    expect(routes.sourceCommit).toBe(
      "06d3972a7ffc88b6c65a4bab4ad47487e55b800c",
    );
    expect(routes.canonical).toHaveLength(54);
    expect(routes.aliases).toHaveLength(9);
  });

  it("accounts for all API test files", () => {
    expect(tests.apiFiles).toHaveLength(40);
    expect(tests.sharedSupportFiles).toHaveLength(11);
  });
});
```

- [ ] **Step 2: Verify the test fails before manifests exist**

Run: `pnpm test tests/contract/source-inventory.test.ts`

Expected: FAIL because the JSON manifests are missing.

- [ ] **Step 3: Create exact manifests and pin verifier**

List every method/path from spec section 8 as separate JSON objects. Add nine `/recurring` equivalents of the bills routes. List the 40 exact `apps/api/src/**/*.test.ts` paths, the 11 exact test files under `packages/shared-types/src` and `packages/shared-logic/src`, and all 13 SQL migration paths. `verify-source-pin.mjs` runs `git -C <root> rev-parse HEAD`, compares the result to the pinned SHA, and exits nonzero before copying when it differs.

```js
const expected = "06d3972a7ffc88b6c65a4bab4ad47487e55b800c";
if (actual !== expected) {
  throw new Error(`Source commit ${actual} does not match pinned ${expected}`);
}
```

- [ ] **Step 4: Run the inventory gate**

```bash
node scripts/verify-source-pin.mjs
pnpm test tests/contract/source-inventory.test.ts
```

Expected: pin verification succeeds and both manifest assertions pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-source-pin.mjs tests/contract
git commit -m "test: pin source route and test inventory"
```

### Task 3: Database ownership and isolated Neon test schemas

**Files:**

- Create: `database/schema/schema.ts`
- Create: `database/schema/index.ts`
- Create: `database/migrations/` from source `packages/db/drizzle/`
- Create: `database/migrate.ts`
- Create: `src/platform/database/client.ts`
- Create: `src/platform/database/types.ts`
- Create: `tests/support/test-database.ts`
- Create: `tests/integration/database/migrations.test.ts`
- Create: `scripts/migrate-test-schema.ts`

**Interfaces:**

- Produces `getDb(): Db`, `closeDb(): Promise<void>`, and `withTransaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T>`.
- Produces `createIsolatedTestDatabase(): Promise<{ db: Db; schemaName: string; cleanup(): Promise<void> }>`.

- [ ] **Step 1: Copy the pinned schema and migration history**

Run the pin verifier, then copy `packages/db/src/schema.ts` to `database/schema/schema.ts`, all seven generated migrations, six raw migrations, and `meta/` to `database/migrations/`. Move the source client and migrator behavior into the target interfaces; replace all `@centsible/db` imports with local relative imports.

- [ ] **Step 2: Write the failing isolation tests**

```ts
it("creates a non-public prefixed schema and migrates it", async () => {
  const testDb = await createIsolatedTestDatabase();
  expect(testDb.schemaName).toMatch(/^centsible_test_[a-z0-9_]+$/);
  expect(testDb.schemaName).not.toBe("public");
  const rows = await testDb.db.execute(
    sql`select to_regclass('users') as users`,
  );
  expect(rows[0]?.users).toBe("users");
  await testDb.cleanup();
});

it("refuses shared sandbox access without the explicit guard", async () => {
  process.env.ALLOW_SHARED_SANDBOX_TEST_DATABASE = "false";
  await expect(createIsolatedTestDatabase()).rejects.toThrow(
    "shared sandbox test database",
  );
});
```

- [ ] **Step 3: Run the tests to verify the missing harness fails**

Run: `pnpm test:integration tests/integration/database/migrations.test.ts`

Expected: FAIL because `createIsolatedTestDatabase` is not implemented.

- [ ] **Step 4: Implement schema-scoped migration and cleanup**

Validate all five spec guards before `CREATE SCHEMA`. Quote the generated identifier through a dedicated `quoteIdentifier` function that accepts only `/^centsible_test_[a-z0-9_]+$/`. Set `search_path` to the generated schema only, keep the Drizzle journal in that schema, and drop exactly that schema in normal cleanup. Never issue `DROP SCHEMA public`, `DROP DATABASE`, or unqualified bulk deletes.

- [ ] **Step 5: Run the database gate**

```bash
pnpm test:integration tests/integration/database/migrations.test.ts
pnpm typecheck
```

Expected: migration and refusal tests pass; the normal sandbox schema remains untouched.

- [ ] **Step 6: Commit**

```bash
git add database src/platform/database tests/support/test-database.ts tests/integration/database scripts/migrate-test-schema.ts
git commit -m "feat: own database schema with isolated Neon tests"
```

### Task 4: Typed configuration, logging, and lifecycle

**Files:**

- Create: `src/platform/config/env.ts`
- Create: `src/platform/config/env.test.ts`
- Create: `src/platform/logging/logger.ts`
- Create: `src/platform/logging/redaction.ts`
- Create: `src/platform/logging/redaction.test.ts`
- Create: `src/platform/http/shutdown.ts`

**Interfaces:**

- Produces `loadEnv(source?: NodeJS.ProcessEnv): Env` with the exact config names and defaults in spec section 18.
- Produces `logger` and `redactLogValue(value: unknown): unknown`.
- Produces `installGracefulShutdown(close: () => Promise<void>): () => void`.

- [ ] **Step 1: Write failing env and redaction tests**

```ts
it("uses the approved local defaults", () => {
  const env = loadEnv(minimalValidEnv);
  expect(env.PORT).toBe(4000);
  expect(env.CACHE_TTL_MS).toBe(300_000);
  expect(env.CACHE_MAX_BYTES).toBe(67_108_864);
});

it("redacts nested secrets and financial payload text", () => {
  expect(
    redactLogValue({ accessToken: "secret", transactionName: "Rent" }),
  ).toEqual({
    accessToken: "[REDACTED]",
    transactionName: "[REDACTED]",
  });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test src/platform/config/env.test.ts src/platform/logging/redaction.test.ts`

Expected: FAIL on missing modules.

- [ ] **Step 3: Implement the typed configuration and redaction allowlist**

Use Zod coercion for numeric and boolean values. Reject invalid ports, nonpositive cache limits, production shared-test flags, and missing Clerk/Plaid/database secrets in runtime modes that need them. Redaction walks arrays and plain objects, replacing keys matching `/token|secret|password|accountNumber|transactionName|payload/i`.

- [ ] **Step 4: Run the task gate and commit**

```bash
pnpm test src/platform/config/env.test.ts src/platform/logging/redaction.test.ts
pnpm typecheck
git add src/platform/config src/platform/logging src/platform/http/shutdown.ts
git commit -m "feat: add typed configuration and safe logging"
```

### Task 5: Unified HTTP errors, request context, limits, and Clerk auth

**Files:**

- Create: `src/platform/errors/app-error.ts`
- Create: `src/platform/errors/error-handler.ts`
- Create: `src/platform/errors/error-handler.test.ts`
- Create: `src/platform/http/hono-env.ts`
- Create: `src/platform/http/request-id.ts`
- Create: `src/platform/http/request-log.ts`
- Create: `src/platform/http/body-limit.ts`
- Create: `src/platform/auth/clerk-auth.ts`
- Create: `src/platform/auth/clerk-auth.test.ts`
- Create: `src/platform/auth/user-identity.repository.ts`
- Create: `src/platform/auth/user-identity.repository.test.ts`

**Interfaces:**

- Produces `AppError`, `AuthenticationError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `ValidationError`, `RateLimitError`, `UpstreamError`.
- Produces typed Hono variables `{ requestId: string; userId: string; clerkUserId: string }`.
- Produces `clerkAuth(): MiddlewareHandler<AppEnv>` and `handleError(err, c): Response`.
- Produces `resolveOrCreateInternalUser(clerkIdentity, db): Promise<string>` from the lifted source users repository.

- [ ] **Step 1: Write the failing envelope test**

```ts
it("maps every expected error to the stable envelope", async () => {
  const response = await testApp.request("/missing");
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({
    error: { code: "NOT_FOUND", message: expect.any(String) },
    requestId: expect.any(String),
  });
  expect(response.headers.get("x-request-id")).toBeTruthy();
});
```

- [ ] **Step 2: Run the test and confirm the legacy shape is absent**

Run: `pnpm test src/platform/errors/error-handler.test.ts`

Expected: FAIL because the typed app and handler do not exist.

- [ ] **Step 3: Lift and refactor the source middleware**

Lift `errors.ts`, `middleware/requestId.ts`, `middleware/requestLog.ts`, `middleware/bodyLimit.ts`, `middleware/clerkAuth.ts`, and `repos/users.ts`. Move user lookup/create into `user-identity.repository.ts`. Replace unsafe context casts with `AppEnv`, convert all body-limit and not-found failures to `AppError`, preserve the source Clerk-user mapping cache, and ensure a 401 occurs before any route write.

- [ ] **Step 4: Add edge-case tests**

Test missing, malformed, expired, and valid Clerk tokens; repeated 401 behavior; default and import body limits; Zod detail paths; unknown routes; request-ID propagation; and redacted unexpected-error logs.

- [ ] **Step 5: Run the task gate and commit**

```bash
pnpm test src/platform/errors src/platform/auth
pnpm typecheck
git add src/platform/errors src/platform/http src/platform/auth
git commit -m "feat: unify HTTP errors and Clerk request context"
```

### Task 6: Side-effect-free app composition and entrypoint shells

**Files:**

- Create: `src/app/create-http-app.ts`
- Create: `src/app/create-worker.ts`
- Create: `src/entrypoints/api.ts`
- Create: `src/entrypoints/worker.ts`
- Create: `src/modules/health/health.routes.ts`
- Create: `src/modules/health/health.routes.test.ts`
- Create: `src/modules/health/index.ts`
- Create: `scripts/test-dist.mjs`

**Interfaces:**

- Produces `createHttpApp(deps?: HttpAppDependencies): OpenAPIHono<AppEnv>` without listening.
- Produces `createWorker(deps?: WorkerDependencies): WorkerRuntime` with `start()` and `stop()`.

- [ ] **Step 1: Write failing composition tests**

```ts
it("creates an app without opening a socket or starting jobs", async () => {
  const app = createHttpApp();
  const response = await app.request("/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: "ok",
    service: "centsible-api",
  });
  expect(startJobsSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and observe failure**

Run: `pnpm test src/modules/health/health.routes.test.ts`

Expected: FAIL because composition does not exist.

- [ ] **Step 3: Implement composition and process entrypoints**

`api.ts` loads env, calls `createHttpApp`, starts `@hono/node-server` on `PORT`, and installs shutdown. `worker.ts` loads env, creates the worker, starts it, and installs shutdown. `create-worker.ts` returns a no-op shell until Plan 3 supplies pollers; importing either app factory must create no sockets, timers, or signal handlers.

- [ ] **Step 4: Implement the dist smoke script**

`scripts/test-dist.mjs` imports `dist/app/create-http-app.js`, requests `/health` in memory, asserts status 200, then imports `dist/app/create-worker.js`, calls `start()` and `stop()` with disabled adapters, and exits 0.

- [ ] **Step 5: Run the task gate and commit**

```bash
pnpm test src/modules/health/health.routes.test.ts
pnpm build
pnpm test:dist
git add src/app src/entrypoints src/modules/health scripts/test-dist.mjs
git commit -m "feat: separate API and worker entrypoints"
```

### Task 7: Generated OpenAPI and Clerk-authenticated Swagger UI

**Files:**

- Create: `src/platform/openapi/document.ts`
- Create: `src/platform/openapi/docs-page.ts`
- Create: `src/platform/openapi/docs.routes.ts`
- Create: `src/platform/openapi/docs.routes.test.ts`
- Modify: `src/app/create-http-app.ts`

**Interfaces:**

- Produces `registerDocs(app: OpenAPIHono<AppEnv>, env: Env): void`.
- Serves `/docs` only when enabled and `/openapi.json` only after Clerk auth.
- Produces an OpenAPI `bearerAuth` security scheme and route tags used by all later modules.

- [ ] **Step 1: Write failing docs-security tests**

```ts
it("hides docs when disabled", async () => {
  const app = createHttpApp({ env: { ...testEnv, API_DOCS_ENABLED: false } });
  expect((await app.request("/docs")).status).toBe(404);
});

it("protects the OpenAPI document with Clerk", async () => {
  const app = createHttpApp({ env: { ...testEnv, API_DOCS_ENABLED: true } });
  expect((await app.request("/openapi.json")).status).toBe(401);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test src/platform/openapi/docs.routes.test.ts`

Expected: FAIL because docs routes are absent.

- [ ] **Step 3: Implement the authenticated docs shell**

Use `@hono/zod-openapi` for document generation and `@hono/swagger-ui` for the console. The HTML loads ClerkJS with `CLERK_PUBLISHABLE_KEY`, mounts Clerk's sign-in component when signed out, calls `Clerk.session.getToken()` before fetching the spec and before each Try It request, and stores the returned token only in a closure variable. Add a sign-out button that clears Swagger authorization before calling Clerk sign-out.

- [ ] **Step 4: Test token injection and route parity hooks**

Assert the page contains no Clerk secret key, no password input implemented by this repository, no local-storage token writes, and code that awaits `getToken()` inside the request interceptor. Add a test helper `listOpenApiOperations(document)` for later parity checks.

- [ ] **Step 5: Run the task gate and commit**

```bash
pnpm test src/platform/openapi
pnpm typecheck
git add src/platform/openapi src/app/create-http-app.ts
git commit -m "feat: add Clerk-authenticated Swagger console"
```

### Task 8: Bounded LRU and user revision invalidation

**Files:**

- Create: `src/platform/cache/cache-policy.ts`
- Create: `src/platform/cache/response-cache.ts`
- Create: `src/platform/cache/response-cache.test.ts`
- Create: `src/platform/cache/user-revisions.repository.ts`
- Create: `src/platform/cache/user-revisions.test.ts`
- Create: `database/schema/cache.ts`
- Create: `database/migrations/0007_user_data_versions.sql`
- Modify: `database/schema/index.ts`

**Interfaces:**

- Produces `ResponseCache.getOrCompute<T>(key: CacheKey, compute: () => Promise<T>): Promise<T>`.
- Produces `ResponseCache.invalidateUser(userId: string): void`.
- Produces `getUserRevision(userId, db): Promise<bigint>` and `incrementUserRevision(userId, tx): Promise<bigint>`.
- Produces `withUserMutation<T>(userId: string, mutate: (tx: DbTransaction) => Promise<T>): Promise<T>` that commits the write/revision, evicts locally, and publishes invalidation.

- [ ] **Step 1: Write failing cache-policy tests**

```ts
it("expires an entry after five absolute minutes without sliding", async () => {
  const clock = new FakeClock();
  const cache = createResponseCache({ clock, ttlMs: 300_000 });
  await cache.getOrCompute(key, async () => "first");
  clock.advance(299_999);
  expect(await cache.getOrCompute(key, async () => "second")).toBe("first");
  clock.advance(1);
  expect(await cache.getOrCompute(key, async () => "second")).toBe("second");
});

it("coalesces concurrent misses and clears every user entry", async () => {
  const compute = vi.fn(async () => "value");
  await Promise.all([
    cache.getOrCompute(key, compute),
    cache.getOrCompute(key, compute),
  ]);
  expect(compute).toHaveBeenCalledTimes(1);
  cache.invalidateUser(key.userId);
  await cache.getOrCompute(key, compute);
  expect(compute).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test src/platform/cache/response-cache.test.ts`

Expected: FAIL because cache interfaces are missing.

- [ ] **Step 3: Implement bounded cache behavior**

Use `lru-cache` with absolute TTL and no TTL refresh on access. Reject entries larger than 2 MiB. Track serialized bytes, maintain a `Map<userId, Set<cacheKey>>` for immediate eviction, and keep a `Map<cacheKey, Promise<unknown>>` for single-flight work. Never cache a rejected computation.

- [ ] **Step 4: Implement transactional revisions and notifications**

Add `user_data_versions`. Upsert revision `1` for the first write and increment thereafter. Publish channel `centsible_user_data_changed` with the internal user ID only after the mutation transaction commits. The cache-hit path reads the current revision before returning the cached value; a mismatch evicts and recomputes.

- [ ] **Step 5: Add integration tests**

Prove revision increments roll back with a failed mutation, notification causes user eviction, a missed notification is caught by revision comparison, byte/entry limits evict least-recently-used data, and errors/oversized values are not cached.

- [ ] **Step 6: Run the foundation gate and commit**

```bash
pnpm test src/platform/cache
pnpm test:integration tests/integration/database
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test:dist
git add src/platform/cache database/schema database/migrations/0007_user_data_versions.sql
git commit -m "feat: add five-minute LRU with write invalidation"
```

## Plan 1 Completion Gate

> **Post-foundation addendum:** Plan 1 intentionally captured 54 routes at the immutable base pin. Plan 2 extends that manifest with one additive account deletion route and the three exact approved supplemental SHAs, producing the effective 55-route inventory without repinning source `HEAD`.

- [ ] `rg "@centsible/" src database scripts` returns no matches.
- [ ] `find dist -name '*.test.js' -o -path '*/tests/*'` returns no files.
- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, and `pnpm test:dist` all exit `0`.
- [ ] Commit SHAs and command evidence are recorded before Plan 2 starts.
