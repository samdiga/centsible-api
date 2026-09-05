import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";
import { getUserRevision } from "../../platform/cache/user-revisions.repository.js";
import { getDb } from "../../platform/database/client.js";
import { FeatureDisabledError } from "../../platform/errors/app-error.js";
import { logger as runtimeLogger } from "../../platform/logging/logger.js";
import { generateForecast } from "./engine/deterministic.js";
import type { ForecastInput, ForecastResult } from "./engine/types.js";
import {
  forecastRepository,
  type ForecastRepository,
} from "./forecast.repository.js";

const CASH_HORIZON_FLAG = "cash_horizon_v1";

type ForecastLogger = Readonly<{
  error: (bindings: Record<string, unknown>, message: string) => unknown;
}>;

export type ForecastService = Readonly<{
  getForecast: (userId: string, horizonDays: number) => Promise<ForecastResult>;
  getAccuracy: (
    userId: string,
  ) => Promise<{ mape30d: number | null; runCount: number }>;
}>;

export type ForecastServiceDependencies = Readonly<{
  repository?: ForecastRepository;
  cache?: Pick<ResponseCache, "getOrCompute">;
  getUserRevision?: (userId: string) => Promise<bigint>;
  now?: () => Date;
  timezone?: string;
  generate?: (input: ForecastInput) => ForecastResult;
  logger?: ForecastLogger;
}>;

function dateInTimeZone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = new Map(
    parts.flatMap((part) =>
      part.type === "year" || part.type === "month" || part.type === "day"
        ? [[part.type, part.value] as const]
        : [],
    ),
  );
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function processTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Creates the cached Forecast use cases and schedules best-effort persistence. */
export function createForecastService(
  dependencies: ForecastServiceDependencies = {},
): ForecastService {
  const repository = dependencies.repository ?? forecastRepository;
  const cache = dependencies.cache ?? createResponseCache();
  const readRevision =
    dependencies.getUserRevision ??
    ((userId: string) => getUserRevision(userId, getDb()));
  const now = dependencies.now ?? (() => new Date());
  const timezone = dependencies.timezone ?? processTimeZone();
  const generate = dependencies.generate ?? generateForecast;
  const serviceLogger = dependencies.logger ?? runtimeLogger;

  return {
    async getForecast(userId, horizonDays) {
      if (!(await repository.isFeatureEnabled(CASH_HORIZON_FLAG, userId)))
        throw new FeatureDisabledError("Cash Horizon is not available yet.");

      const date = dateInTimeZone(now(), timezone);
      const revision = await readRevision(userId);
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/forecast",
          query: { horizonDays: [String(horizonDays)] },
          revision,
          algorithmVersion: "v1",
          horizon: String(horizonDays),
          date,
          timezone,
        },
        async () => {
          const inputs = await repository.getForecastInputs(
            userId,
            horizonDays,
            date,
          );
          const result = generate({
            today: date,
            horizonDays,
            ...inputs,
          });
          void repository
            .saveForecastRun(
              userId,
              result,
              horizonDays,
              inputs.startingBalanceCents,
            )
            .catch((error: unknown) => {
              serviceLogger.error(
                { error, userId, horizonDays },
                "Forecast run persistence failed",
              );
            });
          return result;
        },
      );
    },
    getAccuracy: (userId) => repository.getAccuracySummary(userId),
  };
}
