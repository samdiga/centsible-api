import type {
  AccountRefresher,
  ActiveItemUnlinker,
} from "../accounts/index.js";
import type { PlaidService } from "./plaid.service.js";

export { registerPlaidRoutes } from "./plaid.routes.js";
export { createPlaidService } from "./plaid.service.js";
export type {
  PlaidService,
  PlaidServiceDependencies,
} from "./plaid.service.js";
export { createPlaidItemsRepository } from "./plaid-items.repository.js";
export { createPlaidLiabilitiesService } from "./plaid-liabilities.service.js";
export { createPlaidSyncService } from "./plaid-sync.service.js";
export { createInboundEventHandler } from "./inbound-event-handler.js";
export { createInboundEventsPoller } from "./inbound-events-poller.js";
export {
  createInboundEventsRepository,
  INBOUND_EVENT_LEASE_MS,
  INBOUND_EVENT_MAX_ATTEMPTS,
  nextRetryAt,
} from "./inbound-events.repository.js";
export type {
  PlaidSyncResult,
  PlaidSyncService,
} from "./plaid-sync.service.js";
export type {
  ClaimedInboundWebhookEvent,
  InboundEventStatus,
  InboundWebhookEvent,
  InboundWebhookEventInput,
} from "./inbound-events.types.js";
export type {
  InboundEventHandler,
  InboundEventResult,
} from "./inbound-event-handler.js";
export type { InboundEventsRepository } from "./inbound-events.repository.js";
export type {
  LiabilitiesSyncResult,
  PlaidLiabilitiesService,
} from "./plaid-liabilities.service.js";
export type {
  PlaidItemRow,
  PlaidItemsRepository,
} from "./plaid-items.repository.js";

export function createPlaidAccountRefresher(
  service: PlaidService,
): AccountRefresher {
  return {
    refreshAccountBalance: (input) => service.refreshAccountBalance(input),
  };
}

export function createPlaidAccountUnlinker(
  service: PlaidService,
): ActiveItemUnlinker {
  return {
    unlinkActiveItem: (input) => service.unlinkActiveItem(input),
  };
}

export function createPlaidUserDataRevoker(
  service: PlaidService,
): (userId: string) => Promise<void> {
  return (userId) => service.revokeAllItems(userId);
}
