# Configurable On-Demand Worker Design

**Status:** Approved for implementation on 2026-09-20. This approval does not
authorize live database writes, service changes, Centsy deployment, or Task 5
cutover.

## Goal

Stop idle worker polling from preventing Neon scale-to-zero while preserving
immediate user-requested synchronization and durable, eventually processed
Plaid webhooks.

## Product behavior

- User-triggered pipeline sync wakes the separate local worker immediately.
- The API continues to return the existing asynchronous `202` pipeline-run
  response and clients continue to read pipeline-run status.
- Centsy remains the public Plaid webhook owner and durably inserts verified
  webhook events. Webhook processing may lag by up to the configured safety
  sweep interval.
- The initial safety sweep interval is six hours.
- The interval is configured with `WORKER_SWEEP_INTERVAL_MINUTES=360`.
- `0` disables periodic safety sweeps. Nonzero values below 60 are rejected so
  a configuration error cannot recreate high-frequency idle polling.
- Manual wakes remain available when periodic sweeps are disabled.
- User daily sync remains disabled by default. Existing explicitly enabled
  user schedules are preserved.

## Architecture

The API and worker remain separate entrypoints. The worker exposes a
loopback-only control endpoint configured by `WORKER_WAKE_URL`. After the API
commits a new manual pipeline job, it sends a bounded best-effort wake request
to that endpoint. A failed wake never rolls back or removes the durable job;
the safety sweep remains its recovery path.

The worker no longer starts the jobs poller, inbound-event poller, or scheduler
intervals. Instead, a single-flight sweep performs this sequence:

1. Dispatch due system or explicitly enabled user schedules once.
2. Drain every currently eligible inbound webhook batch.
3. Drain every currently eligible job batch, including jobs created while the
   drain is active.
4. Read the earliest future retry deadline once and arm one in-memory timer for
   the earlier of that deadline or the configured safety sweep.
5. Return to an idle process with no database query timer.

The worker runs that sweep at startup, on a loopback wake request, and on the
configured safety timer. Overlapping wake requests share the same active sweep.
The timer is reset after a completed sweep, so there is at most one periodic
timer and no database work between wakes.

The worker control server binds only to the loopback host encoded in
`WORKER_WAKE_URL`; URLs with credentials, query strings, fragments, non-HTTP
protocols, or non-loopback hosts are rejected. The endpoint accepts only
`POST` at the configured path and responds `202` after accepting the wake,
without waiting for the complete sync pipeline.

## Failure behavior

- A manual wake transport failure is logged with redaction and leaves the job
  queued for the next sweep.
- Individual job and webhook retry/lease behavior remains owned by the current
  repositories and handlers.
- Future-dated retries are not polled. The worker reads the earliest deadline
  once after a drain and arms a single timer for that instant. After a process
  restart, the safety sweep remains the recovery path.
- Shutdown stops accepting wakes, clears the safety timer, aborts or waits for
  active leased work through the existing bounded poller shutdown paths, and
  closes the database afterward.

## Verification boundary

Automated tests must prove configuration validation, loopback-only wake
transport, single-flight sweeps, full queue draining, immediate manual wake,
no idle database timers, bounded shutdown, and preserved durable fallback.
Repository verification includes unit tests, lint, typecheck, build, and
distribution tests.

Live Neon scale-to-zero and PostgreSQL `LISTEN` behavior cannot be proved by
unit tests. They remain a separate read-only/operational verification gate
before any future cutover approval.
