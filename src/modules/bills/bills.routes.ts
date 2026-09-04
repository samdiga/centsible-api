/* eslint-disable @typescript-eslint/no-explicit-any -- Hono route declarations have distinct validated input types; these small adapters preserve one canonical handler implementation for the deprecated aliases. */
import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../platform/http/hono-env.js";
import { validateOutput } from "../../platform/http/output-validation.js";
import {
  BEARER_AUTH_SECURITY,
  OPENAPI_TAGS,
} from "../../platform/openapi/document.js";
import {
  BillActionResponseSchema,
  BillDeletedResponseSchema,
  BillDetailResponseSchema,
  BillIdSchema,
  BillListResponseSchema,
  BillMutateResponseSchema,
  BillOccurrenceListResponseSchema,
  BillQueuedResponseSchema,
  CreateBillBodySchema,
  ErrorEnvelopeSchema,
  MarkBillPaidBodySchema,
  UpdateBillBodySchema,
} from "./bills.schemas.js";
import type { BillsService } from "./bills.service.js";

const idParams = z.object({ id: BillIdSchema });
const occurrenceParams = z.object({ id: BillIdSchema, occId: BillIdSchema });
const monthQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
});
const operation = (
  method: "get" | "post" | "patch" | "delete",
  path: string,
  extra: Record<string, unknown> = {},
): any =>
  createRoute({
    method,
    path,
    tags: [OPENAPI_TAGS.bills],
    security: BEARER_AUTH_SECURITY,
    responses: {},
    ...extra,
  } as never);
const response = (schema: z.ZodType) => ({
  200: { description: "Success", content: { "application/json": { schema } } },
  404: {
    description: "Not found",
    content: { "application/json": { schema: ErrorEnvelopeSchema } },
  },
  409: {
    description: "Conflict",
    content: { "application/json": { schema: ErrorEnvelopeSchema } },
  },
});

const listRoute = operation("get", "/bills", {
  request: { query: monthQuery },
  responses: response(BillListResponseSchema),
});
const createBillRoute = operation("post", "/bills", {
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateBillBodySchema } },
    },
  },
  responses: {
    ...response(BillMutateResponseSchema),
    201: {
      description: "Created",
      content: { "application/json": { schema: BillMutateResponseSchema } },
    },
  },
});
const detectRoute = operation("post", "/bills/detect", {
  responses: response(BillQueuedResponseSchema),
});
const updateRoute = operation("patch", "/bills/{id}", {
  request: {
    params: idParams,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateBillBodySchema } },
    },
  },
  responses: response(BillMutateResponseSchema),
});
const deleteRoute = operation("delete", "/bills/{id}", {
  request: { params: idParams },
  responses: response(BillDeletedResponseSchema),
});
const detailRoute = operation("get", "/bills/{id}", {
  request: { params: idParams },
  responses: response(BillDetailResponseSchema),
});
const occurrencesRoute = operation("get", "/bills/{id}/occurrences", {
  request: { params: idParams },
  responses: response(BillOccurrenceListResponseSchema),
});
const markPaidRoute = operation(
  "post",
  "/bills/{id}/occurrences/{occId}/mark-paid",
  {
    request: {
      params: occurrenceParams,
      body: {
        required: true,
        content: { "application/json": { schema: MarkBillPaidBodySchema } },
      },
    },
    responses: response(BillActionResponseSchema),
  },
);
const skipRoute = operation("post", "/bills/{id}/occurrences/{occId}/skip", {
  request: { params: occurrenceParams },
  responses: response(BillActionResponseSchema),
});

function deprecated(route: any): any {
  return { ...route, deprecated: true };
}
function aliasHeader(c: { header: (name: string, value: string) => void }) {
  c.header("deprecation", "true");
  c.header("link", '</bills>; rel="successor-version"');
}

