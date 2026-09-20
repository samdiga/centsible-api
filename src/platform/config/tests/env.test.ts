import { describe, expect, it } from "vitest";
import { loadEnv } from "../env.js";

const minimalValidEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@example.test/centsible",
  DATABASE_ENVIRONMENT: "sandbox",
};

describe("loadEnv", () => {
  it("uses the approved local defaults", () => {
    const env = loadEnv(minimalValidEnv);

    expect(env.PORT).toBe(4000);
    expect(env.API_HOST).toBe("127.0.0.1");
    expect(env.CACHE_TTL_MS).toBe(300_000);
    expect(env.CACHE_MAX_ENTRIES).toBe(1000);
    expect(env.CACHE_MAX_BYTES).toBe(67_108_864);
    expect(env.CACHE_MAX_ENTRY_BYTES).toBe(2_097_152);
    expect(env.CACHE_ENABLED).toBe(false);
    expect(env.API_DOCS_ENABLED).toBe(false);
    expect(env.ALLOW_SHARED_SANDBOX_TEST_DATABASE).toBe(false);
    expect(env.TEST_SCHEMA_PREFIX).toBe("centsible_test_");
    expect(env.WORKER_ID).toMatch(/^worker-/);
    expect(env.WORKER_SWEEP_INTERVAL_MINUTES).toBe(360);
    expect(env.WORKER_WAKE_URL).toBe("http://127.0.0.1:4011/wake");
  });

  it.each([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ] as const)("parses CACHE_ENABLED=%s", (value, expected) => {
    expect(
      loadEnv({ ...minimalValidEnv, CACHE_ENABLED: value }).CACHE_ENABLED,
    ).toBe(expected);
  });

  it("rejects a non-boolean CACHE_ENABLED value", () => {
    expect(() =>
      loadEnv({ ...minimalValidEnv, CACHE_ENABLED: "yes" }),
    ).toThrow();
  });

  it.each(["0", "60", "360", "1440"])(
    "accepts a safe worker sweep interval: %s",
    (value) => {
      expect(
        loadEnv({ ...minimalValidEnv, WORKER_SWEEP_INTERVAL_MINUTES: value })
          .WORKER_SWEEP_INTERVAL_MINUTES,
      ).toBe(Number(value));
    },
  );

  it.each(["-1", "1", "59", "1441", "60.5", "not-a-number"])(
    "rejects an unsafe worker sweep interval: %s",
    (value) => {
      expect(() =>
        loadEnv({ ...minimalValidEnv, WORKER_SWEEP_INTERVAL_MINUTES: value }),
      ).toThrow();
    },
  );

  it.each([
    "https://127.0.0.1:4011/wake",
    "http://localhost:4011/wake",
    "http://0.0.0.0:4011/wake",
    "http://192.168.1.20:4011/wake",
    "http://127.0.0.1/wake",
    "http://127.0.0.1:0/wake",
    "http://user:secret@127.0.0.1:4011/wake",
    "http://127.0.0.1:4011/wake?token=secret",
    "http://127.0.0.1:4011/wake#fragment",
  ])("rejects an unsafe worker wake URL: %s", (value) => {
    expect(() =>
      loadEnv({ ...minimalValidEnv, WORKER_WAKE_URL: value }),
    ).toThrow();
  });

  it.each(["http://127.0.0.1:4011/wake", "http://[::1]:4011/internal/wake"])(
    "accepts a loopback worker wake URL: %s",
    (value) => {
      expect(
        loadEnv({ ...minimalValidEnv, WORKER_WAKE_URL: value }).WORKER_WAKE_URL,
      ).toBe(value);
    },
  );

  it.each(["0", "-1", "1.5", "not-a-number"])(
    "rejects an invalid port: %s",
    (port) => {
      expect(() => loadEnv({ ...minimalValidEnv, PORT: port })).toThrow();
    },
  );

  it("rejects a port above the TCP port range", () => {
    expect(() => loadEnv({ ...minimalValidEnv, PORT: "65536" })).toThrow();
  });

  it.each([
    "localhost",
    "0.0.0.0",
    "::",
    "192.168.1.20",
    "203.0.113.42",
    "100.63.255.255",
    "100.128.0.1",
    "0.0.0.0/0",
    "100.64.0.1:4000",
    "not-an-ip",
  ])("rejects an invalid API bind address: %s", (host) => {
    expect(() => loadEnv({ ...minimalValidEnv, API_HOST: host })).toThrow();
  });

  it.each([
    "127.0.0.1",
    "::1",
    "100.64.0.42",
    "100.127.255.255",
    "fd7a:115c:a1e0::42",
  ])("accepts an IP literal API bind address: %s", (host) => {
    expect(loadEnv({ ...minimalValidEnv, API_HOST: host }).API_HOST).toBe(host);
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
