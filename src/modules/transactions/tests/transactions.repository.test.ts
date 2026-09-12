import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import { toTransactionDto } from "../transactions.mapper.js";
import {
  transactionRepository,
  type TransactionListRow,
} from "../transactions.repository.js";

describe("transactions repository boundary", () => {
  it("uses physical column names for every Plaid upsert excluded expression", async () => {
    const returning = vi.fn(async () => [
      { id: "11111111-1111-4111-8111-111111111111" },
    ]);
    let conflict: { set: Record<string, unknown> } | undefined;
    const onConflictDoUpdate = vi.fn(
      (config: { set: Record<string, unknown> }) => {
        conflict = config;
        return { returning };
      },
    );
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const db = { insert: vi.fn(() => ({ values })) };

    await transactionRepository.upsertFromPlaid(
      {
        userId: "22222222-2222-4222-8222-222222222222",
        accountId: "33333333-3333-4333-8333-333333333333",
        txn: {
          transaction_id: "plaid-transaction",
          amount: 12.5,
          date: "2026-09-04",
          pending: false,
          name: "Coffee",
        },
      },
      db as never,
    );

    if (!conflict) throw new Error("expected conflict update configuration");
    const dialect = new PgDialect();
    const sqlText = (value: unknown) =>
      dialect.sqlToQuery(value as Parameters<typeof dialect.sqlToQuery>[0]).sql;
    const expectedExcludedColumns = {
      amount: "amount_cents",
      currency: "currency",
      date: "date",
      authorizedDate: "authorized_date",
      status: "status",
      name: "name",
      merchantName: "merchant_name",
      paymentChannel: "payment_channel",
      plaidRawPayload: "plaid_raw_payload",
      plaidCategoryPrimary: "plaid_category_primary",
      plaidCategoryDetailed: "plaid_category_detailed",
      plaidCategoryConfidence: "plaid_category_confidence",
    };

    for (const [field, column] of Object.entries(expectedExcludedColumns)) {
      expect(sqlText(conflict.set[field])).toContain(`excluded.${column}`);
    }
  });

  it("recursively serializes raw row audit snapshots before JSONB insertion", async () => {
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));

    await transactionRepository.recordAudit(
      {
        userId: "11111111-1111-4111-8111-111111111111",
        entityId: "22222222-2222-4222-8222-222222222222",
        source: "transactions.patch",
        before: {
          amount: 1250n,
          updatedAt: new Date("2026-09-04T12:00:00.000Z"),
          nested: [{ amount: -50n }],
        },
        after: { amount: 1300n },
      },
      { insert } as never,
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeJson: {
          amount: "1250",
          updatedAt: "2026-09-04T12:00:00.000Z",
          nested: [{ amount: "-50" }],
        },
        afterJson: { amount: "1300" },
      }),
    );
  });

  it("keeps bigint money internal while exposing cents as a wire-safe string", () => {
    const row: TransactionListRow = {
      id: "11111111-1111-4111-8111-111111111111",
      plaidTransactionId: "plaid",
      accountId: "22222222-2222-4222-8222-222222222222",
      amount: 1250n,
      currency: "USD",
      date: "2026-09-04",
      status: "posted",
      name: "Coffee",
      merchantName: null,
      paymentChannel: null,
      plaidCategoryPrimary: null,
      plaidCategoryDetailed: null,
      categoryId: null,
      userCategoryOverride: false,
      isRecurring: false,
      reviewStatus: "needs_review",
      userName: null,
      notes: null,
    };

    expect(toTransactionDto(row, [])).toMatchObject({
      amount: "1250",
      name: "Coffee",
    });
  });
});

describe("applyRuleMatch", () => {
  it("does not attempt to set a tagIds column even if the patch carries one", async () => {
    const setMock = vi.fn<(patch: Record<string, unknown>) => unknown>(() => ({
      where: () => ({ returning: () => Promise.resolve([{ id: "txn-1" }]) }),
    }));
    const db = { update: () => ({ set: setMock }) } as never;
    await transactionRepository.applyRuleMatch(
      "txn-1",
      "user-1",
      // tagIds is a legal field of TransactionPatchFields (shared with
      // updateTransaction/bulkUpdateTransactions), so this is not a type
      // error — it proves the repository itself is defensive at runtime
      // if a tagIds-bearing patch ever reaches this call.
      { categoryId: "cat-1", tagIds: ["tag-1"] },
      db,
    );
    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty("tagIds");
    expect(setArg.categoryId).toBe("cat-1");
  });
});

describe("addTransactionTags", () => {
  it("is a no-op for an empty tag list", async () => {
    const insertMock = vi.fn();
    const db = { insert: insertMock } as never;
    await transactionRepository.addTransactionTags("txn-1", [], db);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("inserts with onConflictDoNothing, deduped", async () => {
    const valuesMock = vi.fn(() => ({
      onConflictDoNothing: vi.fn(() => Promise.resolve()),
    }));
    const db = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([{ id: "tag-1" }, { id: "tag-2" }]),
        }),
      }),
      insert: () => ({ values: valuesMock }),
    } as never;
    await transactionRepository.addTransactionTags(
      "txn-1",
      ["tag-1", "tag-1", "tag-2"],
      db,
    );
    expect(valuesMock).toHaveBeenCalledWith([
      { transactionId: "txn-1", tagId: "tag-1" },
      { transactionId: "txn-1", tagId: "tag-2" },
    ]);
  });

  it("silently drops a tag id that no longer exists instead of inserting or throwing", async () => {
    const valuesMock = vi.fn(() => ({
      onConflictDoNothing: vi.fn(() => Promise.resolve()),
    }));
    const insertMock = vi.fn(() => ({ values: valuesMock }));
    // Only "tag-1" exists; "tag-missing" was deleted after the rule that
    // references it was created (rules.action_add_tags has no FK, so this
    // is a real, persistent scenario — not hypothetical).
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ id: "tag-1" }]),
        }),
      }),
      insert: insertMock,
    } as never;
    await transactionRepository.addTransactionTags(
      "txn-1",
      ["tag-1", "tag-missing"],
      db,
    );
    expect(valuesMock).toHaveBeenCalledWith([
      { transactionId: "txn-1", tagId: "tag-1" },
    ]);
  });

  it("is a no-op (no insert call) when none of the tag ids exist", async () => {
    const insertMock = vi.fn();
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
      insert: insertMock,
    } as never;
    await transactionRepository.addTransactionTags(
      "txn-1",
      ["tag-missing"],
      db,
    );
    expect(insertMock).not.toHaveBeenCalled();
  });
});
