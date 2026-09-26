import vm from "node:vm";
import { createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../../../app/create-http-app.js";
import type { Env } from "../../config/env.js";
import type { AppEnv } from "../../http/hono-env.js";
import {
  BEARER_AUTH_SECURITY,
  OPENAPI_TAGS,
  listOpenApiOperations,
} from "../document.js";
import { createDocsBootstrap } from "../docs-page.js";

const clerkFrontendHost = "bright-fox.clerk.accounts.dev";
const publishableKey = `pk_test_${Buffer.from(`${clerkFrontendHost}$`).toString("base64url")}`;

function testEnv(enabled: boolean): Env {
  return {
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    PORT: 4000,
    DATABASE_URL: "postgresql://test:test@example.test/centsible",
    DATABASE_ENVIRONMENT: "sandbox",
    ALLOW_SHARED_SANDBOX_TEST_DATABASE: false,
    TEST_SCHEMA_PREFIX: "centsible_test_",
    CLERK_SECRET_KEY: "server-secret-must-not-reach-html",
    CLERK_PUBLISHABLE_KEY: publishableKey,
    PLAID_ENV: "sandbox",
    PLAID_ACTIVE_ENV: "sandbox",
    API_DOCS_ENABLED: enabled,
    CACHE_ENABLED: false,
    CACHE_TTL_MS: 300_000,
    CACHE_MAX_ENTRIES: 1_000,
    CACHE_MAX_BYTES: 67_108_864,
    CACHE_MAX_ENTRY_BYTES: 2_097_152,
    WORKER_ID: "test-worker",
    WORKER_SWEEP_INTERVAL_MINUTES: 360,
    WORKER_WAKE_URL: "http://127.0.0.1:4011/wake",
    APNS_ENV: "sandbox",
    LOG_LEVEL: "info",
  };
}

const allowAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("userId", "user-1");
  c.set("clerkUserId", "clerk-1");
  await next();
};

