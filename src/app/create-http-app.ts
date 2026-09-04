import { OpenAPIHono } from "@hono/zod-openapi";
import { secureHeaders } from "hono/secure-headers";
import type { MiddlewareHandler } from "hono";
import { clerkAuth } from "../platform/auth/clerk-auth.js";
import type { Env } from "../platform/config/env.js";
import { NotFoundError } from "../platform/errors/app-error.js";
import { handleError } from "../platform/errors/error-handler.js";
import { apiBodyLimit } from "../platform/http/body-limit.js";
import type { AppEnv } from "../platform/http/hono-env.js";
import type { CategoryService } from "../modules/categories/index.js";
import type { AccountService } from "../modules/accounts/index.js";
import {
  createResponseCache,
  type ResponseCache,
} from "../platform/cache/response-cache.js";
import { requestId } from "../platform/http/request-id.js";
import {
  requestLog,
  type RequestLogRoot,
} from "../platform/http/request-log.js";
import { registerDocs } from "../platform/openapi/docs.routes.js";
import { registerModules } from "./register-modules.js";

export type ProtectedRouteRegistration = (
  app: OpenAPIHono<AppEnv>,
  auth: MiddlewareHandler<AppEnv>,
) => void;

export type HttpAppDependencies = {
  env?: Env | undefined;
  logger?: RequestLogRoot | undefined;
  auth?: MiddlewareHandler<AppEnv> | undefined;
  categoriesService?: CategoryService | undefined;
  accountsService?: AccountService | undefined;
  responseCache?: ResponseCache | undefined;
  registerProtectedRoutes?: ProtectedRouteRegistration | undefined;
};

/** Composes HTTP middleware and routes without starting process-owned resources. */
export function createHttpApp(
  dependencies: HttpAppDependencies = {},
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });
  const responseCache = dependencies.responseCache ?? createResponseCache();

  app.use("*", requestId());
  app.use("*", requestLog(dependencies.logger));
  app.use("*", secureHeaders());
  app.use("*", apiBodyLimit());
  app.notFound((c) => handleError(new NotFoundError("route"), c));
  app.onError(handleError);

  const auth =
    dependencies.auth ??
    clerkAuth(
      dependencies.env ? { configuration: () => dependencies.env! } : undefined,
    );
  registerModules(app, {
    auth,
    categoriesService: dependencies.categoriesService,
    accountsService: dependencies.accountsService,
    responseCache,
    registerProtectedRoutes: dependencies.registerProtectedRoutes,
  });
  if (dependencies.env) {
    registerDocs(app, dependencies.env, { auth });
  }

  return app;
}
