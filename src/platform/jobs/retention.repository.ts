import { and, inArray, isNotNull, lt } from "drizzle-orm";
import { getDb, schema } from "../database/client.js";
import type { Db } from "../database/types.js";

export type RetentionCounts = Readonly<{
  auditLog: number;
  jobs: number;
  forecastRuns: number;
  forecastEvents: number;
  pipelineRuns: number;
  inboundProcessed: number;
  inboundDead: number;
  rawImports: number;
}>;

type RetentionDependencies = Readonly<{
  db?: Db;
  purgeAuditLog?: (days: number) => Promise<number>;
  purgeFinishedJobs?: (days: number) => Promise<number>;
  purgeForecastRuns?: (days: number) => Promise<number>;
  purgeResolvedForecastEvents?: (days: number) => Promise<number>;
  purgePipelineRuns?: (days: number) => Promise<number>;
  purgeInboundEvents?: (
    processedDays: number,
    deadDays: number,
  ) => Promise<{ processed: number; dead: number }>;
  purgeRawImports?: (days: number) => Promise<number>;
}>;

const cutoff = (days: number) => new Date(Date.now() - days * 86_400_000);

/** Centralizes operational retention periods so scheduled and manual runs agree. */
export function createRetentionRepository(
  dependencies: RetentionDependencies = {},
): Readonly<{
  deleteExpiredOperationalData: () => Promise<RetentionCounts>;
}> {
  const database = () => dependencies.db ?? getDb();
  const remove = async (
    table: Parameters<Db["delete"]>[0],
    condition: Parameters<ReturnType<Db["delete"]>["where"]>[0],
  ): Promise<number> => {
    const rows = await database().delete(table).where(condition).returning();
    return rows.length;
  };
  const purgeAuditLog =
    dependencies.purgeAuditLog ??
    ((days: number) =>
      remove(schema.auditLog, lt(schema.auditLog.createdAt, cutoff(days))));
  const purgeFinishedJobs =
    dependencies.purgeFinishedJobs ??
    ((days: number) =>
      remove(
        schema.jobs,
        and(
          inArray(schema.jobs.status, ["completed", "failed"]),
          lt(schema.jobs.createdAt, cutoff(days)),
        ),
      ));
  const purgeForecastRuns =
    dependencies.purgeForecastRuns ??
    ((days: number) =>
      remove(
        schema.forecastRuns,
        lt(schema.forecastRuns.createdAt, cutoff(days)),
      ));
  const purgeResolvedForecastEvents =
    dependencies.purgeResolvedForecastEvents ??
    ((days: number) =>
      remove(
        schema.forecastEvents,
        and(
          isNotNull(schema.forecastEvents.resolvedToTransactionId),
          lt(schema.forecastEvents.createdAt, cutoff(days)),
        ),
      ));
  const purgePipelineRuns =
    dependencies.purgePipelineRuns ??
    ((days: number) =>
      remove(
        schema.pipelineRuns,
        lt(schema.pipelineRuns.createdAt, cutoff(days)),
      ));
  const purgeRawImports =
    dependencies.purgeRawImports ??
    ((days: number) =>
      remove(
        schema.plaidRawImports,
        lt(schema.plaidRawImports.createdAt, cutoff(days)),
      ));
  const purgeInboundEvents =
    dependencies.purgeInboundEvents ??
    (async (processedDays: number, deadDays: number) => {
      const [processed, dead] = await Promise.all([
        remove(
          schema.inboundWebhookEvents,
          and(
            inArray(schema.inboundWebhookEvents.status, ["processed"]),
            lt(schema.inboundWebhookEvents.processedAt, cutoff(processedDays)),
          ),
        ),
        remove(
          schema.inboundWebhookEvents,
          and(
            inArray(schema.inboundWebhookEvents.status, ["dead"]),
            lt(schema.inboundWebhookEvents.receivedAt, cutoff(deadDays)),
          ),
        ),
      ]);
      return { processed, dead };
    });

  return {
    async deleteExpiredOperationalData() {
      const [
        auditLog,
        jobs,
        forecastRuns,
        forecastEvents,
        pipelineRuns,
        inbound,
        rawImports,
      ] = await Promise.all([
        purgeAuditLog(365),
        purgeFinishedJobs(30),
        purgeForecastRuns(90),
        purgeResolvedForecastEvents(90),
        purgePipelineRuns(90),
        purgeInboundEvents(30, 90),
        purgeRawImports(30),
      ]);
      return {
        auditLog,
        jobs,
        forecastRuns,
        forecastEvents,
        pipelineRuns,
        inboundProcessed: inbound.processed,
        inboundDead: inbound.dead,
        rawImports,
      };
    },
  };
}
