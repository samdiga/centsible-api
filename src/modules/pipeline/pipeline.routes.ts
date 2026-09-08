import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../platform/http/hono-env.js";
import { validateOutput } from "../../platform/http/output-validation.js";
import { NotFoundError } from "../../platform/errors/app-error.js";
import {
  BEARER_AUTH_SECURITY,
  OPENAPI_TAGS,
} from "../../platform/openapi/document.js";
import type { PipelineService } from "./pipeline.service.js";
import {
  PipelineRunDetailResponseSchema,
  PipelineRunsQuerySchema,
  PipelineRunsResponseSchema,
  SyncScheduleResponseSchema,
  TriggerPipelineResponseSchema,
  UpdateSyncScheduleBodySchema,
} from "./pipeline.schemas.js";

const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
const idParams = z.object({ id: z.string().uuid() });
const options = {
  tags: [OPENAPI_TAGS.pipeline],
  security: BEARER_AUTH_SECURITY,
};

const listRoute = createRoute({
  method: "get",
  path: "/pipeline/runs",
  ...options,
  request: { query: PipelineRunsQuerySchema },
  responses: {
    200: {
      description: "Pipeline runs",
      content: { "application/json": { schema: PipelineRunsResponseSchema } },
    },
  },
});
const detailRoute = createRoute({
  method: "get",
  path: "/pipeline/runs/{id}",
  ...options,
  request: { params: idParams },
  responses: {
    200: {
      description: "Pipeline run",
      content: {
        "application/json": { schema: PipelineRunDetailResponseSchema },
      },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});
const triggerRoute = createRoute({
  method: "post",
  path: "/pipeline/run",
  ...options,
  responses: {
    202: {
      description: "Pipeline started",
      content: {
        "application/json": { schema: TriggerPipelineResponseSchema },
      },
    },
    409: {
      description: "Already running",
      content: {
        "application/json": { schema: TriggerPipelineResponseSchema },
      },
    },
  },
});
const scheduleRoute = createRoute({
  method: "get",
  path: "/pipeline/schedule",
  ...options,
  responses: {
    200: {
      description: "Schedule",
      content: { "application/json": { schema: SyncScheduleResponseSchema } },
    },
  },
});
const updateScheduleRoute = createRoute({
  method: "put",
  path: "/pipeline/schedule",
  ...options,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: UpdateSyncScheduleBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Schedule",
      content: { "application/json": { schema: SyncScheduleResponseSchema } },
    },
    400: {
      description: "Invalid schedule",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

export function registerPipelineRoutes(
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
  service: PipelineService,
): void {
  app.openapi({ ...listRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(PipelineRunsResponseSchema, {
        runs: await service.listRuns(
          c.get("userId"),
          c.req.valid("query").limit,
        ),
      }),
      200,
    ),
  );
  app.openapi({ ...detailRoute, middleware: auth }, async (c) => {
    const run = await service.getRun(c.get("userId"), c.req.valid("param").id);
    if (!run) throw new NotFoundError("pipeline run");
    return c.json(
      validateOutput(PipelineRunDetailResponseSchema, { run }),
      200,
    );
  });
  app.openapi({ ...triggerRoute, middleware: auth }, async (c) => {
    const result = validateOutput(
      TriggerPipelineResponseSchema,
      await service.startPipelineRun({
        userId: c.get("userId"),
        trigger: "manual",
      }),
    );
    return c.json(result, result.deduped ? 409 : 202);
  });
  app.openapi({ ...scheduleRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(SyncScheduleResponseSchema, {
        schedule: await service.getSchedule(c.get("userId")),
      }),
      200,
    ),
  );
  app.openapi({ ...updateScheduleRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(SyncScheduleResponseSchema, {
        schedule: await service.upsertSchedule(
          c.get("userId"),
          c.req.valid("json"),
        ),
      }),
      200,
    ),
  );
}
