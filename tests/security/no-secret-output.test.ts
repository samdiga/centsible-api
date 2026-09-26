import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { createLogger } from "../../src/platform/logging/logger.js";

describe("sensitive output redaction", () => {
  it("omits secret and financial canaries while retaining safe request diagnostics", () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const logger = createLogger(destination);
    const canaries = [
      "clerk-secret-canary",
      "plaid-secret-canary",
      "neon-password-canary",
      "auth-token-canary",
      "transaction-name-canary",
      "personal-financial-value-canary",
      "sensitive-fixture-canary",
    ];

    logger.error(
      {
        clerkSecret: canaries[0],
        plaidSecret: canaries[1],
        databaseUrl: `postgres://user:${canaries[2]}@neon.example/db`,
        authorization: `Bearer ${canaries[3]}`,
        transactionName: canaries[4],
        payload: { balance: canaries[5], fixture: canaries[6] },
        requestId: "req-safe",
        code: "UPSTREAM_FAILED",
        route: "/accounts",
        status: 502,
        elapsedMs: 18,
      },
      "request failed",
    );

    const output = chunks.join("");
    for (const canary of canaries) expect(output).not.toContain(canary);
    // Structured data is redacted first, then cut to its first 50 chars.
    const line = JSON.parse(output) as { data: string };
    expect(line.data).toBe(
      '{"clerkSecret":"[REDACTED]","plaidSecret":"[REDACT',
    );
  });
});
