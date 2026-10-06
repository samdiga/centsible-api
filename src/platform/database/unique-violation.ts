/**
 * Detects a Postgres unique-violation (SQLSTATE 23505) even when drizzle-orm
 * wraps the underlying error in a `DrizzleQueryError` (whose own keys are
 * `query`/`params`/`cause`, not `code`). Walks the `.cause` chain up to 8
 * levels deep, with cycle detection.
 */
export function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "23505") return true;
    current = candidate.cause;
  }
  return false;
}
