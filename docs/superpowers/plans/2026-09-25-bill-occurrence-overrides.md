# Bill Occurrence Overrides and Exact Payment Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to override an individual bill occurrence's amount and due date, preserve those values through refresh and materialization, update its forecast event, and auto-confirm payment only on a unique exact posted checking/savings match.

**Architecture:** Keep the bill setup values as a refreshable baseline, add cycle identity and nullable occurrence overrides, and link forecast events directly to occurrences. Add a tenant-scoped edit route and perform automatic payment matching inside the existing user mutation boundary; use one-to-one candidate sets and conditional status updates so ambiguity and replay leave data unchanged.

**Tech Stack:** TypeScript, Hono, Zod, Drizzle ORM, PostgreSQL migrations, Vitest, isolated PostgreSQL integration schemas, and the Centsy generated Drizzle schema mirror.

**Spec:** `docs/superpowers/specs/2026-09-25-bill-occurrence-overrides-design.md` — read it before implementation; it is the behavioral authority for this plan.

## Global Constraints

- API is the source of truth; the iOS screen is a separate task.
- Occurrence overrides are scoped to one occurrence and never mutate the bill setup or neighboring occurrences.
- Posted positive transaction outflow, exact integer cents, live depository checking/savings account, and an inclusive seven-calendar-day window are all required for automatic payment confirmation.
- Ambiguous transaction/occurrence candidate sets remain unchanged; no fuzzy match is allowed.
- Keep reads and writes tenant-scoped and inside the existing user mutation transaction where required.
- Migration duplicate-key detection must fail without deleting or merging user data.
- The Centsy schema mirror is generated from the API schema; sync it with `npm run schema:sync`, never edit its generated schema manually.
- No production or sandbox migration/backfill, API restart, or deploy is authorized by this plan; production and sandbox migration/backfill each require a separate user approval.
- Use explicit isolated `centsible_test_*` schemas for SQL integration coverage; a skipped suite is not evidence of a pass.
- Do not push.

## Review Focus

- A statement due-date shift within a month must keep the same monthly occurrence and forecast event; test this in the bill materialization integration test.
- A user override must survive both statement baseline refresh and repeated materialization; test combined and single-field overrides in bill integration tests.
- Two occurrences or transactions sharing candidate criteria must remain untouched; test both ambiguity directions in matching unit and integration coverage.
- A valid-looking transaction from credit, loan, deleted, pending, or another tenant's account must not confirm payment; test each excluded class in matcher coverage.
- A date override that collides with another active occurrence or forecast event must fail atomically without changing either row; test through the override service and isolated database.

---

## File Map

- `database/schema/schema.ts`: occurrence override/cycle-key columns and forecast-event occurrence link/indexes.
- `database/migrations/0014_bill_occurrence_overrides.sql` and `database/migrations/meta/*`: forward-only schema and data-link migration plus Drizzle metadata, generated with the repository's established migration workflow.
- `src/modules/bills/bill-occurrences.repository.ts`: occurrence identity, effective-value reads, baseline updates, override writes, collision checks, and candidate occurrence reads.
- `src/modules/bills/bills.repository.ts`: linked forecast-event persistence and transaction/account candidate query.
- `src/modules/bills/bills.service.ts`: override mutation and exact one-to-one auto-confirm behavior.
- `src/modules/bills/bills.schemas.ts`, `bills.mapper.ts`, `bills.routes.ts`: request/response contract and OpenAPI route.
- `src/modules/bills/tests/bills.service.test.ts`, `bills.routes.test.ts`, `statement-bills.test.ts`, and `tests/integration/bills/bills.repository.test.ts`: focused unit and isolated database coverage.
- `tests/integration/database/migrations.test.ts`: migration behavior, duplicate-key fail-closed check, and backfilled identity assertions.
- `centsy/src/db/schema.ts`: generated mirror; update only with `npm run schema:sync` from the Centsy worktree.
- `docs/superpowers/specs/2026-09-25-bill-occurrence-overrides-design.md`: accepted design; revise only if implementation discovery reveals a contract conflict and pause for user review.

## Interfaces

