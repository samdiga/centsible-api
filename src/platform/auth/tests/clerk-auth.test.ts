import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { handleError } from "../../errors/error-handler.js";
import type { AppEnv } from "../../http/hono-env.js";
import { requestId } from "../../http/request-id.js";
import {
  clerkAuth,
  __resetAuthCachesForTests,
  type ClerkAuthDependencies,
} from "../clerk-auth.js";
import type { UserIdentityRepository } from "../user-identity.repository.js";

const identity = {
  id: "user_clerk",
  emailAddresses: [{ emailAddress: "person@example.test" }],
  firstName: "Pat",
};

function repository(): UserIdentityRepository {
  return {
    findByAuthProviderId: vi.fn(async () => null),
    findOrCreateByAuthProviderId: vi.fn(async () => ({ id: "internal-user" })),
  };
}

function protectedApp(
  dependencies: ClerkAuthDependencies,
  onWrite = vi.fn(),
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requestId());
  app.post("/protected", clerkAuth(dependencies), (c) => {
    onWrite();
    return c.json({
      userId: c.get("userId"),
      clerkUserId: c.get("clerkUserId"),
    });
  });
  app.onError(handleError);
  return app;
}

function deps(
  overrides: Partial<ClerkAuthDependencies> = {},
): ClerkAuthDependencies {
  const repo = repository();
  return {
    configuration: () => ({
      CLERK_SECRET_KEY: "clerk-secret",
      CLERK_JWT_KEY: undefined,
    }),
    verifyToken: vi.fn(async () => ({ sub: "user_clerk" })),
    clerkClient: { users: { getUser: vi.fn(async () => identity) } },
    repository: repo,
    ...overrides,
  };
}

describe("clerkAuth", () => {
  it.each([
    [undefined, "Not authenticated"],
    ["Basic a-token", "Not authenticated"],
  ])(
    "rejects missing or malformed credentials before a route write",
    async (authorization, message) => {
      const write = vi.fn();
      const app = protectedApp(deps(), write);
      const response = await app.request(
        "/protected",
        authorization
          ? { method: "POST", headers: { authorization } }
          : { method: "POST" },
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "UNAUTHENTICATED", message },
        requestId: expect.any(String),
      });
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("maps expired or invalid tokens to a request-ID-bearing 401", async () => {
    const app = protectedApp(
      deps({
        verifyToken: vi.fn(async () => {
          throw new Error("expired");
        }),
      }),
    );
    const response = await app.request("/protected", {
      method: "POST",
      headers: { authorization: "Bearer expired" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED", message: "Invalid token" },
      requestId: expect.any(String),
    });
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("rejects bearer credentials when Clerk is not configured", async () => {
    const verifyToken = vi.fn(async () => ({ sub: "user_clerk" }));
    const app = protectedApp(
      deps({
        configuration: () => ({
          CLERK_SECRET_KEY: undefined,
          CLERK_JWT_KEY: undefined,
        }),
        verifyToken,
      }),
    );
    const response = await app.request("/protected", {
      method: "POST",
      headers: { authorization: "Bearer valid-but-unconfigured" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED", message: "Clerk not configured" },
    });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("rejects a verified token that has no subject", async () => {
    const app = protectedApp(deps({ verifyToken: vi.fn(async () => ({})) }));
    const response = await app.request("/protected", {
      method: "POST",
      headers: { authorization: "Bearer subjectless" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED", message: "Not authenticated" },
    });
  });

  it("does not cache failed authentication", async () => {
    const verifyToken = vi.fn(async () => {
      throw new Error("expired");
    });
    const app = protectedApp(deps({ verifyToken }));

    await app.request("/protected", {
      method: "POST",
      headers: { authorization: "Bearer expired" },
    });
    await app.request("/protected", {
      method: "POST",
      headers: { authorization: "Bearer expired" },
    });

    expect(verifyToken).toHaveBeenCalledTimes(2);
  });

  it("verifies every valid token before using its identity mapping cache", async () => {
    __resetAuthCachesForTests();
    const verifyToken = vi.fn(async () => ({ sub: "user_clerk" }));
    const repo = repository();
    const client = { users: { getUser: vi.fn(async () => identity) } };
    const app = protectedApp(
      deps({ verifyToken, repository: repo, clerkClient: client }),
    );

    const first = await app.request("/protected", {
      method: "POST",
      headers: { authorization: "Bearer first" },
    });
    const second = await app.request("/protected", {
      method: "POST",
      headers: { authorization: "Bearer second" },
    });

    expect(first.status).toBe(200);
    expect(await second.json()).toEqual({
      userId: "internal-user",
      clerkUserId: "user_clerk",
    });
    expect(verifyToken).toHaveBeenCalledTimes(2);
    expect(repo.findByAuthProviderId).toHaveBeenCalledTimes(1);
    expect(repo.findOrCreateByAuthProviderId).toHaveBeenCalledTimes(1);
    expect(client.users.getUser).toHaveBeenCalledTimes(1);
  });

  it("uses an existing database mapping without Clerk hydration", async () => {
    __resetAuthCachesForTests();
    const repo = repository();
    vi.mocked(repo.findByAuthProviderId).mockResolvedValueOnce({
      id: "existing-user",
    });
    const client = { users: { getUser: vi.fn(async () => identity) } };
    const app = protectedApp(deps({ repository: repo, clerkClient: client }));

    const response = await app.request("/protected", {
      method: "POST",
      headers: { authorization: "Bearer good" },
    });

    expect(await response.json()).toEqual({
      userId: "existing-user",
      clerkUserId: "user_clerk",
    });
    expect(client.users.getUser).not.toHaveBeenCalled();
  });

  it("uses the deterministic fallback email when Clerk has no email", async () => {
    __resetAuthCachesForTests();
    const repo = repository();
    const app = protectedApp(
      deps({
        repository: repo,
        clerkClient: {
          users: {
            getUser: vi.fn(async () => ({
              id: "user_clerk",
              emailAddresses: [],
              firstName: null,
            })),
          },
        },
      }),
    );

    const response = await app.request("/protected", {
      method: "POST",
      headers: { authorization: "Bearer good" },
    });

    expect(response.status).toBe(200);
    expect(repo.findOrCreateByAuthProviderId).toHaveBeenCalledWith({
      authProviderId: "user_clerk",
      email: "user_clerk@clerk.local",
      name: undefined,
    });
  });
});
