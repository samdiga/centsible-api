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
import type { TransactionService } from "../modules/transactions/index.js";
import type { DashboardService } from "../modules/dashboard/index.js";
import type { ReportsService } from "../modules/reports/index.js";
import type {
  BillJobDispatcher,
  BillsService,
} from "../modules/bills/index.js";
import type { BudgetsService } from "../modules/budgets/index.js";
import type { ForecastService } from "../modules/forecast/index.js";
import type { RuleJobDispatcher, RuleService } from "../modules/rules/index.js";
import type { NotificationPreferencesService } from "../modules/notifications/index.js";
import type {
  UserDataService,
  UserDataServiceDependencies,
} from "../modules/user-data/index.js";
import type { PipelineService } from "../modules/pipeline/index.js";
import type { PlaidService } from "../modules/plaid/index.js";
import type { TagService } from "../modules/tags/index.js";
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
  transactionsService?: TransactionService | undefined;
  dashboardService?: DashboardService | undefined;
  reportsService?: ReportsService | undefined;
  billsService?: BillsService | undefined;
  budgetsService?: BudgetsService | undefined;
  forecastService?: ForecastService | undefined;
  rulesService?: RuleService | undefined;
  tagsService?: TagService | undefined;
  notificationsService?: NotificationPreferencesService | undefined;
  userDataService?: UserDataService | undefined;
  pipelineService?: PipelineService | undefined;
  plaidService?: PlaidService | undefined;
  billDispatcher?: BillJobDispatcher | undefined;
  ruleDispatcher?: RuleJobDispatcher | undefined;
  revokePlaidItems?: UserDataServiceDependencies["revokePlaidItems"];
  responseCache?: ResponseCache | undefined;
  wakeWorker?: (() => Promise<void>) | undefined;
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
    transactionsService: dependencies.transactionsService,
    dashboardService: dependencies.dashboardService,
    reportsService: dependencies.reportsService,
    billsService: dependencies.billsService,
    budgetsService: dependencies.budgetsService,
    forecastService: dependencies.forecastService,
    rulesService: dependencies.rulesService,
    tagsService: dependencies.tagsService,
    notificationsService: dependencies.notificationsService,
    userDataService: dependencies.userDataService,
    pipelineService: dependencies.pipelineService,
    plaidService: dependencies.plaidService,
    billDispatcher: dependencies.billDispatcher,
    ruleDispatcher: dependencies.ruleDispatcher,
    revokePlaidItems: dependencies.revokePlaidItems,
    responseCache,
    wakeWorker: dependencies.wakeWorker,
    registerProtectedRoutes: dependencies.registerProtectedRoutes,
  });
  if (dependencies.env) {
    registerDocs(app, dependencies.env, { auth });
  }

  return app;
}
