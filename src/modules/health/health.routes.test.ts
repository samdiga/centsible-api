import { AppError } from "../../platform/errors/app-error.js";
import type { Context } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createHttpApp,
  type ProtectedRouteRegistration,
} from "../../app/create-http-app.js";
import type { AppEnv } from "../../platform/http/hono-env.js";

describe("health route", () => {
  it("returns the unwrapped service health body in memory without configuration", async () => {
    const response = await createHttpApp().request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "centsible-api",
      timestamp: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      ),
    });
  });

  it("keeps health public while using injected protected-route dependencies", async () => {
    const auth = vi.fn(
      async (c: Context<AppEnv>, next: () => Promise<void>) => {
        c.set("userId", "user-42");
        await next();
      },
    );
    const registerProtectedRoutes: ProtectedRouteRegistration = vi.fn(
      (app, suppliedAuth) => {
        app.use("/protected/*", suppliedAuth);
        app.get("/protected/ping", (c: Context<AppEnv>) =>
          c.json({ userId: c.get("userId") }),
        );
      },
    );
    const app = createHttpApp({ auth, registerProtectedRoutes });

    const health = await app.request("/health");
    const protectedResponse = await app.request("/protected/ping");

    expect(health.status).toBe(200);
    expect(await protectedResponse.json()).toEqual({ userId: "user-42" });
    expect(auth).toHaveBeenCalledTimes(1);
    expect(registerProtectedRoutes).toHaveBeenCalledWith(app, auth);
  });

  it("applies request IDs, security headers, logging, and the global error envelope", async () => {
    const debug = vi.fn();
    const logger = { child: vi.fn(() => ({ debug })) };
    const app = createHttpApp({
      logger,
      registerProtectedRoutes: (protectedApp) => {
        protectedApp.get("/explode", () => {
          throw new AppError("TEST_FAILURE", "private", 418, "Safe failure.");
        });
      },
    });

    const response = await app.request("/explode", {
      headers: { "x-request-id": "composition-42" },
    });

    expect(response.status).toBe(418);
    expect(response.headers.get("x-request-id")).toBe("composition-42");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({
      error: { code: "TEST_FAILURE", message: "Safe failure." },
      requestId: "composition-42",
    });
    expect(logger.child).toHaveBeenCalledWith({ requestId: "composition-42" });
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ status: 418 }),
      "Request complete",
    );
  });

  it("uses the composition's body limit and stable not-found envelope", async () => {
    const app = createHttpApp({
      registerProtectedRoutes: (protectedApp) => {
        protectedApp.post("/payload", (c) => c.text("accepted"));
      },
    });

    const oversized = await app.request("/payload", {
      method: "POST",
      body: "x".repeat(64 * 1024 + 1),
    });
    const missing = await app.request("/missing", {
      headers: { "x-request-id": "missing-42" },
    });

    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
      requestId: expect.any(String),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "NOT_FOUND", message: "We couldn't find that route." },
      requestId: "missing-42",
    });
  });
});
