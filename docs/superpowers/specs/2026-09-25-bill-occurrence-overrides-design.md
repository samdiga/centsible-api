# Bill Occurrence Overrides and Exact Payment Matching

**Status:** Draft for user review. The high-level design was approved on
2026-09-25. This spec is not yet approved for implementation and does not
authorize a production migration, backfill, API restart, or deployment.

## Goal

Let a user change the expected amount and due date for one upcoming bill
occurrence. Keep those choices through statement refreshes and recurring-bill
materialization, show the effective values in Cash Horizon, and mark the
occurrence paid only when a posted checking or savings outflow matches the
effective amount exactly near its due date.

The API is the source of truth. The iOS screen is a separate task.

## Verified current behavior

- Statement bill refresh updates the recurring setup's amount and next due date
  from the linked account's current statement.
- Materialization creates occurrences and forecast events from setup values.
  Occurrence insertion ignores a conflict, while recurring forecast events are
  keyed by series and date and are not updated by later materialization.
- There is no endpoint to edit an individual occurrence's amount or date.
- Payment reconciliation currently requires a transaction already associated
  with a recurring series, accepts a 20% amount difference, and only confirms
  an occurrence in the processing state.
- A read-only production check found 60 upcoming occurrences and no exact
  posted positive transaction from a checking or savings account within seven
  days of its occurrence's current due date. No names, amounts, or account
  identifiers were returned.

## Product behavior

1. A user can override the amount, due date, or both for an upcoming or
   overdue occurrence. Each omitted field remains unchanged. The override is
   scoped to that occurrence; it does not change the recurring setup or other
   occurrences.
2. The occurrence API returns effective expectedAmountCents and dueDate:
   the user override when present, otherwise the latest generated baseline.
3. Statement refresh may update the generated baseline. It must not replace an
   explicit occurrence override.
4. Re-materialization is idempotent for an occurrence. It updates open
   occurrence baselines and their forecast event while preserving explicit
   overrides. It does not change terminal paid, skipped, or cancelled
   occurrences.
5. A posted positive transaction outflow from an undeleted account of type
   depository and subtype checking or savings is an automatic payment
   candidate when its integer-cent amount exactly equals the occurrence's
   effective amount and its transaction date is within seven calendar days
   before or after the effective due date, inclusive.
6. Automatic matching does not require recurringSeriesId. It considers
   upcoming and overdue occurrences directly. A processing occurrence from
   the existing manual-mark-paid flow can be confirmed only by the same exact
   amount and date/account rules; the existing 20% tolerance is removed for
   bill payment confirmation.
7. Matching is one-to-one. If an occurrence has more than one candidate
   transaction, or a transaction could match more than one occurrence, leave
   those candidates unchanged. Never choose a fuzzy or ambiguous match.
8. On a unique match, mark the occurrence paid, link the transaction and
   source account, record the paid amount and confirmation time, resolve the
   linked forecast event, and write the existing audited mutation record.

## API contract

Add PATCH /bills/{id}/occurrences/{occId} with an object containing one or
both of:

- amountCents: a positive integer encoded as a decimal string.
- dueDate: an ISO calendar date (YYYY-MM-DD).

Reject an empty object, invalid dates, non-positive amounts, a bill/occurrence
pair that does not belong to the authenticated user, terminal occurrences, or
an effective due date that collides with another active occurrence for the
same bill. Use the existing user-mutation transaction boundary, tenant
predicates, audit log, and cache invalidation. Return the updated occurrence
with effective values.

The existing list and detail routes keep their response shape; the existing
dueDate and expectedAmountCents fields become the effective values.

## Data model and synchronization

Add nullable expected_amount_override_cents and due_date_override columns to
bill_occurrences. Keep generated amount/date fields as the refreshable
baseline.

Add a stable occurrence cycle key. For monthly occurrences, use the bill setup
and calendar month so a statement due-date shift within a month updates the
same occurrence. For other cadences, use the generated scheduled date; those
setups are not shifted by statement refresh. Backfill existing keys and add a
unique index on (bill_setup_id, occurrence_key). Before creating that index,
the migration must detect duplicate keys and fail without deleting or merging
user data.

Add nullable bill_occurrence_id to forecast_events, with a foreign key and a
partial unique index for non-null occurrence IDs. Backfill links from existing
recurring forecast events by user, setup, and scheduled due date.
Materialization then upserts each event by occurrence ID using the effective
amount and date. The link remains stable when the forecast date is overridden,
so later materialization updates the same event rather than inserting a second
one. Keep existing forecast-event identity constraints for unrelated events.

The Centsy generated schema mirror must be synced from this API worktree and
committed with the API schema/migration.

## Transaction matching and concurrency

The reconciliation query is scoped to one user and only selects posted,
positive, non-deleted transactions joined to a live checking or savings
account. Compare integer cents directly; do not use absolute-value tolerance.
Find candidate pairs by each open occurrence's effective date window and
effective amount, rather than relying on a transaction's recurring-series
classification.

Run matching inside the existing user mutation boundary. Apply status changes
with a conditional update from upcoming, overdue, or processing so repeated
or concurrent passes cannot mark an already-transitioned occurrence again.
The existing audit source remains distinguishable for automatic payment
confirmation.

Forecast events linked to bill occurrences are resolved by this exact matcher.
Generic recurring forecast events without an occurrence link retain their
existing reconciliation behavior; they cannot transition a bill occurrence to
paid.

## Failure behavior and boundaries

- Invalid or terminal occurrence edits return the API's existing typed
  validation/conflict/not-found errors and write no audit row.
- A forecast-date uniqueness conflict rejects the edit atomically; do not
  delete or silently move another forecast event.
- A non-unique payment candidate remains open for user review.
- Production and sandbox migrations are separate approval gates. The approved
  T-008 migration does not authorize a T-032 migration or backfill.
- No UI, Plaid transaction mutation, transaction deletion, or automatic
  handling of partial transactions is included.

## Verification

- Unit tests cover partial and combined overrides, invalid/terminal edits,
  tenant and parent-bill checks, and audit/cache behavior.
- Materialization tests prove statement baseline refresh and repeated
  materialization preserve overrides, keep one occurrence per cycle, and
  update the same forecast event with effective values.
- Matching tests cover exact cents, the inclusive seven-day boundary, posted
  status, positive outflow, checking/savings account type, no recurring-series
  requirement, one-to-one ambiguity rejection, replay idempotency, and
  tenant-scoped auditing. Near matches, inflows, pending/deleted transactions,
  and other account subtypes must not mark a bill paid.
- Add guarded integration coverage on an explicitly isolated
  centsible_test_* schema for migration constraints, stable occurrence
  identity, and forecast-event updates. A skipped integration suite is not
  evidence that these properties passed.
- Run API typecheck, full unit suite, build, and the relevant integration
  suite; sync and build the Centsy schema mirror.
- Before any production migration, inspect the exact pending schema changes
  and ask the user. After any separately approved production migration, verify
  schema state read-only and follow the task's production restart procedure.
