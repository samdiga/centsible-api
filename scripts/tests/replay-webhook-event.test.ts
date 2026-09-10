import { expect, it, vi } from "vitest";
import {
  ConflictError,
  ValidationError,
} from "../../src/platform/errors/app-error.js";
import { replayWebhookEvent } from "../replay-webhook-event.js";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

it("validates one dead event, replays it, and writes payload-free audit metadata", async () => {
  const replayDeadEvent = vi.fn(async () => ({
    id: EVENT_ID,
    status: "pending",
  }));
  const audit = vi.fn(async () => undefined);
  const dependencies = {
    findById: vi.fn(async () => ({
      id: EVENT_ID,
      status: "dead",
      providerItemId: "provider-item",
      webhookType: "ITEM",
      webhookCode: "ERROR",
    })),
    findItem: vi.fn(async () => ({ userId: "user-id" })),
    replayDeadEvent,
    audit,
  };

  await expect(
    replayWebhookEvent([EVENT_ID], dependencies as never),
  ).resolves.toMatchObject({ id: EVENT_ID, status: "pending" });
  expect(replayDeadEvent).toHaveBeenCalledWith(EVENT_ID);
  expect(audit).toHaveBeenCalledWith(
    expect.objectContaining({
      entityId: EVENT_ID,
      after: {
        eventId: EVENT_ID,
        webhookType: "ITEM",
        webhookCode: "ERROR",
        status: "pending",
      },
    }),
  );
  expect(JSON.stringify(audit.mock.calls)).not.toContain("payload");
});

it("rejects malformed input and non-dead events", async () => {
  await expect(replayWebhookEvent([], {} as never)).rejects.toBeInstanceOf(
    ValidationError,
  );
  await expect(
    replayWebhookEvent([EVENT_ID], {
      findById: vi.fn(async () => ({ status: "processed" })),
    } as never),
  ).rejects.toBeInstanceOf(ConflictError);
});
