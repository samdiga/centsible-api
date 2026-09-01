# Centsy Plaid Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the co-located `centsy` Next.js app the safe public Plaid webhook ingress and write verified events durably to the API-owned Neon table.

**Architecture:** A Next.js App Router route reads the exact raw body, verifies Plaid's ES256 JWT and body digest, validates a bounded JSON envelope, and inserts one pending event. Centsy mirrors API-owned schema source but never migrates or writes financial domain tables.

**Tech Stack:** Next.js 16 App Router, TypeScript, Plaid SDK, JOSE, Drizzle ORM, postgres.js, Neon Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-centsible-api-migration-design.md`

## Global Constraints

- This plan modifies `/Users/samdiga/code/centsy`, which requires separate filesystem/write authorization at execution time.
- Follow `/Users/samdiga/code/centsy/AGENTS.md` and preserve unrelated changes.
- Centsy may insert only into `inbound_webhook_events`; it does not run API migrations or domain services.
- Acknowledge with 2xx only after the Neon insert commits.
- Reject invalid signature/digest with 400, unsupported content type with 415, oversized body with 413, and Neon failure with 503.
- Never log raw bodies, verification JWTs, provider item IDs, or financial error messages.

---

### Task 1: Mirror API-owned schema sources

**Files in `centsy`:**

- Modify: `scripts/sync-schema.mjs`
- Create: `src/db/inbound-webhook-events.schema.ts`
- Create: `src/db/index.ts`
- Create: `src/db/schema-sync.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- `CENTSIBLE_API_PATH` overrides the sibling source path; default is `../centsible-api`.
- Full mirror source is `database/schema/schema.ts`; inbound-event mirror source is `database/schema/inbound-webhook-events.ts`.
- `npm run schema:check` fails on drift when the sibling API checkout exists and succeeds from committed mirrors on Vercel.

- [ ] **Step 1: Add the test runner and write a failing sync test**

Run `npm install --save-dev vitest`, add `"test": "vitest run"`, then create:

```ts
it("names centsible-api as the schema owner and source", () => {
  const script = readFileSync("scripts/sync-schema.mjs", "utf8");
  expect(script).toContain("CENTSIBLE_API_PATH");
  expect(script).toContain("../centsible-api");
  expect(script).not.toContain("CENTSIBLE_CLAUDE_PATH");
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/db/schema-sync.test.ts`

Expected: FAIL because the script still points at `centsible-claude`.

- [ ] **Step 3: Refactor the mirror script**

Keep the current `--write` and `--check` behavior, Vercel no-source fallback, commit stamping, and generated header. Change ownership text and source paths to `centsible-api`. Mirror the API's self-contained inbound-event schema into `src/db/inbound-webhook-events.schema.ts`; export the full and narrow mirrors from hand-authored `src/db/index.ts` so the generated `src/db/schema.ts` remains a verbatim file.

- [ ] **Step 4: Verify and commit in Centsy**

```bash
npm run schema:sync
npm run schema:check
npm test -- src/db/schema-sync.test.ts
npm run typecheck
git add scripts/sync-schema.mjs src/db package.json package-lock.json
git commit -m "chore: mirror schema from centsible-api"
```

### Task 2: Verify Plaid webhooks from the exact raw body

**Files in `centsy`:**

- Create: `src/lib/plaid/client.ts`
- Create: `src/lib/plaid/verify-webhook.ts`
- Create: `src/lib/plaid/verify-webhook.test.ts`
- Create: `src/lib/plaid/webhook-schema.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Produces `verifyPlaidWebhook(rawBody: string, verificationJwt: string): Promise<VerifiedPlaidWebhook>`.
- `VerifiedPlaidWebhook` includes `webhookType`, `webhookCode`, `providerItemId`, parsed `payload`, `payloadDigest`, and deterministic `dedupeKey`.

- [ ] **Step 1: Install runtime dependencies and write failing verification tests**

Run: `npm install jose plaid postgres zod`

```ts
it("accepts ES256 JWT whose request_body_sha256 matches exact bytes", async () => {
  await expect(
    verifyPlaidWebhook(rawBody, await sign(rawBody)),
  ).resolves.toMatchObject({
    webhookType: "TRANSACTIONS",
    webhookCode: "SYNC_UPDATES_AVAILABLE",
  });
});

