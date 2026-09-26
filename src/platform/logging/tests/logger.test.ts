import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  LOG_DATA_MAX_CHARS,
  truncateLogData,
} from "../logger.js";

describe("logger serialization", () => {
  it("redacts root values, messages, child bindings, and Error metadata", () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const localLogger = createLogger(destination);
    const error = new Error("transaction Rent failed with token secret");
    Object.assign(error, { code: error });

    localLogger.info(
      {
        accessToken: "demo-token",
        databaseUrl: "postgresql://user:password@db.example/centsible",
        payload: { transactionDescription: "Rent" },
        requestId: "req-root",
        route: "/accounts",
        elapsedMs: 12,
        err: error,
      },
      "token message demo-token",
    );
    localLogger.info("access token is %s", "sk_live_interpolation_value");
    localLogger.info("lone-free-form-credential-value-12345");
    localLogger
      .child({
        payload: { transactionDescription: "Rent" },
        requestId: "req-child",
        route: "/transactions",
        elapsedMs: 8,
      })
      .info("request completed");
    localLogger
      .child(
        {
          requestId: "req-silent",
          route: "/silent",
          elapsedMs: 3,
        },
        { level: "silent" },
      )
      .info({ route: "/silent" }, "should not serialize");
    const childOptions = { msgPrefix: "child-option-secret-marker:" };
    localLogger
      .child(
        { requestId: "req-prefix", route: "/prefix", elapsedMs: 2 },
        childOptions,
      )
      .info({ route: "/prefix" }, "prefix message");

    const serialized = chunks.join("");
    expect(serialized).not.toContain("demo-token");
    expect(serialized).not.toContain("sk_live_interpolation_value");
    expect(serialized).not.toContain("lone-free-form-credential-value-12345");
    expect(serialized).not.toContain(
      "postgresql://user:password@db.example/centsible",
    );
    expect(serialized).not.toContain("Rent");
    expect(serialized).not.toContain(
      "transaction Rent failed with token secret",
    );
    expect(serialized).toContain('\\"requestId\\":\\"req-child\\"');
    expect(serialized).not.toContain("req-silent");
    expect(serialized).not.toContain("child-option-secret-marker:");
    expect(serialized).toContain("[REDACTED]");
    expect(childOptions).toEqual({
      msgPrefix: "child-option-secret-marker:",
    });
  });
});

/** Prod runs LOG_REDACTION_MODE=partial, so messages stay readable. */
async function captureLogger() {
  vi.stubEnv("LOG_REDACTION_MODE", "partial");
  vi.resetModules();
  const partial = await import("../logger.js");
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { lines, localLogger: partial.createLogger(destination) };
}

describe("log data truncation", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it("emits call fields then child bindings as one data string cut to 50 chars", async () => {
    const { lines, localLogger } = await captureLogger();
    localLogger
      .child({ requestId: "25f41c31-2e6d-4618-acc9-e02f9b4ca11e" })
      .info(
        { method: "GET", path: "/accounts/summary", status: 200, elapsedMs: 4 },
        "Request complete",
      );

    const line = lines[0] ?? {};
    expect(line.msg).toBe("Request complete");
    expect(line.data).toBe(
      '{"method":"GET","path":"/accounts/summary","status',
    );
    expect(String(line.data)).toHaveLength(LOG_DATA_MAX_CHARS);
    for (const key of ["method", "path", "status", "elapsedMs", "requestId"]) {
      expect(line).not.toHaveProperty(key);
    }
    expect(line).toHaveProperty("pid");
    expect(line).toHaveProperty("hostname");
    expect(line).toHaveProperty("time");
  });

  it("redacts before truncating so a secret is never half-printed", async () => {
    const { lines, localLogger } = await captureLogger();
    localLogger.info({ accessToken: "access-sandbox-abcdef" }, "linked");

    expect(lines[0]?.data).toBe('{"accessToken":"[REDACTED]"}');
  });

  it("keeps short data whole and the message untouched", async () => {
    const { lines, localLogger } = await captureLogger();
    const longMessage = "m".repeat(200);
    localLogger.child({ jobId: "j1" }).info({ n: 1 }, longMessage);
    localLogger.info(longMessage);

    expect(lines[0]).toMatchObject({
      data: '{"n":1,"jobId":"j1"}',
      msg: longMessage,
    });
    expect(lines[1]).not.toHaveProperty("data");
    expect(lines[1]?.msg).toBe(longMessage);
  });

  it("lets call fields win over child bindings with the same key", async () => {
    const { lines, localLogger } = await captureLogger();
    localLogger.child({ route: "/child" }).info({ route: "/call" }, "x");

    expect(lines[0]?.data).toBe('{"route":"/call"}');
  });

  it("respects the child's level option", async () => {
    const { lines, localLogger } = await captureLogger();
    localLogger.child({ a: 1 }, { level: "silent" }).info({ b: 2 }, "hidden");

    expect(lines).toHaveLength(0);
  });

  it("serializes bigint and does not split a surrogate pair", () => {
    expect(truncateLogData({ big: 10n })).toBe('{"big":"10"}');
    const cut = truncateLogData({ s: `${"a".repeat(43)}\u{1F600}tail` });
    expect(cut).toBe(`{"s":"${"a".repeat(43)}`);
    expect(truncateLogData({})).toBeUndefined();
  });
});
