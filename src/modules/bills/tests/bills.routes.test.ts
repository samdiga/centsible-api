import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

import { createHttpApp } from "../../../app/create-http-app.js";
import {
  ConflictError,
  NotFoundError,
} from "../../../platform/errors/app-error.js";
import type { AppEnv } from "../../../platform/http/hono-env.js";
import { createBillsService, type BillsService } from "../bills.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const BILL_ID = "22222222-2222-4222-8222-222222222222";
const PAID_OCCURRENCE_ID = "33333333-3333-4333-8333-333333333333";
const MISSING_OCCURRENCE_ID = "44444444-4444-4444-8444-444444444444";

const auth = vi.fn(async (c: Context<AppEnv>, next: () => Promise<void>) => {
  c.set("userId", USER_ID);
  c.set("clerkUserId", "clerk-user-1");
  await next();
});

const bill = {
  id: BILL_ID,
  canonicalName: "Rent",
  cadence: "monthly" as const,
  status: "active" as const,
  avgAmountCents: "145000",
  lastAmountCents: null,
  nextExpectedDate: "2026-10-01",
  lastOccurredOn: null,
  categoryId: null,
  billType: "payable" as const,
  accountId: null,
  toAccountId: null,
  confidence: 1,
  sampleCount: 1,
  userConfirmed: true,
  lastPriceChangeAt: null,
  previousAvgAmountCents: null,
  notes: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  currentOccurrence: null,
};

const service: BillsService = {
  listBills: vi.fn(async () => ({ series: [bill], pendingCount: 0 })),
  createBill: vi.fn(async () => bill),
  updateBill: vi.fn(async () => bill),
  deleteBill: vi.fn(async () => true),
  getBill: vi.fn(async () => bill),
  listOccurrences: vi.fn(async () => []),
  markOccurrencePaid: vi.fn(async (_userId, occurrenceId) => {
    if (occurrenceId === MISSING_OCCURRENCE_ID)
      throw new NotFoundError("bill occurrence");
    throw new ConflictError("Bill occurrence cannot be marked paid");
  }),
  skipOccurrence: vi.fn(async () => {
    throw new ConflictError("Bill occurrence cannot be skipped");
  }),
  queueDetection: vi.fn(async () => undefined),
};

function app() {
  return createHttpApp({ auth, billsService: service });
}

async function request(method: string, path: string, body?: unknown) {
  return app().request(path, {
    method,
    headers: {
      authorization: "Bearer test-token",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("bills routes", () => {
  it("preserves the recurring list alias and marks it deprecated", async () => {
    const bills = await request("GET", "/bills");
    const recurring = await request("GET", "/recurring");

    expect(await recurring.json()).toEqual(await bills.json());
    expect(recurring.headers.get("deprecation")).toBe("true");
  });

  it("returns typed not-found and conflict errors for occurrence actions", async () => {
    const paidBody = { accountId: BILL_ID, amountCents: "145000" };
    const missing = await request(
      "POST",
      `/bills/${BILL_ID}/occurrences/${MISSING_OCCURRENCE_ID}/mark-paid`,
      paidBody,
    );
    const skipped = await request(
      "POST",
      `/bills/${BILL_ID}/occurrences/${PAID_OCCURRENCE_ID}/skip`,
    );

    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(skipped.status).toBe(409);
  });

  it("returns an empty occurrence history for an unknown bill", async () => {
    const response = await request(
      "GET",
      "/bills/55555555-5555-4555-8555-555555555555/occurrences",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ occurrences: [] });
  });

  it("does not report detection as queued when the dispatcher is unavailable", async () => {
    const response = await createHttpApp({
      auth,
      billsService: createBillsService(),
    }).request("/bills/detect", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });
});
