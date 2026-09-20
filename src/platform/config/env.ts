import { randomUUID } from "node:crypto";
import { z } from "zod";

const TEST_SCHEMA_PREFIX = "centsible_test_";

const strictBoolean = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}, z.boolean().default(false));

const positiveInteger = (defaultValue: number) =>
  z.preprocess((value) => {
    if (value === undefined) return defaultValue;
    if (typeof value === "string" && value.trim() === "") return value;
    return typeof value === "number" ? value : Number(value);
  }, z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

const workerSweepInterval = z.preprocess(
  (value) => {
    if (value === undefined) return 360;
    if (typeof value === "string" && value.trim() === "") return value;
    return typeof value === "number" ? value : Number(value);
  },
  z
    .number()
    .int()
    .min(0)
    .max(1_440)
    .refine(
      (value) => value === 0 || value >= 60,
      "worker sweep interval must be 0 or at least 60 minutes",
    ),
);

const workerWakeUrl = z
  .string()
  .url()
  .default("http://127.0.0.1:4011/wake")
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      url.port !== "" &&
      Number(url.port) > 0 &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname !== "/"
    );
  }, "WORKER_WAKE_URL must be an uncredentialed loopback HTTP URL with an explicit port and path");

const optionalBlankString = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() || undefined : value),
  z.string().min(1).optional(),
);

