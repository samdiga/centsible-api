import type { MiddlewareHandler } from "hono";
import { logger } from "../logging/logger.js";
import type { AppEnv } from "./hono-env.js";

export type RequestLogChild = {
  debug: (bindings: Record<string, unknown>, message: string) => unknown;
};

export type RequestLogRoot = {
  child: (bindings: Record<string, unknown>) => RequestLogChild;
};

/** Records both successful and error responses with the request's correlation ID. */
export function requestLog(
  rootLogger: RequestLogRoot = logger,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const startedAt = Date.now();
    const requestLogger = rootLogger.child({ requestId: c.get("requestId") });
    requestLogger.debug(
      { method: c.req.method, path: c.req.path },
      "Incoming request",
    );
    try {
      await next();
    } finally {
      requestLogger.debug(
        {
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          elapsedMs: Date.now() - startedAt,
        },
        "Request complete",
      );
    }
  };
}
