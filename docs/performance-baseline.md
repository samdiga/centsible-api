# Read-performance baseline

Date: 2026-09-12

Base commit: `714cd4988adcc065714870c4a1121c0e8cb997f5`

## Verdict

The guarded Neon sandbox invalidation test and the five-family benchmark ran
successfully. These figures describe this one deterministic, minimal fixture on
this machine and are not universal performance limits. The plan documents do
not define a numeric slow-query threshold, so threshold approval remains
unresolved.

## Environment

| Field               | Value                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Node / pnpm         | Node 24.2.0 / pnpm 9.15.0                                                                               |
| OS / architecture   | Darwin / arm64                                                                                          |
| Machine model / RAM | Not verified without privileged access                                                                  |
| Intended Mac mini   | Not verified; not inferred from the repository path                                                     |
| Neon sandbox branch | Connection verified as guarded sandbox; branch identifier not safely discoverable from the supplied URL |
| Fixture scale       | 1 user, 1 Plaid item, 1 account, 0 transactions                                                         |

The invocation was:

```bash
pnpm tsx scripts/benchmark-reads.ts --iterations 20 --horizon 30
```

The process received `NODE_ENV=test`, `DATABASE_ENVIRONMENT=sandbox`,
`ALLOW_SHARED_SANDBOX_TEST_DATABASE=true`, and
`TEST_SCHEMA_PREFIX=centsible_test_` through the ignored sandbox environment
file. It created and cleaned one generated schema. No URL, token, response body,
account name, transaction name, or financial value was printed.

## Benchmark results

Each family used 20 measured uncached runs, one warm-up miss, then 20 cached
runs. Query counts are measured postgres.js debug callbacks, including the
revision check required before serving a hit.

| Family                   | Uncached p50 / p95 ms | Cached p50 / p95 ms | Queries uncached / cached | Hits / misses | Bytes |
| ------------------------ | --------------------: | ------------------: | ------------------------: | ------------: | ----: |
| Dashboard summary        |     297.479 / 314.539 |     70.705 / 85.318 |                   80 / 20 |        20 / 0 |   166 |
| Accounts                 |     153.168 / 169.940 |     75.132 / 89.149 |                   40 / 20 |        20 / 0 |   406 |
| First transactions page  |     152.225 / 175.240 |     75.975 / 83.941 |                   40 / 20 |        20 / 0 |    37 |
| Reports                  |     160.841 / 217.110 |     77.624 / 85.199 |                   40 / 20 |        20 / 0 |    39 |
| Forecast, 30-day horizon |     547.299 / 583.917 |   148.203 / 179.385 |                  140 / 40 |        20 / 0 | 2,658 |

The computation-time field emitted by the script is the uncached p50 for each
family. The fixture deliberately measures repeatability and instrumentation,
not production-scale row throughput.

## Approved cache settings when enabled

Runtime response caching now defaults to `CACHE_ENABLED=false` so the API does
not hold a PostgreSQL `LISTEN` connection that prevents Neon scale-to-zero. The
limits below remain the approved values when caching is explicitly enabled.

| Setting                          |                                                Fixed value |
| -------------------------------- | ---------------------------------------------------------: |
| Absolute, non-refreshing TTL     |                                                 300,000 ms |
| Maximum entries                  |                                                      1,000 |
| Total approximate payload budget |                                  64 MiB (67,108,864 bytes) |
| Maximum cached item              |                                    2 MiB (2,097,152 bytes) |
| Expired-entry cleanup            |                                                  60,000 ms |
| Identical miss behavior          |                                              Single-flight |
| Failed compute behavior          |                                               Never cached |
| Successful user write behavior   | Immediate invalidation; worker writes notify API listeners |

The focused cache unit suite verifies the limits and behavioral properties;
the Task 3 integration test verifies the write path rather than tuning it.

## Invalidation evidence

The guarded test ran one table-driven test with no skips. It primed dashboard,
accounts, first transactions page, reports, and forecast keys for a target and
control user before each real service-layer mutation. It covered categories,
transactions, notification preferences, bills and occurrences, budgets, rules
and retroactive application, pipeline schedule, net-worth snapshot, bill
workers, Plaid exchange/balance/sync/liabilities/unlink, all mutating item
webhook branches, account removal, and user-data import/reset.

Every scenario proved target eviction, revision advance, control-user cache and
revision isolation, and recomputation. Worker scenarios used a separate
PostgreSQL listener connection. The command passed in 66.92 seconds: 1 file,
1 test, 0 failed, 0 skipped. Its generated schema was cleaned.

## Query-plan disposition

Neither the migration design nor Plan 5 Task 3 defines a numeric slow-query
threshold. Therefore no threshold pass/fail determination is possible and no
index or repository change is justified in this task. Forecast was the slowest
measured family.

Representative `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)` samples ran in a
separate generated schema for all five read shapes. Literals were redacted and
the schema was cleaned. On the minimal empty-row plan fixture:

| Family                  | Principal plan                            | Index evidence                                       | Planning / execution ms |
| ----------------------- | ----------------------------------------- | ---------------------------------------------------- | ----------------------: |
| Accounts                | Index scan plus incremental sort          | `accounts_type_idx`                                  |           0.385 / 0.039 |
| Dashboard summary       | Aggregate over index scan                 | `transactions_user_date_active_idx`                  |           0.881 / 0.078 |
| First transactions page | Limit plus incremental sort               | `transactions_user_date_active_idx`                  |           0.222 / 0.073 |
| Reports                 | Group aggregate and nested-loop left join | transaction date index and category primary key      |           0.737 / 0.112 |
| Forecast                | Nested-loop left join                     | forecast user/date and occurrence setup/date indexes |           0.741 / 0.043 |

These plans confirm index selection only for the deterministic fixture; they do
not establish production-scale cost or threshold approval.

## Limitations and cleanup

- The machine model, RAM, and Neon branch identifier were not verified.
- The fixture contains no transactions and does not model production data
  volume; rerun with an approved deterministic scale fixture for capacity work.
- An earlier extension-missing diagnostic invocation retained 52 generated
  schemas. The successful invalidation and benchmark runs each cleaned their
  own schema. The retained schemas are not used by this baseline and must be
  removed only by exact name, never by a broad prefix deletion.