- `BillOccurrenceRow` gains `occurrenceKey`, nullable `expectedAmountOverrideCents`, and nullable `dueDateOverride`; effective values are computed as override-or-baseline.
- Occurrence insertion/upsert takes `{ userId, billSetupId, occurrenceKey, dueDate, expectedAmountCents }`; existing open rows update baseline fields by stable key without clearing overrides, while terminal rows remain unchanged.
- Forecast-event rows gain nullable `billOccurrenceId`. Bill-generated event upsert keys on that ID and writes effective amount/date; unrelated recurring/manual event identity stays as it is.
- `PATCH /bills/{id}/occurrences/{occId}` accepts `amountCents?: string` and `dueDate?: YYYY-MM-DD`, requires at least one field, and returns `{ occurrence: BillOccurrenceDto }` with effective dueDate and expectedAmountCents.
- The matcher consumes tenant-scoped open occurrences plus eligible posted positive outflow transactions and emits only unique one-to-one pairs; it does not need `recurringSeriesId` for bill occurrences.

## Task 1: Add stable occurrence and forecast-event identity

**Files:**
- Modify: `database/schema/schema.ts`
- Create: `database/migrations/0014_bill_occurrence_overrides.sql`
- Modify generated: `centsy/src/db/schema.ts` (from a dedicated `centsy-worktrees/q-T-032` worktree)
- Test: `tests/integration/database/migrations.test.ts`

**Interfaces:**
- Produces occurrence key, override, and forecast-link database columns plus constraints consumed by Tasks 2–4.
- Backfill monthly occurrence keys from setup ID and calendar month; use setup ID and the existing scheduled date for non-monthly keys, as specified in the design.
- Backfill forecast links by tenant, setup, and scheduled date. Preserve existing forecast events and stop the migration before adding uniqueness if occurrence keys collide.

- [x] **Step 1: Add migration tests first.** Extend the isolated migration test fixture to assert both new override columns, the stable key, forecast foreign key, and partial unique index exist after migration.
- [x] **Step 2: Prove duplicate keys fail closed.** Seed two occurrences that map to the same cycle key in a temporary isolated schema; assert the migration rejects the duplicate and leaves both rows intact.
- [x] **Step 3: Add baseline migration SQL.** Add nullable override columns and occurrence key; backfill keys and forecast links using deterministic joins; execute a duplicate-key guard before creating uniqueness; add the occurrence-key unique index and forecast-event FK/partial unique index without deleting rows.
- [x] **Step 4: Update the Drizzle source schema.** Add the columns and indexes in `database/schema/schema.ts`; keep migration history in the numbered forward-only SQL migration, following `0013_account_metadata_overrides.sql` (the current runner discovers numbered SQL migrations and the later hand-written migrations do not update the legacy Drizzle journal/snapshots).
- [x] **Step 5: Run focused migration tests.** Run `NODE_OPTIONS= pnpm exec vitest run tests/integration/database/migrations.test.ts`; require the isolated DB test to execute, not skip.
- [x] **Step 6: Generate the Centsy mirror.** In the dedicated Centsy worktree, run `npm run schema:sync`, then `npm run schema:check`; commit no manually edited generated schema.
- [x] **Step 7: Review migration data behavior.** Run `git diff --check` and inspect the migration SQL to verify it has no delete/merge statements and the duplicate guard executes before uniqueness creation.

## Task 2: Preserve cycle identity, overrides, and forecast state on refresh

**Files:**
- Modify: `src/modules/bills/statement-bills.ts` only if refresh synchronization needs an explicit occurrence-baseline update hook
- Modify: `src/modules/bills/bill-occurrences.repository.ts`
- Modify: `src/modules/bills/bills.repository.ts`
- Modify: `src/modules/bills/bills.service.ts`
- Modify: `database/schema/schema.ts` and `database/migrations/0014_bill_occurrence_overrides.sql` to enforce the stable occurrence key as non-null after all writers populate it
- Create: `database/migrations/raw/0008_bill_occurrence_event_identity.sql` to scope legacy forecast date indexes to unlinked generic events
- Test: `src/modules/bills/tests/statement-bills.test.ts`
- Test: `src/modules/bills/tests/bills.service.test.ts`
- Test: `tests/integration/bills/bills.repository.test.ts`
- Test: `tests/integration/database/migrations.test.ts`
- Test: `tests/integration/cache-write-invalidation.test.ts` and `tests/integration/forecast/forecast.repository.test.ts` for direct occurrence fixtures affected by the non-null key.

