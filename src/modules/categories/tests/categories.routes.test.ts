import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

import { createHttpApp } from "../../../app/create-http-app.js";
import { NotFoundError } from "../../../platform/errors/app-error.js";
import type { AppEnv } from "../../../platform/http/hono-env.js";
import type { CategoryService } from "../categories.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const MISSING_ID = "22222222-2222-4222-8222-222222222222";
const validCategory = {
  name: "Dining",
  icon: "utensils",
  color: "#123456",
};

const auth = vi.fn(async (c: Context<AppEnv>, next: () => Promise<void>) => {
  c.set("userId", USER_ID);
  c.set("clerkUserId", "clerk-user-1");
  await next();
});

const category = {
  id: "33333333-3333-4333-8333-333333333333",
  parentId: null,
  name: "Dining",
  icon: "utensils",
  color: "#123456",
  isIncome: false,
  isTransfer: false,
  excludeFromBudgets: false,
  displayOrder: 1,
  isCustom: true,
};

const service: CategoryService = {
  listCategories: vi.fn(async () => [category]),
  createCategory: vi.fn(async () => category),
  updateCategory: vi.fn(async () => {
    throw new NotFoundError("category");
  }),
  archiveCategory: vi.fn(async () => true),
};

function app() {
  return createHttpApp({
    auth,
    categoriesService: service,
  });
}

async function authenticatedRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return app().request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      authorization: "Bearer test-token",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
  });
}

describe("categories routes", () => {
  it("lists visible categories in the documented response envelope", async () => {
    const response = await authenticatedRequest("GET", "/categories");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      categories: expect.any(Array),
    });
  });

  it("creates a category with a 201 response", async () => {
    const response = await authenticatedRequest(
      "POST",
      "/categories",
      validCategory,
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      category: expect.objectContaining({ name: "Dining" }),
    });
  });

  it("uses the platform validation error envelope for malformed input", async () => {
    const response = await authenticatedRequest("POST", "/categories", {
      name: "",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION", message: "Invalid request" },
      requestId: expect.any(String),
    });
  });

  it("uses the category not-found envelope for a missing update", async () => {
    const response = await authenticatedRequest(
      "PATCH",
      `/categories/${MISSING_ID}`,
      { name: "Renamed" },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: "We couldn't find that category.",
      },
      requestId: expect.any(String),
    });
  });

  it("archives a category and returns the documented flag", async () => {
    const response = await authenticatedRequest(
      "DELETE",
      `/categories/${MISSING_ID}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ archived: true });
  });
});