const apiBindAddress = z.union([z.ipv4(), z.ipv6()]).refine((value) => {
  if (value === "127.0.0.1" || value === "::1") return true;
  if (value.toLowerCase().startsWith("fd7a:115c:a1e0:")) return true;

  const octets = value.split(".").map(Number);
  return (
    octets.length === 4 &&
    octets[0] === 100 &&
    octets[1] !== undefined &&
    octets[1] >= 64 &&
    octets[1] <= 127
  );
}, "API_HOST must be loopback or a Tailscale IP address");

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.preprocess(
      (value) =>
        value === undefined
          ? 4000
          : typeof value === "number"
            ? value
            : Number(value),
      z.number().int().positive().max(65_535),
    ),
    API_HOST: apiBindAddress.default("127.0.0.1"),
    DATABASE_URL: z.string().url(),
    DATABASE_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
    TEST_DATABASE_URL: z.string().url().optional(),
    ALLOW_SHARED_SANDBOX_TEST_DATABASE: strictBoolean,
    TEST_SCHEMA_PREFIX: z.string().default(TEST_SCHEMA_PREFIX),
    CLERK_SECRET_KEY: optionalBlankString,
    CLERK_PUBLISHABLE_KEY: optionalBlankString,
    CLERK_JWT_KEY: optionalBlankString,
    PLAID_CLIENT_ID: optionalBlankString,
    PLAID_SECRET: optionalBlankString,
    PLAID_ENV: z
      .enum(["sandbox", "development", "production"])
      .default("sandbox"),
    PLAID_TOKEN_KEY: z.preprocess(
      (value) =>
        typeof value === "string" ? value.trim() || undefined : value,
      z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/)
        .optional(),
    ),
    WEBHOOK_BASE_URL: z.string().url().optional(),
    PLAID_REDIRECT_URI: optionalBlankString,
    API_DOCS_ENABLED: strictBoolean,
    CACHE_ENABLED: strictBoolean,
    CACHE_TTL_MS: positiveInteger(300_000),
    CACHE_MAX_ENTRIES: positiveInteger(1_000),
    CACHE_MAX_BYTES: positiveInteger(67_108_864),
    CACHE_MAX_ENTRY_BYTES: positiveInteger(2_097_152),
    WORKER_ID: optionalBlankString,
    WORKER_SWEEP_INTERVAL_MINUTES: workerSweepInterval,
    WORKER_WAKE_URL: workerWakeUrl,
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error"])
      .default("info"),
  })
  .superRefine((value, context) => {
    if (value.TEST_SCHEMA_PREFIX !== TEST_SCHEMA_PREFIX) {
      context.addIssue({
        code: "custom",
        path: ["TEST_SCHEMA_PREFIX"],
        message: `TEST_SCHEMA_PREFIX must remain ${TEST_SCHEMA_PREFIX}`,
      });
    }

    if (value.CACHE_MAX_ENTRY_BYTES > value.CACHE_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["CACHE_MAX_ENTRY_BYTES"],
        message: "CACHE_MAX_ENTRY_BYTES cannot exceed CACHE_MAX_BYTES",
      });
    }

    if (value.NODE_ENV === "test" && value.DATABASE_ENVIRONMENT !== "sandbox") {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_ENVIRONMENT"],
        message: "test databases must use the sandbox environment",
      });
    }

    if (value.ALLOW_SHARED_SANDBOX_TEST_DATABASE) {
      if (value.NODE_ENV !== "test") {
        context.addIssue({
          code: "custom",
          path: ["ALLOW_SHARED_SANDBOX_TEST_DATABASE"],
          message: "shared test database approval is only valid in test mode",
        });
      }
      if (
        !value.TEST_DATABASE_URL ||
        value.TEST_DATABASE_URL !== value.DATABASE_URL
      ) {
        context.addIssue({
          code: "custom",
          path: ["TEST_DATABASE_URL"],
          message:
            "shared test approval requires TEST_DATABASE_URL to equal DATABASE_URL",
        });
      }
      if (value.DATABASE_ENVIRONMENT !== "sandbox") {
        context.addIssue({
          code: "custom",
          path: ["DATABASE_ENVIRONMENT"],
          message: "shared test databases must use the sandbox environment",
        });
      }
    }

    if (
      value.TEST_DATABASE_URL === value.DATABASE_URL &&
      !value.ALLOW_SHARED_SANDBOX_TEST_DATABASE
    ) {
      context.addIssue({
        code: "custom",
        path: ["ALLOW_SHARED_SANDBOX_TEST_DATABASE"],
        message:
          "using the application database for tests requires explicit approval",
      });
    }

    if (value.NODE_ENV !== "test") {
      const required: Array<keyof typeof value> = [
        "CLERK_SECRET_KEY",
        "CLERK_PUBLISHABLE_KEY",
        "PLAID_CLIENT_ID",
        "PLAID_SECRET",
        "PLAID_TOKEN_KEY",
      ];
      for (const key of required) {
        if (!value[key]) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required outside test mode`,
          });
        }
      }
    }
  });

export interface Env {
  NODE_ENV: "development" | "test" | "production";
  PORT: number;
  API_HOST: string;
  DATABASE_URL: string;
  DATABASE_ENVIRONMENT: "sandbox" | "production";
  TEST_DATABASE_URL?: string | undefined;
  ALLOW_SHARED_SANDBOX_TEST_DATABASE: boolean;
  TEST_SCHEMA_PREFIX: string;
  CLERK_SECRET_KEY?: string | undefined;
  CLERK_PUBLISHABLE_KEY?: string | undefined;
  CLERK_JWT_KEY?: string | undefined;
  PLAID_CLIENT_ID?: string | undefined;
  PLAID_SECRET?: string | undefined;
  PLAID_ENV: "sandbox" | "development" | "production";
  PLAID_TOKEN_KEY?: string | undefined;
  WEBHOOK_BASE_URL?: string | undefined;
  PLAID_REDIRECT_URI?: string | undefined;
  API_DOCS_ENABLED: boolean;
  CACHE_ENABLED: boolean;
  CACHE_TTL_MS: number;
  CACHE_MAX_ENTRIES: number;
  CACHE_MAX_BYTES: number;
  CACHE_MAX_ENTRY_BYTES: number;
  WORKER_ID: string;
  WORKER_SWEEP_INTERVAL_MINUTES: number;
  WORKER_WAKE_URL: string;
  LOG_LEVEL: "trace" | "debug" | "info" | "warn" | "error";
}

/** Parse and validate process configuration before accepting work. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.parse(source);
  return {
    ...parsed,
    WORKER_ID: parsed.WORKER_ID ?? `worker-${process.pid}-${randomUUID()}`,
  };
}

let cached: Env | undefined;

/** Lazily parse the process environment for callers that need a process singleton. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Clear the lazy process configuration cache; intended for isolated tests. */
export function __resetEnvForTests(): void {
  cached = undefined;
}

export { TEST_SCHEMA_PREFIX };
