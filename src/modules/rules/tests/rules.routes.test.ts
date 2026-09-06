import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

import { createHttpApp } from "../../../app/create-http-app.js";
import { NotFoundError } from "../../../platform/errors/app-error.js";
import type { AppEnv } from "../../../platform/http/hono-env.js";
import {
  createOpenApiDocument,
  listOpenApiOperations,
} from "../../../platform/openapi/document.js";
import type { RuleService } from "../rules.service.js";
import { createRuleService } from "../rules.service.js";
import type { RuleRepository, RuleRow } from "../rules.repository.js";
import type { DbTransaction } from "../../../platform/database/types.js";
import type { UserMutationService } from "../../../platform/cache/user-revisions.repository.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_RULE_ID = "22222222-2222-4222-8222-222222222222";
const RULE_ID = "33333333-3333-4333-8333-333333333333";
const CATEGORY_ID = "44444444-4444-4444-8444-444444444444";

const auth = vi.fn(async (c: Context<AppEnv>, next: () => Promise<void>) => {
  c.set("userId", USER_ID);
  c.set("clerkUserId", "clerk-user-1");
  await next();
});

const rule = {
  id: RULE_ID,
  name: "Whole Foods",
  priority: 10,
  matchType: "merchant_exact" as const,
  matchMerchant: "Whole Foods",
  matchNameContains: null,
  matchAmountMin: null,
  matchAmountMax: null,
  matchAccountId: null,
  actionCategoryId: CATEGORY_ID,
  actionMemberId: null,
  actionSetNotes: null,
  actionMarkReviewed: null,
  actionExcludeFromBudgets: null,
  isActive: true,
  applyToExisting: true,
  timesApplied: 0,
  lastAppliedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
};

const createInput = {
  matchType: "merchant_exact" as const,
  matchMerchant: "Whole Foods",
  actionCategoryId: CATEGORY_ID,
  applyToExisting: true,
};

const service: RuleService = {
  listRules: vi.fn(async () => [rule]),
  previewCount: vi.fn(async () => 3),
  createRule: vi.fn(async () => ({
    rule,
    retroactiveJobId: "55555555-5555-4555-8555-555555555555",
  })),
  updateRule: vi.fn(async (_userId, id) => {
    if (id === OTHER_RULE_ID) throw new NotFoundError("rule");
    return rule;
  }),
  deleteRule: vi.fn(async () => true),
};

function request(method: string, path: string, body?: unknown) {
  return createHttpApp({ auth, rulesService: service }).request(path, {
    method,
    headers: {
      authorization: "Bearer test-token",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("rules routes", () => {
  it("registers exactly the five Rules OpenAPI operations", () => {
    const operations = listOpenApiOperations(
      createOpenApiDocument(createHttpApp({ auth, rulesService: service })),
    ).filter((operation) => operation.path.startsWith("/rules"));
    expect(operations).toEqual([
      { method: "get", path: "/rules" },
      { method: "post", path: "/rules" },
      { method: "delete", path: "/rules/{id}" },
      { method: "patch", path: "/rules/{id}" },
      { method: "get", path: "/rules/preview" },
    ]);
  });

  it("exposes exactly the documented list, preview, create, update, and delete behavior", async () => {
    expect((await request("GET", "/rules")).status).toBe(200);
    expect(await (await request("GET", "/rules")).json()).toMatchObject({
      rules: [rule],
    });
    expect(
      await (
        await request(
          "GET",
          "/rules/preview?matchType=merchant_exact&matchMerchant=whole",
        )
      ).json(),
    ).toEqual({ count: 3 });
    const created = await request("POST", "/rules", createInput);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      rule,
      retroactiveJobId: expect.any(String),
    });
    expect(
      (await request("PATCH", `/rules/${RULE_ID}`, { priority: 20 })).status,
    ).toBe(200);
    expect((await request("DELETE", `/rules/${RULE_ID}`)).status).toBe(200);
  });

  it("maps another user's update to the stable not-found envelope", async () => {
    const response = await request("PATCH", `/rules/${OTHER_RULE_ID}`, {
      priority: 20,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
      requestId: expect.any(String),
    });
  });

  it("rejects malformed rule input", async () => {
    const response = await request("POST", "/rules", { matchType: "invalid" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION" },
    });
  });

  it("returns 503 and does not mutate when retroactive dispatch is unavailable", async () => {
    const persistedRule = {
      ...rule,
      matchAmountMin: null,
      matchAmountMax: null,
      timesApplied: 0,
      createdAt: new Date(rule.createdAt),
      updatedAt: new Date(rule.createdAt),
    } as unknown as RuleRow;
    const repository = {
      createRule: vi.fn(async () => persistedRule),
      categoryExists: vi.fn(async () => true),
      categoryName: vi.fn(async () => "Groceries"),
    } as unknown as RuleRepository;
    const mutationCalls: string[] = [];
    const withUserMutation: UserMutationService["withUserMutation"] = async <T>(
      userId: string,
      callback: (tx: DbTransaction) => Promise<T>,
    ) => {
      mutationCalls.push(userId);
      return callback({} as DbTransaction);
    };
    const realService = createRuleService({ repository, withUserMutation });
    const response = await createHttpApp({
      auth,
      rulesService: realService,
    }).request("/rules", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(createInput),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Service temporarily unavailable.",
      },
      requestId: expect.any(String),
    });
    expect(mutationCalls).toHaveLength(0);
    expect(repository.createRule).not.toHaveBeenCalled();
  });
});
