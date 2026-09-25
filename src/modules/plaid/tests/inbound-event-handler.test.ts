import { describe, expect, it, vi } from "vitest";
import { createInboundEventHandler } from "../inbound-event-handler.js";
import type { InboundWebhookEvent } from "../inbound-events.types.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";

function event(
  overrides: Partial<InboundWebhookEvent> = {},
): InboundWebhookEvent {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    provider: "plaid",
    webhookType: "TRANSACTIONS",
    webhookCode: "SYNC_UPDATES_AVAILABLE",
    providerItemId: "plaid-item-1",
    payload: {},
    payloadDigest: "digest",
    dedupeKey: "dedupe",
    status: "processing",
    attempts: 1,
    availableAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 300_000),
    lockedBy: "worker-a",
    leaseToken: "lease-token",
    lastErrorCode: null,
    receivedAt: new Date(),
    processedAt: null,
    ...overrides,
  };
}

function dependencies() {
  const item = {
    id: ITEM_ID,
    userId: USER_ID,
    plaidItemId: "plaid-item-1",
  };
  const items = {
    findByPlaidItemId: vi.fn(async (): Promise<typeof item | null> => item),
    markWebhookStatus: vi.fn(async () => undefined),
  };
  const startPipeline = vi.fn(
    async (): Promise<{ runId: string | null; deduped: boolean }> => ({
      runId: "run-1",
      deduped: false,
    }),
  );
  const withUserMutation = vi.fn(
    async (_userId: string, mutate: (tx: object) => Promise<unknown>) =>
      mutate({}),
  );
  const audit = { record: vi.fn(async () => undefined) };
  return { item, items, startPipeline, withUserMutation, audit };
}

describe("inbound event handler", () => {
  it("starts one webhook pipeline and reports duplicate when pipeline dedupes", async () => {
    const deps = dependencies();
    deps.startPipeline.mockResolvedValueOnce({ runId: null, deduped: true });
    const handler = createInboundEventHandler(deps as never);

    await expect(handler(event())).resolves.toBe("duplicate");
    expect(deps.startPipeline).toHaveBeenCalledWith({
      userId: USER_ID,
      trigger: "webhook",
    });
  });

  it("handles item errors inside the user mutation boundary", async () => {
    const deps = dependencies();
    const handler = createInboundEventHandler(deps as never);

    await expect(
      handler(
        event({
          webhookType: "ITEM",
          webhookCode: "ERROR",
          payload: {
            error: {
              error_code: "ITEM_LOGIN_REQUIRED",
              error_message: "Reconnect",
            },
          },
        }),
      ),
    ).resolves.toBe("processed");
    expect(deps.withUserMutation).toHaveBeenCalledWith(
      USER_ID,
      expect.any(Function),
    );
    expect(deps.items.markWebhookStatus).toHaveBeenCalledWith(
      ITEM_ID,
      "login_required",
      "ITEM_LOGIN_REQUIRED",
      "Reconnect",
      expect.anything(),
    );
  });

  it("marks pending expiration and login repaired as item status transitions", async () => {
    const deps = dependencies();
    const handler = createInboundEventHandler(deps as never);

    await expect(
      handler(
        event({ webhookType: "ITEM", webhookCode: "PENDING_EXPIRATION" }),
      ),
    ).resolves.toBe("processed");
    await expect(
      handler(event({ webhookType: "ITEM", webhookCode: "LOGIN_REPAIRED" })),
    ).resolves.toBe("processed");
    expect(deps.items.markWebhookStatus).toHaveBeenNthCalledWith(
      1,
      ITEM_ID,
      "pending_expiration",
      "PENDING_EXPIRATION",
      "PENDING_EXPIRATION",
      expect.anything(),
    );
    expect(deps.items.markWebhookStatus).toHaveBeenNthCalledWith(
      2,
      ITEM_ID,
      "active",
      null,
      null,
      expect.anything(),
    );
  });

  it("ignores unknown providers, codes, and missing items", async () => {
    const deps = dependencies();
    deps.items.findByPlaidItemId.mockResolvedValue(null);
    const handler = createInboundEventHandler(deps as never);

    await expect(handler(event())).resolves.toBe("ignored");
    deps.items.findByPlaidItemId.mockResolvedValue(deps.item);
    await expect(handler(event({ provider: "other" }))).resolves.toBe(
      "ignored",
    );
    await expect(
      handler(event({ webhookType: "ASSETS", webhookCode: "READY" })),
    ).resolves.toBe("ignored");
    expect(deps.startPipeline).not.toHaveBeenCalled();
  });

  it("does not begin webhook work after shutdown cancellation", async () => {
    const deps = dependencies();
    const handler = createInboundEventHandler(deps as never);
    const controller = new AbortController();
    controller.abort(new Error("worker stopping"));

    await expect(
      handler(event(), { signal: controller.signal }),
    ).rejects.toThrow("worker stopping");
    expect(deps.items.findByPlaidItemId).not.toHaveBeenCalled();
    expect(deps.startPipeline).not.toHaveBeenCalled();
    expect(deps.withUserMutation).not.toHaveBeenCalled();
  });
});

describe("item status change hook", () => {
  it("notifies after a status webhook and keeps the event processed if the hook fails", async () => {
    const onItemStatusChanged = vi
      .fn<(userId: string) => Promise<undefined>>(async () => undefined)
      .mockRejectedValueOnce(new Error("queue down"));
    const handler = createInboundEventHandler({
      ...dependencies(),
      onItemStatusChanged,
    } as never);
    const statusEvent = event({
      webhookType: "ITEM",
      webhookCode: "PENDING_EXPIRATION",
    });

    await expect(handler(statusEvent)).resolves.toBe("processed");
    await expect(handler(statusEvent)).resolves.toBe("processed");
    expect(onItemStatusChanged).toHaveBeenCalledTimes(2);
    expect(onItemStatusChanged).toHaveBeenCalledWith(USER_ID);
  });

  it("does not notify for transaction update webhooks", async () => {
    const onItemStatusChanged = vi.fn(async () => undefined);
    const handler = createInboundEventHandler({
      ...dependencies(),
      onItemStatusChanged,
    } as never);
    await handler(event());
    expect(onItemStatusChanged).not.toHaveBeenCalled();
  });
});
