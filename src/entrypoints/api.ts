import { serve, type ServerType } from "@hono/node-server";
import {
  createHttpApp,
  type HttpAppDependencies,
} from "../app/create-http-app.js";
import { createResponseCache } from "../platform/cache/response-cache.js";
import {
  createUserInvalidationListener,
  type UserInvalidationListener,
} from "../platform/cache/user-revisions.repository.js";
import { loadEnv, type Env } from "../platform/config/env.js";
import {
  closeDb,
  createPostgresNotificationAdapter,
  type DatabaseNotificationAdapter,
} from "../platform/database/client.js";
import { installGracefulShutdown } from "../platform/http/shutdown.js";
import { logger } from "../platform/logging/logger.js";

type EntrypointLogger = {
  info: (bindings: Record<string, unknown>, message: string) => unknown;
  error: (bindings: Record<string, unknown>, message: string) => unknown;
};

export type ApiStartDependencies = HttpAppDependencies & {
  loadEnv?: (() => Env) | undefined;
  createHttpApp?: typeof createHttpApp | undefined;
  serve?: typeof serve | undefined;
  closeDb?: (() => Promise<void>) | undefined;
  createNotificationAdapter?:
    ((databaseUrl: string) => DatabaseNotificationAdapter) | undefined;
  createInvalidationListener?:
    typeof createUserInvalidationListener | undefined;
  installGracefulShutdown?: typeof installGracefulShutdown | undefined;
  startupLogger?: EntrypointLogger | undefined;
  revision?: string | undefined;
};

export type ApiRuntime = {
  server: ServerType;
  close: () => Promise<void>;
  uninstallShutdown: () => void;
};

function isAlreadyClosed(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ERR_SERVER_NOT_RUNNING"
  );
}

/** Awaits a Node server close, including the normal already-closed case. */
export async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const complete = (error?: Error): void => {
      if (error && !isAlreadyClosed(error)) {
        reject(error);
        return;
      }
      resolve();
    };

    try {
      server.close(complete);
    } catch (error) {
      if (isAlreadyClosed(error)) {
        resolve();
        return;
      }
      reject(error);
    }
  });
}

async function cleanupLifecycle(
  actions: readonly (() => Promise<void>)[],
  primaryFailure?: unknown,
): Promise<void> {
  const failures: unknown[] = [];
  if (primaryFailure !== undefined) failures.push(primaryFailure);
  for (const action of actions) {
    try {
      await action();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "API lifecycle cleanup failed");
  }
}

/** Starts only the HTTP role and wires its process-owned shutdown lifecycle. */
export async function startApi(
  dependencies: ApiStartDependencies = {},
): Promise<ApiRuntime> {
  const configuration = (dependencies.loadEnv ?? loadEnv)();
  const responseCache = dependencies.responseCache ?? createResponseCache();
  const app = (dependencies.createHttpApp ?? createHttpApp)({
    ...dependencies,
    env: configuration,
    responseCache,
  });
  const notificationAdapter = (
    dependencies.createNotificationAdapter ?? createPostgresNotificationAdapter
  )(configuration.DATABASE_URL);
  const createListener =
    dependencies.createInvalidationListener ?? createUserInvalidationListener;
  const invalidationListener: UserInvalidationListener = createListener({
    cache: responseCache,
    listen: notificationAdapter.listen,
  });

  try {
    await invalidationListener.start();
  } catch (error: unknown) {
    await cleanupLifecycle([notificationAdapter.close], error);
    throw error;
  }

  let server: ServerType;
  try {
    server = (dependencies.serve ?? serve)({
      fetch: app.fetch,
      hostname: configuration.API_HOST,
      port: configuration.PORT,
    });
  } catch (error: unknown) {
    await cleanupLifecycle(
      [invalidationListener.stop, notificationAdapter.close],
      error,
    );
    throw error;
  }
  const databaseClose = dependencies.closeDb ?? closeDb;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= cleanupLifecycle([
      () => closeServer(server),
      invalidationListener.stop,
      notificationAdapter.close,
      databaseClose,
    ]);
    return closePromise;
  };
  const uninstallShutdown = (
    dependencies.installGracefulShutdown ?? installGracefulShutdown
  )(close);

  (dependencies.startupLogger ?? logger).info(
    {
      service: "centsible-api",
      role: "api",
      hostname: configuration.API_HOST,
      port: configuration.PORT,
      revision: dependencies.revision ?? process.env.GIT_SHA ?? "unknown",
    },
    "API listening",
  );

  return { server, close, uninstallShutdown };
}
