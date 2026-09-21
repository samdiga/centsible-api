import { ZodError } from "zod";
import type { Context } from "hono";
import { logger, redactLogValue } from "../logging/logger.js";
import type { AppEnv } from "../http/hono-env.js";
import {
  AppError,
  RateLimitError,
  ValidationError,
  type ValidationIssue,
} from "./app-error.js";

type ErrorLogger = {
  error: (bindings: Record<string, unknown>, message: string) => unknown;
};

type ErrorBody = {
  error: { code: string; message: string; details?: unknown };
  requestId: string;
};

type SafeDiagnostic = {
  name: string;
  code?: string | number;
  status?: number;
  statusCode?: number;
  stack?: string[];
  cause?: SafeDiagnostic | { cycle: true };
  upstream?: Record<string, string>;
};

const MAX_STACK_FRAMES = 8;
const MAX_DIAGNOSTIC_CHARS = 400;
const MAX_CAUSE_DEPTH = 3;
const sensitiveDiagnosticText =
  /token|secret|password|account(?:number)?|transaction|description|payload/i;

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
  if (error instanceof RateLimitError) {
    response.headers.set("retry-after", String(error.retryAfterSeconds));
  }
  return response;
}

/** Creates the API's stable error envelope and always propagates the request ID. */
export function errorResponse(c: Context<AppEnv>, error: AppError): Response {
  return appErrorResponse(requestIdFor(c), error);
}

function toAppError(error: unknown): AppError | undefined {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    const issues: ValidationIssue[] = error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map((segment) =>
        typeof segment === "string" || typeof segment === "number"
          ? segment
          : String(segment),
      ),
    }));
    return new ValidationError("Invalid request", issues);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function getProperty(record: Record<string, unknown>, key: string): unknown {
  try {
    return Reflect.get(record, key);
  } catch {
    return undefined;
  }
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== "string" || sensitiveDiagnosticText.test(value)) {
    return undefined;
  }
  return value.slice(0, MAX_DIAGNOSTIC_CHARS);
}

function safeStack(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const frames = value
    .split("\n")
    .slice(1, MAX_STACK_FRAMES + 1)
    .filter((frame) => /^\s+at\s/.test(frame))
    .map(safeText)
    .filter((frame): frame is string => frame !== undefined);
  return frames.length > 0 ? frames : undefined;
}

function safeUpstream(
  record: Record<string, unknown>,
): Record<string, string> | undefined {
  const response = asRecord(getProperty(record, "response"));
  const data = response && asRecord(getProperty(response, "data"));
  if (!data) return undefined;

  const upstream: Record<string, string> = {};
  for (const key of [
    "error_code",
    "error_type",
    "error_message",
    "request_id",
  ]) {
    const value = safeText(getProperty(data, key));
    if (value !== undefined) upstream[key] = value;
  }
  return Object.keys(upstream).length > 0 ? upstream : undefined;
}

function safeDiagnostic(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): SafeDiagnostic | { cycle: true } {
  const record = asRecord(value);
  if (!record) return { name: typeof value };
  if (seen.has(record)) return { cycle: true };
  seen.add(record);

  const name = safeText(getProperty(record, "name")) ?? "UnknownError";
  const diagnostic: SafeDiagnostic = { name };
  const code = getProperty(record, "code");
  if (typeof code === "number") {
    diagnostic.code = code;
  } else {
    const safeCode = safeText(code);
    if (safeCode !== undefined) diagnostic.code = safeCode;
  }
  for (const key of ["status", "statusCode"] as const) {
    const value = getProperty(record, key);
    if (typeof value === "number" && Number.isFinite(value)) {
      diagnostic[key] = value;
    }
  }
  const stack = safeStack(getProperty(record, "stack"));
  if (stack) diagnostic.stack = stack;
  const upstream = safeUpstream(record);
  if (upstream) diagnostic.upstream = upstream;
  if (depth < MAX_CAUSE_DEPTH) {
    const cause = getProperty(record, "cause");
    if (cause !== undefined) {
      diagnostic.cause = safeDiagnostic(cause, seen, depth + 1);
    }
  }
  seen.delete(record);
  return diagnostic;
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
      diagnostic: redactLogValue(safeDiagnostic(error)),
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
