import { describe, expect, it, vi } from "vitest";
import { upsertStatementBills } from "../statement-bills.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

const card = (overrides: Record<string, unknown> = {}) => ({
  id: ACCOUNT_ID,
  userId: USER_ID,
  name: "Visa",
  nameOverride: null,
  mask: "1111",
  type: "credit" as const,
  paymentDueDate: "2026-10-15",
  statementBalance: 12500n,
  deletedAt: null,
  ...overrides,
});

const bill = (overrides: Record<string, unknown> = {}) => ({
  id: "bill-1",
  canonicalName: "Visa payment",
  displayName: null,
  billType: "transfer",
  toAccountId: ACCOUNT_ID,
  cadence: "monthly" as const,
  status: "active" as const,
  deletedAt: null,
  ...overrides,
});

/** Runs the upsert over these accounts and bills; returns what it wrote. */
async function run(accounts: unknown[], bills: unknown[] = []) {
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const db = {
    select: vi.fn(() => ({ from: () => ({ where: async () => accounts }) })),
  };
  const tx = {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ orderBy: async () => bills }) }),
    })),
    insert: vi.fn(() => ({
      values: async (value: Record<string, unknown>) => {
        inserted.push(value);
      },
    })),
    update: vi.fn(() => ({
      set: (value: Record<string, unknown>) => ({
        where: async () => {
          updated.push(value);
        },
      }),
    })),
  };
  const result = await (
    upsertStatementBills as unknown as (
      userId: string,
      dependencies: unknown,
    ) => Promise<{ created: number; updated: number }>
  )(USER_ID, {
    db,
    withUserMutation: async (
      _userId: string,
      callback: (transaction: unknown) => Promise<unknown>,
    ) => callback(tx),
  });
  return { result, inserted, updated };
}

describe("statement bills", () => {
  it("creates an active transfer bill from an eligible statement account", async () => {
    const { result, inserted } = await run([card()]);

    expect(result).toEqual({ created: 1, updated: 0 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      userId: USER_ID,
      canonicalName: "Visa payment",
      billType: "transfer",
      toAccountId: ACCOUNT_ID,
      avgAmount: 12500n,
      nextExpectedDate: "2026-10-15",
    });
    expect(inserted[0]).not.toHaveProperty("displayName");
  });

  it("updates the card's live bill but never resurrects a deleted or paused one", async () => {
    const live = await run([card()], [bill()]);
    expect(live.result).toEqual({ created: 0, updated: 1 });
    expect(live.updated[0]).toMatchObject({
      avgAmount: 12500n,
      nextExpectedDate: "2026-10-15",
      dayOfMonth: 15,
    });
    expect(live.updated[0]).not.toHaveProperty("displayName");

    for (const disabled of [
      bill({ deletedAt: new Date("2026-09-01T00:00:00.000Z") }),
      bill({ status: "paused" }),
    ]) {
      const { result, inserted, updated } = await run([card()], [disabled]);
      expect(result).toEqual({ created: 0, updated: 0 });
      expect(inserted).toEqual([]);
      expect(updated).toEqual([]);
    }
  });

  it("finds a card's bill by the card, not a name another card shares", async () => {
    // Two "Venture X" cards; the one bill named for both belongs to ••6494.
    const { result, inserted, updated } = await run(
      [
        card({ name: "Venture X", mask: "6494" }),
        card({ id: OTHER_ID, name: "Venture X", mask: "6925" }),
      ],
      [bill({ canonicalName: "Venture X payment" })],
    );

    expect(result).toEqual({ created: 1, updated: 1 });
    expect(updated[0]).toMatchObject({ displayName: "Venture X ••6494 payment" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      canonicalName: "Venture X ••6925 payment",
      toAccountId: OTHER_ID,
    });
  });

  it("names the bill after the user's name for the card, until the user names the bill", async () => {
    const chase = card({ name: "CREDIT CARD", nameOverride: "Chase Freedom" });
    const renamed = await run(
      [chase],
      [bill({ canonicalName: "CREDIT CARD payment" })],
    );
    expect(renamed.updated[0]).toMatchObject({
      displayName: "Chase Freedom payment",
    });

    const userNamed = await run(
      [chase],
      [bill({ canonicalName: "CREDIT CARD payment", displayName: "Freedom" })],
    );
    expect(userNamed.updated[0]).not.toHaveProperty("displayName");

    const fresh = await run([chase]);
    expect(fresh.inserted[0]).toMatchObject({
      canonicalName: "Chase Freedom payment",
    });
  });

  it("never reuses a name another bill already holds", async () => {
    // Another card's deleted bill keeps "Visa payment".
    const { inserted } = await run(
      [card()],
      [bill({ toAccountId: OTHER_ID, deletedAt: new Date("2026-09-01") })],
    );

    expect(inserted[0]).toMatchObject({
      canonicalName: "Visa ••1111 payment",
      displayName: "Visa payment",
    });
  });
});
