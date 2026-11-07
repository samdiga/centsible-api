# Transaction splits — API Implementation Plan (T-186)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One transaction can be divided into category lines that every per-category total counts, without breaking the shipped app.

**Architecture:** A new `transaction_category_splits` table holds lines; `transactions.category_id` stays stored as the derived (largest-line) category and `transactions.split_out_of_balance` marks a split the bank's amount broke. One shared SQL helper, `spendLines`, expands a transaction into its counted (category, amount) lines; every per-category reader joins through it. Pure split math (derive, validate, rebalance) lives in one module with unit tests.

**Tech Stack:** TypeScript, Hono + zod-openapi, Drizzle ORM 0.45 over Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-07-transaction-splits-design.md` (approved 2026-11-07). Read it first; this plan does not repeat its rules.

## Global Constraints

- Money is integer cents (`bigint`, `amount_cents`) end to end; Plaid sign: + outflow, − inflow.
- Migrations: additive raw SQL in `database/migrations/NNNN_*.sql` plus a rollback in `database/migrations/down/NNNN_*.sql` ending with `DELETE FROM "__drizzle_migrations" WHERE hash = '<sha256 of the up file>';` (pattern: 0029). Mirror columns in `database/schema/schema.ts`.
- The spec's "`centsy` schema mirrors" do not exist (searched 2026-11-07); nothing to sync.
- API change is backward-compatible: every new response field is optional/additive; `categoryId` stays on every transaction.
- Writes go through the service's `mutate` (`withUserMutation`) so response caches invalidate.
- Never log transaction names or amounts.
- "Largest line" = largest absolute amount; ties → lowest `position`.
- Splits only on `status = 'posted'` transactions.
- Node/pnpm commands are prefixed `NODE_OPTIONS=`. Integration tests: `env -u PLAID_ACTIVE_ENV NODE_OPTIONS= node --env-file=$HOME/code/centsible-api/.env ~/code/.agent-queue/run-integration.mjs tests/integration/<dir>`.

## Review Focus

1. A split transfer, or a split on an account excluded from budgets, contributes $0 to every per-category total (exclusions apply before lines expand) — test in Task 4.
2. A group filter (Food) over a split with Restaurants and Coffee lines returns the transaction once, `filteredAmount` = both lines summed — test in Task 5.
3. A bank sync that changes +30000 to −5000 flags the split rather than producing mixed-sign lines — test in Task 2 and Task 6.
4. An old-app PATCH that re-sends the unchanged derived `categoryId` with a note leaves the split intact — test in Task 3.
5. Archive-with-reassign that moves Coffee onto Restaurants, where both are lines of one split, merges them into one line and keeps the total — test in Task 7.

---

### Task 1: Schema — lines table and out-of-balance flag

**Files:**
- Create: `database/migrations/0030_transaction_category_splits.sql`
- Create: `database/migrations/down/0030_transaction_category_splits.sql`
- Modify: `database/schema/schema.ts` (after `transactions`, ~line 530)
- Test: `tests/integration/transactions/splits-schema.test.ts`

**Interfaces:**
- Produces: `schema.transactionCategorySplits` with columns `id uuid pk`, `transactionId` (`transaction_id`, FK transactions ON DELETE CASCADE, not null), `userId` (`user_id`, FK users ON DELETE CASCADE, not null), `categoryId` (`category_id`, FK categories ON DELETE SET NULL, nullable), `amount` (`amount_cents` bigint not null, CHECK <> 0), `position` (smallint not null), `isRemainder` (`is_remainder` boolean not null default false), `createdAt`. Unique `(transaction_id, position)`; partial unique `(transaction_id) WHERE is_remainder`; index `(user_id, category_id)`. `schema.transactions.splitOutOfBalance` (`split_out_of_balance` boolean not null default false).
- `is_split`, `parent_transaction_id`, `transaction_splits` are left untouched.

- [ ] **Step 1:** Write `splits-schema.test.ts`: inserting a line with `amount_cents = 0` fails; two `is_remainder` lines on one transaction fail; deleting the transaction row deletes its lines; deleting a category sets the line's `category_id` to NULL.
- [ ] **Step 2:** Run it; expect FAIL (relation does not exist).
- [ ] **Step 3:** Write the up migration, the down migration (drop table, drop column, delete the tracker row by the up file's sha256 from `shasum -a 256`), and the Drizzle mirror.
- [ ] **Step 4:** Run the test; expect PASS. Run `NODE_OPTIONS= pnpm typecheck`; expect exit 0.
- [ ] **Step 5:** Commit `Splits: lines table and out-of-balance flag (T-186)`.

### Task 2: Split math (pure)

**Files:**
- Create: `src/modules/transactions/splits/split-math.ts`
- Test: `src/modules/transactions/splits/tests/split-math.test.ts`

**Interfaces:**
- Produces:
  - `type SplitLine = { categoryId: string | null; amount: bigint; position: number; isRemainder: boolean }`
  - `derivedCategoryId(lines: readonly SplitLine[]): string | null` — largest |amount|, ties lowest position.
  - `validateSplitLines(lines: readonly SplitLine[], transactionAmount: bigint): SplitValidationError | null` where `SplitValidationError = "too_few_lines" | "zero_line" | "sign_mismatch" | "sum_mismatch" | "duplicate_category" | "remainder_count"`. Rules: ≥2 lines, none zero, all same sign as the amount, sum equals amount, no two lines share a non-null category or both null, exactly one remainder.
  - `rebalance(lines: readonly SplitLine[], newAmount: bigint): { lines: SplitLine[]; outOfBalance: boolean }` — remainder absorbs `newAmount − sum(others)`; `outOfBalance` when any resulting line is zero or differs in sign from `newAmount` (lines returned unchanged then). If the lines already sum to `newAmount`, `outOfBalance: false` (this is how a flag auto-clears).
  - `mergeDuplicateCategories(lines: readonly SplitLine[]): SplitLine[]` — sums lines sharing a category into the lowest position; keeps `isRemainder` if any merged line had it; renumbers positions 0..n-1. Used by Task 7.

- [ ] **Step 1:** Write tests: `derivedCategoryId` with [Rest 10000, Owed 20000] → Owed; refund [−10000, −20000] → the −20000 line; tie [15000, 15000] → position 0. `validateSplitLines` returns each error for a crafted input and null for [10000 Rest, 20000 Owed remainder] of 30000. `rebalance`: 30000→32000 gives remainder 22000, not out of balance; 30000→−5000 → outOfBalance true, lines unchanged; 30000→10000 with remainder 20000 → remainder 0 → outOfBalance; flagged lines summing to 30000 with newAmount 30000 → outOfBalance false. `mergeDuplicateCategories` on [Rest 10000, Coffee→Rest 5000 remainder, Owed 15000] → [Rest 15000 remainder, Owed 15000].
- [ ] **Step 2:** Run `NODE_OPTIONS= pnpm vitest run src/modules/transactions/splits`; expect FAIL.
- [ ] **Step 3:** Implement the four functions.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Splits: derive, validate and rebalance lines (T-186)`.

