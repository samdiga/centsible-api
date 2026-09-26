import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { describe, expect, it, vi } from "vitest";

import { handleError } from "../../../platform/errors/error-handler.js";
import type { AppEnv } from "../../../platform/http/hono-env.js";
import { BadCursorError } from "../../../shared/pagination/cursor.js";
import { BadRequestError } from "../../../platform/errors/app-error.js";
import { registerTransactionsRoutes } from "../transactions.routes.js";
import type { TransactionService } from "../transactions.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TRANSACTION_ID = "22222222-2222-4222-8222-222222222222";

const first = [
  transaction("33333333-3333-4333-8333-333333333333", "2026-09-04"),
  transaction("44444444-4444-4444-8444-444444444444", "2026-09-03"),
];
const second = [
  transaction("55555555-5555-4555-8555-555555555555", "2026-09-02"),
  transaction("66666666-6666-4666-8666-666666666666", "2026-09-01"),
];

function transaction(id: string, date: string) {
  return {
    id,
    accountId: "77777777-7777-4777-8777-777777777777",
    amount: "1250",
    currency: "USD",
    date,
    status: "posted" as const,
    name: `Transaction ${id.slice(0, 4)}`,
    merchantName: null,
    paymentChannel: null,
    plaidCategoryPrimary: null,
    plaidCategoryDetailed: null,
    categoryId: null,
    userCategoryOverride: false,
    isRecurring: false,
    reviewStatus: "needs_review" as const,
    userName: null,
    notes: null,
    tagIds: [],
    isManual: false,
  };
}

const service: TransactionService = {
  listTransactions: vi.fn(async (_userId, query) => {
    if (query.cursor === "bad")
      throw new BadCursorError("cursor shape is invalid");
    return query.cursor
      ? { transactions: second, nextCursor: null }
      : { transactions: first, nextCursor: "next-page" };
  }),
  getTransaction: vi.fn(async () => transaction(TRANSACTION_ID, "2026-09-04")),
  patchTransaction: vi.fn(async (_userId, _id, patch) => {
    if (Object.keys(patch).length === 0) {
      throw new BadRequestError(
        "BAD_REQUEST",
        "At least one field is required",
      );
    }
    return transaction(TRANSACTION_ID, "2026-09-04");
  }),
  listSimilarTransactions: vi.fn(async () => [
    transaction("88888888-8888-4888-8888-888888888888", "2026-08-30"),
  ]),
  bulkPatchTransactions: vi.fn(async () => 1),
  createManualTransaction: vi.fn(async (_userId, key: string) => ({
    transaction: {
      ...transaction(TRANSACTION_ID, "2026-09-20"),
      isManual: true,
    },
    replayed: key === "99999999-9999-4999-8999-999999999999",
  })),
  exportTransactionsCsv: vi.fn(async () => ({
    csv: "Date\n",
    truncated: false,
  })),
};

const auth = vi.fn(async (c: Context<AppEnv>, next: () => Promise<void>) => {
  c.set("userId", USER_ID);
  c.set("clerkUserId", "clerk-user");
  await next();
});

function app(transactionService: TransactionService = service) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });
  app.onError(handleError);
  registerTransactionsRoutes(app, auth, transactionService);
  return app;
}

