# Consolidated review: Centsy transaction splits design spec
Panel: 4 fresh reviewers (money-correctness · category-readers-coverage · backward-compat-and-contract · edge-cases-and-ux). Verdict: **Not ready to plan.** The core counting rule is sound. However, the category that old clients and the flagged state rely on is neither defined nor owned, several write and delete paths have no rules, and no reviewer could check any API claim against code.

## Bottom line
- **Verdict:** Don't approve yet. The main rule (count the lines, or count the whole charge once when flagged) is right. But the "largest line" category that old apps see has no precise definition and no owner. Every API-side claim in the spec is also still unchecked, because no reviewer could open `centsible-api/src`.
- **Fix first:**
  1. Define "largest line" as the largest absolute amount, with ties going to the lowest `position`. Keep `transactions.category_id` stored and rewrite it in the same DB transaction on every path that changes lines or the flag. Make the sync upsert leave `category_id` and `user_category_override` alone on a split.
- **Then tidy:** Close the must-level gaps that only one reviewer raised:
  - the deferred sweep of readers of `category_id`;
  - group filters that count a transaction twice;
  - bank amounts that flip sign;
  - an old app's unchanged `categoryId` wiping a split;
  - lines left behind when a transaction is deleted;
  - remainder rules for 3 or more rows;
  - archived or deleted categories on lines;
  - PATCH of `amount` or `excludeFromBudgets` on a split.

  After that: row locking or a 409 for a stale amount, a response-contract table, separating "has lines" from "out of balance", a table of writers, and the cache paths.
- **Needs a human decision:**
  1. A flagged split whose largest line is in a "Leave out of budgets" category: should the whole charge drop out of budgets, or count under the largest *counted* line?
  2. A later sync makes a flagged split's lines add up again: auto-clear the flag, or keep it until the user saves (spec line 87)?
  3. The user edits a split transaction's amount: re-run the remainder/flag logic, or refuse until they unsplit?

## MUST-FIX (binding — ≥3 reviewers)
1. **The "largest line" category has no precise definition and no owner.** It is the `categoryId` old clients see and the category the flagged state counts under.
   - **Raised by:** money-correctness #2 (must), category-readers M3 + S1 (must), backward-compat M2 (must). edge-cases also asked how ties are broken.
   - **Location:** Constraints (lines 138–141), flagged state (lines 83–85), "What the user agreed to" (lines 55–57), "Left to the builder" (lines 175–179).
   - **Defects:**
     - "Largest" by signed value picks the wrong line for refunds, where lines are negative (line 185).
     - "First line" on a tie is undefined: `position` or creation order?
     - The spec never says whether `category_id` is a stored column or computed at read time, or who keeps it current.
     - Nothing stops sync, rules or auto-categorise from overwriting it on a split.
   - **Fix:**
     - Largest means largest by absolute amount, with ties going to the lowest `position`.
     - Use one shared definition in both the SQL helper and the serializer.
     - Keep `transactions.category_id` stored.
     - Recompute it in the same DB transaction on every one of these: split save, unsplit, flag set, flag clear, bank amount change, `moveCategoryReferences`, and archive-with-reassign.
     - The sync upsert must not write `category_id` or `user_category_override` for a split.
   - **Why stored (backward-compat):** readers nobody has traced then fail safe. They count the whole charge under one category, and a rollback needs no data repair.

## SHOULD
- **Concurrency and a stale amount.** Raised by 2: money S5, edge-cases S7. Location: lines 79–88, 180–184.
  - Run sync and `PUT /splits` each in one DB transaction that holds `SELECT … FOR UPDATE` on the transaction row.
  - Reject a save made against an old amount with a 409 that carries the current amount.
  - Disable Save until the remainder is resolved.
- **Response contract for split fields.** Raised by 3 at should level or by overlap: backward-compat S3, edge-cases S9, money M3 (contract part). Location: lines 154–159, 180–181.
  - Name the added list and detail fields: the lines (or only a count, for the list), the split flag, the flagged state, and the per-filter amount field. All of them must be additive and optional.
  - Pin the row rule under a category filter: the filtered category is shown first.
