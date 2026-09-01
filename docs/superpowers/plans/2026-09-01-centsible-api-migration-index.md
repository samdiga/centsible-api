# Centsible API Migration Implementation Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the complete backend from the pinned `centsible-claude` source into an independent, domain-oriented `centsible-api`, integrate Centsy webhook ingress, and cut the Mac mini over safely.

**Architecture:** A single pnpm/TypeScript package exposes separate Hono HTTP and worker entrypoints. Domain modules own their routes, schemas, services, repositories, mappers, and tests; Neon provides persistence, cache revisions, and the durable webhook queue.

**Tech Stack:** Node.js 20+, pnpm 9+, TypeScript ESM, Hono, Zod/OpenAPI, Swagger UI, Clerk, Drizzle ORM, postgres.js, Neon Postgres, Vitest, Pino, Plaid SDK.

**Spec:** `docs/superpowers/specs/2026-09-01-centsible-api-migration-design.md`

## Global Constraints

- Copy only from source commit `06d3972a7ffc88b6c65a4bab4ad47487e55b800c`; do not import dirty source files listed in the spec.
- Preserve all 54 canonical route contracts and nine `/recurring` aliases except that public `POST /plaid/webhook` relocates to Centsy.
- Preserve Swift wire shapes, decimal integer strings for money, ISO-8601 timestamps, and opaque keyset cursors.
- Run the API privately on the Mac mini through Tailscale port `4000`; retain Clerk defense-in-depth.
- Use a five-minute absolute LRU TTL, 1,000-entry cap, 64 MiB cap, 2 MiB per-entry cap, and immediate user invalidation after writes.
- Use no Docker, Redis, CDN, Vercel API deployment, or process supervisor.
- Run integration tests only in generated `centsible_test_<run-id>` schemas inside the approved Neon sandbox.
- Keep API and worker startup separate and side-effect free when imported.
- Use Prettier, ESLint, strict TypeScript, typed domain errors, focused comments, and no string-coded exception branching.
- End every task with its named verification commands and a focused commit. Do not proceed through a failing gate.

---

## Execution Order

- [ ] **Plan 1 — Foundation and platform:** `docs/superpowers/plans/2026-09-01-centsible-api-01-foundation.md`
  - Produces the independent package, database migration/test harness, typed platform, unified errors, Clerk auth, OpenAPI console, cache, and entrypoint shells.
  - Gate: clean build and platform tests pass without any workspace import.

- [ ] **Plan 2 — Domain migration:** `docs/superpowers/plans/2026-09-01-centsible-api-02-domains.md`
  - Migrates 11 core and financial route modules plus shared backend logic into vertical slices and preserves `/recurring`.
  - Gate: Plan 1 and Plan 2 expose 42 canonical local routes plus nine aliases with compatible contracts.

- [ ] **Plan 3 — Worker and Plaid:** `docs/superpowers/plans/2026-09-01-centsible-api-03-worker-plaid.md`
  - Migrates Plaid, pipeline, jobs, schedules, retention, durable event processing, and cache invalidation notifications.
  - Gate: all 54 canonical behaviors are preserved or relocated and retry/idempotency tests pass.

- [ ] **Plan 4 — Centsy ingress:** `docs/superpowers/plans/2026-09-01-centsible-api-04-centsy-ingress.md`
  - Changes the co-located `centsy` repository to mirror the API schema and accept verified Plaid webhooks through narrow durable inserts.
  - Gate: invalid events are rejected, Neon outages return 503, and valid events reach the local worker.

- [ ] **Plan 5 — Verification and cutover:** `docs/superpowers/plans/2026-09-01-centsible-api-05-verification-cutover.md`
  - Completes source-test mapping, clean-install/dist verification, documentation, sandbox rehearsal, port-4000 cutover, soak, and archive.
  - Gate: Swift, Swagger, worker, webhook, cache invalidation, and rollback smoke checks succeed.

## Approved-Spec Coverage

| Approved concern                                                          | Owning plan(s) | Completion evidence                                             |
| ------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------- |
| Independent package, readable domain layout, formatting, comments, errors | 1, 2           | Clean build plus platform and domain tests                      |
| 54 canonical operations, nine aliases, Swift wire compatibility           | 1, 2, 3, 5     | Generated route manifest, OpenAPI snapshot, source-test mapping |
| Clerk-protected Swagger test console                                      | 1, 5           | Auth/security tests and browser smoke                           |
| Five-minute bounded LRU and immediate write invalidation                  | 1, 2, 3, 5     | Cache unit, integration, and benchmark evidence                 |
| Neon ownership and isolated sandbox test schemas                          | 1, 4           | Migration and schema-isolation tests                            |
| Separate local API/worker on Mac mini and Tailscale port 4000             | 1, 3, 5        | Lifecycle tests, operator rehearsal, cutover checklist          |
| Verified Centsy Plaid ingress and shared durable queue                    | 3, 4, 5        | Cross-repository contract and end-to-end webhook test           |
| Deprecation, rollback, seven-day soak, reversible archive                 | 5              | Cutover checklist, soak report, explicit archive approval       |

## Handoff Protocol

1. Give a worker only the approved spec, this index, and the current plan file.
2. Require the worker to report the exact checkbox reached, commands run, output summary, commit SHA, and any deviation from the pinned source.
3. Review the commit before starting the next task. Domain tasks may not be batched across a review gate.
4. If a test exposes source behavior that conflicts with the spec, stop and escalate; do not silently change the compatibility contract.
5. Keep `.idea/` and unrelated user files untracked and untouched.
