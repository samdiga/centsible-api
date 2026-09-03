/** Converts optional dates to the ISO-8601 wire format. */
export function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}
