import { describe, expect, it } from "vitest";

import { splitImportBatches } from "../user-data.repository.js";

describe("user data import batching", () => {
  it("keeps high-cardinality inserts below the parameter-safe batch size", () => {
    const values = Array.from({ length: 5_001 }, (_, index) => index);
    const batches = splitImportBatches(values);
    expect(batches.map((batch) => batch.length)).toEqual([
      500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 1,
    ]);
    expect(
      Math.max(...batches.map((batch) => batch.length)),
    ).toBeLessThanOrEqual(500);
  });
});
