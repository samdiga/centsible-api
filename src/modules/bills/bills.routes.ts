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
  BillOccurrenceDtoSchema,
  BillQueuedResponseSchema,
  CreateBillBodySchema,
  ErrorEnvelopeSchema,
  MarkBillPaidBodySchema,
  UpdateBillBodySchema,
  UpdateBillOccurrenceBodySchema,
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
const errors = {
  404: {
    description: "Not found",
    content: { "application/json": { schema: ErrorEnvelopeSchema } },
  },
  409: {
    description: "Conflict",
    content: { "application/json": { schema: ErrorEnvelopeSchema } },
  },
};
const serviceUnavailable = {
  503: {
    description: "Required service unavailable",
    content: { "application/json": { schema: ErrorEnvelopeSchema } },
  },
};
const options = { tags: [OPENAPI_TAGS.bills], security: BEARER_AUTH_SECURITY };
const listResponses = {
  ...errors,
  200: {
    description: "Bills",
    content: { "application/json": { schema: BillListResponseSchema } },
  },
};
const mutateResponses = {
  ...errors,
  ...serviceUnavailable,
  200: {
    description: "Bill updated",
    content: { "application/json": { schema: BillMutateResponseSchema } },
  },
};
const createResponses = {
  ...errors,
  ...serviceUnavailable,
  201: {
    description: "Bill created",
    content: { "application/json": { schema: BillMutateResponseSchema } },
  },
};
const detailResponses = {
  ...errors,
  200: {
    description: "Bill",
    content: { "application/json": { schema: BillDetailResponseSchema } },
  },
};
const occurrencesResponses = {
  ...errors,
  200: {
    description: "Occurrence history",
    content: {
      "application/json": { schema: BillOccurrenceListResponseSchema },
    },
  },
};
const actionResponses = {
  ...errors,
  200: {
    description: "Occurrence updated",
    content: { "application/json": { schema: BillActionResponseSchema } },
  },
};
const detectResponses = {
  ...errors,
  ...serviceUnavailable,
  200: {
    description: "Detection queued",
    content: { "application/json": { schema: BillQueuedResponseSchema } },
  },
};
const deleteResponses = {
  ...errors,
  200: {
    description: "Bill deleted",
    content: { "application/json": { schema: BillDeletedResponseSchema } },
  },
};

const listRoute = createRoute({
  method: "get",
  path: "/bills",
  ...options,
  request: { query: monthQuery },
  responses: listResponses,
});
const createBillRoute = createRoute({
  method: "post",
  path: "/bills",
  ...options,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateBillBodySchema } },
    },
  },
  responses: createResponses,
});
const detectRoute = createRoute({
  method: "post",
  path: "/bills/detect",
  ...options,
  responses: detectResponses,
});
const updateRoute = createRoute({
  method: "patch",
  path: "/bills/{id}",
  ...options,
  request: {
    params: idParams,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateBillBodySchema } },
    },
  },
  responses: mutateResponses,
});
const deleteRoute = createRoute({
  method: "delete",
  path: "/bills/{id}",
  ...options,
  request: { params: idParams },
  responses: deleteResponses,
});
const detailRoute = createRoute({
  method: "get",
  path: "/bills/{id}",
  ...options,
  request: { params: idParams },
  responses: detailResponses,
});
const occurrencesRoute = createRoute({
  method: "get",
  path: "/bills/{id}/occurrences",
  ...options,
  request: { params: idParams },
  responses: occurrencesResponses,
});
const updateOccurrenceRoute = createRoute({
  method: "patch",
  path: "/bills/{id}/occurrences/{occId}",
  ...options,
  request: {
    params: occurrenceParams,
    body: {
      required: true,
      content: {
        "application/json": { schema: UpdateBillOccurrenceBodySchema },
      },
    },
  },
  responses: {
    ...errors,
    200: {
      description: "Occurrence updated",
      content: {
        "application/json": {
          schema: z.object({ occurrence: BillOccurrenceDtoSchema }),
        },
      },
    },
  },
});
const markPaidRoute = createRoute({
  method: "post",
  path: "/bills/{id}/occurrences/{occId}/mark-paid",
  ...options,
  request: {
    params: occurrenceParams,
    body: {
      required: true,
      content: { "application/json": { schema: MarkBillPaidBodySchema } },
    },
  },
  responses: actionResponses,
});
const skipRoute = createRoute({
  method: "post",
  path: "/bills/{id}/occurrences/{occId}/skip",
  ...options,
  request: { params: occurrenceParams },
  responses: actionResponses,
});
const recurringListRoute = createRoute({
  method: "get",
  path: "/recurring",
  deprecated: true,
  ...options,
  request: { query: monthQuery },
  responses: listResponses,
});
const recurringCreateRoute = createRoute({
  method: "post",
  path: "/recurring",
  deprecated: true,
  ...options,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateBillBodySchema } },
    },
  },
  responses: createResponses,
});
const recurringDetectRoute = createRoute({
  method: "post",
  path: "/recurring/detect",
  deprecated: true,
  ...options,
  responses: detectResponses,
});
const recurringUpdateRoute = createRoute({
  method: "patch",
  path: "/recurring/{id}",
  deprecated: true,
  ...options,
  request: {
    params: idParams,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateBillBodySchema } },
    },
  },
  responses: mutateResponses,
});
const recurringDeleteRoute = createRoute({
  method: "delete",
  path: "/recurring/{id}",
  deprecated: true,
  ...options,
  request: { params: idParams },
  responses: deleteResponses,
});
const recurringDetailRoute = createRoute({
  method: "get",
  path: "/recurring/{id}",
  deprecated: true,
  ...options,
  request: { params: idParams },
  responses: detailResponses,
});
const recurringOccurrencesRoute = createRoute({
  method: "get",
  path: "/recurring/{id}/occurrences",
  deprecated: true,
  ...options,
  request: { params: idParams },
  responses: occurrencesResponses,
});
const recurringMarkPaidRoute = createRoute({
  method: "post",
  path: "/recurring/{id}/occurrences/{occId}/mark-paid",
  deprecated: true,
  ...options,
  request: {
    params: occurrenceParams,
    body: {
      required: true,
      content: { "application/json": { schema: MarkBillPaidBodySchema } },
    },
  },
  responses: actionResponses,
});
const recurringSkipRoute = createRoute({
  method: "post",
  path: "/recurring/{id}/occurrences/{occId}/skip",
  deprecated: true,
  ...options,
  request: { params: occurrenceParams },
  responses: actionResponses,
});