**Interfaces:**
- Consumes the schema created in Task 1.
- Produces idempotent cycle-key materialization: monthly due-date shifts within one month update the same occurrence; other cadence identity follows generated scheduled date.
- Produces one forecast event per bill occurrence, updated by occurrence ID with effective amount/date; terminal occurrences and their events are not resurrected.

- [ ] **Step 1: Write failing repository tests.** Insert a monthly occurrence and linked forecast event, change the statement due date within that same month, materialize again, and assert the same occurrence and event IDs remain.
- [ ] **Step 2: Write failing override persistence tests.** Set amount-only, date-only, and combined overrides; refresh the setup baseline; materialize repeatedly; assert each effective value remains overridden while unoverridden baseline values advance.
- [ ] **Step 3: Implement cycle-key occurrence upsert.** Replace due-date-only `onConflictDoNothing` insertion with conflict handling by setup/key; update baseline amount/date only for open statuses and retain both override columns. When the generated monthly due date shifts before today, include the cycle only if its occurrence already exists; do not create new past occurrences. Make every insertion path provide a key, then set the migration column `NOT NULL` and match the Drizzle source schema so null keys cannot bypass uniqueness.
- [ ] **Step 4: Implement linked forecast-event upsert.** Upsert bill events by `billOccurrenceId`, using effective amount/date; avoid changing generic recurring events or resolved/terminal events. Scope both legacy `(user_id, recurring_series_id, date)` unique indexes (`forecast_events_identity_uniq` and `forecast_events_series_date_uniq`) to rows with no `bill_occurrence_id`; linked bill events use occurrence identity, while generic recurring events retain their date identity. Add the next ordered raw migration as `database/migrations/raw/0008_bill_occurrence_event_identity.sql`.
- [ ] **Step 5: Verify focused tests.** Run the bill service/statement unit files, the complete bills repository, migration, cache invalidation, and forecast repository integration files on explicit isolated schemas; verify repeat materialization does not duplicate either row and no suite skips.

## Task 3: Add tenant-scoped occurrence override endpoint

**Files:**
- Modify: `src/modules/bills/bills.schemas.ts`
- Modify: `src/modules/bills/bill-occurrences.repository.ts`
- Modify: `src/modules/bills/bills.service.ts`
- Modify: `src/modules/bills/bills.mapper.ts`
- Modify: `src/modules/bills/bills.routes.ts`
- Test: `src/modules/bills/tests/bills.routes.test.ts`
- Test: `src/modules/bills/tests/bills.service.test.ts`
- Test: `tests/integration/bills/bills.repository.test.ts`

**Interfaces:**
- Consumes Task 1 schema and Task 2 effective-value repository behavior.
- Produces `PATCH /bills/{id}/occurrences/{occId}`; request uses positive integer-cent decimal string and ISO calendar date, and response returns the updated effective occurrence DTO.
- Every write is scoped by authenticated user, bill ID, and occurrence ID and uses the existing user-mutation, audit, and cache invalidation path.

- [x] **Step 1: Write schema tests.** Accept amount only, date only, or both; reject empty object, zero/negative amount, non-integer cents, impossible calendar date, malformed date, and extra unsupported fields.
- [x] **Step 2: Write route tests.** Assert authenticated `PATCH` passes the exact bill/occurrence IDs and parsed fields to the service and returns `{ occurrence }`; assert the OpenAPI route declares typed 404/409 errors.
- [x] **Step 3: Write service tests.** Assert non-owned bill/occurrence pairs return not found, terminal rows conflict, effective-date collisions conflict, and successful changes audit once and invalidate the user's cached views.
- [x] **Step 4: Implement effective mapper and request schema.** Compute DTO due date and amount as override-or-baseline; validate strict positive cents and real calendar dates.
- [x] **Step 5: Implement tenant and collision repository checks.** Check the bill belongs to the user, the occurrence belongs to that bill/user, its status is upcoming or overdue, and the resulting date does not collide with another active occurrence or an existing unlinked forecast event with the same recurring identity.
- [x] **Step 6: Implement service and route.** In one user mutation transaction, update override columns, preserve omitted fields, write the audit record, invalidate cache, and return the effective DTO.
- [x] **Step 7: Verify route/service/database behavior.** Run focused tests and an isolated integration test proving collision rollback leaves both occurrence and forecast event unchanged.

## Task 4: Match exact posted checking/savings outflows one-to-one

