import { describe, expect, it, vi } from "vitest";

import type { DbTransaction } from "../../../platform/database/types.js";
import { ValidationError } from "../../../platform/errors/app-error.js";
import {
  BACKUP_VERSION,
  type BackupPayload,
  type BackupTransaction,
} from "../user-data.schemas.js";
import {
  createUserDataService,
  type UserDataRepository,
} from "../user-data.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const emptyBackup: BackupPayload = {
  version: BACKUP_VERSION,
  exportedAt: "2026-09-01T00:00:00.000Z",
  accounts: [],
  transactions: [],
  categories: [],
  rules: [],
  budgets: [],
  recurring: [],
};

function transaction(id: string): BackupTransaction {
  return {
    id,
    accountId: "22222222-2222-4222-8222-222222222222",
    plaidTransactionId: null,
    amount: "100",
    currency: "USD",
    date: "2026-09-01",
    name: "Coffee",
    merchantName: null,
    userName: null,
    categoryId: null,
    notes: null,
    status: "posted",
    reviewStatus: "needs_review",
    excludeFromBudgets: false,
    excludeFromReports: false,
    userCategoryOverride: false,
  };
}

describe("user data service", () => {
  it("assembles metadata and bounded transaction pages as a valid JSON stream", async () => {
    const rows = Array.from({ length: 5_001 }, (_, index) =>
      transaction(
        `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
      ),
    );
    const listPage = vi.fn(async (_userId: string, after: string | null) =>
      after === null ? rows.slice(0, 5_000) : rows.slice(5_000),
    );
    const repository = {
      exportMetadata: vi.fn(async () => ({ ...emptyBackup, transactions: [] })),
      listTransactionPage: listPage,
    } as unknown as UserDataRepository;
    const service = createUserDataService({ repository });

    const stream = await service.exportUserData(USER_ID);
    const body = await new Response(stream).text();
    const parsed = JSON.parse(body) as BackupPayload;
    expect(parsed.transactions).toHaveLength(5_001);
    expect(listPage).toHaveBeenNthCalledWith(1, USER_ID, null);
    expect(listPage).toHaveBeenNthCalledWith(2, USER_ID, rows[4_999]!.id);
  });

  it("rejects unsupported versions and invalid references before mutation", async () => {
    const importUserData = vi.fn();
    const repository: UserDataRepository = {
      exportMetadata: vi.fn(),
      listTransactionPage: vi.fn(),
      validateBackupReferences: vi.fn(async () => undefined),
      importUserData,
      resetUserData: vi.fn(),
    };
    const service = createUserDataService({ repository });
    await expect(
      service.importUserData(USER_ID, { ...emptyBackup, version: 2 } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(importUserData).not.toHaveBeenCalled();

    const invalidReference = {
      ...emptyBackup,
      transactions: [transaction("33333333-3333-4333-8333-333333333333")],
    };
    vi.mocked(repository.validateBackupReferences).mockRejectedValueOnce(
      new ValidationError(
        "transaction.accountId does not belong to this backup.",
      ),
    );
    await expect(
      service.importUserData(USER_ID, invalidReference),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(importUserData).not.toHaveBeenCalled();
  });

  it("runs reset and import in the mutation transaction, then evicts once", async () => {
    const tx = {} as DbTransaction;
    const order: string[] = [];
    const repository: UserDataRepository = {
      exportMetadata: vi.fn(),
      listTransactionPage: vi.fn(),
      validateBackupReferences: vi.fn(async () => undefined),
      importUserData: vi.fn(async () => {
        order.push("import");
      }),
      resetUserData: vi.fn(async () => {
        order.push("reset");
      }),
      recordAudit: vi.fn(async () => {
        order.push("audit");
      }),
    };
    const cache = { invalidateUser: vi.fn() };
    const withUserMutation = vi.fn(async (_userId, mutate) => mutate(tx));
    const service = createUserDataService({
      repository,
      cache,
      withUserMutation,
    });

    await service.resetUserData(USER_ID);
    expect(order).toEqual(["reset", "audit"]);
    expect(withUserMutation).toHaveBeenCalledTimes(1);
    expect(repository.resetUserData).toHaveBeenCalledWith(USER_ID, tx);
    expect(repository.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete" }),
      tx,
    );
    expect(cache.invalidateUser).not.toHaveBeenCalled();
    await service.importUserData(USER_ID, emptyBackup);
    expect(order).toEqual(["reset", "audit", "import", "audit"]);
    expect(withUserMutation).toHaveBeenCalledTimes(2);
  });

  it("preserves rollback by propagating repository failures", async () => {
    const repository: UserDataRepository = {
      exportMetadata: vi.fn(),
      listTransactionPage: vi.fn(),
      validateBackupReferences: vi.fn(async () => undefined),
      importUserData: vi.fn(async () => {
        throw new Error("insert failed");
      }),
      resetUserData: vi.fn(),
    };
    const withUserMutation = vi.fn(async (_userId, mutate) =>
      mutate({} as never),
    );
    const service = createUserDataService({ repository, withUserMutation });
    await expect(service.importUserData(USER_ID, emptyBackup)).rejects.toThrow(
      "insert failed",
    );
  });

  it("revokes Plaid items before reset/import when the Plan 3 adapter is supplied", async () => {
    const order: string[] = [];
    const repository: UserDataRepository = {
      exportMetadata: vi.fn(),
      listTransactionPage: vi.fn(),
      validateBackupReferences: vi.fn(async () => {
        order.push("validate");
      }),
      importUserData: vi.fn(async () => {
        order.push("import");
      }),
      resetUserData: vi.fn(async () => {
        order.push("reset");
      }),
      recordAudit: vi.fn(async () => {
        order.push("audit");
      }),
    };
    const service = createUserDataService({
      repository,
      withUserMutation: async (_userId, mutate) => mutate({} as never),
      revokePlaidItems: async () => {
        order.push("revoke");
      },
    });

    await service.importUserData(USER_ID, emptyBackup);
    await service.resetUserData(USER_ID);
    expect(order).toEqual([
      "validate",
      "revoke",
      "import",
      "audit",
      "revoke",
      "reset",
      "audit",
    ]);
  });
});
