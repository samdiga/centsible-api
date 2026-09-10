import { describe, expect, it, vi } from "vitest";
import { createRetentionRepository } from "../retention.repository.js";

describe("retention repository", () => {
  it("applies the approved retention windows", async () => {
    const purgeAuditLog = vi.fn(async () => 1);
    const purgeFinishedJobs = vi.fn(async () => 2);
    const purgeForecastRuns = vi.fn(async () => 3);
    const purgeResolvedForecastEvents = vi.fn(async () => 4);
    const purgePipelineRuns = vi.fn(async () => 5);
    const purgeInboundEvents = vi.fn(async () => ({ processed: 6, dead: 7 }));
    const purgeRawImports = vi.fn(async () => 8);
    const repository = createRetentionRepository({
      purgeAuditLog,
      purgeFinishedJobs,
      purgeForecastRuns,
      purgeResolvedForecastEvents,
      purgePipelineRuns,
      purgeInboundEvents,
      purgeRawImports,
    });

    await expect(repository.deleteExpiredOperationalData()).resolves.toEqual({
      auditLog: 1,
      jobs: 2,
      forecastRuns: 3,
      forecastEvents: 4,
      pipelineRuns: 5,
      inboundProcessed: 6,
      inboundDead: 7,
      rawImports: 8,
    });
    expect(purgeAuditLog).toHaveBeenCalledWith(365);
    expect(purgeFinishedJobs).toHaveBeenCalledWith(30);
    expect(purgeForecastRuns).toHaveBeenCalledWith(90);
    expect(purgeResolvedForecastEvents).toHaveBeenCalledWith(90);
    expect(purgePipelineRuns).toHaveBeenCalledWith(90);
    expect(purgeInboundEvents).toHaveBeenCalledWith(30, 90);
    expect(purgeRawImports).toHaveBeenCalledWith(30);
  });
});
