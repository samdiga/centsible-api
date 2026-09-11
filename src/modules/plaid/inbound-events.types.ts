import type { schema } from "../../platform/database/client.js";

export type InboundEventStatus =
  "pending" | "processing" | "processed" | "dead";
export type InboundWebhookEvent =
  typeof schema.inboundWebhookEvents.$inferSelect & {
    status: InboundEventStatus;
  };
export type InboundWebhookEventInput = Readonly<{
  id?: string;
  provider: string;
  webhookType: string;
  webhookCode: string;
  providerItemId?: string | null;
  payload: unknown;
  payloadDigest: string;
  dedupeKey: string;
  receivedAt?: Date;
}>;

export type ClaimedInboundWebhookEvent = InboundWebhookEvent & {
  status: "processing";
  lockedBy: string;
  leaseToken: string;
  leaseExpiresAt: Date;
};
