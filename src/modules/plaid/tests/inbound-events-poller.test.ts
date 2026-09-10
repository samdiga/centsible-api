import { expect, it, vi } from "vitest";
import { createInboundEventsPoller } from "../inbound-events-poller.js";
import type { ClaimedInboundWebhookEvent } from "../inbound-events.types.js";

const event = (attempts: number): ClaimedInboundWebhookEvent => ({
  id: `event-${attempts}`,
  provider: "plaid",
  webhookType: "TRANSACTIONS",
  webhookCode: "SYNC_UPDATES_AVAILABLE",
  providerItemId: "item",
  payload: {},
  payloadDigest: "digest",
  dedupeKey: "dedupe",
  status: "processing",
  attempts,
  availableAt: new Date(),
  leaseExpiresAt: new Date(Date.now() + 300_000),
  lockedBy: "worker-a",
  lastErrorCode: null,
  receivedAt: new Date(),
  processedAt: null,
});

it("processes successes, retries failures, and dead-letters attempt eight", async () => {
  const events = [event(1), event(2), event(8)];
  const repository = {
    claimInboundEvents: vi.fn(async () => events),
    markProcessed: vi.fn(async () => true),
    scheduleRetry: vi.fn(async () => true),
    markDead: vi.fn(async () => true),
    hasProcessedDuplicate: vi.fn(async () => false),
  };
  const handler = vi.fn(async (value: ClaimedInboundWebhookEvent) => {
    if (value.attempts > 1)
      throw Object.assign(new Error("failed"), { code: "UPSTREAM_FAILURE" });
    return "processed" as const;
  });
  const poller = createInboundEventsPoller({
    workerId: "worker-a",
    repository,
    handler,
    random: () => 0,
    now: () => new Date("2026-09-09T12:00:00Z"),
  });

  await poller.pollOnce();

  expect(repository.markProcessed).toHaveBeenCalledWith("event-1", "worker-a");
  expect(repository.scheduleRetry).toHaveBeenCalledWith(
    "event-2",
    "worker-a",
    2,
    "UPSTREAM_FAILURE",
    new Date("2026-09-09T12:00:00Z"),
    expect.any(Function),
  );
  expect(repository.markDead).toHaveBeenCalledWith(
    "event-8",
    "worker-a",
    "UPSTREAM_FAILURE",
  );
});

it("bounds shutdown while an event handler is still running", async () => {
  vi.useFakeTimers();
  const repository = {
    claimInboundEvents: vi.fn(async () => [event(1)]),
    markProcessed: vi.fn(async () => true),
    scheduleRetry: vi.fn(async () => true),
    markDead: vi.fn(async () => true),
    hasProcessedDuplicate: vi.fn(async () => false),
  };
  const handler = vi.fn(() => new Promise<never>(() => undefined));
  const poller = createInboundEventsPoller({
    workerId: "worker-a",
    repository,
    handler,
    shutdownTimeoutMs: 100,
  });

  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  const stopping = poller.stop();
  await vi.advanceTimersByTimeAsync(100);

  await expect(stopping).resolves.toBeUndefined();
  vi.useRealTimers();
});
