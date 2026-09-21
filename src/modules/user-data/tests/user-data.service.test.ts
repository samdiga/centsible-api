import { describe, expect, it, vi } from "vitest";

import type { DbTransaction } from "../../../platform/database/types.js";
import {
  RateLimitError,
  ServiceUnavailableError,
  ValidationError,
} from "../../../platform/errors/app-error.js";
import {
  BACKUP_VERSION,
  BackupPayloadSchema,
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
  tags: [],
  rules: [],
  budgets: [],
  recurring: [],
  netWorthSnapshots: [],
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
    tagIds: [],
  };
}

describe("BackupPayloadSchema", () => {
  it("defaults netWorthSnapshots to [] when the key is genuinely absent, not just empty", () => {
    // Build the payload without spreading emptyBackup (which already
    // includes netWorthSnapshots: []) so the key is truly missing, the way
    // a real pre-net-worth-snapshot backup file is shaped.
    const v1Shaped = {
      version: 1,
      exportedAt: "2026-09-01T00:00:00.000Z",
      accounts: [],
      transactions: [],
      categories: [],
      tags: [],
      rules: [],
      budgets: [],
      recurring: [],
    };
    expect(v1Shaped).not.toHaveProperty("netWorthSnapshots");

    const result = BackupPayloadSchema.safeParse(v1Shaped);
    expect(result.success).toBe(true);
    expect(result.success && result.data.netWorthSnapshots).toEqual([]);
  });
});

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
    const service = createUserDataService({
      repository,
      rateLimiter: () => undefined,
      revokePlaidItems: vi.fn(async () => undefined),
    });

    const stream = await service.exportUserData(USER_ID);
    const body = await new Response(stream).text();
    const parsed = JSON.parse(body) as BackupPayload;
    expect(parsed.transactions).toHaveLength(5_001);
    expect(listPage).toHaveBeenNthCalledWith(1, USER_ID, null);
    expect(listPage).toHaveBeenNthCalledWith(2, USER_ID, rows[4_999]!.id);
  });

  it("pulls no more than one page at a time and stops page work after cancellation", async () => {
    const listPage = vi.fn(async () => [
      transaction("22222222-2222-4222-8222-222222222222"),
    ]);
    const service = createUserDataService({
      repository: {
        exportMetadata: vi.fn(async () => ({
          ...emptyBackup,
          transactions: [],
        })),
        listTransactionPage: listPage,
      } as unknown as UserDataRepository,
    });
    const reader = (await service.exportUserData(USER_ID)).getReader();
    await reader.read();
    expect(listPage).not.toHaveBeenCalled();
    await reader.read();
    expect(listPage).toHaveBeenCalledTimes(1);
    await reader.cancel("client disconnected");
    await Promise.resolve();
    expect(listPage).toHaveBeenCalledTimes(1);
  });

  it("preserves metadata after the streamed transaction array", async () => {
    const metadata = {
      ...emptyBackup,
      categories: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          parentId: null,
          name: "Food",
          icon: null,
          color: null,
          isIncome: false,
          isTransfer: false,
          excludeFromBudgets: false,
          displayOrder: 1,
        },
      ],
    };
    const service = createUserDataService({
      repository: {
        exportMetadata: vi.fn(async () => ({ ...metadata, transactions: [] })),
        listTransactionPage: vi.fn(async () => []),
      } as unknown as UserDataRepository,
    });
    const stream = await service.exportUserData(USER_ID);
    const parsed = JSON.parse(
      await new Response(stream).text(),
    ) as BackupPayload;
    expect(parsed.categories).toEqual(metadata.categories);
  });

  it("uses an injectable per-user token bucket for export limits", async () => {
    const consume = vi.fn((key: string) => {
      if (
        consume.mock.calls.filter(([calledKey]) => calledKey === key).length > 5
      ) {
        throw new RateLimitError();
      }
    });
    const repository = {
      exportMetadata: vi.fn(async () => ({ ...emptyBackup, transactions: [] })),
      listTransactionPage: vi.fn(async () => []),
    } as unknown as UserDataRepository;
    const service = createUserDataService({ repository, rateLimiter: consume });
    for (let index = 0; index < 5; index += 1)
      await service.exportUserData(USER_ID);
    await expect(service.exportUserData(USER_ID)).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(consume).toHaveBeenCalledWith(
      `export:${USER_ID}`,
      expect.objectContaining({ capacity: 5, refillPerMinute: 1 }),
    );
  });

  it("uses the smaller independent token bucket for import limits", async () => {
    const consume = vi.fn((key: string) => {
      if (
        consume.mock.calls.filter(([calledKey]) => calledKey === key).length > 3
      ) {
        throw new RateLimitError();
      }
    });
    const repository: UserDataRepository = {
      exportMetadata: vi.fn(),
      listTransactionPage: vi.fn(),
      validateBackupReferences: vi.fn(async () => undefined),
      importUserData: vi.fn(async () => undefined),
      resetUserData: vi.fn(async () => undefined),
      recordAudit: vi.fn(async () => undefined),
    };
    const service = createUserDataService({
      repository,
      rateLimiter: consume,
      withUserMutation: async (_userId, mutate) => mutate({} as never),
      revokePlaidItems: vi.fn(async () => undefined),
    });
    for (let index = 0; index < 3; index += 1)
      await service.importUserData(USER_ID, emptyBackup);
    await expect(
      service.importUserData(USER_ID, emptyBackup),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(consume).toHaveBeenCalledWith(
      `import:${USER_ID}`,
      expect.objectContaining({ capacity: 3, refillPerMinute: 0.5 }),
    );
  });

  it("rejects a mismatched backup version with an actionable message, before any mutation", async () => {
    const importUserData = vi.fn();
    const repository: UserDataRepository = {
      exportMetadata: vi.fn(),
      listTransactionPage: vi.fn(),
      validateBackupReferences: vi.fn(async () => undefined),
      importUserData,
      resetUserData: vi.fn(),
      recordAudit: vi.fn(async () => undefined),
    };
    const service = createUserDataService({
      repository,
      rateLimiter: () => undefined,
      revokePlaidItems: vi.fn(async () => undefined),
    });
    const promise = service.importUserData(USER_ID, {
      ...emptyBackup,
      version: 1,
    });
    await expect(promise).rejects.toBeInstanceOf(ValidationError);
    await expect(promise).rejects.toThrow("older version of Centsy");
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

  it("makes the version-mismatch mechanism work end-to-end for a genuine v1-shaped payload (netWorthSnapshots key absent)", async () => {
    const importUserData = vi.fn();
    const repository: UserDataRepository = {
      exportMetadata: vi.fn(),
      listTransactionPage: vi.fn(),
      validateBackupReferences: vi.fn(async () => undefined),
      importUserData,
      resetUserData: vi.fn(),
      recordAudit: vi.fn(async () => undefined),
    };
    const service = createUserDataService({
      repository,
      rateLimiter: () => undefined,
      revokePlaidItems: vi.fn(async () => undefined),
    });

    // A real v1 export predates netWorthSnapshots entirely, so build the raw
    // payload without the key present at all, then parse it through the
    // actual schema (as the route layer does) rather than constructing an
    // already-typed BackupPayload by hand.
    const rawV1Payload: Record<string, unknown> = { ...emptyBackup };
    delete rawV1Payload.netWorthSnapshots;
    rawV1Payload.version = 1;
    expect(rawV1Payload).not.toHaveProperty("netWorthSnapshots");

    const parsed = BackupPayloadSchema.parse(rawV1Payload);
    expect(parsed.netWorthSnapshots).toEqual([]);

    const promise = service.importUserData(USER_ID, parsed);
    await expect(promise).rejects.toBeInstanceOf(ValidationError);
    await expect(promise).rejects.toThrow("older version of Centsy");
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
      revokePlaidItems: vi.fn(async () => undefined),
      rateLimiter: () => undefined,
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
      recordAudit: vi.fn(async () => undefined),
    };
    const withUserMutation = vi.fn(async (_userId, mutate) =>
      mutate({} as never),
    );
    const service = createUserDataService({
      repository,
      withUserMutation,
      revokePlaidItems: vi.fn(async () => undefined),
      rateLimiter: () => undefined,
    });
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
      rateLimiter: () => undefined,
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

  it("fails closed before destructive mutation when Plaid revocation is unavailable", async () => {
    const importUserData = vi.fn(async () => undefined);
    const resetUserData = vi.fn(async () => undefined);
    const validateBackupReferences = vi.fn(async () => undefined);
    const withUserMutation = vi.fn(async (_userId, mutate) =>
      mutate({} as never),
    );
    const service = createUserDataService({
      repository: {
        exportMetadata: vi.fn(),
        listTransactionPage: vi.fn(),
        validateBackupReferences,
        importUserData,
        resetUserData,
        recordAudit: vi.fn(async () => undefined),
      },
      withUserMutation,
      rateLimiter: () => undefined,
    });

    await expect(
      service.importUserData(USER_ID, emptyBackup),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(service.resetUserData(USER_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(importUserData).not.toHaveBeenCalled();
    expect(resetUserData).not.toHaveBeenCalled();
    expect(validateBackupReferences).not.toHaveBeenCalled();
    expect(withUserMutation).not.toHaveBeenCalled();
  });

  it("fails closed before destructive mutation when Plaid revocation fails", async () => {
    const importUserData = vi.fn(async () => undefined);
    const resetUserData = vi.fn(async () => undefined);
    const validateBackupReferences = vi.fn(async () => undefined);
    const withUserMutation = vi.fn(async (_userId, mutate) =>
      mutate({} as never),
    );
    const revokePlaidItems = vi.fn(async () => {
      const error = new Error("Plaid unavailable");
      Object.assign(error, { accessToken: "access-secret" });
      throw error;
    });
    const logger = { error: vi.fn() };
    const service = createUserDataService({
      repository: {
        exportMetadata: vi.fn(),
        listTransactionPage: vi.fn(),
        validateBackupReferences,
        importUserData,
        resetUserData,
        recordAudit: vi.fn(async () => undefined),
      },
      withUserMutation,
      revokePlaidItems,
      logger,
      rateLimiter: () => undefined,
    });

    await expect(
      service.importUserData(USER_ID, emptyBackup),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(service.resetUserData(USER_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(revokePlaidItems).toHaveBeenCalledTimes(2);
    expect(validateBackupReferences).toHaveBeenCalledTimes(1);
    expect(importUserData).not.toHaveBeenCalled();
    expect(resetUserData).not.toHaveBeenCalled();
    expect(withUserMutation).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        error: expect.objectContaining({
          name: "Error",
          message: "[REDACTED]",
        }),
      }),
      "Plaid item revocation failed",
    );
  });

  it("keeps the typed 503 when revocation failure logging also fails", async () => {
    const withUserMutation = vi.fn();
    const service = createUserDataService({
      repository: {
        exportMetadata: vi.fn(),
        listTransactionPage: vi.fn(),
        validateBackupReferences: vi.fn(async () => undefined),
        importUserData: vi.fn(),
        resetUserData: vi.fn(),
        recordAudit: vi.fn(),
      },
      withUserMutation,
      revokePlaidItems: async () => {
        throw new Error("Plaid unavailable");
      },
      logger: {
        error: async () => {
          throw new Error("logger unavailable");
        },
      },
      rateLimiter: () => undefined,
    });

    await expect(service.resetUserData(USER_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(withUserMutation).not.toHaveBeenCalled();
  });
});
