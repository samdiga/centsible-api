import { randomBytes } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { clerkAuth } from "../auth/clerk-auth.js";
import type { Env } from "../config/env.js";
import type { AppEnv } from "../http/hono-env.js";
import {
  createOpenApiDocument,
  registerOpenApiComponents,
} from "./document.js";
import { createDocsPage } from "./docs-page.js";

export type DocsRouteDependencies = {
  auth?: MiddlewareHandler<AppEnv> | undefined;
  nonce?: (() => string) | undefined;
};

/** Registers the optional Clerk sign-in shell and protected OpenAPI document. */
export function registerDocs(
  app: OpenAPIHono<AppEnv>,
  configuration: Env,
  dependencies: DocsRouteDependencies = {},
): void {
  if (!configuration.API_DOCS_ENABLED) return;
  if (!configuration.CLERK_PUBLISHABLE_KEY) {
    throw new Error(
      "CLERK_PUBLISHABLE_KEY is required when API docs are enabled",
    );
  }

  registerOpenApiComponents(app);
  const auth =
    dependencies.auth ??
    clerkAuth({
      configuration: () => configuration,
    });

  app.get("/docs", (c) => {
    const nonce = (
      dependencies.nonce ?? (() => randomBytes(18).toString("base64url"))
    )();
    const page = createDocsPage(configuration.CLERK_PUBLISHABLE_KEY!, nonce);
    return c.html(page.html, 200, {
      "content-security-policy": page.contentSecurityPolicy,
      "cache-control": "no-store",
    });
  });
  app.get("/openapi.json", auth, () => {
    return new Response(JSON.stringify(createOpenApiDocument(app)), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "cache-control": "no-store",
      },
    });
  });
}
