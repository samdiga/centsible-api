import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";

import { registerHealthRoutes } from "../modules/health/index.js";
import type { AppEnv } from "../platform/http/hono-env.js";
import type { ProtectedRouteRegistration } from "./create-http-app.js";

export type ModuleDependencies = {
  auth: MiddlewareHandler<AppEnv>;
  registerProtectedRoutes?: ProtectedRouteRegistration | undefined;
};

/** Registers every HTTP module through one app-level composition boundary. */
export function registerModules(
  app: OpenAPIHono<AppEnv>,
  dependencies: ModuleDependencies,
): void {
  registerHealthRoutes(app);
  dependencies.registerProtectedRoutes?.(app, dependencies.auth);
}