**Files:**
- Modify: `src/modules/bills/bills.repository.ts`
- Modify: `src/modules/bills/bill-occurrences.repository.ts`
- Modify: `src/modules/bills/bills.service.ts`
- Test: `src/modules/bills/tests/bills.service.test.ts`
- Test: `tests/integration/bills/bills.repository.test.ts`
- Test: `tests/integration/cache-write-invalidation.test.ts` if its bill auto-confirm path assertions need updates

**Interfaces:**
- Consumes Task 1 linked forecast events and Task 2 effective due dates/amounts.
- Candidate transaction query returns tenant-owned, non-deleted, posted positive outflows joined to non-deleted depository checking/savings accounts.
- Matcher confirms only pairs where amount cents match exactly and transaction date is within inclusive ±7 calendar days; each occurrence and transaction must have exactly one candidate.

- [x] **Step 1: Add matcher unit cases.** Cover exact cents, one-cent difference, both inclusive date boundaries, one day outside, no recurring-series ID, and uniqueness/ambiguity in both directions.
- [x] **Step 2: Add exclusions.** Cover pending/deleted transactions, deleted accounts, credit/loan/other subtypes, inflows, and cross-tenant rows; each must leave the occurrence open.
- [x] **Step 3: Add replay/concurrency test.** Run reconciliation twice and conditionally update from upcoming/overdue/processing; assert one transition, one audit entry, one transaction link, and linked forecast resolution.
- [x] **Step 4: Query only eligible transaction candidates.** Add a repository method with tenant, posted, positive outflow, deleted-at, account type/subtype, and date-window predicates; return account ID and date with transaction ID/amount.
- [x] **Step 5: Build unique candidate sets.** Compare integer cents against effective occurrence amounts, date against effective due-date window, and ignore recurring-series classification for occurrence matching. Do not mutate any pair unless each side has exactly one candidate.
- [x] **Step 6: Apply exact confirmation transactionally.** Conditionally transition an eligible occurrence to paid, set linked transaction/account, paid amount and confirmation time, resolve its linked forecast event, and record the distinguishable `bills.auto_confirm_paid` audit source.
- [x] **Step 7: Preserve generic recurring-event behavior.** Keep generic events without a bill occurrence link on their existing reconciliation path, but ensure they cannot mark bill occurrences paid and cannot use the old 20% tolerance for bill confirmation.
- [x] **Step 8: Run focused tests.** Run service unit tests and bill repository integration tests on isolated schemas. Cache invalidation tests needed no assertion changes.

## Task 5: Full validation, review, and queue closeout

**Files:**
- Review all Task 1–4 changes in API and Centsy worktrees; no additional files unless a verification failure requires a scoped fix.

**Interfaces:**
- Produces verified API and Centsy schema changes ready for the task's finish steps; production migration/backfill remains gated on user approval.

- [ ] **Step 1: Run API static checks.** Run `NODE_OPTIONS= pnpm typecheck` and `git diff --check` in the API worktree.
- [ ] **Step 2: Run API unit suite.** Run `NODE_OPTIONS= pnpm test`; record pass/fail/skip counts and investigate all failures.
- [ ] **Step 3: Run API build.** Run `NODE_OPTIONS= pnpm build` after tests.
- [ ] **Step 4: Run guarded SQL integration coverage.** Run the bill and migration integration tests with explicit isolated `centsible_test_*` configuration; verify they executed rather than skipped.
- [ ] **Step 5: Validate Centsy mirror.** Run `npm run schema:check`, `npm run typecheck`, and `npm run build` in the Centsy worktree.
- [ ] **Step 6: Review self-critically.** Confirm no API response shape outside the stated effective occurrence fields changed, no generic event was linked accidentally, no ambiguous match can transition, and migration SQL cannot delete or merge user rows.
- [ ] **Step 7: Follow the shared working agreement's finish sequence.** Merge main into the task branches; fast-forward main in `centsible-api`, `centsy`, then `centsible-ui` order; restart production API from main only if the API changed and after the required migration approval; remove task worktrees and branches; then mark the queue task done with merged SHAs, tested/not-tested evidence, and the largest remaining risk. Do not push.
- [ ] **Step 8: Stop for database authorization if needed.** Before any sandbox or production migration/backfill, show the exact pending schema/data operations and obtain the separate approval for that environment; do not run either without it.
