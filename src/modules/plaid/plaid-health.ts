import type { PlaidItemHealth } from "./plaid.schemas.js";
import type { PlaidItemRow } from "./plaid-items.repository.js";

/** A connection that hasn't synced successfully for this long counts as stale. */
export const STALE_SYNC_THRESHOLD_MS = 72 * 60 * 60 * 1000;

/**
 * Derives a connection's user-facing health. Shared by `GET /plaid/items` and
 * the sync-health alert job so the banner and the push never disagree.
 */
export function computeItemHealth(
  item: Pick<PlaidItemRow, "status" | "cursor" | "lastSyncAt">,
  now: Date = new Date(),
): PlaidItemHealth {
  if (item.status === "login_required") return "needs_relink";
  if (item.status === "pending_expiration") return "expiring";
  if (item.status === "error" || item.status === "disconnected") return "error";
  if (item.cursor === null) return "ok";
  if (!item.lastSyncAt) return "stale";
  const age = now.getTime() - item.lastSyncAt.getTime();
  return age > STALE_SYNC_THRESHOLD_MS ? "stale" : "ok";
}
