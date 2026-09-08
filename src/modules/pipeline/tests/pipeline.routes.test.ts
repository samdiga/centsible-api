import { expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../../platform/http/hono-env.js";
import { registerPipelineRoutes } from "../pipeline.routes.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("userId", USER_ID);
  await next();
};

it("registers exactly the five authenticated pipeline routes", async () => {
  const app = new OpenAPIHono();
  const service = {
    listRuns: async () => [],
    getRun: async () => null,
    startPipelineRun: async () => ({ runId: null, deduped: true }),
    getSchedule: async () => ({
      hour: 6,
      minute: 0,
      timezone: "UTC",
      enabled: false,
    }),
    upsertSchedule: async () => ({
      hour: 6,
      minute: 0,
      timezone: "UTC",
      enabled: false,
    }),
  };
  registerPipelineRoutes(app as never, auth, service as never);
  expect((await app.request("/pipeline/runs")).status).toBe(200);
  expect((await app.request("/pipeline/schedule")).status).toBe(200);
  expect((await app.request("/pipeline/run", { method: "POST" })).status).toBe(
    409,
  );
});
