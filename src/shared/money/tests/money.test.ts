import { describe, expect, it } from "vitest";

import { ValidationError } from "../../../platform/errors/app-error.js";
import { centsToWire, wireToCents } from "../money.js";

describe("money wire conversions", () => {
  it("serializes integer cents without changing their sign", () => {
    expect(centsToWire(0n)).toBe("0");
    expect(centsToWire(-125n)).toBe("-125");
    expect(centsToWire(null)).toBeNull();
  });

  it("rejects fractional wire values instead of silently rounding them", () => {
    expect(() => wireToCents("1.25")).toThrow(ValidationError);
  });
});
