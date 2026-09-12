import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { featureFlags, plaidItems, users } from "../database/schema/index.js";
import * as schema from "../database/schema/index.js";
import { createAccountRepository } from "../src/modules/accounts/accounts.repository.js";
import { createAccountService } from "../src/modules/accounts/accounts.service.js";
import { createDashboardRepository } from "../src/modules/dashboard/dashboard.repository.js";
import { createDashboardService } from "../src/modules/dashboard/dashboard.service.js";
import { createForecastRepository } from "../src/modules/forecast/forecast.repository.js";
import { createForecastService } from "../src/modules/forecast/forecast.service.js";
import { createReportsRepository } from "../src/modules/reports/reports.repository.js";
import { createReportsService } from "../src/modules/reports/reports.service.js";
import { createTransactionRepository } from "../src/modules/transactions/transactions.repository.js";
import { createTransactionService } from "../src/modules/transactions/transactions.service.js";
import { createResponseCache } from "../src/platform/cache/response-cache.js";
import { getUserRevision } from "../src/platform/cache/user-revisions.repository.js";
import {
  createIsolatedConnectionConfig,
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../tests/support/test-database.js";

type Metric = Readonly<{
  family: string;
  iterations: number;
  warmupIterations: number;
  uncached: Readonly<{ p50Ms: number; p95Ms: number }>;
  cached: Readonly<{ p50Ms: number; p95Ms: number }>;
  cache: Readonly<{ hits: number; misses: number }>;
  serializedBytes: number;
  computationMs: number;
  measuredQueryCount: Readonly<{ uncached: number; cached: number }>;
}>;

function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const raw = index === -1 ? undefined : process.argv[index + 1];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return Number(
    (
      sorted[
        Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
      ] ?? 0
    ).toFixed(3),
  );
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function timed<T>(
  operation: () => Promise<T>,
): Promise<Readonly<{ durationMs: number; value: T }>> {
  const start = performance.now();
  const value = await operation();
  return { durationMs: performance.now() - start, value };
}

async function main(): Promise<void> {
  const databaseConfig = readTestDatabaseConfig(process.env);
  const iterations = option("--iterations", 20);
  const horizon = option("--horizon", 30);
  const harness = await createIsolatedTestDatabase();
  const connectionConfig = createIsolatedConnectionConfig(
    databaseConfig.databaseUrl,
    harness.schemaName,
  );
  let queryCount = 0;
  const measuredClient = postgres(connectionConfig.url, {
    ...connectionConfig.options,
    debug: () => {
      queryCount += 1;
    },
  });
  const measuredDb = drizzle(measuredClient, { schema });
  const userId = randomUUID();
  const cache = createResponseCache();
  const fixedNow = new Date("2026-09-11T12:00:00.000Z");

  try {
    await harness.db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      name: "Benchmark fixture",
    });
    const item = (
      await harness.db
        .insert(plaidItems)
        .values({
          userId,
          plaidItemId: `item-${randomUUID()}`,
          institutionId: "benchmark_institution",
          institutionName: "Benchmark institution",
          accessTokenEncrypted: "benchmark_encrypted",
          accessTokenNonce: "benchmark_nonce",
        })
        .returning()
    )[0];
    if (!item) throw new Error("Expected benchmark item fixture");
    const accounts = createAccountRepository(measuredDb);
    await accounts.upsertFromPlaid({
      userId,
      plaidItemUuid: item.id,
      account: {
        account_id: `account-${randomUUID()}`,
        name: "Benchmark account",
        type: "depository",
        subtype: "checking",
        mask: "0000",
        balances: { current: 1, available: 1, iso_currency_code: "USD" },
      },
    });
    await harness.db
      .update(featureFlags)
      .set({ enabled: true })
      .where(eq(featureFlags.flagKey, "cash_horizon_v1"));
    await harness.db.insert(featureFlags).values({
      userId,
      flagKey: "cash_horizon_v1",
      enabled: true,
    });

    const revision = () => getUserRevision(userId, measuredDb);
    const reads: ReadonlyArray<{
      family: string;
      read: () => Promise<unknown>;
    }> = [
      {
        family: "dashboard-summary",
        read: () =>
          createDashboardService({
            repository: createDashboardRepository(measuredDb),
            cache,
            getUserRevision: revision,
            now: () => fixedNow,
          }).getSummary(userId),
      },
      {
        family: "accounts",
        read: () =>
          createAccountService({
            repository: accounts,
            cache,
            getUserRevision: revision,
          }).listAccountSummaries(userId),
      },
      {
        family: "transactions-first-page",
        read: () =>
          createTransactionService({
            repository: createTransactionRepository(measuredDb),
            cache,
            getUserRevision: revision,
          }).listTransactions(userId, { limit: 1 }),
      },
      {
        family: "reports",
        read: () =>
          createReportsService({
            repository: createReportsRepository(measuredDb),
            cache,
            getUserRevision: revision,
          }).getReport(userId, {
            type: "monthly_spending",
            dateFrom: "2026-08-01",
            dateTo: "2026-09-11",
          }),
      },
      {
        family: "forecast",
        read: () =>
          createForecastService({
            repository: createForecastRepository(measuredDb),
            cache,
            getUserRevision: revision,
            now: () => fixedNow,
            timezone: "UTC",
            logger: { error: () => undefined },
          }).getForecast(userId, horizon),
      },
    ];
    const metrics: Metric[] = [];
    for (const read of reads) {
      cache.invalidateUser(userId);
      const uncached: number[] = [];
      let latest: unknown;
      queryCount = 0;
      for (let index = 0; index < iterations; index += 1) {
        cache.invalidateUser(userId);
        const result = await timed(read.read);
        uncached.push(result.durationMs);
        latest = result.value;
      }
      const uncachedQueries = queryCount;
      cache.invalidateUser(userId);
      await read.read(); // one repeatable warm-up miss
      const before = cache.stats();
      queryCount = 0;
      const cached: number[] = [];
      for (let index = 0; index < iterations; index += 1) {
        const result = await timed(read.read);
        cached.push(result.durationMs);
        latest = result.value;
      }
      const cachedQueries = queryCount;
      const after = cache.stats();
      metrics.push({
        family: read.family,
        iterations,
        warmupIterations: 1,
        uncached: {
          p50Ms: percentile(uncached, 0.5),
          p95Ms: percentile(uncached, 0.95),
        },
        cached: {
          p50Ms: percentile(cached, 0.5),
          p95Ms: percentile(cached, 0.95),
        },
        cache: {
          hits: after.hits - before.hits,
          misses: after.misses - before.misses,
        },
        serializedBytes: bytes(latest),
        computationMs: percentile(uncached, 0.5),
        measuredQueryCount: {
          uncached: uncachedQueries,
          cached: cachedQueries,
        },
      });
    }
    console.info(
      JSON.stringify(
        {
          fixtureRows: { users: 1, items: 1, accounts: 1, transactions: 0 },
          cacheDefaults: {
            ttlMs: 300000,
            maxEntries: 1000,
            maxBytes: 67108864,
            maxEntryBytes: 2097152,
            cleanupMs: 60000,
          },
          metrics,
          limitations: [
            "Query counts use postgres.js debug callbacks on a second client pinned to the generated test schema; SQL and bindings are never printed.",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await measuredClient.end({ timeout: 5 });
    await harness.cleanup();
  }
}

await main();
