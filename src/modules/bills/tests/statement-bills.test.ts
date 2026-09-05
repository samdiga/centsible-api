import { describe, expect, it, vi } from "vitest";
import { upsertStatementBills } from "../statement-bills.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

const account = {
  id: ACCOUNT_ID,
  userId: USER_ID,
  name: "Visa",
  type: "credit" as const,
  paymentDueDate: "2026-10-15",
  statementBalance: 12500n,
  deletedAt: null,
};

function invokeWithDependencies(
  dependencies: unknown,
): Promise<{ created: number; updated: number }> {
  return (
    upsertStatementBills as unknown as (
      userId: string,
      dependencies: unknown,
    ) => Promise<{ created: number; updated: number }>
  )(USER_ID, dependencies);
}

describe("statement bills", () => {
  it("creates an active transfer bill from an eligible statement account", async () => {
    const inserted: unknown[] = [];
    const db = {
      select: vi.fn(() => ({
        from: () => ({ where: async () => [account] }),
      })),
    };
    const tx = {
      select: vi.fn(() => ({
        from: () => ({ where: async () => [] }),
      })),
      insert: vi.fn(() => ({
        values: (value: unknown) => ({
          onConflictDoUpdate: async () => {
            inserted.push(value);
          },
        }),
      })),
    };

    await expect(
      invokeWithDependencies({
        db,
        withUserMutation: async (
          _userId: string,
          callback: (transaction: unknown) => Promise<unknown>,
        ) => callback(tx),
      }),
    ).resolves.toEqual({ created: 1, updated: 0 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      userId: USER_ID,
      canonicalName: "Visa payment",
      billType: "transfer",
      toAccountId: ACCOUNT_ID,
      avgAmount: 12500n,
      nextExpectedDate: "2026-10-15",
    });
  });

  it("updates a live statement bill but never resurrects a deleted one", async () => {
    const inserted: unknown[] = [];
    const live = {
      canonicalName: "Visa payment",
      cadence: "monthly" as const,
      status: "active" as const,
      deletedAt: null,
    };
    const deleted = {
      ...live,
      deletedAt: new Date("2026-09-01T00:00:00.000Z"),
    };
    const db = {
      select: vi.fn(() => ({
        from: () => ({ where: async () => [account] }),
      })),
    };
    const tx = {
      select: vi
        .fn()
        .mockImplementationOnce(() => ({
          from: () => ({ where: async () => [live] }),
        }))
        .mockImplementationOnce(() => ({
          from: () => ({ where: async () => [deleted] }),
        })),
      insert: vi.fn(() => ({
        values: (value: unknown) => ({
          onConflictDoUpdate: async () => {
            inserted.push(value);
          },
        }),
      })),
    };

    const dependencies = {
      db,
      withUserMutation: async (
        _userId: string,
        callback: (transaction: unknown) => Promise<unknown>,
      ) => callback(tx),
    };

    await expect(invokeWithDependencies(dependencies)).resolves.toEqual({
      created: 0,
      updated: 1,
    });
    await expect(invokeWithDependencies(dependencies)).resolves.toEqual({
      created: 0,
      updated: 0,
    });
    expect(inserted).toHaveLength(1);
  });
});
