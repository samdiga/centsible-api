import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

import { createHttpApp } from "../../../app/create-http-app.js";
import {
  NotFoundError,
  ConflictError,
} from "../../../platform/errors/app-error.js";
import type { AppEnv } from "../../../platform/http/hono-env.js";
import type { TagService } from "../tags.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const MISSING_ID = "22222222-2222-4222-8222-222222222222";

const auth = vi.fn(async (c: Context<AppEnv>, next: () => Promise<void>) => {
  c.set("userId", USER_ID);
  c.set("clerkUserId", "clerk-user-1");
  await next();
});

const tag = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Dining",
  color: "#123456",
  createdAt: "2026-09-01T00:00:00.000Z",
};

function service(): TagService {
  return {
    listTags: vi.fn(async () => [tag]),
    createTag: vi.fn(async () => tag),
    updateTag: vi.fn(async () => {
      throw new NotFoundError("tag");
    }),
    deleteTag: vi.fn(async () => true),
  };
}

function app(svc: TagService) {
  return createHttpApp({ auth, tagsService: svc });
}

async function authenticatedRequest(
  method: string,
  path: string,
  body: unknown,
  svc: TagService,
): Promise<Response> {
  return app(svc).request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      authorization: "Bearer test-token",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
  });
}

describe("tags routes", () => {
  it("lists the user's tags in the documented response envelope", async () => {
    const response = await authenticatedRequest(
      "GET",
      "/tags",
      undefined,
      service(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tags: [tag] });
  });

  it("creates a tag with a 201 response", async () => {
    const response = await authenticatedRequest(
      "POST",
      "/tags",
      { name: "Dining", color: "#123456" },
      service(),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      tag: expect.objectContaining({ name: "Dining" }),
    });
  });

  it("uses the platform validation error envelope for malformed input", async () => {
    const response = await authenticatedRequest(
      "POST",
      "/tags",
      { name: "" },
      service(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION", message: "Invalid request" },
      requestId: expect.any(String),
    });
  });

  it("maps a duplicate name to a 409 conflict envelope", async () => {
    const svc = service();
    vi.mocked(svc.createTag).mockRejectedValue(
      new ConflictError('A tag named "Dining" already exists.'),
    );
    const response = await authenticatedRequest(
      "POST",
      "/tags",
      { name: "Dining" },
      svc,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "CONFLICT" },
    });
  });

  it("uses the tag not-found envelope for a missing update", async () => {
    const response = await authenticatedRequest(
      "PATCH",
      `/tags/${MISSING_ID}`,
      { name: "Renamed" },
      service(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "We couldn't find that tag." },
      requestId: expect.any(String),
    });
  });

  it("deletes a tag and returns the documented flag", async () => {
    const response = await authenticatedRequest(
      "DELETE",
      `/tags/${MISSING_ID}`,
      undefined,
      service(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
  });
});
