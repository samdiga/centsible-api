import { Hono } from "hono";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  ValidationError,
} from "./app-error.js";
import { handleError } from "./error-handler.js";
import { apiBodyLimit } from "../http/body-limit.js";
import type { AppEnv } from "../http/hono-env.js";
import { requestId } from "../http/request-id.js";

function testApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requestId());
  app.use("*", apiBodyLimit());
  app.get("/expected/:kind", (c) => {
    const errors = {
      conflict: new ConflictError("Duplicate item"),
      forbidden: new ForbiddenError(),
      missing: new NotFoundError("item"),
      rate: new RateLimitError(),
      upstream: new UpstreamError("Upstream unavailable"),
      validation: new ValidationError("Invalid request", [["name"]]),
    } as const;
    throw errors[c.req.param("kind") as keyof typeof errors];
  });
  app.post("/zod", async (c) => {
    const parsed = z
      .object({ account: z.object({ name: z.string().min(1) }) })
      .safeParse(await c.req.json());
    if (!parsed.success) throw parsed.error;
    return c.json(parsed.data);
  });
  app.get("/explode", () => {
    throw new Error("database password and transaction Rent");
  });
  app.notFound((c) => handleError(new NotFoundError("route"), c));
  app.onError(handleError);
  return app;
}

describe("HTTP error envelope", () => {
  it("maps every expected error to the stable envelope", async () => {
    const response = await testApp().request("/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: expect.any(String) },
      requestId: expect.any(String),
    });
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it.each([
    ["conflict", 409, "CONFLICT"],
    ["forbidden", 403, "FORBIDDEN"],
    ["missing", 404, "NOT_FOUND"],
    ["rate", 429, "RATE_LIMITED"],
    ["upstream", 502, "UPSTREAM"],
    ["validation", 400, "VALIDATION"],
  ])("normalizes %s errors", async (kind, status, code) => {
    const response = await testApp().request(`/expected/${kind}`);

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      error: { code },
      requestId: expect.any(String),
    });
  });

  it("preserves supplied request IDs in error bodies and headers", async () => {
    const response = await testApp().request("/missing", {
      headers: { "x-request-id": "swift-42" },
    });

    expect(response.headers.get("x-request-id")).toBe("swift-42");
    expect(await response.json()).toMatchObject({ requestId: "swift-42" });
  });

  it("exposes validation paths without exposing implementation details", async () => {
    const response = await testApp().request("/zod", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: { name: "" } }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION", details: [["account", "name"]] },
    });
  });

  it.each([
    ["/other", 64 * 1024, 200],
    ["/other", 64 * 1024 + 1, 413],
    ["/user/import", 64 * 1024, 200],
    ["/user/import", 25 * 1024 * 1024, 200],
    ["/user/import", 25 * 1024 * 1024 + 1, 413],
    ["/user/import/", 64 * 1024 + 1, 413],
  ])("enforces the selected body limit for %s", async (path, bytes, status) => {
    const app = testApp();
    app.post("/other", (c) => c.text("ok"));
    app.post("/user/import", (c) => c.text("ok"));
    app.post("/user/import/", (c) => c.text("ok"));
    const response = await app.request(path, {
      method: "POST",
      body: "x".repeat(bytes),
    });

    expect(response.status).toBe(status);
    if (status === 413)
      expect(await response.json()).toMatchObject({
        error: { code: "PAYLOAD_TOO_LARGE" },
        requestId: expect.any(String),
      });
  });

  it("returns a safe internal error and redacts unexpected-error logs", async () => {
    const errorLog = vi.fn();
    const app = new Hono<AppEnv>();
    app.use("*", requestId());
    app.get("/explode", () => {
      throw new Error("password super-secret Rent");
    });
    app.onError((error, c) => handleError(error, c, { error: errorLog }));

    const response = await app.request("/explode");
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      error: { code: "INTERNAL", message: "Something went wrong." },
      requestId: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain("super-secret");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("super-secret");
  });
});
