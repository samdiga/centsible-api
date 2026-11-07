# Transaction splits: one charge, several categories (T-186)

Status: design. Builder check and review panel done (report: docs/reviews/2026-11-07-t186-transaction-splits-design.md); awaiting the
user's approval.
Spans `centsible-api` (schema, spend queries, endpoints) and `centsible-ui`
(transaction detail, list row). Per the working agreement the API part ships
first, backward-compatible, as its own task; the UI task depends on it.

## Why

The user often pays for a group (a dinner, trip lodging, a gift collection, a
shared phone bill) and is paid back later. Today a transaction carries one
category, so a $300 dinner either overstates Restaurants or loses the user's
own share. The user's words (2026-11-07): "split that transaction into two
categories or multiple categories to say what I owe to my specific category".

Example: $300 dinner becomes Restaurants $100 (the user's share) and
"Owed to me" $200 (everyone else's). "Owed to me" is an ordinary category the
user creates; nothing special is built for it.

## What the user decided

- **The transaction stays one transaction.** It keeps its full amount, date,
  account and bank details. It is divided into category lines; it is never
  turned into two transactions. ("Transaction just stays the same. It's just
  going to be split into two categories.")
- **Creating a split** happens where the category is picked today, in the
  transaction's detail screen: a button ("Split" / "Add another category")
  turns the single category into two category rows, each with its own
  category picker.
- **Amounts fill in automatically:** the user types one row's amount and the
  other row becomes the remainder, so the lines always add up to the
  transaction's amount. ("The amount you automatically is based on what I do.")
- **In the transaction list**, a split row shows both categories when they fit
  ("Restaurants · Owed to me"); when they don't, one category plus a count
  ("Owed to me +1"). Opening it shows every line and its amount.
- **Pending charges can't be split (yet).** Only posted transactions can be
  split; on a pending charge the split button is not offered (the detail screen
  says it becomes available once the charge posts). The pending-to-posted link
  is queued as its own task (see "Follow-up task"); once it lands, splitting
  pending charges can be enabled. (User's pick, option A, 2026-11-07.)
- **When the bank changes the amount and the split can't absorb it** (see
  "Bank changes the amount" below): the transaction stores the bank's new
  amount, so balances and totals stay correct; the user's lines are kept; until
  the user fixes it the whole charge counts under the split's largest line's
  category, and the transaction is flagged for review. (User's pick, option A,
  2026-11-07.)

## What the user agreed to (proposed by Claude, confirmed "Correct")

- More than two rows are allowed. Removing rows down to one turns it back into
  a normal single-category transaction.
- The row amount in the list stays the full charge ($300): that is what left
  the account.
- A split is the user's own choice and nothing automatic undoes it: bank sync,
  auto-categorise and rules leave a split transaction's lines alone, as they
  already leave a hand-picked category alone (`user_category_override`).
- Filtering or searching by a category finds a split transaction under each of
  its categories; a budget drill-in for Restaurants shows the dinner as $100,
  not $300.
- "Owed to me" works with the T-188 "Leave out of budgets" switch: if the user
  leaves it out, the $200 line counts toward nothing and only the $100 counts.

## Correction to what the user was told

In the conversation Claude said a split would carry over from pending to
posted "the same as a hand-picked category does now". That was wrong: verified
2026-11-07, nothing in `centsible-api` links a pending transaction to the
posted one that replaces it (Plaid sends `pending_transaction_id` on the
posted transaction; the sync does not use it). Today a hand-picked category on
a pending charge is lost when it posts. The user was told, and chose to keep
pending charges out of splits for now and fix the link separately.

## Bank changes the amount

A posted transaction's amount can change on a later sync. One line is the
**remainder line**; it absorbs the change:

- If, after adjusting the remainder line, every line is non-zero and the same
  sign as the new amount, the remainder is adjusted and nothing else happens.
  (A sign flip, e.g. +300 becoming -50, therefore always flags.)
- Otherwise the split is **out of balance**: the transaction's amount is
  updated to the bank's, the lines are kept as they were, and the transaction
  is flagged. While flagged, every per-category reader counts the whole
  transaction under the category of its largest line (ties: first line), the
  same category old clients see as `categoryId`. The lines never count while
  flagged, so no total double-counts or drifts from the bank.
- The flag clears when the user saves a new set of lines that adds up (or
  unsplits), or when a later sync brings the amount back to what the lines
  add up to (Claude's call: the flag means "lines don't add up", so it is
  re-checked whenever the amount changes).
- A user edit of the amount (manual transactions) follows the same rule as a
  bank change: the remainder absorbs it, otherwise the split is flagged.
  (Claude's call.)
- If the largest line's category is left out of budgets, a flagged split drops
  out of budgets entirely until fixed, the same as any transaction in that
  category. (Claude's call: one rule, the one old clients already see.)

This replaces the earlier "always sum" wording: lines always sum to the
amount, except in this flagged state, where they are not counted at all.

## Goals

- Every number that adds spending up by category counts each line toward its
  own category, once: budget usage and its drill-in (`budgetSpendConditions`,
  `budgets.repository` usage spend and budget suggestions' medians), reports
  (spending by category, category trends), transaction filters by category
  (`transactions.repository` `categoryIds`, incl. a group's subcategories, and
  `uncategorized`), and the data export. (The forecast has no per-category
  baseline; it reads whole amounts per account. Corrected during the build.)
- The plan sweeps every other reader of `transactions.category_id` (bills and
  bill matching, recurring detection, notifications, widgets, insights) and
  decides for each whether it counts by line or keeps the single category; the
  builder check did not trace these.
- Totals that don't break spending down by category (net worth, account
  balances, dashboard "spending this month", safe-to-spend) are unchanged: the
  transaction's full amount still counts once.
- Money stays integer cents end to end. Lines always sum exactly to the
  transaction amount (outside the flagged state above); the server enforces it.

## Non-goals

- Matching paybacks (Zelle, Venmo, Splitwise lump sums) to the money owed:
  explicitly parked by the user. Do not design for it.
- Splitting by person/household member (the existing, unused
  `transaction_splits` table does this) is not part of this.
- Splitting pending charges (until the follow-up task lands).
- Splitting manual transactions differently from bank ones: both work the same.
- Rules that create splits automatically.

## Anti-goals (would make it a failure even if it "works")

- Any total that counts the full $300 under a category *and* the lines.
- Two rows in the transaction list for one bank charge.
- A sync, rule or auto-categorise run that quietly rewrites or drops a split.
- Lines that don't add up to the transaction amount being counted.

## Constraints

- Schema changes only in `centsible-api` migrations, additive and reversible
  (down migration). `centsy` schema mirrors are re-synced in the same task.
- The existing `transactions.is_split`, `transactions.parent_transaction_id`
  and `transaction_splits` (by household member) are unused (0 prod rows per
  the task). The builder decides whether to reuse `is_split` as the flag and
  leave the rest alone; `parent_transaction_id` (child transactions) must not
  be used, since the user chose one transaction.
- API contract change is backward-compatible: the shipped app, which knows
  nothing about splits, keeps working. A split transaction still carries a
  single `categoryId` for old clients: the largest line's category; ties go to
  the first line. (Claude's call.)
- Writes go through `withUserMutation` so response caches invalidate.
- App: SwiftUI, `Token.*` design tokens only, Swift Testing, Swift 6
  concurrency; `scripts/check-design-tokens.sh` must pass.
- Never log transaction names or amounts beyond the existing logging rules.

## Claude's calls (from what the user said; check while reading)

- **Which row is the remainder.** With three or more rows, the row the user
  hasn't typed an amount into takes the remainder; the app sends which line it
  is and the server stores it, so the server knows which line to adjust when
  the bank changes the amount. With two rows, it is the row the user didn't
  type into. Editor rules: the remainder is the last row the user hasn't
  typed into; if they type into every row, Save stays off and the editor
  shows "$X left to assign" until the rows add up, and the last row is marked
  remainder on save; if the
  remainder row is removed, the last remaining untyped row takes over; a
  remainder that would reach zero or flip sign keeps Save off.
- **Flagged state, minimum UX:** a banner in the transaction detail ("The bank
  changed this charge from $300.00 to $320.00. Update the split.") that opens
  the editor pre-filled with "$20.00 left to assign"; a small indicator on the
  list row.
- **Picking one category on a split** shows a confirmation ("Replace the
  split with one category?") first. The "recategorise similar" sheet that
  follows a category change does not offer split transactions.
- **Which amount a split shows.** Wherever the user is looking at one category
  (budget drill-in, the Transactions tab filtered by category, report
  drill-ins), a split shows that category's part ($100). Everywhere else it
  shows the full charge ($300). The API adds a per-filter amount field for
  this; older app versions ignore it and show $300 in those places until
  updated.
- **CSV export:** one row per transaction; the category column lists each
  line with its amount ("Restaurants $100.00; Owed to me $200.00"), so a charge
  never becomes two rows. The JSON backup carries the lines in full.
- **A single-category change on a split** (picking one category in the
  picker, or an old app sending one `categoryId`) replaces the split with that
  category: the user chose one category. Bulk "recategorise similar" skips
  split transactions instead of flattening them.
- **Lines and categories:** a line may be uncategorised (counts as
  Uncategorized). Archiving a category with reassign moves its lines too;
  customising a shared default (`moveCategoryReferences`) moves lines too.
- **Forecast and transfer detection** read the transaction's full amount and
  stored category as today.

## Data rules (from the review panel, 2026-11-07)

- **The derived category.** "Largest line" means largest by absolute amount
  (so refunds work); ties go to the lowest `position`. One definition, used by
  the SQL helper and the serializer.
- **`transactions.category_id` stays a stored column** holding the derived
  category of a split. It is rewritten in the same DB transaction as every
  change to lines, the flag or the amount, and by `moveCategoryReferences` and
  archive-with-reassign. Any reader not switched to lines therefore fails safe:
  it counts the whole charge once, under one category. A rollback needs no
  data repair.
- **Saving a split sets `user_category_override = true`.** Verified
  2026-11-07: every automatic writer already skips override rows, so splits
  are protected by the existing gate (see the writers table).
- **"Out of balance" is its own column** (e.g. `split_out_of_balance`), not
  `is_split`; "has lines" is answered by the lines table.
- **Foreign keys:** lines' `transaction_id` is `ON DELETE CASCADE`; lines'
  `category_id` is `ON DELETE SET NULL` (an uncategorised line). Bank-removed
  transactions are soft-deleted (`softDeleteByPlaidIds`), and every reader
  already filters `deleted_at`, so their lines stop counting with them.
- **Two lines may not share a category.** The save is rejected; when archive-
  with-reassign or a customise copy would make two lines share one, they are
  merged into one line (amounts summed; the remainder marker kept if either
  had it).
- **Concurrency:** sync and the split save each run in one DB transaction
  holding `SELECT … FOR UPDATE` on the transaction row
  (`findByIdForUpdate` exists). The save sends the amount it was made against;
  a mismatch returns 409 with the current amount, and the editor reloads.
- **Transaction-level exclusions apply first:** transfers, hidden/excluded
  accounts, `exclude_from_budgets` on the transaction and the spend-sign filter
  drop the whole transaction, every line included, inside the shared helper.
  `exclude_from_budgets` on a split transaction overrides its lines.
- **Old clients and `categoryId`:** a PATCH or bulk edit whose `categoryId`
  equals the current derived category leaves the split alone; only a
  different value replaces it. (The builder checks whether the shipped app
  re-sends an unchanged `categoryId`, `TransactionPatchBody` in
  `centsible-ui` `DTOs.swift`.)
- **Filters:** a category or group filter matches with `EXISTS` over lines,
  so a transaction never appears twice. Its per-filter amount is the sum of
  the matching lines, or the full amount when flagged and the derived
  category matches. Under `uncategorized` it is the uncategorised line's part.
- **Response contract (all additive, optional):** detail carries `splits`
  (lines with category, amount, position, isRemainder) and `splitOutOfBalance`;
  the list carries `splitCategoryIds` (ordered, for the "+1" label),
  `splitOutOfBalance` and `filteredAmount` (only when a category filter is
  applied). Under a category filter the row shows the filtered category first.
- **Cache:** every path that changes lines or the flag (split save, unsplit,
  sync, archive-with-reassign, `moveCategoryReferences`) runs inside
  `withUserMutation` or bumps the user data version itself.
- **Down migration** drops the lines table and the flag column; transactions
  fall back to their stored `category_id`. Losing splits on rollback is
  accepted.
- **Invariant test:** over any window, the sum of line-level category totals
  (including left-out and uncategorised) equals the sum of the same
  transactions' amounts.
- **Out of scope by design:** the dashboard's "spending this month" shows
  $300 while the Restaurants budget shows $100. That is intended.
- **Bank re-issues a posted transaction under a new ID:** the old row is
  soft-deleted and the new one is unsplit. Accepted as a known limit here;
  T-189 (pending → posted link) covers the common case of a pending charge
  posting.
- **Export:** CSV amounts are formatted from integer cents. The JSON backup
  carries lines, and `POST /user/import` restores them (an older backup
  without lines imports as before). Corrected during the build: a restore
  endpoint does exist.

## Readers and writers of `transactions.category_id` (swept 2026-11-07)

Readers that add spending up by category switch to the shared line helper;
the rest keep the stored derived category on purpose.

| Where | What | Verdict |
|---|---|---|
| `shared/budget-spend/budget-spend.ts` `budgetSpendConditions` | budget usage + drill-in | lines (the shared helper lives here) |
| `budgets.repository.ts` `getCategoryMedians`, `getSpentByCategory` | suggestions' medians, spend by category | lines |
| `reports.repository.ts` `getSpendingByCategory`, category trend (`categoryIdExpr`) | reports | lines |
| `transactions.repository.ts` `conditionsFor` (`categoryIds`, `uncategorized`) and export list | Transactions filters, CSV | lines (`EXISTS`, `filteredAmount`) |
| `forecast-accounts.repository.ts` daily-spend baseline | per account, whole amounts; reads only the category's transfer flag | stored category (corrected during build: there is no per-category baseline) |
| `forecast.repository.ts` pending rows | pending only, never split | stored category |
| `bills.repository.ts` card-payment detection, paycheck detection | classifies a whole charge | stored category |
| `bills/paid-from-inference.ts` (`isTransfer`) | whole-charge classification | stored category |
| `transactions/auto-categorize.ts` merchant history | learns from hand-picked rows | stored category (a split teaches its derived category) |
| `transactions.repository.ts` `listSimilarByMerchant` | "recategorise similar" candidates | exclude split rows |
| `user-data.repository.ts` | JSON export | stored category + `splits` |
| notifications, dashboard, pipeline, tags modules | no category reads found (`rg` 2026-11-07) | none |

| Writer | Gate today | With splits |
|---|---|---|
| Plaid sync rules (`plaid-sync.service.ts` ~283) | skips `userCategoryOverride` | skips splits (override = true) |
| Auto-categorise (sync ~310, `auto-categorize.ts`) | only `category_id IS NULL` and override false | skips |
| Retroactive rules (`rules/retroactive.ts`, `rules.repository.ts`) | override false | skips |
| `bills.repository.ts` `applyBillCategoryToTransaction` | override false | skips |
| Single PATCH `updateTransaction` / bulk `/transactions/bulk` | sets override = true | replaces the split only if `categoryId` differs from the derived category |
| `categories.repository.ts` `moveCategoryReferences` (customise, archive-reassign) | moves all rows | moves lines too, merges duplicates, rewrites derived category |
| Manual create (`manual-transactions.repository.ts`) | sets override | unsplit at creation |

## Left to the builder

- Table shape for lines (e.g. `transaction_category_splits(transaction_id,
  category_id, amount_cents, position, is_remainder)`), indexes, and how spend
  queries read "a transaction's lines or, if unsplit or flagged, its own
  category" (a view, a lateral join, or a shared SQL helper next to
  `budgetSpendConditions`). One shared definition, not one per query.
- Endpoint shape (e.g. `PUT /transactions/:id/splits` with the full line list;
  an empty or one-line list unsplits).
- Validation details: at least two lines, every line non-zero, same sign as
  the transaction, categories visible to the user and not archived, sum equal
  to the amount, exactly one remainder line, transaction not pending.
- Refunds: a negative transaction can be split the same way (lines negative).
- The flagged state's wording and where it shows (transaction detail; Review
  queue if one fits).
- Exact list-row layout and truncation, following the existing row.

## Follow-up task (queued separately)

Link a pending transaction to the posted one that replaces it, using Plaid's
`pending_transaction_id`, so a hand-picked category (and later, a split)
carries over when a charge posts. Fixes an existing bug independent of splits.
