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
import { createWorkerWakeClient } from "../platform/jobs/worker-wake.js";

type EntrypointLogger = {
  info: (bindings: Record<string, unknown>, message: string) => unknown;
  error: (bindings: Record<string, unknown>, message: string) => unknown;
};

type Failure =
  Readonly<{ present: false }> | Readonly<{ present: true; value: unknown }>;

const noFailure: Failure = { present: false };

function capturedFailure(value: unknown): Failure {
  return { present: true, value };
}

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
  primaryFailure: Failure = noFailure,
): Promise<void> {
  const failures: unknown[] = [];
  if (primaryFailure.present) failures.push(primaryFailure.value);
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
  const responseCache =
    dependencies.responseCache ??
    createResponseCache({
      ttlMs: configuration.CACHE_TTL_MS,
      maxEntries: configuration.CACHE_MAX_ENTRIES,
      maxBytes: configuration.CACHE_MAX_BYTES,
      maxEntryBytes: configuration.CACHE_MAX_ENTRY_BYTES,
    });
  const wakeWorker =
    dependencies.wakeWorker ??
    (configuration.WORKER_WAKE_URL
      ? createWorkerWakeClient(configuration.WORKER_WAKE_URL)
      : undefined);
  const app = (dependencies.createHttpApp ?? createHttpApp)({
    ...dependencies,
    env: configuration,
    responseCache,
    wakeWorker,
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

  let stopCacheCleanup: (() => void) | undefined;
  try {
    await invalidationListener.start();
    stopCacheCleanup = responseCache.startCleanup(60_000);
  } catch (error: unknown) {
    await cleanupLifecycle(
      [
        async () => stopCacheCleanup?.(),
        invalidationListener.stop,
        notificationAdapter.close,
      ],
      capturedFailure(error),
    );
    throw error;
  }

  const databaseClose = dependencies.closeDb ?? closeDb;
  let server: ServerType | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let listening = false;
      let settled = false;
      let errorHandlerAttached = false;
      const handleError = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const handleListening = (): void => {
        listening = true;
        if (!server || settled) return;
        settled = true;
        if (errorHandlerAttached) server.off("error", handleError);
        resolve();
      };

      server = (dependencies.serve ?? serve)(
        {
          fetch: app.fetch,
          hostname: configuration.API_HOST,
          port: configuration.PORT,
        },
        handleListening,
      );
      if (listening) {
        handleListening();
      } else {
        server.once("error", handleError);
        errorHandlerAttached = true;
      }
    });
  } catch (error: unknown) {
    await cleanupLifecycle(
      [
        async () => {
          if (server) await closeServer(server);
        },
        async () => stopCacheCleanup?.(),
        invalidationListener.stop,
        notificationAdapter.close,
        databaseClose,
      ],
      capturedFailure(error),
    );
    throw error;
  }
  if (!server) throw new Error("HTTP server did not initialize");
  const activeServer = server;
  let closePromise: Promise<void> | undefined;
  let uninstallShutdown = (): void => undefined;
  const cleanupOwnedResources = (primaryFailure: Failure = noFailure) =>
    cleanupLifecycle(
      [
        async () => uninstallShutdown(),
        () => closeServer(activeServer),
        async () => stopCacheCleanup?.(),
        invalidationListener.stop,
        notificationAdapter.close,
        databaseClose,
      ],
      primaryFailure,
    );
  const close = (): Promise<void> => {
    closePromise ??= cleanupOwnedResources();
    return closePromise;
  };
  try {
    uninstallShutdown = (
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
  } catch (error: unknown) {
    await cleanupOwnedResources(capturedFailure(error));
    throw error;
  }

  return { server: activeServer, close, uninstallShutdown };
}
