import { describe, expect, it } from "vitest";
import type { Db, DbTransaction } from "../database/types.js";
import {
  USER_DATA_CHANGED_CHANNEL,
  createUserInvalidationListener,
  createWithUserMutation,
} from "./user-revisions.repository.js";

const USER_ID = "33333333-3333-4333-8333-333333333333";

function transactionDb(order: string[]): Pick<Db, "transaction"> {
  return {
    transaction: async <T>(callback: (tx: DbTransaction) => Promise<T>) => {
      const result = await callback({} as DbTransaction);
      order.push("commit");
      return result;
    },
  } as Pick<Db, "transaction">;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("user mutation invalidation", () => {
  it("commits mutation and revision before locally evicting then publishing only the internal user ID", async () => {
    const order: string[] = [];
    const withUserMutation = createWithUserMutation({
      db: transactionDb(order),
      cache: {
        invalidateUser(userId) {
          order.push(`evict:${userId}`);
        },
      },
      incrementRevision: async (userId) => {
        order.push(`revision:${userId}`);
        return 1n;
      },
      publishInvalidation: async (userId) => {
        order.push(`publish:${userId}`);
      },
    });

    const result = await withUserMutation(USER_ID, async () => {
      order.push("mutate");
      return { committed: true };
    });

    expect(result).toEqual({ committed: true });
    expect(order).toEqual([
      "mutate",
      `revision:${USER_ID}`,
      "commit",
      `evict:${USER_ID}`,
      `publish:${USER_ID}`,
    ]);
  });

  it("does not evict or publish when the transaction rolls back", async () => {
    const order: string[] = [];
    const withUserMutation = createWithUserMutation({
      db: transactionDb(order),
      cache: { invalidateUser: (userId) => order.push(`evict:${userId}`) },
      incrementRevision: async (userId) => {
        order.push(`revision:${userId}`);
        return 1n;
      },
      publishInvalidation: async (userId) => {
        order.push(`publish:${userId}`);
      },
    });

    await expect(
      withUserMutation(USER_ID, async () => {
        order.push("mutate");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(order).toEqual(["mutate"]);
  });

  it("returns a committed mutation when publishing fails and reports the failure safely", async () => {
    const order: string[] = [];
    const publishError = new Error("notification unavailable");
    const withUserMutation = createWithUserMutation({
      db: transactionDb(order),
      cache: { invalidateUser: (userId) => order.push(`evict:${userId}`) },
      incrementRevision: async (userId) => {
        order.push(`revision:${userId}`);
        return 1n;
      },
      publishInvalidation: async (userId) => {
        order.push(`publish:${userId}`);
        throw publishError;
      },
      onPublishError: (error, userId) => {
        expect(error).toBe(publishError);
        order.push(`report:${userId}`);
        throw new Error("observer unavailable");
      },
      logger: {
        error: () => {
          order.push("unexpected-default-report");
        },
      },
    });

    await expect(
      withUserMutation(USER_ID, async () => {
        order.push("mutate");
        return "committed";
      }),
    ).resolves.toBe("committed");
    expect(order).toEqual([
      "mutate",
      `revision:${USER_ID}`,
      "commit",
      `evict:${USER_ID}`,
      `publish:${USER_ID}`,
      `report:${USER_ID}`,
    ]);
  });

  it("reports a failed publication through the injected logger without exposing error secrets", async () => {
    const order: string[] = [];
    const reports: Array<{
      bindings: Record<string, unknown>;
      message: string;
    }> = [];
    const secret = "postgresql://user:database-password@private.example/test";
    const withUserMutation = createWithUserMutation({
      db: transactionDb(order),
      cache: { invalidateUser: (userId) => order.push(`evict:${userId}`) },
      incrementRevision: async (userId) => {
        order.push(`revision:${userId}`);
        return 1n;
      },
      publishInvalidation: async (userId) => {
        order.push(`publish:${userId}`);
        throw new Error(`notification failed for ${secret}`);
      },
      logger: {
        error(bindings, message) {
          reports.push({ bindings, message });
        },
      },
    });

    await expect(
      withUserMutation(USER_ID, async () => {
        order.push("mutate");
        return "committed";
      }),
    ).resolves.toBe("committed");

    expect(order).toEqual([
      "mutate",
      `revision:${USER_ID}`,
      "commit",
      `evict:${USER_ID}`,
      `publish:${USER_ID}`,
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      message: "User data invalidation publication failed",
      bindings: {
        userId: USER_ID,
        channel: USER_DATA_CHANGED_CHANNEL,
        error: {
          name: "Error",
          message: "[REDACTED]",
          stack: "[REDACTED]",
        },
      },
    });
    expect(JSON.stringify(reports)).not.toContain(secret);
    expect(JSON.stringify(reports)).not.toContain("database-password");
  });

  it("contains an async custom publication-error reporter rejection before returning the committed result", async () => {
    const order: string[] = [];
    const reportStarted = deferred();
    const releaseReport = deferred();
    const withUserMutation = createWithUserMutation({
      db: transactionDb(order),
      cache: { invalidateUser: () => undefined },
      incrementRevision: async () => 1n,
      publishInvalidation: async () => {
        throw new Error("publish unavailable");
      },
      onPublishError: async () => {
        order.push("report:start");
        reportStarted.resolve();
        await releaseReport.promise;
        order.push("report:reject");
        throw new Error("async observer unavailable");
      },
    });

    let mutationSettled = false;
    const mutation = withUserMutation(USER_ID, async () => "committed").then(
      (result) => {
        mutationSettled = true;
        return result;
      },
    );

    await reportStarted.promise;
    await Promise.resolve();
    expect(mutationSettled).toBe(false);
    releaseReport.resolve();
    await expect(mutation).resolves.toBe("committed");
    expect(order).toEqual(["commit", "report:start", "report:reject"]);
  });

  it("contains an async injected logger rejection before returning the committed result", async () => {
    const order: string[] = [];
    const reportStarted = deferred();
    const releaseReport = deferred();
    const withUserMutation = createWithUserMutation({
      db: transactionDb(order),
      cache: { invalidateUser: () => undefined },
      incrementRevision: async () => 1n,
      publishInvalidation: async () => {
        throw new Error("publish unavailable");
      },
      logger: {
        async error() {
          order.push("logger:start");
          reportStarted.resolve();
          await releaseReport.promise;
          order.push("logger:reject");
          throw new Error("async logger unavailable");
        },
      },
    });

    let mutationSettled = false;
    const mutation = withUserMutation(USER_ID, async () => "committed").then(
      (result) => {
        mutationSettled = true;
        return result;
      },
    );

    await reportStarted.promise;
    await Promise.resolve();
    expect(mutationSettled).toBe(false);
    releaseReport.resolve();
    await expect(mutation).resolves.toBe("committed");
    expect(order).toEqual(["commit", "logger:start", "logger:reject"]);
  });
});

describe("user invalidation listener", () => {
  it("has no subscription side effect until started and ignores malformed payloads", async () => {
    const invalidated: string[] = [];
    const invalidPayloads: string[] = [];
    const channels: string[] = [];
    let notify: ((payload: string) => void) | undefined;
    let stopped = 0;
    const listener = createUserInvalidationListener({
      cache: { invalidateUser: (userId) => invalidated.push(userId) },
      listen: async (channel, onNotification) => {
        channels.push(channel);
        notify = onNotification;
        return { unlisten: async () => void (stopped += 1) };
      },
      onInvalidPayload: (payload) => invalidPayloads.push(payload),
    });

    expect(channels).toEqual([]);
    await listener.start();
    notify?.("not-a-uuid");
    notify?.(USER_ID);
    await listener.stop();
    await listener.stop();

    expect(channels).toEqual([USER_DATA_CHANGED_CHANNEL]);
    expect(invalidated).toEqual([USER_ID]);
    expect(invalidPayloads).toEqual(["not-a-uuid"]);
    expect(stopped).toBe(1);
  });
});