async function errorCode(
  application: OpenAPIHono<AppEnv>,
  method: string,
  path: string,
  body?: unknown,
): Promise<string> {
  const response = await application.request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
  });
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe("transactions routes", () => {
  it("pages transactions without duplicating records and maps malformed input to stable errors", async () => {
    const application = app();
    const firstPage = (await (
      await application.request("/transactions?limit=2")
    ).json()) as {
      transactions: typeof first;
      nextCursor: string | null;
    };
    const secondResponse = await application.request(
      `/transactions?limit=2&cursor=${firstPage.nextCursor}`,
    );
    const secondPage = (await secondResponse.json()) as {
      transactions: typeof second;
    };

    expect(firstPage.transactions).toHaveLength(2);
    expect(secondResponse.status).toBe(200);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(
      new Set([...firstPage.transactions, ...secondPage.transactions]).size,
    ).toBe(4);
    expect(
      await errorCode(application, "GET", "/transactions?cursor=bad"),
    ).toBe("BAD_CURSOR");
    expect(
      await errorCode(
        application,
        "PATCH",
        `/transactions/${TRANSACTION_ID}`,
        {},
      ),
    ).toBe("BAD_REQUEST");
  });

  it("does not send an invalid transaction response to the client", async () => {
    const invalidService: TransactionService = {
      ...service,
      listTransactions: async () => ({
        transactions: [{ ...first[0]!, amount: "12.50" }],
        nextCursor: null,
      }),
    };

    const response = await app(invalidService).request("/transactions");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "INTERNAL" },
    });
  });

  it("keeps malformed request input in the client-validation envelope", async () => {
    const response = await app().request("/transactions?limit=not-a-number");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION" },
    });
  });

  it("serves detail, export, bulk, and patch response envelopes", async () => {
    const application = app();
    const detail = await application.request(`/transactions/${TRANSACTION_ID}`);
    const exported = await application.request("/transactions/export");
    const bulk = await application.request("/transactions/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: [TRANSACTION_ID],
        patch: { categoryId: null },
      }),
    });
    const patched = await application.request(
      `/transactions/${TRANSACTION_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notes: "updated" }),
      },
    );

    expect(await detail.json()).toMatchObject({
      transaction: { id: TRANSACTION_ID },
    });
    expect(exported.headers.get("content-type")).toContain("text/csv");
    expect(exported.headers.get("content-disposition")).toContain(
      "transactions.csv",
    );
    expect(await bulk.json()).toEqual({ updated: 1 });
    expect(await patched.json()).toMatchObject({
      transaction: { id: TRANSACTION_ID },
    });
  });

  it("serves similar transactions for one transaction", async () => {
    const response = await app().request(
      `/transactions/${TRANSACTION_ID}/similar`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { transactions: { id: string }[] };
    expect(body.transactions.map((row) => row.id)).toEqual([
      "88888888-8888-4888-8888-888888888888",
    ]);
    expect(service.listSimilarTransactions).toHaveBeenCalledWith(
      USER_ID,
      TRANSACTION_ID,
    );
    expect(
      (await app().request("/transactions/not-a-uuid/similar")).status,
    ).toBe(400);
  });

  it("creates a manual transaction with an Idempotency-Key and flags replays", async () => {
    const body = {
      accountId: "77777777-7777-4777-8777-777777777777",
      amount: "1250",
      date: "2026-09-20",
      name: "Farmers market",
    };
    const post = (headers: Record<string, string>, payload: unknown = body) =>
      app().request("/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(payload),
      });

    const created = await post({
      "Idempotency-Key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("Idempotent-Replayed")).toBeNull();
    expect(
      ((await created.json()) as { transaction: { isManual: boolean } })
        .transaction.isManual,
    ).toBe(true);
    expect(service.createManualTransaction).toHaveBeenCalledWith(
      USER_ID,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      body,
    );

    const replayed = await post({
      "Idempotency-Key": "99999999-9999-4999-8999-999999999999",
    });
    expect(replayed.status).toBe(201);
    expect(replayed.headers.get("Idempotent-Replayed")).toBe("true");

    expect((await post({})).status).toBe(400);
    expect((await post({ "Idempotency-Key": "not-a-uuid" })).status).toBe(400);
    const key = { "Idempotency-Key": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    expect((await post(key, { ...body, amount: "12.50" })).status).toBe(400);
    expect((await post(key, { ...body, date: "2026-02-30" })).status).toBe(400);
    expect((await post(key, { ...body, name: "   " })).status).toBe(400);
    expect((await post(key, { ...body, extra: true })).status).toBe(400);
  });
});
