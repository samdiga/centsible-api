import { describe, expect, it, vi } from "vitest";

import type { DbTransaction } from "../../../platform/database/types.js";
import {
  createUserDataRepository,
  insertUserCategories,
  splitImportBatches,
} from "../user-data.repository.js";
import { BACKUP_VERSION, type BackupPayload } from "../user-data.schemas.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SYSTEM_CATEGORY_ID = "22222222-2222-4222-8222-222222222222";
const USER_CATEGORY_ID = "33333333-3333-4333-8333-333333333333";

const emptyBackup: BackupPayload = {
  version: BACKUP_VERSION,
  exportedAt: "2026-09-01T00:00:00.000Z",
  accounts: [],
  transactions: [],
  categories: [],
  tags: [],
  rules: [],
  budgets: [],
  recurring: [],
  netWorthSnapshots: [],
};

describe("user data import batching", () => {
  it("keeps high-cardinality inserts below the parameter-safe batch size", () => {
    const values = Array.from({ length: 5_001 }, (_, index) => index);
    const batches = splitImportBatches(values);
    expect(batches.map((batch) => batch.length)).toEqual([
      500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 1,
    ]);
    expect(
      Math.max(...batches.map((batch) => batch.length)),
    ).toBeLessThanOrEqual(500);
  });

  it("skips known system rows but inserts user rows without suppressing conflicts", async () => {
    const onConflictDoNothing = vi.fn();
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const db = { insert: vi.fn(() => ({ values })) };

    await insertUserCategories(
      db as never,
      USER_ID,
      [
        {
          id: SYSTEM_CATEGORY_ID,
          parentId: null,
          name: "System",
          icon: null,
          color: null,
          isIncome: false,
          isTransfer: false,
          excludeFromBudgets: false,
          displayOrder: 0,
        },
        {
          id: USER_CATEGORY_ID,
          parentId: SYSTEM_CATEGORY_ID,
          name: "Custom child",
          icon: null,
          color: null,
          isIncome: false,
          isTransfer: false,
          excludeFromBudgets: false,
          displayOrder: 1,
        },
      ],
      new Set([SYSTEM_CATEGORY_ID]),
    );

    expect(values).toHaveBeenCalledWith([
      expect.objectContaining({
        id: USER_CATEGORY_ID,
        userId: USER_ID,
        parentId: SYSTEM_CATEGORY_ID,
      }),
    ]);
    expect(onConflictDoNothing).not.toHaveBeenCalled();
  });

  it("opens a bound transaction for standalone reset/import and forwards an explicit one", async () => {
    const where = vi.fn(async () => []);
    const tx = {
      delete: vi.fn(() => ({ where })),
    } as unknown as DbTransaction;
    const transaction = vi.fn(
      async (callback: (inner: DbTransaction) => Promise<void>) => callback(tx),
    );
    const repository = createUserDataRepository({ transaction } as never);

    await repository.resetUserData(USER_ID);
    await repository.importUserData(USER_ID, emptyBackup);
    expect(transaction).toHaveBeenCalledTimes(2);

    await repository.resetUserData(USER_ID, tx);
    await repository.importUserData(USER_ID, emptyBackup, tx);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(
      (tx as never as { delete: ReturnType<typeof vi.fn> }).delete,
    ).toHaveBeenCalled();
  });
});

describe("net worth snapshot backup coverage", () => {
  it("inserts net worth snapshots inside the same import transaction, mapping cents fields back to bigint columns", async () => {
    const values = vi.fn();
    const insert = vi.fn(() => ({ values }));
    const where = vi.fn(async () => []);
    const tx = {
      insert,
      delete: vi.fn(() => ({ where })),
    } as unknown as DbTransaction;

    const repository = createUserDataRepository({} as never);
    await repository.importUserData(
      USER_ID,
      {
        ...emptyBackup,
        netWorthSnapshots: [
          {
            date: "2026-09-15",
            netWorthCents: "500000",
            assetsCents: "600000",
            liabilitiesCents: "100000",
            liquidAssetsCents: "400000",
            breakdown: { checking: 400000, savings: 200000 },
          },
        ],
      },
      tx,
    );

    expect(values).toHaveBeenCalledWith([
      expect.objectContaining({
        userId: USER_ID,
        date: "2026-09-15",
        totalAssets: 600000n,
        totalLiabilities: 100000n,
        netWorth: 500000n,
        liquidAssets: 400000n,
        breakdown: { checking: 400000, savings: 200000 },
      }),
    ]);
  });
});
