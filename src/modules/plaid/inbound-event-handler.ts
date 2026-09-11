import { getDb } from "../../platform/database/client.js";
import type { DbTransaction } from "../../platform/database/types.js";
import {
  auditLogRepository,
  type AuditLogRepository,
} from "../../platform/database/audit-log.repository.js";
import {
  createWithUserMutation,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import { startPipelineRun } from "../pipeline/pipeline.service.js";
import {
  createPlaidItemsRepository,
  type PlaidItemsRepository,
} from "./plaid-items.repository.js";
import type { InboundWebhookEvent } from "./inbound-events.types.js";

export type InboundEventResult = "processed" | "duplicate" | "ignored";
export type InboundEventHandler = (
  event: InboundWebhookEvent,
  context?: Readonly<{ signal: AbortSignal }>,
) => Promise<InboundEventResult>;

type Dependencies = Readonly<{
  items?: Pick<PlaidItemsRepository, "findByPlaidItemId" | "markWebhookStatus">;
  startPipeline?: typeof startPipelineRun;
  withUserMutation?: UserMutationService["withUserMutation"];
  audit?: Pick<AuditLogRepository, "record">;
}>;

function errorDetails(payload: unknown): { code: string; message: string } {
  if (typeof payload !== "object" || payload === null)
    return { code: "UNKNOWN", message: "" };
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null)
    return { code: "UNKNOWN", message: "" };
  const value = error as { error_code?: unknown; error_message?: unknown };
  return {
    code:
      typeof value.error_code === "string" && value.error_code
        ? value.error_code
        : "UNKNOWN",
    message: typeof value.error_message === "string" ? value.error_message : "",
  };
}

export function createInboundEventHandler(
  dependencies: Dependencies = {},
): InboundEventHandler {
  const items = dependencies.items ?? createPlaidItemsRepository(getDb());
  const start = dependencies.startPipeline ?? startPipelineRun;
  const audit = dependencies.audit ?? auditLogRepository;
  const mutate =
    dependencies.withUserMutation ??
    createWithUserMutation({
      db: getDb(),
      cache: { invalidateUser: () => undefined },
    });

  return async (event, context) => {
    const checkCancelled = (): void => context?.signal.throwIfAborted();
    checkCancelled();
    if (event.provider !== "plaid" || !event.providerItemId) return "ignored";
    const item = await items.findByPlaidItemId(event.providerItemId);
    checkCancelled();
    if (!item || item.deletedAt) return "ignored";
    const code = `${event.webhookType}:${event.webhookCode}`;
    if (code === "TRANSACTIONS:SYNC_UPDATES_AVAILABLE") {
      const result = await start({ userId: item.userId, trigger: "webhook" });
      checkCancelled();
      return result.deduped ? "duplicate" : "processed";
    }
    if (code === "ITEM:ERROR") {
      const details = errorDetails(event.payload);
      const status =
        details.code === "ITEM_LOGIN_REQUIRED" ? "login_required" : "error";
      await mutate(item.userId, async (tx: DbTransaction) => {
        checkCancelled();
        await items.markWebhookStatus(
          item.id,
          status,
          details.code,
          details.message,
          tx,
        );
        checkCancelled();
        await audit.record(
          {
            userId: item.userId,
            entityType: "plaid_item",
            entityId: item.id,
            action: "update",
            source: "plaid.webhook",
            after: { status, errorCode: details.code },
          },
          tx,
        );
        checkCancelled();
      });
      return "processed";
    }
    if (code === "ITEM:PENDING_EXPIRATION") {
      await mutate(item.userId, async (tx: DbTransaction) => {
        checkCancelled();
        await items.markWebhookStatus(
          item.id,
          "pending_expiration",
          "PENDING_EXPIRATION",
          "PENDING_EXPIRATION",
          tx,
        );
        checkCancelled();
        await audit.record(
          {
            userId: item.userId,
            entityType: "plaid_item",
            entityId: item.id,
            action: "update",
            source: "plaid.webhook",
            after: {
              status: "pending_expiration",
              errorCode: "PENDING_EXPIRATION",
            },
          },
          tx,
        );
        checkCancelled();
      });
      return "processed";
    }
    if (code === "ITEM:LOGIN_REPAIRED") {
      await mutate(item.userId, async (tx: DbTransaction) => {
        checkCancelled();
        await items.markWebhookStatus(item.id, "active", null, null, tx);
        checkCancelled();
        await audit.record(
          {
            userId: item.userId,
            entityType: "plaid_item",
            entityId: item.id,
            action: "update",
            source: "plaid.webhook",
            after: { status: "active" },
          },
          tx,
        );
        checkCancelled();
      });
      return "processed";
    }
    return "ignored";
  };
}
