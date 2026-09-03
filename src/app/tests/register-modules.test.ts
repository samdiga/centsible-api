import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { registerModules } from "../register-modules.js";
import type { AppEnv } from "../../platform/http/hono-env.js";

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
});
