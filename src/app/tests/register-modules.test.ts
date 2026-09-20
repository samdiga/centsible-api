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

vi.mock("../../modules/bills/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../modules/bills/index.js")>();
  return {
    ...actual,
    createBillsService: vi.fn(actual.createBillsService),
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

vi.mock("../../modules/pipeline/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../modules/pipeline/index.js")>();
  return {
    ...actual,
    createPipelineService: vi.fn(actual.createPipelineService),
  };
});

vi.mock("../../modules/plaid/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../modules/plaid/index.js")>();
  return {
    ...actual,
    createPlaidService: vi.fn(actual.createPlaidService),
  };
});

import { registerModules } from "../register-modules.js";
import type { AppEnv } from "../../platform/http/hono-env.js";
import { createRuleService } from "../../modules/rules/index.js";
import { createBillsService } from "../../modules/bills/index.js";
import { createUserDataService } from "../../modules/user-data/index.js";
import { createPipelineService } from "../../modules/pipeline/index.js";
import { createPlaidService } from "../../modules/plaid/index.js";

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

  it("forwards separate bill and rule dispatchers to their default services", () => {
    const app = new OpenAPIHono<AppEnv>();
    const cache = {} as never;
    const billDispatcher = {
      detect: vi.fn(async () => undefined),
      materialize: vi.fn(async () => undefined),
    };
    const ruleDispatcher = {
      dispatchRetroactive: vi.fn(async () => ({ id: "job-id" })),
    };

    registerModules(app, {
      auth: async () => undefined,
      responseCache: cache,
      billDispatcher,
      ruleDispatcher,
    });

    expect(createBillsService).toHaveBeenLastCalledWith({
      cache,
      billDispatcher,
    });
    expect(createRuleService).toHaveBeenLastCalledWith({
      cache,
      dispatcher: ruleDispatcher,
    });
  });

  it("gives user-data the exact shared cache instance", () => {
    const app = new OpenAPIHono<AppEnv>();
    const cache = {} as never;

    registerModules(app, { auth: async () => undefined, responseCache: cache });

    expect(createUserDataService).toHaveBeenLastCalledWith({
      cache,
      revokePlaidItems: expect.any(Function),
    });
  });

  it("supplies the Plaid revocation adapter in the default composition", () => {
    const app = new OpenAPIHono<AppEnv>();

    registerModules(app, { auth: async () => undefined });

    expect(createBillsService).toHaveBeenLastCalledWith(undefined);
    expect(createUserDataService).toHaveBeenLastCalledWith({
      revokePlaidItems: expect.any(Function),
    });
  });

  it("forwards the Plaid revocation adapter to default user-data", () => {
    const app = new OpenAPIHono<AppEnv>();
    const revokePlaidItems = vi.fn(async () => undefined);

    registerModules(app, { auth: async () => undefined, revokePlaidItems });

    expect(createUserDataService).toHaveBeenLastCalledWith({
      revokePlaidItems,
    });
  });

  it("shares the manual worker wake through pipeline and Plaid composition", () => {
    const app = new OpenAPIHono<AppEnv>();
    const wakeWorker = vi.fn(async () => undefined);

    registerModules(app, { auth: async () => undefined, wakeWorker });

    expect(createPipelineService).toHaveBeenLastCalledWith({ wakeWorker });
    expect(createPlaidService).toHaveBeenLastCalledWith({
      startPipeline: expect.any(Function),
    });
  });
});
