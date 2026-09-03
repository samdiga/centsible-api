import { describe, expect, it } from "vitest";
import { redactLogValue } from "../redaction.js";

describe("redactLogValue", () => {
  it("redacts nested secrets and financial payload text", () => {
    expect(
      redactLogValue({ accessToken: "secret", transactionName: "Rent" }),
    ).toEqual({
      accessToken: "[REDACTED]",
      transactionName: "[REDACTED]",
    });
  });

  it("redacts matching keys case-insensitively through arrays", () => {
    expect(
      redactLogValue([
        { SECRET: "one", nested: [{ accountNumber: "two" }] },
        { harmless: "three", payload: { description: "four" } },
      ]),
    ).toEqual([
      { SECRET: "[REDACTED]", nested: [{ accountNumber: "[REDACTED]" }] },
      { harmless: "three", payload: "[REDACTED]" },
    ]);
  });

  it("does not mutate its input", () => {
    const input = { nested: { password: "secret" } };
    const output = redactLogValue(input);

    expect(input).toEqual({ nested: { password: "secret" } });
    expect(output).not.toBe(input);
  });

  it("handles circular values without recursing forever", () => {
    const input: { self?: unknown; token?: string } = { token: "secret" };
    input.self = input;

    expect(redactLogValue(input)).toEqual({
      token: "[REDACTED]",
      self: "[Circular]",
    });
  });

  it("handles circular Error metadata without recursing or leaking", () => {
    const error = new Error("transaction Rent failed with token secret");
    Object.assign(error, { code: error });

    expect(redactLogValue(error)).toMatchObject({
      name: "Error",
      message: "[REDACTED]",
      stack: "[REDACTED]",
      code: "[Circular]",
    });
  });

  it("handles errors and non-plain objects without exposing values", () => {
    const error = new Error("transaction Rent failed with token secret");
    const output = redactLogValue({ error, when: new Date("2020-01-01") }) as {
      error: Record<string, unknown>;
      when: Date;
    };

    expect(output.error.name).toBe("Error");
    expect(output.error.message).toBe("[REDACTED]");
    expect(output.error.stack).toBe("[REDACTED]");
    expect(output.when).toEqual(new Date("2020-01-01"));
  });

  it("preserves harmless operational fields", () => {
    expect(
      redactLogValue({ requestId: "req-123", route: "/health", elapsedMs: 4 }),
    ).toEqual({ requestId: "req-123", route: "/health", elapsedMs: 4 });
  });
});
