import { describe, expect, it } from "vitest";

import { toIso } from "../date.js";

describe("toIso", () => {
  it("serializes dates for the wire and preserves nulls", () => {
    expect(toIso(new Date("2026-08-31T12:34:56.789Z"))).toBe(
      "2026-08-31T12:34:56.789Z",
    );
    expect(toIso(null)).toBeNull();
  });
});
