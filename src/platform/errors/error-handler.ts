import { ZodError } from "zod";
import type { Context } from "hono";
import { logger, redactLogValue } from "../logging/logger.js";
import type { AppEnv } from "../http/hono-env.js";
import { AppError, ValidationError, type ValidationPath } from "./app-error.js";

type ErrorLogger = {
  error: (bindings: Record<string, unknown>, message: string) => unknown;
};

type ErrorBody = {
  error: { code: string; message: string; details?: unknown };
  requestId: string;
};

function requestIdFor(c: Context<AppEnv>): string {
  return c.get("requestId") ?? "unknown";
}

/** Builds the API's stable error envelope for a known request ID. */
export function appErrorResponse(requestId: string, error: AppError): Response {
  const details =
    error.details === undefined ? undefined : { details: error.details };
  const body: ErrorBody = {
    error: { code: error.code, message: error.userMessage, ...details },
    requestId,
  };
  const response = new Response(JSON.stringify(body), {
    status: error.httpStatus,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
  response.headers.set("x-request-id", body.requestId);
  return response;
}

/** Creates the API's stable error envelope and always propagates the request ID. */
export function errorResponse(c: Context<AppEnv>, error: AppError): Response {
  return appErrorResponse(requestIdFor(c), error);
}

function toAppError(error: unknown): AppError | undefined {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    const paths: ValidationPath[] = error.issues.map((issue) =>
      issue.path.map((segment) =>
        typeof segment === "string" || typeof segment === "number"
          ? segment
          : String(segment),
      ),
    );
    return new ValidationError("Invalid request", paths);
  }
  return undefined;
}

/** Converts expected errors and validation failures into a stable public response. */
export function handleError(
  error: Error | unknown,
  c: Context<AppEnv>,
  errorLogger: ErrorLogger = logger,
): Response {
  const appError = toAppError(error);
  if (appError) return errorResponse(c, appError);

  errorLogger.error(
    {
      requestId: requestIdFor(c),
      route: c.req.path,
      error: redactLogValue(error),
    },
    "Unhandled HTTP error",
  );
  return errorResponse(
    c,
    new AppError(
      "INTERNAL",
      "Internal server error",
      500,
      "Something went wrong.",
    ),
  );
}
