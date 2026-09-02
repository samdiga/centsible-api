import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const minimalValidEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@example.test/centsible",
  DATABASE_ENVIRONMENT: "sandbox",
};

describe("loadEnv", () => {
  it("uses the approved local defaults", () => {
    const env = loadEnv(minimalValidEnv);

    expect(env.PORT).toBe(4000);
    expect(env.CACHE_TTL_MS).toBe(300_000);
    expect(env.CACHE_MAX_ENTRIES).toBe(1000);
    expect(env.CACHE_MAX_BYTES).toBe(67_108_864);
    expect(env.CACHE_MAX_ENTRY_BYTES).toBe(2_097_152);
    expect(env.API_DOCS_ENABLED).toBe(false);
    expect(env.ALLOW_SHARED_SANDBOX_TEST_DATABASE).toBe(false);
    expect(env.TEST_SCHEMA_PREFIX).toBe("centsible_test_");
    expect(env.WORKER_ID).toMatch(/^worker-/);
  });

  it.each(["0", "-1", "1.5", "not-a-number"])(
    "rejects an invalid port: %s",
    (port) => {
      expect(() => loadEnv({ ...minimalValidEnv, PORT: port })).toThrow();
    },
  );

  it("rejects a port above the TCP port range", () => {
    expect(() => loadEnv({ ...minimalValidEnv, PORT: "65536" })).toThrow();
  });

  it.each(["0", "-1", "1.5", "not-a-number"])(
    "rejects invalid cache limits: %s",
    (value) => {
      expect(() =>
        loadEnv({ ...minimalValidEnv, CACHE_MAX_ENTRIES: value }),
      ).toThrow();
    },
  );

  it("rejects an entry limit larger than the total byte budget", () => {
    expect(() =>
      loadEnv({
        ...minimalValidEnv,
        CACHE_MAX_BYTES: "100",
        CACHE_MAX_ENTRY_BYTES: "101",
      }),
    ).toThrow();
  });

  it("parses only explicit boolean spellings", () => {
    expect(
      loadEnv({
        ...minimalValidEnv,
        API_DOCS_ENABLED: "true",
        ALLOW_SHARED_SANDBOX_TEST_DATABASE: "false",
      }),
    ).toMatchObject({
      API_DOCS_ENABLED: true,
      ALLOW_SHARED_SANDBOX_TEST_DATABASE: false,
    });

    expect(
      loadEnv({
        ...minimalValidEnv,
        API_DOCS_ENABLED: "false",
        ALLOW_SHARED_SANDBOX_TEST_DATABASE: "0",
      }),
    ).toMatchObject({
      API_DOCS_ENABLED: false,
      ALLOW_SHARED_SANDBOX_TEST_DATABASE: false,
    });

    expect(() =>
      loadEnv({ ...minimalValidEnv, API_DOCS_ENABLED: "yes" }),
    ).toThrow();
  });

  it("requires a valid database URL in every mode", () => {
    expect(() =>
      loadEnv({ ...minimalValidEnv, DATABASE_URL: undefined }),
    ).toThrow();
    expect(() =>
      loadEnv({ ...minimalValidEnv, DATABASE_URL: "not-a-url" }),
    ).toThrow();
  });

  it("requires Clerk and Plaid credentials outside test mode", () => {
    const runtimeEnv = {
      ...minimalValidEnv,
      NODE_ENV: "development",
      CLERK_SECRET_KEY: "clerk-secret",
      CLERK_PUBLISHABLE_KEY: "clerk-publishable",
      PLAID_CLIENT_ID: "plaid-client",
      PLAID_SECRET: "plaid-secret",
      PLAID_TOKEN_KEY:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };

    expect(loadEnv(runtimeEnv)).toMatchObject({ NODE_ENV: "development" });
    expect(() =>
      loadEnv({ ...runtimeEnv, CLERK_SECRET_KEY: undefined }),
    ).toThrow();
    expect(() => loadEnv({ ...runtimeEnv, PLAID_SECRET: undefined })).toThrow();
  });

  it.each([
    "CLERK_SECRET_KEY",
    "CLERK_PUBLISHABLE_KEY",
    "PLAID_CLIENT_ID",
    "PLAID_SECRET",
    "PLAID_TOKEN_KEY",
  ] as const)("rejects whitespace-only %s", (credential) => {
    const runtimeEnv = {
      ...minimalValidEnv,
      NODE_ENV: "development" as const,
      CLERK_SECRET_KEY: "clerk-secret",
      CLERK_PUBLISHABLE_KEY: "clerk-publishable",
      PLAID_CLIENT_ID: "plaid-client",
      PLAID_SECRET: "plaid-secret",
      PLAID_TOKEN_KEY:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };

    expect(() => loadEnv({ ...runtimeEnv, [credential]: "   " })).toThrow();
  });

  it("does not require external-provider secrets in test mode", () => {
    expect(loadEnv(minimalValidEnv)).toMatchObject({ NODE_ENV: "test" });
  });

  it("guards shared test databases to the sandbox and explicit opt-in", () => {
    const shared = {
      ...minimalValidEnv,
      TEST_DATABASE_URL: minimalValidEnv.DATABASE_URL,
    };
    expect(() => loadEnv(shared)).toThrow();
    expect(
      loadEnv({ ...shared, ALLOW_SHARED_SANDBOX_TEST_DATABASE: "true" }),
    ).toMatchObject({ ALLOW_SHARED_SANDBOX_TEST_DATABASE: true });
    expect(() =>
      loadEnv({
        ...shared,
        ALLOW_SHARED_SANDBOX_TEST_DATABASE: "true",
        DATABASE_ENVIRONMENT: "production",
      }),
    ).toThrow();
    expect(() =>
      loadEnv({
        ...shared,
        ALLOW_SHARED_SANDBOX_TEST_DATABASE: "true",
        NODE_ENV: "production",
      }),
    ).toThrow();
  });

  it("rejects an overridden test schema prefix", () => {
    expect(() =>
      loadEnv({ ...minimalValidEnv, TEST_SCHEMA_PREFIX: "public" }),
    ).toThrow();
  });
});
