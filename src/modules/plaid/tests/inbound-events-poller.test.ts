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
  leaseToken: `lease-${attempts}`,
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
    heartbeatInboundEvent: vi.fn(async () => true),
    releaseInboundEvent: vi.fn(async () => true),
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

  expect(repository.markProcessed).toHaveBeenCalledWith(
    "event-1",
    "worker-a",
    1,
    "lease-1",
  );
  expect(repository.scheduleRetry).toHaveBeenCalledWith(
    "event-2",
    "worker-a",
    2,
    "lease-2",
    "UPSTREAM_FAILURE",
    new Date("2026-09-09T12:00:00Z"),
    expect.any(Function),
  );
  expect(repository.markDead).toHaveBeenCalledWith(
    "event-8",
    "worker-a",
    8,
    "lease-8",
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
    heartbeatInboundEvent: vi.fn(async () => true),
    releaseInboundEvent: vi.fn(async () => true),
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

it("aborts stale work when an inbound-event heartbeat loses ownership", async () => {
  vi.useFakeTimers();
  const repository = {
    claimInboundEvents: vi.fn(async () => [event(1)]),
    markProcessed: vi.fn(async () => true),
    scheduleRetry: vi.fn(async () => true),
    markDead: vi.fn(async () => true),
    heartbeatInboundEvent: vi.fn(async () => false),
    releaseInboundEvent: vi.fn(async () => true),
    hasProcessedDuplicate: vi.fn(async () => false),
  };
  const handler = vi.fn(
    (_event: ClaimedInboundWebhookEvent, context: { signal: AbortSignal }) =>
      new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      }),
  );
  const poller = createInboundEventsPoller({
    workerId: "worker-a",
    repository,
    handler,
    leaseMs: 100,
    heartbeatMs: 10,
  });

  const polling = poller.pollOnce();
  await vi.advanceTimersByTimeAsync(10);
  await polling;

  expect(repository.heartbeatInboundEvent).toHaveBeenCalledWith(
    "event-1",
    "worker-a",
    1,
    "lease-1",
    100,
  );
  expect(repository.markProcessed).not.toHaveBeenCalled();
  expect(repository.scheduleRetry).not.toHaveBeenCalled();
  expect(repository.markDead).not.toHaveBeenCalled();
  vi.useRealTimers();
});

it("keeps a stalled heartbeat single-flight during bounded shutdown", async () => {
  vi.useFakeTimers();
  const repository = {
    claimInboundEvents: vi.fn(async () => [event(1)]),
    markProcessed: vi.fn(async () => true),
    scheduleRetry: vi.fn(async () => true),
    markDead: vi.fn(async () => true),
    heartbeatInboundEvent: vi.fn(() => new Promise<boolean>(() => undefined)),
    releaseInboundEvent: vi.fn(async () => true),
    hasProcessedDuplicate: vi.fn(async () => false),
  };
  const handler = vi.fn(
    (_event: ClaimedInboundWebhookEvent, context: { signal: AbortSignal }) =>
      new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      }),
  );
  const poller = createInboundEventsPoller({
    workerId: "worker-a",
    repository,
    handler,
    leaseMs: 100,
    heartbeatMs: 10,
    shutdownTimeoutMs: 20,
  });

  const polling = poller.pollOnce();
  await vi.advanceTimersByTimeAsync(50);
  expect(repository.heartbeatInboundEvent).toHaveBeenCalledOnce();
  await poller.stop();
  await polling;

  vi.useRealTimers();
});

it("aborts cooperative inbound handlers during shutdown", async () => {
  vi.useFakeTimers();
  const repository = {
    claimInboundEvents: vi.fn(async () => [event(1)]),
    markProcessed: vi.fn(async () => true),
    scheduleRetry: vi.fn(async () => true),
    markDead: vi.fn(async () => true),
    heartbeatInboundEvent: vi.fn(async () => true),
    releaseInboundEvent: vi.fn(async () => true),
    hasProcessedDuplicate: vi.fn(async () => false),
  };
  const handler = vi.fn(
    (_event: ClaimedInboundWebhookEvent, context: { signal: AbortSignal }) =>
      new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      }),
  );
  const poller = createInboundEventsPoller({
    workerId: "worker-a",
    repository,
    handler,
    shutdownTimeoutMs: 100,
  });

  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  await poller.stop();

  expect(repository.markProcessed).not.toHaveBeenCalled();
  expect(repository.scheduleRetry).not.toHaveBeenCalled();
  expect(repository.markDead).not.toHaveBeenCalled();
  vi.useRealTimers();
});

