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
import {
  createDashboardService,
  registerDashboardRoutes,
  type DashboardService,
} from "../modules/dashboard/index.js";
import {
  createReportsService,
  registerReportsRoutes,
  type ReportsService,
} from "../modules/reports/index.js";
import {
  createBillsService,
  registerBillsRoutes,
  type BillJobDispatcher,
  type BillsService,
} from "../modules/bills/index.js";
import {
  createBudgetsService,
  registerBudgetsRoutes,
  type BudgetsService,
} from "../modules/budgets/index.js";
import {
  createForecastService,
  registerForecastRoutes,
  type ForecastService,
} from "../modules/forecast/index.js";
import {
  createRuleService,
  registerRulesRoutes,
  type RuleJobDispatcher,
  type RuleService,
} from "../modules/rules/index.js";
import {
  createNotificationsService,
  registerNotificationsRoutes,
  type NotificationPreferencesService,
} from "../modules/notifications/index.js";
import {
  createUserDataService,
  registerUserDataRoutes,
  type UserDataService,
  type UserDataServiceDependencies,
} from "../modules/user-data/index.js";

export type ModuleDependencies = {
  auth: MiddlewareHandler<AppEnv>;
  categoriesService?: CategoryService | undefined;
  accountsService?: AccountService | undefined;
  transactionsService?: TransactionService | undefined;
  dashboardService?: DashboardService | undefined;
  reportsService?: ReportsService | undefined;
  billsService?: BillsService | undefined;
  budgetsService?: BudgetsService | undefined;
  forecastService?: ForecastService | undefined;
  rulesService?: RuleService | undefined;
  notificationsService?: NotificationPreferencesService | undefined;
  userDataService?: UserDataService | undefined;
  billDispatcher?: BillJobDispatcher | undefined;
  ruleDispatcher?: RuleJobDispatcher | undefined;
  revokePlaidItems?: UserDataServiceDependencies["revokePlaidItems"];
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
  const dashboardService =
    dependencies.dashboardService ??
    createDashboardService(
      dependencies.responseCache
        ? { cache: dependencies.responseCache }
        : undefined,
    );
  registerDashboardRoutes(app, dependencies.auth, dashboardService);
  const reportsService =
    dependencies.reportsService ??
    createReportsService(
      dependencies.responseCache
        ? { cache: dependencies.responseCache }
        : undefined,
    );
  registerReportsRoutes(app, dependencies.auth, reportsService);
  const billsService =
    dependencies.billsService ??
    createBillsService(
      dependencies.responseCache || dependencies.billDispatcher
        ? {
            ...(dependencies.responseCache
              ? { cache: dependencies.responseCache }
              : {}),
            ...(dependencies.billDispatcher
              ? { billDispatcher: dependencies.billDispatcher }
              : {}),
          }
        : undefined,
    );
  registerBillsRoutes(app, dependencies.auth, billsService);
  const budgetsService =
    dependencies.budgetsService ??
    createBudgetsService(
      dependencies.responseCache
        ? { cache: dependencies.responseCache }
        : undefined,
    );
  registerBudgetsRoutes(app, dependencies.auth, budgetsService);
  const forecastService =
    dependencies.forecastService ??
    createForecastService(
      dependencies.responseCache
        ? { cache: dependencies.responseCache }
        : undefined,
    );
  registerForecastRoutes(app, dependencies.auth, forecastService);
  const rulesService =
    dependencies.rulesService ??
    createRuleService(
      dependencies.responseCache || dependencies.ruleDispatcher
        ? {
            ...(dependencies.responseCache
              ? { cache: dependencies.responseCache }
              : {}),
            ...(dependencies.ruleDispatcher
              ? { dispatcher: dependencies.ruleDispatcher }
              : {}),
          }
        : undefined,
    );
  registerRulesRoutes(app, dependencies.auth, rulesService);
  const notificationsService =
    dependencies.notificationsService ??
    createNotificationsService(
      dependencies.responseCache
        ? { cache: dependencies.responseCache }
        : undefined,
    );
  registerNotificationsRoutes(app, dependencies.auth, notificationsService);
  const userDataService =
    dependencies.userDataService ??
    createUserDataService(
      dependencies.responseCache || dependencies.revokePlaidItems
        ? {
            ...(dependencies.responseCache
              ? { cache: dependencies.responseCache }
              : {}),
            ...(dependencies.revokePlaidItems
              ? { revokePlaidItems: dependencies.revokePlaidItems }
              : {}),
          }
        : undefined,
    );
  registerUserDataRoutes(app, dependencies.auth, userDataService);
  dependencies.registerProtectedRoutes?.(app, dependencies.auth);
}
