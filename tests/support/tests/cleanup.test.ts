import { describe, expect, it, vi } from "vitest";
import { runCleanupActions } from "../cleanup.js";

describe("runCleanupActions", () => {
  it("attempts every cleanup action and preserves every failure", async () => {
    const first = new Error("listener cleanup failed");
    const second = new Error("schema cleanup failed");
    const finalAction = vi.fn(async () => undefined);

    const failure = await runCleanupActions(
      [
        async () => Promise.reject(first),
        async () => Promise.reject(second),
        finalAction,
      ],
      "integration cleanup failed",
    ).catch((error: unknown) => error);

    expect(finalAction).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([first, second]);
  });
});
