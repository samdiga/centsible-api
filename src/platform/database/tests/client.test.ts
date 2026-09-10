import { describe, expect, it, vi } from "vitest";

const postgresClient = vi.hoisted(() => ({
  end: vi.fn(async () => undefined),
  listen: vi.fn(async () => ({ unlisten: vi.fn(async () => undefined) })),
}));
const postgresFactory = vi.hoisted(() => vi.fn(() => postgresClient));

vi.mock("postgres", () => ({ default: postgresFactory }));

import { createPostgresNotificationAdapter } from "../client.js";

describe("createPostgresNotificationAdapter", () => {
  it("owns a dedicated postgres listener client and closes it idempotently", async () => {
    const adapter = createPostgresNotificationAdapter(
      "postgres://listener:secret@example.test/centsible",
    );
    const onNotification = vi.fn();

    await adapter.listen("centsible_user_data_changed", onNotification);
    await adapter.close();
    await adapter.close();

    expect(postgresFactory).toHaveBeenCalledWith(
      "postgres://listener:secret@example.test/centsible",
      expect.objectContaining({
        connect_timeout: 10,
        max: 1,
        prepare: false,
      }),
    );
    expect(postgresClient.listen).toHaveBeenCalledWith(
      "centsible_user_data_changed",
      onNotification,
    );
    expect(postgresClient.end).toHaveBeenCalledTimes(1);
  });
});
