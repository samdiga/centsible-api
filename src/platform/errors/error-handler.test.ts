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
import { requestLog, type RequestLogRoot } from "../http/request-log.js";

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
      validation: new ValidationError("Invalid request", [
        { path: ["name"], code: "too_small" },
      ]),
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
    ["upstream", 502, "UPSTREAM_FAILURE"],
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

  it("sets a safe default Retry-After header for rate limited responses", async () => {
    const response = await testApp().request("/expected/rate");

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  });

  it("uses the supplied retry duration in the Retry-After header", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", requestId());
    app.get("/rate", () => {
      throw new RateLimitError(17);
    });
    app.onError(handleError);

    const response = await app.request("/rate");

    expect(response.headers.get("retry-after")).toBe("17");
  });

  it("exposes stable validation issue codes and paths without Zod details", async () => {
    const response = await testApp().request("/zod", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: { name: "" } }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "VALIDATION",
        details: [{ path: ["account", "name"], code: "too_small" }],
      },
    });
    expect(JSON.stringify(body)).not.toContain("Too small");
    expect(JSON.stringify(body)).not.toContain('"input"');
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

  it("returns a safe internal error with allowlisted, sanitized diagnostics", async () => {
    const errorLog = vi.fn();
    const app = new Hono<AppEnv>();
    app.use("*", requestId());
    app.get("/explode", () => {
      const cause = Object.assign(new Error("cause super-secret"), {
        code: "CAUSE_UNAVAILABLE",
        status: 503,
      });
      const error = Object.assign(new Error("password super-secret Rent"), {
        code: "UPSTREAM_FAILURE",
        statusCode: 502,
        cause,
        response: {
          data: {
            error_code: "ITEM_LOGIN_REQUIRED",
            error_type: "ITEM_ERROR",
            error_message: "provider rejected super-secret request",
            request_id: "plaid-request-42",
            access_token: "token super-secret",
            transactionDescription: "Rent",
          },
        },
      });
      cause.cause = error;
      error.stack =
        "Error: password super-secret Rent\n    at safeFrame (handler.ts:1:1)";
      throw error;
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
    const bindings = errorLog.mock.calls[0]?.[0];
    expect(bindings).toMatchObject({
      requestId: expect.any(String),
      route: "/explode",
      diagnostic: {
        name: "Error",
        code: "UPSTREAM_FAILURE",
        statusCode: 502,
        stack: ["    at safeFrame (handler.ts:1:1)"],
        cause: { name: "Error", code: "CAUSE_UNAVAILABLE", status: 503 },
        upstream: {
          error_code: "ITEM_LOGIN_REQUIRED",
          error_type: "ITEM_ERROR",
          request_id: "plaid-request-42",
        },
      },
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("super-secret");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("Rent");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("access_token");
    expect(bindings).not.toMatchObject({
      diagnostic: { upstream: { error_message: expect.anything() } },
    });
  });

  it("records exactly one completion event for a thrown request", async () => {
    const debug = vi.fn();
    const requestLogger: RequestLogRoot = {
      child: vi.fn(() => ({ debug })),
    };
    const app = new Hono<AppEnv>();
    app.use("*", requestId());
    app.use("*", requestLog(requestLogger));
    app.get("/explode", () => {
      throw new Error("database secret");
    });
    app.onError((error, c) => handleError(error, c, { error: vi.fn() }));

    const response = await app.request("/explode");
    const completions = debug.mock.calls.filter(
      ([, message]) => message === "Request complete",
    );

    expect(response.status).toBe(500);
    expect(requestLogger.child).toHaveBeenCalledWith({
      requestId: expect.any(String),
    });
    expect(completions).toHaveLength(1);
    expect(completions[0]?.[0]).toMatchObject({
      method: "GET",
      path: "/explode",
      status: 500,
      elapsedMs: expect.any(Number),
    });
  });
});
