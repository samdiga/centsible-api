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
  ErrorEnvelopeSchema,
  SimilarTransactionsResponseSchema,
  TransactionBulkPatchResponseSchema,
  TransactionBulkPatchSchema,
  TransactionDetailResponseSchema,
  TransactionIdSchema,
  TransactionListQuerySchema,
  TransactionListResponseSchema,
  TransactionPatchSchema,
} from "./transactions.schemas.js";
import type { TransactionService } from "./transactions.service.js";
import { TransactionBadCursorError } from "./transactions.service.js";
import { BadCursorError } from "../../shared/pagination/cursor.js";

const params = z.object({ id: TransactionIdSchema });
const listRoute = createRoute({
  method: "get",
  path: "/transactions",
  tags: [OPENAPI_TAGS.transactions],
  security: BEARER_AUTH_SECURITY,
  request: { query: TransactionListQuerySchema },
  responses: {
    200: {
      description: "Transaction page",
      content: {
        "application/json": { schema: TransactionListResponseSchema },
      },
    },
    400: {
      description: "Bad cursor",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});
const exportRoute = createRoute({
  method: "get",
  path: "/transactions/export",
  tags: [OPENAPI_TAGS.transactions],
  security: BEARER_AUTH_SECURITY,
  request: {
    query: TransactionListQuerySchema.omit({ cursor: true, limit: true }),
  },
  responses: {
    200: {
      description: "Transactions CSV",
      content: { "text/csv": { schema: z.string() } },
    },
  },
});
const detailRoute = createRoute({
  method: "get",
  path: "/transactions/{id}",
  tags: [OPENAPI_TAGS.transactions],
  security: BEARER_AUTH_SECURITY,
  request: { params },
  responses: {
    200: {
      description: "Transaction",
      content: {
        "application/json": { schema: TransactionDetailResponseSchema },
      },
    },
    404: {
      description: "Transaction not found",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});
const similarRoute = createRoute({
  method: "get",
  path: "/transactions/{id}/similar",
  tags: [OPENAPI_TAGS.transactions],
  security: BEARER_AUTH_SECURITY,
  request: { params },
  responses: {
    200: {
      description:
        "Other transactions from the same merchant whose category differs from this one's, newest first",
      content: {
        "application/json": { schema: SimilarTransactionsResponseSchema },
      },
    },
    404: {
      description: "Transaction not found",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});
const bulkRoute = createRoute({
  method: "post",
  path: "/transactions/bulk",
  tags: [OPENAPI_TAGS.transactions],
  security: BEARER_AUTH_SECURITY,
  request: {
    body: {
      content: { "application/json": { schema: TransactionBulkPatchSchema } },
    },
  },
  responses: {
    200: {
      description: "Updated count",
      content: {
        "application/json": { schema: TransactionBulkPatchResponseSchema },
      },
    },
  },
});
const patchRoute = createRoute({
  method: "patch",
  path: "/transactions/{id}",
  tags: [OPENAPI_TAGS.transactions],
  security: BEARER_AUTH_SECURITY,
  request: {
    params,
    body: {
      content: { "application/json": { schema: TransactionPatchSchema } },
    },
  },
  responses: {
    200: {
      description: "Updated transaction",
      content: {
        "application/json": { schema: TransactionDetailResponseSchema },
      },
    },
    400: {
      description: "Empty patch",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    404: {
      description: "Transaction not found",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
  },
});

export function registerTransactionsRoutes(
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
  service: TransactionService,
): void {
  app.openapi({ ...listRoute, middleware: auth }, async (c) => {
    try {
      return c.json(
        validateOutput(
          TransactionListResponseSchema,
          await service.listTransactions(c.get("userId"), c.req.valid("query")),
        ),
        200,
      );
    } catch (error) {
      if (error instanceof BadCursorError)
        throw new TransactionBadCursorError(error.message);
      throw error;
    }
  });
  app.openapi({ ...exportRoute, middleware: auth }, async (c) => {
    const result = await service.exportTransactionsCsv(
      c.get("userId"),
      c.req.valid("query"),
    );
    c.header("Content-Type", "text/csv");
    c.header("Content-Disposition", 'attachment; filename="transactions.csv"');
    if (result.truncated) c.header("X-Export-Truncated", "true");
    return c.body(result.csv);
  });
  app.openapi({ ...detailRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(TransactionDetailResponseSchema, {
        transaction: await service.getTransaction(
          c.get("userId"),
          c.req.valid("param").id,
        ),
      }),
      200,
    ),
  );
  app.openapi({ ...similarRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(SimilarTransactionsResponseSchema, {
        transactions: await service.listSimilarTransactions(
          c.get("userId"),
          c.req.valid("param").id,
        ),
      }),
      200,
    ),
  );
  app.openapi({ ...bulkRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(TransactionBulkPatchResponseSchema, {
        updated: await service.bulkPatchTransactions(
          c.get("userId"),
          c.req.valid("json"),
        ),
      }),
      200,
    ),
  );
  app.openapi({ ...patchRoute, middleware: auth }, async (c) =>
    c.json(
      validateOutput(TransactionDetailResponseSchema, {
        transaction: await service.patchTransaction(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      }),
      200,
    ),
  );
}
