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

/**
 * Plaid reports no error, we sync fine, but Plaid hasn't reached the bank
 * for longer than the stale threshold, so nothing new can arrive.
 * Only for an otherwise healthy connection: every other state already has
 * its own, more useful message. Not part of `computeItemHealth`, so it
 * sends no push.
 */
export function isBankNotRefreshing(
  item: Pick<PlaidItemRow, "status" | "cursor" | "lastSyncAt" | "bankLastUpdatedAt">,
  now: Date = new Date(),
): boolean {
  if (computeItemHealth(item, now) !== "ok" || item.cursor === null) return false;
  if (!item.bankLastUpdatedAt) return false;
  return now.getTime() - item.bankLastUpdatedAt.getTime() > STALE_SYNC_THRESHOLD_MS;
}
