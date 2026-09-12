# API rollback checklist

Rollback preserves additive database changes and keeps Centsy durable webhook
ingress active. Never use `killall`, broad `pkill`, wildcard PID matching,
port-kill scripts, or prefix-wide schema deletion.

## Task 4 sandbox rehearsal

The 2026-09-12 rehearsal completed every item below against the exact generated
schema. The boxes remain reusable instructions rather than Task 5 approvals.

Run from
`/Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal`.
Only captured Task 4 PIDs and the exact generated schema are allowed.

- [ ] Stop the new worker first: `kill -TERM "$WORKER_PID"` then
      `wait "$WORKER_PID"`.
- [ ] Query safe job/inbound-event metadata and confirm the stopped worker no
      longer claims work.
- [ ] Stop the new API second: `kill -TERM "$API_PID"` then `wait "$API_PID"`.
- [ ] Confirm only port `4001` is free with
      `! lsof -nP -iTCP:4001 -sTCP:LISTEN`.
- [ ] Stop rehearsal Centsy by exact PID: `kill -TERM "$CENTSY_PID"` then
      `wait "$CENTSY_PID"`.
- [ ] Confirm only the selected Centsy rehearsal port is free.
- [ ] Confirm the acknowledged signed event remains durably represented and
      has its expected terminal status; do not select its payload.
- [ ] Confirm no `processing` inbound event or `running` job has a stranded
      lease. If a lease exists, do not edit it; wait for the documented expiry and
      let a worker reclaim it through normal fencing.
- [ ] Confirm Task 4 never signaled, stopped, restarted, or rebound the
      pre-rehearsal port-`4000` service.
- [ ] Close all sandbox clients.
- [ ] Validate `$DATABASE_SCHEMA` against
      `^centsible_test_[a-z0-9_]+$`, drop only that exact quoted name, and query
      `pg_namespace` to prove it no longer exists.
- [ ] Leave the 52 previously retained diagnostic schemas untouched as a
      separate cleanup backlog.

Safe lease inspection:

```bash
# Read-only database metadata — Task 4 worktree
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "select id,status,locked_by,lease_expires_at,last_error_code from inbound_webhook_events where status in ('pending','processing','dead') order by received_at"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "select id,type,status,locked_by,lease_expires_at,error_code from jobs where status in ('pending','running','failed') order by created_at"
```

Exact-name cleanup:

```bash
# Sandbox-mutating — exact Task 4 schema only
cd /Users/samdiga/code/centsible-api/.worktrees/plan5-operations-rehearsal
[[ "$DATABASE_SCHEMA" =~ ^centsible_test_[a-z0-9_]+$ ]] || exit 1
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -v schema_name="$DATABASE_SCHEMA" -c 'DROP SCHEMA :"schema_name" CASCADE'
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -v schema_name="$DATABASE_SCHEMA" -Atc "select count(*) from pg_namespace where nspname = :'schema_name'" | grep -Fx 0
```

## Approved Task 5 production rollback — DO NOT RUN DURING TASK 4

Run only after an approved cutover, using the PIDs and verified old paths
recorded in the Task 5 approval packet.

1. Stop the new worker gracefully by its exact PID and wait for exit.
2. Confirm it no longer claims jobs or inbound events; allow fenced leases to
   expire naturally rather than editing ownership fields.
3. Stop the new API gracefully by its exact PID and wait for exit.
4. Confirm those exact new processes exited and port `4000` is free.
5. Keep Centsy running. It must continue verifying and durably inserting Plaid
   webhooks throughout application rollback.
6. Inspect pending, processing, retry, and dead-event metadata without selecting
   payloads.
7. Restart the old API and worker/scheduler only from their previously verified
   paths, commands, commit, and environment owner.
8. Prove exactly one scheduler is running before accepting normal operation.
9. Run public health, authenticated read smoke, and a safe worker check.
10. Record event IDs and statuses received during interruption for later normal
    processing or exact dead-event replay.
11. Preserve additive schema objects. Do not drop new tables, rewind migrations,
    or perform an emergency production restore as application rollback.

If the old paths, PIDs, environment owner, or restart commands were not captured
before cutover, stop. Guessing them during an incident is not an approved
rollback procedure.
