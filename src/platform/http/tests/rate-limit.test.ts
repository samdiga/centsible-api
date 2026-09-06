import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RateLimitError } from "../../errors/app-error.js";
import { consumeToken, resetTokenBucketsForTests } from "../rate-limit.js";

describe("token bucket rate limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTokenBucketsForTests();
  });
  afterEach(() => {
    resetTokenBucketsForTests();
    vi.useRealTimers();
  });

  it("keeps independent per-key capacity and refill", () => {
    const config = { capacity: 2, refillPerMinute: 60 };
    consumeToken("a", config);
    consumeToken("a", config);
    expect(() => consumeToken("a", config)).toThrow(RateLimitError);
    consumeToken("b", config);
    vi.advanceTimersByTime(1_000);
    consumeToken("a", config);
  });
});