- **Transaction-level exclusions apply before lines are expanded.** Raised by 2: money S7 and M4 (part), edge-cases S8 (part). Location: lines 95–101, 175–179.
  - Transfers, hidden or excluded accounts, `excludeFromBudgets` and the spend-sign filter all drop the whole transaction, including every line, inside the shared helper.
  - Add a test that a split transfer contributes nothing.
- **Table of writers of `category_id` / `user_category_override`.** Raised by 2: category-readers S3, edge-cases S8. Location: lines 55–57, 163–166.
  - For each writer (sync, rules engine, auto-categorise, bulk recategorise, single PATCH, bulk edit, import, manual create, hide/ignore, mark-as-transfer), say whether it skips or replaces a split.
- **Separate "has lines" from "out of balance".** Raised by 2: category-readers N1, backward-compat S4. Location: lines 133–137.
  - Don't reuse `is_split` as the flag. Add a new column such as `split_out_of_balance`.
- **Two lines sharing a category.** Raised by 2: money N9, edge-cases M4 (part) and N10. This includes after an archive-with-reassign merge, and two uncategorised lines. Either allow it, with filter amounts summed, or forbid it and merge on reassign.
- **Minimum UX for the flagged state** (edge-cases S5; lines 175–179): a detail banner showing the old total, new total and difference; a list-row indicator; and an editor that opens pre-filled with "$X left to assign".
- **Flag re-evaluation on later syncs** (money S6; lines 87–88): this needs a stated rule. See human decision 2.
- **Cache invalidation paths** (backward-compat S6; line 142):
  - These paths must invalidate the transaction, budget, report and forecast caches: a sync that sets or clears the flag, archive-with-reassign, `moveCategoryReferences`, and an old-client unsplit.
  - Wrap any of them that bypass `withUserMutation`.
- **Migration down** (backward-compat S5; line 131): the down migration drops the lines table and the flag column, transactions fall back to the stored `category_id`, and the spec states that losing splits is accepted.
- **Out-of-scope readers keep the full amount by design** (money S8; lines 106–108):
  - Say that the dashboard showing $300 while the budget shows $100 is intended.
  - Add an invariant test: line-level category totals plus left-out totals equal transaction totals over the same window.
- **Export restore** (category-readers S4; lines 160–162): say whether the JSON restore round-trips lines, or that no restore exists.
- **Flattening from the single-category picker** (edge-cases S8; `TransactionDetailScreen.swift:469`, checked in UI code):
  - The "recategorise similar" sheet appears right after the patch that flattens a split. Say whether that sequence is intended.
  - Warn before the picker replaces a split.

## NIT
- CSV example values such as `$100.00` should be stated as formatted from integer cents, with no floats in the export (money N10; line 161).
- The refund editor shows magnitudes and flips the sign for the user (edge-cases N11).
- "0 prod rows" for `is_split` / `parent_transaction_id` / `transaction_splits` comes from the task and is unverified. Re-check it in the plan (backward-compat N7; line 134).
- Say whether transfer detection reads a Transfer category, and how a split with a Transfer line behaves (category-readers N2; lines 170–171).

## Single-/minority-reviewer flags (not dropped — surfaced with rationale)
- **The sweep of readers is deferred to the plan** (category-readers M1 + M2; lines 102–105, 95–101).
  - Rationale: the "plannable without guessing" criterion. The anti-goals at lines 124/127 forbid double-counting, yet the readers that could double-count (bills, recurring, notifications, widgets, insights) are explicitly untraced.
  - Fix: before approval, add a "Readers of `transactions.category_id`" table (file, function, verdict). Add a rule that any SQL grouping, filtering or summing by category goes through the shared helper or is listed as deliberately single-category.
  - The stored `category_id` from the binding fix lessens the risk but does not remove it: per-category totals that need line-level amounts still have to be found. **This is the strongest minority flag.**
