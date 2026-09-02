import { OpenAPIHono } from "@hono/zod-openapi";
import { secureHeaders } from "hono/secure-headers";
import type { MiddlewareHandler } from "hono";
import { registerHealthRoutes } from "../modules/health/index.js";
import { clerkAuth } from "../platform/auth/clerk-auth.js";
import type { Env } from "../platform/config/env.js";
import { NotFoundError } from "../platform/errors/app-error.js";
import { handleError } from "../platform/errors/error-handler.js";
import { apiBodyLimit } from "../platform/http/body-limit.js";
import type { AppEnv } from "../platform/http/hono-env.js";
import { requestId } from "../platform/http/request-id.js";
import {
  requestLog,
  type RequestLogRoot,
} from "../platform/http/request-log.js";
import { registerDocs } from "../platform/openapi/docs.routes.js";

export type ProtectedRouteRegistration = (
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
) => void;

export type HttpAppDependencies = {
  env?: Env | undefined;
  logger?: RequestLogRoot | undefined;
  auth?: MiddlewareHandler<AppEnv> | undefined;
  registerProtectedRoutes?: ProtectedRouteRegistration | undefined;
};

/** Composes HTTP middleware and routes without starting process-owned resources. */
export function createHttpApp(
  dependencies: HttpAppDependencies = {},
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.use("*", requestId());
  app.use("*", requestLog(dependencies.logger));
  app.use("*", secureHeaders());
  app.use("*", apiBodyLimit());
  app.notFound((c) => handleError(new NotFoundError("route"), c));
  app.onError(handleError);

  registerHealthRoutes(app);
  const auth =
    dependencies.auth ??
    clerkAuth(
      dependencies.env ? { configuration: () => dependencies.env! } : undefined,
    );
  if (dependencies.registerProtectedRoutes) {
    dependencies.registerProtectedRoutes(app, auth);
  }
  if (dependencies.env) {
    registerDocs(app, dependencies.env, { auth });
  }

  return app;
}