function deprecated(c: {
  header: (name: string, value: string) => void;
}): void {
  c.header("deprecation", "true");
  c.header("link", '</bills>; rel="successor-version"');
}
export function registerBillsRoutes(
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
  service: BillsService,
): void {
  app.openapi({ ...listRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(
        BillListResponseSchema,
        await service.listBills(c.get("userId"), c.req.valid("query").month),
      ),
      200,
    ),
  );
  app.openapi({ ...createBillRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(BillMutateResponseSchema, {
        series: await service.createBill(c.get("userId"), c.req.valid("json")),
      }),
      201,
    ),
  );
  app.openapi({ ...detectRoute, middleware: auth }, async (c) => {
    await service.queueDetection(c.get("userId"));
    return c.json({ queued: true as const }, 200);
  });
  app.openapi({ ...updateRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(BillMutateResponseSchema, {
        series: await service.updateBill(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      }),
      200,
    ),
  );
  app.openapi({ ...deleteRoute, middleware: auth }, async (c) => {
    await service.deleteBill(c.get("userId"), c.req.valid("param").id);
    return c.json({ deleted: true as const }, 200);
  });
  app.openapi({ ...detailRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(BillDetailResponseSchema, {
        series: await service.getBill(c.get("userId"), c.req.valid("param").id),
      }),
      200,
    ),
  );
  app.openapi({ ...occurrencesRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(BillOccurrenceListResponseSchema, {
        occurrences: await service.listOccurrences(
          c.get("userId"),
          c.req.valid("param").id,
        ),
      }),
      200,
    ),
  );
  app.openapi({ ...updateOccurrenceRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(z.object({ occurrence: BillOccurrenceDtoSchema }), {
        occurrence: await service.updateOccurrence(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").occId,
          c.req.valid("json"),
        ),
      }),
      200,
    ),
  );
  app.openapi({ ...markPaidRoute, middleware: auth }, async (c) => {
    await service.markOccurrencePaid(
      c.get("userId"),
      c.req.valid("param").occId,
      c.req.valid("json"),
    );
    return c.json({ ok: true as const }, 200);
  });
  app.openapi({ ...skipRoute, middleware: auth }, async (c) => {
    await service.skipOccurrence(c.get("userId"), c.req.valid("param").occId);
    return c.json({ ok: true as const }, 200);
  });
  app.openapi({ ...recurringListRoute, middleware: auth }, async (c) => {
    deprecated(c);
    return c.json(
      validateOutput(
        BillListResponseSchema,
        await service.listBills(c.get("userId"), c.req.valid("query").month),
      ),
      200,
    );
  });
  app.openapi({ ...recurringCreateRoute, middleware: auth }, async (c) => {
    deprecated(c);
    return c.json(
      validateOutput(BillMutateResponseSchema, {
        series: await service.createBill(c.get("userId"), c.req.valid("json")),
      }),
      201,
    );
  });
  app.openapi({ ...recurringDetectRoute, middleware: auth }, async (c) => {
    deprecated(c);
    await service.queueDetection(c.get("userId"));
    return c.json({ queued: true as const }, 200);
  });
  app.openapi({ ...recurringUpdateRoute, middleware: auth }, async (c) => {
    deprecated(c);
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
  });
  app.openapi({ ...recurringDeleteRoute, middleware: auth }, async (c) => {
    deprecated(c);
    await service.deleteBill(c.get("userId"), c.req.valid("param").id);
    return c.json({ deleted: true as const }, 200);
  });
  app.openapi({ ...recurringDetailRoute, middleware: auth }, async (c) => {
    deprecated(c);
    return c.json(
      validateOutput(BillDetailResponseSchema, {
        series: await service.getBill(c.get("userId"), c.req.valid("param").id),
      }),
      200,
    );
  });
  app.openapi({ ...recurringOccurrencesRoute, middleware: auth }, async (c) => {
    deprecated(c);
    return c.json(
      validateOutput(BillOccurrenceListResponseSchema, {
        occurrences: await service.listOccurrences(
          c.get("userId"),
          c.req.valid("param").id,
        ),
      }),
      200,
    );
  });
  app.openapi({ ...recurringMarkPaidRoute, middleware: auth }, async (c) => {
    deprecated(c);
    await service.markOccurrencePaid(
      c.get("userId"),
      c.req.valid("param").occId,
      c.req.valid("json"),
    );
    return c.json({ ok: true as const }, 200);
  });
  app.openapi({ ...recurringSkipRoute, middleware: auth }, async (c) => {
    deprecated(c);
    await service.skipOccurrence(c.get("userId"), c.req.valid("param").occId);
    return c.json({ ok: true as const }, 200);
  });
}
