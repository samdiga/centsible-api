import { bodyLimit } from "hono/body-limit";
import type { MiddlewareHandler } from "hono";
import { AppError } from "../errors/app-error.js";
import { appErrorResponse } from "../errors/error-handler.js";
import type { AppEnv } from "./hono-env.js";

const DEFAULT_MAX_BYTES = 64 * 1024;
const IMPORT_MAX_BYTES = 25 * 1024 * 1024;

const onError: Parameters<typeof bodyLimit>[0]["onError"] = (c) => {
  const requestId = c.res.headers.get("x-request-id") ?? "unknown";
  return appErrorResponse(
    requestId,
    new AppError(
      "PAYLOAD_TOO_LARGE",
      "Payload too large",
      413,
      "Payload too large.",
    ),
  );
};

const defaultLimit = bodyLimit({ maxSize: DEFAULT_MAX_BYTES, onError });
const importLimit = bodyLimit({ maxSize: IMPORT_MAX_BYTES, onError });

/** Applies the larger limit only to the exact backup-import path. */
export function apiBodyLimit(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const limit = c.req.path === "/user/import" ? importLimit : defaultLimit;
    return limit(c, next);
  };
}
