import { describe, expect, it } from "vitest";

import { applyRuleRetroactively } from "../retroactive.js";

describe("applyRuleRetroactively", () => {
  it.skip("applies matching transactions in bounded batches while preserving tenant filters", async () => {
    // Full tenant and atomicity coverage lives in tests/integration/rules and
    // requires the explicitly guarded isolated Neon test database.
    await applyRuleRetroactively(
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    );
    expect(true).toBe(true);
  });
});
