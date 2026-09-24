import { describe, expect, it } from "vitest";

import { createHttpApp } from "../../src/app/create-http-app.js";
import type { Env } from "../../src/platform/config/env.js";
import { AuthenticationError } from "../../src/platform/errors/app-error.js";
import { createOpenApiDocument } from "../../src/platform/openapi/document.js";

const canaries = {
  CLERK_SECRET_KEY: "clerk-secret-canary",
  PLAID_SECRET: "plaid-secret-canary",
  DATABASE_URL: "https://neon-canary.example/database",
};

const docsEnv: Env = {
  NODE_ENV: "test",
  PORT: 4001,
  API_HOST: "127.0.0.1",
  DATABASE_URL: canaries.DATABASE_URL,
  DATABASE_ENVIRONMENT: "sandbox",
  ALLOW_SHARED_SANDBOX_TEST_DATABASE: false,
  TEST_SCHEMA_PREFIX: "centsible_test_",
  CLERK_SECRET_KEY: canaries.CLERK_SECRET_KEY,
  CLERK_PUBLISHABLE_KEY: "pk_test_docs_canary",
  PLAID_CLIENT_ID: "plaid-client-canary",
  PLAID_SECRET: canaries.PLAID_SECRET,
  PLAID_ENV: "sandbox",
  PLAID_TOKEN_KEY: "0".repeat(64),
  API_DOCS_ENABLED: true,
  CACHE_ENABLED: false,
  CACHE_TTL_MS: 300_000,
  CACHE_MAX_ENTRIES: 1_000,
  CACHE_MAX_BYTES: 67_108_864,
  CACHE_MAX_ENTRY_BYTES: 2_097_152,
  WORKER_ID: "test-worker",
  WORKER_SWEEP_INTERVAL_MINUTES: 360,
  WORKER_WAKE_URL: "http://127.0.0.1:4011/wake",
  APNS_ENV: "sandbox",
  LOG_LEVEL: "silent" as Env["LOG_LEVEL"],
};

function docsApp() {
  return createHttpApp({
    env: docsEnv,
    auth: async (context, next) => {
      if (context.req.header("authorization") !== "Bearer test-token") {
        throw new AuthenticationError();
      }
      await next();
    },
  });
}

describe("OpenAPI security", () => {
  it("does not include configured secret canaries in the document", () => {
    const document = JSON.stringify(createOpenApiDocument(docsApp()));
    for (const canary of Object.values(canaries)) {
      expect(document).not.toContain(canary);
    }
  });

  it("keeps health public and every other operation Clerk bearer protected", () => {
    const document = createOpenApiDocument(docsApp()) as {
      paths: Record<string, Record<string, { security?: unknown }>>;
    };
    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (path === "/health" && method === "get") {
          expect(operation.security).toBeUndefined();
        } else {
          expect(operation.security, `${method.toUpperCase()} ${path}`).toEqual(
            [{ bearerAuth: [] }],
          );
        }
      }
    }
  });

  it("rejects unauthenticated OpenAPI requests when docs are enabled", async () => {
    const response = await docsApp().request("/openapi.json");
    expect(response.status).toBe(401);
  });
});
