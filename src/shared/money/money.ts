import { ValidationError } from "../../platform/errors/app-error.js";

/** Converts integer cents to the string representation used at API boundaries. */
export function centsToWire(value: bigint | null): string | null {
  return value?.toString() ?? null;
}

/** Parses API-boundary cents without accepting fractional or unsafe number values. */
export function wireToCents(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new ValidationError("Cents must be an integer string");
  }
}
