/**
 * A timestamp read through raw `db.execute`, as a Date.
 *
 * Drizzle's postgres-js driver turns off the client's timestamptz parsing, so
 * a raw query hands back the column as a string even when typed as Date.
 * Anything that isn't a valid instant becomes null rather than a Date that
 * throws or compares as NaN later.
 */
export function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}
