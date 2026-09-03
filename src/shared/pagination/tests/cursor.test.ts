import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { BadCursorError, decodeCursor, encodeCursor } from "../cursor.js";

describe("cursor encoding", () => {
  it("round-trips a date and UUID cursor value", () => {
    const value = { date: "2026-08-31", id: randomUUID() };

    expect(decodeCursor(encodeCursor(value))).toEqual(value);
  });

  it("rejects non-base64 cursor input with the typed cursor error", () => {
    expect(() => decodeCursor("not-base64")).toThrow(BadCursorError);
  });
});
