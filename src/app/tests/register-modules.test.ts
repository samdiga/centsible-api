import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../modules/rules/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../modules/rules/index.js")>();
  return {
    ...actual,
    createRuleService: vi.fn(actual.createRuleService),
  };
});

vi.mock("../../modules/user-data/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../modules/user-data/index.js")>();
  return {
    ...actual,
    createUserDataService: vi.fn(actual.createUserDataService),
  };
});

import { registerModules } from "../register-modules.js";
import type { AppEnv } from "../../platform/http/hono-env.js";
import { createRuleService } from "../../modules/rules/index.js";
import { createUserDataService } from "../../modules/user-data/index.js";

describe("registerModules", () => {
  it("mounts health and gives protected modules the configured auth middleware", async () => {
    const app = new OpenAPIHono<AppEnv>();
    const auth = async (): Promise<void> => undefined;

    registerModules(app, {
      auth,
      registerProtectedRoutes(mountedApp, mountedAuth) {
        mountedApp.get("/protected", (c) =>
          c.json({ hasConfiguredAuth: mountedAuth === auth }),
        );
      },
    });

    expect((await app.request("/health")).status).toBe(200);
    expect(await (await app.request("/protected")).json()).toEqual({
      hasConfiguredAuth: true,
    });
  });

  it("forwards the shared cache and optional dispatcher to the default Rules service", () => {
    const app = new OpenAPIHono<AppEnv>();
    const cache = {} as never;
    const dispatcher = {
      dispatchRetroactive: vi.fn(async () => ({ id: "job-id" })),
    };

    registerModules(app, {
      auth: async () => undefined,
      responseCache: cache,
      dispatcher,
    });

    expect(createRuleService).toHaveBeenLastCalledWith({ cache, dispatcher });
  });

  it("gives user-data the exact shared cache instance", () => {
    const app = new OpenAPIHono<AppEnv>();
    const cache = {} as never;

    registerModules(app, { auth: async () => undefined, responseCache: cache });

    expect(createUserDataService).toHaveBeenLastCalledWith({ cache });
  });
});