/** Registers canonical bills operations and their deprecated /recurring compatibility aliases. */
export function registerBillsRoutes(
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
  service: BillsService,
): void {
  const list = async (c: any, alias = false) => {
    if (alias) aliasHeader(c);
    return c.json(
      validateOutput(
        BillListResponseSchema,
        await service.listBills(c.get("userId"), c.req.valid("query").month),
      ),
      200,
    );
  };
  const create = async (c: any, alias = false) => {
    if (alias) aliasHeader(c);
    return c.json(
      validateOutput(BillMutateResponseSchema, {
        series: await service.createBill(c.get("userId"), c.req.valid("json")),
      }),
      201,
    );
  };
  const detect = async (c: any, alias = false) => {
    if (alias) aliasHeader(c);
    await service.queueDetection(c.get("userId"));
    return c.json({ queued: true as const }, 200);
  };
  const update = async (c: any, alias = false) => {
    if (alias) aliasHeader(c);
    return c.json(
      validateOutput(BillMutateResponseSchema, {
        series: await service.updateBill(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      }),
      200,
    );
  };
  const remove = async (c: any, alias = false) => {
    if (alias) aliasHeader(c);
    await service.deleteBill(c.get("userId"), c.req.valid("param").id);
    return c.json({ deleted: true as const }, 200);
  };
  const detail = async (c: any, alias = false) => {
    if (alias) aliasHeader(c);
    return c.json(
      validateOutput(BillDetailResponseSchema, {
        series: await service.getBill(c.get("userId"), c.req.valid("param").id),
      }),
      200,
    );
  };
  const occurrences = async (c: any, alias = false) => {
    if (alias) aliasHeader(c);
    return c.json(
      validateOutput(BillOccurrenceListResponseSchema, {
        occurrences: await service.listOccurrences(
          c.get("userId"),
          c.req.valid("param").id,
        ),
      }),
      200,
    );
  };
  const markPaid = async (c: any, alias = false) => {
    if (alias) aliasHeader(c);
    await service.markOccurrencePaid(
      c.get("userId"),
      c.req.valid("param").occId,
      c.req.valid("json"),
    );
    return c.json({ ok: true as const }, 200);
  };
  const skip = async (c: any, alias = false) => {
    if (alias) aliasHeader(c);
    await service.skipOccurrence(c.get("userId"), c.req.valid("param").occId);
    return c.json({ ok: true as const }, 200);
  };
  app.openapi({ ...listRoute, middleware: auth }, (c) => list(c));
  app.openapi({ ...createBillRoute, middleware: auth }, (c) => create(c));
  app.openapi({ ...detectRoute, middleware: auth }, (c) => detect(c));
  app.openapi({ ...updateRoute, middleware: auth }, (c) => update(c));
  app.openapi({ ...deleteRoute, middleware: auth }, (c) => remove(c));
  app.openapi({ ...detailRoute, middleware: auth }, (c) => detail(c));
  app.openapi({ ...occurrencesRoute, middleware: auth }, (c) => occurrences(c));
  app.openapi({ ...markPaidRoute, middleware: auth }, (c) => markPaid(c));
  app.openapi({ ...skipRoute, middleware: auth }, (c) => skip(c));
  app.openapi(
    {
      ...deprecated(
        operation("get", "/recurring", {
          request: { query: monthQuery },
          responses: response(BillListResponseSchema),
        }),
      ),
      middleware: auth,
    },
    (c) => list(c, true),
  );
  app.openapi(
    {
      ...deprecated(
        operation("post", "/recurring", {
          request: {
            body: {
              required: true,
              content: { "application/json": { schema: CreateBillBodySchema } },
            },
          },
          responses: response(BillMutateResponseSchema),
        }),
      ),
      middleware: auth,
    },
    (c) => create(c, true),
  );
  app.openapi(
    {
      ...deprecated(
        operation("post", "/recurring/detect", {
          responses: response(BillQueuedResponseSchema),
        }),
      ),
      middleware: auth,
    },
    (c) => detect(c, true),
  );
  app.openapi(
    {
      ...deprecated(
        operation("patch", "/recurring/{id}", {
          request: {
            params: idParams,
            body: {
              required: true,
              content: { "application/json": { schema: UpdateBillBodySchema } },
            },
          },
          responses: response(BillMutateResponseSchema),
        }),
      ),
      middleware: auth,
    },
    (c) => update(c, true),
  );
  app.openapi(
    {
      ...deprecated(
        operation("delete", "/recurring/{id}", {
          request: { params: idParams },
          responses: response(BillDeletedResponseSchema),
        }),
      ),
      middleware: auth,
    },
    (c) => remove(c, true),
  );
  app.openapi(
    {
      ...deprecated(
        operation("get", "/recurring/{id}", {
          request: { params: idParams },
          responses: response(BillDetailResponseSchema),
        }),
      ),
      middleware: auth,
    },
    (c) => detail(c, true),
  );
  app.openapi(
    {
      ...deprecated(
        operation("get", "/recurring/{id}/occurrences", {
          request: { params: idParams },
          responses: response(BillOccurrenceListResponseSchema),
        }),
      ),
      middleware: auth,
    },
    (c) => occurrences(c, true),
  );
  app.openapi(
    {
      ...deprecated(
        operation("post", "/recurring/{id}/occurrences/{occId}/mark-paid", {
          request: {
            params: occurrenceParams,
            body: {
              required: true,
              content: {
                "application/json": { schema: MarkBillPaidBodySchema },
              },
            },
          },
          responses: response(BillActionResponseSchema),
        }),
      ),
      middleware: auth,
    },
    (c) => markPaid(c, true),
  );
  app.openapi(
    {
      ...deprecated(
        operation("post", "/recurring/{id}/occurrences/{occId}/skip", {
          request: { params: occurrenceParams },
          responses: response(BillActionResponseSchema),
        }),
      ),
      middleware: auth,
    },
    (c) => skip(c, true),
  );
}
