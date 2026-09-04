import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import {
  createCategoryService,
  registerCategoriesRoutes,
  type CategoryService,
} from "../modules/categories/index.js";
import type { ResponseCache } from "../platform/cache/response-cache.js";
import { registerHealthRoutes } from "../modules/health/index.js";
import type { AppEnv } from "../platform/http/hono-env.js";
import type { ProtectedRouteRegistration } from "./create-http-app.js";
import {
  createAccountService,
  registerAccountsRoutes,
  type AccountService,
} from "../modules/accounts/index.js";
import {
  createTransactionService,
  registerTransactionsRoutes,
  type TransactionService,
} from "../modules/transactions/index.js";

export type ModuleDependencies = {
  auth: MiddlewareHandler<AppEnv>;
  categoriesService?: CategoryService | undefined;
  accountsService?: AccountService | undefined;
  transactionsService?: TransactionService | undefined;
  responseCache?: ResponseCache | undefined;
  registerProtectedRoutes?: ProtectedRouteRegistration | undefined;
};

/** Registers every HTTP module through one app-level composition boundary. */
export function registerModules(
  app: OpenAPIHono<AppEnv>,
  dependencies: ModuleDependencies,
): void {
  registerHealthRoutes(app);
  const categoriesService =
    dependencies.categoriesService ??
    createCategoryService(
      dependencies.responseCache
        ? { cache: dependencies.responseCache }
        : undefined,
    );
  registerCategoriesRoutes(app, dependencies.auth, categoriesService);
  const accountsService =
    dependencies.accountsService ??
    createAccountService(
      dependencies.responseCache
        ? { cache: dependencies.responseCache }
        : undefined,
    );
  registerAccountsRoutes(app, dependencies.auth, accountsService);
  const transactionsService =
    dependencies.transactionsService ??
    createTransactionService(
      dependencies.responseCache
        ? { cache: dependencies.responseCache }
        : undefined,
    );
  registerTransactionsRoutes(app, dependencies.auth, transactionsService);
  dependencies.registerProtectedRoutes?.(app, dependencies.auth);
}
