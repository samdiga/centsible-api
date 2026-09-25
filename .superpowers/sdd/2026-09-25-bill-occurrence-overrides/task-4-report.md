# Task 4 report — exact bill occurrence matching

## Result

Implementation commit: `3857e710c141379a0e3bba2f51bfad0006316ad1`.

Bill occurrences now auto-confirm only when an eligible transaction has the exact effective amount and falls within the inclusive seven-calendar-day window. The match graph must be unique from both sides. Transaction candidates must be tenant-owned, posted, positive outflows on a live depository checking or savings account. The occurrence path does not depend on recurring-series classification.

On a successful conditional status transition, the service stores the transaction, account, amount, and confirmation timestamp; resolves the occurrence-linked forecast event; and writes one `bills.auto_confirm_paid` audit entry. The existing fuzzy matcher continues to resolve only unlinked generic recurring forecast events and no longer changes bill occurrence status.

## Files

- `src/modules/bills/bills.repository.ts` — eligible transaction query, bill-event resolution, and generic-event exclusion.
- `src/modules/bills/bill-occurrences.repository.ts` — tenant-scoped eligible occurrence listing.
- `src/modules/bills/bills.service.ts` — exact unique bipartite match and conditional paid transition.
- `src/modules/bills/tests/bills.service.test.ts` — exact cents, both ±7-day boundaries, one-cent mismatch, outside-window, ambiguity in both directions, three eligible statuses, no recurring-series requirement, and generic-path isolation.
- `tests/integration/bills/bills.repository.test.ts` — exact checking and savings confirmation, transaction/account exclusions, replay, linked forecast resolution, and one audit per successful transition.

## Validation

- `NODE_OPTIONS= pnpm exec vitest run src/modules/bills/tests/bills.service.test.ts` — 1 file, 18 passed, 0 skipped.
- Guarded sandbox command: load `DATABASE_URL` from `/Users/samdiga/code/centsible-api/.env` as `TEST_DATABASE_URL`; set `NODE_ENV=test`, `DATABASE_ENVIRONMENT=sandbox`, `ALLOW_SHARED_SANDBOX_TEST_DATABASE=true`, `TEST_SCHEMA_PREFIX=centsible_test_`; run `pnpm exec vitest run tests/integration/bills/bills.repository.test.ts --testTimeout 30000` — 1 file, 9 passed, 0 skipped (192.11s).
- `NODE_OPTIONS= pnpm typecheck` — passed.
- `pnpm exec prettier --check src/modules/bills/bills.repository.ts src/modules/bills/bill-occurrences.repository.ts src/modules/bills/bills.service.ts src/modules/bills/tests/bills.service.test.ts tests/integration/bills/bills.repository.test.ts` — passed.
- `git diff --check` — passed.

The sandbox suite creates a disposable `centsible_test_*` schema for each integration test and cleans it up. An initial 5-second Vitest timeout left one isolated schema; I dropped that exact schema and reran the selected test with a 30-second timeout, then ran the complete file successfully. No production/sandbox application schema migration or API restart/deploy occurred. No cache invalidation assertions changed because the reconciliation still runs inside the existing user mutation boundary.

## Remaining risks / limits

- The uniqueness graph is built from a transactionally read snapshot, and the occurrence update is conditional on its current eligible status. The schema does not add a unique constraint over `linked_transaction_id`; concurrent matching is serialized through the existing per-user mutation boundary. The integration test verifies replay but does not launch simultaneous workers.
- Full API validation and independent Task 4 review are Task 5 work. Do not treat T-032 as complete here.
