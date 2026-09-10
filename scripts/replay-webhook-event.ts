import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { auditLogRepository } from "../src/platform/database/audit-log.repository.js";
import { closeDb } from "../src/platform/database/client.js";
import { loadEnv } from "../src/platform/config/env.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../src/platform/errors/app-error.js";
import {
  createInboundEventsRepository,
  type InboundEventsRepository,
} from "../src/modules/plaid/inbound-events.repository.js";
import {
  createPlaidItemsRepository,
  type PlaidItemsRepository,
} from "../src/modules/plaid/plaid-items.repository.js";
import type { AuditLogEntry } from "../src/platform/database/audit-log.repository.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Dependencies = Readonly<{
  findById?: InboundEventsRepository["findById"];
  replayDeadEvent?: InboundEventsRepository["replayDeadEvent"];
  findItem?: PlaidItemsRepository["findByPlaidItemId"];
  audit?: (entry: AuditLogEntry) => Promise<void>;
}>;

/** Requeues exactly one dead delivery and records metadata without its payload. */
export async function replayWebhookEvent(
  args: readonly string[],
  dependencies: Dependencies = {},
) {
  if (args.length !== 1 || !UUID.test(args[0] ?? ""))
    throw new ValidationError("Expected one canonical webhook event UUID");
  const id = args[0]!;
  const findById =
    dependencies.findById ??
    ((eventId: string) => createInboundEventsRepository().findById(eventId));
  const replay =
    dependencies.replayDeadEvent ??
    ((eventId: string) =>
      createInboundEventsRepository().replayDeadEvent(eventId));
  const findItem =
    dependencies.findItem ??
    ((providerItemId: string) =>
      createPlaidItemsRepository().findByPlaidItemId(providerItemId));
  const audit = dependencies.audit ?? auditLogRepository.record;
  const before = await findById(id);
  if (!before || before.status !== "dead")
    throw new ConflictError("Only dead webhook events can be replayed");
  if (!before.providerItemId) throw new NotFoundError("webhook event item");
  const item = await findItem(before.providerItemId);
  if (!item) throw new NotFoundError("webhook event item");
  const replayed = await replay(id);
  if (!replayed) throw new ConflictError("Webhook event was already replayed");
  await audit({
    userId: item.userId,
    entityType: "inbound_webhook_event",
    entityId: id,
    action: "update",
    source: "webhook.replay",
    before: { eventId: id, status: "dead" },
    after: {
      eventId: id,
      webhookType: before.webhookType,
      webhookCode: before.webhookCode,
      status: "pending",
    },
  });
  return replayed;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
  loadEnv();
  try {
    const result = await replayWebhookEvent(process.argv.slice(2));
    console.log(`Requeued webhook event ${result.id}`);
  } finally {
    await closeDb();
  }
}
