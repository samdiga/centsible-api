import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

import { createHttpApp } from "../../../app/create-http-app.js";
import { NotFoundError } from "../../../platform/errors/app-error.js";
import type { AppEnv } from "../../../platform/http/hono-env.js";
import type { BudgetsService } from "../budgets.service.js";
import { createBudgetsService } from "../budgets.service.js";
import type { BudgetRepository } from "../budgets.repository.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CATEGORY_ID = "22222222-2222-4222-8222-222222222222";
const BUDGET_ID = "33333333-3333-4333-8333-333333333333";

const auth = vi.fn(async (c: Context<AppEnv>, next: () => Promise<void>) => {
  c.set("userId", USER_ID);
  c.set("clerkUserId", "clerk-user-1");
  await next();
});

const budget = {
  id: BUDGET_ID,
  name: "My Budget",
  period: "monthly" as const,
  startDate: "2026-09-01",
  isActive: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  items: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      budgetId: BUDGET_ID,
      categoryId: CATEGORY_ID,
      categoryName: "Dining",
      amountCents: "50000",
    },
  ],
};

const service: BudgetsService = {
  getSetupSuggestions: vi.fn(async () => []),
  getActiveBudget: vi.fn(async () => budget),
  createBudget: vi.fn(async () => ({ id: BUDGET_ID })),
  getBudgetProgress: vi.fn(async () => ({
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    totalBudgetedCents: "50000",
    totalSpentCents: "12000",
    items: [
      {
        categoryId: CATEGORY_ID,
        categoryName: "Dining",
        budgetedCents: "50000",
        spentCents: "12000",
        remainingCents: "38000",
      },
    ],
  })),
  replaceBudgetItems: vi.fn(async () => undefined),
  upsertBudgetItem: vi.fn(async () => ({
    id: "44444444-4444-4444-8444-444444444444",
    budgetId: BUDGET_ID,
    categoryId: CATEGORY_ID,
    amountCents: "50000",
  })),
  deleteBudgetItem: vi.fn(async () => true),
};

function request(method: string, path: string, body?: unknown) {
  return createHttpApp({ auth, budgetsService: service }).request(path, {
    method,
    headers: {
      authorization: "Bearer test-token",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("budgets routes", () => {
  it("returns a typed not-found envelope when there is no active budget", async () => {
    const noBudgetService: BudgetsService = {
      ...service,
      getActiveBudget: vi.fn(async () => {
        throw new NotFoundError("active budget");
      }),
    };
    const response = await createHttpApp({
      auth,
      budgetsService: noBudgetService,
    }).request("/budgets/active", {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: "We couldn't find that active budget.",
      },
    });
  });

  it("keeps money values as signed decimal integer strings", async () => {
    const response = await request("GET", `/budgets/${BUDGET_ID}/progress`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      progress: { items: Array<{ spentCents: string }> };
    };
    expect(body.progress.items[0]?.spentCents).toMatch(/^-?\d+$/);
  });

  it("creates a budget with a 201 response", async () => {
    const response = await request("POST", "/budgets", {
      name: "September",
      items: [{ categoryId: CATEGORY_ID, amountCents: "50000" }],
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: BUDGET_ID });
  });

  it("runs deletion through one user mutation and advances its revision", async () => {
    let revision = 3n;
    let mutationCalls = 0;
    const row = {
      id: BUDGET_ID,
      userId: USER_ID,
      name: "My Budget",
      style: "flex" as const,
      period: "monthly" as const,
      startDate: "2026-09-01",
      isActive: true,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    };
    const repository: BudgetRepository = {
      getActiveBudget: vi.fn(async () => row),
      getBudgetItems: vi.fn(async () => []),
      createBudget: vi.fn(),
      replaceBudgetItems: vi.fn(),
      upsertBudgetItem: vi.fn(),
      deleteBudgetItem: vi.fn(async () => true),
      categoryExists: vi.fn(async () => true),
      getCategoryNames: vi.fn(async () => new Map()),
      getCategoryMedians: vi.fn(async () => []),
      getSpentByCategory: vi.fn(async () => []),
      recordAudit: vi.fn(async () => undefined),
    };
    const serviceUnderTest = createBudgetsService({
      repository,
      getUserRevision: async () => revision,
      withUserMutation: async (_userId, callback) => {
        mutationCalls += 1;
        const result = await callback({} as never);
        revision += 1n;
        return result;
      },
    });

    const before = revision;
    await expect(
      serviceUnderTest.deleteBudgetItem(USER_ID, CATEGORY_ID),
    ).resolves.toBe(true);
    expect(mutationCalls).toBe(1);
    expect(revision).toBeGreaterThan(before);
  });
});
