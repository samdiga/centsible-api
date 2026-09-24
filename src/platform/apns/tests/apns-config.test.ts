import { describe, expect, it } from "vitest";

import type { Env } from "../../config/env.js";
import { loadApnsConfig } from "../apns-config.js";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    PORT: 4000,
    API_HOST: "127.0.0.1",
    DATABASE_URL: "postgres://localhost/test",
    DATABASE_ENVIRONMENT: "sandbox",
    ALLOW_SHARED_SANDBOX_TEST_DATABASE: false,
    TEST_SCHEMA_PREFIX: "centsible_test_",
    PLAID_ENV: "sandbox",
    API_DOCS_ENABLED: false,
    CACHE_ENABLED: false,
    CACHE_TTL_MS: 300_000,
    CACHE_MAX_ENTRIES: 1_000,
    CACHE_MAX_BYTES: 67_108_864,
    CACHE_MAX_ENTRY_BYTES: 2_097_152,
    WORKER_ID: "worker-test",
    WORKER_SWEEP_INTERVAL_MINUTES: 360,
    WORKER_WAKE_URL: "http://127.0.0.1:4011/wake",
    APNS_ENV: "sandbox",
    LOG_LEVEL: "info",
    ...overrides,
  };
}

describe("loadApnsConfig", () => {
  it("returns undefined when any required key is missing", () => {
    expect(loadApnsConfig(baseEnv())).toBeUndefined();
    expect(
      loadApnsConfig(
        baseEnv({
          APNS_KEY_ID: "key-1",
          APNS_TEAM_ID: "team-1",
          APNS_BUNDLE_ID: "com.centsible.app",
        }),
      ),
    ).toBeUndefined();
  });

  it("builds config and normalizes escaped newlines in the private key", () => {
    const config = loadApnsConfig(
      baseEnv({
        APNS_KEY_ID: "key-1",
        APNS_TEAM_ID: "team-1",
        APNS_BUNDLE_ID: "com.centsible.app",
        APNS_PRIVATE_KEY:
          "-----BEGIN EC PRIVATE KEY-----\\nabc\\n-----END EC PRIVATE KEY-----",
        APNS_ENV: "production",
      }),
    );

    expect(config).toEqual({
      keyId: "key-1",
      teamId: "team-1",
      bundleId: "com.centsible.app",
      privateKey:
        "-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----",
      environment: "production",
    });
  });

  it("leaves a private key with real newlines untouched", () => {
    const config = loadApnsConfig(
      baseEnv({
        APNS_KEY_ID: "key-1",
        APNS_TEAM_ID: "team-1",
        APNS_BUNDLE_ID: "com.centsible.app",
        APNS_PRIVATE_KEY: "line1\nline2",
      }),
    );

    expect(config?.privateKey).toBe("line1\nline2");
  });
});
