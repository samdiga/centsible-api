import { describe, expect, it, vi } from "vitest";

const postgresClient = vi.hoisted(() => ({
  end: vi.fn(async () => undefined),
  listen: vi.fn(async () => ({ unlisten: vi.fn(async () => undefined) })),
}));
const postgresFactory = vi.hoisted(() => vi.fn(() => postgresClient));

vi.mock("postgres", () => ({ default: postgresFactory }));

import {
  createPostgresNotificationAdapter,
  listenerDatabaseUrl,
} from "../client.js";

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

  it("listens on Neon's direct host, because the pooler never delivers notifications", async () => {
    postgresFactory.mockClear();
    const adapter = createPostgresNotificationAdapter(
      "postgres://listener:secret@ep-quiet-sun-a1b2c3-pooler.us-east-2.aws.neon.tech/centsible?sslmode=require",
    );
    await adapter.close();

    expect(postgresFactory).toHaveBeenCalledWith(
      "postgres://listener:secret@ep-quiet-sun-a1b2c3.us-east-2.aws.neon.tech/centsible?sslmode=require",
      expect.anything(),
    );
  });

  it("passes a connection string that isn't a URL through unchanged", () => {
    expect(listenerDatabaseUrl("host=localhost dbname=centsible")).toBe(
      "host=localhost dbname=centsible",
    );
  });
});