it.each(["missing", "wrong-algorithm", "wrong-digest", "invalid-json"])(
  "rejects %s input",
  async (kind) => {
    await expect(verifyFixture(kind)).rejects.toThrow(WebhookVerificationError);
  },
);
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/lib/plaid/verify-webhook.test.ts`

Expected: FAIL because verification code is missing.

- [ ] **Step 3: Implement verification without copying dispatch behavior**

Lift only verification and JWKS-cache behavior from pinned source `apps/api/src/services/plaid/webhook.ts`. Require `Plaid-Verification`, `kid`, ES256, valid signature, and exact SHA-256 digest. Cache public JWKs by key ID for 24 hours. After verification, parse Zod fields `webhook_type`, `webhook_code`, optional `item_id`, and passthrough payload. Compute dedupe SHA-256 over provider/type/code/item/digest. Do not look up users or dispatch domain work.

- [ ] **Step 4: Verify and commit in Centsy**

```bash
npm test -- src/lib/plaid/verify-webhook.test.ts
npm run lint
npm run typecheck
git add src/lib/plaid package.json package-lock.json
git commit -m "feat: verify Plaid webhook signatures"
```

### Task 3: Durable webhook route and narrow database adapter

**Files in `centsy`:**

- Create: `src/db/client.ts`
- Create: `src/db/inbound-events.ts`
- Create: `src/db/inbound-events.test.ts`
- Create: `src/app/api/plaid/webhook/route.ts`
- Create: `src/app/api/plaid/webhook/route.test.ts`
- Create: `.env.example`
- Modify: `README.md`

**Interfaces:**

- Produces `insertInboundWebhookEvent(event): Promise<{ id: string }>` using only the mirrored event table.
- Exposes `POST /api/plaid/webhook` on `centsy.dev`.

- [ ] **Step 1: Write failing HTTP outcome tests**

```ts
expect((await POST(request({ contentType: "text/plain" }))).status).toBe(415);
expect((await POST(request({ body: oversizedJson }))).status).toBe(413);
expect((await POST(request({ jwt: invalidJwt }))).status).toBe(400);
expect((await POST(validRequest())).status).toBe(200);
expect(insertInboundWebhookEvent).toHaveBeenCalledOnce();
insertInboundWebhookEvent.mockRejectedValueOnce(
  new Error("database unavailable"),
);
expect((await POST(validRequest())).status).toBe(503);
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/app/api/plaid/webhook/route.test.ts`

Expected: FAIL because the route is missing.

- [ ] **Step 3: Implement bounded raw-body handling and durable insert**

Require `application/json`. Reject declared or measured bodies above 262,144 bytes. Read `request.text()` exactly once, verify before parsing through the verifier, insert `provider='plaid'`, extracted dispatch fields, parsed payload, digest, dedupe key, `status='pending'`, `attempts=0`, and `availableAt=now`. Return `{ "ok": true }` only after insert succeeds. Log only request ID, safe verification code, status, and duration.

- [ ] **Step 4: Add database adapter tests**

Against the generated API test schema, prove all fields persist, two identical deliveries create two rows, no domain table changes, and a failed insert yields no partial row. Use the least-privileged Centsy connection string when it becomes available; do not make role creation a Vercel runtime action.

- [ ] **Step 5: Document environment and verify**

Document `DATABASE_URL`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, and the public webhook URL. Run:

```bash
npm test
npm run schema:check
npm run lint
npm run typecheck
npm run build
```

Expected: every command exits `0`.

- [ ] **Step 6: Commit in Centsy**

```bash
git add src/app/api/plaid/webhook src/db src/lib/plaid .env.example README.md package.json package-lock.json
git commit -m "feat: durably ingest Plaid webhooks"
```

### Task 4: Cross-repository event contract smoke test

**Files in `centsible-api`:**

- Create: `tests/contract/centsy-webhook-fixtures.ts`
- Create: `tests/integration/centsy-webhook-flow.test.ts`
- Create: `docs/centsy-webhook-contract.md`
- Create: `database/security/centsy-ingress-grants.sql`

**Interfaces:**

- Uses Centsy's verifier and insert contract as an external producer of API-owned `InboundWebhookEvent` rows.
- Proves the local API worker consumes the same row shape.

- [ ] **Step 1: Write the failing end-to-end contract test**

```ts
const inserted = await insertFixtureFromCentsy(validSyncWebhook);
await runOneInboundEventPoll();
expect(await getInboundEvent(inserted.id)).toMatchObject({
  status: "processed",
});
expect(await getActivePipelineRun(userId)).toMatchObject({
  trigger: "webhook",
});
expect(await getUserRevision(userId)).toBeGreaterThan(revisionBefore);
```

- [ ] **Step 2: Run and confirm any producer/consumer mismatch**

Run: `pnpm test:integration tests/integration/centsy-webhook-flow.test.ts`

Expected before alignment: FAIL if mirrored names or enum values differ.

- [ ] **Step 3: Align only the contract boundary**

Fix schema mirror/export names, timestamp defaults, JSON payload typing, or worker DTO parsing until Centsy output is consumed without a translation copy. Document request limits, statuses, table fields, retention, and ownership in `docs/centsy-webhook-contract.md`. Add reviewed SQL that grants a pre-created `centsy_ingress` role `USAGE` on the application schema and `INSERT` on only the inbound-event columns; Centsy generates the UUID before insert and does not use `RETURNING`, so it needs no domain-table or broad read permission.

- [ ] **Step 4: Verify and commit in the API repository**

```bash
pnpm test:integration tests/integration/centsy-webhook-flow.test.ts
pnpm typecheck
git add tests/contract/centsy-webhook-fixtures.ts tests/integration/centsy-webhook-flow.test.ts docs/centsy-webhook-contract.md database/security/centsy-ingress-grants.sql
git commit -m "test: verify Centsy webhook handoff"
```

## Plan 4 Completion Gate

- [ ] Centsy schema ownership text contains no `centsible-claude` reference.
- [ ] Invalid JWT/digest/JSON, wrong content type, oversized body, Neon failure, duplicate delivery, and successful delivery tests pass.
- [ ] Centsy writes no financial domain table.
- [ ] The API worker processes a Centsy-created event and invalidates the affected user cache.
- [ ] Both repositories have clean lint, type-check, test, and build results recorded with their commit SHAs.
