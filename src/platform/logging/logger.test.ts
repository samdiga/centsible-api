import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

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
    localLogger
      .child({
        payload: { transactionDescription: "Rent" },
        requestId: "req-child",
        route: "/transactions",
        elapsedMs: 8,
      })
      .info("request completed");

    const serialized = chunks.join("");
    expect(serialized).not.toContain("demo-token");
    expect(serialized).not.toContain(
      "postgresql://user:password@db.example/centsible",
    );
    expect(serialized).not.toContain("Rent");
    expect(serialized).not.toContain(
      "transaction Rent failed with token secret",
    );
    expect(serialized).toContain('"requestId":"req-root"');
    expect(serialized).toContain('"requestId":"req-child"');
    expect(serialized).toContain('"route":"/accounts"');
    expect(serialized).toContain('"elapsedMs":12');
    expect(serialized).toContain('"elapsedMs":8');
  });
});
