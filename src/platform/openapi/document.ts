import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../http/hono-env.js";

export const BEARER_AUTH_SECURITY = [{ bearerAuth: [] }];

export const OPENAPI_TAGS = {
  accounts: "Accounts",
  bills: "Bills",
  budgets: "Budgets",
  categories: "Categories",
  dashboard: "Dashboard",
  forecast: "Forecast",
  health: "Health",
  notifications: "Notifications",
  pipeline: "Pipeline",
  plaid: "Plaid",
  reports: "Reports",
  rules: "Rules",
  transactions: "Transactions",
  userData: "User Data",
} as const;

const HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

export type OpenApiOperation = { method: string; path: string };

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object"
    ? (value as JsonObject)
    : undefined;
}

/** Registers components shared by every generated API operation. */
export function registerOpenApiComponents(app: OpenAPIHono<AppEnv>): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
}

/** Generates the current OpenAPI 3.1 document from the app's route registry. */
export function createOpenApiDocument(app: OpenAPIHono<AppEnv>): unknown {
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Centsible API",
      version: "0.1.0",
      description: "Private personal-finance and bill-management API.",
    },
  });
}

/** Returns deterministic method/path pairs for route-parity contract tests. */
export function listOpenApiOperations(document: unknown): OpenApiOperation[] {
  const paths = asObject(asObject(document)?.paths);
  if (!paths) return [];

  const operations: OpenApiOperation[] = [];
  for (const [path, pathItemValue] of Object.entries(paths)) {
    const pathItem = asObject(pathItemValue);
    if (!pathItem) continue;
    for (const method of Object.keys(pathItem)) {
      const normalizedMethod = method.toLowerCase();
      if (HTTP_METHODS.has(normalizedMethod)) {
        operations.push({ method: normalizedMethod, path });
      }
    }
  }
  return operations.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.method.localeCompare(right.method),
  );
}