describe("OpenAPI docs routes", () => {
  it("hides both docs routes behind the feature flag", async () => {
    const app = createHttpApp({ env: testEnv(false) });

    for (const path of ["/docs", "/openapi.json"]) {
      const response = await app.request(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: "NOT_FOUND" },
        requestId: expect.any(String),
      });
    }
  });

  it("serves the sign-in shell but protects the document with Clerk", async () => {
    const app = createHttpApp({ env: testEnv(true) });

    const page = await app.request("/docs");
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain(
      `https://${clerkFrontendHost}`,
    );
    expect(page.headers.get("content-security-policy")).not.toContain("*");
    expect(page.headers.get("content-security-policy")).not.toContain("data:");
    expect(html).toContain(publishableKey);
    expect(html).toContain("swagger-ui-dist@5.32.11/");
    expect(html).not.toContain("swagger-ui-dist@5/");
    expect(html).not.toContain("server-secret-must-not-reach-html");
    expect(html).not.toMatch(/<input[^>]+type=["']password/i);
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain("sessionStorage");

    const document = await app.request("/openapi.json");
    expect(document.status).toBe(401);
    expect(await document.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED" },
      requestId: expect.any(String),
    });
  });

  it("generates OpenAPI 3.1 with reusable bearer security and operation tags", async () => {
    const privateRoute = createRoute({
      method: "get",
      path: "/private-summary",
      tags: [OPENAPI_TAGS.reports],
      security: BEARER_AUTH_SECURITY,
      responses: {
        200: {
          description: "Private summary",
          content: {
            "application/json": { schema: z.object({ ok: z.boolean() }) },
          },
        },
      },
    });
    const app = createHttpApp({
      env: testEnv(true),
      auth: allowAuth,
      registerProtectedRoutes: (target, auth) => {
        target.use("/private-summary", auth);
        target.openapi(privateRoute, (c) => c.json({ ok: true }, 200));
      },
    });

    const response = await app.request("/openapi.json");
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      openapi: string;
      components: {
        securitySchemes: { bearerAuth: Record<string, unknown> };
      };
      paths: Record<
        string,
        { get: { tags: string[]; security: Array<Record<string, string[]>> } }
      >;
    };
    expect(document.openapi).toBe("3.1.0");
    expect(document.components.securitySchemes.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });
    expect(document.paths["/private-summary"]?.get).toMatchObject({
      tags: ["Reports"],
      security: [{ bearerAuth: [] }],
    });
    expect(listOpenApiOperations(document)).toEqual([
      { method: "get", path: "/accounts" },
      { method: "post", path: "/accounts" },
      { method: "delete", path: "/accounts/{accountId}" },
      { method: "patch", path: "/accounts/{accountId}" },
      { method: "post", path: "/accounts/{accountId}/refresh-balance" },
      { method: "get", path: "/bills" },
      { method: "post", path: "/bills" },
      { method: "delete", path: "/bills/{id}" },
      { method: "get", path: "/bills/{id}" },
      { method: "patch", path: "/bills/{id}" },
      { method: "get", path: "/bills/{id}/occurrences" },
      { method: "patch", path: "/bills/{id}/occurrences/{occId}" },
      {
        method: "post",
        path: "/bills/{id}/occurrences/{occId}/mark-paid",
      },
      { method: "post", path: "/bills/{id}/occurrences/{occId}/skip" },
      { method: "post", path: "/bills/detect" },
      { method: "post", path: "/budgets" },
      { method: "put", path: "/budgets/{id}/items" },
      { method: "get", path: "/budgets/{id}/progress" },
      { method: "get", path: "/budgets/active" },
      { method: "delete", path: "/budgets/active/items/{categoryId}" },
      { method: "patch", path: "/budgets/active/items/{categoryId}" },
      { method: "get", path: "/budgets/suggestions" },
      { method: "get", path: "/categories" },
      { method: "post", path: "/categories" },
      { method: "delete", path: "/categories/{id}" },
      { method: "patch", path: "/categories/{id}" },
      { method: "get", path: "/dashboard/net-worth/history" },
      { method: "get", path: "/dashboard/summary" },
      { method: "get", path: "/forecast" },
      { method: "get", path: "/forecast/accuracy" },
      { method: "get", path: "/health" },
      { method: "get", path: "/notifications/preferences" },
      { method: "patch", path: "/notifications/preferences" },
      { method: "delete", path: "/notifications/push-token" },
      { method: "put", path: "/notifications/push-token" },
      { method: "post", path: "/pipeline/run" },
      { method: "get", path: "/pipeline/runs" },
      { method: "get", path: "/pipeline/runs/{id}" },
      { method: "get", path: "/pipeline/schedule" },
      { method: "put", path: "/pipeline/schedule" },
      { method: "post", path: "/plaid/exchange" },
      { method: "get", path: "/plaid/items" },
      { method: "delete", path: "/plaid/items/{itemId}" },
      { method: "post", path: "/plaid/items/{itemId}/refresh" },
      {
        method: "post",
        path: "/plaid/items/{itemId}/update-link-token",
      },
      { method: "post", path: "/plaid/link-token" },
      { method: "get", path: "/private-summary" },
      { method: "get", path: "/recurring" },
      { method: "post", path: "/recurring" },
      { method: "delete", path: "/recurring/{id}" },
      { method: "get", path: "/recurring/{id}" },
      { method: "patch", path: "/recurring/{id}" },
      { method: "get", path: "/recurring/{id}/occurrences" },
      {
        method: "post",
        path: "/recurring/{id}/occurrences/{occId}/mark-paid",
      },
      {
        method: "post",
        path: "/recurring/{id}/occurrences/{occId}/skip",
      },
      { method: "post", path: "/recurring/detect" },
      { method: "get", path: "/reports/summary" },
      { method: "get", path: "/rules" },
      { method: "post", path: "/rules" },
      { method: "delete", path: "/rules/{id}" },
      { method: "patch", path: "/rules/{id}" },
      { method: "post", path: "/rules/{id}/apply" },
      { method: "get", path: "/rules/preview" },
      { method: "get", path: "/tags" },
      { method: "post", path: "/tags" },
      { method: "delete", path: "/tags/{id}" },
      { method: "patch", path: "/tags/{id}" },
      { method: "get", path: "/transactions" },
      { method: "post", path: "/transactions" },
      { method: "delete", path: "/transactions/{id}" },
      { method: "get", path: "/transactions/{id}" },
      { method: "patch", path: "/transactions/{id}" },
      { method: "get", path: "/transactions/{id}/similar" },
      { method: "post", path: "/transactions/bulk" },
      { method: "get", path: "/transactions/export" },
      { method: "delete", path: "/user/data" },
      { method: "get", path: "/user/export" },
      { method: "post", path: "/user/import" },
    ]);
  });
});

type FakeElement = {
  hidden: boolean;
  replaceChildren: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
};

type SwaggerRequest = {
  headers: Record<string, string>;
};

type SwaggerOptions = {
  requestInterceptor: (request: SwaggerRequest) => Promise<SwaggerRequest>;
};

type FakeSession = {
  getToken: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
};

type FakeClerk = {
  isSignedIn: boolean;
  session: FakeSession | null;
  load: ReturnType<typeof vi.fn>;
  mountSignIn: ReturnType<typeof vi.fn>;
  unmountSignIn: ReturnType<typeof vi.fn>;
  addListener: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
};

type DocsTestWindow = {
  Clerk: new (key: string) => FakeClerk;
  SwaggerUIBundle: (options: SwaggerOptions) => unknown;
  document: { getElementById: (id: string) => FakeElement | undefined };
  window?: DocsTestWindow;
  __centsibleDocsReady?: Promise<void>;
};