### Task 3: Save, unsplit and read splits (repository, service, routes)

**Files:**
- Create: `src/modules/transactions/splits/splits.repository.ts`
- Modify: `src/modules/transactions/transactions.schemas.ts`, `transactions.service.ts` (`patchTransaction` ~403, `bulkPatchTransactions` ~506, `getTransaction` ~382), `transactions.routes.ts`, `transactions.mapper.ts`, `transactions.repository.ts` (`listColumns`, `updateTransaction`, bulk update)
- Test: `tests/integration/transactions/splits.test.ts`, `src/modules/transactions/tests/transactions.routes.test.ts`

**Interfaces:**
- Consumes: Task 1 schema; Task 2 `SplitLine`, `validateSplitLines`, `derivedCategoryId`.
- Produces:
  - `splitsRepository.listLines(userId, transactionIds: string[], db): Promise<Map<string, SplitLine[]>>`
  - `splitsRepository.replaceLines(userId, transactionId, lines: SplitLine[] | [], db): Promise<void>` — deletes then inserts. With ≥2 lines it also sets `transactions.category_id = derivedCategoryId(lines)`, `user_category_override = true`, `split_out_of_balance = false`. With `[]` it only deletes lines and clears `split_out_of_balance`; `category_id` is left to the caller.
  - `PUT /transactions/{id}/splits` body `TransactionSplitsPutSchema = { expectedAmount: string (cents), lines: { categoryId: uuid|null, amount: string (cents), isRemainder: boolean }[] }`. 0 or 1 lines → unsplit (1 line: transaction takes that line's category). Responses: 200 `TransactionDetailResponse`; 404; 409 `{ error: { code: "AMOUNT_CHANGED", currentAmount } }` when `expectedAmount` ≠ the locked row's amount; 422 for a pending transaction, an archived/invisible category (reuse `assertPatchOwnership`'s category check) or any `SplitValidationError` (code = the error string).
  - `TransactionDtoSchema` gains optional `splits?: { categoryId, amount, position, isRemainder }[]` (detail only), `splitCategoryIds?: (string|null)[]` (list; ordered by position, filtered category first when a category filter applies — Task 5), `splitOutOfBalance?: boolean`.
- PATCH/bulk rule: `categoryId` present and different from the stored derived category → `replaceLines(..., [])` then the normal update (split replaced). Equal or absent → lines untouched. A manual `amount` edit on a split → `rebalance` (Task 2) and write lines/flag in the same transaction.

- [ ] **Step 1:** Write integration tests: PUT two lines on a posted $300 → GET detail shows both lines, `categoryId` = Owed (larger), `userCategoryOverride` true; PUT on a pending row → 422; PUT with `expectedAmount` 29900 → 409 with `currentAmount` "30000"; PUT `lines: []` → unsplit, category kept; PATCH `{ notes, categoryId: <derived> }` → lines kept (Review Focus 4); PATCH `{ categoryId: <other> }` → lines gone; bulk PATCH with a different category → split replaced; manual transaction amount PATCH 30000→32000 → remainder 22000; →−5000 → `splitOutOfBalance` true.
- [ ] **Step 2:** Run `tests/integration/transactions`; expect FAIL.
- [ ] **Step 3:** Implement repository, service method `putSplits(userId, id, body)` inside `mutate` using `findByIdForUpdate`, the route, schema and mapper fields; add `putSplits` to the routes-test service mock and a route test for 409/422 mapping.
- [ ] **Step 4:** Run integration + `NODE_OPTIONS= pnpm test`; expect PASS.
- [ ] **Step 5:** Commit `Splits: PUT /transactions/:id/splits, unsplit on a new single category (T-186)`.

### Task 4: Shared spend-lines helper; budgets count lines

**Files:**
- Create: `src/shared/spend-lines/spend-lines.ts`
- Modify: `src/shared/budget-spend/budget-spend.ts`, `src/modules/budgets/budgets.repository.ts` (usage spend, `getCategoryMedians`, `getSpentByCategory` ~343, `getLeftOutCategoryIds` unaffected)
- Test: `tests/integration/budgets/budget-usage.test.ts`, `tests/integration/transactions/budget-drill-in.test.ts`, `tests/integration/transactions/spend-lines-invariant.test.ts`

**Interfaces:**
- Produces:
  - `spendLinesJoin(): SQL` — the `CROSS JOIN LATERAL` below, aliased `spend_line`, to place right after `FROM transactions`:
    ```sql
    CROSS JOIN LATERAL (
      SELECT s.category_id, s.amount_cents FROM transaction_category_splits s
       WHERE s.transaction_id = transactions.id AND NOT transactions.split_out_of_balance
      UNION ALL
      SELECT transactions.category_id, transactions.amount_cents
       WHERE transactions.split_out_of_balance
          OR NOT EXISTS (SELECT 1 FROM transaction_category_splits s2 WHERE s2.transaction_id = transactions.id)
    ) AS spend_line
    ```
    Use Drizzle's lateral join API if 0.45 offers one that keeps the alias; otherwise the raw `sql` fragment.
  - `spendLine.categoryId: SQL`, `spendLine.amount: SQL<bigint>` — column expressions for `spend_line.category_id` / `spend_line.amount_cents`.
  - `budgetSpendConditions()` unchanged in signature; its "uncategorised paycheck" clause reads `spend_line.category_id`, and callers now LEFT JOIN `categories` on `spend_line.category_id`. Transaction-level conditions (status, `exclude_from_budgets`, card payment, account filters) stay on `transactions`, so they drop every line.

- [ ] **Step 1:** Tests: $300 split Restaurants 10000 / Owed 20000 → Restaurants budget usage 10000; Owed left out of budgets (T-188) → Owed counts 0; flagged split with largest line Owed left out → counts 0 everywhere; split on a transfer-category transaction / `exclude_from_budgets` → 0 (Review Focus 1); drill-in for Restaurants lists the dinner once with `filteredAmount` "10000"; invariant: over a month, Σ spend-line amounts by category (all categories, incl. null) = Σ transaction amounts.
- [ ] **Step 2:** Run budgets + transactions integration; expect FAIL.
- [ ] **Step 3:** Implement the helper and switch each budgets reader.
- [ ] **Step 4:** Run; expect PASS (existing budget tests unchanged).
- [ ] **Step 5:** Commit `Splits: budgets count each line under its category (T-186)`.

### Task 5: Transactions filters, reports, forecast baseline

**Files:**
- Modify: `src/modules/transactions/transactions.repository.ts` (`conditionsFor` ~330–341, list select), `src/modules/reports/reports.repository.ts` (`getSpendingByCategory` ~110, trend `categoryIdExpr` ~251 and ~230), `src/modules/forecast/forecast-accounts.repository.ts` (~68–102)
- Test: `tests/integration/transactions/transactions.repository.test.ts`, `tests/integration/reports/*`, `tests/integration/forecast/*`

**Interfaces:**
- Consumes: Task 4 `spendLinesJoin`, `spendLine`.
- Produces: list filter `categoryIds` (and group expansion) and `uncategorized` become `EXISTS (SELECT 1 FROM <spend lines of this transaction> WHERE category matches)`; list item gains `filteredAmount?: string` = Σ matching spend-line amounts, only when `categoryIds`, `uncategorized` or `budget` filters are applied. Reports group by `COALESCE(spend_line.category_id::text, 'uncategorized')` summing `spend_line.amount_cents`. Forecast baseline groups by spend-line category.

- [ ] **Step 1:** Tests: Food group filter over Restaurants+Coffee split → one row, `filteredAmount` = both (Review Focus 2); `uncategorized` filter with a null line → that line's amount; no filter → no `filteredAmount`, amount 30000; spending-by-category report shows Restaurants 10000 and Owed 20000, total unchanged; trend top-N keeps the uncategorised bucket; forecast baseline for Restaurants uses 10000.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run transactions, reports, forecast integration and unit tests; expect PASS.
- [ ] **Step 5:** Commit `Splits: filters, reports and forecast baseline count lines (T-186)`.

### Task 6: Bank sync rebalances splits

**Files:**
- Modify: `src/modules/plaid/plaid-sync.service.ts` (after `upsertManyFromPlaid`, ~280), `src/modules/transactions/splits/splits.repository.ts`
- Test: `tests/integration/plaid/*` (the sync test that upserts a modified transaction)

**Interfaces:**
- Consumes: Task 2 `rebalance`, `derivedCategoryId`; Task 3 `splitsRepository`.
- Produces: `splitsRepository.rebalanceAfterAmountChange(userId, transactionIds: string[], db): Promise<void>` — for each id with lines, run `rebalance` against the row's new amount; write the lines (when balanced) and `split_out_of_balance`; keep `category_id` = `derivedCategoryId(lines)`. Called inside the sync's DB transaction for every saved row (the upsert holds the row lock).

- [ ] **Step 1:** Tests: modified Plaid row 30000→32000 → remainder 22000, flag false; 30000→−5000 → flag true, lines unchanged, `category_id` = derived, budget counts 0 under Restaurants and −5000 under Owed (Review Focus 3); a later sync back to 30000 → flag false; rules and auto-categorise leave the split's `category_id` alone.
- [ ] **Step 2:** Run plaid integration; expect FAIL.
- [ ] **Step 3:** Implement and call it.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Splits: a bank amount change adjusts the remainder or flags the split (T-186)`.

### Task 7: Categories move lines; recategorise-similar skips splits

**Files:**
- Modify: `src/modules/categories/categories.repository.ts` (`moveCategoryReferences` ~119), `src/modules/transactions/transactions.repository.ts` (`listSimilarByMerchant` ~580)
- Test: `tests/integration/categories/*`, `tests/integration/transactions/similar-transactions.test.ts`

**Interfaces:**
- Consumes: Task 2 `mergeDuplicateCategories`, `derivedCategoryId`.
- Produces: `moveCategoryReferences` also updates `transaction_category_splits.category_id` from→to, merges duplicate lines per affected transaction, and rewrites each affected transaction's `category_id` to the derived category. `listSimilarByMerchant` excludes transactions that have lines.

- [ ] **Step 1:** Tests: customise a shared default used by a line → line points at the copy; archive Coffee reassigning to Restaurants on a Restaurants+Coffee+Owed split → two lines, Restaurants summed, total unchanged (Review Focus 5); similar-by-merchant never returns a split row.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run categories + transactions integration; expect PASS.
- [ ] **Step 5:** Commit `Splits: category moves and archives carry lines (T-186)`.

### Task 8: Export and backup

**Files:**
- Modify: `src/modules/transactions/transactions.service.ts` (`exportTransactionsCsv` ~658), `src/modules/user-data/user-data.repository.ts` (~109), `src/modules/user-data/user-data.schemas.ts`
- Test: `src/modules/transactions/tests/transactions.export.test.ts`, `tests/integration/user-data/*`

**Interfaces:**
- Consumes: Task 3 `splitsRepository.listLines`.
- Produces: CSV category column for a split = `"Restaurants $100.00; Owed to me $200.00"` (position order; amounts formatted from cents, uncategorised line named "Uncategorized"); one row per transaction. JSON export transaction gains `splits` (same shape as the DTO) and `splitOutOfBalance`.

- [ ] **Step 1:** Tests for the exact CSV cell above and the JSON fields.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Splits: export lists lines (T-186)`.

### Task 9: Cache invalidation, full gate, deploy

**Files:**
- Modify: `tests/integration/cache-write-invalidation.test.ts`

- [ ] **Step 1:** Test: after PUT splits, a cached `GET /budgets/active/usage` and `GET /transactions` return new values; same after a sync that flags a split and after archive-with-reassign.
- [ ] **Step 2:** Run; fix any path that bypasses `mutate` or the data-version bump; expect PASS.
- [ ] **Step 3:** Full gate: `NODE_OPTIONS= pnpm typecheck && NODE_OPTIONS= pnpm lint && NODE_OPTIONS= pnpm test`, then the integration runner over `tests/integration`; expect exit 0.
- [ ] **Step 4:** Code review of the branch; fix findings.
- [ ] **Step 5:** Merge and deploy per the working agreement: `~/code/.agent-queue/deploy-api.sh q/T-186` (runs migration 0030; additive), then `/health` on 127.0.0.1:4000 and the Tailscale IP. Ask the user before this step only if the migration is anything but additive.