it("serializes handlers for the same Plaid item", async () => {
  const first = event(1);
  const second = {
    ...event(2),
    id: "event-second",
    providerItemId: first.providerItemId,
  };
  const repository = {
    claimInboundEvents: vi.fn(async () => [first, second]),
    markProcessed: vi.fn(async () => true),
    scheduleRetry: vi.fn(async () => true),
    markDead: vi.fn(async () => true),
    heartbeatInboundEvent: vi.fn(async () => true),
    releaseInboundEvent: vi.fn(async () => true),
    hasProcessedDuplicate: vi.fn(async () => false),
  };
  let active = 0;
  let maximum = 0;
  const order: string[] = [];
  const handler = vi.fn(async (value: ClaimedInboundWebhookEvent) => {
    active += 1;
    maximum = Math.max(maximum, active);
    order.push(`${value.id}:start`);
    await Promise.resolve();
    order.push(`${value.id}:finish`);
    active -= 1;
  });
  const poller = createInboundEventsPoller({
    workerId: "worker-a",
    repository,
    handler,
    concurrency: 2,
  });

  await poller.pollOnce();

  expect(maximum).toBe(1);
  expect(order).toEqual([
    "event-1:start",
    "event-1:finish",
    "event-second:start",
    "event-second:finish",
  ]);
});

it("releases claims that arrive after shutdown instead of starting handlers", async () => {
  vi.useFakeTimers();
  let resolveClaim!: (events: ClaimedInboundWebhookEvent[]) => void;
  const repository = {
    claimInboundEvents: vi.fn(
      () =>
        new Promise<ClaimedInboundWebhookEvent[]>((resolve) => {
          resolveClaim = resolve;
        }),
    ),
    markProcessed: vi.fn(async () => true),
    scheduleRetry: vi.fn(async () => true),
    markDead: vi.fn(async () => true),
    heartbeatInboundEvent: vi.fn(async () => true),
    releaseInboundEvent: vi.fn(async () => true),
    hasProcessedDuplicate: vi.fn(async () => false),
  };
  const handler = vi.fn(async () => undefined);
  const poller = createInboundEventsPoller({
    workerId: "worker-a",
    repository,
    handler,
    shutdownTimeoutMs: 10,
  });

  poller.start();
  await Promise.resolve();
  const stopping = poller.stop();
  await vi.advanceTimersByTimeAsync(10);
  await stopping;
  resolveClaim([event(8)]);
  await vi.advanceTimersByTimeAsync(0);

  expect(handler).not.toHaveBeenCalled();
  expect(repository.releaseInboundEvent).toHaveBeenCalledWith(
    "event-8",
    "worker-a",
    8,
    "lease-8",
  );
  vi.useRealTimers();
});

it("releases same-item work still queued when shutdown starts", async () => {
  const first = event(1);
  const second = { ...event(2), id: "event-queued" };
  const repository = {
    claimInboundEvents: vi.fn(async () => [first, second]),
    markProcessed: vi.fn(async () => true),
    scheduleRetry: vi.fn(async () => true),
    markDead: vi.fn(async () => true),
    heartbeatInboundEvent: vi.fn(async () => true),
    releaseInboundEvent: vi.fn(async () => true),
    hasProcessedDuplicate: vi.fn(async () => false),
  };
  const handler = vi.fn(
    (value: ClaimedInboundWebhookEvent, context: { signal: AbortSignal }) => {
      if (value.id === "event-queued") return Promise.resolve();
      return new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    },
  );
  const poller = createInboundEventsPoller({
    workerId: "worker-a",
    repository,
    handler,
    concurrency: 2,
  });

  poller.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await poller.stop();

  expect(handler).toHaveBeenCalledOnce();
  expect(repository.releaseInboundEvent).toHaveBeenCalledWith(
    "event-queued",
    "worker-a",
    2,
    "lease-2",
  );
});

it("reports a terminal update that loses lease ownership", async () => {
  const repository = {
    claimInboundEvents: vi.fn(async () => [event(1)]),
    markProcessed: vi.fn(async () => false),
    scheduleRetry: vi.fn(async () => true),
    markDead: vi.fn(async () => true),
    heartbeatInboundEvent: vi.fn(async () => true),
    releaseInboundEvent: vi.fn(async () => true),
    hasProcessedDuplicate: vi.fn(async () => false),
  };
  const error = vi.fn();
  const poller = createInboundEventsPoller({
    workerId: "worker-a",
    repository,
    handler: async () => undefined,
    logger: { error },
  });

  await poller.pollOnce();

  expect(error).toHaveBeenCalledWith(
    { eventId: "event-1" },
    "inbound event terminal update lost lease",
  );
});