function fakeElement(): FakeElement {
  return {
    hidden: false,
    replaceChildren: vi.fn(),
    addEventListener: vi.fn(),
  };
}

type BrowserHarness = ReturnType<typeof createBrowserHarness>;

function createBrowserHarness(signedIn: boolean, tokens: Array<string | null>) {
  const events: string[] = [];
  const elements = new Map([
    ["clerk-sign-in", fakeElement()],
    ["docs-console", fakeElement()],
    ["swagger-ui", fakeElement()],
    ["docs-sign-out", fakeElement()],
  ]);
  let listener: (() => Promise<void>) | undefined;
  let swaggerOptions: SwaggerOptions | undefined;
  const logout = vi.fn(() => events.push("swagger:logout"));
  const getToken = vi.fn(async () => tokens.shift() ?? null);
  const clerk: FakeClerk = {
    isSignedIn: signedIn,
    session: signedIn ? { getToken } : null,
    load: vi.fn(async () => events.push("clerk:load")),
    mountSignIn: vi.fn(() => events.push("clerk:mount-sign-in")),
    unmountSignIn: vi.fn(() => events.push("clerk:unmount-sign-in")),
    addListener: vi.fn((next: () => Promise<void>) => {
      listener = next;
    }),
    signOut: vi.fn(async () => {
      events.push("clerk:sign-out");
      clerk.isSignedIn = false;
      clerk.session = null;
    }),
  };
  const ClerkConstructor = function (key: string): FakeClerk {
    events.push(`clerk:new:${key}`);
    return clerk;
  } as unknown as new (key: string) => FakeClerk;
  const swagger = vi.fn((options: SwaggerOptions) => {
    swaggerOptions = options;
    events.push("swagger:create");
    return { authActions: { logout } };
  });
  const document = {
    getElementById: vi.fn((id: string) => elements.get(id)),
  };
  const window: DocsTestWindow = {
    Clerk: ClerkConstructor,
    SwaggerUIBundle: swagger,
    document,
  };
  window.window = window;
  const context = vm.createContext({ window, document, console });

  return {
    clerk,
    context,
    elements,
    events,
    get listener() {
      return listener;
    },
    logout,
    swagger,
    get swaggerOptions() {
      return swaggerOptions;
    },
    window,
  };
}

async function runBootstrap(harness: BrowserHarness): Promise<void> {
  vm.runInContext(createDocsBootstrap(publishableKey), harness.context);
  await harness.window.__centsibleDocsReady;
}

describe("docs browser bootstrap", () => {
  it("mounts Clerk SignIn and delays Swagger while signed out", async () => {
    const harness = createBrowserHarness(false, []);

    await runBootstrap(harness);
    await harness.listener?.();

    expect(harness.clerk.mountSignIn).toHaveBeenCalledOnce();
    expect(harness.swagger).not.toHaveBeenCalled();
    expect(harness.elements.get("docs-console")?.hidden).toBe(true);
  });

  it("refreshes the in-memory bearer token for every Swagger request", async () => {
    const harness = createBrowserHarness(true, [
      "token-one",
      "token-two",
      null,
    ]);
    await runBootstrap(harness);
    const interceptor = harness.swaggerOptions?.requestInterceptor;
    expect(interceptor).toBeTypeOf("function");
    if (!interceptor) throw new Error("Swagger interceptor was not installed");

    const first = await interceptor({ headers: {} });
    const second = await interceptor({ headers: {} });
    const signedOut = await interceptor({
      headers: { Authorization: "Bearer stale" },
    });

    expect(first.headers.Authorization).toBe("Bearer token-one");
    expect(second.headers.Authorization).toBe("Bearer token-two");
    expect(signedOut.headers.Authorization).toBeUndefined();
    expect(harness.clerk.session?.getToken).toHaveBeenCalledTimes(3);
  });

  it("transitions after sign-in and clears Swagger before Clerk sign-out", async () => {
    const harness = createBrowserHarness(false, ["fresh-token"]);
    await runBootstrap(harness);
    harness.clerk.isSignedIn = true;
    harness.clerk.session = {
      getToken:
        harness.clerk.session?.getToken ?? vi.fn(async () => "fresh-token"),
    };

    await harness.listener?.();
    expect(harness.swagger).toHaveBeenCalledOnce();
    const signOutHandler = harness.elements.get("docs-sign-out")
      ?.addEventListener.mock.calls[0]?.[1] as
      (() => Promise<void>) | undefined;
    await signOutHandler?.();

    expect(harness.events.indexOf("swagger:logout")).toBeGreaterThan(-1);
    expect(harness.events.indexOf("swagger:logout")).toBeLessThan(
      harness.events.indexOf("clerk:sign-out"),
    );
    expect(
      harness.elements.get("swagger-ui")?.replaceChildren,
    ).toHaveBeenCalled();
    expect(harness.clerk.mountSignIn).toHaveBeenCalledTimes(2);
  });
});
