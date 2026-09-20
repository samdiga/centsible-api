import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../../platform/database/types.js";
import {
  createInboundEventsRepository,
  nextRetryAt,
} from "../inbound-events.repository.js";
import type { InboundWebhookEvent } from "../inbound-events.types.js";

const USER_ITEM_ID = "plaid-item-1";

function event(
  overrides: Partial<InboundWebhookEvent> = {},
): InboundWebhookEvent {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "plaid",
    webhookType: "TRANSACTIONS",
    webhookCode: "SYNC_UPDATES_AVAILABLE",
    providerItemId: USER_ITEM_ID,
    payload: { webhook_type: "TRANSACTIONS" },
    payloadDigest: "digest",
    dedupeKey: "dedupe",
    status: "processing",
    attempts: 1,
    availableAt: new Date("2026-01-01T00:00:00.000Z"),
    leaseExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
    lockedBy: "worker-a",
    leaseToken: "lease-token",
    lastErrorCode: null,
    receivedAt: new Date("2026-01-01T00:00:00.000Z"),
    processedAt: null,
    ...overrides,
  };
}

function fakeDb(rows: unknown[] = []) {
  return {
    execute: vi.fn(async () => rows),
  } as unknown as Db;
}

describe("inbound event repository", () => {
  it("returns the earliest future pending event deadline", async () => {
    const deadline = new Date("2026-09-20T18:00:00.000Z");
    const db = fakeDb([{ availableAt: deadline }]);
    const repository = createInboundEventsRepository(db);

    await expect(repository.nextAvailableAt()).resolves.toEqual(deadline);
    vi.mocked(db.execute).mockResolvedValueOnce([] as never);
    await expect(repository.nextAvailableAt()).resolves.toBeNull();
  });

  it("claims leased rows and maps the claimed lifecycle fields", async () => {
    const db = fakeDb([event()]);
    const repository = createInboundEventsRepository(db);

    await expect(
      repository.claimInboundEvents("worker-a", 1, 300_000),
    ).resolves.toEqual([event()]);
    expect(db.execute).toHaveBeenCalledOnce();
  });

  it("computes exponential retry with a 75-minute maximum jittered delay", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(nextRetryAt(1, now, () => 0)).toEqual(
      new Date("2026-01-01T00:00:30.000Z"),
    );
    expect(nextRetryAt(8, now, () => 1)).toEqual(
      new Date("2026-01-01T01:15:00.000Z"),
    );
  });

  it("marks processing work terminally and replays dead rows from a clean lease", async () => {
    const replayed = event({
      status: "pending",
      attempts: 0,
      lockedBy: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    const db = fakeDb();
    vi.mocked(db.execute)
      .mockResolvedValueOnce([{ id: event().id }] as never)
      .mockResolvedValueOnce([replayed] as never);
    const repository = createInboundEventsRepository(db);

    await expect(
      repository.markDead(
        event().id,
        "worker-a",
        1,
        "lease-token",
        "provider secret",
      ),
    ).resolves.toBe(true);
    await expect(repository.replayDeadEvent(event().id)).resolves.toEqual(
      replayed,
    );
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid claim and retry parameters before database access", async () => {
    const db = fakeDb();
    const repository = createInboundEventsRepository(db);

    await expect(repository.claimInboundEvents("", 1)).rejects.toThrow(
      "workerId",
    );
    await expect(repository.claimInboundEvents("worker-a", 0)).rejects.toThrow(
      "limit",
    );
    await expect(
      repository.claimInboundEvents("worker-a", 1, 0),
    ).rejects.toThrow("leaseMs");
    expect(() => nextRetryAt(1, new Date(), () => 2)).toThrow(
      "between 0 and 1",
    );
    expect(db.execute).not.toHaveBeenCalled();
  });
});