- **Group/category filters can return a transaction twice, and the per-filter amount is undefined** (money M3; lines 58–60, 98–100, 154–159).
  - Rationale: the "never double-count" criterion. A Food group filter matches both Restaurants and Coffee lines.
  - Fix: filter with `EXISTS` so rows don't multiply. The per-filter amount is the sum of the matching lines, or the full amount when the transaction is flagged and its derived category matches. Under the `uncategorized` filter, show only the null-category line's part.
  - backward-compat S3 and edge-cases S9 back this up at should level.
- **A bank amount that flips sign can leave counted lines with mixed signs** (money M1; lines 79–81).
  - Example: +300 changes to −50 with lines of +100 and +200. The remainder becomes −150, which "passes".
  - Fix: adjust the remainder only if *every* line ends up non-zero and has the same sign as the new amount. Otherwise flag the split.
- **An old client's unchanged `categoryId` may wipe a split** (backward-compat M1; lines 163–166).
  - Fix: a `categoryId` write replaces the split only if it differs from the current derived category. A value equal to it, or an absent key, leaves the lines alone.
  - Not verified: whether the shipped app re-sends an unchanged `categoryId` on edits of other fields. `TransactionPatchBody` (`DTOs.swift:453-472`) is the place to check.
- **Deleting a transaction, or a Plaid `removed` event, leaves lines behind** (edge-cases M2 must; money S5 should; lines 74–91). Require `ON DELETE CASCADE` on the lines table's `transaction_id`.
- **Categories on lines** (edge-cases M4 must; category-readers S2 should; lines 167–169):
  - The spec doesn't cover archive without reassign or a hard delete. Use `ON DELETE SET NULL` on the line's `category_id`, which matches the uncategorised lines the spec already allows.
  - It doesn't say whether re-saving a split that holds an archived category passes validation.
  - It doesn't settle the left-out + flagged case: human decision 1.
- **Remainder rules for 3 or more rows** (edge-cases M1; "Which row is the remainder", validation details). Specify what happens when:
  - the user types into every row;
  - the remainder row is removed;
  - the user types into the remainder row itself;
  - the remainder would hit zero or flip sign.
- **A posted split re-sent by the bank under a new `transaction_id` loses its lines** (edge-cases M3). The options are to map the lines, flag the new transaction, or list it as a non-goal. How often Plaid re-issues IDs for posted transactions was not verified.
- **PATCH of `amount` or `excludeFromBudgets` on a split has no rule** (money M4; `DTOs.swift:454, 462`, checked in UI code). See human decision 3 for amount. For `excludeFromBudgets`, the flag on the transaction should override its lines.

## Disagreements / notes
- **The panel did not meet the evidence criterion.** All four reviewers were blocked from `/Users/samdiga/code/centsible-api/src`. There are no API file:line citations. The only claims checked against code are in the UI: `DTOs.swift:453-472` and `TransactionDetailScreen.swift:469/567`. Several spec claims are unverified: that `is_split` / `transaction_splits` are unused, the `user_category_override` behaviour, `withUserMutation` coverage, and the reader list. Before this gate passes, someone with API access should run `rg -n "category_id|categoryId" src` in `centsible-api` and classify every hit.
- **How the binding item was merged.** It combines two facets. money-correctness raised the *definition* (absolute value, tie-break). category-readers and backward-compat raised *ownership* (stored vs computed, sync overwrite). All three raised it at must level, at the same location (lines 138–141), with the same root cause: the largest-line category is under-specified.
- **Stored vs computed `category_id`.** backward-compat insists on stored. category-readers accepts either, provided it is stated. The binding fix follows backward-compat's argument that untraced readers then fail safe.
- **No conflict on foreign keys.** CASCADE applies to `transaction_id` (edge-cases, money). SET NULL applies to the line's `category_id` (category-readers). They are different keys.
- **Money S6's auto-clear suggestion conflicts with spec line 87,** which clears the flag only when the user saves. That is why it is listed as a human decision and not as a fix.
- **Open questions:**
  - Do reports honour the T-188 "Leave out of budgets" switch today?
  - Does a Review queue exist (line 187)?
  - Do any readers outside the transactions filter treat `category_id IS NULL` as "uncategorised", such as badges or notifications?
  - Does an old client's "mark reviewed" on a flagged transaction leave the flag set? The spec implies yes, but doesn't say.