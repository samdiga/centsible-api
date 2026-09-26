import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

import { createHttpApp } from "../../../app/create-http-app.js";
import { createOpenApiDocument } from "../../../platform/openapi/document.js";
import {
  ConflictError,
  NotFoundError,
} from "../../../platform/errors/app-error.js";
import type { AppEnv } from "../../../platform/http/hono-env.js";
import { createBillsService, type BillsService } from "../bills.service.js";
import { UpdateBillOccurrenceBodySchema } from "../bills.schemas.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const BILL_ID = "22222222-2222-4222-8222-222222222222";
const PAID_OCCURRENCE_ID = "33333333-3333-4333-8333-333333333333";
const MISSING_OCCURRENCE_ID = "44444444-4444-4444-8444-444444444444";
const OCCURRENCE_ID = "55555555-5555-4555-8555-555555555555";

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
  updateOccurrence: vi.fn(async () => ({
    id: OCCURRENCE_ID,
    billSetupId: BILL_ID,
    dueDate: "2026-10-22",
    status: "upcoming" as const,
    expectedAmountCents: "17000",
    paidAmountCents: null,
    paidAccountId: null,
    linkedTransactionId: null,
    markedPaidAt: null,
    confirmedPaidAt: null,
    notes: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    baselineDueDate: "2026-10-20",
    baselineAmountCents: "25000",
    dueDateOverride: "2026-10-22",
    amountOverrideCents: "17000",
    linkedTransaction: null,
  })),
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
  it("validates occurrence overrides as a nonempty strict patch", () => {
    expect(
      UpdateBillOccurrenceBodySchema.safeParse({ amountCents: "12500" })
        .success,
    ).toBe(true);
    expect(
      UpdateBillOccurrenceBodySchema.safeParse({ dueDate: "2026-02-28" })
        .success,
    ).toBe(true);
    expect(
      UpdateBillOccurrenceBodySchema.safeParse({
        amountCents: "12500",
        dueDate: "2026-02-28",
      }).success,
    ).toBe(true);
    for (const input of [
      {},
      { amountCents: "0" },
      { amountCents: "-1" },
      { amountCents: "1.5" },
      { dueDate: "2026-02-30" },
      { dueDate: "2026/02/28" },
      { amountCents: "100", status: "paid" },
    ]) {
      expect(UpdateBillOccurrenceBodySchema.safeParse(input).success).toBe(
        false,
      );
    }
  });

  it("passes an explicit null through so the service can clear an override", async () => {
    const response = await request(
      "PATCH",
      `/bills/${BILL_ID}/occurrences/${OCCURRENCE_ID}`,
      { amountCents: null },
    );
    expect(response.status).toBe(200);
    expect(service.updateOccurrence).toHaveBeenLastCalledWith(
      USER_ID,
      BILL_ID,
      OCCURRENCE_ID,
      { amountCents: null },
    );
  });

  it("patches one occurrence and returns its effective DTO", async () => {
    const response = await request(
      "PATCH",
      `/bills/${BILL_ID}/occurrences/${OCCURRENCE_ID}`,
      { amountCents: "17000", dueDate: "2026-10-22" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      occurrence: {
        id: OCCURRENCE_ID,
        billSetupId: BILL_ID,
        dueDate: "2026-10-22",
        status: "upcoming",
        expectedAmountCents: "17000",
        paidAmountCents: null,
        paidAccountId: null,
        linkedTransactionId: null,
        markedPaidAt: null,
        confirmedPaidAt: null,
        notes: null,
        createdAt: "2026-09-01T00:00:00.000Z",
        baselineDueDate: "2026-10-20",
        baselineAmountCents: "25000",
        dueDateOverride: "2026-10-22",
        amountOverrideCents: "17000",
        linkedTransaction: null,
      },
    });
    expect(service.updateOccurrence).toHaveBeenCalledWith(
      USER_ID,
      BILL_ID,
      OCCURRENCE_ID,
      {
        amountCents: 17000n,
        dueDate: "2026-10-22",
      },
    );
  });

  it("declares typed not-found and conflict responses for occurrence overrides", () => {
    const document = createOpenApiDocument(app()) as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
    };
    const responses = document.paths["/bills/{id}/occurrences/{occId}"]?.patch
      ?.responses as
      | Record<string, { content?: Record<string, { schema?: unknown }> }>
      | undefined;
    expect(
      responses?.["404"]?.content?.["application/json"]?.schema,
    ).toBeDefined();
    expect(
      responses?.["409"]?.content?.["application/json"]?.schema,
    ).toBeDefined();
  });

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
